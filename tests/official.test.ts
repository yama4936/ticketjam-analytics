import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicketdive } from "../packages/sources/official/ticketdive.js";
test("official tickets and sale windows belong only to their stage, not every session", () => {
  const detail = {
    event: { name: "公演" },
    stages: [
      {
        id: "a",
        stageName: "1部",
        startStage: "2026-10-02T03:00:00Z",
        venue: { name: "Hall" },
      },
      {
        id: "b",
        stageName: "2部",
        startStage: "2026-10-02T05:00:00Z",
        venue: { name: "Hall" },
      },
    ],
    ticketInfoList: [
      {
        id: "w",
        name: "先行",
        startApply: "2026-09-01T00:00:00Z",
        endApply: null,
        ticketTypes: [
          {
            id: "t",
            name: "優先券",
            stageIds: ["b"],
            price: 1500,
            fee: 210,
            prefix: "B",
          },
        ],
      },
    ],
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { __superjsonProps: { json: { eventDetail: detail } } } } })}</script>`;
  const result = parseTicketdive(html);
  assert.equal(result[0]!.tickets.length, 0);
  assert.deepEqual(
    [
      result[1]!.tickets[0]!.price,
      result[1]!.tickets[0]!.fee,
      result[1]!.tickets[0]!.startsAt,
    ],
    [1500, 210, "2026-09-01T00:00:00Z"],
  );
  assert.equal(result[1]!.drinkYen, null);
  assert.throws(() => parseTicketdive("<html>Login</html>"));
});

import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent } from "../packages/db/ingest.js";
import { storeOfficial, reviewOfficial } from "../packages/db/official.js";
import { randomUUID } from "node:crypto";
test(
  "PostgreSQL: official corrections remove obsolete derived windows and rejected evidence stays rejected",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      const id = randomUUID(),
        now = new Date(),
        event = {
          externalId: id,
          title: id,
          startsAt: new Date(now.getTime() + 86400000).toISOString(),
          venue: "Hall",
          url: "https://ticketjam.jp/tickets/test/event/1",
        };
      const sourceId = await registerEvent(pool, event),
        eventId = (
          await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
            sourceId,
          ])
        ).rows[0].event_id,
        url = `https://ticketdive.com/event/${id}`;
      const ticket = {
        name: "優先",
        price: 2000,
        fee: 100,
        prefix: "A",
        windowId: "one",
        windowName: "先行",
        startsAt: now.toISOString(),
        endsAt: null,
      };
      const stage = {
        eventName: id,
        stageName: "Stage",
        stageId: id,
        startsAt: event.startsAt,
        venue: "Hall",
        drinkYen: null,
        tickets: [
          ticket,
          { ...ticket, windowId: "two", windowName: "一般" },
          { ...ticket, name: "旧券種", prefix: "B" },
        ],
      };
      await storeOfficial(pool, url, now, [stage]);
      const oldEvidence = (
        await pool.query("SELECT id FROM official_evidence WHERE event_id=$1", [
          eventId,
        ])
      ).rows[0].id;
      await storeOfficial(pool, url, new Date(now.getTime() + 1000), [
        { ...stage, tickets: [{ ...ticket, price: 2500 }] },
      ]);
      await assert.rejects(
        reviewOfficial(
          pool,
          oldEvidence,
          "confirmed",
          "古い情報を再承認する操作のテスト",
        ),
        { statusCode: 409 },
      );
      let types = (
        await pool.query("SELECT * FROM ticket_types WHERE event_id=$1", [
          eventId,
        ])
      ).rows;
      assert.equal(types.length, 1);
      assert.equal(types[0].face_value_yen, 2500);
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM sale_windows WHERE ticket_type_id=$1",
            [types[0].id],
          )
        ).rowCount,
        1,
      );
      await reviewOfficial(
        pool,
        types[0].evidence_id,
        "rejected",
        "テスト用の対応づけを却下する",
      );
      await storeOfficial(pool, url, new Date(now.getTime() + 2000), [
        { ...stage, tickets: [{ ...ticket, price: 2500 }] },
      ]);
      assert.equal(
        (
          await pool.query("SELECT * FROM ticket_types WHERE event_id=$1", [
            eventId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM review_queue WHERE event_id=$1 AND status='pending'",
            [eventId],
          )
        ).rowCount,
        0,
      );
      await storeOfficial(pool, url, new Date(now.getTime() + 3000), [
        { ...stage, tickets: [{ ...ticket, price: 2800 }] },
      ]);
      assert.equal(
        (
          await pool.query("SELECT * FROM ticket_types WHERE event_id=$1", [
            eventId,
          ])
        ).rowCount,
        0,
        "Changed source fields do not revive a rejected identity",
      );
      await storeOfficial(pool, url, new Date(now.getTime() + 4000), [stage]);
      assert.equal(
        (
          await pool.query("SELECT * FROM ticket_types WHERE event_id=$1", [
            eventId,
          ])
        ).rowCount,
        0,
        "A rollback to old source fields does not revive a rejected identity",
      );
      await storeOfficial(pool, url, new Date(now.getTime() + 5000), [
        { ...stage, tickets: [{ ...ticket, price: 2800 }] },
      ]);
      const latest = (
        await pool.query(
          "SELECT * FROM official_evidence WHERE event_id=$1 ORDER BY checked_at DESC LIMIT 1",
          [eventId],
        )
      ).rows[0];
      assert.equal(latest.review_status, "pending");
      await reviewOfficial(
        pool,
        latest.id,
        "confirmed",
        "新しい根拠を確認して対応づけを再承認する",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT face_value_yen FROM ticket_types WHERE event_id=$1",
            [eventId],
          )
        ).rows[0].face_value_yen,
        2800,
      );
    } finally {
      await pool.end();
    }
  },
);

