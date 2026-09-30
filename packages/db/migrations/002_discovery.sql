CREATE TABLE discovery_candidates (
  source text NOT NULL,
  external_id text NOT NULL,
  group_id uuid NOT NULL REFERENCES groups(id),
  url text NOT NULL,
  first_discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_discovered_at timestamptz NOT NULL DEFAULT now(),
  imported boolean NOT NULL DEFAULT false,
  PRIMARY KEY(source,external_id,group_id)
);
CREATE INDEX discovery_candidates_group ON discovery_candidates(group_id);
CREATE TABLE discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','failed')),
  discovered_count integer,
  error text
);
CREATE INDEX discovery_runs_group_time ON discovery_runs(group_id,started_at DESC);
INSERT INTO groups(name,ticketjam_slug) VALUES ('iLiFE!','ilife-idol') ON CONFLICT DO NOTHING;
