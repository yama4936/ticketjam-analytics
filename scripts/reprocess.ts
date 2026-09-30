import { createPool } from "../packages/db/pool.js";
import {
  normalizeAdmission,
  classifyTicketType,
} from "../packages/normalization/admission.js";
import { NORMALIZATION_VERSION } from "../packages/domain/types.js";
const pool = createPool();
let processed = 0;
try {
  for (;;) {
    const rows = (
      await pool.query(
        "SELECT id,admission_raw FROM listing_observations o WHERE NOT EXISTS(SELECT 1 FROM observation_normalizations n WHERE n.observation_id=o.id AND n.version=$1) ORDER BY id LIMIT 500",
        [NORMALIZATION_VERSION],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const n = normalizeAdmission(row.admission_raw);
      await pool.query(
        `INSERT INTO observation_normalizations(observation_id,version,admission_kind,admission_prefix,admission_lower,admission_upper,ticket_type)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          row.id,
          n.version,
          n.kind,
          n.prefix,
          n.lower,
          n.upper,
          classifyTicketType(row.admission_raw),
        ],
      );
      processed++;
    }
  }
  console.log(JSON.stringify({ processed, version: NORMALIZATION_VERSION }));
} finally {
  await pool.end();
}
