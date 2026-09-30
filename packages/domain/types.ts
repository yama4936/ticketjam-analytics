export const PARSER_VERSION = "ticketjam-1";
export const NORMALIZATION_VERSION = "admission-3";

export type ListingState = "listed" | "sold_confirmed" | "ended_unknown";
export interface Admission {
  raw: string;
  kind: "number" | "range" | "unknown" | "unassigned" | "reserved_seat";
  prefix: string | null;
  lower: number | null;
  upper: number | null;
  version: string;
}
export interface SourceListing {
  externalId: string;
  url: string;
  priceYen: number;
  quantity: number;
  admissionRaw: string;
  ticketType: string | null;
  state: ListingState;
  // Only populate from an explicit source field; never copy an asking price here.
  confirmedSalePriceYen: number | null;
}
export interface SourceEvent {
  externalId: string;
  url: string;
  title: string;
  startsAt: string;
  venue: string;
}
export interface EventPage {
  event: SourceEvent;
  listings: SourceListing[];
  expectedCount: number;
  nextUrl: string | null;
  warnings: string[];
}
