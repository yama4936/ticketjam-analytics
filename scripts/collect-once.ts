import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent, persistBatch } from "../packages/db/ingest.js";
import { parseEventPage } from "../packages/sources/ticketjam/parser.js";
import { TicketjamHttp } from "../packages/sources/ticketjam/http.js";
import { collectEvent } from "../apps/worker/collect.js";

const url = process.argv[2];
if (!url)
  throw new Error(
    "Usage: npm run collect:once -- https://ticketjam.jp/tickets/SLUG/event/ID",
  );
const pool = createPool();
try {
  await migrate(pool);
  const http = new TicketjamHttp(pool);
  const first = await http.get(url);
  const page = parseEventPage(first.html, url);
  const sourceId = await registerEvent(pool, page.event);
  const slot = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  // Avoid refetching a complete one-page event solely to initialize its identity.
  const result = page.nextUrl
    ? await collectEvent(pool, sourceId, slot, http)
    : await persistBatch(pool, sourceId, slot, [
        { page, observedAt: first.observedAt },
      ]);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
