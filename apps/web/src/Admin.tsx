import { useState } from "react";
interface Review {
  id: string;
  title: string;
  source_url: string | null;
  reason: string;
  details: { sourceVenue: string; eventVenue: string };
  extracted_fields: null | {
    stageName: string;
    startsAt: string;
    tickets: { name: string; price: number; windowName: string }[];
  };
}
interface Summary {
  evidence: (Pick<
    Review,
    "id" | "title" | "source_url" | "extracted_fields"
  > & {
    review_status: string;
    checked_at: string;
    review_note: string | null;
  })[];
  reviews: Review[];
  groups: {
    id: string;
    name: string;
    ticketjam_slug: string;
    enabled: boolean;
  }[];
  sources: { source: string; blocked: boolean; block_reason: string | null }[];
  runs: {
    title: string;
    status: string;
    scheduled_at: string;
    error: string | null;
  }[];
  officialSources: {
    url: string;
    checked_at: string | null;
    last_error: string | null;
  }[];
}
export function Admin() {
  const [token, setToken] = useState(""),
    [data, setData] = useState<Summary | null>(null),
    [error, setError] = useState(""),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [artist, setArtist] = useState(""),
    [officialUrl, setOfficialUrl] = useState("");
  async function request(path: string, body?: unknown) {
    const r = await fetch(`/api/admin/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error ?? "操作に失敗しました");
    return result;
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setData(await request("summary"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review(id: string, decision: "confirmed" | "rejected") {
    setBusy(true);
    setError("");
    try {
      await request(`reviews/${id}`, { decision, note: notes[id] ?? "" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await request(path, body);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-page">
      <a href="/">分析画面へ</a>
      <h1>観測の管理</h1>
      <p className="muted">公式公演との対応づけと、取得の状態を確認します。</p>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void refresh();
        }}
      >
        <label>
          管理キー
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button className="refresh" disabled={busy}>
          管理データを表示
        </button>
      </form>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <section className="panel">
            <h2>公式情報の確認待ち {data.reviews.length}件</h2>
            {data.reviews.map((r) => (
              <article key={r.id} className="official">
                <h3>{r.title}</h3>
                <p>
                  {r.extracted_fields?.stageName ?? r.reason} /{" "}
                  {new Date(r.extracted_fields?.startsAt ?? "").toLocaleString(
                    "ja-JP",
                    { timeZone: "Asia/Tokyo" },
                  )}
                </p>
                <p>
                  公演の会場: {r.details.eventVenue}
                  <br />
                  公式の会場: {r.details.sourceVenue}
                </p>
                <p>
                  {r.extracted_fields?.tickets
                    .map(
                      (t) =>
                        `${t.name} ¥${t.price.toLocaleString()} (${t.windowName})`,
                    )
                    .join(" / ")}
                </p>
                <a href={r.source_url ?? "#"} target="_blank" rel="noreferrer">
                  公式ページを確認
                </a>
                <label>
                  確認の根拠（10文字以上）
                  <input
                    value={notes[r.id] ?? ""}
                    onChange={(e) =>
                      setNotes({ ...notes, [r.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  className="refresh"
                  disabled={
                    busy ||
                    !r.extracted_fields ||
                    (notes[r.id]?.length ?? 0) < 10
                  }
                  onClick={() => void review(r.id, "confirmed")}
                >
                  同じ公演として確認
                </button>{" "}
                <button
                  className="refresh"
                  disabled={
                    busy ||
                    !r.extracted_fields ||
                    (notes[r.id]?.length ?? 0) < 10
                  }
                  onClick={() => void review(r.id, "rejected")}
                >
                  対応づけを却下
                </button>
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>登録済み公式情報の訂正</h2>
            <p className="muted">
              確認済みの対応づけも取り消せます。取り消すと定価比較への利用を止めます。確認履歴と取得した情報は残ります。
            </p>
            {data.evidence.map((r) => (
              <details key={r.id} className="official">
                <summary>
                  {r.title} / {r.extracted_fields?.stageName} —{" "}
                  {
                    {
                      confirmed: "確認済み",
                      pending: "確認待ち",
                      rejected: "却下済み",
                    }[r.review_status]
                  }
                </summary>
                <p>
                  取得日時{" "}
                  {new Date(r.checked_at).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })}{" "}
                  JST
                </p>
                <p>
                  {r.extracted_fields?.tickets
                    .map(
                      (t) =>
                        `${t.name} ¥${t.price.toLocaleString()} (${t.windowName})`,
                    )
                    .join(" / ")}
                </p>
                <a href={r.source_url ?? "#"} target="_blank" rel="noreferrer">
                  公式ページ
                </a>
                {r.review_note && <p>前回の根拠: {r.review_note}</p>}
                <label>
                  訂正・再確認の根拠（10文字以上）
                  <input
                    value={notes[r.id] ?? ""}
                    onChange={(e) =>
                      setNotes({ ...notes, [r.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  className="refresh"
                  disabled={busy || (notes[r.id]?.length ?? 0) < 10}
                  onClick={() =>
                    void mutate(`evidence/${r.id}`, {
                      decision:
                        r.review_status === "confirmed"
                          ? "rejected"
                          : "confirmed",
                      note: notes[r.id],
                    })
                  }
                >
                  {r.review_status === "confirmed"
                    ? "対応づけを取り消す"
                    : "根拠に基づき確認する"}
                </button>
              </details>
            ))}
          </section>
          <section className="panel">
            <h2>取得元の状態</h2>
            {data.sources.map((s) => (
              <p key={s.source}>
                {s.source}: {s.blocked ? "停止中" : "取得可能"} {s.block_reason}
              </p>
            ))}
          </section>
          <section className="panel">
            <h2>収集の記録</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>公演</th>
                    <th>予定日時</th>
                    <th>状態</th>
                    <th>エラー</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r, i) => (
                    <tr key={i}>
                      <td>{r.title}</td>
                      <td>
                        {new Date(r.scheduled_at).toLocaleString("ja-JP", {
                          timeZone: "Asia/Tokyo",
                        })}
                      </td>
                      <td>{r.status}</td>
                      <td>{r.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>対象グループ</h2>
            {data.groups.map((g) => (
              <p key={g.id}>
                {g.name} ({g.ticketjam_slug}){" "}
                <button
                  className="refresh"
                  disabled={busy}
                  onClick={() =>
                    void mutate(`groups/${g.id}`, { enabled: !g.enabled })
                  }
                >
                  {g.enabled ? "収集を停止" : "収集を再開"}
                </button>
              </p>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate("groups", {
                  name,
                  ticketjamSlug: slug,
                  ...(artist ? { officialArtistSlug: artist } : {}),
                });
              }}
            >
              <div className="form-grid">
                <label>
                  グループ名
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  チケジャムURLの /tickets/ 以降
                  <input
                    required
                    pattern="[a-z0-9-]+"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                  />
                </label>
                <label>
                  TicketDiveのアーティストID（任意）
                  <input
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                  />
                </label>
              </div>
              <button className="refresh" disabled={busy}>
                グループを追加
              </button>
              <p className="muted">
                新しい公演は次回の毎時収集から発見します。観測公演の上限はサーバー設定に従います。
              </p>
            </form>
          </section>
          <section className="panel">
            <h2>公式ページの取得</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate("official-sources", { url: officialUrl });
              }}
            >
              <label>
                TicketDiveの公式イベントURL
                <input
                  type="url"
                  required
                  value={officialUrl}
                  onChange={(e) => setOfficialUrl(e.target.value)}
                  placeholder="https://ticketdive.com/event/…"
                />
              </label>
              <button className="refresh" disabled={busy}>
                公式ページを追加
              </button>
            </form>
            {data.officialSources.map((s) => (
              <p key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.url}
                </a>{" "}
                {s.last_error ?? (s.checked_at ? "取得済み" : "取得待ち")}
              </p>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
