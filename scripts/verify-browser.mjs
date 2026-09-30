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
  await until(
    "document.querySelectorAll('.event-card').length >= 2 && document.querySelector('.analysis-area table')",
  );
  await browser("snapshot", "-i");
  await evaluate("performance.clearResourceTimings()");
  await browser("click", ".topbar button");
  await until(
    "performance.getEntriesByType('resource').some(e=>e.name.includes('/api/comparison'))",
  );
  pass("Comparison reload requests fresh data");
  await browser(
    "fill",
    "input[placeholder='公演を検索']",
    "no-such-event-890123",
  );
  await until(
    "document.querySelector('.events-panel .empty')?.textContent.includes('該当する公演')",
  );
  await browser("click", "input[placeholder='公演を検索']");
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  await until("document.querySelectorAll('.event-card').length >= 2");
  pass("Search empty result and recovery");
  await browser("click", ".event-card:first-child");
  await until("document.querySelector('.filterbar')");
  const firstUrl = await evaluate("location.href");
  await browser("click", ".event-card:first-child");
  await until("document.querySelector('.filterbar')");
  pass("Reselecting current event preserves loaded detail");
  await browser("fill", "input[placeholder='1']", "200");
  await browser("fill", "input[placeholder='100']", "100");
  await until(
    "[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('400'))",
  );
  await browser("fill", "input[placeholder='1']", "1");
  await browser("click", "input[placeholder='100']");
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  await until("!document.querySelector('.analysis-area [role=alert]')");
  pass("Invalid numeric range reports error and recovers");
  await browser("click", ".event-card:last-child");
  await until("document.querySelector('.filterbar')");
  await browser("fill", "input[placeholder='A / B / S']", "ZZZ");
  await until("document.querySelector('.metrics')?.textContent.includes('0')");
  await browser("back");
  await until("document.querySelector('.filterbar')");
  assert.equal(await evaluate("location.href"), firstUrl);
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('.filterbar input')].map(e=>e.value)",
    ),
    ["", "", ""],
  );
  pass("Back navigation resets event-specific filters");
  await browser("click", ".tabs button:nth-child(2)");
  await until(
    "document.querySelector('.tabs button:nth-child(2)').classList.contains('active')",
  );
  await browser("click", ".tabs button:nth-child(3)");
  await until(
    "document.querySelector('.tabs button:nth-child(3)').classList.contains('active')",
  );
  pass("Listing and official/coverage tabs");
  await browser("open", firstUrl);
  await until("document.querySelector('.filterbar')");
  pass("Direct event URL loads");
  for (const width of [1440, 390]) {
    await browser("set", "viewport", String(width), "900");
    await until("document.documentElement.scrollWidth <= innerWidth");
    await mkdir(".local/evidence", { recursive: true });
    await browser(
      "screenshot",
      resolve(".local/evidence/routes-" + width + ".png"),
    );
  }
  pass("Desktop/mobile layout has no horizontal overflow");
  await browser("open", base + "/?event=00000000-0000-4000-8000-000000000000");
  await until(
    "document.querySelector('[role=alert]')?.textContent.includes('404')",
  );
  await browser("click", ".event-card:first-child");
  await until("document.querySelector('.filterbar')");
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
