export interface Group {
  id: string;
  name: string;
  enabled: boolean;
}
export interface PriceGroup {
  official_type_id: string | null;
  purpose: string;
  segment: string;
  face_value_yen: number | null;
  listing_count: number;
  ticket_count: number;
  median_price_yen: number | null;
  min_price_yen: number | null;
}
export interface EventSummary {
  purpose: string;
  session_label: string | null;
  price_groups?: PriceGroup[];
  id: string;
  title: string;
  starts_at: string;
  venue: string;
  source_url: string;
  groups: Group[] | null;
  listing_count: number | null;
  ticket_count: number | null;
  median_price_yen: number | null;
  min_price_yen: number | null;
  observed_at: string | null;
  complete: boolean | null;
  latest_status: string | null;
}
export interface EventIndex {
  events: EventSummary[];
  scope: {
    candidates: number;
    monitored: number;
    observation_started_at: string | null;
    source_blocked: boolean | null;
  };
}
export interface Observation {
  id: string;
  listing_id: string;
  price_yen: number;
  quantity: number;
  admission_raw: string;
  ticket_type: string | null;
  state: string;
  observed_at: string;
  first_observed_at: string;
  url: string;
  admission_kind: string;
  admission_prefix: string | null;
  admission_lower: number | null;
  admission_upper: number | null;
}
export interface TimelinePoint {
  runId: string;
  time: string;
  scheduledAt: string;
  status: string;
  warnings: string[];
  error: string | null;
  listingCount: number | null;
  ticketCount: number | null;
  minPrice: number | null;
  medianPrice: number | null;
  newCount: number | null;
}
export interface Change {
  asking_price_yen: number | null;
  confirmed_sale_price_yen: number | null;
  admission_lower: number | null;
  admission_prefix: string | null;
  id: string;
  kind: string;
  interval_start: string | null;
  interval_end: string;
  before_value: unknown;
  after_value: unknown;
  first_observed_at: string;
}
export interface Official {
  purpose: string;
  id: string;
  name: string;
  face_value_yen: number | null;
  fee_yen: number | null;
  drink_yen: number | null;
  source_url: string;
  checked_at: string;
  review_status: string;
  admission_prefix: string | null;
  sale_windows:
    | {
        id: string;
        name: string;
        starts_at: string | null;
        ends_at: string | null;
        face_value_yen: number | null;
        fee_yen: number | null;
      }[]
    | null;
}
export interface Outcome {
  id: string;
  url: string;
  state: string;
  first_observed_at: string;
  last_observed_at: string;
  last_listed_at: string | null;
  asking_price_yen: number;
  confirmed_sale_price_yen: number | null;
  admission_raw: string;
  admission_lower: number | null;
  admission_upper: number | null;
  admission_prefix: string | null;
  interval_start: string | null;
  interval_end: string | null;
}
export interface Detail {
  outcomes: Outcome[];
  outcomesTruncated: boolean;
  snapshots: { id: string; observed_at: string; status: string }[];
  selectedSnapshot: { id: string; observed_at: string; status: string } | null;
  view: "current" | "history";
  priceGroups: PriceGroup[];
  priceComparable: boolean;
  event: EventSummary;
  types: string[];
  official: Official[];
  listings: Observation[];
  timeline: TimelinePoint[];
  changes: Change[];
  summary: {
    listingCount: number | null;
    ticketCount: number | null;
    minPrice: number | null;
    medianPrice: number | null;
  };
  histogram: { lower: number; upper: number; count: number }[];
  latestStatus: string;
  truncated: boolean;
  capabilities: { soldConfirmation: boolean };
}

export interface Comparison {
  rows: (PriceGroup & {
    event_id: string;
    title: string;
    starts_at: string;
    observed_at: string;
    status: string;
    groups: string[] | null;
    segment: string;
    listing_count: number;
    ticket_count: number;
    min_price_yen: number | null;
    median_price_yen: number | null;
  })[];
  truncated: boolean;
}
