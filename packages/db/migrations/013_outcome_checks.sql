CREATE TABLE listing_outcome_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 listing_id uuid NOT NULL REFERENCES listings(id),
 checked_at timestamptz NOT NULL,
 source_url text NOT NULL,
 final_url text,
 status text NOT NULL CHECK(status IN ('purchased','unconfirmed','failed')),
 evidence_text text,
 content_sha256 text,
 error text
);
CREATE INDEX outcome_checks_listing_time ON listing_outcome_checks(listing_id,checked_at DESC);
