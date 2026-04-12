import { useState, useEffect, useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatJPYAuto } from '../../utils/format'
import { buildZeroBasePlan } from '../../domain/optimization/zeroBase'
import {
  getTrustShortFilterTuning,
  getTrustShortRecentEntries,
  getTrustShortTrackingStats,
} from '../../domain/learning/trustShortTracker'

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

function loadWatchlist(): WatchItem[] {
  try { return JSON.parse(localStorage.getItem('v83_watchlist') || '[]') as WatchItem[] }
  catch { return [] }
}

function saveWatchlist(list: WatchItem[]) {
  localStorage.setItem('v83_watchlist', JSON.stringify(list))
}

function loadDecisionLog(): DecisionLog[] {
  try { return JSON.parse(localStorage.getItem('v83_declog') || '[]') as DecisionLog[] }
  catch { return [] }
}

function saveDecisionLog(log: DecisionLog[]) {
  localStorage.setItem('v83_declog', JSON.stringify(log))
}

function shortDecisionColor(decision: 'BULL' | 'BEAR' | 'WAIT') {
  if (decision === 'BULL') return 'var(--g)'
  if (decision === 'BEAR') return 'var(--r)'
  return 'var(--a)'
}

function shortOutcomeColor(outcome: 'win' | 'loss' | 'flat') {
  if (outcome === 'win') return 'var(--g)'
  if (outcome === 'loss') return 'var(--r)'
  return 'var(--d)'
}

