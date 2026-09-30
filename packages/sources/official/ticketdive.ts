import { load } from "cheerio";
import { z } from "zod";
export const OFFICIAL_PARSER_VERSION = "ticketdive-1";
const time = z.string().datetime({ offset: true });
const schema = z.object({
  event: z.object({ name: z.string().min(1) }),
  stages: z.array(
    z.object({
      id: z.string(),
      stageName: z.string(),
      startStage: time,
      venue: z.object({ name: z.string() }),
    }),
  ),
  ticketInfoList: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      startApply: time.nullish(),
      endApply: time.nullish(),
      ticketTypes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          stageIds: z.array(z.string()),
          price: z.number().int().nonnegative(),
          fee: z.number().int().nonnegative().nullish(),
          prefix: z.string().nullish(),
        }),
      ),
    }),
  ),
});
export interface OfficialTicket {
  name: string;
  prefix: string | null;
  price: number;
  fee: number | null;
  windowId: string;
  windowName: string;
  startsAt: string | null;
  endsAt: string | null;
}
export interface OfficialStage {
  eventName: string;
  stageName: string;
  stageId: string;
  startsAt: string;
  venue: string;
  tickets: OfficialTicket[];
  drinkYen: number | null;
}
export function parseTicketdive(html: string): OfficialStage[] {
  const $ = load(html);
  const next = JSON.parse($("#__NEXT_DATA__").text());
  // Select public event fields only, excluding account, internal IDs and unrelated site state.
  const raw =
    next.props?.pageProps?.__superjsonProps?.json?.eventDetail ??
    next.props?.pageProps?.eventDetail;
  const data = schema.parse(raw);
  return data.stages.map((stage) => ({
    eventName: data.event.name,
    stageName: stage.stageName,
    stageId: stage.id,
    startsAt: stage.startStage,
    venue: stage.venue.name,
    drinkYen: null,
    tickets: data.ticketInfoList.flatMap((window) =>
      window.ticketTypes
        .filter((type) => type.stageIds.includes(stage.id))
        .map((type) => ({
          name: type.name,
          prefix: type.prefix?.toUpperCase() ?? null,
          price: type.price,
          fee: type.fee ?? null,
          windowId: window.id,
          windowName: window.name,
          startsAt: window.startApply ?? null,
          endsAt: window.endApply ?? null,
        })),
    ),
  }));
}
export function discoverOfficialUrls(html: string): string[] {
  const $ = load(html);
  const urls = new Set<string>();
  $("a[href]").each((_, a) => {
    const u = new URL($(a).attr("href")!, "https://ticketdive.com");
    if (
      u.origin === "https://ticketdive.com" &&
      /^\/event\/[a-zA-Z0-9_-]+$/.test(u.pathname)
    )
      urls.add(u.origin + u.pathname);
  });
  return [...urls];
}
export function nameKey(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}
