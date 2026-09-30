CREATE TABLE worker_heartbeat (
  name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL
);
CREATE TABLE operational_alerts (
  key text PRIMARY KEY,
  message text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX operational_alerts_active ON operational_alerts(last_seen_at) WHERE resolved_at IS NULL;
