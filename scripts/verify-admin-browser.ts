import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent } from "../packages/db/ingest.js";
import { storeOfficial } from "../packages/db/official.js";
import { buildServer } from "../apps/api/server.js";
if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "TEST_DATABASE_URL is required; never use the collection database",
  );
const pool = createPool(process.env.TEST_DATABASE_URL);
const token = randomUUID(),
  suffix = randomUUID(),
  title = "Browser review " + suffix;
process.env.ADMIN_TOKEN = token;
const app = await buildServer(pool);
const exec = promisify(execFile),
  checks: string[] = [];
async function browser(...args: string[]) {
  try {
    const { stdout } = await exec(
      "npx",
      [
        "--yes",
        "agent-browser",
        "--session",
        "ticketjam-admin-verify",
        "--json",
        ...args,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const r = JSON.parse(stdout);
    if (!r.success) throw new Error();
    return r.data;
  } catch {
    throw new Error("Admin browser command failed (arguments redacted)");
  }
}
async function evaluate(code: string) {
  return (await browser("eval", code)).result;
}
async function until(code: string) {
  for (let i = 0; i < 15; i++) {
    if (await evaluate("Boolean(" + code + ")")) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Admin browser condition timed out");
}
function pass(name: string) {
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await migrate(pool);
  const startsAt = new Date(Date.now() + 864000000).toISOString();
  const sourceId = await registerEvent(pool, {
    externalId: suffix,
    url: "https://ticketjam.jp/tickets/test/event/1",
    title,
    startsAt,
    venue: "Hall",
  });
  const eventId = (
    await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
      sourceId,
    ])
  ).rows[0].event_id;
  const sourceUrl = "https://ticketdive.com/event/browser-" + suffix;
  await storeOfficial(pool, sourceUrl, new Date(), [
    {
      eventName: title,
      stageName: "Browser stage",
      stageId: suffix,
      startsAt,
      venue: "Different Hall",
      drinkYen: null,
      tickets: [
        {
          name: "Browser ticket",
          prefix: "A",
          price: 2000,
          fee: null,
          windowId: "first",
          windowName: "General",
          startsAt,
          endsAt: null,
        },
      ],
    },
  ]);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await browser(
    "--cdp",
    process.env.VERIFY_CDP ?? "http://127.0.0.1:9229",
    "open",
    address + "/admin",
  );
  await browser("fill", "input[type=password]", token);
  await browser("click", "form button");
  await until("document.body.textContent.includes('公式情報の確認待ち')");
  await browser("snapshot", "-i");
  // Select only the synthetic event created by this invocation.
  await evaluate(
    `[...document.querySelectorAll('article.official')].find(e=>e.textContent.includes(${JSON.stringify(title)})).id='verify-review'`,
  );
  await browser(
    "fill",
    "#verify-review input",
    "公式の日付と公演名を検証用データで照合しました",
  );
  await browser("click", "#verify-review button:first-of-type");
  await until("!document.getElementById('verify-review')");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ticket_types WHERE event_id=$1",
        [eventId],
      )
    ).rows[0].n,
    1,
  );
  pass("Pending official review confirms and materializes ticket type");
  await evaluate(
    `[...document.querySelectorAll('details.official')].find(e=>e.textContent.includes(${JSON.stringify(title)})).id='verify-evidence'`,
  );
  await browser("click", "#verify-evidence summary");
  await browser(
    "fill",
    "#verify-evidence input",
    "検証用に対応づけを取り消し履歴の保持を確認します",
  );
  await browser("click", "#verify-evidence button");
  await until(
    "document.querySelector('#verify-evidence summary')?.textContent.includes('却下済み')",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ticket_types WHERE event_id=$1",
        [eventId],
      )
    ).rows[0].n,
    0,
  );
  pass("Cancel confirmed match removes derived type");
  await browser(
    "fill",
    "#verify-evidence input",
    "検証用に公式情報を再確認し対応づけを戻します",
  );
  await browser("click", "#verify-evidence button");
  await until(
    "document.querySelector('#verify-evidence summary')?.textContent.includes('確認済み')",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM official_reviews r JOIN official_evidence e ON e.id=r.evidence_id WHERE e.event_id=$1",
        [eventId],
      )
    ).rows[0].n,
    3,
  );
  pass("Reconfirmation restores match and records all three decisions");
  const groupName = "Browser group " + suffix,
    slug = "browser-" + suffix;
  await browser("fill", ".form-grid label:nth-child(1) input", groupName);
  await browser("fill", ".form-grid label:nth-child(2) input", slug);
  await browser("click", "form:has(.form-grid) button");
  await until(
    `[...document.querySelectorAll('section p')].some(e=>e.textContent.includes(${JSON.stringify(groupName)})&&e.querySelector('button'))`,
  );
  await evaluate(
    `[...document.querySelectorAll('section p')].find(e=>e.textContent.includes(${JSON.stringify(groupName)})&&e.querySelector('button')).id='verify-group'`,
  );
  await browser("click", "form:has(.form-grid) button");
  await until(
    "document.querySelector('[role=alert]')?.textContent.includes('登録済み')",
  );
  for (const enabled of [false, true]) {
    await browser("click", "#verify-group button");
    await until(
      `document.querySelector('#verify-group button')?.textContent.includes('${enabled ? "収集を停止" : "収集を再開"}')`,
    );
    assert.equal(
      (
        await pool.query("SELECT enabled FROM groups WHERE ticketjam_slug=$1", [
          slug,
        ])
      ).rows[0].enabled,
      enabled,
    );
  }
  pass("Group add, duplicate error, stop and resume persist through API");
  const newUrl = "https://ticketdive.com/event/browser-source-" + suffix;
  await browser("fill", "input[type=url]", newUrl);
  await browser("click", "form:has(input[type=url]) button");
  await until(`document.querySelector('a[href="${newUrl}"]')`);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM official_sources WHERE url=$1",
        [newUrl],
      )
    ).rows[0].n,
    1,
  );
  pass("Official source form persists URL");
  const errors = await browser("errors");
  assert.ok(!errors.errors?.length);
  await mkdir(".local/evidence", { recursive: true });
  await writeFile(
    ".local/evidence/admin-browser.json",
    JSON.stringify({ checkedAt: new Date(), checks, errors }, null, 2),
  );
} finally {
  await browser("close").catch(() => {});
  await app.close();
  await pool.end();
}
