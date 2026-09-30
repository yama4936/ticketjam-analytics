import type { Change } from "../contracts/index.js";
export function durationPoints(
  changes: Change[],
  kind: "sold_confirmed" | "ended_unknown",
) {
  return changes
    .filter(
      (c) =>
        c.kind === kind &&
        c.interval_start !== null &&
        c.asking_price_yen !== null,
    )
    .map((c) => {
      const first = Date.parse(c.first_observed_at),
        low = Math.max(0, (Date.parse(c.interval_start!) - first) / 3600000),
        high = (Date.parse(c.interval_end) - first) / 3600000;
      return {
        ...c,
        hours: (low + high) / 2,
        uncertainty: [(high - low) / 2, (high - low) / 2],
        lowerHours: low,
        upperHours: high,
      };
    })
    .filter((c) => Number.isFinite(c.hours) && c.upperHours >= c.lowerHours);
}
