import { load } from "cheerio";
import type { OfficialStage, OfficialTicket } from "./ticketdive.js";
export const TVASAHI_PARSER_VERSION = "tvasahi-gift-1";
export function parseTvasahiGift(html: string): OfficialStage[] {
  const $ = load(html);
  const title = $("h2:not([class])").first().text().trim();
  if (!/^GIFT\s*[～〜]Girls Idol Festival Tokyo[～〜]$/.test(title))
    throw new Error("GIFT official title changed");
  const schedule = $("table.about .place").clone();
  schedule.find("style,script,a").remove();
  const venue = $("table.about .place a").text().trim();
  const times = [
    ...schedule
      .text()
      .matchAll(
        /【DAY-(\d)】\s*(\d{4})年(\d{1,2})月(\d{1,2})日[^／]*／開演(\d{1,2}):(\d{2})/g,
      ),
  ];
  if (times.length !== 3 || !venue)
    throw new Error("GIFT official schedule incomplete");
  return times.map((m) => {
    const day = m[1]!,
      date = `${m[2]}-${m[3]!.padStart(2, "0")}-${m[4]!.padStart(2, "0")}T${m[5]!.padStart(2, "0")}:${m[6]}:00+09:00`;
    const prices: { name: string; price: number }[] = [];
    $("table.ticket-type tbody tr").each((_, row) => {
      const name = $(row).find(".type").text().trim();
      if (!name.startsWith(`【DAY-${day}】`)) return;
      const price = $(row)
        .find(".price")
        .text()
        .trim()
        .match(/^[￥¥]([\d,]+)$/);
      if (!price) throw new Error("Official price missing");
      prices.push({
        name: name.replace(/^【DAY-\d】\s*/, ""),
        price: Number(price[1]!.replaceAll(",", "")),
      });
    });
    const tickets: OfficialTicket[] = [];
    $("table.ticket-list tbody tr").each((_, row) => {
      const heading = $(row).find("p.type,p.type-arrival").clone();
      heading.find(".tag").remove();
      const windowName = heading.text().trim();
      if (
        !windowName ||
        (/DAY-\d/.test(windowName) && !windowName.includes(`DAY-${day}`))
      )
        return;
      const start = $(row)
        .find("p.status span")
        .text()
        .match(/(\d{4})年(\d{1,2})月(\d{1,2})日[^\d]*(\d{1,2}):(\d{2})[〜～]/);
      const startsAt = start
        ? `${start[1]}-${start[2]!.padStart(2, "0")}-${start[3]!.padStart(2, "0")}T${start[4]!.padStart(2, "0")}:${start[5]}:00+09:00`
        : null;
      for (const price of prices)
        tickets.push({
          ...price,
          prefix: null,
          fee: null,
          windowName,
          windowId: `day-${day}:${windowName}`,
          startsAt,
          endsAt: null,
        });
    });
    if (!prices.length || !tickets.length)
      throw new Error("Official ticket types or windows missing");
    return {
      eventName: title,
      stageName: `DAY-${day}`,
      stageId: `gift-day-${day}`,
      startsAt: new Date(date).toISOString(),
      venue,
      tickets,
      drinkYen: null,
    };
  });
}
