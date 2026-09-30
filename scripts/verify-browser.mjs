import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const exec = promisify(execFile);
const base = process.env.VERIFY_URL ?? "http://127.0.0.1:4381";
const session = "ticketjam-verify";
const checks = [];
async function browser(...args) {
  try {
    const { stdout } = await exec(
      "npx",
      ["--yes", "agent-browser", "--session", session, "--json", ...args],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const response = JSON.parse(stdout);
    if (!response.success) throw new Error("Browser command failed");
    return response.data;
  } catch {
    // Command arguments may contain a management token; never include them in errors.
    throw new Error("Browser verification command failed");
  }
}
const evaluate = async (code) => (await browser("eval", code)).result;
async function until(code) {
  for (let i = 0; i < 20; i++) {
    if (await evaluate("Boolean(" + code + ")")) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Browser assertion timed out: " + code);
}
function pass(name) {
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await browser(
    "--cdp",
    process.env.VERIFY_CDP ?? "http://127.0.0.1:9229",
    "open",
    base,
  );
  await until("document.querySelectorAll('.event-card').length >= 2");
  assert.equal(
    await evaluate(
      "!!document.querySelector('input[placeholder=\"公演を検索\"]')",
    ),
    false,
  );
  assert.equal(
    await evaluate("document.body.textContent.includes('Internet Archive')"),
    false,
  );
  pass("Event selection without search or archive controls");
  await browser("select", ".events-panel select", "past");
  await until(
    "performance.getEntriesByType('resource').some(e=>e.name.includes('scope=past'))",
  );
  await browser("select", ".events-panel select", "upcoming");
  await until("document.querySelectorAll('.event-card').length>=2");
  pass("Past and upcoming event scopes");
  await evaluate("document.querySelector('.event-card').click()");
  await until("document.querySelector('.ticket-type')");
  assert.equal(
    await evaluate("!!document.querySelector('.selling-analysis')"),
    false,
  );
  const firstUrl = await evaluate("location.href");
  await evaluate("document.querySelector('.ticket-type').click()");
  await until("document.querySelector('.selling-analysis .recharts-wrapper')");
  assert.equal(
    await evaluate("!!document.querySelector('.history-controls')"),
    false,
  );
  pass("Event then ticket type opens selling graphs without snapshot controls");
  await browser("select", ".selling-analysis select", "sold");
  await until(
    "document.querySelector('.selling-analysis select').value==='sold'",
  );
  await browser("select", ".selling-analysis select", "all");
  pass("Purchased-only scatter comparison and return");
  await browser(
    "select",
    ".analysis-area > .graph-controls label:first-child select",
    "7",
  );
  await until(
    "performance.getEntriesByType('resource').some(e=>e.name.includes('days=7')) && !document.querySelector('.analysis-area > .loading[role=status]')",
  );
  pass("Analysis period fetches filtered data");
  await evaluate(
    "[...document.querySelectorAll('.event-family')].find(e=>e.textContent.includes('iLIVE!')).querySelector('button').click()",
  );
  await until(
    "document.querySelector('.ticket-type') && !document.querySelector('.selling-analysis')",
  );
  await evaluate(
    "[...document.querySelectorAll('.ticket-type')].find(e=>e.textContent.includes('Sチケット')).click()",
  );
  await until("document.querySelector('.selling-analysis .recharts-wrapper')");
  const options = await evaluate(
    "document.querySelectorAll('.analysis-area > .graph-controls select')[1].options.length",
  );
  assert.ok(options >= 2);
  const lastSale = await evaluate(
    "[...document.querySelectorAll('.analysis-area > .graph-controls select')[1].options].at(-1).value",
  );
  await browser(
    "select",
    ".analysis-area > .graph-controls label:nth-child(2) select",
    lastSale,
  );
  await until(
    "document.querySelector('.selling-analysis').textContent.includes('基準発売')",
  );
  pass("Official release baseline can switch between sales windows");
  await browser("click", ".evidence-details summary");
  assert.ok(await evaluate("document.querySelector('.evidence-details').open"));
  assert.ok(
    await evaluate(
      "document.querySelector('.evidence-details').textContent.includes('成約価格')",
    ),
  );
  pass("Evidence clearly separates purchased status from actual sale price");
  await browser("back");
  await until(
    "document.querySelector('.ticket-type') && !document.querySelector('.selling-analysis')",
  );
  assert.equal(await evaluate("location.href"), firstUrl);
  pass("Back navigation resets ticket selection");
  await browser("open", firstUrl);
  await until("document.querySelector('.ticket-type')");
  await evaluate("document.querySelector('.ticket-type').click()");
  await until("document.querySelector('.selling-analysis .recharts-wrapper')");
  for (const width of [1440, 390]) {
    await browser("set", "viewport", String(width), "1000");
    await until("document.documentElement.scrollWidth<=innerWidth");
    await browser(
      "screenshot",
      resolve(".local/evidence/selling-" + width + ".png"),
    );
    await evaluate("document.querySelector('.chart-grid').scrollIntoView()");
    await browser(
      "screenshot",
      resolve(".local/evidence/selling-charts-" + width + ".png"),
    );
    await evaluate("window.scrollTo(0,0)");
  }
  pass("Direct URL and desktop/mobile graphs without horizontal overflow");
  await browser("open", base + "/?event=00000000-0000-4000-8000-000000000000");
  await until(
    "document.querySelector('[role=alert]')?.textContent.includes('404')",
  );
  await evaluate("document.querySelector('.event-card').click()");
  await until("document.querySelector('.ticket-type')");
  pass("Unknown event error and recovery");
  await browser("open", base + "/admin");
  await browser("fill", "input[type=password]", "invalid-verification-key");
  await browser("click", "form button");
  await until("document.querySelector('[role=alert]')");
  if (process.env.ADMIN_TOKEN) {
    await browser("fill", "input[type=password]", process.env.ADMIN_TOKEN);
    await browser("click", "form button");
    await until("document.body.textContent.includes('公式情報の確認待ち')");
    pass("Admin rejects invalid token and accepts configured token");
  } else
    pass(
      "Admin rejects invalid token (valid login not tested without ADMIN_TOKEN)",
    );
  const errors = await browser("errors");
  assert.ok(!errors.errors?.length, "Unexpected JavaScript errors");
  await writeFile(
    ".local/evidence/routes-browser.json",
    JSON.stringify({ checkedAt: new Date(), base, checks, errors }, null, 2),
  );
  console.log(checks.length + " browser checks passed");
} finally {
  await browser("close");
}
