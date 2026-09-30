import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent } from "../packages/db/ingest.js";
import { discoverGroup } from "../apps/worker/discover.js";
import { monitor } from "../packages/db/monitor.js";
test(
  "discovery at capacity still associates existing events and reports discovery failure/recovery",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      const suffix = randomUUID(),
        externalId = String(randomInt(1_000_000_000, 2_000_000_000)),
        unknownId = String(Number(externalId) + 1);
      const groups = (
        await pool.query(
          "INSERT INTO groups(name,ticketjam_slug) VALUES($1,$2),($3,$4) RETURNING id",
          [`A-${suffix}`, `a-${suffix}`, `B-${suffix}`, `b-${suffix}`],
        )
      ).rows;
      const source = await registerEvent(
        pool,
        {
          externalId,
          title: "Shared event",
          startsAt: new Date(Date.now() + 86400000).toISOString(),
          venue: "Hall",
          url: `https://ticketjam.jp/tickets/a/event/${externalId}`,
        },
        groups[0].id,
      );
      const calls: string[] = [];
      const result = await discoverGroup(pool, groups[1].id, 1, {
        get: async (url) => {
          calls.push(url);
          return {
            observedAt: new Date(),
            html: `<h1>リセールチケット一覧</h1><a href="/tickets/b/event/${unknownId}">new</a><a href="/tickets/b/event/${externalId}">known</a>`,
          };
        },
      });
      assert.equal(result.discovered, 2);
      assert.equal(
        calls.length,
        1,
        "At capacity no extra event HTTP request is made",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT eg.* FROM event_groups eg JOIN source_events s ON s.event_id=eg.event_id WHERE s.id=$1",
            [source],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT imported FROM discovery_candidates WHERE external_id=$1 AND group_id=$2",
            [unknownId, groups[1].id],
          )
        ).rows[0].imported,
        false,
      );
      await assert.rejects(
        discoverGroup(pool, groups[1].id, 1, {
          get: async () => {
            throw new Error("upstream unavailable");
          },
        }),
        /upstream unavailable/,
      );
      await monitor(pool);
      assert.equal(
        (
          await pool.query(
            "SELECT resolved_at FROM operational_alerts WHERE key=$1",
            [`discovery:${groups[1].id}`],
          )
        ).rows[0].resolved_at,
        null,
      );
      await discoverGroup(pool, groups[1].id, 1, {
        get: async () => ({
          observedAt: new Date(),
          html: "<h1>リセールチケット一覧</h1>",
        }),
      });
      await monitor(pool);
      assert.ok(
        (
          await pool.query(
            "SELECT resolved_at FROM operational_alerts WHERE key=$1",
            [`discovery:${groups[1].id}`],
          )
        ).rows[0].resolved_at,
      );
    } finally {
      await pool.end();
    }
  },
);
