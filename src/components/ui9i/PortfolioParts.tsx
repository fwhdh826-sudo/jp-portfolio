// UI-9I Phase 1: ポートフォリオ表示部品。
// ドーナツ＝構成（何を持っているか）、バー＝目標との差（現在 → 目標）。役割を分ける。
// 行順は projectPortfolio が保持する canonical 順のまま。ここでは並べ替えない。
import type { AssetClass } from '../../types/allocationPlan'
import type { PortfolioClassRow } from '../../presentation/ui9i/portfolioPresentation'
import { currentAmountText, gapText } from '../../presentation/ui9i/portfolioPresentation'
import { StatusDot } from './primitives'

export const ASSET_CLASS_COLOR: Record<AssetClass, string> = {
  JP_STOCK: '#2F6FBF',
  JP_TRUST: '#6FA8DC',
  OVERSEAS_TRUST: '#3E8E63',
  GOLD: '#D3A84C',
  CASH: '#9AAEC2',
  CASH_RESERVE: '#C7D3DF',
}

const EMPTY_RING = '#EDF1F6'

/** conic-gradient 用の構成比。正の currentAmount のみ集計。合計 0 は空リング。 */
export function donutGradient(rows: readonly PortfolioClassRow[]): string {
  const positive = rows.map(r => (Number.isFinite(r.currentAmount) && r.currentAmount > 0 ? r.currentAmount : 0))
  const sum = positive.reduce((a, b) => a + b, 0)
  if (sum <= 0) return `conic-gradient(${EMPTY_RING} 0 100%)`
  let acc = 0
  const stops = rows.map((r, i) => {
    const from = (acc / sum) * 100
    acc += positive[i]
    const to = (acc / sum) * 100
    return `${ASSET_CLASS_COLOR[r.assetClass]} ${from.toFixed(2)}% ${to.toFixed(2)}%`
  })
  return `conic-gradient(${stops.join(', ')})`
}

// gapText は adapter が唯一の生成点（Portfolio 面・投信ハブ・Decision Audit で共有）。
export { gapText }

export function Donut({ rows, centerLabel, centerValue }: {
  rows: readonly PortfolioClassRow[]
  centerLabel: string
  centerValue: string
}) {
  return (
    <div className="u9-donut" style={{ background: donutGradient(rows) }} role="img"
      aria-label={`資産構成 ${rows.map(r => `${r.label} ${currentAmountText(r)}`).join('、')}`}>
      <span className="u9-donut__hole">
        <span>{centerLabel}</span>
        <strong>{centerValue}</strong>
      </span>
    </div>
  )
}

export function Legend({ rows }: { rows: readonly PortfolioClassRow[] }) {
  return (
    <ul className="u9-legend" aria-label="資産構成の凡例">
      {rows.map(r => (
        <li key={r.assetClass}>
          <span className="u9-legend__swatch" style={{ background: ASSET_CLASS_COLOR[r.assetClass] }} aria-hidden="true" />
          <span className="u9-legend__label">{r.label}</span>
          <span className="u9-legend__pct">{r.currentRatioPct === null ? '—' : `${Math.round(r.currentRatioPct)}%`}</span>
        </li>
      ))}
    </ul>
  )
}

function GapBar({ row }: { row: PortfolioClassRow }) {
  const fill = row.currentRatioPct === null ? 0 : Math.max(0, Math.min(100, row.currentRatioPct))
  const target = row.targetRatioPct === null ? null : Math.max(0, Math.min(100, row.targetRatioPct))
  return (
    <div className="u9-bar" aria-hidden="true">
      <div className="u9-bar__fill" style={{ width: `${fill}%`, background: ASSET_CLASS_COLOR[row.assetClass] }} />
      {target !== null && <div className="u9-bar__target" style={{ left: `${target}%` }} />}
    </div>
  )
}

/** rows は渡された順のまま描画する（フィルタのみ呼び出し側で行う）。 */
export function GapList({ rows, bars }: { rows: readonly PortfolioClassRow[]; bars: boolean }) {
  return (
    <ul className="u9-gap-list" aria-label="目標との差">
      {rows.map(r => (
        <li key={r.assetClass} className="u9-gap" data-direction={r.direction}>
          <div className="u9-gap__head">
            <span className="u9-gap__label">{r.label}</span>
            <span className="u9-gap__value">{gapText(r)}</span>
          </div>
          {bars && <GapBar row={r} />}
        </li>
      ))}
    </ul>
  )
}

/** 目標水準のクラスは 1 行にまとめる（モバイル要約用）。方向は adapter の on_target のみ。 */
export function AtTargetLine({ rows, allRowsCount }: { rows: readonly PortfolioClassRow[]; allRowsCount: number }) {
  if (rows.length === 0) return null
  const text = rows.length === allRowsCount
    ? 'すべての資産クラスが目標水準です'
    : `${rows.map(r => r.label).join('・')}は目標水準です`
  return (
    <div className="u9-at-target">
      <StatusDot mark="ok" />
      <span>{text}</span>
    </div>
  )
}
