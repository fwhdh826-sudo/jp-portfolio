import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import {
  selectBuyList,
  selectSellList,
  selectTotalEval,
} from '../../store/selectors'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
import { buildZeroBasePlan } from '../../domain/optimization/zeroBase'
import type { HoldingAnalysis } from '../../types'

interface ActionChecklistItem {
  id: string
  title: string
  rationale: string
  execution: string
  tone: 'positive' | 'negative' | 'caution' | 'neutral'
}

function loadChecklistState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('v91_action_board') || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function saveChecklistState(state: Record<string, boolean>) {
  localStorage.setItem('v91_action_board', JSON.stringify(state))
}

function calculateHealth(analysis: HoldingAnalysis[]) {
  if (analysis.length === 0) {
    return { score: 0, quality: 0, defense: 0, opportunity: 0, coverage: 0 }
  }

  const averageScore = analysis.reduce((sum, item) => sum + item.totalScore, 0) / analysis.length
  const sellRatio = analysis.filter(item => item.decision === 'SELL').length / analysis.length
  const buyRatio = analysis.filter(item => item.decision === 'BUY').length / analysis.length

  const quality = Math.round(averageScore * 0.42)
  const defense = Math.round((1 - sellRatio) * 30)
  const opportunity = Math.round(buyRatio * 18)
  const coverage = Math.round(Math.min(analysis.length / 12, 1) * 10)

  return {
    score: Math.min(100, quality + defense + opportunity + coverage),
    quality,
    defense,
    opportunity,
    coverage,
  }
}

function getHealthLabel(score: number) {
  if (score >= 80) return '運用状態は良好です。大きな修正は不要です。'
  if (score >= 60) return '大枠は安定しています。部分調整を優先してください。'
  if (score >= 40) return '修正が必要です。縮小と再配分を優先してください。'
  return '守りを最優先にしてください。新規追加は控えるべき状態です。'
}

function getToneByDecision(decision: 'BUY' | 'SELL' | 'HOLD' | 'WAIT') {
  if (decision === 'BUY') return 'positive'
  if (decision === 'SELL') return 'negative'
  if (decision === 'WAIT') return 'caution'
  return 'neutral'
}

function RecommendationCard({ item }: { item: HoldingAnalysis }) {
  const holding = useAppStore(s => s.holdings.find(h => h.code === item.code))

  if (!holding) return null

  const tone = getToneByDecision(item.decision)
  const reasons = item.decision === 'SELL'
    ? item.debate.bearReasons.slice(0, 2)
    : item.debate.bullReasons.slice(0, 2)

  return (
    <article className={`recommendation-card recommendation-card--${tone}`}>
      <div className="recommendation-card__top">
        <div>
          <div className="recommendation-card__code">{holding.code}</div>
          <div className="recommendation-card__name">{holding.name}</div>
        </div>
        <div className="recommendation-card__meta">
          <span className={`vd ${item.decision === 'BUY' ? 'buy' : item.decision === 'SELL' ? 'sell' : 'hold'}`}>
            {item.decision}
          </span>
          <span className="recommendation-card__score">{item.totalScore}</span>
        </div>
      </div>

      <div className="recommendation-card__metrics">
        <div>
          <span>EV</span>
          <strong>{item.ev >= 0 ? '+' : ''}{(item.ev * 100).toFixed(1)}%</strong>
        </div>
        <div>
          <span>確信度</span>
          <strong>{(item.confidence * 100).toFixed(0)}%</strong>
        </div>
        <div>
          <span>評価額</span>
          <strong>{formatJPYAuto(holding.eval)}</strong>
        </div>
      </div>

      <div className="recommendation-card__reasons">
        {reasons.length > 0 ? (
          reasons.map(reason => <p key={reason}>{reason}</p>)
        ) : (
          <p>判断理由の集約待ちです。</p>
        )}
      </div>
    </article>
  )
}

