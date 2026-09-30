export function priceSummary(prices: number[], quantities: number[]) {
  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n
    ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2
    : null;
  return {
    listingCount: n,
    ticketCount: quantities.reduce((a, b) => a + b, 0),
    minPrice: n ? sorted[0]! : null,
    medianPrice: median,
  };
}
export function histogram(prices: number[]) {
  if (!prices.length) return [];
  const max = Math.max(...prices);
  const width = Math.max(1000, Math.ceil(max / 12 / 1000) * 1000);
  const bins = new Map<number, number>();
  for (const price of prices) {
    const lower = Math.floor(price / width) * width;
    bins.set(lower, (bins.get(lower) ?? 0) + 1);
  }
  return [...bins]
    .sort((a, b) => a[0] - b[0])
    .map(([lower, count]) => ({ lower, upper: lower + width, count }));
}
