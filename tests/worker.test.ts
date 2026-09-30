import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { registerEvent, persistBatch } from "../packages/db/ingest.js";
import { collectEvent } from "../apps/worker/collect.js";
test(
  "worker: failed pagination preserves inventory; retry is atomic; duplicates and concurrent jobs do not fetch twice",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      await migrate(pool);
      const id = String(randomInt(2_000_000_000, 3_000_000_000)),
        url = `https://ticketjam.jp/tickets/test/event/${id}`;
      const event = {
          externalId: id,
          url,
          title: "Worker fixture",
          startsAt: "2026-12-01T18:00:00+09:00",
          venue: "Test Hall",
        },
        sourceId = await registerEvent(pool, event),
        now = Date.now(),
        slot = new Date(Math.floor(now / 3600000) * 3600000);
      const oldId = String(Number(id) + 3);
      await persistBatch(pool, sourceId, new Date(slot.getTime() - 3600000), [
        {
          observedAt: new Date(now - 3600000),
          page: {
            event,
            listings: [
              {
                externalId: oldId,
                url: `https://ticketjam.jp/ticket/live_domestic/${oldId}`,
                admissionRaw: "A12",
                ticketType: null,
                priceYen: 3000,
                quantity: 1,
                state: "listed",
                confirmedSalePriceYen: null,
              },
            ],
            expectedCount: 1,
            nextUrl: null,
            warnings: [],
          },
        },
      ]);
      const html = (rowId: string, next: boolean, count = 2) =>
        `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: event.title, startDate: event.startsAt, location: { name: event.venue }, offers: { url } })}</script><a class="active">出品中（${count}）</a><li class="eventlist__item active"><a class="eventlist__wrap" href="/ticket/live_domestic/${rowId}"><div class="eventlist__title"><span class="align-middle">${event.title}</span></div><div class="venue">2026/12/01(火) 18:00 Test Hall</div><p class="description"><span class="font-weight-bold">A12</span></p><div class="eventlist__price"><ul><li><span class="font-weight-bold">3,000</span><small>円/枚</small><span class="ml-1 bold">1 枚</span></li></ul></div></a></li>${next ? `<a rel="next" href="${url}?page=2">次へ</a>` : ""}`;
      const row1 = String(Number(id) + 1),
        row2 = String(Number(id) + 2);
      let calls = 0;
      await assert.rejects(
        collectEvent(pool, sourceId, slot, {
          get: async () => {
            calls++;
            if (calls === 2) throw new Error("page two unavailable");
            return { html: html(row1, true), observedAt: new Date(now) };
          },
        }),
        /page two unavailable/,
      );
      assert.equal(
        (
          await pool.query("SELECT state FROM listings WHERE external_id=$1", [
            oldId,
          ])
        ).rows[0].state,
        "listed",
      );
      const run = (
        await pool.query(
          "SELECT * FROM collection_runs WHERE source_event_id=$1 AND scheduled_at=$2",
          [sourceId, slot],
        )
      ).rows[0];
      assert.equal(run.status, "failed");
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM listing_observations WHERE run_id=$1",
            [run.id],
          )
        ).rowCount,
        0,
      );
      const client = {
        get: async (target: string) => {
          calls++;
          return {
            html: html(
              target.includes("page=2") ? row2 : row1,
              !target.includes("page=2"),
            ),
            observedAt: new Date(now + 1000),
          };
        },
      };
      await collectEvent(pool, sourceId, slot, client);
      assert.equal(
        (
          await pool.query("SELECT status FROM collection_runs WHERE id=$1", [
            run.id,
          ])
        ).rows[0].status,
        "complete",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM collection_attempts WHERE run_id=$1",
            [run.id],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM listing_observations WHERE run_id=$1",
            [run.id],
          )
        ).rowCount,
        2,
      );
      const before = calls;
      assert.equal(
        (await collectEvent(pool, sourceId, slot, client)).duplicate,
        true,
      );
      assert.equal(calls, before);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        started = new Promise<void>((r) => (entered = r)),
        nextSlot = new Date(slot.getTime() + 3600000);
      const pending = collectEvent(pool, sourceId, nextSlot, {
        get: async () => {
          entered();
          await gate;
          return {
            html: html(row1, false, 1),
            observedAt: new Date(now + 3600000),
          };
        },
      });
      await started;
      try {
        assert.equal(
          (await collectEvent(pool, sourceId, nextSlot, client)).skipped,
          "already_running",
        );
      } finally {
        release();
        await pending;
      }
    } finally {
      await pool.end();
    }
  },
);
