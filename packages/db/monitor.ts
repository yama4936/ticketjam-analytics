import type pg from "pg";
export async function monitor(pool: pg.Pool) {
  const issues = (
    await pool.query(`SELECT 'source:'||source AS key,source||': '||coalesce(block_reason,'収集を停止中') AS message FROM source_state WHERE blocked_until>now()
    UNION ALL
    SELECT 'event:'||s.id,e.title||': 最新の取得に失敗、または90分以上観測できていません' FROM source_events s JOIN events e ON e.id=s.event_id
    LEFT JOIN LATERAL(SELECT * FROM collection_runs WHERE source_event_id=s.id ORDER BY scheduled_at DESC LIMIT 1)r ON true
    WHERE s.enabled AND e.starts_at>now() AND EXISTS(SELECT 1 FROM event_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.event_id=e.id AND g.enabled)
      AND (r.status='failed' OR coalesce(r.completed_at,s.discovered_at)<now()-interval '90 minutes')
    UNION ALL
    SELECT 'discovery:'||g.id,g.name||': 公演発見処理に失敗しています' FROM groups g
    JOIN LATERAL(SELECT status FROM discovery_runs WHERE group_id=g.id ORDER BY started_at DESC LIMIT 1)r ON true
    WHERE g.enabled AND r.status IN('failed','partial')
    UNION ALL SELECT 'official:'||url,'公式ページの取得失敗: '||url FROM official_sources WHERE enabled AND last_error IS NOT NULL`)
  ).rows;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('operations-monitor'))",
    );
    for (const issue of issues) {
      const previous = (
        await c.query(
          "SELECT resolved_at FROM operational_alerts WHERE key=$1",
          [issue.key],
        )
      ).rows[0];
      await c.query(
        `INSERT INTO operational_alerts(key,message) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET message=excluded.message,last_seen_at=now(),resolved_at=NULL`,
        [issue.key, issue.message],
      );
      if (!previous || previous.resolved_at)
        console.error(JSON.stringify({ type: "operational_alert", ...issue }));
    }
    await c.query(
      "UPDATE operational_alerts SET resolved_at=now() WHERE resolved_at IS NULL AND NOT(key=ANY($1::text[]))",
      [issues.map((r) => r.key)],
    );
    await c.query(
      "INSERT INTO worker_heartbeat(name,last_seen_at) VALUES('collector',now()) ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at",
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
