import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCoverage,
  discoverEvents,
  parseEventPage,
  eventId,
} from "../packages/sources/ticketjam/parser.js";

const url = "https://ticketjam.jp/tickets/test/event/123";
function fixture(count = 1, extra = "") {
  return `<h1>リセールチケット一覧</h1><script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "Test Live", startDate: "2026-10-01T18:00:00+09:00", location: { name: "Test Hall" }, offers: { url } })}</script>
  <a class="active">出品中（${count}）</a>
  <ul class="eventlist"><li class="eventlist__item active"><a class="eventlist__wrap" href="/ticket/live_domestic/456">
  <div class="eventlist__title"><span class="align-middle">Test Live</span></div>
  <div class="venue">2026/10/01(木) 18:00 東京 Test Hall</div>
  <p class="description"><span class="font-weight-bold">一般券 A12</span>成約しました（出品者の自由文）</p>
  <div class="eventlist__price"><ul><li><span class="font-weight-bold">3,000</span><small>円/枚</small><span class="ml-1 bold">2 枚</span></li></ul></div></a></li></ul>${extra}`;
}
test("extract actual unit price and quantity without treating prose as sold evidence", () => {
  const page = parseEventPage(fixture(), url);
  assert.equal(page.listings[0]!.priceYen, 3000);
  assert.equal(page.listings[0]!.quantity, 2);
  assert.equal(page.listings[0]!.state, "listed");
  assert.equal(page.listings[0]!.confirmedSalePriceYen, null);
  assert.equal(assessCoverage([page]).complete, true);
});
test("inconsistent totals, malformed cards and truncated pagination are not complete", () => {
  assert.equal(
    assessCoverage([parseEventPage(fixture(2), url)]).complete,
    false,
  );
  assert.equal(
    assessCoverage([
      parseEventPage(fixture().replace("円/枚", "円/セット"), url),
    ]).complete,
    false,
  );
  assert.equal(
    assessCoverage([
      parseEventPage(
        fixture(2, '<a rel="next" href="?page=2">次へ</a>').replace(
          'href="?page=2"',
          'href="/tickets/test/event/123?page=2"',
        ),
        url,
      ),
    ]).complete,
    false,
  );
  assert.throws(() => parseEventPage("<html>ログイン</html>", url));
  assert.throws(() =>
    parseEventPage(
      fixture(
        1,
        '<a rel="next" href="https://evil.test/tickets/test/event/123?page=2">次へ</a>',
      ),
      url,
    ),
  );
});
test("reject requests and filtered pages and deduplicate events across groups by ID", () => {
  assert.throws(() => eventId(url + "?requested=true"));
  assert.throws(() => eventId("https://evil.test/tickets/test/event/123"));
  const html =
    '<h1>リセールチケット一覧</h1><a href="/tickets/a/event/123">a</a><a href="/tickets/b/event/123">b</a><a href="/tickets/b/event/123?requested=true">request</a>';
  assert.equal(discoverEvents(html).length, 1);
});

test("select the requested session among multiple Event records and reject other session rows", () => {
  const unrelated = `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "Other", startDate: "2026-10-01T15:00:00+09:00", location: { name: "Other Hall" }, offers: { url: "https://ticketjam.jp/tickets/test/event/999" } })}</script>`;
  assert.equal(
    parseEventPage(unrelated + fixture(), url).event.externalId,
    "123",
  );
  const wrongTime = parseEventPage(
    fixture().replace("18:00 東京", "15:00 東京"),
    url,
  );
  assert.equal(wrongTime.listings.length, 0);
  assert.equal(assessCoverage([wrongTime]).complete, false);
});
