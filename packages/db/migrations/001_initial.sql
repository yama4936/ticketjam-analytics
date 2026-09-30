CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  ticketjam_slug text UNIQUE,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  venue text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_starts_at ON events(starts_at);
CREATE TABLE event_groups (
  event_id uuid NOT NULL REFERENCES events(id),
  group_id uuid NOT NULL REFERENCES groups(id),
  PRIMARY KEY (event_id, group_id)
);
CREATE INDEX event_groups_group ON event_groups(group_id);
CREATE TABLE source_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  source text NOT NULL,
  external_id text NOT NULL,
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, external_id)
);
CREATE INDEX source_events_event ON source_events(event_id);
CREATE TABLE source_state (
  source text PRIMARY KEY,
  next_request_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  block_reason text,
  min_interval_ms integer NOT NULL DEFAULT 5000 CHECK (min_interval_ms >= 1000)
);
INSERT INTO source_state(source) VALUES ('ticketjam');

CREATE TABLE collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id uuid NOT NULL REFERENCES source_events(id),
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  parser_version text NOT NULL,
  pages_fetched integer NOT NULL DEFAULT 0,
  expected_count integer CHECK (expected_count >= 0),
  observed_count integer CHECK (observed_count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]',
  error text,
  UNIQUE(source_event_id, scheduled_at)
);
CREATE INDEX collection_runs_freshness ON collection_runs(source_event_id, completed_at DESC);
CREATE TABLE collection_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES collection_runs(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text,
  error text
);
CREATE INDEX collection_attempts_run ON collection_attempts(run_id);
CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text NOT NULL,
  event_id uuid NOT NULL REFERENCES events(id),
  url text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_listed_at timestamptz,
  source_created_at timestamptz,
  state text NOT NULL CHECK (state IN ('listed','sold_confirmed','ended_unknown')),
  UNIQUE(source, external_id)
);
CREATE INDEX listings_event ON listings(event_id, state);
CREATE TABLE listing_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id),
  run_id uuid NOT NULL REFERENCES collection_runs(id),
  observed_at timestamptz NOT NULL,
  price_yen integer NOT NULL CHECK (price_yen >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  admission_raw text NOT NULL,
  ticket_type_raw text,
  state text NOT NULL CHECK (state IN ('listed','sold_confirmed')),
  confirmed_sale_price_yen integer CHECK (confirmed_sale_price_yen >= 0),
  raw_fields jsonb NOT NULL,
  parser_version text NOT NULL,
  CHECK (confirmed_sale_price_yen IS NULL OR state = 'sold_confirmed'),
  UNIQUE(listing_id, run_id)
);
CREATE INDEX observations_listing_time ON listing_observations(listing_id, observed_at DESC);
CREATE INDEX observations_run ON listing_observations(run_id);
CREATE TABLE observation_normalizations (
  observation_id uuid NOT NULL REFERENCES listing_observations(id),
  version text NOT NULL,
  admission_kind text NOT NULL CHECK (admission_kind IN ('number','range','unknown','unassigned','reserved_seat')),
  admission_prefix text,
  admission_lower integer,
  admission_upper integer,
  ticket_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(observation_id, version),
  CHECK ((admission_lower IS NULL AND admission_upper IS NULL) OR
         (admission_lower IS NOT NULL AND admission_upper IS NOT NULL AND admission_lower >= 1 AND admission_upper >= admission_lower))
);
CREATE INDEX normalizations_admission ON observation_normalizations(version, admission_prefix, admission_lower);
CREATE TABLE listing_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id),
  run_id uuid NOT NULL REFERENCES collection_runs(id),
  kind text NOT NULL CHECK (kind IN ('first_seen','price_drop','price_rise','quantity_changed','sold_confirmed','ended_unknown','reappeared')),
  interval_start timestamptz,
  interval_end timestamptz NOT NULL,
  before_value jsonb,
  after_value jsonb,
  CHECK (interval_start IS NULL OR interval_start <= interval_end),
  UNIQUE(listing_id, run_id, kind)
);
CREATE INDEX changes_run ON listing_changes(run_id);
CREATE INDEX changes_listing_time ON listing_changes(listing_id, interval_end);

CREATE TABLE official_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id),
  source_url text NOT NULL,
  checked_at timestamptz NOT NULL,
  parser_version text NOT NULL,
  extracted_fields jsonb NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','confirmed','rejected'))
);
CREATE INDEX official_evidence_event ON official_evidence(event_id);
CREATE TABLE ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  name text NOT NULL,
  face_value_yen integer CHECK(face_value_yen >= 0),
  fee_yen integer CHECK(fee_yen >= 0),
  drink_yen integer CHECK(drink_yen >= 0),
  evidence_id uuid NOT NULL REFERENCES official_evidence(id),
  UNIQUE(event_id, name)
);
CREATE INDEX ticket_types_evidence ON ticket_types(evidence_id);
CREATE TABLE sale_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_type_id uuid NOT NULL REFERENCES ticket_types(id),
  name text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  evidence_id uuid NOT NULL REFERENCES official_evidence(id),
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  UNIQUE(ticket_type_id, name)
);
CREATE INDEX sale_windows_evidence ON sale_windows(evidence_id);
CREATE TABLE review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id),
  reason text NOT NULL,
  details jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX review_queue_event ON review_queue(event_id);
CREATE INDEX review_queue_pending ON review_queue(created_at) WHERE status='pending';
CREATE TABLE event_metrics (
  run_id uuid PRIMARY KEY REFERENCES collection_runs(id),
  event_id uuid NOT NULL REFERENCES events(id),
  observed_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  listing_count integer NOT NULL,
  ticket_count integer NOT NULL,
  min_price_yen integer,
  median_price_yen numeric,
  price_distribution jsonb NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_metrics_event_time ON event_metrics(event_id, observed_at);
