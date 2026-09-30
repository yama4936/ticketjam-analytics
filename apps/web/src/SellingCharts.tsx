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
const stateName = (s: string) =>
  s === "sold_confirmed"
    ? "購入済み確認"
    : s === "listed"
      ? "掲載中"
      : "終了・理由不明";
export function SellingCharts({
  data,
  releasedAt,
}: {
  data: Detail;
  releasedAt: string | null;
}) {
  const [show, setShow] = useState("all");
  const rows = sellingPoints(data.outcomes, releasedAt);
  const visible = rows.filter(
    (r) => show === "all" || r.state === "sold_confirmed",
  );
  const numberRows = visible.filter((r) => r.number !== null);
  const timeRows = visible.filter(
    (r) => r.state !== "listed" && r.hours !== null,
  );
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
            基準発売から {payload[0].payload.lowerHours.toFixed(1)}〜
            {payload[0].payload.upperHours.toFixed(1)}時間
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
                <ScatterChart>
                  <CartesianGrid stroke="#e6e9e1" />
                  <XAxis type="number" dataKey="number" name="整理番号の下限" />
                  <YAxis
                    type="number"
                    dataKey="price"
                    name="価格"
                    width={60}
                    tickFormatter={(v) => `${v / 1000}千円`}
                  />
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
          <h3>発売からの時間 × 価格</h3>
          <p className="muted">
            どの価格帯が、発売から何時間後に購入済みになったか
          </p>
          {timeRows.length ? (
            <div className="chart">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart>
                  <CartesianGrid stroke="#e6e9e1" />
                  <XAxis
                    type="number"
                    dataKey="hours"
                    domain={["dataMin", "dataMax"]}
                    name="基準発売からの時間"
                    unit="h"
                  />
                  <YAxis
                    type="number"
                    dataKey="price"
                    width={60}
                    tickFormatter={(v) => `${v / 1000}千円`}
                  />
                  <Tooltip content={tooltip} />
                  <Legend />
                  {groups
                    .filter((g) => g.state !== "listed")
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
                          width={5}
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
            件表示。横線は最後の掲載確認〜購入済み確認の区間です。実際の購入時刻・出品から売れるまでの時間ではありません。発売前の区間・時刻不明は除外します。
          </p>
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
