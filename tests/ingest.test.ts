import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { persistBatch, registerEvent } from "../packages/db/ingest.js";
import type { EventPage, SourceListing } from "../packages/domain/types.js";

test(
  "PostgreSQL: idempotent history, partial coverage, inferred end and reappearance",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      await migrate(pool);
      const suffix = randomUUID();
      const event = {
        externalId: `test-${suffix}`,
        url: "https://ticketjam.jp/tickets/test/event/1",
        title: "Test",
        startsAt: "2026-12-01T18:00:00+09:00",
        venue: "Test",
      };
      const sourceId = await registerEvent(pool, event);
      const groupIds = (
        await pool.query(
          "INSERT INTO groups(name) VALUES($1),($2) RETURNING id",
          [`Group A ${suffix}`, `Group B ${suffix}`],
        )
      ).rows.map((r) => r.id);
      for (const groupId of groupIds)
        assert.equal(await registerEvent(pool, event, groupId), sourceId);
      assert.equal(
        (
          await pool.query(
            "SELECT eg.* FROM event_groups eg JOIN source_events s ON s.event_id=eg.event_id WHERE s.id=$1",
            [sourceId],
          )
        ).rowCount,
        2,
      );
      assert.equal(await registerEvent(pool, event), sourceId);
      const item: SourceListing = {
        externalId: suffix,
        url: "https://ticketjam.jp/ticket/live_domestic/1",
        priceYen: 5000,
        quantity: 2,
        admissionRaw: "A12",
        ticketType: null,
        state: "listed",
        confirmedSalePriceYen: null,
      };
      const batch = async (
        hour: number,
        items: SourceListing[],
        count: number,
      ) => {
        const at = new Date(Date.UTC(2026, 8, 1, hour));
        const page: EventPage = {
          event,
          listings: items,
          expectedCount: count,
          nextUrl: null,
          warnings: [],
        };
        return persistBatch(pool, sourceId, at, [{ page, observedAt: at }]);
      };
      const r1 = await batch(1, [item], 1);
      assert.equal((await batch(1, [item], 1)).duplicate, true);
      await batch(2, [{ ...item, priceYen: 4000, quantity: 1 }], 1);
      await batch(3, [], 1); // failure to find a row is not evidence of sale/end
      const state = async () =>
        (
          await pool.query("SELECT state FROM listings WHERE external_id=$1", [
            suffix,
          ])
        ).rows[0].state;
      assert.equal(await state(), "listed");
      await batch(4, [], 0);
      assert.equal(await state(), "ended_unknown");
      await batch(5, [{ ...item, priceYen: 4000, quantity: 1 }], 1);
      assert.equal(await state(), "listed");
      await batch(
        6,
        [{ ...item, priceYen: 4000, quantity: 1, state: "sold_confirmed" }],
        1,
      );
      assert.equal(await state(), "sold_confirmed");
      const changes = (
        await pool.query(
          "SELECT c.* FROM listing_changes c JOIN listings l ON l.id=c.listing_id WHERE l.external_id=$1 ORDER BY interval_end",
          [suffix],
        )
      ).rows;
      assert.deepEqual(
        changes.map((x) => x.kind).sort(),
        [
          "first_seen",
          "price_drop",
          "quantity_changed",
          "ended_unknown",
          "reappeared",
          "sold_confirmed",
        ].sort(),
      );
      const sold = changes.find((x) => x.kind === "sold_confirmed");
      assert.equal(
        sold.interval_start.toISOString(),
        "2026-09-01T05:00:00.000Z",
      );
      const observations = (
        await pool.query(
          "SELECT o.* FROM listing_observations o JOIN listings l ON l.id=o.listing_id WHERE l.external_id=$1 ORDER BY observed_at",
          [suffix],
        )
      ).rows;
      assert.equal(observations.length, 4);
      assert.equal(observations[0].price_yen, 5000);
      assert.equal(observations.at(-1).confirmed_sale_price_yen, null);
      assert.equal(
        (
          await pool.query(
            "SELECT ticket_count FROM event_metrics WHERE run_id=$1",
            [r1.runId],
          )
        ).rows[0].ticket_count,
        2,
      );
      await assert.rejects(batch(0, [item], 1), /Out-of-order/);
      const observationId = observations[0].id;
      const before = (
        await pool.query(
          "SELECT md5(to_jsonb(o)::text) AS hash FROM listing_observations o WHERE id=$1",
          [observationId],
        )
      ).rows[0].hash;
      await pool.query(
        "DELETE FROM observation_normalizations WHERE observation_id=$1",
        [observationId],
      );
      const reprocess = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/reprocess.ts"],
        {
          env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
          encoding: "utf8",
        },
      );
      assert.equal(reprocess.status, 0, reprocess.stderr);
      assert.equal(
        (
          await pool.query(
            "SELECT admission_lower FROM observation_normalizations WHERE observation_id=$1",
            [observationId],
          )
        ).rows[0].admission_lower,
        12,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT md5(to_jsonb(o)::text) AS hash FROM listing_observations o WHERE id=$1",
            [observationId],
          )
        ).rows[0].hash,
        before,
      );
    } finally {
      await pool.end();
    }
  },
);
