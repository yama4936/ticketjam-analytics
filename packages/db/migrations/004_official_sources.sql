INSERT INTO source_state(source) VALUES('ticketdive') ON CONFLICT DO NOTHING;
ALTER TABLE groups ADD COLUMN official_artist_slug text;
UPDATE groups SET official_artist_slug='ilife' WHERE ticketjam_slug='ilife-idol';
CREATE TABLE official_sources (
  url text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  checked_at timestamptz,
  last_error text,
  discovered_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO official_sources(url) VALUES('https://ticketdive.com/event/noa_later2026'),('https://ticketdive.com/event/ilive1021');
ALTER TABLE official_evidence ADD COLUMN fingerprint text;
CREATE UNIQUE INDEX official_evidence_version ON official_evidence(event_id,source_url,fingerprint);
ALTER TABLE ticket_types ADD COLUMN admission_prefix text;
ALTER TABLE sale_windows ADD COLUMN source_window_id text;
ALTER TABLE sale_windows ADD COLUMN face_value_yen integer CHECK(face_value_yen>=0);
ALTER TABLE sale_windows ADD COLUMN fee_yen integer CHECK(fee_yen>=0);
ALTER TABLE sale_windows DROP CONSTRAINT sale_windows_ticket_type_id_name_key;
CREATE UNIQUE INDEX sale_windows_source_window ON sale_windows(ticket_type_id,source_window_id);
CREATE TABLE official_links (
  event_id uuid NOT NULL REFERENCES events(id),
  source_url text NOT NULL REFERENCES official_sources(url),
  stage_id text NOT NULL,
  confirmed_at timestamptz,
  review_note text,
  PRIMARY KEY(event_id,source_url,stage_id)
);
CREATE INDEX official_links_source ON official_links(source_url);
