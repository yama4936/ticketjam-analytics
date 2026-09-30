import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent, persistBatch } from "../packages/db/ingest.js";
import { storeOfficial } from "../packages/db/official.js";
import { buildServer } from "../apps/api/server.js";

test(
  "saved snapshots preserve former inventory independently of current state, period and other events",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    await migrate(pool);
    const app = await buildServer(pool);
    try {
      const key = randomUUID();
      const event = {
        externalId: key,
        url: "https://ticketjam.jp/tickets/test/event/2",
        title: "履歴検証 " + key,
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        venue: "Hall",
      };
      const sourceId = await registerEvent(pool, event);
      const eventId = (
        await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
          sourceId,
        ])
      ).rows[0].event_id;
      await storeOfficial(
        pool,
        "https://ticketdive.com/event/" + key,
        new Date(),
        [
          {
            eventName: event.title,
            stageName: "第1部",
            stageId: key,
            startsAt: event.startsAt,
            venue: event.venue,
            drinkYen: null,
            tickets: [
              {
                name: "ライブチケット",
                prefix: "A",
                price: 1500,
                fee: 100,
                windowId: "sale",
                windowName: "一般",
                startsAt: event.startsAt,
                endsAt: null,
              },
            ],
          },
        ],
      );
      const observe = async (time: Date, entries: number[][]) =>
        persistBatch(pool, sourceId, time, [
          {
            observedAt: time,
            page: {
              event,
              listings: entries.map(([id, price, quantity]) => ({
                externalId: `${key}-${id}`,
                url: `https://ticketjam.jp/ticket/live_domestic/${id}`,
                priceYen: price!,
                quantity: quantity!,
                admissionRaw: id === 1 ? "ライブチケット A10" : "記載不明",
                ticketType: null,
                state: "listed" as const,
                confirmedSalePriceYen: null,
              })),
              expectedCount: entries.length,
              nextUrl: null,
              warnings: [],
            },
          },
        ]);
      await observe(new Date(Date.now() - 40 * 86400000), [
        [1, 4000, 2],
        [2, 7000, 1],
      ]);
      await observe(new Date(), [
        [1, 3000, 1],
        [3, 6000, 1],
      ]);
      const current = (await app.inject(`/api/events/${eventId}`)).json();
      assert.equal(current.view, "current");
      assert.equal(current.snapshots.length, 2);
      assert.deepEqual(
        current.listings.map((x: any) => x.price_yen),
        [3000, 6000],
      );
      assert.equal(current.summary.ticketCount, 2);
      const oldId = current.snapshots[1].id;
      const old = (
        await app.inject(`/api/events/${eventId}?snapshot=${oldId}&days=7`)
      ).json();
      assert.equal(old.view, "history");
      assert.equal(old.selectedSnapshot.id, oldId);
      assert.deepEqual(
        old.listings.map((x: any) => [x.price_yen, x.quantity]),
        [
          [4000, 2],
          [7000, 1],
        ],
      );
      assert.equal(old.summary.ticketCount, 3);
      assert.equal(old.summary.medianPrice, null);
      const typeId = current.official[0].id;
      const oldType = (
        await app.inject(
          `/api/events/${eventId}?snapshot=${oldId}&officialType=${typeId}`,
        )
      ).json();
      assert.equal(oldType.summary.medianPrice, 4000);
      assert.equal(
        oldType.priceGroups.find((g: any) => g.official_type_id === typeId)
          .median_price_yen,
        4000,
      );
      const nowType = (
        await app.inject(`/api/events/${eventId}?officialType=${typeId}`)
      ).json();
      assert.equal(nowType.summary.medianPrice, 3000);
      const unknown = (
        await app.inject(
          `/api/events/${eventId}?snapshot=${oldId}&officialType=unknown`,
        )
      ).json();
      assert.deepEqual(
        unknown.listings.map((x: any) => x.price_yen),
        [7000],
      );
      assert.equal(unknown.priceComparable, false);

      assert.equal(
        old.priceGroups.reduce((n: number, g: any) => n + g.ticket_count, 0),
        3,
      );
      assert.equal(
        (await app.inject(`/api/events/${eventId}?snapshot=bad`)).statusCode,
        400,
      );
      assert.equal(
        (await app.inject(`/api/events/${eventId}?snapshot=${randomUUID()}`))
          .statusCode,
        404,
      );
      const otherSource = await registerEvent(pool, {
        ...event,
        externalId: randomUUID(),
      });
      const otherId = (
        await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
          otherSource,
        ])
      ).rows[0].event_id;
      assert.equal(
        (await app.inject(`/api/events/${otherId}?snapshot=${oldId}`))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject(`/api/events/${eventId}`)).json().selectedSnapshot.id,
        current.snapshots[0].id,
      );
      await pool.query(
        "UPDATE events SET starts_at=now()-interval '1 day' WHERE id=$1",
        [eventId],
      );
      assert.equal(
        (await app.inject(`/api/events/${eventId}`)).json().view,
        "history",
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
