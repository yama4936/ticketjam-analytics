-- Read-time matching keeps immutable observations intact and excludes ambiguous identities.
CREATE FUNCTION ticket_purpose_v1(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH flags AS (SELECT
    normalize(coalesce(value,''), NFKC) ~ '前物販|事前物販' AS merch,
    normalize(coalesce(value,''), NFKC) ~ '特典会|チェキ会|撮影会|握手会' AS benefit,
    normalize(coalesce(value,''), NFKC) ~* 'ライブ|LIVE|FESTIVAL|フェス|コンサート' AS live)
  SELECT CASE WHEN merch::int + benefit::int + live::int > 1 THEN '用途複合・要確認'
    WHEN merch THEN '前物販' WHEN benefit THEN '特典会' WHEN live THEN 'ライブ'
    ELSE '用途未確認' END FROM flags
$$;
CREATE FUNCTION ticket_session_v1(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
   WHEN normalize(coalesce(value,''),NFKC) ~ '[0-9]+\s*部'
     THEN 'part:' || (regexp_match(normalize(value,NFKC),'([0-9]+)\s*部'))[1]
   WHEN normalize(coalesce(value,''),NFKC) ~* 'DAY[ -]*[0-9]+'
     THEN 'day:' || (regexp_match(normalize(value,NFKC),'DAY[ -]*([0-9]+)','i'))[1]
   ELSE NULL END
$$;
CREATE FUNCTION matched_ticket_type_v1(event_key uuid, raw_text text, normalized_type text, prefix text)
RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH candidates AS (
    SELECT t.id FROM ticket_types t JOIN official_evidence oe ON oe.id=t.evidence_id
    JOIN events e ON e.id=t.event_id
    WHERE t.event_id=event_key AND oe.review_status='confirmed'
    -- Explicit listing purpose/session conflicts always override a matching prefix.
    AND (ticket_purpose_v1(raw_text)='用途未確認' OR
      ticket_purpose_v1(raw_text)=ticket_purpose_v1(e.title || ' ' || coalesce(oe.extracted_fields->>'stageName','') || ' ' || t.name))
    AND (ticket_session_v1(raw_text) IS NULL OR
      ticket_session_v1(raw_text)=ticket_session_v1(coalesce(oe.extracted_fields->>'stageName','') || ' ' || t.name))
    AND (normalize(coalesce(raw_text,''),NFKC) !~ '[0-9]{1,2}/[0-9]{1,2}' OR
      (regexp_match(normalize(raw_text,NFKC),'([0-9]{1,2})/([0-9]{1,2})'))[1]::int=extract(month FROM e.starts_at AT TIME ZONE 'Asia/Tokyo')
      AND (regexp_match(normalize(raw_text,NFKC),'([0-9]{1,2})/([0-9]{1,2})'))[2]::int=extract(day FROM e.starts_at AT TIME ZONE 'Asia/Tokyo'))
    AND (
      t.name=normalized_type OR position(normalize(t.name,NFKC) in normalize(coalesce(raw_text,''),NFKC))>0
      OR t.admission_prefix=prefix
      OR (ticket_session_v1(raw_text) IS NOT NULL AND
        ticket_session_v1(raw_text)=ticket_session_v1(coalesce(oe.extracted_fields->>'stageName','') || ' ' || t.name)
        AND (SELECT count(*) FROM ticket_types tt JOIN official_evidence oo ON oo.id=tt.evidence_id WHERE tt.event_id=e.id AND oo.review_status='confirmed')=1)
    )
  ) SELECT CASE WHEN count(*)=1 THEN (array_agg(id))[1] ELSE NULL END FROM candidates
$$;
