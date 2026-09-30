ALTER TABLE discovery_candidates ADD COLUMN last_error text;
ALTER TABLE discovery_candidates ADD COLUMN retry_after timestamptz;
ALTER TABLE discovery_runs DROP CONSTRAINT discovery_runs_status_check;
ALTER TABLE discovery_runs ADD CHECK(status IN ('running','complete','partial','failed'));
