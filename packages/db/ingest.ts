import type pg from "pg";
import {
  PARSER_VERSION,
  type EventPage,
  type SourceEvent,
  type SourceListing,
} from "../domain/types.js";
import {
  classifyTicketType,
  normalizeAdmission,
} from "../normalization/admission.js";
import { assessCoverage } from "../sources/ticketjam/parser.js";

export async function registerEvent(
  pool: pg.Pool,
  event: SourceEvent,
  groupId?: string,
): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `ticketjam:event:${event.externalId}`,
    ]);
    const existing = await c.query(
      "SELECT id,event_id FROM source_events WHERE source=$1 AND external_id=$2",
      ["ticketjam", event.externalId],
    );
    let sourceId: string;
    let eventId: string;
    if (existing.rows[0]) {
      sourceId = existing.rows[0].id;
      eventId = existing.rows[0].event_id;
    } else {
      eventId = (
        await c.query(
          "INSERT INTO events(title,starts_at,venue) VALUES($1,$2,$3) RETURNING id",
          [event.title, event.startsAt, event.venue],
        )
      ).rows[0].id;
      sourceId = (
        await c.query(
          "INSERT INTO source_events(event_id,source,external_id,url) VALUES($1,$2,$3,$4) RETURNING id",
          [eventId, "ticketjam", event.externalId, event.url],
        )
      ).rows[0].id;
    }
    if (groupId)
      await c.query(
        "INSERT INTO event_groups(event_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [eventId, groupId],
      );
    await c.query("COMMIT");
    return sourceId;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export interface FetchedPage {
  page: EventPage;
  observedAt: Date;
}

