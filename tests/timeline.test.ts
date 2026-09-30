import { test } from "node:test";
import assert from "node:assert/strict";
import { withMissingSlots } from "../packages/analytics/timeline.js";
import type { TimelinePoint } from "../packages/contracts/index.js";
test("missing schedules are gaps, never inventory zero; current collection has ten minutes grace", () => {
  const point: TimelinePoint = {
    runId: "1",
    time: "2026-09-30T01:03:00Z",
    scheduledAt: "2026-09-30T01:00:00Z",
    status: "complete",
    warnings: [],
    error: null,
    listingCount: 5,
    ticketCount: 6,
    minPrice: 1000,
    medianPrice: 1500,
    newCount: 5,
  };
  const result = withMissingSlots(
    [point],
    new Date("2026-10-01T00:00:00Z"),
    new Date("2026-09-30T03:05:00Z"),
  );
  assert.equal(result.length, 2);
  assert.equal(result[1]!.status, "missing");
  assert.equal(result[1]!.listingCount, null);
  assert.deepEqual(withMissingSlots([], new Date(), new Date()), []);
});
