import { createPool } from "../packages/db/pool.js";
const pool = createPool();
try {
  const r =
    await pool.query(`INSERT INTO event_metrics(run_id,event_id,observed_at,complete,listing_count,ticket_count,min_price_yen,median_price_yen,price_distribution)
    SELECT r.id,s.event_id,r.completed_at,r.status='complete',count(o.id),coalesce(sum(o.quantity),0),min(o.price_yen),percentile_cont(0.5) WITHIN GROUP(ORDER BY o.price_yen),coalesce(jsonb_agg(o.price_yen ORDER BY o.price_yen) FILTER(WHERE o.id IS NOT NULL),'[]')
    FROM collection_runs r JOIN source_events s ON s.id=r.source_event_id LEFT JOIN listing_observations o ON o.run_id=r.id AND o.state='listed'
    WHERE r.status IN('complete','partial') GROUP BY r.id,s.event_id
    ON CONFLICT(run_id) DO UPDATE SET listing_count=excluded.listing_count,ticket_count=excluded.ticket_count,min_price_yen=excluded.min_price_yen,median_price_yen=excluded.median_price_yen,price_distribution=excluded.price_distribution,calculated_at=now()`);
  console.log(JSON.stringify({ reaggregatedRuns: r.rowCount }));
} finally {
  await pool.end();
}
