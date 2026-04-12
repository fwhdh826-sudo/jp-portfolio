import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatDateTime, formatJPYAuto, formatPrice } from '../../utils/format'
import { buildZeroBasePlan } from '../../domain/optimization/zeroBase'
import { buildTrustPortfolioPlan } from '../../domain/optimization/trustPortfolio'
import {
  getTrustShortFilterTuning,
  getTrustShortRecentEntries,
  getTrustShortTrackingStats,
} from '../../domain/learning/trustShortTracker'

function resolveReferencePrice(price?: number, target?: number, alert?: number) {
  if (price && price > 0) return price
  if (target && target > 0) return target
  if (alert && alert > 0) return alert
  return null
}

function resolveBuyEntry(currentPrice: number, alert: number) {
  const pullback = Math.round(currentPrice * 0.985)
  if (alert > 0) return Math.max(Math.round(alert * 1.03), pullback)
  return pullback
}

function resolveSellEntry(currentPrice: number, target: number, alert: number) {
  const defensive = Math.round(currentPrice * 0.99)
  if (alert > 0) return Math.min(defensive, Math.round(alert * 1.01))
  if (target > 0) return Math.min(defensive, Math.round(target * 0.94))
  return defensive
}

function actionBadge(action: 'BUY' | 'SELL' | 'WAIT') {
  if (action === 'BUY') return 'buy'
  if (action === 'SELL') return 'sell'
  return 'wait'
}

