import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'
import { formatJPYAuto } from '../../utils/format'
import { JP_STOCK_MAX_VALUE, SELLABLE_CODES } from '../../constants/market'
import { getSellLockRemainingDays, isSellLocked } from '../../domain/constraints/stockLock'

const sectorColors: Record<string, string> = {
  金融: '#7f99ff',
  'HR/テック': '#5cc6b7',
  ゲーム: '#d490ff',
  エネルギー: '#f08d49',
  精密: '#d2b35f',
  医療: '#6dbb7b',
  内需: '#7db1f2',
  重工: '#b7c1d1',
  通信: '#5ea5d8',
}

function getSectorColor(sector: string) {
  return sectorColors[sector] ?? '#6f7c8f'
}

function decisionTone(decision: string, locked: boolean) {
  if (locked) return 'neutral'
  if (decision === 'BUY') return 'positive'
  if (decision === 'SELL') return 'negative'
  return 'neutral'
}

interface StockOptimalRow {
  code: string
  name: string
  currentValue: number
  currentWeight: number
  targetValue: number
  targetWeight: number
  diffValue: number
  decision: 'BUY' | 'HOLD' | 'SELL'
  locked: boolean
}

export function T2_Holdings() {
  const holdings = useAppStore(s => s.holdings)
  const analysis = useAppStore(s => s.analysis)
  const metrics = useAppStore(s => s.metrics)
  const universe = useAppStore(s => s.universe)
  const totalEval = useAppStore(selectTotalEval)

  const [expandedCode, setExpandedCode] = useState<string | null>(null)

  const analysisByCode = useMemo(
    () => new Map(analysis.map(item => [item.code, item])),
    [analysis],
  )

  const sectorEntries = useMemo(() => {
    const grouped = holdings.reduce<Record<string, number>>((acc, holding) => {
      acc[holding.sector] = (acc[holding.sector] || 0) + holding.eval
      return acc
    }, {})

    return Object.entries(grouped)
      .sort((a, b) => b[1] - a[1])
      .map(([sector, value]) => ({
        sector,
        value,
        ratio: totalEval > 0 ? (value / totalEval) * 100 : 0,
      }))
  }, [holdings, totalEval])

  const lockedCount = holdings.filter(holding => isSellLocked(holding)).length
  const sellableCount = holdings.filter(holding => !isSellLocked(holding) && SELLABLE_CODES.has(holding.code)).length
  const mitsuRatio = totalEval > 0
    ? (holdings.filter(holding => holding.mitsu).reduce((sum, holding) => sum + holding.eval, 0) / totalEval) * 100
    : 0

  const positions = useMemo(() => {
    const rank = { SELL: 0, BUY: 1, HOLD: 2 }
    return [...holdings]
      .sort((left, right) => {
        const leftDecision = analysisByCode.get(left.code)?.decision ?? 'HOLD'
        const rightDecision = analysisByCode.get(right.code)?.decision ?? 'HOLD'
        if (rank[leftDecision] !== rank[rightDecision]) {
          return rank[leftDecision] - rank[rightDecision]
        }
        return right.eval - left.eval
      })
  }, [analysisByCode, holdings])

  const allocationDiffs = (universe?.categories ?? [])
    .filter(item => item.class === 'JP_STOCK' || item.class === 'CASH' || item.class === 'CASH_RESERVE' || item.class === 'ADD_ROOM')

  const stockOptimalRows = useMemo<StockOptimalRow[]>(() => {
    const raw = holdings.map(holding => {
      const item = analysisByCode.get(holding.code)
      const locked = isSellLocked(holding)
      const decision = item?.decision ?? 'HOLD'
      const scoreBase = item?.totalScore ?? 50
      const bonus = decision === 'BUY' ? 12 : decision === 'SELL' ? -18 : 0
      const lockPenalty = locked ? -14 : 0
      const concentrationPenalty = holding.mitsu ? -4 : 0
      const volatilityPenalty = Math.round(holding.sigma * 24)
      const weightSeed = Math.max(8, scoreBase + bonus + lockPenalty + concentrationPenalty - volatilityPenalty)
      return {
        holding,
        locked,
        decision,
        weightSeed,
      }
    })

    const totalSeed = raw.reduce((sum, row) => sum + row.weightSeed, 0)
    if (totalSeed <= 0 || totalEval <= 0) return []

    return raw
      .map(row => {
        const targetWeight = row.weightSeed / totalSeed
        const targetValue = totalEval * targetWeight
        const currentWeight = row.holding.eval / totalEval
        return {
          code: row.holding.code,
          name: row.holding.name,
          currentValue: row.holding.eval,
          currentWeight,
          targetValue,
          targetWeight,
          diffValue: targetValue - row.holding.eval,
          decision: row.decision,
          locked: row.locked,
        }
      })
      .sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue))
  }, [analysisByCode, holdings, totalEval])

  const calcInstitutionalScore = (code: string) => {
    const holding = holdings.find(item => item.code === code)
    if (!holding) {
      return { fundamental: 0, technical: 0, risk: 0, flow: 0 }
    }

    return {
      fundamental: Math.round(
        (holding.roe >= 12 ? 8 : holding.roe >= 8 ? 5 : 2) +
        (holding.epsG >= 10 ? 8 : holding.epsG >= 0 ? 5 : 0) +
        (holding.per <= 15 ? 8 : holding.per <= 25 ? 5 : 2) +
        (holding.cfOk ? 6 : 0),
      ),
      technical: Math.round(
        (holding.ma ? 5 : 0) +
        (holding.macd ? 5 : 0) +
        (holding.rsi < 70 && holding.rsi > 30 ? 5 : 2) +
        (holding.mom3m > 0 ? 5 : 0),
      ),
      risk: Math.round(
        (holding.sigma < 0.25 ? 10 : holding.sigma < 0.35 ? 7 : 3) +
        (holding.pnlPct >= 0 ? 10 : holding.pnlPct >= -10 ? 6 : 2),
      ),
      flow: Math.round(
        (holding.vol ? 5 : 0) +
        (holding.mom3m > 5 ? 5 : holding.mom3m > 0 ? 3 : 0),
      ),
    }
  }

  return (
    <div className="tab-panel holdings-page">
      <section className="decision-grid">
        <article className="card">
          <div className="section-kicker">Overview</div>
          <h2 className="section-heading">保有状況の要約</h2>
          <div className="summary-grid">
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">国内株評価額</div>
              <div className="summary-tile__value">{formatJPYAuto(totalEval)}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">銘柄数</div>
              <div className="summary-tile__value">{holdings.length}</div>
            </div>
            <div className={`summary-tile ${mitsuRatio > 35 ? 'summary-tile--negative' : 'summary-tile--caution'}`}>
              <div className="summary-tile__label">三菱比率</div>
              <div className="summary-tile__value">{mitsuRatio.toFixed(1)}%</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">売却可能銘柄</div>
              <div className="summary-tile__value">{sellableCount}</div>
            </div>
          </div>

          {metrics && (
            <div className="metrics-inline">
              <span>期待リターン {(metrics.mu * 100).toFixed(1)}%</span>
              <span>ボラティリティ {(metrics.sigma * 100).toFixed(1)}%</span>
              <span>Sharpe {metrics.sharpe.toFixed(2)}</span>
              <span>最大DD {(metrics.mdd * 100).toFixed(1)}%</span>
            </div>
          )}
        </article>

        <article className="card">
          <div className="section-kicker">Exposure</div>
          <h2 className="section-heading">セクター配分</h2>
          <div className="sector-bar">
            {sectorEntries.map(item => (
              <span
                key={item.sector}
                className="sector-bar__item"
                style={{ width: `${Math.max(item.ratio, 4)}%`, background: getSectorColor(item.sector) }}
              >
                {item.ratio >= 10 ? `${item.sector} ${item.ratio.toFixed(0)}%` : item.sector}
              </span>
            ))}
          </div>
          <div className="sector-legend">
            {sectorEntries.map(item => (
              <div key={item.sector} className="sector-legend__item">
                <span
                  className="sector-legend__dot"
                  style={{ background: getSectorColor(item.sector) }}
                />
                <span>{item.sector}</span>
                <strong>{item.ratio.toFixed(1)}%</strong>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Stock-only optimizer</div>
                <h3 className="section-heading">個別株 最適ポートフォリオ提案</h3>
              </div>
              <div className="section-caption">投信は含めない</div>
            </div>
            <p className="section-copy">
              提案は個別株のみを対象に算出しています。`SELL` 判定でも 3ヶ月ロック中は即売却せず、ロック解除後の候補として扱います。
            </p>

            <div className="tw" style={{ marginTop: 12 }}>
              <table className="dt">
                <thead>
                  <tr>
                    <th>銘柄</th>
                    <th>現在</th>
                    <th>目標</th>
                    <th>差額</th>
                    <th>アクション</th>
                  </tr>
                </thead>
                <tbody>
                  {stockOptimalRows.slice(0, 10).map(row => {
                    const action =
                      row.diffValue > 60_000
                        ? '買い増し候補'
                        : row.diffValue < -60_000
                        ? row.locked
                          ? 'ロック解除後に縮小'
                          : '縮小候補'
                        : '維持'
                    return (
                      <tr key={row.code}>
                        <td>{row.code} {row.name}</td>
                        <td>
                          {formatJPYAuto(row.currentValue)}
                          <div className="d">{(row.currentWeight * 100).toFixed(1)}%</div>
                        </td>
                        <td>
                          {formatJPYAuto(row.targetValue)}
                          <div className="d">{(row.targetWeight * 100).toFixed(1)}%</div>
                        </td>
                        <td className={row.diffValue >= 0 ? 'p' : 'n'}>
                          {row.diffValue >= 0 ? '+' : ''}{formatJPYAuto(row.diffValue)}
                        </td>
                        <td>
                          <span className={`vd ${row.locked ? 'lock' : row.decision === 'BUY' ? 'buy' : row.decision === 'SELL' ? 'sell' : 'hold'}`}>
                            {action}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Allocation drift</div>
                <h3 className="section-heading">個別株運用差分</h3>
              </div>
              <div className="section-caption">
                上限 {formatJPYAuto(JP_STOCK_MAX_VALUE)}
              </div>
            </div>

            <div className="allocation-list">
              {allocationDiffs.map(item => (
                <div key={item.class} className="allocation-list__item">
                  <div className="allocation-list__header">
                    <strong>{item.label}</strong>
                    <span>{item.role}</span>
                  </div>
                  <div className="allocation-list__meta">
                    <span>現在 {(item.currentRatio * 100).toFixed(1)}%</span>
                    <span>目標 {(item.targetRatio * 100).toFixed(1)}%</span>
                    <span>{item.diffValue >= 0 ? '積増' : '削減'} {formatJPYAuto(Math.abs(item.diffValue))}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </div>

        <article className="card">
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">Constraints</div>
              <h3 className="section-heading">運用制約</h3>
            </div>
          </div>

          <div className="constraint-list">
            <div className="constraint-list__item">
              <strong>売却ロック銘柄</strong>
              <span>{lockedCount}件</span>
              <p>購入から3ヶ月以内は売却せず、解除日まで監視を継続します。</p>
            </div>
            <div className="constraint-list__item">
              <strong>国内株上限</strong>
              <span>{totalEval > JP_STOCK_MAX_VALUE ? '超過' : '範囲内'}</span>
              <p>現在 {formatJPYAuto(totalEval)} / 上限 {formatJPYAuto(JP_STOCK_MAX_VALUE)}</p>
            </div>
            <div className="constraint-list__item">
              <strong>集中管理</strong>
              <span>{mitsuRatio.toFixed(1)}%</span>
              <p>三菱グループ比率は35%以内を目安に維持します。</p>
            </div>
          </div>
        </article>
      </section>

      <section className="card">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Position board</div>
            <h3 className="section-heading">保有ポジション</h3>
          </div>
          <div className="section-caption">SELL優先表示</div>
        </div>

        <div className="position-board">
          {positions.map(holding => {
            const item = analysisByCode.get(holding.code)
            const decision = item?.decision ?? 'HOLD'
            const isExpanded = expandedCode === holding.code
            const locked = isSellLocked(holding)
            const lockRemain = getSellLockRemainingDays(holding)
            const tone = decisionTone(decision, locked)
            const weight = totalEval > 0 ? (holding.eval / totalEval) * 100 : 0
            const institutional = calcInstitutionalScore(holding.code)
            const institutionalRows = [
              { label: 'Fundamental', value: institutional.fundamental, max: 30 },
              { label: 'Technical', value: institutional.technical, max: 20 },
              { label: 'Risk', value: institutional.risk, max: 20 },
              { label: 'Flow', value: institutional.flow, max: 10 },
            ]

            return (
              <article key={holding.code} className={`position-card position-card--${tone}`}>
                <button
                  className="position-card__header"
                  onClick={() => setExpandedCode(isExpanded ? null : holding.code)}
                  type="button"
                >
                  <div className="position-card__identity">
                    <span className="position-card__code">{holding.code}</span>
                    <strong>{holding.name}</strong>
                  </div>
                  <div className="position-card__badges">
                    <span className={`vd ${locked ? 'lock' : decision === 'BUY' ? 'buy' : decision === 'SELL' ? 'sell' : 'hold'}`}>
                      {locked ? `LOCK ${lockRemain}d` : decision}
                    </span>
                    <span className="position-card__score">{item?.totalScore ?? '—'}</span>
                  </div>
                </button>

                <div className="position-card__metrics">
                  <div>
                    <span>評価額</span>
                    <strong>{formatJPYAuto(holding.eval)}</strong>
                  </div>
                  <div>
                    <span>損益率</span>
                    <strong>{holding.pnlPct >= 0 ? '+' : ''}{holding.pnlPct.toFixed(2)}%</strong>
                  </div>
                  <div>
                    <span>保有比率</span>
                    <strong>{weight.toFixed(1)}%</strong>
                  </div>
                  <div>
                    <span>年率σ</span>
                    <strong>{(holding.sigma * 100).toFixed(1)}%</strong>
                  </div>
                </div>

                <div className="position-card__footer">
                  <span>{holding.sector}</span>
                  {locked && <span>売却制約 残り{lockRemain}日</span>}
                  <span>ROE {holding.roe.toFixed(1)}%</span>
                  <span>EPS {holding.epsG >= 0 ? '+' : ''}{holding.epsG.toFixed(1)}%</span>
                  <span>RSI {holding.rsi.toFixed(0)}</span>
                </div>

                {isExpanded && (
                  <div className="position-card__details">
                    <div className="detail-grid">
                      <div className="detail-panel">
                        <div className="section-subtitle">判断メモ</div>
                        <div className="detail-list">
                          <span>ファンダ {item?.fundamentalScore ?? '—'} / 30</span>
                          <span>テクニカル {item?.technicalScore ?? '—'} / 20</span>
                          <span>マクロ {item?.marketScore ?? '—'} / 20</span>
                          <span>ニュース {item?.newsScore ?? '—'} / 15</span>
                        </div>
                      </div>

                      <div className="detail-panel">
                        <div className="section-subtitle">機関観点スコア</div>
                        <div className="institution-grid">
                          {institutionalRows.map(row => (
                            <div key={row.label} className="institution-grid__item">
                              <div className="institution-grid__label">
                                <span>{row.label}</span>
                                <strong>{row.value}/{row.max}</strong>
                              </div>
                              <div className="institution-grid__bar">
                                <span style={{ width: `${(row.value / row.max) * 100}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}
