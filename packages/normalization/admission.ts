import { NORMALIZATION_VERSION, type Admission } from "../domain/types.js";

export function normalizeAdmission(raw: string): Admission {
  const value = raw
    .normalize("NFKC")
    .replace(/[~〜～–−ー]/g, "-")
    .trim();
  const base: Admission = {
    raw,
    kind: "unknown",
    prefix: null,
    lower: null,
    upper: null,
    version: NORMALIZATION_VERSION,
  };
  if (/未定|未発券|未確定|発券前|番号不明|整理番号なし/.test(value))
    return { ...base, kind: "unassigned" };
  if (/指定席|[0-9]+\s*列|[0-9]+\s*階|アリーナ.*ブロック/.test(value))
    return { ...base, kind: "reserved_seat" };
  // A2連番 is a quantity/condition, not evidence that admission number is A2.
  const range = value.match(
    /(?:^|[^A-Za-z0-9])([A-Za-z]{0,3})\s*(\d{1,6})\s*-\s*([A-Za-z]{0,3})\s*(\d{1,6})(?:番)?(?!\d)/,
  );
  if (range) {
    const prefix = range[1]!.toUpperCase() || null;
    const endPrefix = range[3]!.toUpperCase() || null;
    const lower = Number(range[2]);
    const upper = Number(range[4]);
    if ((endPrefix && endPrefix !== prefix) || lower > upper || lower < 1)
      return base;
    return { ...base, kind: "range", prefix, lower, upper };
  }
  const band = value.match(/(?:^|[^A-Za-z0-9])([A-Za-z]{0,3})\s*(\d{1,6})番[台代]/);
  if (band) {
    const lower = Number(band[2]);
    const zeroCount = band[2]!.match(/0+$/)?.[0].length ?? 0;
    if (zeroCount === 0 || lower === 0) return base;
    return {
      ...base,
      kind: "range",
      prefix: band[1]!.toUpperCase() || null,
      lower,
      upper: lower + 10 ** zeroCount - 1,
    };
  }
  const exact =
    value.match(
      /(?:^|[^A-Za-z0-9])([A-Za-z]{1,3})\s*(\d{1,6})(?:番)?(?=$|[\s、。/])/,
    ) ?? value.match(/(?:整理番号\s*|^)(\d{1,6})番(?!台)/);
  if (!exact) return base;
  const prefixed = exact[2] !== undefined;
  const n = Number(prefixed ? exact[2] : exact[1]);
  if (n < 1 || /\d+番以内|\d+番以下|\d+番以降/.test(value)) return base;
  return {
    ...base,
    kind: "number",
    prefix: prefixed ? exact[1]!.toUpperCase() : null,
    lower: n,
    upper: n,
  };
}

export function classifyTicketType(raw: string): string | null {
  // Admission prefixes are not automatically ticket types.
  const value = raw.normalize("NFKC");
  if (/1DAY\s*共通チケット/i.test(value)) return "1DAY共通チケット";
  return (
    value.match(
      /(?:VIP|SS|S|A|B|C)(?:チケット|券)|優先(?:入場)?(?:チケット|券)?|前方(?:チケット|券)?|一般(?:チケット|券)?/i,
    )?.[0] ?? null
  );
}
