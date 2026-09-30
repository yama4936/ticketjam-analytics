import { load } from "cheerio";
import { z } from "zod";
import type { EventPage, SourceListing } from "../../domain/types.js";
import { classifyTicketType } from "../../normalization/admission.js";

const ORIGIN = "https://ticketjam.jp";
export class SourceShapeError extends Error {}

export function ticketjamUrl(input: string): URL {
  const url = new URL(input, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash)
    throw new SourceShapeError("Unexpected source URL");
  return url;
}

export function eventId(input: string): string {
  const url = ticketjamUrl(input);
  const match = url.pathname.match(/^\/tickets\/[a-z0-9-]+\/event\/(\d+)$/);
  if (!match) throw new SourceShapeError("Expected an event page");
  if (
    [...url.searchParams.keys()].some((k) => k !== "page") ||
    (url.searchParams.has("page") &&
      !/^[1-9]\d*$/.test(url.searchParams.get("page")!))
  ) {
    throw new SourceShapeError(
      "Filtered/request pages are not collection targets",
    );
  }
  return match[1]!;
}

export function discoverEvents(html: string): string[] {
  const $ = load(html);
  if (!$("h1").text().includes("リセールチケット一覧"))
    throw new SourceShapeError("Missing category identity");
  const found = new Map<string, string>();
  $("a[href]").each((_, node) => {
    const href = $(node).attr("href")!;
    try {
      const url = ticketjamUrl(href);
      if (
        !url.search &&
        /^\/tickets\/[a-z0-9-]+\/event\/\d+$/.test(url.pathname)
      )
        found.set(eventId(url.href), url.href);
    } catch {
      /* Unrelated links are not collection targets. */
    }
  });
  return [...found.values()];
}

const eventSchema = z.object({
  "@type": z.literal("Event"),
  name: z.string().min(1),
  startDate: z.string().datetime({ offset: true }),
  location: z.object({ name: z.string().min(1) }),
  offers: z.object({ url: z.string() }),
});

export function parseEventPage(html: string, sourceUrl: string): EventPage {
  const id = eventId(sourceUrl);
  const $ = load(html);
  const records = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((node) => {
      try {
        const value = JSON.parse($(node).text()) as unknown;
        return Array.isArray(value) ? value : [value];
      } catch {
        return [];
      }
    });
  const event = records
    .map((value) => eventSchema.safeParse(value))
    .find((result) => {
      if (!result.success) return false;
      try {
        return eventId(result.data.offers.url) === id;
      } catch {
        return false;
      }
    })?.data;
  if (!event || eventId(event.offers.url) !== id)
    throw new SourceShapeError("Missing or mismatched Event metadata");
  const counts = $("a.active")
    .toArray()
    .map((node) =>
      $(node)
        .text()
        .trim()
        .match(/^出品中[（(]([\d,]+)[）)]$/),
    )
    .filter(Boolean);
  const expectedCount = counts[0]
    ? Number(counts[0][1]!.replaceAll(",", ""))
    : NaN;
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0)
    throw new SourceShapeError("Missing listing total");
  const warnings: string[] = [];
  const listings: SourceListing[] = [];
  const seen = new Set<string>();
  $(".eventlist__item").each((i, node) => {
    const row = $(node);
    const href = row.find("a.eventlist__wrap").attr("href");
    const price = row.find(".eventlist__price li").first();
    const amount = price.find("span.font-weight-bold").first().text().trim();
    const quantityMatch = price
      .find("span.ml-1.bold")
      .text()
      .trim()
      .match(/^(\d+)\s*枚/);
    const match = href?.match(/^\/ticket\/[a-z_]+\/(\d+)$/);
    const admissionRaw = row
      .find(".description > span.font-weight-bold")
      .first()
      .text()
      .trim();
    const title = row.find(".eventlist__title .align-middle").text().trim();
    const venue = row.find(".venue").text().replace(/\s+/g, " ").trim();
    const datetime = venue.match(
      /(\d{4})\/(\d{2})\/(\d{2})\([^)]*\)\s*(\d{2}):(\d{2})/,
    );
    const startsAt = datetime
      ? Date.parse(
          `${datetime[1]}-${datetime[2]}-${datetime[3]}T${datetime[4]}:${datetime[5]}:00+09:00`,
        )
      : NaN;
    if (
      !match ||
      !/^[\d,]+$/.test(amount) ||
      !quantityMatch ||
      !price.find("small").first().text().includes("円/枚") ||
      title !== event.name ||
      startsAt !== Date.parse(event.startDate) ||
      !venue.includes(event.location.name) ||
      !row.hasClass("active")
    ) {
      warnings.push(`Unrecognized listing row ${i + 1}`);
      return;
    }
    const priceYen = Number(amount.replaceAll(",", ""));
    const quantity = Number(quantityMatch[1]);
    if (
      !Number.isSafeInteger(priceYen) ||
      priceYen < 0 ||
      quantity < 1 ||
      !Number.isSafeInteger(quantity)
    ) {
      warnings.push(`Invalid price/quantity at row ${i + 1}`);
      return;
    }
    if (seen.has(match[1]!)) {
      warnings.push(`Duplicate listing ${match[1]}`);
      return;
    }
    seen.add(match[1]!);
    listings.push({
      externalId: match[1]!,
      url: ticketjamUrl(href!).href,
      priceYen,
      quantity,
      admissionRaw,
      ticketType: classifyTicketType(admissionRaw),
      state: "listed",
      confirmedSalePriceYen: null,
    });
  });
  const nextLinks = [
    ...new Set(
      $('a[rel="next"]')
        .toArray()
        .map((node) => ticketjamUrl($(node).attr("href")!).href),
    ),
  ];
  if (nextLinks.length > 1) throw new SourceShapeError("Ambiguous pagination");
  const nextUrl = nextLinks[0] ?? null;
  if (
    nextUrl &&
    (eventId(nextUrl) !== id ||
      Number(new URL(nextUrl).searchParams.get("page")) <=
        Number(new URL(sourceUrl).searchParams.get("page") ?? "1"))
  ) {
    throw new SourceShapeError("Pagination changes event or does not advance");
  }
  if (expectedCount > 0 && !listings.length)
    warnings.push("Nonzero total without valid listings");
  return {
    event: {
      externalId: id,
      url: event.offers.url,
      title: event.name,
      startsAt: event.startDate,
      venue: event.location.name,
    },
    listings,
    expectedCount,
    nextUrl,
    warnings,
  };
}

export function assessCoverage(pages: EventPage[]): {
  complete: boolean;
  warnings: string[];
  listings: SourceListing[];
} {
  const warnings = pages.flatMap((p) => p.warnings);
  if (!pages.length)
    return { complete: false, warnings: ["No pages"], listings: [] };
  const first = pages[0]!;
  const all = pages.flatMap((p) => p.listings);
  const unique = new Map(all.map((item) => [item.externalId, item]));
  if (unique.size !== all.length)
    warnings.push("Listings moved or duplicated across pages");
  if (
    pages.some(
      (p) =>
        p.event.externalId !== first.event.externalId ||
        p.expectedCount !== first.expectedCount,
    )
  )
    warnings.push("Event or total changed during pagination");
  if (pages.at(-1)!.nextUrl) warnings.push("Pagination incomplete");
  if (unique.size !== first.expectedCount)
    warnings.push(
      `Count mismatch: expected ${first.expectedCount}, observed ${unique.size}`,
    );
  return {
    complete: warnings.length === 0,
    warnings,
    listings: [...unique.values()],
  };
}