export function T1_Decision() {
  const analysis = useAppStore(s => s.analysis)
  const buyList = useAppStore(selectBuyList)
  const sellList = useAppStore(selectSellList)
  const holdings = useAppStore(s => s.holdings)
  const trust = useAppStore(s => s.trust)
  const macro = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const metrics = useAppStore(s => s.metrics)
  const universe = useAppStore(s => s.universe)
  const market = useAppStore(s => s.market)
  const cash = useAppStore(s => s.cash)
  const cashReserve = useAppStore(s => s.cashReserve)
  const addRoom = useAppStore(s => s.addRoom)
  const importCsv = useAppStore(s => s.importCsv)
  const system = useAppStore(s => s.system)
  const totalEval = useAppStore(selectTotalEval)

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

  const health = calculateHealth(analysis)
  const [doneState, setDoneState] = useState<Record<string, boolean>>(loadChecklistState)

  useEffect(() => {
    saveChecklistState(doneState)
  }, [doneState])

  const checklistItems: ActionChecklistItem[] = [
    ...sellList.slice(0, 2).map(item => {
      const holding = holdings.find(h => h.code === item.code)
      return {
        id: `trim-${item.code}`,
        title: `${holding?.name ?? item.code} を縮小または撤退する`,
        rationale: `SELL判定かつEV ${(item.ev * 100).toFixed(1)}%。先に弱いポジションを整理する局面です。`,
        execution: `寄付き直後は避け、流動性を見ながら段階的に執行します。`,
        tone: 'negative' as const,
      }
    }),
    ...buyList.slice(0, 2).map(item => {
      const holding = holdings.find(h => h.code === item.code)
      return {
        id: `add-${item.code}`,
        title: `${holding?.name ?? item.code} を候補として監視する`,
        rationale: `BUY判定かつ確信度 ${(item.confidence * 100).toFixed(0)}%。ただし先に防御条件を満たす必要があります。`,
        execution: `一括ではなく分割で執行し、初回は全予定額の30%以内に留めます。`,
        tone: 'positive' as const,
      }
    }),
    {
      id: 'refresh-csv',
      title: '最新CSVを取り込み、分析前提を更新する',
      rationale: '評価額と損益率が古いと、判断の精度が落ちます。',
      execution: 'SBI証券のCSVをここに投入して、分析状態を最新化します。',
      tone: 'neutral' as const,
    },
  ]

  const readinessChecks = [
    {
      label: 'SELL銘柄を先に整理',
      current: `${sellList.length}件`,
      passed: sellList.length === 0,
    },
    {
      label: 'Sharpe 1.0以上',
      current: metrics ? metrics.sharpe.toFixed(2) : '—',
      passed: (metrics?.sharpe ?? 0) >= 1,
    },
    {
      label: '市場ボラティリティ許容',
      current: `VIX ${market.vix.toFixed(1)}`,
      passed: market.vix <= 20,
    },
    {
      label: '国内株の過剰集中回避',
      current: universe?.categories.find(item => item.class === 'JP_STOCK')
        ? `${(universe.categories.find(item => item.class === 'JP_STOCK')!.currentRatio * 100).toFixed(1)}%`
        : '—',
      passed: (universe?.categories.find(item => item.class === 'JP_STOCK')?.currentRatio ?? 0) <= 0.2,
    },
  ]

  const completedChecks = readinessChecks.filter(item => item.passed).length
  const allocationDiffs = (zeroPlan.categoryDiffs.length > 0 ? zeroPlan.categoryDiffs : universe?.categories ?? []).slice(0, 8)

  const handleFileDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importCsv(file)
  }

  return (
    <div className="tab-panel decision-page">
      <section className="decision-grid">
        <article className={`card focus-card focus-card--${zeroPlan.board.marketMode}`}>
          <div className="section-kicker">Execution brief</div>
          <h2 className="section-heading">今日の基本方針</h2>
          <p className="focus-card__summary">{zeroPlan.board.conclusion}</p>

          <div className="focus-card__badges">
            <span className={`tone-chip tone-chip--${zeroPlan.board.marketMode === 'normal' ? 'positive' : zeroPlan.board.marketMode === 'caution' ? 'caution' : 'negative'}`}>
              {zeroPlan.board.modeLabel}
            </span>
            <span className="tone-chip tone-chip--neutral">
              分析更新 {system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行'}
            </span>
          </div>

          <div className="focus-card__columns">
            <div>
              <div className="section-subtitle">本日の優先事項</div>
              <ul className="simple-list">
                {zeroPlan.board.todo.slice(0, 4).map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
            <div>
              <div className="section-subtitle">警戒ポイント</div>
              <ul className="simple-list simple-list--alert">
                {zeroPlan.board.riskAlerts.slice(0, 4).map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
          </div>
        </article>

        <article className="card health-card">
          <div className="section-kicker">Portfolio health</div>
          <div className="health-card__score">{health.score}</div>
          <p className="health-card__copy">{getHealthLabel(health.score)}</p>

          <div className="health-card__grid">
            <div className="health-metric">
              <span>クオリティ</span>
              <strong>{health.quality}</strong>
            </div>
            <div className="health-metric">
              <span>防御力</span>
              <strong>{health.defense}</strong>
            </div>
            <div className="health-metric">
              <span>機会量</span>
              <strong>{health.opportunity}</strong>
            </div>
            <div className="health-metric">
              <span>カバレッジ</span>
              <strong>{health.coverage}</strong>
            </div>
          </div>

          <div className="health-card__footer">
            <span>総評価額 {formatJPYAuto(totalEval)}</span>
            <span>分析銘柄 {analysis.length}件</span>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Priority queue</div>
                <h3 className="section-heading">執行キュー</h3>
              </div>
              <div className="section-caption">{zeroPlan.proposals.length}件</div>
            </div>

            <div className="action-list">
              {zeroPlan.proposals.slice(0, 8).map((proposal, index) => (
                <div key={proposal.id} className={`action-list__item action-list__item--${getToneByDecision(proposal.action)}`}>
                  <div className="action-list__index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="action-list__body">
                    <div className="action-list__title-row">
                      <strong>{proposal.name} ({proposal.code})</strong>
                      <span className={`vd ${proposal.action === 'BUY' ? 'buy' : proposal.action === 'SELL' ? 'sell' : 'wait'}`}>
                        {proposal.action}
                      </span>
                    </div>
                    <p>{proposal.reason}</p>
                    <div className="action-list__detail">
                      <span>金額 {proposal.amount > 0 ? formatJPYAuto(proposal.amount) : '未指定'}</span>
                      <span>利確 {proposal.rule.takeProfit}</span>
                      <span>損切 {proposal.rule.stopLoss}</span>
                    </div>
                  </div>
                </div>
              ))}

              {zeroPlan.proposals.length === 0 && (
                <div className="empty-state">
                  執行候補はありません。今日は新規売買より監視を優先する局面です。
                </div>
              )}
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Checklist</div>
                <h3 className="section-heading">実行前チェック</h3>
              </div>
              <div className="section-caption">
                {checklistItems.filter(item => doneState[item.id]).length}/{checklistItems.length}
              </div>
            </div>

            <div className="checklist">
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
                    <span>{item.rationale}</span>
                    <span>{item.execution}</span>
                  </span>
                </button>
              ))}
            </div>
          </article>

          <article
            className="card import-card"
            onDrop={handleFileDrop}
            onDragOver={event => event.preventDefault()}
          >
            <div className="section-kicker">Input</div>
            <h3 className="section-heading">評価データを更新</h3>
            <p className="import-card__copy">
              最新のSBI証券CSVを投入すると、保有額・損益率・判断ロジックが最新値に揃います。
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

        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Readiness</div>
                <h3 className="section-heading">追加投資の準備度</h3>
              </div>
              <div className="section-caption">{completedChecks}/{readinessChecks.length}</div>
            </div>

            <div className="readiness-list">
              {readinessChecks.map(item => (
                <div key={item.label} className={`readiness-list__item${item.passed ? ' is-passed' : ''}`}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.current}</span>
                  </div>
                  <span>{item.passed ? 'OK' : '要確認'}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Allocation drift</div>
                <h3 className="section-heading">配分のズレ</h3>
              </div>
              <div className="section-caption">{allocationDiffs.length}分類</div>
            </div>

            <div className="allocation-list">
              {allocationDiffs.map(item => (
                <div key={item.class} className="allocation-list__item">
                  <div className="allocation-list__header">
                    <strong>{item.label}</strong>
                    <span>{item.currentRatio * 100 > item.targetRatio * 100 ? '削減候補' : '積み増し候補'}</span>
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

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Shortlist</div>
                <h3 className="section-heading">優先候補</h3>
              </div>
            </div>

            <div className="recommendation-column">
              {sellList.slice(0, 2).map(item => <RecommendationCard key={`sell-${item.code}`} item={item} />)}
              {buyList.slice(0, 2).map(item => <RecommendationCard key={`buy-${item.code}`} item={item} />)}
              {sellList.length === 0 && buyList.length === 0 && (
                <div className="empty-state">
                  目立つ売買候補はありません。監視中心で十分です。
                </div>
              )}
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
