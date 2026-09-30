import type pg from "pg";
import { createHash } from "node:crypto";
import {
  nameKey,
  OFFICIAL_PARSER_VERSION,
  type OfficialStage,
} from "../sources/official/ticketdive.js";

export async function storeOfficial(
  pool: pg.Pool,
  url: string,
  checkedAt: Date,
  stages: OfficialStage[],
  parserVersion = OFFICIAL_PARSER_VERSION,
) {
  const c = await pool.connect();
  let matches = 0;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `official:${url}`,
    ]);
    await c.query(
      "INSERT INTO official_sources(url) VALUES($1) ON CONFLICT DO NOTHING",
      [url],
    );
    const events = (await c.query("SELECT * FROM events")).rows;
    for (const stage of stages) {
      const candidates = events.filter(
        (e) =>
          nameKey(e.title) === nameKey(stage.eventName) &&
          new Date(e.starts_at).getTime() === Date.parse(stage.startsAt),
      );
      for (const event of candidates) {
        const exactVenue = nameKey(event.venue) === nameKey(stage.venue);
        await c.query(
          "INSERT INTO official_links(event_id,source_url,stage_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [event.id, url, stage.stageId],
        );
        const link = (
          await c.query(
            "SELECT * FROM official_links WHERE event_id=$1 AND source_url=$2 AND stage_id=$3",
            [event.id, url, stage.stageId],
          )
        ).rows[0];
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(stage))
          .digest("hex");
        const prior = (
          await c.query(
            "SELECT * FROM official_evidence WHERE event_id=$1 AND source_url=$2 ORDER BY checked_at DESC LIMIT 1",
            [event.id, url],
          )
        ).rows[0];
        // A manual approval covers the stage identity, not arbitrary future field changes.
        const confirmed =
          exactVenue ||
          Boolean(
            link.confirmed_at && (!prior || prior.fingerprint === fingerprint),
          );
        const evidence = (
          await c.query(
            `INSERT INTO official_evidence(event_id,source_url,checked_at,parser_version,extracted_fields,review_status,fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id,source_url,fingerprint) DO UPDATE SET checked_at=excluded.checked_at RETURNING *`,
            [
              event.id,
              url,
              checkedAt,
              parserVersion,
              JSON.stringify(stage),
              confirmed ? "confirmed" : "pending",
              fingerprint,
            ],
          )
        ).rows[0];
        matches++;
        if (evidence.review_status === "rejected") continue;
        if (evidence.review_status !== "confirmed") {
          const pending = await c.query(
            "SELECT id FROM review_queue WHERE event_id=$1 AND reason='official_match' AND details->>'evidenceId'=$2 AND status='pending'",
            [event.id, evidence.id],
          );
          if (!pending.rowCount)
            await c.query(
              "INSERT INTO review_queue(event_id,reason,details) VALUES($1,$2,$3)",
              [
                event.id,
                "official_match",
                JSON.stringify({
                  evidenceId: evidence.id,
                  url,
                  sourceVenue: stage.venue,
                  eventVenue: event.venue,
                  stageName: stage.stageName,
                }),
              ],
            );
          continue;
        }
        await materializeOfficial(c, event.id, evidence.id, stage);
      }
    }
    await c.query(
      "UPDATE official_sources SET checked_at=$2,last_error=NULL WHERE url=$1",
      [url, checkedAt],
    );
    await c.query("COMMIT");
    return { matches };
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

async function materializeOfficial(
  c: pg.PoolClient,
  eventId: string,
  evidenceId: string,
  stage: OfficialStage,
) {
  const names = [...new Set(stage.tickets.map((t) => t.name))];
  for (const name of names) {
    const variants = stage.tickets.filter((t) => t.name === name);
    const one = <T>(values: T[]) =>
      new Set(values).size === 1 ? values[0]! : null;
    const typeId = (
      await c.query(
        `INSERT INTO ticket_types(event_id,name,face_value_yen,fee_yen,drink_yen,evidence_id,admission_prefix)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id,name) DO UPDATE SET face_value_yen=excluded.face_value_yen,fee_yen=excluded.fee_yen,drink_yen=excluded.drink_yen,evidence_id=excluded.evidence_id,admission_prefix=excluded.admission_prefix RETURNING id`,
        [
          eventId,
          name,
          one(variants.map((v) => v.price)),
          one(variants.map((v) => v.fee)),
          stage.drinkYen,
          evidenceId,
          one(variants.map((v) => v.prefix)),
        ],
      )
    ).rows[0].id;
    await c.query(
      "DELETE FROM sale_windows WHERE ticket_type_id=$1 AND NOT(source_window_id=ANY($2::text[]))",
      [typeId, variants.map((v) => v.windowId)],
    );
    for (const v of variants)
      await c.query(
        `INSERT INTO sale_windows(ticket_type_id,name,starts_at,ends_at,evidence_id,source_window_id,face_value_yen,fee_yen)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(ticket_type_id,source_window_id) DO UPDATE SET name=excluded.name,starts_at=excluded.starts_at,ends_at=excluded.ends_at,evidence_id=excluded.evidence_id,face_value_yen=excluded.face_value_yen,fee_yen=excluded.fee_yen`,
        [
          typeId,
          v.windowName,
          v.startsAt,
          v.endsAt,
          evidenceId,
          v.windowId,
          v.price,
          v.fee,
        ],
      );
  }
  // Remove obsolete derived types from this source; the original evidence remains immutable.
  const stale = (
    await c.query(
      "SELECT t.id FROM ticket_types t JOIN official_evidence oe ON oe.id=t.evidence_id WHERE t.event_id=$1 AND oe.source_url=(SELECT source_url FROM official_evidence WHERE id=$2) AND NOT(t.name=ANY($3::text[]))",
      [eventId, evidenceId, names],
    )
  ).rows.map((r) => r.id);
  await c.query(
    "DELETE FROM sale_windows WHERE ticket_type_id=ANY($1::uuid[])",
    [stale],
  );
  await c.query("DELETE FROM ticket_types WHERE id=ANY($1::uuid[])", [stale]);
}

export async function reviewOfficial(
  pool: pg.Pool,
  evidenceId: string,
  decision: "confirmed" | "rejected",
  note: string,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = (
      await c.query("SELECT * FROM official_evidence WHERE id=$1 FOR UPDATE", [
        evidenceId,
      ])
    ).rows[0];
    if (!row?.event_id)
      throw new Error("Evidence with event association required");
    await c.query("UPDATE official_evidence SET review_status=$2 WHERE id=$1", [
      evidenceId,
      decision,
    ]);
    const stage = row.extracted_fields as OfficialStage;
    if (decision === "confirmed") {
      await c.query(
        "UPDATE official_links SET confirmed_at=now(),review_note=$4 WHERE event_id=$1 AND source_url=$2 AND stage_id=$3",
        [row.event_id, row.source_url, stage.stageId, note],
      );
      await materializeOfficial(c, row.event_id, row.id, stage);
    }
    if (decision === "rejected") {
      await c.query(
        "DELETE FROM sale_windows WHERE ticket_type_id IN(SELECT id FROM ticket_types WHERE evidence_id=$1)",
        [evidenceId],
      );
      await c.query("DELETE FROM ticket_types WHERE evidence_id=$1", [
        evidenceId,
      ]);
    }
    await c.query(
      "UPDATE review_queue SET status=$2,resolved_at=now(),details=details||jsonb_build_object('reviewNote',$3::text) WHERE details->>'evidenceId'=$1",
      [evidenceId, decision === "confirmed" ? "resolved" : "rejected", note],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
