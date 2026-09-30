import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { NORMALIZATION_VERSION } from "../../packages/domain/types.js";
export function registerComparison(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/comparison", async (request) => {
    const f = z
      .object({
        group: z.string().uuid().optional(),
        by: z.enum(["event", "type", "prefix"]).default("event"),
      })
      .parse(request.query);
    const rows = (
      await pool.query(
        `WITH latest AS(
      SELECT DISTINCT ON(s.event_id) s.event_id,r.id,r.completed_at,r.status FROM collection_runs r JOIN source_events s ON s.id=r.source_event_id
      WHERE r.status IN('complete','partial') ORDER BY s.event_id,r.scheduled_at DESC
    ) SELECT e.id AS event_id,e.title,e.starts_at,r.completed_at AS observed_at,r.status,
      (SELECT jsonb_agg(g.name ORDER BY g.name) FROM event_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.event_id=e.id) AS groups,
      CASE $2 WHEN 'type' THEN coalesce(n.ticket_type,'券種不明') WHEN 'prefix' THEN coalesce(n.admission_prefix,'接頭辞不明') ELSE '全券種' END AS segment,
      count(o.id)::int AS listing_count,coalesce(sum(o.quantity),0)::int AS ticket_count,min(o.price_yen) AS min_price_yen,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY o.price_yen) AS median_price_yen
      FROM events e JOIN latest r ON r.event_id=e.id LEFT JOIN listing_observations o ON o.run_id=r.id AND o.state='listed'
      LEFT JOIN observation_normalizations n ON n.observation_id=o.id AND n.version=$3
      WHERE ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM event_groups WHERE event_id=e.id AND group_id=$1))
      GROUP BY e.id,r.completed_at,r.status,segment ORDER BY e.starts_at,e.id,segment LIMIT 1000`,
        [f.group ?? null, f.by, NORMALIZATION_VERSION],
      )
    ).rows;
    return { rows, truncated: rows.length === 1000 };
  });
}
