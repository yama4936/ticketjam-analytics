import type { TimelinePoint } from "../contracts/index.js";
export function withMissingSlots(
  points: TimelinePoint[],
  eventAt: Date,
  now = new Date(),
): TimelinePoint[] {
  if (!points.length) return [];
  const bySlot = new Map(points.map((p) => [Date.parse(p.scheduledAt), p]));
  const first = Math.min(...bySlot.keys());
  const last = Math.max(...bySlot.keys());
  const expectedThrough =
    Math.floor(Math.min(now.getTime() - 600000, eventAt.getTime()) / 3600000) *
    3600000;
  const result: TimelinePoint[] = [];
  for (let t = first; t <= Math.max(last, expectedThrough); t += 3600000) {
    result.push(
      bySlot.get(t) ?? {
        runId: `missing-${t}`,
        time: new Date(t).toISOString(),
        scheduledAt: new Date(t).toISOString(),
        status: "missing",
        warnings: ["Scheduled observation missing"],
        error: null,
        listingCount: null,
        ticketCount: null,
        minPrice: null,
        medianPrice: null,
        newCount: null,
      },
    );
  }
  return result;
}
