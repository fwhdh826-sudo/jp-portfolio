import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'
import { formatJPYAuto } from '../../utils/format'
import { JP_STOCK_MAX_VALUE } from '../../constants/market'
import {
  getSellLockRemainingDays,
  getSellableDate,
  isSellLocked,
} from '../../domain/constraints/stockLock'
import { buildStockPortfolioPlan } from '../../domain/optimization/stockPortfolio'

type PositionFilter = 'ALL' | 'SELL' | 'BUY' | 'HOLD' | 'LOCK'

function recommendationTone(recommendation: string) {
  if (recommendation === 'BUY') return 'positive'
  if (recommendation === 'SELL') return 'negative'
  if (recommendation === 'WAIT_LOCK') return 'neutral'
  return 'neutral'
}

function positionTone(decision: string, locked: boolean) {
  if (locked) return 'neutral'
  if (decision === 'BUY') return 'positive'
  if (decision === 'SELL') return 'negative'
  return 'neutral'
}

export function T2_Holdings() {
  const holdings = useAppStore(s => s.holdings)
  const analysis = useAppStore(s => s.analysis)
  const metrics = useAppStore(s => s.metrics)
  const universe = useAppStore(s => s.universe)
  const totalEval = useAppStore(selectTotalEval)

  const [expandedCode, setExpandedCode] = useState<string | null>(null)
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('ALL')

  const stockPlan = useMemo(
    () =>
      buildStockPortfolioPlan(holdings, analysis, {
        targetTotalValue: universe?.categories.find(item => item.class === 'JP_STOCK')?.targetValue,
      }),
    [analysis, holdings, universe],
  )

  const analysisByCode = useMemo(
    () => new Map(analysis.map(item => [item.code, item])),
    [analysis],
  )

  const weightedPnl = totalEval > 0
    ? holdings.reduce((sum, item) => sum + item.pnlPct * (item.eval / totalEval), 0)
    : 0

  const mitsuRatio = totalEval > 0
    ? holdings.filter(item => item.mitsu).reduce((sum, item) => sum + item.eval, 0) / totalEval * 100
    : 0

  const highVolCount = holdings.filter(item => item.sigma >= 0.35).length
  const deepLossCount = holdings.filter(item => item.pnlPct <= -12).length

  const lockSchedule = holdings
    .map(holding => {
      const remaining = getSellLockRemainingDays(holding)
      return {
        ...holding,
        remaining,
        locked: isSellLocked(holding),
        sellableAt: getSellableDate(holding),
      }
    })
    .filter(item => item.locked)
    .sort((left, right) => left.remaining - right.remaining)

  const allocationDiffs = (universe?.categories ?? [])
    .filter(item => item.class === 'JP_STOCK' || item.class === 'CASH' || item.class === 'CASH_RESERVE' || item.class === 'ADD_ROOM')

  const positions = useMemo(() => {
    const rank = { SELL: 0, BUY: 1, HOLD: 2 }
    return [...holdings].sort((left, right) => {
      const leftDecision = analysisByCode.get(left.code)?.decision ?? 'HOLD'
      const rightDecision = analysisByCode.get(right.code)?.decision ?? 'HOLD'
      if (rank[leftDecision] !== rank[rightDecision]) {
        return rank[leftDecision] - rank[rightDecision]
      }
      return right.eval - left.eval
    })
  }, [analysisByCode, holdings])

  const filteredPositions = useMemo(() => {
    if (positionFilter === 'ALL') return positions
    if (positionFilter === 'LOCK') return positions.filter(holding => isSellLocked(holding))
    return positions.filter(holding => (analysisByCode.get(holding.code)?.decision ?? 'HOLD') === positionFilter)
  }, [analysisByCode, positionFilter, positions])

  return (
    <div className="tab-panel holdings-page">
      <section className="decision-grid">
        <article className="card">
          <div className="section-kicker">Stock overview</div>
          <h2 className="section-heading">個別株ポートフォリオ要約</h2>
          <div className="summary-grid">
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">評価額</div>
              <div className="summary-tile__value">{formatJPYAuto(totalEval)}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">銘柄数</div>
              <div className="summary-tile__value">{holdings.length}</div>
            </div>
            <div className={`summary-tile ${stockPlan.lockCount > 0 ? 'summary-tile--caution' : 'summary-tile--positive'}`}>
              <div className="summary-tile__label">売却ロック</div>
              <div className="summary-tile__value">{stockPlan.lockCount}件</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">売却可能</div>
              <div className="summary-tile__value">{stockPlan.sellableCount}件</div>
            </div>
          </div>
          <div className="metrics-inline">
            <span>加重損益率 {weightedPnl >= 0 ? '+' : ''}{weightedPnl.toFixed(2)}%</span>
            <span>高ボラ {highVolCount}件</span>
            <span>深い含み損 {deepLossCount}件</span>
            {metrics && <span>Sharpe {metrics.sharpe.toFixed(2)}</span>}
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Constraints</div>
          <h2 className="section-heading">運用制約</h2>
          <div className="constraint-list">
            <div className="constraint-list__item">
              <strong>3ヶ月売却不可</strong>
              <span>{stockPlan.lockCount}件</span>
              <p>ロック中は売却せず、解除予定日を起点に再判定します。</p>
            </div>
            <div className="constraint-list__item">
              <strong>国内個別株上限</strong>
              <span>{totalEval > JP_STOCK_MAX_VALUE ? '超過' : '範囲内'}</span>
              <p>現在 {formatJPYAuto(totalEval)} / 上限 {formatJPYAuto(JP_STOCK_MAX_VALUE)}</p>
            </div>
            <div className="constraint-list__item">
              <strong>三菱系集中</strong>
              <span>{mitsuRatio.toFixed(1)}%</span>
              <p>35%を超える場合は縮小を優先して分散を確保します。</p>
            </div>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Zero-base optimizer</div>
                <h3 className="section-heading">個別株のみ最適ポートフォリオ</h3>
              </div>
              <div className="section-caption">投信は除外</div>
            </div>
            <p className="section-copy">
              現保有に引きずられず、個別株だけで推奨比率を再計算しています。
              売却制約中の銘柄は `ロック解除後に縮小` として扱います。
            </p>

            <div className="recommendation-column" style={{ marginTop: 12 }}>
              {stockPlan.rebalanceTop.map(item => (
                <article key={item.code} className={`recommendation-card recommendation-card--${recommendationTone(item.recommendation)}`}>
                  <div className="recommendation-card__top">
                    <div>
                      <div className="recommendation-card__code">{item.code}</div>
                      <div className="recommendation-card__name">{item.name}</div>
                    </div>
                    <div className="recommendation-card__meta">
                      <span className={`vd ${item.recommendation === 'BUY' ? 'buy' : item.recommendation === 'SELL' ? 'sell' : item.recommendation === 'WAIT_LOCK' ? 'wait' : 'hold'}`}>
                        {item.recommendation}
                      </span>
                      <span className="recommendation-card__score">{item.score}</span>
                    </div>
                  </div>

                  <div className="recommendation-card__metrics">
                    <div>
                      <span>現在比率</span>
                      <strong>{(item.currentWeight * 100).toFixed(1)}%</strong>
                    </div>
                    <div>
                      <span>推奨比率</span>
                      <strong>{(item.targetWeight * 100).toFixed(1)}%</strong>
                    </div>
                    <div>
                      <span>差額</span>
                      <strong className={item.diffValue >= 0 ? 'p' : 'n'}>
                        {item.diffValue >= 0 ? '+' : ''}{formatJPYAuto(item.diffValue)}
                      </strong>
                    </div>
                    <div>
                      <span>保有スタンス</span>
                      <strong>{item.holdingStyle}</strong>
                    </div>
                  </div>

                  <div className="recommendation-card__reasons">
                    <p>{item.reason}</p>
                    {item.locked && (
                      <p>
                        ロック中: 残り {item.lockRemainingDays}日
                        {item.sellableAt ? ` / 売却可能予定日 ${item.sellableAt}` : ''}
                      </p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </article>

          <article className="card">
            <div className="section-kicker">Swap ideas</div>
            <h3 className="section-heading">入替候補（個別株のみ）</h3>
            <div className="scenario-list" style={{ marginTop: 12 }}>
              {stockPlan.swapIdeas.length > 0 ? stockPlan.swapIdeas.map(idea => (
                <div key={`${idea.sellCode}-${idea.buyCode}`} className="scenario-list__item">
                  <div>
                    <strong>{idea.sellName} → {idea.buyName}</strong>
                    <span>{idea.reason}</span>
                  </div>
                  <span className="tone-chip tone-chip--caution">候補</span>
                </div>
              )) : (
                <div className="empty-state">明確な入替候補はまだありません。</div>
              )}
            </div>
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Allocation drift</div>
            <h3 className="section-heading">個別株運用差分</h3>
            <div className="allocation-list" style={{ marginTop: 12 }}>
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

          <article className="card">
            <div className="section-kicker">Lock schedule</div>
            <h3 className="section-heading">ロック解除予定</h3>
            {lockSchedule.length > 0 ? (
              <div className="risk-register" style={{ marginTop: 12 }}>
                {lockSchedule.map(item => (
                  <div key={`lock-${item.code}`} className="risk-register__item risk-register__item--medium">
                    <div className="risk-register__title">
                      <strong>{item.code} {item.name}</strong>
                      <span className="vd lock">LOCK {item.remaining}d</span>
                    </div>
                    <div className="risk-register__meta">
                      <span>評価額 {formatJPYAuto(item.eval)}</span>
                      <span>損益率 {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%</span>
                      <span>売却可能予定 {item.sellableAt ?? '未設定'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ marginTop: 12 }}>ロック中の銘柄はありません。</div>
            )}
          </article>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Position board</div>
            <h3 className="section-heading">保有ポジション詳細</h3>
          </div>
          <div className="section-caption">{filteredPositions.length}件</div>
        </div>

        <div className="log-filter" style={{ marginTop: 12 }}>
          {(['ALL', 'SELL', 'BUY', 'HOLD', 'LOCK'] as PositionFilter[]).map(item => (
            <button
              key={item}
              className={`log-filter__button${positionFilter === item ? ' active' : ''}`}
              onClick={() => setPositionFilter(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>

        <div className="position-board" style={{ marginTop: 12 }}>
          {filteredPositions.map(holding => {
            const item = analysisByCode.get(holding.code)
            const decision = item?.decision ?? 'HOLD'
            const locked = isSellLocked(holding)
            const lockRemain = getSellLockRemainingDays(holding)
            const tone = positionTone(decision, locked)
            const isExpanded = expandedCode === holding.code
            const weight = totalEval > 0 ? (holding.eval / totalEval) * 100 : 0

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
                    <span>σ</span>
                    <strong>{(holding.sigma * 100).toFixed(1)}%</strong>
                  </div>
                </div>

                <div className="position-card__footer">
                  <span>{holding.sector}</span>
                  {locked && <span>売却制約 残り{lockRemain}日</span>}
                  {holding.acquiredAt && <span>取得日 {holding.acquiredAt}</span>}
                  <span>ROE {holding.roe.toFixed(1)}%</span>
                </div>

                {isExpanded && (
                  <div className="position-card__details">
                    <div className="detail-grid">
                      <div className="detail-panel">
                        <div className="section-subtitle">判断軸</div>
                        <div className="detail-list">
                          <span>ファンダ {item?.fundamentalScore ?? '—'} / 30</span>
                          <span>テクニカル {item?.technicalScore ?? '—'} / 20</span>
                          <span>マクロ {item?.marketScore ?? '—'} / 20</span>
                          <span>ニュース {item?.newsScore ?? '—'} / 15</span>
                        </div>
                      </div>
                      <div className="detail-panel">
                        <div className="section-subtitle">継続保有理由</div>
                        <div className="detail-list">
                          {(item?.debate.bullReasons ?? []).slice(0, 2).map(reason => (
                            <span key={reason}>・{reason}</span>
                          ))}
                          {(item?.debate.bearReasons ?? []).slice(0, 1).map(reason => (
                            <span key={reason}>・注意: {reason}</span>
                          ))}
                          {locked && <span>・ロック解除後に売却可否を再判定</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            )
          })}

          {filteredPositions.length === 0 && (
            <div className="empty-state">この条件に一致するポジションはありません。</div>
          )}
        </div>
      </section>
    </div>
  )
}
