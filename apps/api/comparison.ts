import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { NORMALIZATION_VERSION } from "../../packages/domain/types.js";

export async function priceCohorts(
  pool: pg.Pool,
  group: string | null = null,
  by = "type",
  eventId: string | null = null,
) {
  return (
    await pool.query(
      `WITH latest AS (
    SELECT DISTINCT ON(s.event_id) s.event_id,r.id,r.completed_at,r.status FROM collection_runs r JOIN source_events s ON s.id=r.source_event_id
    WHERE r.status IN('complete','partial') ORDER BY s.event_id,r.scheduled_at DESC
  ), matched AS (
    SELECT e.id AS event_id,e.title,e.starts_at,r.completed_at AS observed_at,r.status,o.id AS observation_id,o.quantity,o.price_yen,
      t.id AS official_type_id,t.name AS official_type,t.face_value_yen,
      CASE WHEN t.id IS NULL THEN ticket_purpose_v1(o.admission_raw) ELSE official_ticket_purpose_v1(e.title,oe.extracted_fields->>'stageName',t.name) END AS purpose,
      CASE WHEN $2='prefix' THEN coalesce(n.admission_prefix,'接頭辞不明') ELSE '' END AS prefix_segment
    FROM events e JOIN latest r ON r.event_id=e.id
    LEFT JOIN listing_observations o ON o.run_id=r.id AND o.state='listed'
    LEFT JOIN observation_normalizations n ON n.observation_id=o.id AND n.version=$3
    LEFT JOIN ticket_types t ON t.id=matched_ticket_type_v1(e.id,o.admission_raw,n.ticket_type,n.admission_prefix)
    LEFT JOIN official_evidence oe ON oe.id=t.evidence_id
    WHERE ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM event_groups WHERE event_id=e.id AND group_id=$1))
      AND ($4::uuid IS NULL OR e.id=$4)
  ) SELECT event_id,title,starts_at,observed_at,status,official_type_id,purpose,face_value_yen,
    coalesce(official_type,'券種・部の対応未確認') || CASE WHEN prefix_segment='' THEN '' ELSE ' / ' || prefix_segment END AS segment,
    (SELECT jsonb_agg(g.name ORDER BY g.name) FROM event_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.event_id=matched.event_id) AS groups,
    count(observation_id)::int AS listing_count,coalesce(sum(quantity),0)::int AS ticket_count,
    CASE WHEN official_type_id IS NOT NULL AND face_value_yen IS NOT NULL THEN min(price_yen) END AS min_price_yen,
    CASE WHEN official_type_id IS NOT NULL AND face_value_yen IS NOT NULL THEN percentile_cont(0.5) WITHIN GROUP(ORDER BY price_yen) END AS median_price_yen
    FROM matched GROUP BY event_id,title,starts_at,observed_at,status,official_type_id,official_type,purpose,face_value_yen,prefix_segment
    ORDER BY starts_at,event_id,official_type_id NULLS LAST,purpose,prefix_segment LIMIT 1000`,
      [group, by, NORMALIZATION_VERSION, eventId],
    )
  ).rows;
}
export function registerComparison(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/comparison", async (request) => {
    const f = z
      .object({
        group: z.string().uuid().optional(),
        by: z.enum(["event", "type", "prefix"]).default("type"),
      })
      .parse(request.query);
    const rows = await priceCohorts(pool, f.group ?? null, f.by);
    return { rows, truncated: rows.length === 1000 };
  });
}