export function T5_Backtest() {
  const analysis = useAppStore(s => s.analysis)
  const holdings = useAppStore(s => s.holdings)
  const trust = useAppStore(s => s.trust)
  const market = useAppStore(s => s.market)
  const macro = useAppStore(s => s.macro)
  const news = useAppStore(s => s.news)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const metrics = useAppStore(s => s.metrics)
  const universe = useAppStore(s => s.universe)
  const cash = useAppStore(s => s.cash)
  const cashReserve = useAppStore(s => s.cashReserve)
  const addRoom = useAppStore(s => s.addRoom)
  const system = useAppStore(s => s.system)

  const [budget, setBudget] = useState(1_000_000)

  const zeroPlan = useMemo(
    () =>
      buildZeroBasePlan({
        holdings,
        trust,
        analysis,
        market,
        macro,
        sqCalendar,
        metrics,
        universe,
        cash,
        cashReserve,
        addRoom,
      }),
    [
      holdings,
      trust,
      analysis,
      market,
      macro,
      sqCalendar,
      metrics,
      universe,
      cash,
      cashReserve,
      addRoom,
    ],
  )

  const trackingStats = useMemo(() => getTrustShortTrackingStats(), [])
  const trustPlan = useMemo(
    () =>
      buildTrustPortfolioPlan({
        trust,
        market,
        macro,
        news,
        sqCalendar,
        margin: null,
        flows: null,
        performance30d: trackingStats,
      }),
    [macro, market, news, sqCalendar, trackingStats, trust],
  )
  const shortEntries = useMemo(() => getTrustShortRecentEntries(90).slice(0, 8), [])
  const shortTuning = useMemo(() => getTrustShortFilterTuning(90), [])

  const proposalRows = useMemo(
    () =>
      zeroPlan.proposals.slice(0, 12).map(proposal => {
        const holding = holdings.find(item => item.code === proposal.code)
        const currentPrice = resolveReferencePrice(
          holding?.currentPrice,
          holding?.target,
          holding?.alert,
        )
        const buyEntry = currentPrice && holding
          ? resolveBuyEntry(currentPrice, holding.alert)
          : null
        const sellEntry = currentPrice && holding
          ? resolveSellEntry(currentPrice, holding.target, holding.alert)
          : null

        return {
          ...proposal,
          currentPrice,
          buyEntry,
          sellEntry,
          analysis: analysis.find(item => item.code === proposal.code),
        }
      }),
    [analysis, holdings, zeroPlan.proposals],
  )

  const kellyItems = holdings
    .map(holding => {
      const kelly = (holding.mu - 0.005) / (holding.sigma * holding.sigma)
      const halfKelly = Math.min(0.30, Math.max(0, kelly * 0.5))
      return { code: holding.code, name: holding.name, halfKelly }
    })
    .filter(item => item.halfKelly > 0)
    .sort((left, right) => right.halfKelly - left.halfKelly)
    .slice(0, 8)

  return (
    <div className="tab-panel planning-page">
      <section className="decision-grid">
        <article className="card">
          <div className="section-kicker">Execution planner</div>
          <h2 className="section-heading">今日の執行計画（価格つき）</h2>
          <div className="summary-grid" style={{ marginTop: 14 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">提案件数</div>
              <div className="summary-tile__value">{zeroPlan.proposals.length}</div>
            </div>
            <div className="summary-tile summary-tile--positive">
              <div className="summary-tile__label">BUY</div>
              <div className="summary-tile__value">
                {zeroPlan.proposals.filter(item => item.action === 'BUY').length}
              </div>
            </div>
            <div className="summary-tile summary-tile--negative">
              <div className="summary-tile__label">SELL</div>
              <div className="summary-tile__value">
                {zeroPlan.proposals.filter(item => item.action === 'SELL').length}
              </div>
            </div>
            <div className="summary-tile summary-tile--caution">
              <div className="summary-tile__label">分析更新</div>
              <div className="summary-tile__value" style={{ fontSize: 16 }}>
                {system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行'}
              </div>
            </div>
          </div>
          <div className="metrics-inline">
            <span>市場モード {zeroPlan.board.modeLabel}</span>
            <span>短期投信 {trustPlan.shortTermSignal}</span>
            <span>投信ニュース {trustPlan.newsContext.trustHeadlineCount}件</span>
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Short trust module</div>
          <h2 className="section-heading">高勝率短期モードの補助情報</h2>
          <div className="summary-grid" style={{ marginTop: 14 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">勝率</div>
              <div className="summary-tile__value">{trackingStats.winRate.toFixed(1)}%</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">実行回数</div>
              <div className="summary-tile__value">{trackingStats.executions}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">Bull VIX</div>
              <div className="summary-tile__value">≤ {shortTuning.recommendedBullVixMax.toFixed(1)}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">Bear VIX</div>
              <div className="summary-tile__value">≥ {shortTuning.recommendedBearVixMin.toFixed(1)}</div>
            </div>
          </div>
          <div className="scenario-list" style={{ marginTop: 12 }}>
            {shortEntries.length === 0 ? (
              <div className="empty-state">直近トレースがありません。</div>
            ) : (
              shortEntries.map((entry, index) => (
                <div key={`${entry.date}-${index}`} className="scenario-list__item">
                  <div>
                    <strong>{entry.date.slice(0, 10)} / {entry.decision}</strong>
                    <span>conf {entry.confidence}% / 条件 {entry.conditionsPassed} / VIX {entry.vix.toFixed(1)}</span>
                  </div>
                  <span>{entry.outcome}</span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <article className="card" style={{ marginTop: 16 }}>
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Execution tickets</div>
            <h3 className="section-heading">売買チケット（現在価格 / 買い / 売り）</h3>
          </div>
        </div>

        {proposalRows.length > 0 ? (
          <div className="plan-ticket-table" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>銘柄</th>
                  <th>現在価格</th>
                  <th>買いエントリー</th>
                  <th>売りエントリー</th>
                  <th>推奨金額</th>
                  <th>理由</th>
                </tr>
              </thead>
              <tbody>
                {proposalRows.map(row => (
                  <tr key={row.id}>
                    <td>
                      <span className={`vd ${actionBadge(row.action)}`}>{row.action}</span>
                    </td>
                    <td>
                      <div className="plan-ticket-table__stock">
                        <strong>{row.code}</strong>
                        <span>{row.name}</span>
                      </div>
                    </td>
                    <td>{row.currentPrice ? formatPrice(row.currentPrice) : '—'}</td>
                    <td>{row.buyEntry ? formatPrice(row.buyEntry) : '—'}</td>
                    <td>{row.sellEntry ? formatPrice(row.sellEntry) : '—'}</td>
                    <td>{row.amount > 0 ? formatJPYAuto(row.amount) : '—'}</td>
                    <td>
                      <div className="plan-ticket-table__reason">
                        <span>{row.reason}</span>
                        <small>score {row.score} / rank {row.strategyRank}</small>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state" style={{ marginTop: 12 }}>
            今日の売買チケットはありません。
          </div>
        )}
      </article>

      <article className="card" style={{ marginTop: 16 }}>
        <div className="section-kicker">Half-Kelly</div>
        <h3 className="section-heading">予算別の推奨投下配分</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>予算</span>
          <input
            type="range"
            min="500000"
            max="5000000"
            step="100000"
            value={budget}
            onChange={event => setBudget(Number(event.target.value))}
            style={{ flex: 1 }}
          />
          <strong>{formatJPYAuto(budget)}</strong>
        </div>

        <div className="risk-concentration" style={{ marginTop: 12 }}>
          {kellyItems.length === 0 ? (
            <div className="empty-state">Kelly計算対象の銘柄がありません。</div>
          ) : (
            kellyItems.map(item => (
              <div key={item.code} className="risk-concentration__row">
                <div className="risk-concentration__header">
                  <strong>{item.code} {item.name}</strong>
                  <span>{(item.halfKelly * 100).toFixed(1)}%</span>
                </div>
                <div className="risk-concentration__meta">
                  <span>推奨投下 {formatJPYAuto(Math.round(budget * item.halfKelly / 1000) * 1000)}</span>
                </div>
                <div className="risk-concentration__bar">
                  <span style={{ width: `${Math.min(100, item.halfKelly / 0.3 * 100)}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </article>
    </div>
  )
}
