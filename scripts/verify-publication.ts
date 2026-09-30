import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const origin = "https://tickets.yama.asia";
const checks: string[] = [];
async function request(path: string, expected = 200, init?: RequestInit) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, expected, path);
  return response;
}
try {
  const http = await fetch(
    origin.replace("https:", "http:") + "/?publication=verify",
    {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    },
  );
  assert.ok([301, 302, 307, 308].includes(http.status));
  assert.equal(http.headers.get("location"), origin + "/?publication=verify");
  checks.push("HTTP redirects to HTTPS preserving path and query");
  const root = await request("/");
  assert.equal(root.headers.get("x-content-type-options"), "nosniff");
  const html = await root.text();
  assert.ok(html.includes("Ticket Observatory"));
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(
    (m) => m[1]!,
  );
  assert.ok(assets.length >= 2);
  for (const asset of assets) await request(asset);
  checks.push(
    "TLS certificate verified; page, JavaScript and stylesheet return 200",
  );
  for (const path of [
    "/healthz",
    "/api/status",
    "/api/groups",
    "/api/comparison?by=event",
    "/api/comparison?by=type",
    "/api/comparison?by=prefix",
  ])
    await request(path);
  const events = await (await request("/api/events")).json();
  assert.ok(events.events.length > 0);
  const eventId = events.events[0].id;
  assert.ok(
    (await (await request("/?event=" + eventId)).text()).includes(
      "Ticket Observatory",
    ),
  );
  const detail = await (await request("/api/events/" + eventId)).json();
  assert.equal(detail.event.id, eventId);
  checks.push("Public API, comparison and direct event URL return live data");
  await request("/admin");
  for (const path of ["/api/admin/summary", "/api/%61dmin/summary"])
    await request(path, 401);
  for (const path of ["/api/admin/groups", "/api/%61dmin/groups"])
    await request(path, 401, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  await request("/api/events/not-a-uuid", 400);
  await request("/api/events/00000000-0000-4000-8000-000000000000", 404);
  checks.push(
    "Admin rejects unauthenticated normal/encoded GET and POST; invalid IDs are rejected",
  );
  await mkdir(".local/evidence", { recursive: true });
  await writeFile(
    ".local/evidence/publication.json",
    JSON.stringify(
      {
        url: origin,
        checkedAt: new Date(),
        domainConfigured: true,
        externalHttpsVerified: true,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ url: origin, checks }, null, 2));
} catch (error) {
  await mkdir(".local/evidence", { recursive: true });
  await writeFile(
    ".local/evidence/publication.json",
    JSON.stringify(
      {
        url: origin,
        checkedAt: new Date(),
        externalHttpsVerified: false,
        checks,
      },
      null,
      2,
    ),
  );
  throw error;
}
