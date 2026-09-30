import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent } from "../packages/db/ingest.js";
import { storeOfficial } from "../packages/db/official.js";
import {
  normalizeAdmission,
  classifyTicketType,
} from "../packages/normalization/admission.js";

test(
  "ticket abbreviations and uncertain numbers retain identity without guessing number bounds",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    await migrate(pool);
    try {
      const key = randomUUID();
      const event = {
        externalId: key,
        title: "ライブ券種検証 " + key,
        startsAt: new Date(Date.now() + 86400000 * 10).toISOString(),
        venue: "Hall",
        url: "https://ticketjam.jp/tickets/test/event/3",
      };
      const source = await registerEvent(pool, event);
      const id = (
        await pool.query("SELECT event_id FROM source_events WHERE id=$1", [
          source,
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
              ["Sチケット", "S"],
              ["一般チケット", "A"],
              ["女性チケット", "L"],
            ].map(([name, prefix]) => ({
              name: name!,
              prefix: prefix!,
              price: 1000,
              fee: null,
              windowId: "sale",
              windowName: "一般",
              startsAt: event.startsAt,
              endsAt: null,
            })),
          },
        ],
      );
      const types = (
        await pool.query(
          "SELECT id,admission_prefix FROM ticket_types WHERE event_id=$1",
          [id],
        )
      ).rows;
      const ids = Object.fromEntries(
        types.map((t) => [t.admission_prefix, t.id]),
      );
      const match = async (raw: string) =>
        (
          await pool.query("SELECT matched_ticket_type_v1($1,$2,$3,$4) AS id", [
            id,
            raw,
            classifyTicketType(raw),
            normalizeAdmission(raw).prefix,
          ])
        ).rows[0].id;
      for (const raw of [
        "Sチケ700番台",
        "Sチケ 900番台",
        "S1100番以内",
        "S800番代",
        "S〜650",
        "S-820番台",
        "S535~545",
        "S200-",
        "S～210",
        "S 〜580番",
        "S120番代",
        "sチケ140番代",
        "ｓ８００番代",
      ])
        assert.equal(await match(raw), ids.S, raw);
      for (const raw of [
        "一般1730番代2連",
        "Aチケ 1000〜1500",
        "Aチケット 2000〜2010番",
        "A～1600",
        "A400番代",
        "A1500〜",
        "FC先行Aチケ",
        "A席60代",
      ])
        assert.equal(await match(raw), ids.A, raw);
      assert.equal(await match("女性チケ300番代"), ids.L);
      for (const raw of [
        "前方チケット",
        "1600番台",
        "SS700番台",
        "SSチケット700番台",
        "XSチケット700番台",
        "女性名義",
        "Sチケ / Aチケ",
        "特典会 Sチケ700番台",
        "2部 Sチケ700番台",
        "1/1 Sチケ700番台",
      ])
        assert.equal(await match(raw), null, raw);
      assert.equal(normalizeAdmission("S1100番以内").lower, null);
      assert.equal(normalizeAdmission("S〜650").upper, null);
    } finally {
      await pool.end();
    }
  },
);
