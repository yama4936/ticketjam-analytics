import { monitor } from "../../packages/db/monitor.js";
import { PgBoss } from "pg-boss";
import { createPool } from "../../packages/db/pool.js";
import { migrate } from "../../packages/db/migrate.js";
import { collectEvent } from "./collect.js";
import { discoverGroup } from "./discover.js";
import { refreshOfficial } from "./official.js";

const pool = createPool();
await migrate(pool);
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 5,
});
boss.on("error", (error) =>
  console.error(
    JSON.stringify({ type: "queue_error", message: error.message }),
  ),
);
await boss.start();
for (const name of [
  "hourly-scan",
  "discover-group",
  "collect-event",
  "official-refresh",
])
  await boss.createQueue(name, {
    retryLimit: 2,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 1200,
  });

async function enqueue() {
  const scheduledAt = new Date(
    Math.floor(Date.now() / 3600000) * 3600000,
  ).toISOString();
  const groups = (await pool.query("SELECT id FROM groups WHERE enabled")).rows;
  for (const group of groups)
    await boss.send(
      "discover-group",
      { groupId: group.id },
      { singletonKey: group.id, singletonSeconds: 3600 },
    );
  const sources = (
    await pool.query(
      "SELECT s.id FROM source_events s JOIN events e ON e.id=s.event_id WHERE s.enabled AND e.starts_at>now() AND EXISTS(SELECT 1 FROM event_groups eg JOIN groups g ON g.id=eg.group_id WHERE eg.event_id=e.id AND g.enabled)",
    )
  ).rows;
  for (const source of sources)
    await boss.send(
      "collect-event",
      { sourceId: source.id, scheduledAt },
      { singletonKey: `${source.id}:${scheduledAt}`, singletonSeconds: 3600 },
    );
}
await boss.work("hourly-scan", async () => {
  await enqueue();
});
await boss.work<{ groupId: string }>("discover-group", async (jobs) => {
  for (const job of jobs) {
    const result = await discoverGroup(
      pool,
      job.data.groupId,
      Number(process.env.MAX_ACTIVE_EVENTS ?? 5),
    );
    console.log(JSON.stringify({ type: "discovered", ...result }));
    // Newly discovered paginated events should not wait an extra hour.
    const scheduledAt = new Date(
      Math.floor(Date.now() / 3600000) * 3600000,
    ).toISOString();
    const sources = (
      await pool.query(
        "SELECT s.id FROM source_events s JOIN event_groups eg ON eg.event_id=s.event_id JOIN events e ON e.id=s.event_id WHERE eg.group_id=$1 AND s.enabled AND e.starts_at>now()",
        [job.data.groupId],
      )
    ).rows;
    for (const source of sources)
      await boss.send(
        "collect-event",
        { sourceId: source.id, scheduledAt },
        { singletonKey: `${source.id}:${scheduledAt}`, singletonSeconds: 3600 },
      );
  }
});
await boss.work<{ sourceId: string; scheduledAt: string }>(
  "collect-event",
  async (jobs) => {
    for (const job of jobs)
      console.log(
        JSON.stringify({
          type: "collected",
          ...(await collectEvent(
            pool,
            job.data.sourceId,
            new Date(job.data.scheduledAt),
          )),
        }),
      );
  },
);
await boss.schedule("hourly-scan", "0 * * * *", null, { tz: "Asia/Tokyo" });
await boss.work("official-refresh", async () => {
  console.log(
    JSON.stringify({
      type: "official_refreshed",
      ...(await refreshOfficial(pool)),
    }),
  );
});
await boss.schedule("official-refresh", "20 */12 * * *", null, {
  tz: "Asia/Tokyo",
});
await boss.send("official-refresh", null, {
  singletonKey: "official",
  singletonSeconds: 43200,
});
await enqueue();
console.log(
  JSON.stringify({ type: "worker_ready", at: new Date().toISOString() }),
);
await monitor(pool);
const heartbeat = setInterval(
  () =>
    void monitor(pool).catch((e) =>
      console.error(
        JSON.stringify({ type: "monitor_error", message: e.message }),
      ),
    ),
  60000,
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    await boss.stop({ graceful: true, timeout: 30000 });
    await pool.end();
  });
