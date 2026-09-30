import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent, persistBatch } from "../packages/db/ingest.js";
import { checkOutcomes } from "../apps/worker/outcomes.js";
import { buildServer } from "../apps/api/server.js";
test(
  "purchase evidence confirms missing tickets even after partial collection, without inventing price or altering observations",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    await migrate(pool);
    const app = await buildServer(pool);
    try {
      const key = randomUUID();
      const event = {
        externalId: key,
        title: "購入確認 " + key,
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        venue: "Hall",
        url: "https://ticketjam.jp/tickets/test/event/" + key,
      };
      const sourceId = await registerEvent(pool, event);
      const eventId = (
        await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
          sourceId,
        ])
      ).rows[0].event_id;
      const at = new Date(Date.now() - 7200000),
        later = new Date(Date.now() - 3600000);
      const listing = (i: number) => ({
        externalId: key + "-" + i,
        url: "https://ticketjam.jp/ticket/live_domestic/" + i,
        priceYen: 5000 + i * 1000,
        quantity: 1,
        admissionRaw: "S100番台",
        ticketType: null,
        state: "listed" as const,
        confirmedSalePriceYen: null,
      });
      await persistBatch(pool, sourceId, at, [
        {
          observedAt: at,
          page: {
            event,
            listings: [listing(1), listing(2), listing(3)],
            expectedCount: 3,
            nextUrl: null,
            warnings: [],
          },
        },
      ]);
      await persistBatch(pool, sourceId, later, [
        {
          observedAt: later,
          page: {
            event,
            listings: [listing(1)],
            expectedCount: 3,
            nextUrl: null,
            warnings: ["partial"],
          },
        },
      ]);
      const html =
        '<div class="flash_wrapper"><p>購入済みチケットのため、同じ公演のチケットを表示しています。</p></div>';
      const checkedAt = new Date();
      let requests = 0;
      const fake = {
        getTicketOutcome: async (url: string) => {
          requests++;
          return {
            html: url.endsWith("/2") ? html : "unconfirmed",
            finalUrl: event.url,
            observedAt: checkedAt,
          };
        },
      };
      const result = await checkOutcomes(pool, fake, eventId);
      assert.equal(result.purchased, 1);
      assert.equal(requests, 2);
      await checkOutcomes(pool, fake, eventId);
      assert.equal(
        requests,
        2,
        "successful checks are idempotent / unconfirmed checks wait a day",
      );
      const detail = (await app.inject("/api/events/" + eventId)).json();
      assert.equal(detail.outcomes.length, 3);
      const purchased = detail.outcomes.find(
        (o: any) => o.state === "sold_confirmed",
      );
      assert.equal(purchased.asking_price_yen, 7000);
      assert.equal(purchased.confirmed_sale_price_yen, null);
      assert.equal(purchased.interval_start, at.toISOString());
      assert.equal(purchased.interval_end, checkedAt.toISOString());
      assert.equal(
        detail.outcomes.filter((o: any) => o.state === "listed").length,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM listing_observations o JOIN listings l ON l.id=o.listing_id WHERE l.event_id=$1",
            [eventId],
          )
        ).rows[0].n,
        4,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM listing_changes c JOIN listings l ON l.id=c.listing_id WHERE l.event_id=$1 AND kind='sold_confirmed'",
            [eventId],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
