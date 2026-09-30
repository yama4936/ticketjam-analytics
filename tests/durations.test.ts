import { test } from "node:test";
import assert from "node:assert/strict";
import { durationPoints } from "../packages/analytics/durations.js";
test("duration intervals preserve uncertainty and omit no-known-listed bound", () => {
  const base = {
    id: "a",
    kind: "sold_confirmed",
    first_observed_at: "2026-09-01T00:00:00Z",
    interval_start: "2026-09-01T01:00:00Z",
    interval_end: "2026-09-01T03:00:00Z",
    asking_price_yen: 2000,
    confirmed_sale_price_yen: null,
    admission_lower: 10,
    admission_prefix: "A",
    before_value: null,
    after_value: null,
  };
  const rows = durationPoints(
    [
      base,
      { ...base, id: "b", interval_start: null },
      { ...base, id: "c", kind: "ended_unknown" },
    ],
    "sold_confirmed",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hours, 2);
  assert.deepEqual(rows[0]!.uncertainty, [1, 1]);
  assert.equal(rows[0]!.confirmed_sale_price_yen, null);
});
