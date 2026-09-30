import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
import { migrate } from "../packages/db/migrate.js";
import { buildServer } from "../apps/api/server.js";
test(
  "all management routes: authorization, validation, duplicate conflicts and reversible group state",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    await migrate(pool);
    process.env.ADMIN_TOKEN = randomUUID();
    process.env.TRUST_PROXY = "1";
    const app = await buildServer(pool);
    const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      suffix = randomUUID();
    try {
      for (const url of [
        "/healthz",
        "/api/status",
        "/api/groups",
        "/api/events",
        "/api/comparison?by=event",
        "/api/comparison?by=type",
        "/api/comparison?by=prefix",
      ]) {
        const r = await app.inject(url);
        assert.equal(r.statusCode, 200, url);
        assert.equal(r.headers["x-content-type-options"], "nosniff");
      }
      for (const url of [
        "/api/events?group=invalid",
        "/api/comparison?by=unknown",
        "/api/events/not-a-uuid",
        "/api/events?q=" + "x".repeat(101),
      ])
        assert.equal((await app.inject(url)).statusCode, 400, url);
      for (const url of [
        "/api/admin/summary",
        "/api/admin/summary?x=y",
        "/api/%61dmin/summary",
        "/api/admin%2fsummary",
        "/api//admin/summary",
      ])
        assert.ok(
          [401, 403, 404].includes((await app.inject(url)).statusCode),
          url,
        );
      for (const url of [
        "/api/admin/groups",
        "/api/%61dmin/groups",
        `/api/admin/groups/${suffix}`,
        `/api/%61dmin/groups/${suffix}`,
        `/api/admin/reviews/${suffix}`,
        `/api/admin/evidence/${suffix}`,
        "/api/admin/official-sources",
      ])
        assert.equal(
          (await app.inject({ method: "POST", url, payload: {} })).statusCode,
          401,
          url,
        );
      const post = (url: string, payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url, headers, payload });
      assert.equal(
        (
          await post("/api/admin/groups", {
            name: "   ",
            ticketjamSlug: "test",
          })
        ).statusCode,
        400,
      );
      const body = {
        name: `Route ${suffix}`,
        ticketjamSlug: `route-${suffix}`,
        officialArtistSlug: "test",
      };
      let r = await post("/api/admin/groups", body);
      assert.equal(r.statusCode, 200);
      const groupId = r.json().id;
      r = await post("/api/admin/groups", body);
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /登録済み/);
      for (const enabled of [false, true]) {
        assert.equal(
          (await post(`/api/admin/groups/${groupId}`, { enabled })).statusCode,
          200,
        );
        assert.equal(
          (
            await pool.query("SELECT enabled FROM groups WHERE id=$1", [
              groupId,
            ])
          ).rows[0].enabled,
          enabled,
        );
      }
      assert.equal(
        (await post(`/api/admin/groups/${suffix}`, { enabled: false }))
          .statusCode,
        404,
      );
      assert.equal(
        (await post(`/api/admin/groups/${groupId}`, { enabled: "yes" }))
          .statusCode,
        400,
      );
      for (const url of [
        "https://evil.test/event/foo",
        "http://ticketdive.com/event/foo",
        "https://ticketdive.com/artist/foo",
        "https://ticketdive.com/event/foo?token=bar",
        "https://u:p@ticketdive.com/event/foo",
      ])
        assert.equal(
          (await post("/api/admin/official-sources", { url })).statusCode,
          400,
          url,
        );
      const officialUrl = `https://ticketdive.com/event/route-${suffix}`;
      for (let i = 0; i < 2; i++)
        assert.equal(
          (await post("/api/admin/official-sources", { url: officialUrl }))
            .statusCode,
          200,
        );
      assert.equal(
        (
          await pool.query("SELECT * FROM official_sources WHERE url=$1", [
            officialUrl,
          ])
        ).rowCount,
        1,
      );
      for (const path of ["reviews", "evidence"]) {
        assert.equal(
          (
            await post(`/api/admin/${path}/${suffix}`, {
              decision: "confirmed",
              note: "          ",
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await post(`/api/admin/${path}/${suffix}`, {
              decision: "confirmed",
              note: "存在しない公式情報への確認操作",
            })
          ).statusCode,
          404,
        );
      }
      const original = process.env.ADMIN_TOKEN;
      delete process.env.ADMIN_TOKEN;
      assert.equal((await app.inject("/api/admin/summary")).statusCode, 503);
      process.env.ADMIN_TOKEN = original;
      const limited = await app.inject({
        method: "POST",
        url: "/api/admin/groups",
        headers: { ...headers, "content-type": "application/json" },
        payload: JSON.stringify({ name: "x".repeat(70000) }),
      });
      assert.equal(limited.statusCode, 413);
      await pool.query(
        "UPDATE official_sources SET enabled=false WHERE url=$1",
        [officialUrl],
      );
      // The proxy's immediate client address determines the limiter key,
      // not an attacker-supplied address at the left of the forwarding chain.
      for (let i = 0; i < 125; i++)
        await app.inject({
          url: "/api/groups",
          headers: { "x-forwarded-for": "192.0.2.210" },
        });
      assert.equal(
        (
          await app.inject({
            url: "/api/groups",
            headers: { "x-forwarded-for": "192.0.2.211, 192.0.2.210" },
          })
        ).statusCode,
        429,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/groups",
            headers: { "x-forwarded-for": "192.0.2.211" },
          })
        ).statusCode,
        200,
      );
      for (let i = 0; i < 125; i++)
        await app.inject({ url: "/api/groups", remoteAddress: "192.0.2.123" });
      assert.equal(
        (await app.inject({ url: "/api/groups", remoteAddress: "192.0.2.123" }))
          .statusCode,
        429,
      );
      assert.equal(
        (await app.inject({ url: "/api/groups", remoteAddress: "192.0.2.124" }))
          .statusCode,
        200,
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
