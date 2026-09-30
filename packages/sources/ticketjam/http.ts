import type pg from "pg";
import { PublicSourceHttp } from "../http.js";
export { SourceBlockedError, SourceHttpError, retryAfterMs } from "../http.js";
export class TicketjamHttp extends PublicSourceHttp {
  constructor(pool: pg.Pool, fetcher: typeof fetch = fetch) {
    super(pool, "ticketjam", fetcher);
  }
}
