import { useEffect, useState } from "react";
import type { Comparison as ComparisonData } from "./types.js";
export function Comparison({
  group,
  choose,
}: {
  group: string;
  choose: (id: string) => void;
}) {
  const [by, setBy] = useState("event"),
    [data, setData] = useState<ComparisonData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    const p = new URLSearchParams({ by });
    if (group) p.set("group", group);
    fetch(`/api/comparison?${p}`, { signal: c.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("比較データを取得できませんでした");
        setData(await r.json());
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [group, by]);
  const money = (v: number | null) =>
    v === null ? "—" : `¥${v.toLocaleString("ja-JP")}`;
  return (
    <section className="panel">
      <span className="eyebrow">COMPARE OBSERVATIONS</span>
      <h2>公演・券種を比較</h2>
      <label>
        比較単位
        <select value={by} onChange={(e) => setBy(e.target.value)}>
          <option value="event">公演ごと</option>
          <option value="type">公演と券種</option>
          <option value="prefix">公演と番号の接頭辞</option>
        </select>
      </label>
      <p className="muted">
        左のグループ選択で絞り込めます。同一公演は重複計上しません。観測日時や公演までの日数、券種の条件を確認して比較してください。
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>比較データを読み込み中…</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>公演 / グループ</th>
                  <th>区分</th>
                  <th>中央値 / 最安値</th>
                  <th>出品 / 枚数</th>
                  <th>観測時点の残日数</th>
                  <th>観測日時 JST / 状態</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.event_id}:${r.segment}`}>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => choose(r.event_id)}
                      >
                        {r.title}
                      </button>
                      <small className="cell-note">
                        {r.groups?.join(" / ") ?? "グループ不明"}
                      </small>
                    </td>
                    <td>{r.segment}</td>
                    <td>
                      {money(r.median_price_yen)}
                      <br />
                      {money(r.min_price_yen)}
                    </td>
                    <td>
                      {r.listing_count} 件 / {r.ticket_count} 枚
                    </td>
                    <td>
                      {(
                        (Date.parse(r.starts_at) - Date.parse(r.observed_at)) /
                        86400000
                      ).toFixed(1)}{" "}
                      日
                    </td>
                    <td>
                      {new Date(r.observed_at).toLocaleString("ja-JP", {
                        timeZone: "Asia/Tokyo",
                      })}
                      <br />
                      {r.status === "complete" ? "取得完了" : "部分取得"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.rows.length && (
            <p className="empty">比較できる観測がありません。</p>
          )}
          {data.truncated && (
            <p className="notice">
              比較の表示上限です。グループで絞り込んでください。
            </p>
          )}
        </>
      )}
      <p className="chart-note">
        各行は最新保存観測の出品価格。成約確認は未対応で、失敗後は以前の観測が残ります。部分取得は公演全体を表さない場合があります。
      </p>
    </section>
  );
}