import { parseTvasahiGift } from "../packages/sources/official/tvasahi.js";
test("GIFT: day-specific types and sales; absent historical release dates stay unknown", () => {
  const html = `<h2>GIFT ～Girls Idol Festival Tokyo～</h2><table class="about"><tr><td class="place"><a>SGC HALL ARIAKE、TOYOTA ARENA TOKYO</a><p>${[1, 2, 3].map((d) => `【DAY-${d}】 2026年11月${26 + d}日（日） 開場11:30／開演13:00`).join("<br>")}</p></td></tr></table><table class="ticket-type"><tbody>${[1, 2, 3].map((d) => `<tr><td class="type">【DAY-${d}】 ${d === 1 ? "指定席" : "1DAY共通チケット"}</td><td class="price">￥12,000</td></tr>`).join("")}</tbody></table><table class="ticket-list"><tbody><tr><td><p class="type-arrival"><span class="tag">先着</span>一般発売</p><p class="status"><span>2026年10月3日（土） 10:00〜</span></p></td></tr>${[1, 2, 3].map((d) => `<tr><td><p class="type"><span class="tag">抽選</span>【最速先行】DAY-${d}</p><p class="status"><span></span></p></td></tr>`).join("")}</tbody></table>`;
  const stages = parseTvasahiGift(html),
    third = stages[2]!;
  assert.equal(third.startsAt, "2026-11-29T04:00:00.000Z");
  assert.equal(third.tickets.length, 2);
  assert.deepEqual(
    third.tickets.map((t) => [t.windowName, t.startsAt, t.fee]),
    [
      ["一般発売", "2026-10-03T10:00:00+09:00", null],
      ["【最速先行】DAY-3", null, null],
    ],
  );
  assert.ok(third.tickets.every((t) => t.name === "1DAY共通チケット"));
  assert.throws(
    () => parseTvasahiGift(html.replace("￥12,000", "料金未定")),
    /price missing/,
  );
});
