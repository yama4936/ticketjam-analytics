import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retryAfterMs,
  TicketjamHttp,
  SourceBlockedError,
} from "../packages/sources/ticketjam/http.js";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
test("429 backoff honors Retry-After and does not retry aggressively", () => {
  const now = Date.UTC(2026, 8, 30);
  assert.equal(retryAfterMs(null, now), 3600000);
  assert.equal(retryAfterMs("10", now), 3600000);
  assert.equal(retryAfterMs("7200", now), 7200000);
  assert.equal(
    retryAfterMs(new Date(now + 86400000).toUTCString(), now),
    86400000,
  );
  assert.equal(retryAfterMs("invalid", now), 3600000);
});

test(
  "PostgreSQL: shared spacing and a 403 stop other clients before another request",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      await pool.query(
        "UPDATE source_state SET blocked_until=NULL,block_reason=NULL,next_request_at=now(),min_interval_ms=1000 WHERE source='ticketjam'",
      );
      const calls: { url: string; time: number }[] = [];
      const fake: typeof fetch = async (input) => {
        const url = String(input);
        calls.push({ url, time: Date.now() });
        return url.endsWith("robots.txt")
          ? new Response("User-agent: *\nDisallow: /users/", {
              headers: { "content-type": "text/plain" },
            })
          : new Response("denied", { status: 403 });
      };
      await assert.rejects(
        new TicketjamHttp(pool, fake).get(
          "https://ticketjam.jp/tickets/test/event/123",
        ),
        SourceBlockedError,
      );
      assert.equal(calls.length, 2);
      assert.ok(
        calls[1]!.time - calls[0]!.time >= 900,
        "Requests honor database spacing",
      );
      await assert.rejects(
        new TicketjamHttp(pool, fake).get(
          "https://ticketjam.jp/tickets/test/event/123",
        ),
        SourceBlockedError,
      );
      assert.equal(calls.length, 2, "No HTTP after a shared source block");
    } finally {
      await pool.query(
        "UPDATE source_state SET blocked_until=NULL,block_reason=NULL,next_request_at=now(),min_interval_ms=5000 WHERE source='ticketjam'",
      );
      await pool.end();
    }
  },
);

test(
  "PostgreSQL: public redirects do not block other events; network failures still reserve spacing",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      await pool.query(
        "UPDATE source_state SET blocked_until=NULL,block_reason=NULL,next_request_at=now(),min_interval_ms=1000 WHERE source='ticketjam'",
      );
      const calls: number[] = [];
      const fake: typeof fetch = async (input) => {
        calls.push(Date.now());
        if (String(input).endsWith("robots.txt"))
          return new Response("User-agent: *\nAllow: /", {
            headers: { "content-type": "text/plain" },
          });
        if (calls.length === 2)
          return new Response(null, {
            status: 302,
            headers: { location: "/tickets/test/event/123" },
          });
        throw new Error("network unavailable");
      };
      const client = new TicketjamHttp(pool, fake);
      await assert.rejects(
        client.get("https://ticketjam.jp/ticket/live_domestic/1"),
        /302/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT blocked_until FROM source_state WHERE source='ticketjam'",
          )
        ).rows[0].blocked_until,
        null,
      );
      await assert.rejects(
        client.get("https://ticketjam.jp/tickets/test/event/123"),
        /network unavailable/,
      );
      await assert.rejects(
        client.get("https://ticketjam.jp/tickets/test/event/123"),
        /network unavailable/,
      );
      assert.ok(calls[3]! - calls[2]! >= 900);
    } finally {
      await pool.query(
        "UPDATE source_state SET min_interval_ms=5000 WHERE source='ticketjam'",
      );
      await pool.end();
    }
  },
);

test(
  "purchase checks follow one public redirect with isolated anonymous cookies",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      await pool.query(
        "UPDATE source_state SET blocked_until=NULL,next_request_at=now(),min_interval_ms=1000 WHERE source='ticketjam'",
      );
      const cookies: string[] = [];
      const fake: typeof fetch = async (input, init) => {
        const url = String(input);
        const cookie = new Headers(init?.headers).get("cookie") ?? "";
        cookies.push(cookie);
        if (url.endsWith("robots.txt"))
          return new Response("User-agent: *\nAllow: /", {
            headers: { "content-type": "text/plain" },
          });
        if (url.includes("/ticket/")) {
          assert.equal(cookie, "");
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://ticketjam.jp/tickets/test/event/123",
              "set-cookie": "flash=purchased; Path=/; HttpOnly",
            },
          });
        }
        assert.equal(cookie, "flash=purchased");
        return new Response(
          '<div class="flash_wrapper"><p>購入済みチケットのため、同じ公演のチケットを表示しています。</p></div>',
          { headers: { "content-type": "text/html" } },
        );
      };
      const http = new TicketjamHttp(pool, fake);
      assert.equal(
        (
          await http.getTicketOutcome(
            "https://ticketjam.jp/ticket/live_domestic/1",
          )
        ).finalUrl,
        "https://ticketjam.jp/tickets/test/event/123",
      );
      await http.getTicketOutcome(
        "https://ticketjam.jp/ticket/live_domestic/2",
      );
      assert.deepEqual(cookies, [
        "",
        "",
        "flash=purchased",
        "",
        "flash=purchased",
      ]);
    } finally {
      await pool.query(
        "UPDATE source_state SET blocked_until=NULL,next_request_at=now(),min_interval_ms=5000 WHERE source='ticketjam'",
      );
      await pool.end();
    }
  },
);
