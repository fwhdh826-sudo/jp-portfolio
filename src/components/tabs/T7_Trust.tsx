import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectIsLoading } from '../../store/selectors'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
import {
  buildTrustPortfolioPlan,
  type ConditionStatus,
  type TrustSignalAction,
} from '../../domain/optimization/trustPortfolio'
import {
  getTrustShortFilterTuning,
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
  recordTrustShortDecision,
} from '../../domain/learning/trustShortTracker'
import type { Trust } from '../../types'

const POLICY_LABEL: Record<Trust['policy'], string> = {
  JAPAN_SHORTTERM: '日本株投信（超短期）',
  OVERSEAS_LONGTERM: '海外投信（中長期）',
  GOLD: 'ゴールド（分散）',
}

function decisionTone(action: 'BULL' | 'BEAR' | 'WAIT') {
  if (action === 'BULL') return 'positive'
  if (action === 'BEAR') return 'negative'
  return 'caution'
}

function decisionLabel(action: 'BULL' | 'BEAR' | 'WAIT') {
  if (action === 'BULL') return 'ブル推奨'
  if (action === 'BEAR') return 'ベア推奨'
  return '待機推奨'
}

function conditionTone(status: ConditionStatus) {
  if (status === 'pass') return 'positive'
  if (status === 'warn') return 'caution'
  return 'negative'
}

function conditionLabel(status: ConditionStatus) {
  if (status === 'pass') return '達成'
  if (status === 'warn') return '境界'
  return '未達'
}

function actionTone(action: TrustSignalAction) {
  if (action === 'BUY' || action === 'BULL') return 'positive'
  if (action === 'EXIT' || action === 'TRIM' || action === 'BEAR') return 'negative'
  if (action === 'WAIT') return 'caution'
  return 'neutral'
}

function actionLabel(action: TrustSignalAction) {
  if (action === 'BUY') return '買い'
  if (action === 'TRIM') return '縮小'
  if (action === 'EXIT') return '即時売却'
  if (action === 'HOLD') return '維持'
  if (action === 'BULL') return 'ブル推奨'
  if (action === 'BEAR') return 'ベア推奨'
  return '待機'
}

function recommendationBadge(action: TrustSignalAction) {
  if (action === 'BUY' || action === 'BULL') return 'buy'
  if (action === 'TRIM' || action === 'EXIT' || action === 'BEAR') return 'sell'
  if (action === 'WAIT') return 'wait'
  return 'hold'
}

function isShortTermCandidate(item: Trust) {
  return item.policy === 'JAPAN_SHORTTERM'
}

