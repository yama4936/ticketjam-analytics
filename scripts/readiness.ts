import { createPool } from "../packages/db/pool.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const pool = createPool();
try {
  const runtime = (
    await pool.query(`SELECT min(started_at) AS first_run,max(completed_at) AS last_run,count(*)::int AS runs,
    count(*) FILTER(WHERE status='complete')::int AS complete,count(*) FILTER(WHERE status='partial')::int AS partial,count(*) FILTER(WHERE status='failed')::int AS failed,
    extract(epoch FROM now()-min(started_at))/3600 AS elapsed_hours FROM collection_runs`)
  ).rows[0];
  const gaps = (
    await pool.query(`SELECT e.title,count(*)::int AS missing_slots FROM source_events s JOIN events e ON e.id=s.event_id
    CROSS JOIN LATERAL generate_series(date_trunc('hour',s.discovered_at)+interval '1 hour',date_trunc('hour',least(now()-interval '10 minutes',e.starts_at-interval '1 millisecond')),interval '1 hour') slot
    WHERE s.enabled AND NOT EXISTS(SELECT 1 FROM collection_runs r WHERE r.source_event_id=s.id AND r.scheduled_at=slot AND r.status IN('complete','partial')) GROUP BY e.id`)
  ).rows;
  const sourceBlocks = (
    await pool.query(
      "SELECT source,block_reason FROM source_state WHERE blocked_until>now()",
    )
  ).rows;
  const alerts = (
    await pool.query(
      "SELECT key,message FROM operational_alerts WHERE resolved_at IS NULL",
    )
  ).rows;
  let backup: unknown = null;
  try {
    backup = JSON.parse(
      await readFile(".local/evidence/backup-verification.json", "utf8"),
    );
  } catch {}
  let publication: {
    url?: string;
    checkedAt?: string;
    domainConfigured?: boolean;
    externalHttpsVerified?: boolean;
  } = {};
  try {
    publication = JSON.parse(
      await readFile(".local/evidence/publication.json", "utf8"),
    );
  } catch {}
  const publicationFresh =
    publication.checkedAt &&
    Date.now() - Date.parse(publication.checkedAt) < 86400000;
  const report = {
    checkedAt: new Date().toISOString(),
    runtime,
    gaps,
    sourceBlocks,
    alerts,
    backup,
    multiDayElapsed: Number(runtime.elapsed_hours) >= 48,
    publication: {
      ...publication,
      domainConfigured: publication.domainConfigured === true,
      externalHttpsVerified: Boolean(
        publicationFresh && publication.externalHttpsVerified,
      ),
    },
    note: "48時間未満、未解決の欠測・失敗、取得元停止、公開URL未検証の状態で全要件達成と判定しない。部分取得の原因も個別確認する。",
  };
  await mkdir(".local/evidence", { recursive: true });
  await writeFile(
    ".local/evidence/readiness.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      { ...report, backup: backup ? "restore verification available" : null },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