export function T5_Backtest() {
  const analysis  = useAppStore(s => s.analysis)
  const holdings  = useAppStore(s => s.holdings)
  const trust     = useAppStore(s => s.trust)
  const market    = useAppStore(s => s.market)
  const macro     = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const metrics   = useAppStore(s => s.metrics)
  const universe  = useAppStore(s => s.universe)
  const cash      = useAppStore(s => s.cash)
  const cashReserve = useAppStore(s => s.cashReserve)
  const addRoom   = useAppStore(s => s.addRoom)
  const system    = useAppStore(s => s.system)

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

  // ── Watchlist ────────────────────────────────────────────────
  const [watchlist, setWatchlist] = useState<WatchItem[]>(loadWatchlist)
  const [wCode, setWCode]   = useState('')
  const [wName, setWName]   = useState('')
  const [wReason, setWReason] = useState('')

  useEffect(() => { saveWatchlist(watchlist) }, [watchlist])

  const addWatch = () => {
    if (!wCode.trim()) return
    setWatchlist(prev => [...prev, { code: wCode.trim(), name: wName.trim(), reason: wReason.trim() }])
    setWCode(''); setWName(''); setWReason('')
  }
  const delWatch = (i: number) => setWatchlist(prev => prev.filter((_, j) => j !== i))

  // ── Decision Log ─────────────────────────────────────────────
  const [decLog, setDecLog] = useState<DecisionLog[]>(loadDecisionLog)

  useEffect(() => { saveDecisionLog(decLog) }, [decLog])

  const logAction = (action: DecisionLog['action'], code: string, detail: string) => {
    const entry: DecisionLog = { ts: new Date().toISOString(), action, code, detail }
    setDecLog(prev => [entry, ...prev].slice(0, 50))
  }

  // ── Half-Kelly ───────────────────────────────────────────────
  const [budget, setBudget] = useState(1000000)

  const kellyItems = holdings
    .map(h => {
      const kelly = (h.mu - 0.005) / (h.sigma * h.sigma)
      const halfKelly = Math.min(0.30, Math.max(0, kelly * 0.5))
      return { code: h.code, name: h.name, kelly, halfKelly }
    })
    .filter(k => k.kelly > 0)
    .sort((a, b) => b.halfKelly - a.halfKelly)

  const tagColor = (action: string) => {
    if (action === 'BUY')  return { bg: 'rgba(45,212,160,.15)',  color: 'var(--g)',  border: 'var(--g2)' }
    if (action === 'SELL') return { bg: 'rgba(232,64,90,.15)',   color: 'var(--r)',  border: 'var(--r2)' }
    if (action === 'HOLD') return { bg: 'rgba(104,150,200,.15)', color: 'var(--c)',  border: 'var(--b1)' }
    return                        { bg: 'rgba(212,160,23,.15)',  color: 'var(--a)',  border: 'var(--a)' }
  }

  const shortStats = getTrustShortTrackingStats()
  const shortEntries = getTrustShortRecentEntries(90)
  const shortTuning = getTrustShortFilterTuning(90)

  return (
    <div className="tab-panel">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: 10 }}>
        最終分析: {system.analysisLastRunAt?.slice(0, 19).replace('T', ' ') ?? '─'}
      </div>

      {/* ── 日本株投信 短期モジュール検証 ─────────────────────── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">短期モジュール検証（日本株投信） <span className="badge ai">30日/90日</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 10 }}>
          <div className="kpi">
            <div className="l">30日勝率</div>
            <div className="v" style={{ color: shortStats.winRate >= 78 ? 'var(--g)' : shortStats.winRate >= 65 ? 'var(--a)' : 'var(--r)' }}>
              {shortStats.winRate.toFixed(1)}%
            </div>
          </div>
          <div className="kpi">
            <div className="l">実行回数</div>
            <div className="v wh">{shortStats.executions}</div>
          </div>
          <div className="kpi">
            <div className="l">待機日数</div>
            <div className="v wh">{shortStats.waitDays}</div>
          </div>
          <div className="kpi">
            <div className="l">待機後続勝率</div>
            <div className="v" style={{ color: shortStats.postWaitWinRate >= 70 ? 'var(--g)' : shortStats.postWaitWinRate >= 55 ? 'var(--a)' : 'var(--d)' }}>
              {shortStats.postWaitWinRate.toFixed(1)}%
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginBottom: 10 }}>
          <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '8px 10px', background: 'rgba(45,212,160,.06)' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>VIXフィルター提案（Bull）</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--g)' }}>
              VIX ≤ {shortTuning.recommendedBullVixMax.toFixed(1)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--d)', marginTop: 3 }}>
              該当 {shortTuning.bullSample}件 / 勝率 {shortTuning.bullWinRate.toFixed(1)}%
            </div>
          </div>
          <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '8px 10px', background: 'rgba(232,64,90,.06)' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>VIXフィルター提案（Bear）</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--r)' }}>
              VIX ≥ {shortTuning.recommendedBearVixMin.toFixed(1)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--d)', marginTop: 3 }}>
              該当 {shortTuning.bearSample}件 / 勝率 {shortTuning.bearWinRate.toFixed(1)}%
            </div>
          </div>
        </div>

        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 6 }}>
          直近90日トレース（新しい順）
        </div>
        {shortEntries.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
            追跡データがありません。T7の短期モード判定またはCSV更新後に自動蓄積されます。
          </div>
        ) : (
          shortEntries.slice(0, 12).map((entry, idx) => (
            <div key={`${entry.date}-${idx}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--b1)' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', minWidth: 64 }}>
                {entry.date.slice(5)}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: shortDecisionColor(entry.decision), minWidth: 50 }}>
                {entry.decision}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', minWidth: 58 }}>
                conf {entry.confidence}%
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', minWidth: 44 }}>
                {entry.conditionsPassed}/4
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', minWidth: 52 }}>
                VIX {entry.vix.toFixed(1)}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: shortOutcomeColor(entry.outcome), minWidth: 46 }}>
                {entry.outcome}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: entry.executed ? 'var(--g)' : 'var(--a)' }}>
                {entry.executed ? 'executed' : 'watch'}
              </span>
            </div>
          ))
        )}
      </div>

      {/* ── ゼロベース売買提案（理由/利確/損切/前提崩れ） ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">
          売買提案（ゼロベース）
          <span className="badge live" style={{ marginLeft: 8 }}>{zeroPlan.board.modeLabel}</span>
        </div>
        {zeroPlan.proposals.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '8px 0' }}>
            売買提案なし
          </div>
        ) : (
          zeroPlan.proposals.slice(0, 6).map((p, i) => (
            <div key={p.id} style={{
              background: p.action === 'SELL' ? 'rgba(232,64,90,.06)' : p.action === 'BUY' ? 'rgba(45,212,160,.06)' : 'rgba(212,160,23,.06)',
              border: `1px solid ${p.action === 'SELL' ? 'rgba(232,64,90,.3)' : p.action === 'BUY' ? 'var(--g3)' : 'rgba(212,160,23,.25)'}`,
              borderLeft: `3px solid ${p.action === 'SELL' ? 'var(--r)' : p.action === 'BUY' ? 'var(--g)' : 'var(--a)'}`,
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>#{i + 1}</span>
                <span className={`vd ${p.action === 'SELL' ? 'sell' : p.action === 'BUY' ? 'buy' : 'wait'}`}>{p.action}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--w)', fontWeight: 700 }}>
                  {p.name} ({p.code})
                </span>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: p.action === 'SELL' ? 'var(--r)' : p.action === 'BUY' ? 'var(--g)' : 'var(--a)' }}>
                  {p.amount > 0 ? formatJPYAuto(p.amount) : '金額なし'}
                </span>
              </div>

              <div style={{ fontSize: 11, color: 'var(--d)', marginBottom: 6, lineHeight: 1.6 }}>
                {p.reason}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10, lineHeight: 1.55 }}>
                <div style={{ color: 'var(--c)' }}>根拠: {p.rule.entryRationale}</div>
                <div style={{ color: 'var(--d)' }}>保有前提: {p.rule.holdingPremise}</div>
                <div style={{ color: 'var(--g)' }}>利確条件: {p.rule.takeProfit}</div>
                <div style={{ color: 'var(--r)' }}>損切条件: {p.rule.stopLoss}</div>
                <div style={{ color: 'var(--a)' }}>前提崩れ: {p.rule.invalidation}</div>
                <div style={{ color: 'var(--d)' }}>分割執行: {p.rule.splitExecution}</div>
              </div>

              <div style={{ marginTop: 6, fontSize: 10, color: 'var(--d)' }}>
                逆ポジ判定: {p.rule.reverseSignal}
              </div>

              <button
                onClick={() => logAction(p.action === 'WAIT' ? 'HOLD' : p.action, p.code, `${p.reason} / ${p.rule.takeProfit}`)}
                style={{
                  marginTop: 8,
                  background: 'rgba(104,150,200,.15)',
                  border: '1px solid var(--b1)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--c)',
                }}
              >
                実行ログに記録
              </button>
            </div>
          ))
        )}
      </div>

      {/* ── ウォッチリスト ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">ウォッチリスト <span className="badge">localStorage</span></div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            value={wCode} onChange={e => setWCode(e.target.value)}
            placeholder="コード"
            style={{
              flex: '0 0 70px', background: 'var(--bg3)', border: '1px solid var(--b1)',
              borderRadius: 5, padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--w)',
            }}
          />
          <input
            value={wName} onChange={e => setWName(e.target.value)}
            placeholder="銘柄名"
            style={{
              flex: '1 1 80px', background: 'var(--bg3)', border: '1px solid var(--b1)',
              borderRadius: 5, padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--w)',
            }}
          />
          <input
            value={wReason} onChange={e => setWReason(e.target.value)}
            placeholder="理由"
            style={{
              flex: '2 1 100px', background: 'var(--bg3)', border: '1px solid var(--b1)',
              borderRadius: 5, padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--w)',
            }}
          />
          <button
            onClick={addWatch}
            style={{
              background: 'var(--g3)', border: '1px solid var(--g2)', borderRadius: 5,
              padding: '4px 12px', cursor: 'pointer', fontFamily: 'var(--mono)',
              fontSize: 11, color: 'var(--g)',
            }}
          >
            追加
          </button>
        </div>
        {watchlist.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>ウォッチなし</div>
        ) : (
          watchlist.map((w, i) => (
            <div key={i} className="wl-item" style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 0', borderBottom: '1px solid var(--b1)',
            }}>
              <span className="wl-code" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--c)', minWidth: 52 }}>{w.code}</span>
              <span className="wl-name" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--w)', flex: 1 }}>{w.name}</span>
              <span className="wl-reason" style={{ fontSize: 10, color: 'var(--d)', flex: 2 }}>{w.reason}</span>
              <button
                className="wl-del"
                onClick={() => delWatch(i)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--r)', fontSize: 14, padding: '0 4px',
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* ── Half-Kelly 基準 ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">Half-Kelly 最適配分</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', whiteSpace: 'nowrap' }}>
            投資予算
          </span>
          <input
            type="range" min="500000" max="5000000" step="100000"
            value={budget}
            onChange={e => setBudget(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--w)', minWidth: 60 }}>
            {formatJPYAuto(budget)}
          </span>
        </div>
        {kellyItems.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
            Kelly計算対象銘柄なし（μ {'>'} 0.5% 以上の銘柄が必要）
          </div>
        ) : (
          kellyItems.slice(0, 8).map(k => {
            const amt = Math.round(budget * k.halfKelly / 1000) * 1000
            return (
              <div key={k.code} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 10, marginBottom: 2 }}>
                  <span style={{ color: 'var(--c)' }}>{k.code}</span>
                  <span style={{ color: 'var(--d)' }}>{k.name?.slice(0, 8)}</span>
                  <span style={{ color: 'var(--g)' }}>
                    {(k.halfKelly * 100).toFixed(1)}% = {formatJPYAuto(amt)}
                  </span>
                </div>
                <div className="sb">
                  <div className="sb-fill" style={{ width: `${k.halfKelly * 100 / 0.30 * 100}%`, background: 'var(--g2)' }} />
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── 意思決定ログ ── */}
      <div className="card">
        <div className="card-title">意思決定ログ <span className="badge">localStorage</span></div>
        {decLog.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '8px 0' }}>
            ログなし — SELL実行ボタンで記録
          </div>
        ) : (
          decLog.slice(0, 20).map((log, i) => {
            const tc = tagColor(log.action)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--b1)' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', minWidth: 60 }}>
                  {log.ts.slice(5, 16).replace('T', ' ')}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 9,
                  background: tc.bg, color: tc.color, border: `1px solid ${tc.border}`,
                  borderRadius: 8, padding: '1px 7px', flexShrink: 0,
                }}>
                  {log.action}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--c)', minWidth: 48 }}>{log.code}</span>
                <span style={{ fontSize: 10, color: 'var(--d)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.detail}
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* ── スコアブレークダウン ── */}
      {analysis.length > 0 && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="card-title">スコア ブレークダウン分布</div>
          {[
            { label: 'Fundamental', key: 'fundamentalScore', max: 30 },
            { label: 'Market',      key: 'marketScore',      max: 20 },
            { label: 'Technical',   key: 'technicalScore',   max: 20 },
            { label: 'News',        key: 'newsScore',        max: 15 },
            { label: 'Quality',     key: 'qualityScore',     max: 10 },
          ].map(s => {
            const avg = analysis.reduce((sum, a) => sum + (a[s.key as keyof typeof a] as number), 0) / analysis.length
            const pct = avg / s.max * 100
            return (
              <div key={s.label} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 10, marginBottom: 3 }}>
                  <span className="d">{s.label}</span>
                  <span style={{ color: pct >= 65 ? 'var(--g)' : pct >= 45 ? 'var(--a)' : 'var(--r)' }}>
                    {avg.toFixed(1)}/{s.max}
                  </span>
                </div>
                <div className="sb">
                  <div
                    className="sb-fill"
                    style={{
                      width: `${pct}%`,
                      background: pct >= 65 ? 'var(--g2)' : pct >= 45 ? 'var(--a)' : 'var(--r2)',
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