export async function persistBatch(
  pool: pg.Pool,
  sourceEventId: string,
  scheduledAt: Date,
  fetched: FetchedPage[],
) {
  if (
    !fetched.length ||
    fetched.some((f) => !Number.isFinite(f.observedAt.getTime())) ||
    !Number.isFinite(scheduledAt.getTime())
  )
    throw new Error("Valid page observations are required");
  const coverage = assessCoverage(fetched.map((f) => f.page));
  const byId = new Map<string, { item: SourceListing; observedAt: Date }>();
  for (const f of fetched)
    for (const item of f.page.listings)
      byId.set(item.externalId, { item, observedAt: f.observedAt });
  const firstTime = new Date(
    Math.min(...fetched.map((f) => f.observedAt.getTime())),
  );
  const lastTime = new Date(
    Math.max(...fetched.map((f) => f.observedAt.getTime())),
  );
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `ingest:${sourceEventId}`,
    ]);
    const source = (
      await c.query("SELECT * FROM source_events WHERE id=$1", [sourceEventId])
    ).rows[0];
    if (
      !source ||
      fetched.some((f) => f.page.event.externalId !== source.external_id)
    )
      throw new Error("Source event mismatch");
    const existingRun = (
      await c.query(
        "SELECT * FROM collection_runs WHERE source_event_id=$1 AND scheduled_at=$2",
        [sourceEventId, scheduledAt],
      )
    ).rows[0];
    if (existingRun && ["complete", "partial"].includes(existingRun.status)) {
      await c.query("COMMIT");
      return { runId: existingRun.id as string, duplicate: true };
    }
    const newer = await c.query(
      "SELECT 1 FROM collection_runs WHERE source_event_id=$1 AND completed_at >= $2 AND status IN ('complete','partial') LIMIT 1",
      [sourceEventId, firstTime],
    );
    if (newer.rowCount)
      throw new Error("Out-of-order observations cannot replace current state");
    const runId: string =
      existingRun?.id ??
      (
        await c.query(
          `INSERT INTO collection_runs(source_event_id,scheduled_at,started_at,status,parser_version)
      VALUES($1,$2,$3,'running',$4) RETURNING id`,
          [sourceEventId, scheduledAt, firstTime, PARSER_VERSION],
        )
      ).rows[0].id;
    const change = async (
      listingId: string,
      kind: string,
      start: Date | null,
      end: Date,
      before: unknown,
      after: unknown,
    ) => {
      await c.query(
        `INSERT INTO listing_changes(listing_id,run_id,kind,interval_start,interval_end,before_value,after_value)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          listingId,
          runId,
          kind,
          start,
          end,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
    };
    for (const { item, observedAt } of byId.values()) {
      const previous = (
        await c.query(
          "SELECT * FROM listings WHERE source=$1 AND external_id=$2 FOR UPDATE",
          [source.source, item.externalId],
        )
      ).rows[0];
      if (previous && previous.event_id !== source.event_id)
        throw new Error(
          `Listing ${item.externalId} belongs to a different event`,
        );
      let listingId: string;
      if (!previous) {
        listingId = (
          await c.query(
            `INSERT INTO listings(source,external_id,event_id,url,first_observed_at,last_observed_at,last_listed_at,state)
          VALUES($1,$2,$3,$4,$5,$5,$6,$7) RETURNING id`,
            [
              source.source,
              item.externalId,
              source.event_id,
              item.url,
              observedAt,
              item.state === "listed" ? observedAt : null,
              item.state,
            ],
          )
        ).rows[0].id;
        await change(
          listingId,
          "first_seen",
          null,
          observedAt,
          null,
          item.state,
        );
        if (item.state === "sold_confirmed")
          await change(
            listingId,
            "sold_confirmed",
            null,
            observedAt,
            null,
            item.state,
          );
      } else {
        listingId = previous.id;
        const prior = (
          await c.query(
            "SELECT * FROM listing_observations WHERE listing_id=$1 ORDER BY observed_at DESC LIMIT 1",
            [listingId],
          )
        ).rows[0];
        if (prior) {
          if (prior.price_yen !== item.priceYen)
            await change(
              listingId,
              item.priceYen < prior.price_yen ? "price_drop" : "price_rise",
              prior.observed_at,
              observedAt,
              prior.price_yen,
              item.priceYen,
            );
          if (prior.quantity !== item.quantity)
            await change(
              listingId,
              "quantity_changed",
              prior.observed_at,
              observedAt,
              prior.quantity,
              item.quantity,
            );
        }
        if (
          item.state === "sold_confirmed" &&
          previous.state !== "sold_confirmed"
        )
          await change(
            listingId,
            "sold_confirmed",
            previous.last_listed_at,
            observedAt,
            previous.state,
            item.state,
          );
        if (item.state === "listed" && previous.state !== "listed")
          await change(
            listingId,
            "reappeared",
            previous.last_observed_at,
            observedAt,
            previous.state,
            item.state,
          );
        await c.query(
          "UPDATE listings SET last_observed_at=$2,last_listed_at=CASE WHEN $3=$4 THEN $2 ELSE last_listed_at END,state=$3 WHERE id=$1",
          [listingId, observedAt, item.state, "listed"],
        );
      }
      const observationId: string = (
        await c.query(
          `INSERT INTO listing_observations(listing_id,run_id,observed_at,price_yen,quantity,admission_raw,ticket_type_raw,state,confirmed_sale_price_yen,raw_fields,parser_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            listingId,
            runId,
            observedAt,
            item.priceYen,
            item.quantity,
            item.admissionRaw,
            item.ticketType,
            item.state,
            item.confirmedSalePriceYen,
            JSON.stringify(item),
            PARSER_VERSION,
          ],
        )
      ).rows[0].id;
      const normalized = normalizeAdmission(item.admissionRaw);
      await c.query(
        `INSERT INTO observation_normalizations(observation_id,version,admission_kind,admission_prefix,admission_lower,admission_upper,ticket_type)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          observationId,
          normalized.version,
          normalized.kind,
          normalized.prefix,
          normalized.lower,
          normalized.upper,
          classifyTicketType(item.admissionRaw),
        ],
      );
    }
    if (coverage.complete) {
      const absent = await c.query(
        `SELECT id,last_listed_at FROM listings WHERE source=$1 AND event_id=$2 AND state='listed' AND NOT(external_id=ANY($3::text[])) FOR UPDATE`,
        [source.source, source.event_id, [...byId.keys()]],
      );
      for (const row of absent.rows) {
        await change(
          row.id,
          "ended_unknown",
          row.last_listed_at,
          lastTime,
          "listed",
          "ended_unknown",
        );
        await c.query("UPDATE listings SET state='ended_unknown' WHERE id=$1", [
          row.id,
        ]);
      }
    }
    await c.query(
      `UPDATE collection_runs SET status=$2,completed_at=$3,pages_fetched=$4,expected_count=$5,observed_count=$6,warnings=$7,error=NULL WHERE id=$1`,
      [
        runId,
        coverage.complete ? "complete" : "partial",
        lastTime,
        fetched.length,
        fetched[0]!.page.expectedCount,
        byId.size,
        JSON.stringify(coverage.warnings),
      ],
    );
    await c.query(
      `INSERT INTO event_metrics(run_id,event_id,observed_at,complete,listing_count,ticket_count,min_price_yen,median_price_yen,price_distribution)
      SELECT $1,$2,$3,$4,count(*),coalesce(sum(quantity),0),min(price_yen),percentile_cont(0.5) WITHIN GROUP(ORDER BY price_yen),coalesce(jsonb_agg(price_yen ORDER BY price_yen),'[]')
      FROM listing_observations WHERE run_id=$1 AND state='listed'`,
      [runId, source.event_id, lastTime, coverage.complete],
    );
    await c.query("COMMIT");
    return { runId, duplicate: false };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
