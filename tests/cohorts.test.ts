import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent, persistBatch } from "../packages/db/ingest.js";
import { storeOfficial } from "../packages/db/official.js";
import { buildServer } from "../apps/api/server.js";
test(
  "price cohorts separate purpose, original price and session; conflicts and ambiguous rows never enter medians",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    await migrate(pool);
    const app = await buildServer(pool);
    try {
      const id = randomUUID(),
        now = new Date(),
        startsAt = new Date(Date.now() + 86400000 * 10).toISOString();
      const event = {
        externalId: id,
        url: "https://ticketjam.jp/tickets/test/event/1",
        title: "ライブ比較検証 " + id,
        startsAt,
        venue: "Hall",
      };
      const sourceId = await registerEvent(pool, event);
      const eventId = (
        await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
          sourceId,
        ])
      ).rows[0].event_id;
      const names = ["前物販チケット", "特典会参加券", "ライブチケット"];
      await storeOfficial(pool, "https://ticketdive.com/event/" + id, now, [
        {
          eventName: event.title,
          stageName: "第1部",
          stageId: id,
          startsAt,
          venue: "Hall",
          drinkYen: null,
          tickets: names.map((name, i) => ({
            name,
            prefix: "A",
            price: [500, 1500, 4000][i]!,
            fee: 100,
            windowId: "sale",
            windowName: "一般",
            startsAt,
            endsAt: null,
          })),
        },
      ]);
      const raws = [
        "前物販チケット 1部 A10",
        "特典会参加券 1部 A20",
        "ライブチケット 1部 A30",
        "前物販チケット 2部 A40",
        "A50",
        "前物販チケット 1部 1/1 A60",
      ];
      await persistBatch(
        pool,
        sourceId,
        new Date(Math.floor(now.getTime() / 3600000) * 3600000),
        [
          {
            observedAt: now,
            page: {
              event,
              listings: raws.map((admissionRaw, i) => ({
                externalId: id + "-" + i,
                url: "https://ticketjam.jp/ticket/live_domestic/" + (i + 1),
                priceYen: [1000, 5000, 9000, 100000, 200000, 300000][i]!,
                quantity: 1,
                admissionRaw,
                ticketType: null,
                state: "listed" as const,
                confirmedSalePriceYen: null,
              })),
              expectedCount: raws.length,
              nextUrl: null,
              warnings: [],
            },
          },
        ],
      );
      const data = (await app.inject("/api/events/" + eventId)).json();
      assert.equal(data.summary.medianPrice, null);
      const groups = data.priceGroups;
      assert.equal(groups.filter((g: any) => g.official_type_id).length, 3);
      assert.equal(
        groups
          .filter((g: any) => !g.official_type_id)
          .reduce((n: number, g: any) => n + g.listing_count, 0),
        3,
      );
      for (const [i, name] of names.entries()) {
        const g = groups.find((g: any) => g.segment === name);
        assert.equal(g.listing_count, 1);
        assert.equal(g.median_price_yen, [1000, 5000, 9000][i]);
        assert.equal(g.face_value_yen, [500, 1500, 4000][i]);
        const selected = (
          await app.inject(
            "/api/events/" + eventId + "?officialType=" + g.official_type_id,
          )
        ).json();
        assert.equal(selected.summary.listingCount, 1);
        assert.equal(selected.summary.medianPrice, g.median_price_yen);
      }
      for (const by of ["event", "type", "prefix"]) {
        const comparison = (await app.inject("/api/comparison?by=" + by))
          .json()
          .rows.filter((r: any) => r.event_id === eventId);
        assert.equal(
          comparison.filter((g: any) => g.official_type_id).length,
          3,
        );
        assert.ok(
          comparison
            .filter((g: any) => !g.official_type_id)
            .every((g: any) => g.median_price_yen === null),
        );
      }
      const unknownFace = groups.find((g: any) => g.segment === names[0]);
      await pool.query(
        "UPDATE ticket_types SET face_value_yen=NULL WHERE id=$1",
        [unknownFace.official_type_id],
      );
      const unknownDetail = (
        await app.inject(
          "/api/events/" +
            eventId +
            "?officialType=" +
            unknownFace.official_type_id,
        )
      ).json();
      assert.equal(unknownDetail.priceComparable, false);
      assert.equal(unknownDetail.summary.medianPrice, null);
      assert.deepEqual(unknownDetail.histogram, []);
      assert.ok(
        unknownDetail.timeline.every(
          (point: any) => point.medianPrice === null,
        ),
      );
      // A known session can identify a single official type even when its prefix is absent.
      await pool.query(
        "DELETE FROM sale_windows WHERE ticket_type_id IN(SELECT id FROM ticket_types WHERE event_id=$1 AND name<>$2)",
        [eventId, names[0]],
      );
      await pool.query(
        "DELETE FROM ticket_types WHERE event_id=$1 AND name<>$2",
        [eventId, names[0]],
      );
      const match = async (raw: string) =>
        (
          await pool.query(
            "SELECT matched_ticket_type_v1($1,$2,NULL,NULL) AS id",
            [eventId, raw],
          )
        ).rows[0].id;
      assert.ok(await match("１部 10番台"));
      assert.equal(await match("２部 10番台"), null);
      assert.equal(await match("10番台"), null);
      assert.equal(await match("ライブ 1部 10番台"), null);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
