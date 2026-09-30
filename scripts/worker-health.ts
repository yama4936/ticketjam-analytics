import { createPool } from "../packages/db/pool.js";
const pool = createPool();
try {
  const r = await pool.query(
    "SELECT 1 FROM worker_heartbeat WHERE name='collector' AND last_seen_at>now()-interval '2 minutes'",
  );
  process.exitCode = r.rowCount ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
