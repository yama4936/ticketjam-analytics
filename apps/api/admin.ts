import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { reviewOfficial } from "../../packages/db/official.js";
export async function registerAdmin(app: FastifyInstance, pool: pg.Pool) {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/admin/")) return;
    const expected = process.env.ADMIN_TOKEN;
    if (!expected)
      return reply.code(503).send({ error: "管理キーが設定されていません" });
    const actual = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      return reply.code(401).send({ error: "管理キーを確認してください" });
  });
  app.get("/api/admin/summary", async () => {
    const results = await Promise.all([
      pool.query(
        "SELECT id,name,ticketjam_slug,official_artist_slug,enabled FROM groups ORDER BY name",
      ),
      pool.query(
        "SELECT r.id,r.reason,r.details,e.title,oe.extracted_fields,oe.source_url FROM review_queue r LEFT JOIN events e ON e.id=r.event_id LEFT JOIN official_evidence oe ON oe.id::text=r.details->>'evidenceId' WHERE r.status='pending' ORDER BY r.created_at",
      ),
      pool.query(
        "SELECT source,blocked_until>now() AS blocked,block_reason FROM source_state ORDER BY source",
      ),
      pool.query(
        "SELECT e.title,r.status,r.error,r.warnings,r.scheduled_at,r.completed_at FROM collection_runs r JOIN source_events s ON s.id=r.source_event_id JOIN events e ON e.id=s.event_id ORDER BY r.scheduled_at DESC LIMIT 50",
      ),
      pool.query(
        "SELECT * FROM official_sources ORDER BY checked_at DESC NULLS FIRST LIMIT 100",
      ),
    ]);
    return {
      groups: results[0]!.rows,
      reviews: results[1]!.rows,
      sources: results[2]!.rows,
      runs: results[3]!.rows,
      officialSources: results[4]!.rows,
    };
  });
  app.post("/api/admin/reviews/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        decision: z.enum(["confirmed", "rejected"]),
        note: z.string().min(10).max(1000),
      })
      .parse(request.body);
    const row = (
      await pool.query("SELECT details FROM review_queue WHERE id=$1", [id])
    ).rows[0];
    if (!row?.details.evidenceId)
      return reply.code(404).send({ error: "確認対象が見つかりません" });
    await reviewOfficial(
      pool,
      row.details.evidenceId,
      body.decision,
      body.note,
    );
    return { ok: true };
  });
  app.post("/api/admin/groups", async (request) => {
    const body = z
      .object({
        name: z.string().min(1).max(100),
        ticketjamSlug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(100),
        officialArtistSlug: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .max(100)
          .optional(),
      })
      .parse(request.body);
    await pool.query(
      "INSERT INTO groups(name,ticketjam_slug,official_artist_slug) VALUES($1,$2,$3)",
      [body.name, body.ticketjamSlug, body.officialArtistSlug ?? null],
    );
    return { ok: true };
  });
  app.post("/api/admin/groups/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const result = await pool.query(
      "UPDATE groups SET enabled=$2 WHERE id=$1",
      [id, enabled],
    );
    return result.rowCount
      ? { ok: true }
      : reply.code(404).send({ error: "グループが見つかりません" });
  });
  app.post("/api/admin/official-sources", async (request) => {
    const { url } = z.object({ url: z.url() }).parse(request.body);
    const parsed = new URL(url);
    if (
      parsed.origin !== "https://ticketdive.com" ||
      !/^\/event\/[a-zA-Z0-9_-]+$/.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new z.ZodError([
        { code: "custom", path: ["url"], message: "Unsupported URL" },
      ]);
    await pool.query(
      "INSERT INTO official_sources(url) VALUES($1) ON CONFLICT DO NOTHING",
      [url],
    );
    return { ok: true };
  });
}
