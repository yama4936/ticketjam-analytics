import { useEffect, useState, lazy, Suspense } from "react";
import type { EventIndex, Detail } from "./types.js";
const SellingCharts = lazy(() =>
  import("./SellingCharts.js").then((m) => ({ default: m.SellingCharts })),
);
const date = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "未確認";
const money = (v: number | null | undefined) =>
  v == null ? "未確認" : `¥${v.toLocaleString("ja-JP")}`;
async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw Error(`データを取得できませんでした（${r.status}）`);
  return r.json();
}
export function App() {
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("event") ?? "",
  );
  const [index, setIndex] = useState<EventIndex | null>(null),
    [detail, setDetail] = useState<Detail | null>(null);
  const [officialType, setOfficialType] = useState(""),
    [saleWindow, setSaleWindow] = useState(""),
    [days, setDays] = useState("30");
  const [scope, setScope] = useState("upcoming"),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [detailError, setDetailError] = useState(""),
    [loading, setLoading] = useState(false);
  const [operational, setOperational] = useState<{
    workerAlive: boolean;
    alerts: { key: string; message: string }[];
  } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    get<EventIndex>(`/api/events?scope=${scope}`, c.signal)
      .then((r) => {
        setIndex(r);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [scope, refresh]);
  useEffect(() => {
    const c = new AbortController();
    const update = () =>
      get<{ workerAlive: boolean; alerts: { key: string; message: string }[] }>(
        "/api/status",
        c.signal,
      )
        .then(setOperational)
        .catch(() => {});
    void update();
    const t = setInterval(update, 60000);
    return () => {
      c.abort();
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const c = new AbortController();
    setLoading(true);
    setDetailError("");
    const p = new URLSearchParams({ days });
    if (officialType) p.set("officialType", officialType);
    get<Detail>(`/api/events/${selected}?${p}`, c.signal)
      .then(setDetail)
      .catch((e) => {
        if (e.name !== "AbortError") setDetailError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [selected, officialType, days, refresh]);
  function choose(id: string, push = true) {
    setSelected(id);
    setDetail((previous) => (previous?.event.id === id ? previous : null));
    setOfficialType("");
    setSaleWindow("");
    const u = new URL(location.href);
    id ? u.searchParams.set("event", id) : u.searchParams.delete("event");
    if (push) history.pushState({}, "", u);
    window.scrollTo(0, 0);
  }
  useEffect(() => {
    const pop = () =>
      choose(new URLSearchParams(location.search).get("event") ?? "", false);
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const families = new Map<string, NonNullable<EventIndex["events"]>>();
  for (const e of index?.events ?? [])
    families.set(e.title, [...(families.get(e.title) ?? []), e]);
  const ticket = detail?.official.find((t) => t.id === officialType);
  const sale =
    ticket?.sale_windows?.find((s) => s.id === saleWindow) ??
    ticket?.sale_windows?.[0];
  return (
    <>
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            choose("");
          }}
        >
          <span className="brand-icon">▥</span>Ticket Observatory
        </a>
        <span className="topbar-caption">TICKET CONDITIONS</span>
        <button
          className="refresh"
          onClick={() => {
            setLoading(!!selected);
            setRefresh((r) => r + 1);
          }}
        >
          データを再読込
        </button>
      </header>
      <main className={selected ? "has-event" : ""}>
        <div className="intro">
          <div>
            <span className="eyebrow">ヒロインズ チケット観測室</span>
            <h1>どの番号が、いくらで、いつ動いたか。</h1>
            <p>
              公演と券種を選び、購入済み・掲載中のチケットをグラフで比較します。
            </p>
          </div>
        </div>
        {operational &&
          (!operational.workerAlive || operational.alerts.length > 0) && (
            <div className="notice danger" role="alert">
              {!operational.workerAlive && (
                <p>収集ワーカーの応答を確認できません。</p>
              )}
              {operational.alerts.map((a) => (
                <p key={a.key}>{a.message}</p>
              ))}
            </div>
          )}
        <div className={`workspace ${selected ? "" : "browse"}`}>
          <aside className="events-panel">
            <div className="section-heading">
              <h2>1. 公演を選ぶ</h2>
              <span>{families.size}公演</span>
            </div>
            <label>
              公演の期間
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="upcoming">開催予定</option>
                <option value="past">過去の公演</option>
              </select>
            </label>
            {error ? (
              <div role="alert" className="notice danger">
                {error}
              </div>
            ) : !index ? (
              <p>公演を読み込み中…</p>
            ) : (
              <div className="event-list">
                {[...families].map(([title, events]) => (
                  <article className="event-family" key={title}>
                    <h3>{title}</h3>
                    {events.map((e) => (
                      <button
                        className={`event-card ${selected === e.id ? "selected" : ""}`}
                        key={e.id}
                        onClick={() => choose(e.id)}
                        aria-pressed={selected === e.id}
                      >
                        <span className="event-date">
                          {date(e.starts_at)} JST
                        </span>
                        {e.session_label && e.session_label !== e.venue && (
                          <strong>{e.session_label}</strong>
                        )}
                        <span className="venue">{e.venue}</span>
                      </button>
                    ))}
                  </article>
                ))}
              </div>
            )}
            {index && !index.events.length && (
              <p className="empty small">この期間の公演はまだありません。</p>
            )}
          </aside>
          <section className="analysis-area" aria-live="polite">
            {selected && (
              <button
                className="refresh change-event"
                onClick={() => choose("")}
              >
                ← 公演を選び直す
              </button>
            )}
            {!selected ? (
              <div className="welcome panel">
                <h2>公演 → 券種 → 売れる条件を比較</h2>
                <p>
                  整理番号・価格・発売からの経過時間を見比べます。同じ券種の中で、購入済みと掲載中の違いを確認できます。
                </p>
              </div>
            ) : detailError ? (
              <div role="alert" className="notice danger">
                {detailError}
                <button
                  onClick={() => {
                    setLoading(!!selected);
                    setRefresh((r) => r + 1);
                  }}
                >
                  再試行
                </button>
              </div>
            ) : !detail ? (
              <div className="loading panel">データを読み込み中…</div>
            ) : (
              <>
                <div className="detail-heading">
                  <div>
                    <span className="ticket-purpose">
                      {detail.event.purpose}
                    </span>
                    <h2>
                      {detail.event.session_label &&
                      detail.event.session_label !== detail.event.venue
                        ? detail.event.session_label
                        : detail.event.title}
                    </h2>
                    <p>
                      {date(detail.event.starts_at)} JST · {detail.event.venue}
                    </p>
                  </div>
                  <a
                    href={detail.event.source_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    チケジャムで確認 ↗
                  </a>
                </div>
                <section className="panel cohort-panel">
                  <h3>2. チケットの種類を選ぶ</h3>
                  <div className="ticket-types">
                    {detail.official
                      .filter((t) => t.review_status === "confirmed")
                      .map((t) => (
                        <button
                          className={`ticket-type ${officialType === t.id ? "selected" : ""}`}
                          key={t.id}
                          aria-pressed={officialType === t.id}
                          onClick={() => {
                            if (officialType !== t.id) setLoading(true);
                            setOfficialType(t.id);
                            setSaleWindow("");
                          }}
                        >
                          <span className="ticket-purpose">{t.purpose}</span>
                          <strong>{t.name}</strong>
                          <span>定価 {money(t.face_value_yen)}</span>
                        </button>
                      ))}
                  </div>
                  {!detail.official.some(
                    (t) => t.review_status === "confirmed",
                  ) && (
                    <p>
                      公式券種との対応を確認中です。異なる券種を混ぜた分析は行いません。
                    </p>
                  )}
                  <p className="muted">
                    用途・部・券種を分けて比較します。券種の対応未確認{" "}
                    {detail.priceGroups
                      .filter((g) => !g.official_type_id)
                      .reduce((n, g) => n + g.listing_count, 0)}
                    件はグラフに混ぜません。
                  </p>
                </section>
                {!officialType ? (
                  <p className="empty panel">
                    券種を選ぶと、番号・価格・時間のグラフを表示します。
                  </p>
                ) : loading ? (
                  <div className="loading panel" role="status">
                    選択した券種を集計しています…
                  </div>
                ) : (
                  <>
                    <div className="graph-controls">
                      <label>
                        集計期間
                        <select
                          value={days}
                          onChange={(e) => {
                            setLoading(true);
                            setDays(e.target.value);
                          }}
                        >
                          <option value="7">直近7日</option>
                          <option value="30">直近30日</option>
                          <option value="90">直近90日</option>
                          <option value="365">直近1年</option>
                        </select>
                      </label>
                      <label>
                        時間の基準とする発売
                        <select
                          value={sale?.id ?? ""}
                          onChange={(e) => setSaleWindow(e.target.value)}
                          disabled={!ticket?.sale_windows?.length}
                        >
                          {ticket?.sale_windows?.length ? (
                            ticket.sale_windows.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name} · {date(s.starts_at)}
                              </option>
                            ))
                          ) : (
                            <option value="">発売日時未確認</option>
                          )}
                        </select>
                      </label>
                    </div>
                    <p className="muted">
                      選択した公式発売日時からの経過時間です。各出品がその先行・一般販売で購入されたかは未確認です。
                    </p>
                    {detail.outcomesTruncated && (
                      <p className="notice">
                        表示上限に達しました。集計期間を短くしてください。
                      </p>
                    )}
                    <Suspense
                      fallback={<p className="loading">グラフを読み込み中…</p>}
                    >
                      <SellingCharts
                        data={detail}
                        faceValue={ticket?.face_value_yen ?? null}
                        releasedAt={sale?.starts_at ?? null}
                      />
                    </Suspense>
                    <details className="panel evidence-details">
                      <summary>データの根拠・公式情報</summary>
                      <p>
                        最終収集 {date(detail.selectedSnapshot?.observed_at)}{" "}
                        JST。購入済み確認は元の出品URLへのアクセスで表示された明示メッセージが根拠です。取引完了や実際の成約価格まで確認できたことは意味しません。
                      </p>
                      <p>
                        初回観測は出品日時ではありません。掲載終了だけで購入済みとは判定しません。
                      </p>
                      <p>
                        直近{days}日：部分取得{" "}
                        {
                          detail.timeline.filter((t) => t.status === "partial")
                            .length
                        }
                        回 / 欠測・失敗{" "}
                        {
                          detail.timeline.filter((t) =>
                            ["failed", "missing"].includes(t.status),
                          ).length
                        }
                        回
                      </p>
                      {ticket && (
                        <p>
                          <a
                            href={ticket.source_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            公式販売ページ
                          </a>{" "}
                          · 定価 {money(ticket.face_value_yen)} · 手数料{" "}
                          {money(ticket.fee_yen)} · ドリンク代{" "}
                          {money(ticket.drink_yen)}
                        </p>
                      )}
                    </details>
                  </>
                )}
              </>
            )}
          </section>
        </div>
        <footer>
          <strong>Ticket Observatory</strong>
          <span>
            非公式の観測サイト · 時刻は日本時間 ·
            購入済み確認と掲載終了を区別します。
          </span>
        </footer>
      </main>
    </>
  );
}
