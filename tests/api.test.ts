import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent, persistBatch } from "../packages/db/ingest.js";
import { storeOfficial } from "../packages/db/official.js";
import { buildServer } from "../apps/api/server.js";
test(
  "API: filter same official ticket, retain asking price semantics, validate input and admin access",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    process.env.ADMIN_TOKEN = randomUUID();
    const app = await buildServer(pool);
    try {
      await migrate(pool);
      const suffix = randomUUID(),
        now = new Date(),
        at = new Date(now.getTime() + 86400000 * 10);
      const event = {
        externalId: suffix,
        url: "https://ticketjam.jp/tickets/test/event/1",
        title: `Test ${suffix}`,
        startsAt: at.toISOString(),
        venue: "Hall",
      };
      const sourceId = await registerEvent(pool, event);
      const eventId = (
        await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
          sourceId,
        ])
      ).rows[0].event_id;
      const listings = ["A", "B"].map((prefix, i) => ({
        externalId: `${suffix}-${i}`,
        url: `https://ticketjam.jp/ticket/live_domestic/${i + 1}`,
        priceYen: 4000 * (i + 1),
        quantity: i + 1,
        admissionRaw: `${prefix}12`,
        ticketType: null,
        state: "listed" as const,
        confirmedSalePriceYen: null,
      }));
      await persistBatch(
        pool,
        sourceId,
        new Date(Math.floor(now.getTime() / 3600000) * 3600000),
        [
          {
            observedAt: now,
            page: {
              event,
              listings,
              expectedCount: 2,
              nextUrl: null,
              warnings: [],
            },
          },
        ],
      );
      await storeOfficial(
        pool,
        `https://ticketdive.com/event/test-${suffix}`,
        now,
        [
          {
            eventName: event.title,
            stageName: "Stage",
            stageId: suffix,
            startsAt: event.startsAt,
            venue: "Hall",
            drinkYen: null,
            tickets: [
              {
                name: "優先券",
                prefix: "A",
                price: 2000,
                fee: 100,
                windowId: "a",
                windowName: "先行",
                startsAt: now.toISOString(),
                endsAt: null,
              },
              {
                name: "一般券",
                prefix: "B",
                price: 1000,
                fee: 100,
                windowId: "b",
                windowName: "先行",
                startsAt: now.toISOString(),
                endsAt: null,
              },
            ],
          },
        ],
      );
      let r = await app.inject(`/api/events/${eventId}`);
      assert.equal(r.statusCode, 200);
      let data = r.json();
      assert.equal(data.summary.medianPrice, 6000);
      assert.equal(data.summary.ticketCount, 3);
      assert.equal(data.official.length, 2);
      const comparison = (await app.inject("/api/comparison?by=prefix")).json();
      assert.deepEqual(
        comparison.rows
          .filter((r: { event_id: string }) => r.event_id === eventId)
          .map(
            (r: {
              segment: string;
              listing_count: number;
              median_price_yen: number;
            }) => [r.segment, r.listing_count, r.median_price_yen],
          ),
        [
          ["A", 1, 4000],
          ["B", 1, 8000],
        ],
      );
      const official = data.official.find(
        (t: { name: string }) => t.name === "優先券",
      );
      r = await app.inject(
        `/api/events/${eventId}?officialType=${official.id}`,
      );
      assert.equal(r.statusCode, 200);
      data = r.json();
      assert.equal(data.summary.listingCount, 1);
      assert.equal(data.summary.medianPrice, 4000);
      assert.equal(data.timeline[0].newCount, 1);
      assert.equal(data.listings[0].confirmed_sale_price_yen, null);
      assert.equal(
        (await app.inject(`/api/events/${eventId}?lower=100&upper=1`))
          .statusCode,
        400,
      );
      assert.equal(
        (await app.inject("/api/events/not-a-uuid")).statusCode,
        400,
      );
      assert.equal(
        (await app.inject(`/api/events/${randomUUID()}`)).statusCode,
        404,
      );
      assert.equal((await app.inject("/api/admin/summary")).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/summary",
            headers: { authorization: "Bearer " + "あ".repeat(36) },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/summary",
            headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
          })
        ).statusCode,
        200,
      );
      const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
      const evidenceId = official.evidence_id;
      for (const decision of ["rejected", "confirmed"]) {
        const reviewed = await app.inject({
          method: "POST",
          url: `/api/admin/evidence/${evidenceId}`,
          headers,
          payload: { decision, note: "APIから公式対応づけを訂正する検証" },
        });
        assert.equal(reviewed.statusCode, 200);
        const detail = (await app.inject(`/api/events/${eventId}`)).json();
        assert.equal(
          detail.official.some(
            (t: { evidence_id: string }) => t.evidence_id === evidenceId,
          ),
          decision === "confirmed",
        );
      }
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM official_reviews WHERE evidence_id=$1",
            [evidenceId],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await pool.query("SELECT * FROM official_evidence WHERE id=$1", [
            evidenceId,
          ])
        ).rowCount,
        1,
        "Review correction retains original evidence",
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
