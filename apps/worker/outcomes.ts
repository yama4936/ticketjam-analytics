import type pg from "pg";
import { load } from "cheerio";
import { createHash } from "node:crypto";
import {
  PublicSourceHttp,
  SourceBlockedError,
} from "../../packages/sources/http.js";
export function purchaseNotice(
  html: string,
  finalUrl: string,
  eventId: string,
): string | null {
  const url = new URL(finalUrl);
  if (
    url.origin !== "https://ticketjam.jp" ||
    !url.pathname.endsWith("/event/" + eventId)
  )
    return null;
  const $ = load(html);
  const notice = $(".flash_wrapper p")
    .toArray()
    .map((e) => $(e).text().trim())
    .find(
      (t) =>
        t === "購入済みチケットのため、同じ公演のチケットを表示しています。",
    );
  return notice ?? null;
}
export async function checkOutcomes(
  pool: pg.Pool,
  http: Pick<PublicSourceHttp, "getTicketOutcome"> = new PublicSourceHttp(
    pool,
    "ticketjam",
  ),
  eventId: string | null = null,
) {
  const lock = await pool.connect();
  try {
    const acquired = (
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtext('ticket-outcomes')) AS ok",
      )
    ).rows[0].ok;
    if (!acquired) return { skipped: true };
    const listings = (
      await pool.query(
        `SELECT l.*,s.external_id AS event_external_id,r.id AS confirmation_run_id
      FROM listings l JOIN source_events s ON s.event_id=l.event_id AND s.source=l.source
      JOIN LATERAL(SELECT id FROM collection_runs WHERE source_event_id=s.id AND status IN('complete','partial') ORDER BY scheduled_at DESC LIMIT 1)r ON true
      WHERE l.state<>'sold_confirmed' AND s.enabled AND ($1::uuid IS NULL OR l.event_id=$1)
      AND (l.state='ended_unknown' OR NOT EXISTS(SELECT 1 FROM listing_observations o WHERE o.listing_id=l.id AND o.run_id=r.id))
      AND NOT EXISTS(SELECT 1 FROM listing_outcome_checks c WHERE c.listing_id=l.id AND c.checked_at>now()-interval '24 hours')
      ORDER BY l.last_observed_at DESC LIMIT 20`,
        [eventId],
      )
    ).rows;
    let purchased = 0;
    for (const listing of listings) {
      let page;
      try {
        page = await http.getTicketOutcome(listing.url);
      } catch (error) {
        await pool.query(
          `INSERT INTO listing_outcome_checks(listing_id,checked_at,source_url,status,error) VALUES($1,now(),$2,'failed',$3)`,
          [
            listing.id,
            listing.url,
            error instanceof Error ? error.message : "Fetch failed",
          ],
        );
        if (error instanceof SourceBlockedError) throw error;
        continue;
      }
      const notice = purchaseNotice(
        page.html,
        page.finalUrl,
        listing.event_external_id,
      );
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const current = (
          await c.query("SELECT * FROM listings WHERE id=$1 FOR UPDATE", [
            listing.id,
          ])
        ).rows[0];
        await c.query(
          `INSERT INTO listing_outcome_checks(listing_id,checked_at,source_url,final_url,status,evidence_text,content_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            listing.id,
            page.observedAt,
            listing.url,
            page.finalUrl,
            notice ? "purchased" : "unconfirmed",
            notice,
            createHash("sha256").update(page.html).digest("hex"),
          ],
        );
        if (
          notice &&
          current.state !== "sold_confirmed" &&
          page.observedAt >= current.last_observed_at
        ) {
          const end = { run_id: listing.confirmation_run_id };
          if (end) {
            await c.query(
              `INSERT INTO listing_changes(listing_id,run_id,kind,interval_start,interval_end,before_value,after_value) VALUES($1,$2,'sold_confirmed',$3,$4,$5,'"sold_confirmed"') ON CONFLICT DO NOTHING`,
              [
                listing.id,
                end.run_id,
                current.last_listed_at,
                page.observedAt,
                JSON.stringify(current.state),
              ],
            );
            await c.query(
              "UPDATE listings SET state='sold_confirmed',last_observed_at=$2 WHERE id=$1",
              [listing.id, page.observedAt],
            );
            purchased++;
          }
        }
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    return { checked: listings.length, purchased };
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('ticket-outcomes'))");
    lock.release();
  }
}
