import {
  parseTvasahiGift,
  TVASAHI_PARSER_VERSION,
} from "../../packages/sources/official/tvasahi.js";
import type pg from "pg";
import {
  PublicSourceHttp,
  SourceBlockedError,
} from "../../packages/sources/http.js";
import {
  parseTicketdive,
  discoverOfficialUrls,
} from "../../packages/sources/official/ticketdive.js";
import { storeOfficial } from "../../packages/db/official.js";
export async function refreshOfficial(pool: pg.Pool) {
  const http = new PublicSourceHttp(pool, "ticketdive"),
    tvasahi = new PublicSourceHttp(pool, "tvasahi");
  const groups = (
    await pool.query(
      "SELECT official_artist_slug FROM groups WHERE enabled AND official_artist_slug IS NOT NULL",
    )
  ).rows;
  for (const g of groups) {
    if (!/^[a-zA-Z0-9_-]+$/.test(g.official_artist_slug)) continue;
    const response = await http.get(
      `https://ticketdive.com/artist/${g.official_artist_slug}`,
    );
    for (const url of discoverOfficialUrls(response.html))
      await pool.query(
        "INSERT INTO official_sources(url) VALUES($1) ON CONFLICT DO NOTHING",
        [url],
      );
  }
  const sources = (
    await pool.query(
      "SELECT url FROM official_sources WHERE enabled AND (checked_at IS NULL OR checked_at<now()-interval '12 hours') ORDER BY checked_at NULLS FIRST,discovered_at LIMIT 30",
    )
  ).rows;
  for (const source of sources) {
    try {
      if (source.url === "https://ticket.tv-asahi.co.jp/ex/project/gift") {
        const r = await tvasahi.get(source.url);
        await storeOfficial(
          pool,
          source.url,
          r.observedAt,
          parseTvasahiGift(r.html),
          TVASAHI_PARSER_VERSION,
        );
      } else {
        const r = await http.get(source.url);
        await storeOfficial(
          pool,
          source.url,
          r.observedAt,
          parseTicketdive(r.html),
        );
      }
    } catch (error) {
      await pool.query(
        "UPDATE official_sources SET checked_at=now(),last_error=$2 WHERE url=$1",
        [source.url, error instanceof Error ? error.message : "Unknown error"],
      );
      if (error instanceof SourceBlockedError) throw error;
    }
  }
  return { checked: sources.length };
}
