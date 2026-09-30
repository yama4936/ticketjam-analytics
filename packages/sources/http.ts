import type pg from "pg";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const USER_AGENT =
  "TicketTrendResearch/0.1 (+https://github.com/yama4936/ticketjam-analytics)";
interface RobotPolicy {
  isAllowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
}
const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  text: string,
) => RobotPolicy;
export class SourceBlockedError extends Error {}
export class SourceHttpError extends Error {
  constructor(public status: number) {
    super(`Source returned HTTP ${status}`);
  }
}
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 3600000;
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(3600000, ms) : 3600000;
}

// One session lock spans the request. This enforces spacing even with many workers
// and stops already-queued requests after a remote access restriction is observed.
export class PublicSourceHttp {
  private robots: RobotPolicy | null = null;
  private robotsAt = 0;
  constructor(
    private pool: pg.Pool,
    private source: "ticketjam" | "ticketdive" | "tvasahi",
    private fetcher: typeof fetch = fetch,
  ) {}
  private get origin() {
    return this.source === "ticketjam"
      ? "https://ticketjam.jp"
      : this.source === "ticketdive"
        ? "https://ticketdive.com"
        : "https://ticket.tv-asahi.co.jp";
  }

  async get(url: string): Promise<{ html: string; observedAt: Date }> {
    return this.getPage(url);
  }

  // A fresh anonymous cookie context carries only this ticket's redirect notice.
  async getTicketOutcome(url: string) {
    if (
      this.source !== "ticketjam" ||
      !/^https:\/\/ticketjam.jp\/ticket\/[a-z_]+\/\d+$/.test(url)
    )
      throw new Error("Expected ticket detail URL");
    return this.getPage(url, true);
  }

  private async getPage(
    url: string,
    followTicketRedirect = false,
    cookie = "",
  ): Promise<{ html: string; observedAt: Date; finalUrl: string }> {
    const checked = new URL(url);
    if (
      checked.origin !== this.origin ||
      checked.username ||
      checked.password ||
      checked.hash
    )
      throw new Error("Invalid source URL");
    const allowedPath =
      this.source === "ticketjam"
        ? /^(?:\/tickets\/[a-z0-9-]+(?:\/event\/\d+)?|\/ticket\/[a-z_]+\/\d+(?:-\d+)?)$/
        : this.source === "ticketdive"
          ? /^\/(?:event|artist)\/[a-zA-Z0-9_-]+$/
          : /^\/ex\/project\/gift$/;
    if (
      !allowedPath.test(checked.pathname) ||
      [...checked.searchParams.keys()].some((k) => k !== "page")
    )
      throw new Error("URL outside collection allowlist");
    if (!this.robots || Date.now() - this.robotsAt > 3600000) {
      const result = await this.request(`${this.origin}/robots.txt`);
      this.robots = robotsParser(`${this.origin}/robots.txt`, result.html);
      this.robotsAt = Date.now();
      const crawlDelay = this.robots.getCrawlDelay(USER_AGENT);
      if (crawlDelay && crawlDelay > 5)
        await this.pool.query(
          "UPDATE source_state SET min_interval_ms=greatest(min_interval_ms,$1) WHERE source=$2",
          [Math.ceil(crawlDelay * 1000), this.source],
        );
    }
    if (this.robots.isAllowed(checked.href, USER_AGENT) !== true)
      throw new SourceBlockedError("robots.txt does not allow this path");
    const result = await this.request(
      checked.href,
      cookie,
      followTicketRedirect,
    );
    if (result.redirectUrl)
      return this.getPage(result.redirectUrl, false, result.cookie);
    return {
      html: result.html,
      observedAt: result.observedAt,
      finalUrl: checked.href,
    };
  }

  private async request(
    url: string,
    cookie = "",
    followTicketRedirect = false,
  ): Promise<{
    html: string;
    observedAt: Date;
    redirectUrl?: string;
    cookie?: string;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [
        `${this.source}-http`,
      ]);
      const row = (
        await client.query(
          "SELECT *,blocked_until>now() AS blocked FROM source_state WHERE source=$1",
          [this.source],
        )
      ).rows[0];
      if (!row || row.blocked)
        throw new SourceBlockedError(
          row?.block_reason ?? "Source policy missing",
        );
      await delay(
        Math.max(0, new Date(row.next_request_at).getTime() - Date.now()),
      );
      let response: Response;
      try {
        response = await this.fetcher(url, {
          redirect: "manual",
          headers: {
            "User-Agent": USER_AGENT,
            ...(cookie ? { Cookie: cookie } : {}),
            Accept: url.endsWith("/robots.txt") ? "text/plain" : "text/html",
          },
          signal: AbortSignal.timeout(30000),
        });
      } finally {
        await client.query(
          "UPDATE source_state SET next_request_at=now() + min_interval_ms * interval '1 millisecond' WHERE source=$1",
          [this.source],
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        const target = location ? new URL(location, url) : null;
        // Removed ticket details can redirect to their public event. This is not
        // sale evidence, and is not an access ban affecting unrelated events.
        if (
          this.source !== "tvasahi" &&
          target?.origin === this.origin &&
          !target.username &&
          !target.password &&
          (this.source === "ticketjam"
            ? /^\/tickets\/[a-z0-9-]+(?:\/event\/\d+)?$/
            : /^\/(event|artist)\/[a-zA-Z0-9_-]+$/
          ).test(target.pathname)
        ) {
          await response.body?.cancel();
          if (
            followTicketRedirect &&
            this.source === "ticketjam" &&
            !target.search
          ) {
            return {
              html: "",
              observedAt: new Date(),
              redirectUrl: target.href,
              cookie: response.headers
                .getSetCookie()
                .map((c) => c.split(";")[0])
                .join("; "),
            };
          }
          throw new SourceHttpError(response.status);
        }
      }
      if (
        [401, 403, 429].includes(response.status) ||
        (response.status >= 300 && response.status < 400)
      ) {
        const reason =
          response.status === 429
            ? "HTTP 429 rate limit"
            : `HTTP ${response.status}: access or redirect requires review`;
        const until =
          response.status === 429
            ? new Date(
                Date.now() + retryAfterMs(response.headers.get("retry-after")),
              ).toISOString()
            : "infinity";
        await client.query(
          "UPDATE source_state SET blocked_until=$1,block_reason=$2 WHERE source=$3",
          [until, reason, this.source],
        );
        await response.body?.cancel();
        throw new SourceBlockedError(reason);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceHttpError(response.status);
      }
      if (!response.headers.get("content-type")?.match(/text\/(html|plain)/)) {
        await response.body?.cancel();
        throw new Error("Unexpected source content type");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Source body missing");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 3_000_000) {
          await reader.cancel();
          throw new Error("Source response exceeds size limit");
        }
        chunks.push(value);
      }
      const html = Buffer.concat(chunks).toString("utf8");
      if (
        !url.endsWith("/robots.txt") &&
        /<title>[^<]*(?:Access Denied|Just a moment|ログイン)/i.test(html)
      ) {
        await client.query(
          "UPDATE source_state SET blocked_until='infinity',block_reason='Access challenge' WHERE source=$1",
          [this.source],
        );
        throw new SourceBlockedError("Access challenge requires review");
      }
      return { html, observedAt: new Date() };
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          `${this.source}-http`,
        ]);
      } finally {
        client.release();
      }
    }
  }
}
