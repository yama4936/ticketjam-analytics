CREATE TABLE official_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES official_evidence(id),
  decision text NOT NULL CHECK(decision IN('confirmed','rejected')),
  note text NOT NULL CHECK(length(note)>=10),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX official_reviews_evidence_time ON official_reviews(evidence_id,reviewed_at DESC);
