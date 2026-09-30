import type pg from "pg";
import {
  discoverEvents,
  eventId,
  parseEventPage,
} from "../../packages/sources/ticketjam/parser.js";
import {
  TicketjamHttp,
  SourceBlockedError,
} from "../../packages/sources/ticketjam/http.js";
import { registerEvent, persistBatch } from "../../packages/db/ingest.js";

export async function discoverGroup(
  pool: pg.Pool,
  groupId: string,
  maxActiveEvents = 5,
) {
  if (
    !Number.isInteger(maxActiveEvents) ||
    maxActiveEvents < 1 ||
    maxActiveEvents > 100
  )
    throw new Error("MAX_ACTIVE_EVENTS must be 1-100");
  const group = (
    await pool.query("SELECT * FROM groups WHERE id=$1 AND enabled", [groupId])
  ).rows[0];
  if (!group || !/^[a-z0-9-]+$/.test(group.ticketjam_slug))
    throw new Error("Group requires valid source slug");
  const runId = (
    await pool.query(
      "INSERT INTO discovery_runs(group_id) VALUES($1) RETURNING id",
      [groupId],
    )
  ).rows[0].id;
  const client = await pool.connect();
  try {
    // Serializes discovery imports globally, including the active-event budget.
    await client.query("SELECT pg_advisory_lock(hashtext('discovery-import'))");
    const http = new TicketjamHttp(pool);
    const category = await http.get(
      `https://ticketjam.jp/tickets/${group.ticketjam_slug}`,
    );
    const urls = discoverEvents(category.html);
    for (const url of urls)
      await client.query(
        `INSERT INTO discovery_candidates(source,external_id,group_id,url) VALUES('ticketjam',$1,$2,$3)
      ON CONFLICT(source,external_id,group_id) DO UPDATE SET last_discovered_at=now(),url=excluded.url`,
        [eventId(url), groupId, url],
      );
    const candidates = (
      await client.query(
        "SELECT * FROM discovery_candidates WHERE group_id=$1 AND NOT imported AND (retry_after IS NULL OR retry_after<=now()) ORDER BY first_discovered_at",
        [groupId],
      )
    ).rows;
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const known = (
          await client.query(
            "SELECT * FROM source_events WHERE source=$1 AND external_id=$2",
            [candidate.source, candidate.external_id],
          )
        ).rows[0];
        if (known) {
          await client.query(
            "INSERT INTO event_groups(event_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [known.event_id, groupId],
          );
        } else {
          const count = Number(
            (
              await client.query(
                "SELECT count(*) FROM source_events s JOIN events e ON e.id=s.event_id WHERE s.enabled AND e.starts_at>now()",
              )
            ).rows[0].count,
          );
          if (count >= maxActiveEvents) break;
          const response = await http.get(candidate.url);
          const page = parseEventPage(response.html, candidate.url);
          const sourceId = await registerEvent(pool, page.event, groupId);
          if (new Date(page.event.startsAt) <= new Date()) {
            await client.query(
              "UPDATE source_events SET enabled=false WHERE id=$1",
              [sourceId],
            );
          } else if (!page.nextUrl) {
            const slot = new Date(
              Math.floor(response.observedAt.getTime() / 3600000) * 3600000,
            );
            await persistBatch(pool, sourceId, slot, [
              { page, observedAt: response.observedAt },
            ]);
          }
        }
        await client.query(
          "UPDATE discovery_candidates SET imported=true WHERE source=$1 AND external_id=$2 AND group_id=$3",
          [candidate.source, candidate.external_id, groupId],
        );
      } catch (error) {
        if (error instanceof SourceBlockedError) throw error;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(`${candidate.external_id}: ${message}`);
        await client.query(
          "UPDATE discovery_candidates SET last_error=$4,retry_after=now()+interval '1 hour' WHERE source=$1 AND external_id=$2 AND group_id=$3",
          [candidate.source, candidate.external_id, groupId, message],
        );
      }
    }
    await client.query(
      "UPDATE discovery_runs SET completed_at=now(),status=$3,discovered_count=$2,error=$4 WHERE id=$1",
      [
        runId,
        urls.length,
        errors.length ? "partial" : "complete",
        errors.length ? errors.join("; ") : null,
      ],
    );
    return { discovered: urls.length, errors };
  } catch (error) {
    await client.query(
      "UPDATE discovery_runs SET completed_at=now(),status='failed',error=$2 WHERE id=$1",
      [runId, error instanceof Error ? error.message : "Unknown error"],
    );
    throw error;
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('discovery-import'))",
      );
    } finally {
      client.release();
    }
  }
}
