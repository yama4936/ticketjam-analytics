import type { Outcome } from "../contracts/index.js";
export function sellingPoints(rows: Outcome[], releasedAt: string | null) {
  const release = releasedAt ? Date.parse(releasedAt) : NaN;
  return rows.map((row) => {
    const lower = row.interval_start
      ? (Date.parse(row.interval_start) - release) / 3600000
      : null;
    const upper = row.interval_end
      ? (Date.parse(row.interval_end) - release) / 3600000
      : null;
    const hasInterval =
      lower !== null &&
      upper !== null &&
      Number.isFinite(lower) &&
      Number.isFinite(upper) &&
      lower >= 0 &&
      upper >= lower;
    return {
      ...row,
      number: row.admission_lower,
      price:
        row.state === "sold_confirmed" && row.confirmed_sale_price_yen !== null
          ? row.confirmed_sale_price_yen
          : row.asking_price_yen,
      priceKind:
        row.state === "sold_confirmed" && row.confirmed_sale_price_yen !== null
          ? "確認成約価格"
          : "最終観測の出品価格",
      hours: hasInterval ? (lower + upper) / 2 : null,
      lowerHours: hasInterval ? lower : null,
      upperHours: hasInterval ? upper : null,
      uncertainty: hasInterval
        ? [(upper - lower) / 2, (upper - lower) / 2]
        : [0, 0],
    };
  });
}
export function conditionBands(
  rows: ReturnType<typeof sellingPoints>,
  by: "price" | "number",
) {
  const bands = new Map<
    number,
    {
      label: string;
      lower: number;
      purchased: number;
      listed: number;
      unknown: number;
    }
  >();
  const maxValue = Math.max(
    0,
    ...rows.map((row) =>
      by === "price"
        ? row.asking_price_yen
        : (row.admission_upper ?? row.number ?? 0),
    ),
  );
  const width =
    by === "price"
      ? maxValue <= 10000
        ? 1000
        : 5000
      : maxValue <= 100
        ? 10
        : 100;
  for (const row of rows) {
    const value = by === "price" ? row.asking_price_yen : row.number;
    if (value === null) continue;
    // Exclude number ranges crossing a band rather than assign them to a misleading bucket.
    const lower = Math.floor(value / width) * width;
    if (by === "number" && (row.admission_upper ?? value) >= lower + width)
      continue;
    const band = bands.get(lower) ?? {
      label:
        by === "price"
          ? `¥${lower.toLocaleString()}–${(lower + width - 1).toLocaleString()}`
          : `${Math.max(1, lower)}–${lower + width - 1}番`,
      lower,
      purchased: 0,
      listed: 0,
      unknown: 0,
    };
    if (row.state === "sold_confirmed") band.purchased++;
    else if (row.state === "listed") band.listed++;
    else band.unknown++;
    bands.set(lower, band);
  }
  return [...bands.values()].sort((a, b) => a.lower - b.lower);
}
