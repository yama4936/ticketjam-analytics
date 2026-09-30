import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  ZAxis,
  ErrorBar,
} from "recharts";
import { durationPoints } from "../../../packages/analytics/durations.js";
import type { Detail } from "./types.js";

const yen = (v: unknown) =>
  typeof v === "number" ? `¥${v.toLocaleString("ja-JP")}` : "—";
export function Charts({
  data,
  axis,
  releasedAt,
  faceValue,
}: {
  data: Detail;
  axis: string;
  releasedAt: string | null;
  faceValue: number | null;
}) {
  const timeAxis = axis === "release" && !releasedAt ? "date" : axis;
  const start = new Date(data.event.starts_at).getTime();
  const points = data.timeline
    .map((p) => ({
      ...p,
      x:
        timeAxis === "remaining"
          ? (start - new Date(p.time).getTime()) / 3600000
          : timeAxis === "release" && releasedAt
            ? (new Date(p.time).getTime() - Date.parse(releasedAt)) / 3600000
            : new Date(p.time).getTime(),
      ratio:
        faceValue && p.medianPrice !== null ? p.medianPrice / faceValue : null,
    }))
    .sort((a, b) => a.x - b.x);
  const tick = (x: number) =>
    timeAxis !== "date"
      ? `${Math.round(x)}h`
      : new Date(x).toLocaleString("ja-JP", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          timeZone: "Asia/Tokyo",
        });
  const summary = data.listings
    .filter((o) => o.state === "listed" && o.admission_lower !== null)
    .map((o) => ({
      number: o.admission_lower!,
      price: o.price_yen,
      label: o.admission_raw,
    }));
  const stored = data.timeline.filter((p) =>
    ["complete", "partial"].includes(p.status),
  );
  const meta = `保存観測 ${stored.length} 回 / 欠測・失敗 ${data.timeline.filter((p) => ["missing", "failed"].includes(p.status)).length} 回 / 部分取得 ${stored.filter((p) => p.status === "partial").length} 回 · 最終 ${stored.at(-1) ? new Date(stored.at(-1)!.time).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未観測"} JST · 成約の明示確認は未対応`;
  return (
    <div className="chart-grid">
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">PRICE HISTORY</span>
            <h3>出品価格の推移</h3>
          </div>
          <span className="legend">中央値 / 最安値</span>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points}>
              <CartesianGrid stroke="#e6e9e1" vertical={false} />
              <XAxis
                dataKey="x"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={tick}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(v) => `${v / 1000}k`}
                width={44}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                labelFormatter={(v) => tick(Number(v))}
                formatter={yen}
              />
              <Line
                dataKey="medianPrice"
                name="中央値"
                type="linear"
                stroke="#184c3e"
                strokeWidth={3}
                dot={{ r: 4 }}
                connectNulls={false}
              />
              <Line
                dataKey="minPrice"
                name="最安値"
                stroke="#b9ae73"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="chart-note">
          観測{" "}
          {
            data.timeline.filter(
              (p) => p.status === "complete" || p.status === "partial",
            ).length
          }{" "}
          回 · 部分取得を含みます。欠測区間は補間しません。
          <br />
          {meta}
        </p>
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">SUPPLY</span>
            <h3>出品件数とチケット枚数</h3>
          </div>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points}>
              <CartesianGrid stroke="#e6e9e1" vertical={false} />
              <XAxis
                dataKey="x"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={tick}
                tick={{ fontSize: 11 }}
              />
              <YAxis allowDecimals={false} width={38} />
              <Tooltip labelFormatter={(v) => tick(Number(v))} />
              <Line
                dataKey="listingCount"
                name="出品件数"
                stroke="#184c3e"
                strokeWidth={2}
                dot
              />
              <Line
                dataKey="ticketCount"
                name="枚数"
                stroke="#b9ae73"
                strokeWidth={2}
                dot
              />
              <Line
                dataKey="newCount"
                name="新規観測出品"
                stroke="#a18b86"
                strokeWidth={1}
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="chart-note">
          新規は初めて観測した出品です。実際の出品時刻ではありません。取得失敗は0件に含めません。
          <br />
          {meta}
        </p>
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">PRICE DISTRIBUTION</span>
            <h3>価格帯ごとの出品件数</h3>
          </div>
          <span className="legend">{data.summary.listingCount} 件</span>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data.histogram.map((b) => ({
                ...b,
                label: `${b.lower / 1000}–${b.upper / 1000}k`,
              }))}
            >
              <CartesianGrid stroke="#e6e9e1" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} width={38} />
              <Tooltip />
              <Bar
                dataKey="count"
                name="出品件数"
                fill="#6f8e78"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="chart-note">
          最新の保存済み観測。価格は1枚あたり・手数料別です。
          <br />
          {meta}
        </p>
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">ADMISSION NUMBER</span>
            <h3>整理番号と出品価格</h3>
          </div>
          <span className="legend">解析可能 {summary.length} 件</span>
        </div>
        {summary.length ? (
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart>
                <CartesianGrid stroke="#e6e9e1" />
                <XAxis type="number" dataKey="number" name="整理番号の下限" />
                <YAxis
                  type="number"
                  dataKey="price"
                  name="単価"
                  tickFormatter={(v) => `${v / 1000}k`}
                  width={44}
                />
                <ZAxis range={[50, 50]} />
                <Tooltip
                  content={({ payload }) =>
                    payload?.[0] ? (
                      <div className="tooltip">
                        {String(payload[0].payload.label)}
                        <br />
                        {yen(payload[0].payload.price)}
                      </div>
                    ) : null
                  }
                />
                <Scatter data={summary} fill="#184c3e" fillOpacity={0.65} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty small">
            この条件では整理番号を解析できた出品がありません。
          </div>
        )}
        <p className="chart-note">
          番号範囲は下限を表示。接頭辞や券種が異なる出品は、絞り込んで比較してください。
          <br />
          {meta}
        </p>
      </section>
      {faceValue !== null && faceValue > 0 && (
        <section className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">FACE VALUE RATIO</span>
              <h3>定価に対する価格倍率</h3>
            </div>
            <span className="legend">定価 {yen(faceValue)}</span>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points}>
                <CartesianGrid stroke="#e6e9e1" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={tick}
                  tick={{ fontSize: 11 }}
                />
                <YAxis unit="倍" width={44} />
                <Tooltip labelFormatter={(v) => tick(Number(v))} />
                <Line
                  dataKey="ratio"
                  name="中央値 / 定価"
                  stroke="#184c3e"
                  strokeWidth={2}
                  dot
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="chart-note">
            公式の券種名または確認済みの番号接頭辞に一致した出品だけを比較しています。
            <br />
            {meta}
          </p>
        </section>
      )}
      {(["ended_unknown", "sold_confirmed"] as const).map((kind) => {
        const rows = durationPoints(data.changes, kind),
          count = data.changes.filter((c) => c.kind === kind).length;
        return (
          <section className="panel chart-panel" key={kind}>
            <div className="panel-heading">
              <h3>
                {kind === "sold_confirmed" ? "成約確認" : "掲載終了・理由不明"}
                までの観測期間
              </h3>
              <span className="legend">
                {rows.length} 件 / 区間不明 {count - rows.length} 件
              </span>
            </div>
            {rows.length ? (
              <>
                <div className="chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart>
                      <CartesianGrid stroke="#e6e9e1" />
                      <XAxis
                        type="number"
                        dataKey="hours"
                        name="初回観測からの時間"
                        unit="h"
                      />
                      <YAxis
                        type="number"
                        dataKey="asking_price_yen"
                        name="最終観測の出品価格"
                        width={48}
                      />
                      <Tooltip
                        content={({ payload }) =>
                          payload?.[0] ? (
                            <div className="tooltip">
                              {payload[0].payload.lowerHours.toFixed(1)}〜
                              {payload[0].payload.upperHours.toFixed(1)} 時間
                              <br />
                              {yen(payload[0].payload.asking_price_yen)}
                              <br />
                              整理番号{" "}
                              {payload[0].payload.admission_prefix ?? ""}
                              {payload[0].payload.admission_lower ?? "不明"}
                            </div>
                          ) : null
                        }
                      />
                      <Scatter data={rows} fill="#6f8e78">
                        <ErrorBar
                          dataKey="uncertainty"
                          direction="x"
                          width={5}
                          stroke="#6f8e78"
                        />
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>確認区間 JST</th>
                        <th>整理番号下限</th>
                        <th>確認成約価格</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            {new Date(r.interval_start!).toLocaleString(
                              "ja-JP",
                              { timeZone: "Asia/Tokyo" },
                            )}
                            〜
                            {new Date(r.interval_end).toLocaleString("ja-JP", {
                              timeZone: "Asia/Tokyo",
                            })}
                          </td>
                          <td>
                            {r.admission_prefix}
                            {r.admission_lower ?? "不明"}
                          </td>
                          <td>{yen(r.confirmed_sale_price_yen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="empty small">
                {kind === "sold_confirmed"
                  ? "明示的な成約情報を取得できていないため、分析できません。"
                  : "この期間に掲載終了を確認した出品はありません。"}
              </div>
            )}
            <p className="chart-note">
              横線は最後の掲載確認から終了確認までの区間です。実際の出品からの販売所要時間ではありません。価格は出品価格で、成約価格を推定しません。
              <br />
              {meta}
            </p>
          </section>
        );
      })}
    </div>
  );
}
