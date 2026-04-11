import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
import { buildZeroBasePlan } from '../../domain/optimization/zeroBase'

interface WatchItem {
  code: string
  name: string
  reason: string
}

interface DecisionLog {
  ts: string
  action: 'BUY' | 'HOLD' | 'SELL' | 'BIAS'
  code: string
  detail: string
}

function loadWatchlist() {
  try {
    return JSON.parse(localStorage.getItem('v83_watchlist') || '[]') as WatchItem[]
  } catch {
    return []
  }
}

function saveWatchlist(items: WatchItem[]) {
  localStorage.setItem('v83_watchlist', JSON.stringify(items))
}

function loadDecisionLog() {
  try {
    return JSON.parse(localStorage.getItem('v83_declog') || '[]') as DecisionLog[]
  } catch {
    return []
  }
}

function saveDecisionLog(items: DecisionLog[]) {
  localStorage.setItem('v83_declog', JSON.stringify(items))
}

export function T5_Backtest() {
  const analysis = useAppStore(s => s.analysis)
  const holdings = useAppStore(s => s.holdings)
  const trust = useAppStore(s => s.trust)
  const market = useAppStore(s => s.market)
  const macro = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const metrics = useAppStore(s => s.metrics)
  const universe = useAppStore(s => s.universe)
  const cash = useAppStore(s => s.cash)
  const cashReserve = useAppStore(s => s.cashReserve)
  const addRoom = useAppStore(s => s.addRoom)
  const system = useAppStore(s => s.system)

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

  const [watchlist, setWatchlist] = useState<WatchItem[]>(loadWatchlist)
  const [decisionLog, setDecisionLog] = useState<DecisionLog[]>(loadDecisionLog)
  const [watchCode, setWatchCode] = useState('')
  const [watchName, setWatchName] = useState('')
  const [watchReason, setWatchReason] = useState('')
  const [budget, setBudget] = useState(1_000_000)

  useEffect(() => {
    saveWatchlist(watchlist)
  }, [watchlist])

  useEffect(() => {
    saveDecisionLog(decisionLog)
  }, [decisionLog])

  const addWatch = () => {
    if (!watchCode.trim()) return
    setWatchlist(current => [
      ...current,
      {
        code: watchCode.trim(),
        name: watchName.trim(),
        reason: watchReason.trim(),
      },
    ])
    setWatchCode('')
    setWatchName('')
    setWatchReason('')
  }

  const removeWatch = (index: number) => {
    setWatchlist(current => current.filter((_, itemIndex) => itemIndex !== index))
  }

  const pushDecisionLog = (action: DecisionLog['action'], code: string, detail: string) => {
    setDecisionLog(current => [
      { ts: new Date().toISOString(), action, code, detail },
      ...current,
    ].slice(0, 50))
  }

  const kellyItems = holdings
    .map(holding => {
      const kelly = (holding.mu - 0.005) / (holding.sigma * holding.sigma)
      const halfKelly = Math.min(0.3, Math.max(0, kelly * 0.5))
      return { holding, halfKelly }
    })
    .filter(item => item.halfKelly > 0)
    .sort((left, right) => right.halfKelly - left.halfKelly)

  const scoreAverages = analysis.length > 0
    ? [
        { label: 'Fundamental', value: analysis.reduce((sum, item) => sum + item.fundamentalScore, 0) / analysis.length, max: 30 },
        { label: 'Market', value: analysis.reduce((sum, item) => sum + item.marketScore, 0) / analysis.length, max: 20 },
        { label: 'Technical', value: analysis.reduce((sum, item) => sum + item.technicalScore, 0) / analysis.length, max: 20 },
        { label: 'News', value: analysis.reduce((sum, item) => sum + item.newsScore, 0) / analysis.length, max: 15 },
        { label: 'Quality', value: analysis.reduce((sum, item) => sum + item.qualityScore, 0) / analysis.length, max: 10 },
      ]
    : []

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className={`card focus-card focus-card--${zeroPlan.board.marketMode}`}>
          <div className="section-kicker">Execution plan</div>
          <h2 className="section-heading">ゼロベース売買計画</h2>
          <p className="focus-card__summary">{zeroPlan.board.conclusion}</p>
          <div className="focus-card__badges">
            <span className={`tone-chip tone-chip--${zeroPlan.board.marketMode === 'normal' ? 'positive' : zeroPlan.board.marketMode === 'caution' ? 'caution' : 'negative'}`}>
              {zeroPlan.board.modeLabel}
            </span>
            <span className="tone-chip tone-chip--neutral">
              分析 {system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行'}
            </span>
          </div>

          <div className="focus-card__columns">
            <div>
              <div className="section-subtitle">優先タスク</div>
              <ul className="simple-list">
                {zeroPlan.board.todo.slice(0, 4).map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
            <div>
              <div className="section-subtitle">高確信候補</div>
              {zeroPlan.board.highConviction.length > 0 ? (
                <ul className="simple-list">
                  {zeroPlan.board.highConviction.map(item => (
                    <li key={item.id}>
                      {item.name} ({item.code}) / {formatJPYAuto(item.amount)} / {(item.confidence * 100).toFixed(0)}%
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-state">高確信候補はまだありません。</div>
              )}
            </div>
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Sizing</div>
          <h2 className="section-heading">資金配分の目安</h2>
          <div className="summary-grid" style={{ marginTop: 18 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">現金</div>
              <div className="summary-tile__value">{formatJPYAuto(cash)}</div>
            </div>
            <div className="summary-tile summary-tile--caution">
              <div className="summary-tile__label">待機資金</div>
              <div className="summary-tile__value">{formatJPYAuto(cashReserve)}</div>
            </div>
            <div className="summary-tile summary-tile--positive">
              <div className="summary-tile__label">追加投資枠</div>
              <div className="summary-tile__value">{formatJPYAuto(addRoom)}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">提案数</div>
              <div className="summary-tile__value">{zeroPlan.proposals.length}</div>
            </div>
          </div>

          <div className="slider-box" style={{ marginTop: 18 }}>
            <div className="slider-box__label-row">
              <span>試算予算</span>
              <strong>{formatJPYAuto(budget)}</strong>
            </div>
            <input
              type="range"
              min="500000"
              max="5000000"
              step="100000"
              value={budget}
              onChange={event => setBudget(Number(event.target.value))}
            />
          </div>

          <div className="score-list" style={{ marginTop: 18 }}>
            {kellyItems.slice(0, 6).map(item => (
              <div key={item.holding.code} className="score-list__item">
                <div>
                  <strong>{item.holding.code} {item.holding.name}</strong>
                  <span>Half-Kelly {(item.halfKelly * 100).toFixed(1)}%</span>
                </div>
                <span>{formatJPYAuto(budget * item.halfKelly)}</span>
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
                <div className="section-kicker">Proposal queue</div>
                <h3 className="section-heading">執行候補</h3>
              </div>
            </div>

            <div className="proposal-list" style={{ marginTop: 16 }}>
              {zeroPlan.proposals.length > 0 ? (
                zeroPlan.proposals.slice(0, 10).map(proposal => (
                  <div key={proposal.id} className={`proposal-list__item proposal-list__item--${proposal.action === 'BUY' ? 'positive' : proposal.action === 'SELL' ? 'negative' : 'caution'}`}>
                    <div className="proposal-list__header">
                      <div>
                        <strong>{proposal.name} ({proposal.code})</strong>
                        <span>{proposal.reason}</span>
                      </div>
                      <div className="proposal-list__meta">
                        <span className={`vd ${proposal.action === 'BUY' ? 'buy' : proposal.action === 'SELL' ? 'sell' : 'wait'}`}>
                          {proposal.action}
                        </span>
                        <span>{proposal.amount > 0 ? formatJPYAuto(proposal.amount) : '未指定'}</span>
                      </div>
                    </div>

                    <div className="proposal-list__rules">
                      <span>根拠 {proposal.rule.entryRationale}</span>
                      <span>利確 {proposal.rule.takeProfit}</span>
                      <span>損切 {proposal.rule.stopLoss}</span>
                      <span>分割 {proposal.rule.splitExecution}</span>
                    </div>

                    <button
                      className="text-button"
                      onClick={() => pushDecisionLog(proposal.action === 'WAIT' ? 'HOLD' : proposal.action, proposal.code, `${proposal.reason} / ${proposal.rule.takeProfit}`)}
                      type="button"
                    >
                      実行ログへ追加
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  今回は強い執行候補がありません。
                </div>
              )}
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Score balance</div>
                <h3 className="section-heading">平均スコア構成</h3>
              </div>
            </div>

            {scoreAverages.length > 0 ? (
              <div className="metric-bar-list" style={{ marginTop: 16 }}>
                {scoreAverages.map(item => {
                  const ratio = (item.value / item.max) * 100
                  return (
                    <div key={item.label} className="metric-bar-list__item">
                      <div className="metric-bar-list__label">
                        <span>{item.label}</span>
                        <strong>{item.value.toFixed(1)}/{item.max}</strong>
                      </div>
                      <div className="metric-bar-list__track">
                        <span style={{ width: `${ratio}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="empty-state" style={{ marginTop: 16 }}>
                分析対象がまだありません。
              </div>
            )}
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Watchlist</div>
                <h3 className="section-heading">監視銘柄</h3>
              </div>
            </div>

            <div className="field-grid" style={{ marginTop: 16 }}>
              <input
                className="field-input"
                value={watchCode}
                onChange={event => setWatchCode(event.target.value)}
                placeholder="コード"
              />
              <input
                className="field-input"
                value={watchName}
                onChange={event => setWatchName(event.target.value)}
                placeholder="銘柄名"
              />
              <input
                className="field-input field-input--wide"
                value={watchReason}
                onChange={event => setWatchReason(event.target.value)}
                placeholder="監視理由"
              />
              <button className="field-button" onClick={addWatch} type="button">
                追加
              </button>
            </div>

            <div className="score-list" style={{ marginTop: 16 }}>
              {watchlist.length > 0 ? (
                watchlist.map((item, index) => (
                  <div key={`${item.code}-${index}`} className="score-list__item">
                    <div>
                      <strong>{item.code} {item.name}</strong>
                      <span>{item.reason || '理由未設定'}</span>
                    </div>
                    <button className="text-button" onClick={() => removeWatch(index)} type="button">
                      削除
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-state">監視銘柄はまだありません。</div>
              )}
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Decision log</div>
                <h3 className="section-heading">意思決定ログ</h3>
              </div>
            </div>

            <div className="timeline-list" style={{ marginTop: 16 }}>
              {decisionLog.length > 0 ? (
                decisionLog.slice(0, 20).map((item, index) => (
                  <div key={`${item.ts}-${index}`} className="timeline-list__item">
                    <div className="timeline-list__stamp">{formatDateTime(item.ts)}</div>
                    <div className="timeline-list__content">
                      <div className="timeline-list__top">
                        <span className={`vd ${item.action === 'BUY' ? 'buy' : item.action === 'SELL' ? 'sell' : 'hold'}`}>{item.action}</span>
                        <strong>{item.code}</strong>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">まだログはありません。</div>
              )}
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
