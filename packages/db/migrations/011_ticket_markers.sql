-- Ticket identity can be explicit even when the admission number is uncertain.
-- Keep number parsing independent: S~650 identifies S but not an exact number.
CREATE FUNCTION ticket_markers_v1(raw_text text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 WITH input AS (
   SELECT upper(translate(normalize(coalesce(raw_text,''),NFKC),'〜～–−ー','~~---')) AS value
 ), markers AS (
   SELECT m[1] AS marker FROM input,
   LATERAL regexp_matches(value,'(?<![A-Z0-9])([A-Z]{1,3})(?=(チケット|チケ|券|席|[[:space:]~-]*[0-9]))','g') m
   UNION
   SELECT m[1] FROM input,
   LATERAL regexp_matches(value,'(一般|女性)(?=(チケット|チケ|券|[[:space:]]*[0-9]|[[:space:]]*$))','g') m
 ) SELECT coalesce(array_agg(DISTINCT marker),'{}'::text[]) FROM markers
$$;
CREATE OR REPLACE FUNCTION matched_ticket_type_v1(event_key uuid, raw_text text, normalized_type text, prefix text)
RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH candidates AS (
    SELECT t.id FROM ticket_types t JOIN official_evidence oe ON oe.id=t.evidence_id
    JOIN events e ON e.id=t.event_id
    WHERE t.event_id=event_key AND oe.review_status='confirmed'
    -- Explicit listing purpose/session conflicts always override a matching prefix.
    AND (ticket_purpose_v1(raw_text)='用途未確認' OR
      ticket_purpose_v1(raw_text)=official_ticket_purpose_v1(e.title,oe.extracted_fields->>'stageName',t.name))
    AND (ticket_session_v1(raw_text) IS NULL OR
      ticket_session_v1(raw_text)=ticket_session_v1(coalesce(oe.extracted_fields->>'stageName','') || ' ' || t.name))
    AND (normalize(coalesce(raw_text,''),NFKC) !~ '[0-9]{1,2}/[0-9]{1,2}' OR
      (regexp_match(normalize(raw_text,NFKC),'([0-9]{1,2})/([0-9]{1,2})'))[1]::int=extract(month FROM e.starts_at AT TIME ZONE 'Asia/Tokyo')
      AND (regexp_match(normalize(raw_text,NFKC),'([0-9]{1,2})/([0-9]{1,2})'))[2]::int=extract(day FROM e.starts_at AT TIME ZONE 'Asia/Tokyo'))
    AND (
      t.name=normalized_type OR position(normalize(t.name,NFKC) in normalize(coalesce(raw_text,''),NFKC))>0
      OR t.admission_prefix=prefix
      OR t.admission_prefix=ANY(ticket_markers_v1(raw_text))
      OR regexp_replace(normalize(t.name,NFKC),'(チケット|チケ|券)$','')=ANY(ticket_markers_v1(raw_text))
      OR (ticket_session_v1(raw_text) IS NOT NULL AND
        ticket_session_v1(raw_text)=ticket_session_v1(coalesce(oe.extracted_fields->>'stageName','') || ' ' || t.name)
        AND (SELECT count(*) FROM ticket_types tt JOIN official_evidence oo ON oo.id=tt.evidence_id WHERE tt.event_id=e.id AND oo.review_status='confirmed')=1)
    )
  ) SELECT CASE WHEN count(*)=1 THEN (array_agg(id))[1] ELSE NULL END FROM candidates
$$;
