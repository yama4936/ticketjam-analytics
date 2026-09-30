import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type pg from "pg";
import { createPool } from "../../packages/db/pool.js";
import { NORMALIZATION_VERSION } from "../../packages/domain/types.js";
import { histogram } from "../../packages/analytics/statistics.js";
import { registerComparison } from "./comparison.js";
import { registerAdmin } from "./admin.js";
import { withMissingSlots } from "../../packages/analytics/timeline.js";
import { migrate } from "../../packages/db/migrate.js";

const filters = z
  .object({
    type: z.string().max(100).optional(),
    prefix: z
      .string()
      .max(3)
      .regex(/^[A-Za-z]*$/)
      .optional(),
    lower: z.coerce.number().int().min(1).max(999999).optional(),
    upper: z.coerce.number().int().min(1).max(999999).optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
    officialType: z.string().uuid().optional(),
  })
  .refine(
    (x) => x.lower === undefined || x.upper === undefined || x.lower <= x.upper,
    "番号範囲を確認してください",
  );

export async function buildServer(pool: pg.Pool) {
  // In Compose, only Nginx reaches this internal listener and replaces X-Forwarded-For.
  const app = Fastify({
    logger: true,
    bodyLimit: 65536,
    trustProxy:
      process.env.TRUST_PROXY === "1" ? (_address, hop) => hop === 0 : false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    );
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: "入力条件を確認してください" });
    app.log.error(error);
    const code =
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    reply.code(code).send({
      error:
        code === 409
          ? "公式情報が更新されています。管理データを再読込してください。"
          : code === 429
            ? "アクセスが集中しています。少し待ってください。"
            : "データの取得に失敗しました",
    });
  });
  await registerAdmin(app, pool);
  registerComparison(app, pool);
  app.get("/healthz", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });
  app.get("/api/status", async () => ({
    alerts: (
      await pool.query(
        "SELECT key,message,first_seen_at,last_seen_at FROM operational_alerts WHERE resolved_at IS NULL ORDER BY first_seen_at",
      )
    ).rows,
    workerAlive: !!(
      await pool.query(
        "SELECT 1 FROM worker_heartbeat WHERE last_seen_at>now()-interval '2 minutes'",
      )
    ).rowCount,
  }));
  app.get("/api/groups", async () => ({
    groups: (
      await pool.query("SELECT id,name,enabled FROM groups ORDER BY name")
    ).rows,
  }));
  app.get("/api/events", async (request) => {
    const q = z
      .object({
        group: z.string().uuid().optional(),
        q: z.string().max(100).default(""),
      })
      .parse(request.query);
    const events = (
      await pool.query(
        `SELECT e.*,s.url AS source_url,
      m.listing_count,m.ticket_count,m.min_price_yen,m.median_price_yen,m.observed_at,m.complete,
      r.status AS latest_status,r.error AS latest_error,
      (SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name)) FROM event_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.event_id=e.id) AS groups
      FROM events e JOIN source_events s ON s.event_id=e.id AND s.source='ticketjam'
      LEFT JOIN LATERAL(SELECT * FROM event_metrics WHERE event_id=e.id ORDER BY observed_at DESC LIMIT 1)m ON true
      LEFT JOIN LATERAL(SELECT status,error FROM collection_runs WHERE source_event_id=s.id ORDER BY scheduled_at DESC LIMIT 1)r ON true
      WHERE ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM event_groups WHERE event_id=e.id AND group_id=$1)) AND e.title ILIKE $2
      ORDER BY e.starts_at ASC LIMIT 200`,
        [q.group ?? null, `%${q.q}%`],
      )
    ).rows;
    const scope = (
      await pool.query(`SELECT (SELECT count(DISTINCT (source,external_id))::int FROM discovery_candidates) AS candidates,
      (SELECT count(*)::int FROM source_events s JOIN events e ON e.id=s.event_id WHERE s.enabled AND e.starts_at>now() AND EXISTS(SELECT 1 FROM event_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.event_id=e.id AND g.enabled)) AS monitored,
      (SELECT min(observed_at) FROM listing_observations) AS observation_started_at,
      (SELECT blocked_until>now() FROM source_state WHERE source='ticketjam') AS source_blocked`)
    ).rows[0];
    return {
      events,
      scope,
      capabilities: { soldConfirmation: false, officialMatching: true },
    };
  });
  app.get("/api/events/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const f = filters.parse(request.query);
    const event = (
      await pool.query(
        "SELECT e.*,s.url AS source_url FROM events e JOIN source_events s ON s.event_id=e.id WHERE e.id=$1",
        [id],
      )
    ).rows[0];
    if (!event) return reply.code(404).send({ error: "公演が見つかりません" });
    const args = [
      id,
      NORMALIZATION_VERSION,
      f.type ?? null,
      f.prefix?.toUpperCase() || null,
      f.lower ?? null,
      f.upper ?? null,
      f.days,
      f.officialType ?? null,
    ];
    const condition = `($3::text IS NULL OR n.ticket_type=$3) AND ($4::text IS NULL OR n.admission_prefix=$4)
      AND ($5::int IS NULL OR n.admission_upper>=$5) AND ($6::int IS NULL OR n.admission_lower<=$6)
      AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM ticket_types t JOIN official_evidence oe ON oe.id=t.evidence_id WHERE t.id=$8 AND t.event_id=l.event_id AND oe.review_status='confirmed'
        AND (t.name=n.ticket_type OR (t.admission_prefix=n.admission_prefix AND (SELECT count(*) FROM ticket_types tt WHERE tt.event_id=l.event_id AND tt.admission_prefix=n.admission_prefix)=1))))`;
    const observations = (
      await pool.query(
        `SELECT o.*,l.url,l.first_observed_at,n.admission_kind,n.admission_prefix,n.admission_lower,n.admission_upper,n.ticket_type
      FROM listing_observations o JOIN listings l ON l.id=o.listing_id
      LEFT JOIN observation_normalizations n ON n.observation_id=o.id AND n.version=$2
      WHERE l.event_id=$1 AND ${condition} AND o.run_id=(SELECT r.id FROM collection_runs r JOIN source_events s ON s.id=r.source_event_id
        WHERE s.event_id=$1 AND r.status IN ('complete','partial') AND r.scheduled_at>now()-$7::int*interval '1 day' ORDER BY r.scheduled_at DESC LIMIT 1)
      ORDER BY o.price_yen,o.id LIMIT 5000`,
        args,
      )
    ).rows;
    const runs = (
      await pool.query(
        `SELECT r.* FROM collection_runs r JOIN source_events s ON s.id=r.source_event_id
      WHERE s.event_id=$1 AND r.scheduled_at>now()-$2::int*interval '1 day' ORDER BY r.scheduled_at`,
        [id, f.days],
      )
    ).rows;
    const aggregateRows = (
      await pool.query(
        `SELECT o.run_id,count(*)::int AS listing_count,sum(o.quantity)::int AS ticket_count,min(o.price_yen) AS min_price,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY o.price_yen) AS median_price,
      count(*) FILTER(WHERE l.first_observed_at=o.observed_at)::int AS new_count
      FROM listing_observations o JOIN listings l ON l.id=o.listing_id
      LEFT JOIN observation_normalizations n ON n.observation_id=o.id AND n.version=$2
      WHERE l.event_id=$1 AND ${condition} AND o.state='listed' AND o.observed_at>now()-$7::int*interval '1 day' GROUP BY o.run_id`,
        args,
      )
    ).rows;
    const aggregate = new Map(aggregateRows.map((row) => [row.run_id, row]));
    const timeline = withMissingSlots(
      runs.map((run) => {
        const stats = aggregate.get(run.id);
        const stored = ["complete", "partial"].includes(run.status);
        return {
          runId: run.id,
          time: (run.completed_at ?? run.started_at).toISOString(),
          scheduledAt: run.scheduled_at.toISOString(),
          status: run.status,
          warnings: run.warnings,
          error: run.error,
          ...(stored
            ? {
                listingCount: stats?.listing_count ?? 0,
                ticketCount: stats?.ticket_count ?? 0,
                minPrice: stats?.min_price ?? null,
                medianPrice: stats?.median_price ?? null,
                newCount: stats?.new_count ?? 0,
              }
            : {
                listingCount: null,
                ticketCount: null,
                minPrice: null,
                medianPrice: null,
                newCount: null,
              }),
        };
      }),
      new Date(event.starts_at),
    );
    const latestRun = runs
      .filter((r) => ["complete", "partial"].includes(r.status))
      .at(-1);
    const listings = latestRun
      ? observations.filter((o) => o.run_id === latestRun.id)
      : [];
    const changes = (
      await pool.query(
        `SELECT c.*,l.first_observed_at,o.price_yen AS asking_price_yen,o.confirmed_sale_price_yen,n.admission_lower,n.admission_prefix FROM listing_changes c JOIN listings l ON l.id=c.listing_id
      LEFT JOIN LATERAL(SELECT * FROM listing_observations WHERE listing_id=l.id AND observed_at<=c.interval_end ORDER BY observed_at DESC LIMIT 1)o ON true
      LEFT JOIN observation_normalizations n ON n.observation_id=o.id AND n.version=$2
      WHERE l.event_id=$1 AND ${condition} AND c.interval_end>now()-$7::int*interval '1 day' ORDER BY c.interval_end`,
        args,
      )
    ).rows;
    const types = (
      await pool.query(
        `SELECT DISTINCT n.ticket_type FROM observation_normalizations n JOIN listing_observations o ON o.id=n.observation_id JOIN listings l ON l.id=o.listing_id
      WHERE l.event_id=$1 AND n.version=$2 AND n.ticket_type IS NOT NULL ORDER BY n.ticket_type`,
        [id, NORMALIZATION_VERSION],
      )
    ).rows.map((r) => r.ticket_type);
    const official = (
      await pool.query(
        `SELECT t.*,oe.source_url,oe.checked_at,oe.review_status,
      (SELECT jsonb_agg(sw ORDER BY sw.starts_at) FROM sale_windows sw WHERE sw.ticket_type_id=t.id) AS sale_windows
      FROM ticket_types t JOIN official_evidence oe ON oe.id=t.evidence_id WHERE t.event_id=$1`,
        [id],
      )
    ).rows;
    const listed = listings.filter((o) => o.state === "listed");
    return {
      event,
      filters: f,
      types,
      official,
      listings,
      timeline,
      changes,
      summary: latestRun
        ? {
            listingCount: aggregate.get(latestRun.id)?.listing_count ?? 0,
            ticketCount: aggregate.get(latestRun.id)?.ticket_count ?? 0,
            minPrice: aggregate.get(latestRun.id)?.min_price ?? null,
            medianPrice: aggregate.get(latestRun.id)?.median_price ?? null,
          }
        : {
            listingCount: null,
            ticketCount: null,
            minPrice: null,
            medianPrice: null,
          },
      histogram: histogram(listed.map((o) => o.price_yen)),
      truncated: observations.length === 5000,
      latestStatus: timeline.at(-1)?.status ?? "unobserved",
      capabilities: { soldConfirmation: false },
    };
  });
  const publicRoot = fileURLToPath(new URL("../../dist/web/", import.meta.url));
  if (existsSync(publicRoot)) {
    await app.register(staticPlugin, { root: publicRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "見つかりません" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pool = createPool();
  await migrate(pool);
  const app = await buildServer(pool);
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4381),
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      await pool.end();
    });
}