export function T7_Trust() {
  const trust = useAppStore(state => state.trust)
  const market = useAppStore(state => state.market)
  const macro = useAppStore(state => state.macro)
  const sqCalendar = useAppStore(state => state.sqCalendar)
  const margin = useAppStore(state => state.margin)
  const flows = useAppStore(state => state.flows)
  const system = useAppStore(state => state.system)
  const importCsv = useAppStore(state => state.importCsv)
  const refreshAllData = useAppStore(state => state.refreshAllData)
  const isLoading = useAppStore(selectIsLoading)

  const [trackingStats, setTrackingStats] = useState(() => getTrustShortTrackingStats())
  const [todayEntryCount, setTodayEntryCount] = useState(() => getTrustShortTodayExecutionCount())
  const shortTuning = useMemo(() => getTrustShortFilterTuning(90), [trackingStats])

  const trustPlan = useMemo(
    () =>
      buildTrustPortfolioPlan({
        trust,
        market,
        macro,
        sqCalendar,
        margin,
        flows,
        todayEntryCount,
        performance30d: trackingStats,
      }),
    [flows, macro, margin, market, sqCalendar, todayEntryCount, trackingStats, trust],
  )

  useEffect(() => {
    const next = recordTrustShortDecision({
      date: new Date().toISOString(),
      decision: trustPlan.shortTermMode.decision,
      confidence: trustPlan.shortTermMode.confidence,
      executed: false,
      nikkeiChgPct: market.nikkeiChgPct,
      futuresChgPct: trustPlan.marketContext.nikkeiFuturesDirection,
      conditionsPassed: trustPlan.shortTermMode.conditionsPassed,
      vix: trustPlan.marketContext.vix,
      nikkeiVI: trustPlan.marketContext.nikkeiVI,
      volatilitySpread: trustPlan.marketContext.volatilitySpread,
    })

    setTrackingStats(prev => (
      prev.trackedDays === next.trackedDays &&
      prev.executions === next.executions &&
      prev.waitDays === next.waitDays &&
      prev.winRate === next.winRate &&
      prev.postWaitWinRate === next.postWaitWinRate
        ? prev
        : next
    ))
    setTodayEntryCount(getTrustShortTodayExecutionCount())
  }, [
    market.nikkeiChgPct,
    trustPlan.marketContext.nikkeiFuturesDirection,
    trustPlan.shortTermMode.confidence,
    trustPlan.shortTermMode.conditionsPassed,
    trustPlan.shortTermMode.decision,
  ])

  const handleMarkExecuted = () => {
    const next = recordTrustShortDecision({
      date: new Date().toISOString(),
      decision: trustPlan.shortTermMode.candidateDirection,
      confidence: trustPlan.shortTermMode.confidence,
      executed: true,
      nikkeiChgPct: market.nikkeiChgPct,
      futuresChgPct: trustPlan.marketContext.nikkeiFuturesDirection,
      conditionsPassed: trustPlan.shortTermMode.conditionsPassed,
      vix: trustPlan.marketContext.vix,
      nikkeiVI: trustPlan.marketContext.nikkeiVI,
      volatilitySpread: trustPlan.marketContext.volatilitySpread,
    })
    setTrackingStats(next)
    setTodayEntryCount(getTrustShortTodayExecutionCount())
  }

  const totalEval = trust.reduce((sum, item) => sum + item.eval, 0)
  const totalPnl = trust.reduce((sum, item) => sum + (item.eval - item.eval / (1 + item.pnlPct / 100)), 0)
  const weightedCost =
    totalEval > 0 ? trust.reduce((sum, item) => sum + item.cost * item.eval, 0) / totalEval : 0

  const japanShortTermTrust = useMemo(
    () => trust.filter(isShortTermCandidate),
    [trust],
  )

  const longTermTrustGroups = useMemo(
    () =>
      (['OVERSEAS_LONGTERM', 'GOLD'] as const).map(policy => ({
        policy,
        items: trust
          .filter(item => item.policy === policy)
          .sort((left, right) => right.eval - left.eval),
        total: trust
          .filter(item => item.policy === policy)
          .reduce((sum, item) => sum + item.eval, 0),
      })),
    [trust],
  )

  const handleCsvDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importCsv(file)
  }

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className={`card focus-card shortmode-card focus-card--${decisionTone(trustPlan.shortTermSignal)}`}>
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">High-win short mode</div>
              <h2 className="section-heading">高勝率短期モード（日本株投信）</h2>
            </div>
            <button
              className={`status-shell__refresh${isLoading ? ' is-loading' : ''}`}
              onClick={() => {
                void refreshAllData()
              }}
              disabled={isLoading}
              type="button"
            >
              {isLoading ? '更新中...' : 'データ更新'}
            </button>
          </div>

          <p className="focus-card__summary">{trustPlan.shortTermSummary}</p>

          <div className="focus-card__badges">
            <span className={`tone-chip tone-chip--${decisionTone(trustPlan.shortTermSignal)}`}>
              {decisionLabel(trustPlan.shortTermSignal)}
            </span>
            <span className="tone-chip tone-chip--neutral">確信度 {trustPlan.shortTermMode.confidence}%</span>
            <span className="tone-chip tone-chip--neutral">条件一致 {trustPlan.shortTermMode.conditionsPassed}/4</span>
            <span className={`tone-chip tone-chip--${todayEntryCount >= 1 ? 'negative' : 'neutral'}`}>
              1日上限 {todayEntryCount}/1
            </span>
          </div>

          <div className="trust-kpi-grid">
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">日経先物</div>
              <div className="summary-tile__value">
                {trustPlan.marketContext.nikkeiFuturesDirection >= 0 ? '+' : ''}
                {trustPlan.marketContext.nikkeiFuturesDirection.toFixed(2)}%
              </div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">VIX / 日経VI</div>
              <div className="summary-tile__value">
                {trustPlan.marketContext.vix.toFixed(1)} / {trustPlan.marketContext.nikkeiVI.toFixed(1)}
              </div>
            </div>
            <div className={`summary-tile summary-tile--${trustPlan.marketContext.volatilitySpreadChg <= 0 ? 'positive' : 'negative'}`}>
              <div className="summary-tile__label">volatilitySpread</div>
              <div className="summary-tile__value">
                {trustPlan.marketContext.volatilitySpread.toFixed(2)}
                ({trustPlan.marketContext.volatilitySpreadChg >= 0 ? '+' : ''}
                {trustPlan.marketContext.volatilitySpreadChg.toFixed(2)})
              </div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">SQ</div>
              <div className="summary-tile__value">残り {trustPlan.marketContext.sqDays}営業日</div>
            </div>
          </div>

          <div className="shortmode-budget-grid">
            <div className="shortmode-budget-card shortmode-budget-card--core">
              <div className="shortmode-budget-card__label">コア回転枠（上限）</div>
              <div className="shortmode-budget-card__value">{formatJPYAuto(trustPlan.shortTermMode.coreBudget)}</div>
              <div className="shortmode-budget-card__note">
                本日推奨 {formatJPYAuto(trustPlan.shortTermMode.recommendedCoreBudget)}
              </div>
            </div>
            <div className="shortmode-budget-card shortmode-budget-card--satellite">
              <div className="shortmode-budget-card__label">サテライト高確信枠（上限）</div>
              <div className="shortmode-budget-card__value">{formatJPYAuto(trustPlan.shortTermMode.satelliteBudget)}</div>
              <div className="shortmode-budget-card__note">
                本日推奨 {formatJPYAuto(trustPlan.shortTermMode.recommendedSatelliteBudget)}
              </div>
            </div>
          </div>

          <div className="condition-stack">
            {trustPlan.shortTermMode.checklist.map(item => (
              <div key={item.id} className={`condition-row condition-row--${conditionTone(item.status)}`}>
                <div className="condition-row__main">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="condition-row__meta">
                  <span className={`tone-chip tone-chip--${conditionTone(item.status)}`}>
                    {conditionLabel(item.status)}
                  </span>
                  <div className="condition-meter" aria-hidden="true">
                    <span
                      className={`condition-meter__fill condition-meter__fill--${conditionTone(item.status)}`}
                      style={{ width: item.status === 'pass' ? '100%' : item.status === 'warn' ? '60%' : '30%' }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="proposal-list__rules" style={{ marginTop: 12 }}>
            <span>利確: {trustPlan.shortTermMode.takeProfitRule}</span>
            <span>部分利確: {trustPlan.shortTermMode.partialTakeProfitRule}</span>
            <span>損切: {trustPlan.shortTermMode.stopLossRule}</span>
            <span>最大保有: {trustPlan.shortTermMode.maxHoldingRule}</span>
            <span>前提崩れ: {trustPlan.shortTermMode.invalidationRule}</span>
          </div>

          <div className="risk-register" style={{ marginTop: 12 }}>
            <div className="risk-register__item risk-register__item--high">
              <div className="risk-register__title">
                <strong>ブルベア減価リスク</strong>
                <span className="vd sell">短期専用</span>
              </div>
              <div className="risk-register__meta">
                <span>{trustPlan.shortTermMode.leveragedWarning}</span>
              </div>
            </div>
            <div className="risk-register__item risk-register__item--low">
              <div className="risk-register__title">
                <strong>現物コア運用</strong>
                <span className="vd hold">待機許容</span>
              </div>
              <div className="risk-register__meta">
                <span>{trustPlan.shortTermMode.coreNote}</span>
              </div>
            </div>
          </div>

          {trustPlan.shortTermMode.waitReasons.length > 0 && (
            <ul className="simple-list" style={{ marginTop: 12 }}>
              {trustPlan.shortTermMode.waitReasons.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}

          <div className="summary-grid" style={{ marginTop: 14 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">30日 勝率</div>
              <div className="summary-tile__value">{trustPlan.performance30d.winRate.toFixed(1)}%</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">待機日数</div>
              <div className="summary-tile__value">{trustPlan.performance30d.waitDays}日</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">実行回数</div>
              <div className="summary-tile__value">{trustPlan.performance30d.executions}回</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">待機後続勝率</div>
              <div className="summary-tile__value">{trustPlan.performance30d.postWaitWinRate.toFixed(1)}%</div>
            </div>
          </div>

          <div className="metrics-inline">
            <span>VIXフィルター提案 Bull ≤ {shortTuning.recommendedBullVixMax.toFixed(1)}</span>
            <span>Bear ≥ {shortTuning.recommendedBearVixMin.toFixed(1)}</span>
            <span>サンプル Bull {shortTuning.bullSample}件 / Bear {shortTuning.bearSample}件</span>
          </div>

          <div className="section-heading-row" style={{ marginTop: 10 }}>
            <div className="section-caption">
              トラッキング日数 {trustPlan.performance30d.trackedDays}日
            </div>
            <button
              className="field-button"
              type="button"
              onClick={handleMarkExecuted}
              disabled={todayEntryCount >= 1 || trustPlan.shortTermMode.candidateDirection === 'WAIT'}
            >
              本日エントリー済みにする
            </button>
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Trust overview</div>
          <h2 className="section-heading">投信ポートフォリオ（投信のみ）</h2>
          <div className="summary-grid" style={{ marginTop: 16 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">総評価額</div>
              <div className="summary-tile__value">{formatJPYAuto(totalEval)}</div>
            </div>
            <div className={`summary-tile ${totalPnl >= 0 ? 'summary-tile--positive' : 'summary-tile--negative'}`}>
              <div className="summary-tile__label">含み損益</div>
              <div className="summary-tile__value">
                {totalPnl >= 0 ? '+' : ''}
                {formatJPYAuto(totalPnl)}
              </div>
            </div>
            <div className={`summary-tile ${weightedCost > 0.8 ? 'summary-tile--negative' : weightedCost > 0.5 ? 'summary-tile--caution' : 'summary-tile--positive'}`}>
              <div className="summary-tile__label">加重コスト</div>
              <div className="summary-tile__value">{weightedCost.toFixed(2)}%</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">最終更新</div>
              <div className="summary-tile__value" style={{ fontSize: 16 }}>
                {system.lastUpdated ? formatDateTime(system.lastUpdated) : '未更新'}
              </div>
            </div>
          </div>

          <div className="metrics-inline">
            <span>日本株投信 {japanShortTermTrust.length}本</span>
            <span>海外投信 {longTermTrustGroups.find(group => group.policy === 'OVERSEAS_LONGTERM')?.items.length ?? 0}本</span>
            <span>外国人フロー {trustPlan.marketContext.foreignFlow >= 0 ? '+' : ''}{trustPlan.marketContext.foreignFlow.toFixed(0)}億円</span>
            <span>貸借倍率 {trustPlan.marketContext.marginRatio > 0 ? trustPlan.marketContext.marginRatio.toFixed(2) : '—'}</span>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Trust-only optimizer</div>
            <h3 className="section-heading">投信のみ最適ポートフォリオ</h3>
            <p className="section-copy">
              個別株ロジックを使わず、投信専用で配分差分を算出しています。
            </p>

            <div className="trust-target-board">
              {trustPlan.policyRows.map(row => (
                <div
                  key={row.policy}
                  className={`trust-target-card trust-target-card--${row.recommendation === 'BUY' ? 'positive' : row.recommendation === 'TRIM' ? 'negative' : 'caution'}`}
                >
                  <div className="trust-target-card__top">
                    <strong>{row.label}</strong>
                    <span className={`tone-chip tone-chip--${row.recommendation === 'BUY' ? 'positive' : row.recommendation === 'TRIM' ? 'negative' : 'neutral'}`}>
                      {row.recommendation === 'BUY' ? '積み増し' : row.recommendation === 'TRIM' ? '縮小' : '維持'}
                    </span>
                  </div>
                  <div className="trust-target-card__grid">
                    <span>現在 {(row.currentRatio * 100).toFixed(1)}%</span>
                    <span>目標 {(row.targetRatio * 100).toFixed(1)}%</span>
                    <span>現評価額 {formatJPYAuto(row.currentValue)}</span>
                    <span>目標評価額 {formatJPYAuto(row.targetValue)}</span>
                  </div>
                  <div className={`trust-target-card__diff ${row.diffValue >= 0 ? 'p' : 'n'}`}>
                    {row.diffValue >= 0 ? '+' : ''}
                    {formatJPYAuto(row.diffValue)}
                  </div>
                  <p className="trust-target-card__hint">{row.reason}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <div className="section-kicker">Japan trust tactical module</div>
            <h3 className="section-heading">日本株投信の超短期実行候補</h3>
            <div className="trust-lane" style={{ marginTop: 12 }}>
              {trustPlan.shortTermRows.map(row => (
                <div key={row.id} className={`trust-lane__item trust-lane__item--${actionTone(row.action)}`}>
                  <div className="trust-lane__head">
                    <strong>{row.abbr}</strong>
                    <span className={`vd ${recommendationBadge(row.action)}`}>
                      {actionLabel(row.action)}
                    </span>
                  </div>
                  <p>
                    {row.role} / {row.score}% / 推奨金額 {formatJPYAuto(row.suggestedAmount)}
                  </p>
                  <div className="trust-lane__meta">
                    {row.rationale.map(item => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                  <div className="proposal-list__rules" style={{ marginTop: 10 }}>
                    <span>保有スタンス: {row.holdingStance}</span>
                    <span>エントリー: {row.entryRule}</span>
                    <span>利確: {row.takeProfitRule}</span>
                    <span>損切: {row.stopLossRule}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Execution queue</div>
            <h3 className="section-heading">投信アクションキュー</h3>
            <div className="action-list" style={{ marginTop: 12 }}>
              {trustPlan.executionQueue.map((item, index) => (
                <div
                  key={item.id}
                  className={`action-list__item action-list__item--${item.priority === 'high' ? 'negative' : item.priority === 'medium' ? 'caution' : 'neutral'}`}
                >
                  <div className="action-list__index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="action-list__body">
                    <div className="action-list__title-row">
                      <strong>{item.title}</strong>
                      <span className={`vd ${recommendationBadge(item.action)}`}>{item.priority.toUpperCase()}</span>
                    </div>
                    <p>{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <div className="section-kicker">Import</div>
            <h3 className="section-heading">投信CSVを更新</h3>
            <div
              className="csv-drop"
              style={{ marginTop: 16 }}
              onDrop={handleCsvDrop}
              onDragOver={event => event.preventDefault()}
            >
              <input type="file" accept=".csv" onChange={handleFileChange} />
              <div>投信CSVをドロップまたは選択</div>
              <small>評価額・損益率・日次騰落を最新化します。</small>
            </div>
          </article>
        </div>
      </section>

      <section className="stack-layout" style={{ marginTop: 16 }}>
        {longTermTrustGroups.map(group => {
          if (group.items.length === 0) return null

          return (
            <article key={group.policy} className="card">
              <div className="section-heading-row">
                <div>
                  <div className="section-kicker">Separated long-term zone</div>
                  <h3 className="section-heading">{POLICY_LABEL[group.policy]}</h3>
                </div>
                <div className="section-caption">
                  {formatJPYAuto(group.total)} / {(group.total / Math.max(totalEval, 1) * 100).toFixed(1)}%
                </div>
              </div>

              <div className="fund-grid" style={{ marginTop: 16 }}>
                {group.items.map(item => (
                  <div
                    key={item.id}
                    className={`fund-card fund-card--${item.decision === 'BUY' ? 'positive' : item.decision === 'SELL' ? 'caution' : 'neutral'}`}
                  >
                    <div className="fund-card__top">
                      <div>
                        <div className="position-card__code">{item.abbr}</div>
                        <strong>{item.name}</strong>
                      </div>
                      <span className={`vd ${recommendationBadge(item.decision === 'SELL' ? 'TRIM' : item.decision === 'BUY' ? 'BUY' : 'HOLD')}`}>
                        {item.decision}
                      </span>
                    </div>

                    <div className="fund-card__metrics">
                      <span>評価額 {formatJPYAuto(item.eval)}</span>
                      <span>損益率 {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%</span>
                      <span>当日 {item.dayPct >= 0 ? '+' : ''}{item.dayPct.toFixed(2)}%</span>
                      <span>費用 {item.cost.toFixed(2)}%</span>
                      <span>期待収益 {(item.mu * 100).toFixed(1)}%</span>
                      <span>スコア {item.score}</span>
                    </div>

                    {item.signal && <p className="fund-card__signal">{item.signal}</p>}
                  </div>
                ))}
              </div>
            </article>
          )
        })}
      </section>
    </div>
  )
}
