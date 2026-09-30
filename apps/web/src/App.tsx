import { useEffect, useState, lazy, Suspense } from "react";
const Charts = lazy(() =>
  import("./Charts.js").then((module) => ({ default: module.Charts })),
);

import { Comparison } from "./Comparison.js";
import type { Group, EventIndex, Detail } from "./types.js";

const money = (value: number | null | undefined) =>
  value == null ? "—" : `¥${Number(value).toLocaleString("ja-JP")}`;
const date = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "未観測";
const status = (value: string | null) =>
  ({
    complete: "取得完了",
    partial: "部分取得",
    failed: "取得失敗",
    running: "取得中",
    missing: "欠測",
  })[value ?? ""] ?? "未観測";
async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`データを取得できませんでした（${response.status}）`);
  return response.json();
}

export function App() {
  const [operational, setOperational] = useState<{
    alerts: { key: string; message: string }[];
    workerAlive: boolean;
  } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    const update = () =>
      get<{ alerts: { key: string; message: string }[]; workerAlive: boolean }>(
        "/api/status",
        c.signal,
      )
        .then(setOperational)
        .catch(() => {});
    void update();
    const timer = setInterval(() => void update(), 60000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, []);
  const [groups, setGroups] = useState<Group[]>([]),
    [group, setGroup] = useState(""),
    [query, setQuery] = useState(""),
    [purpose, setPurpose] = useState("");
  const [index, setIndex] = useState<EventIndex | null>(null),
    [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("event") ?? "",
  );
  const [type, setType] = useState(""),
    [prefix, setPrefix] = useState(""),
    [lower, setLower] = useState(""),
    [upper, setUpper] = useState(""),
    [days, setDays] = useState("30"),
    [axis, setAxis] = useState("date"),
    [officialType, setOfficialType] = useState(""),
    [saleWindow, setSaleWindow] = useState("");
  const [error, setError] = useState(""),
    [detailError, setDetailError] = useState(""),
    [detailLoading, setDetailLoading] = useState(false),
    [refresh, setRefresh] = useState(0),
    [tab, setTab] = useState("listings");
  const [snapshot, setSnapshot] = useState("");
  const [eventScope, setEventScope] = useState("upcoming");
  const [showComparison, setShowComparison] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    get<{ groups: Group[] }>("/api/groups", c.signal)
      .then((r) => setGroups(r.groups))
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, []);
  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(() => {
      setError("");
      const p = new URLSearchParams({ q: query, scope: eventScope });
      if (group) p.set("group", group);
      get<EventIndex>(`/api/events?${p}`, c.signal)
        .then(setIndex)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [group, query, refresh, eventScope]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const c = new AbortController();
    setDetail((previous) =>
      previous?.event.id === selected ? previous : null,
    );
    setDetailError("");
    setDetailLoading(true);
    const p = new URLSearchParams({ days });
    for (const [k, v] of Object.entries({
      type,
      prefix,
      lower,
      upper,
      officialType,
      snapshot,
    }))
      if (v) p.set(k, v);
    const timer = setTimeout(() => {
      get<Detail>(`/api/events/${selected}?${p}`, c.signal)
        .then(setDetail)
        .catch((e) => {
          if (e.name !== "AbortError") setDetailError(e.message);
        })
        .finally(() => {
          if (!c.signal.aborted) setDetailLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [
    selected,
    type,
    prefix,
    lower,
    upper,
    days,
    refresh,
    officialType,
    snapshot,
  ]);
  useEffect(() => {
    const fn = () =>
      choose(new URLSearchParams(location.search).get("event") ?? "", false);
    addEventListener("popstate", fn);
    return () => removeEventListener("popstate", fn);
  }, []);
  function choose(id: string, pushHistory = true) {
    setSelected(id);
    setDetail((previous) => (previous?.event.id === id ? previous : null));
    setType("");
    setPrefix("");
    setLower("");
    setUpper("");
    setOfficialType("");
    setSaleWindow("");
    setAxis("date");
    const url = new URL(location.href);
    id ? url.searchParams.set("event", id) : url.searchParams.delete("event");
    if (pushHistory) history.pushState({}, "", url);
    setTab("listings");
    setSnapshot("");
  }
  const visibleEvents =
    index?.events.filter(
      (e) =>
        (eventScope === "past"
          ? new Date(e.starts_at).getTime() < Date.now()
          : new Date(e.starts_at).getTime() >= Date.now()) &&
        (!purpose ||
          e.purpose === purpose ||
          e.price_groups?.some((g) => g.purpose === purpose)),
    ) ?? [];
  const eventFamilies = new Map<string, typeof visibleEvents>();
  for (const event of visibleEvents)
    eventFamilies.set(event.title, [
      ...(eventFamilies.get(event.title) ?? []),
      event,
    ]);
  const selectedOfficial = detail?.official.find((o) => o.id === officialType);
  const selectedSale =
    selectedOfficial?.sale_windows?.find((w) => w.id === saleWindow) ??
    selectedOfficial?.sale_windows?.[0];
  const saved = detail?.timeline
    .filter((p) => ["complete", "partial"].includes(p.status))
    .at(-1);
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
          <span className="brand-icon">▥</span> Ticket Observatory
        </a>
        <span className="topbar-caption">HEROINES / MARKET RESEARCH</span>
        <button className="refresh" onClick={() => setRefresh((v) => v + 1)}>
          データを再読込
        </button>
      </header>
      <main className={selected ? "has-event" : ""}>
        <div className="intro">
          <div>
            <span className="eyebrow">ヒロインズ チケット観測室</span>
            <h1>公演から、チケットを探す。</h1>
            <p>
              公演・日時を選び、前物販・特典会・ライブなどの券種別に出品を確認できます。
            </p>
          </div>
          <div className="scope">
            <strong>
              {index?.scope.monitored ?? "—"}
              <small> 公演を観測中</small>
            </strong>
            <span>
              発見した候補 {index?.scope.candidates ?? "—"} 件 /
              対象は一部の公演
            </span>
            <span>
              観測開始 {date(index?.scope.observation_started_at)} JST
            </span>
          </div>
        </div>
        {index?.scope.source_blocked && (
          <div role="alert" className="notice danger">
            取得元のアクセス制限により収集を停止しています。表示データは過去の観測です。
          </div>
        )}
        {operational &&
          (!operational.workerAlive || operational.alerts.length > 0) && (
            <div className="notice danger" role="alert">
              <strong>観測の運用通知</strong>
              {!operational.workerAlive && (
                <p>収集ワーカーから2分以上応答がありません。</p>
              )}
              {operational.alerts.map((a) => (
                <p key={a.key}>{a.message}</p>
              ))}
              <a href="/admin">管理画面で確認</a>
            </div>
          )}
        <div className={`workspace ${selected ? "" : "browse"}`}>
          <aside className="events-panel">
            <div className="section-heading">
              <h2>1. 公演を選ぶ</h2>
              <span>{eventFamilies.size}公演</span>
            </div>
            <label>
              公演の期間
              <select
                value={eventScope}
                onChange={(e) => setEventScope(e.target.value)}
              >
                <option value="upcoming">開催予定の公演</option>
                <option value="past">過去の公演</option>
              </select>
            </label>
            <label>
              グループ
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">すべての対象グループ</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              公演名
              <input
                placeholder="公演を検索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="purpose-filter">
              チケットの用途
              <select
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              >
                <option value="">すべての用途</option>
                {[
                  "前物販",
                  "特典会",
                  "ライブ",
                  "用途未確認",
                  "用途複合・要確認",
                ].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            {error ? (
              <div role="alert" className="notice danger">
                {error}
              </div>
            ) : !index ? (
              <p className="loading">公演を読み込み中…</p>
            ) : !visibleEvents.length ? (
              <div className="empty small">該当する公演はありません。</div>
            ) : (
              <div className="event-list">
                {[...eventFamilies].map(([title, events]) => (
                  <article className="event-family" key={title}>
                    <h3>{title}</h3>
                    <p className="muted">{events.length}枠 · 日時・部を選択</p>
                    {events.map((e) => (
                      <button
                        key={e.id}
                        className={`event-card ${selected === e.id ? "selected" : ""}`}
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
                        <div className="event-bottom">
                          <span>{e.listing_count ?? "—"}件の出品</span>
                          <span className="tag">{status(e.latest_status)}</span>
                        </div>
                      </button>
                    ))}
                  </article>
                ))}
              </div>
            )}
            <button
              className="refresh compare-button"
              onClick={() => {
                choose("");
                setShowComparison((v) => !v);
              }}
            >
              公演・券種を比較
            </button>
            <p className="aside-note">
              同じ公演を複数のグループから発見しても、重複して集計しません。
            </p>
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
              <>
                {showComparison && (
                  <Comparison
                    group={group}
                    purpose={purpose}
                    choose={choose}
                    refreshVersion={refresh}
                  />
                )}
                <div className="welcome panel">
                  <span className="eyebrow">START EXPLORING</span>
                  <h2>気になる公演を選んでください</h2>
                  <p>
                    価格の分布や整理番号ごとの違いを、実際に観測した出品から確認できます。
                  </p>
                  <div className="welcome-lines">
                    <span>01　公演と日時・部を選ぶ</span>
                    <span>02　チケットの種類を選ぶ</span>
                    <span>03　販売中の出品、過去の観測を見る</span>
                  </div>
                  <p className="muted">
                    履歴は観測開始後から蓄積されます。掲載終了は成約を意味しません。
                  </p>
                </div>
              </>
            ) : detailError && !detail ? (
              <div role="alert" className="notice danger">
                {detailError}
                <button onClick={() => setRefresh((v) => v + 1)}>再試行</button>
              </div>
            ) : !detail ? (
              <div className="panel loading">観測データを読み込み中…</div>
            ) : (
              <>
                {detailError && (
                  <div role="alert" className="notice danger">
                    {detailError}
                    。条件を修正してください。直前の集計を表示しています。
                  </div>
                )}
                <div className="detail-heading">
                  <div>
                    <span className="eyebrow">SELECT TICKET TYPE</span>
                    <span className="ticket-purpose">
                      {detail.event.purpose}
                    </span>
                    <h2>
                      {detail.event.session_label &&
                      detail.event.session_label !== detail.event.venue
                        ? detail.event.session_label
                        : detail.event.title}
                    </h2>
                    {detail.event.session_label && <p>{detail.event.title}</p>}
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
                {detailLoading && (
                  <p className="notice" role="status">
                    条件を更新しています。完了まで直前の集計を表示します。
                  </p>
                )}
                <div className="freshness">
                  <span
                    className={`tag ${detail.latestStatus === "complete" ? "" : "caution"}`}
                  >
                    {status(detail.latestStatus)}
                  </span>
                  <span>最終観測 {date(saved?.time)} JST</span>
                  <span>直近 {days} 日</span>
                </div>
                {detail.latestStatus !== "complete" && (
                  <div className="notice">
                    {detail.latestStatus === "partial"
                      ? "一部の出品や件数を確認できていません。この観測では掲載終了を判定していません。"
                      : ["failed", "missing"].includes(detail.latestStatus)
                        ? "予定された観測を取得できていません。保存済みの観測を表示しています。"
                        : "まだ観測が完了していません。"}
                  </div>
                )}
                {detail.truncated && (
                  <div className="notice danger">
                    表示上限に達しました。期間を短くして確認してください。
                  </div>
                )}
                <section className="panel cohort-panel">
                  <h3>2. チケットの種類を選ぶ</h3>
                  <p className="muted">
                    定価や用途の異なる券種は分けて表示します。記載から判断できない出品は「券種・部の対応未確認」に残します。
                  </p>
                  <div className="ticket-types">
                    {[
                      ...detail.official
                        .filter((o) => o.review_status === "confirmed")
                        .map((o) => ({
                          id: o.id,
                          name: o.name,
                          face: o.face_value_yen,
                          count: detail.priceGroups
                            .filter((g) => g.official_type_id === o.id)
                            .reduce((n, g) => n + g.listing_count, 0),
                          purpose: o.purpose,
                        })),
                      {
                        id: "unknown",
                        name: "券種・部の対応未確認",
                        face: null,
                        purpose: "記載を個別に確認",
                        count: detail.priceGroups
                          .filter((g) => !g.official_type_id)
                          .reduce((n, g) => n + g.listing_count, 0),
                      },
                    ].map((t) => (
                      <button
                        key={t.id}
                        className={`ticket-type ${officialType === t.id ? "selected" : ""}`}
                        aria-pressed={officialType === t.id}
                        onClick={() => {
                          setOfficialType(t.id);
                          setType("");
                          setPrefix("");
                          setLower("");
                          setUpper("");
                          setSaleWindow("");
                          setAxis("date");
                          setTab("listings");
                        }}
                      >
                        <span className="ticket-purpose">{t.purpose}</span>
                        <strong>{t.name}</strong>
                        <span>
                          定価 {money(t.face)} / {t.count}件
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
                {officialType ? (
                  <>
                    <section className="panel history-controls">
                      <h3>
                        3.{" "}
                        {detail.view === "history"
                          ? "過去の出品を見る"
                          : "販売中の出品を見る"}
                      </h3>
                      <label>
                        表示する観測
                        <select
                          aria-label="表示する観測"
                          value={snapshot}
                          onChange={(e) => setSnapshot(e.target.value)}
                        >
                          <option value="">
                            {new Date(detail.event.starts_at).getTime() <
                            Date.now()
                              ? "最新の保存済み観測"
                              : "販売中（最新の観測）"}
                          </option>
                          {detail.snapshots.map((r) => (
                            <option key={r.id} value={r.id}>
                              {date(r.observed_at)} JST · {status(r.status)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="muted">
                        {detail.view === "history"
                          ? "選択した日時に掲載されていた出品です。現在の販売状況とは異なります。"
                          : "最新観測時点で販売中だった出品です。現在の在庫はチケジャムで確認してください。"}{" "}
                        観測日時: {date(detail.selectedSnapshot?.observed_at)}{" "}
                        JST
                      </p>
                      {snapshot &&
                        detail.selectedSnapshot?.status === "partial" && (
                          <p className="notice">
                            この日時は部分取得です。出品の全件を確認できていません。
                          </p>
                        )}
                      <p className="muted">
                        履歴は保存済みの観測から選べます。掲載終了は成約を意味しません。
                      </p>
                    </section>
                    <div className="filterbar">
                      <label>
                        券種
                        <select
                          value={type}
                          onChange={(e) => setType(e.target.value)}
                        >
                          <option value="">すべて / 不明を含む</option>
                          {detail.types.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        番号の接頭辞
                        <input
                          placeholder="A / B / S"
                          value={prefix}
                          maxLength={3}
                          onChange={(e) =>
                            setPrefix(e.target.value.toUpperCase())
                          }
                        />
                      </label>
                      <label>
                        番号の下限
                        <input
                          type="number"
                          min="1"
                          value={lower}
                          onChange={(e) => setLower(e.target.value)}
                          placeholder="1"
                        />
                      </label>
                      <label>
                        上限
                        <input
                          type="number"
                          min="1"
                          value={upper}
                          onChange={(e) => setUpper(e.target.value)}
                          placeholder="100"
                        />
                      </label>
                      <label>
                        比較する公式券種
                        <select
                          value={officialType}
                          onChange={(e) => {
                            setOfficialType(e.target.value);
                            setSaleWindow("");
                            setAxis("date");
                          }}
                        >
                          <option value="">券種を選択（混合集計なし）</option>
                          <option value="unknown">券種・部の対応未確認</option>
                          {detail.official
                            .filter((o) => o.review_status === "confirmed")
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name} / 定価 {money(o.face_value_yen)}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        期間
                        <select
                          value={days}
                          onChange={(e) => setDays(e.target.value)}
                        >
                          <option value="7">7日</option>
                          <option value="30">30日</option>
                          <option value="90">90日</option>
                          <option value="365">1年</option>
                        </select>
                      </label>
                    </div>
                    {tab === "analysis" && (
                      <div className="metrics">
                        <div>
                          <span>出品価格の中央値</span>
                          <strong>{money(detail.summary.medianPrice)}</strong>
                          <small>
                            {detail.priceComparable
                              ? "選択した同一券種のみ / 1枚あたり"
                              : "公式券種を選択してください"}
                          </small>
                        </div>
                        <div>
                          <span>最安値</span>
                          <strong>{money(detail.summary.minPrice)}</strong>
                          <small>
                            {detail.priceComparable
                              ? `定価 ${money(selectedOfficial?.face_value_yen)} / 手数料別`
                              : "異なる券種は混ぜません"}
                          </small>
                        </div>
                        <div>
                          <span>出品件数</span>
                          <strong>
                            {detail.summary.listingCount ?? "—"}
                            <small> 件</small>
                          </strong>
                          <small>選択条件の最新観測</small>
                        </div>
                        <div>
                          <span>チケット枚数</span>
                          <strong>
                            {detail.summary.ticketCount ?? "—"}
                            <small> 枚</small>
                          </strong>
                          <small>出品件数とは別に集計</small>
                        </div>
                      </div>
                    )}
                    <nav className="tabs" aria-label="分析表示">
                      <button
                        className={tab === "analysis" ? "active" : ""}
                        onClick={() => setTab("analysis")}
                      >
                        グラフ
                      </button>
                      <button
                        className={tab === "listings" ? "active" : ""}
                        onClick={() => setTab("listings")}
                      >
                        出品一覧
                      </button>
                      <button
                        className={tab === "quality" ? "active" : ""}
                        onClick={() => setTab("quality")}
                      >
                        取得状況・公式情報
                      </button>
                    </nav>
                    {tab === "analysis" && (
                      <>
                        <div className="graph-controls">
                          <label>
                            時間軸
                            <select
                              value={axis}
                              onChange={(e) => setAxis(e.target.value)}
                            >
                              <option value="date">観測日時</option>
                              <option value="remaining">
                                公演までの残り時間
                              </option>
                              <option
                                value="release"
                                disabled={!selectedSale?.starts_at}
                              >
                                公式発売からの経過時間
                              </option>
                            </select>
                          </label>
                          {selectedOfficial && (
                            <label>
                              比較する販売期間
                              <select
                                value={selectedSale?.id ?? ""}
                                onChange={(e) => {
                                  setSaleWindow(e.target.value);
                                  if (
                                    !selectedOfficial.sale_windows?.find(
                                      (w) => w.id === e.target.value,
                                    )?.starts_at
                                  )
                                    setAxis("date");
                                }}
                              >
                                {selectedOfficial.sale_windows?.map((w) => (
                                  <option key={w.id} value={w.id}>
                                    {w.name} / {date(w.starts_at)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <span>金額は成約価格ではなく出品価格です。</span>
                        </div>
                        <Suspense
                          fallback={
                            <div className="loading">グラフを読み込み中…</div>
                          }
                        >
                          {detailLoading ? (
                            <div className="loading">
                              条件に合うグラフを読み込み中…
                            </div>
                          ) : !detail.priceComparable ? (
                            <p className="notice">
                              上の表から同じ用途・部・公式券種を選択すると価格グラフを表示します。定価や対応が不明な出品の価格は集計しません。
                            </p>
                          ) : (
                            <Charts
                              data={detail}
                              axis={axis}
                              releasedAt={selectedSale?.starts_at ?? null}
                              faceValue={
                                selectedSale?.face_value_yen ??
                                selectedOfficial?.face_value_yen ??
                                null
                              }
                            />
                          )}
                        </Suspense>
                        <div className="changes panel">
                          <h3>掲載状況の変化</h3>
                          <div>
                            <span>
                              値下げ{" "}
                              <b>
                                {
                                  detail.changes.filter(
                                    (c) => c.kind === "price_drop",
                                  ).length
                                }{" "}
                                件
                              </b>
                            </span>
                            <span>
                              掲載終了・理由不明{" "}
                              <b>
                                {
                                  detail.changes.filter(
                                    (c) => c.kind === "ended_unknown",
                                  ).length
                                }{" "}
                                件
                              </b>
                            </span>
                            <span>
                              成約確認 <b>公開情報から未確認</b>
                            </span>
                          </div>
                          <p>
                            掲載終了や枚数の減少だけでは、売れたと判断しません。成約時刻・価格の分析は、明示的に確認できる情報に限定します。
                          </p>
                        </div>
                      </>
                    )}
                    {tab === "listings" && (
                      <section className="panel">
                        <h3>
                          {detail.view === "history"
                            ? "選択日時の出品"
                            : "販売中の出品（最新観測）"}{" "}
                          <small>{detail.listings.length} 件</small>
                        </h3>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>整理番号・席種の記載</th>
                                <th>単価</th>
                                <th>枚数</th>
                                <th>初回観測</th>
                                <th>出典</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.listings.map((l) => (
                                <tr key={l.id}>
                                  <td>
                                    {l.admission_raw || "記載なし"}
                                    <small className="cell-note">
                                      {l.ticket_type ?? "券種未分類"}
                                    </small>
                                  </td>
                                  <td>{money(l.price_yen)}</td>
                                  <td>{l.quantity}</td>
                                  <td>{date(l.first_observed_at)}</td>
                                  <td>
                                    <a
                                      target="_blank"
                                      rel="noreferrer"
                                      href={l.url}
                                    >
                                      出品を見る
                                    </a>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {!detail.listings.length && (
                          <div className="empty small">
                            この条件の観測データはありません。
                          </div>
                        )}
                        <p className="muted">
                          初回観測日時は出品日時ではありません。番号帯の絞り込みは、記載された範囲との重なりで判定します。
                        </p>
                      </section>
                    )}
                    {tab === "quality" && (
                      <>
                        <section className="panel">
                          <h3>公式の販売情報</h3>
                          {!detail.official.length ? (
                            <p className="muted">
                              公式ページとの対応づけは確認中です。定価・手数料・ドリンク代・発売日時は不明として扱い、推測で補いません。
                            </p>
                          ) : (
                            detail.official.map((o) => (
                              <div key={o.id} className="official">
                                <h4>{o.name}</h4>
                                <p>
                                  定価 {money(o.face_value_yen)} / 手数料{" "}
                                  {money(o.fee_yen)} / ドリンク代{" "}
                                  {money(o.drink_yen)}
                                </p>
                                <p>
                                  {o.sale_windows
                                    ?.map(
                                      (w) => `${w.name} ${date(w.starts_at)}`,
                                    )
                                    .join(" · ")}
                                </p>
                                <a
                                  href={o.source_url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  公式販売ページ
                                </a>
                                <span> 確認 {date(o.checked_at)}</span>
                              </div>
                            ))
                          )}
                        </section>
                        <section className="panel">
                          <h3>観測の記録</h3>
                          <p>
                            <a
                              href={`https://web.archive.org/web/*/${detail.event.source_url}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Internet Archiveの保存ページを確認 ↗
                            </a>
                          </p>
                          <p className="muted">
                            保存されている場合は、観測開始前のページも確認できます。アーカイブの内容はこのサイトの出品履歴にはまだ取り込んでいません。
                          </p>
                          <div className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>予定日時</th>
                                  <th>実観測</th>
                                  <th>状態</th>
                                  <th>取得した出品</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.timeline
                                  .slice()
                                  .reverse()
                                  .map((t) => (
                                    <tr key={t.runId}>
                                      <td>{date(t.scheduledAt)}</td>
                                      <td>{date(t.time)}</td>
                                      <td>{status(t.status)}</td>
                                      <td>{t.listingCount ?? "—"}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="muted">
                            取得漏れは0件として埋めません。部分取得の時間帯は、公演全体の相場を表していない場合があります。
                          </p>
                        </section>
                      </>
                    )}
                  </>
                ) : (
                  <div className="empty panel">
                    チケットの種類を選ぶと、出品一覧を表示します。
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        <footer>
          <strong>Ticket Observatory</strong>
          <span>
            非公式の観測・分析サイト。チケットの売買や価格変更は行いません。
          </span>
          <span>時刻は日本時間 / 集計は観測した公開情報に基づきます。</span>
        </footer>
      </main>
    </>
  );
}
