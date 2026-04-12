import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectIsLoading } from '../../store/selectors'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
import { buildZeroBasePlan } from '../../domain/optimization/zeroBase'
import { buildStockPortfolioPlan } from '../../domain/optimization/stockPortfolio'
import { buildTrustPortfolioPlan } from '../../domain/optimization/trustPortfolio'
import { buildCommitteeDecision } from '../../domain/analysis/committeeDecision'
import {
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
} from '../../domain/learning/trustShortTracker'

interface ChecklistItem {
  id: string
  title: string
  detail: string
  tone: 'positive' | 'caution' | 'negative' | 'neutral'
}

function loadChecklistState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('v95_decision_checklist') || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function saveChecklistState(state: Record<string, boolean>) {
  localStorage.setItem('v95_decision_checklist', JSON.stringify(state))
}

function actionTone(priority: 'high' | 'medium' | 'low') {
  if (priority === 'high') return 'negative'
  if (priority === 'medium') return 'neutral'
  return 'neutral'
}

function trustSignalLabel(signal: 'BULL' | 'BEAR' | 'WAIT') {
  if (signal === 'BULL') return 'ブル推奨'
  if (signal === 'BEAR') return 'ベア推奨'
  return '待機推奨'
}

export function T1_Decision() {
  const holdings = useAppStore(s => s.holdings)
  const trust = useAppStore(s => s.trust)
  const analysis = useAppStore(s => s.analysis)
  const metrics = useAppStore(s => s.metrics)
  const market = useAppStore(s => s.market)
  const macro = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const margin = useAppStore(s => s.margin)
  const flows = useAppStore(s => s.flows)
  const universe = useAppStore(s => s.universe)
  const cash = useAppStore(s => s.cash)
  const cashReserve = useAppStore(s => s.cashReserve)
  const addRoom = useAppStore(s => s.addRoom)
  const importCsv = useAppStore(s => s.importCsv)
  const refreshAllData = useAppStore(s => s.refreshAllData)
  const system = useAppStore(s => s.system)
  const isLoading = useAppStore(selectIsLoading)

  const [doneState, setDoneState] = useState<Record<string, boolean>>(loadChecklistState)

  useEffect(() => {
    saveChecklistState(doneState)
  }, [doneState])

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
    [addRoom, analysis, cash, cashReserve, holdings, macro, market, metrics, sqCalendar, trust, universe],
  )

  const stockPlan = useMemo(
    () => buildStockPortfolioPlan(holdings, analysis),
    [analysis, holdings],
  )

  const trustPlan = useMemo(
    () =>
      buildTrustPortfolioPlan({
        trust,
        market,
        macro,
        sqCalendar,
        margin,
        flows,
        todayEntryCount: getTrustShortTodayExecutionCount(),
        performance30d: getTrustShortTrackingStats(),
      }),
    [flows, macro, margin, market, sqCalendar, trust],
  )

  const committee = useMemo(
    () =>
      buildCommitteeDecision({
        zeroPlan,
        stockPlan,
        trustPlan,
        metrics,
        market,
        holdings,
      }),
    [holdings, market, metrics, stockPlan, trustPlan, zeroPlan],
  )

  const checklistItems: ChecklistItem[] = [
    {
      id: 'market-regime',
      title: '市場モードを確認',
      detail: `現在 ${zeroPlan.board.modeLabel}。地合い前提が崩れたら執行量を縮小。`,
      tone: committee.verdict.tone,
    },
    {
      id: 'stock-lock',
      title: '個別株3ヶ月制約を確認',
      detail: `ロック中 ${stockPlan.lockCount}件。ロック中銘柄は売却指示にしても即実行しない。`,
      tone: stockPlan.lockCount > 0 ? 'caution' : 'positive',
    },
    {
      id: 'trust-signal',
      title: '投信短期シグナルを確認',
      detail: `投信判定 ${trustSignalLabel(trustPlan.shortTermSignal)}。日本株投信は超短期ルールでのみ執行。`,
      tone:
        trustPlan.shortTermSignal === 'BULL'
          ? 'positive'
          : trustPlan.shortTermSignal === 'BEAR'
          ? 'negative'
          : 'caution',
    },
    {
      id: 'csv-refresh',
      title: '保有データを更新',
      detail: 'SBI CSVを取り込み、評価額・損益率・取得日を最新化する。',
      tone: 'neutral',
    },
  ]

  const handleFileDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importCsv(file)
  }

  const diffRows = zeroPlan.categoryDiffs.slice(0, 8)

  return (
    <div className="tab-panel decision-page">
      <section className="decision-grid">
        <article className={`card focus-card focus-card--${committee.verdict.tone === 'positive' ? 'normal' : committee.verdict.tone === 'caution' ? 'caution' : 'emergency'}`}>
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">AI committee</div>
              <h2 className="section-heading">AI総合判断</h2>
            </div>
            <button
              className={`status-shell__refresh${isLoading ? ' is-loading' : ''}`}
              onClick={() => { void refreshAllData() }}
              disabled={isLoading}
              type="button"
            >
              {isLoading ? '更新中...' : 'データ更新'}
            </button>
          </div>

          <p className="focus-card__summary">{committee.verdict.summary}</p>

          <div className="focus-card__badges">
            <span className={`tone-chip tone-chip--${committee.verdict.tone}`}>{committee.verdict.label}</span>
            <span className="tone-chip tone-chip--neutral">市場モード {zeroPlan.board.modeLabel}</span>
            <span className={`tone-chip tone-chip--${committee.verdict.noTrade ? 'negative' : 'neutral'}`}>
              {committee.verdict.noTrade ? 'ノートレード判定' : '条件付き執行可'}
            </span>
            <span className="tone-chip tone-chip--neutral">分析更新 {system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行'}</span>
          </div>

          <div className="plan-stats">
            <div className="plan-stat">
              <span>推奨アクション</span>
              <strong>{committee.actions.length}</strong>
            </div>
            <div className="plan-stat">
              <span>個別株ロック</span>
              <strong>{stockPlan.lockCount}</strong>
            </div>
            <div className="plan-stat">
              <span>投信シグナル</span>
              <strong>{trustSignalLabel(trustPlan.shortTermSignal)}</strong>
            </div>
            <div className="plan-stat">
              <span>暴落待機資金</span>
              <strong>{formatJPYAuto(cashReserve)}</strong>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Structured analysis</div>
          <h2 className="section-heading">結論 → 根拠 → リスク → 行動</h2>
          <div className="focus-card__columns" style={{ marginTop: 12 }}>
            <div>
              <div className="section-subtitle">現在スタンス</div>
              <ul className="simple-list">
                <li>{committee.stance}</li>
              </ul>
              <div className="section-subtitle" style={{ marginTop: 10 }}>理由</div>
              <ul className="simple-list">
                {committee.rationale.map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
            <div>
              <div className="section-subtitle">注目ポイント</div>
              <ul className="simple-list">
                {committee.focusPoints.map(item => <li key={item}>{item}</li>)}
              </ul>
              <div className="section-subtitle" style={{ marginTop: 10 }}>リスク要因</div>
              <ul className="simple-list simple-list--alert">
                {committee.risks.map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Recommended actions</div>
                <h3 className="section-heading">推奨アクション</h3>
              </div>
              <div className="section-caption">{committee.actions.length}件</div>
            </div>
            <div className="action-list" style={{ marginTop: 12 }}>
              {committee.actions.map((action, index) => (
                <div key={action.id} className={`action-list__item action-list__item--${actionTone(action.priority)}`}>
                  <div className="action-list__index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="action-list__body">
                    <div className="action-list__title-row">
                      <strong>{action.title}</strong>
                      <span className={`vd ${action.priority === 'high' ? 'sell' : action.priority === 'medium' ? 'wait' : 'hold'}`}>
                        {action.priority.toUpperCase()}
                      </span>
                    </div>
                    <p>{action.detail}</p>
                    <div className="action-list__detail">
                      <span>根拠: {action.reason}</span>
                      <span>区分: {action.domain}</span>
                      <span>保有区分: {action.holdingStatus}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Pre-trade checklist</div>
                <h3 className="section-heading">実行前チェック</h3>
              </div>
              <div className="section-caption">
                {checklistItems.filter(item => doneState[item.id]).length}/{checklistItems.length}
              </div>
            </div>

            <div className="checklist" style={{ marginTop: 12 }}>
              {checklistItems.map(item => (
                <button
                  key={item.id}
                  className={`checklist__item checklist__item--${item.tone}${doneState[item.id] ? ' is-done' : ''}`}
                  onClick={() => setDoneState(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                  type="button"
                >
                  <span className="checklist__marker">{doneState[item.id] ? '完了' : '未了'}</span>
                  <span className="checklist__body">
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Ideal allocation delta</div>
                <h3 className="section-heading">理想PFとの差分</h3>
              </div>
              <div className="section-caption">{diffRows.length}分類</div>
            </div>
            <div className="allocation-list" style={{ marginTop: 12 }}>
              {diffRows.map(item => (
                <div key={item.class} className="allocation-list__item">
                  <div className="allocation-list__header">
                    <strong>{item.label}</strong>
                    <span>{item.role}</span>
                  </div>
                  <div className="allocation-list__meta">
                    <span>現在 {(item.currentRatio * 100).toFixed(1)}%</span>
                    <span>目標 {(item.targetRatio * 100).toFixed(1)}%</span>
                    <span>差額 {item.diffValue >= 0 ? '+' : ''}{formatJPYAuto(item.diffValue)}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article
            className="card import-card"
            onDrop={handleFileDrop}
            onDragOver={event => event.preventDefault()}
          >
            <div className="section-kicker">Input</div>
            <h3 className="section-heading">CSVで保有データを更新</h3>
            <p className="import-card__copy">
              評価額、損益率、取得日を更新し、個別株3ヶ月制約と投信短期判定を最新化します。
            </p>
            <label className="import-card__dropzone">
              <input type="file" accept=".csv" onChange={handleFileChange} />
              <span>CSVをドロップするかクリックして選択</span>
              <small>
                {system.csvLastImportedAt ? `最終取込 ${formatDateTime(system.csvLastImportedAt)}` : 'まだCSVは取り込まれていません。'}
              </small>
            </label>
          </article>
        </div>
      </section>
    </div>
  )
}
