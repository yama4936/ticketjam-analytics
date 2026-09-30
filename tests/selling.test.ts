import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sellingPoints,
  conditionBands,
} from "../packages/analytics/selling.js";
import { purchaseNotice } from "../apps/worker/outcomes.js";
import type { Outcome } from "../packages/contracts/index.js";
const row: Outcome = {
  id: "a",
  url: "https://ticketjam.jp/ticket/live_domestic/1",
  state: "sold_confirmed",
  first_observed_at: "2026-09-01T01:00:00Z",
  last_observed_at: "2026-09-01T04:00:00Z",
  last_listed_at: "2026-09-01T02:00:00Z",
  interval_start: "2026-09-01T02:00:00Z",
  interval_end: "2026-09-01T04:00:00Z",
  asking_price_yen: 7000,
  confirmed_sale_price_yen: null,
  admission_raw: "S90-110",
  admission_lower: 90,
  admission_upper: 110,
  admission_prefix: "S",
};
test("sales analysis preserves price provenance, release baseline and time bounds", () => {
  const [p] = sellingPoints([row], "2026-09-01T00:00:00Z");
  assert.equal(p!.hours, 3);
  assert.deepEqual(p!.uncertainty, [1, 1]);
  assert.equal(p!.price, 7000);
  assert.equal(p!.priceKind, "最終観測の出品価格");
  assert.equal(
    sellingPoints([{ ...row, confirmed_sale_price_yen: 6500 }], null)[0]!.price,
    6500,
  );
  assert.equal(sellingPoints([row], null)[0]!.hours, null);
  assert.equal(sellingPoints([row], "2026-09-01T03:00:00Z")[0]!.hours, null);
  assert.equal(
    sellingPoints(
      [{ ...row, interval_start: null }],
      "2026-09-01T00:00:00Z",
    )[0]!.hours,
    null,
  );
  assert.equal(conditionBands([p!], "number").length, 0);
  const bands = conditionBands(
    sellingPoints(
      [
        row,
        { ...row, id: "b", state: "listed" },
        { ...row, id: "c", state: "ended_unknown" },
      ],
      null,
    ),
    "price",
  );
  assert.equal(bands[0]!.purchased, 1);
  assert.equal(bands[0]!.listed, 1);
  assert.equal(bands[0]!.unknown, 1);
});
test("only exact scoped purchase notice on the expected event is evidence", () => {
  const html =
    '<div class="flash_wrapper"><p>購入済みチケットのため、同じ公演のチケットを表示しています。</p></div>';
  assert.ok(
    purchaseNotice(html, "https://ticketjam.jp/tickets/test/event/123", "123"),
  );
  assert.equal(
    purchaseNotice(html, "https://ticketjam.jp/tickets/test/event/124", "123"),
    null,
  );
  assert.equal(
    purchaseNotice(
      "<p>購入済みチケットのため、同じ公演のチケットを表示しています。</p>",
      "https://ticketjam.jp/tickets/test/event/123",
      "123",
    ),
    null,
  );
  assert.equal(
    purchaseNotice(
      '<div class="flash_wrapper"><p>販売終了</p></div>',
      "https://ticketjam.jp/tickets/test/event/123",
      "123",
    ),
    null,
  );
});
