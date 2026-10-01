import { useState } from "react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ErrorBar,
  ReferenceLine,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import type { Detail } from "./types.js";
import {
  sellingPoints,
  conditionBands,
} from "../../../packages/analytics/selling.js";
const yen = (v: number) => `¥${v.toLocaleString("ja-JP")}`;
const elapsed = (hours: number) => {
  const minutes = Math.round(hours * 60);
  const days = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return `${days ? `${days}日` : ""}${h || !days ? `${h}時間` : ""}${m ? `${m}分` : ""}`;
};
const stateName = (s: string) =>
  s === "sold_confirmed"
    ? "購入済み確認"
    : s === "listed"
      ? "掲載中"
      : "終了・理由不明";
export function SellingCharts({
  data,
  releasedAt,
  faceValue,
}: {
  data: Detail;
  releasedAt: string | null;
  faceValue: number | null;
}) {
  const [show, setShow] = useState("all");
  const rows = sellingPoints(data.outcomes, releasedAt);
  const visible = rows.filter(
    (r) => show === "all" || r.state === "sold_confirmed",
  );
  const numberRows = visible.filter((r) => r.number !== null);
  const timeRows = visible.filter(
    (r) => r.state === "sold_confirmed" && r.hours !== null,
  );
  const timeDomain: [number, number] = timeRows.length
    ? [Math.floor(Math.min(...timeRows.map(r => r.lowerHours!)) / 24) * 24,
       Math.max(24, Math.ceil(Math.max(...timeRows.map(r => r.upperHours!)) / 24) * 24)]
    : [0, 24];
  const reference = faceValue !== null ? (
    <ReferenceLine y={faceValue} stroke="#b34f27" strokeWidth={2} strokeDasharray="6 4"
      ifOverflow="extendDomain" label={{ value: `定価 ${yen(faceValue)}`, position: "insideTopRight", fill: "#943d1b", fontSize: 12 }} />
  ) : null;
  const groups = [
    { state: "sold_confirmed", name: "購入済み確認", color: "#176f59" },
    { state: "listed", name: "掲載中", color: "#8aa4c2" },
    { state: "ended_unknown", name: "終了・理由不明", color: "#a9987e" },
  ];
  const purchased = rows.filter((r) => r.state === "sold_confirmed");
  const actual = purchased.filter((r) => r.confirmed_sale_price_yen !== null);
  const purchasedTimes = purchased.filter((r) => r.lowerHours !== null);
  const purchasedNumbers = purchased.filter((r) => r.admission_lower !== null);
  const tooltip = ({ payload }: any) =>
    payload?.[0] ? (
      <div className="tooltip">
        {payload[0].payload.admission_raw}
        <br />
        {stateName(payload[0].payload.state)}
        <br />
        {payload[0].payload.priceKind}: {yen(payload[0].payload.price)}
        {payload[0].payload.hours !== null && (
          <>
            <br />
            基準発売から {elapsed(payload[0].payload.lowerHours)}〜
            {elapsed(payload[0].payload.upperHours)}
          </>
        )}
      </div>
    ) : null;
  return (
    <section className="selling-analysis">
      <h3>3. 売れたチケットの条件を見る</h3>
      <div className="metrics">
        <div>
          <span>購入済みを確認</span>
          <strong>
            {purchased.length}
            <small> 件</small>
          </strong>
        </div>
        <div>
          <span>成約価格まで確認</span>
          <strong>
            {actual.length}
            <small> 件</small>
          </strong>
        </div>
        <div>
          <span>掲載中</span>
          <strong>
            {rows.filter((r) => r.state === "listed").length}
            <small> 件</small>
          </strong>
        </div>
        <div>
          <span>終了・理由不明</span>
          <strong>
            {rows.filter((r) => r.state === "ended_unknown").length}
            <small> 件</small>
          </strong>
        </div>
      </div>
      {purchased.length > 0 && (
        <section className="panel purchase-summary">
          <h3>購入済みが確認された条件</h3>
          <ul>
            <li>
              最後の出品価格：
              {yen(Math.min(...purchased.map((r) => r.asking_price_yen)))}〜
              {yen(Math.max(...purchased.map((r) => r.asking_price_yen)))}（
              {purchased.length}件・実売額は未確認を含む）
            </li>
            <li>
              整理番号：
              {purchasedNumbers.length
                ? `${Math.min(...purchasedNumbers.map((r) => r.admission_lower!))}〜${Math.max(...purchasedNumbers.map((r) => r.admission_upper!))}番の範囲内`
                : "解析できる番号なし"}
              （{purchasedNumbers.length}件）
            </li>
            <li>
              基準発売から：
              {purchasedTimes.length
                ? `${Math.min(...purchasedTimes.map((r) => r.lowerHours!)).toFixed(1)}〜${Math.max(...purchasedTimes.map((r) => r.upperHours!)).toFixed(1)}時間の区間内`
                : "計算できる区間なし"}
              （{purchasedTimes.length}件）
            </li>
          </ul>
          <p className="muted">
            この条件なら必ず売れる、という予測ではありません。下のグラフで掲載中のチケットと見比べてください。
          </p>
        </section>
      )}
      <p className="notice">
        緑は元ページで購入済みと確認した出品です。成約価格が非公開の場合は、最後に確認した出品価格を表示します。点の価格で売れたと断定するものではありません。
      </p>
      {!purchased.length && (
        <p className="empty small">
          この券種では購入済みの確認データがまだありません。蓄積されると番号・価格・時間の傾向を表示します。
        </p>
      )}
      <p className="face-value-key">{faceValue !== null ? `破線：定価 ${yen(faceValue)}（手数料別）` : "この券種は定価未確認のため、基準線を表示できません。"}</p>
      <label className="graph-controls">
        散布図の比較対象
        <select value={show} onChange={(e) => setShow(e.target.value)}>
          <option value="all">購入済み・掲載中・理由不明を比較</option>
          <option value="sold">購入済みのみ</option>
        </select>
      </label>
      <div className="chart-grid">
        <section className="panel chart-panel">
          <h3>整理番号 × 価格</h3>
          <p className="muted">どの番号が、どの価格帯で購入済みになったか</p>
          {numberRows.length ? (
            <div className="chart">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 24, right: 20, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="#e6e9e1" />
                  <XAxis type="number" dataKey="number" name="整理番号の下限" />
                  <YAxis
                    type="number"
                    dataKey="price"
                    name="価格"
                    width={72}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => `${v.toLocaleString("ja-JP")}円`}
                  />
                  {reference}
                  <Tooltip content={tooltip} />
                  <Legend />
                  {groups.map((g) => (
                    <Scatter
                      key={g.state}
                      name={g.name}
                      data={numberRows.filter((r) => r.state === g.state)}
                      fill={g.color}
                    />
                  ))}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty small">
              比較できる整理番号がまだありません。
            </div>
          )}
          <p className="chart-note">
            {numberRows.length}件表示 / 番号不明{" "}
            {visible.length - numberRows.length}
            件。範囲記載は下限の位置に置き、詳細に原文を表示します。
          </p>
        </section>
        <section className="panel chart-panel">
          <h3>購入済みになった時期と価格</h3>
          <p className="muted">
            発売から何日後に購入済みが確認されたか。下の一覧で番号と価格を確認できます。
          </p>
          {timeRows.length ? (
            <div className="chart">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 24, right: 20, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="#e6e9e1" />
                  <XAxis
                    type="number"
                    dataKey="hours"
                    domain={timeDomain}
                    tickFormatter={(value: number) => elapsed(value)}
                    tick={{ fontSize: 11 }}
                    tickCount={3}
                    minTickGap={24}
                    name="基準発売からの時間"
                  />
                  <YAxis
                    type="number"
                    dataKey="price"
                    width={72}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => `${v.toLocaleString("ja-JP")}円`}
                  />
                  {reference}
                  <Tooltip content={tooltip} />
                  <Legend />
                  {groups
                    .filter((g) => g.state === "sold_confirmed")
                    .map((g) => (
                      <Scatter
                        key={g.state}
                        name={g.name}
                        data={timeRows.filter((r) => r.state === g.state)}
                        fill={g.color}
                      >
                        <ErrorBar
                          dataKey="uncertainty"
                          direction="x"
                          width={4}
                          stroke="#176f59"
                          strokeWidth={2}
                        />
                      </Scatter>
                    ))}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty small">
              {releasedAt
                ? "この発売日時からの確認区間を計算できるデータがまだありません。"
                : "公式の発売日時が未確認のため、経過時間を計算できません。"}
            </div>
          )}
          <p className="chart-note">
            {timeRows.length}
            件表示。横線の左端は最後に掲載されていた時点、右端は購入済みを確認した時点です。点は区間の中央で、購入時刻ではありません。実際の購入時刻・出品から売れるまでの時間ではありません。発売前の区間・時刻不明は除外します。
          </p>
          {timeRows.length > 0 && (
            <ol className="purchase-details" aria-label="購入済みチケットの番号・価格・確認区間">
              {[...timeRows].sort((a, b) => a.upperHours! - b.upperHours!).map(r => (
                <li key={r.id}>
                  <div><strong>{r.admission_raw || "整理番号不明"}</strong><strong>{yen(r.price)}</strong></div>
                  <p>発売から {elapsed(r.lowerHours!)}〜{elapsed(r.upperHours!)}</p>
                  <small>{r.priceKind}{faceValue !== null ? ` · 定価比 ${r.price >= faceValue ? "+" : "−"}${yen(Math.abs(r.price - faceValue))}` : ""}</small>
                </li>
              ))}
            </ol>
          )}
        </section>
        {(["number", "price"] as const).map((by) => {
          const bands = conditionBands(rows, by);
          return (
            <section className="panel chart-panel" key={by}>
              <h3>
                {by === "number" ? "番号帯" : "出品価格帯"}
                ごとの購入済み・掲載中
              </h3>
              {bands.length ? (
                <div className="chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={bands}>
                      <CartesianGrid stroke="#e6e9e1" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      <Bar
                        dataKey="purchased"
                        name="購入済み確認"
                        stackId="state"
                        fill="#176f59"
                      />
                      <Bar
                        dataKey="listed"
                        name="掲載中"
                        stackId="state"
                        fill="#8aa4c2"
                      />
                      <Bar
                        dataKey="unknown"
                        name="終了・理由不明"
                        stackId="state"
                        fill="#a9987e"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="empty small">
                  比較できるデータがありません。
                </div>
              )}
              <p className="chart-note">
                同じ出品は1件として集計。
                {by === "number"
                  ? "番号不明・複数帯にまたがる範囲は除外。"
                  : "最後に確認した出品価格で分類。"}
                観測開始・掲載期間が異なるため、購入済みの割合を売れる確率とは扱いません。
              </p>
            </section>
          );
        })}
      </div>
      <p className="muted">
        {rows.length}
        出品を比較。件数が少ない条件から売れやすさを断定しません。部分取得・取得間隔により確認の遅れや漏れがあります。
      </p>
    </section>
  );
}
