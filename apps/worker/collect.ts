import type pg from "pg";
import { PARSER_VERSION } from "../../packages/domain/types.js";
import { persistBatch, type FetchedPage } from "../../packages/db/ingest.js";
import { parseEventPage } from "../../packages/sources/ticketjam/parser.js";
import { TicketjamHttp } from "../../packages/sources/ticketjam/http.js";

export async function collectEvent(
  pool: pg.Pool,
  sourceEventId: string,
  scheduledAt: Date,
  http = new TicketjamHttp(pool),
) {
  const lock = await pool.connect();
  let runId: string | undefined;
  let attemptId: string | undefined;
  try {
    const acquired = (
      await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
        `collect:${sourceEventId}`,
      ])
    ).rows[0].locked;
    if (!acquired) return { skipped: "already_running" };
    const source = (
      await lock.query("SELECT * FROM source_events WHERE id=$1 AND enabled", [
        sourceEventId,
      ])
    ).rows[0];
    if (!source) throw new Error("Enabled source event not found");
    const prior = (
      await lock.query(
        "SELECT * FROM collection_runs WHERE source_event_id=$1 AND scheduled_at=$2",
        [sourceEventId, scheduledAt],
      )
    ).rows[0];
    if (prior && ["complete", "partial"].includes(prior.status))
      return { runId: prior.id, duplicate: true };
    runId = (
      await lock.query(
        `INSERT INTO collection_runs(source_event_id,scheduled_at,status,parser_version) VALUES($1,$2,'running',$3)
      ON CONFLICT(source_event_id,scheduled_at) DO UPDATE SET status='running',error=NULL RETURNING id`,
        [sourceEventId, scheduledAt, PARSER_VERSION],
      )
    ).rows[0].id;
    attemptId = (
      await lock.query(
        "INSERT INTO collection_attempts(run_id) VALUES($1) RETURNING id",
        [runId],
      )
    ).rows[0].id;
    const pages: FetchedPage[] = [];
    let next: string | null = source.url;
    while (next && pages.length < 20) {
      const result = await http.get(next);
      const page = parseEventPage(result.html, next);
      pages.push({ page, observedAt: result.observedAt });
      next = page.nextUrl;
    }
    const result = await persistBatch(pool, sourceEventId, scheduledAt, pages);
    await lock.query(
      "UPDATE collection_attempts SET completed_at=now(),outcome='stored' WHERE id=$1",
      [attemptId],
    );
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown collection error";
    if (runId)
      await lock.query(
        "UPDATE collection_runs SET status='failed',completed_at=now(),error=$2 WHERE id=$1 AND status='running'",
        [runId, message],
      );
    if (attemptId)
      await lock.query(
        "UPDATE collection_attempts SET completed_at=now(),outcome='failed',error=$2 WHERE id=$1",
        [attemptId, message],
      );
    throw error;
  } finally {
    try {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
        `collect:${sourceEventId}`,
      ]);
    } finally {
      lock.release();
    }
  }
}
