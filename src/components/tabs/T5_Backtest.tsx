import { useState, useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectSellList } from '../../store/selectors'

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

export function T5_Backtest() {
  const analysis  = useAppStore(s => s.analysis)
  const holdings  = useAppStore(s => s.holdings)
  const system    = useAppStore(s => s.system)
  const sellList  = useAppStore(selectSellList)
  const buyList   = useAppStore(selectBuyList)

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

  return (
    <div className="tab-panel">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: 10 }}>
        最終分析: {system.analysisLastRunAt?.slice(0, 19).replace('T', ' ') ?? '─'}
      </div>

      {/* ── 執行オーダー（SELL） ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">
          執行オーダー{' '}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: sellList.length > 0 ? 'var(--r)' : 'var(--g)',
            background: sellList.length > 0 ? 'rgba(232,64,90,.15)' : 'rgba(45,212,160,.15)',
            borderRadius: 10, padding: '2px 8px', marginLeft: 6,
          }}>
            SELL {sellList.length}件
          </span>
        </div>
        {sellList.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--g)', padding: '8px 0' }}>
            ✓ 売却推奨銘柄なし
          </div>
        ) : (
          sellList.slice(0, 3).map((a, i) => {
            const h = holdings.find(x => x.code === a.code)
            return (
              <div key={a.code} className="action-card" style={{
                background: 'rgba(232,64,90,.05)', border: '1px solid rgba(232,64,90,.25)',
                borderLeft: '3px solid var(--r)', borderRadius: 8,
                padding: '10px 14px', marginBottom: 6,
              }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--r)', marginBottom: 4 }}>
                  ORDER #{i + 1} — 売却推奨
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--w)', fontWeight: 700, marginBottom: 2 }}>
                  {h?.name ?? a.code}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', marginBottom: 6 }}>
                  {a.code} → スコア {a.totalScore}/100 / EV {(a.ev * 100).toFixed(1)}%
                </div>
                {h && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span className="wh">¥{(h.eval / 1000).toFixed(0)}K</span>
                    <span className={h.pnlPct >= 0 ? 'p' : 'n'}>
                      {h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(2)}%
                    </span>
                  </div>
                )}
                <button
                  onClick={() => logAction('SELL', a.code, `スコア${a.totalScore} EV${(a.ev*100).toFixed(1)}%`)}
                  style={{
                    marginTop: 8, background: 'rgba(232,64,90,.2)', border: '1px solid var(--r2)',
                    borderRadius: 6, padding: '4px 12px', cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--r)',
                  }}
                >
                  SELL実行 → ログ記録
                </button>
              </div>
            )
          })
        )}
      </div>

      {/* ── 再投資候補（BUY） ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">
          再投資候補 <span className="badge live">BUY {buyList.length}件</span>
        </div>
        {buyList.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '8px 0' }}>
            BUY候補なし
          </div>
        ) : (
          buyList.slice(0, 5).map(a => {
            const h = holdings.find(x => x.code === a.code)
            const halfK = h ? Math.min(0.30, Math.max(0, ((h.mu - 0.005) / (h.sigma * h.sigma)) * 0.5)) : 0
            const investAmt = Math.round(budget * halfK / 1000) * 1000
            return (
              <div key={a.code} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 0', borderBottom: '1px solid var(--b1)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--g)', fontWeight: 700 }}>{a.code}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginLeft: 6 }}>
                    {h?.name?.slice(0, 8)}
                  </span>
                </div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--w)' }}>
                  {(halfK * 100).toFixed(1)}% Kelly
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--g)' }}>
                  ¥{(investAmt / 1000).toFixed(0)}K
                </span>
              </div>
            )
          })
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
            ¥{(budget / 1e6).toFixed(1)}M
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
                    {(k.halfKelly * 100).toFixed(1)}% = ¥{(amt / 1000).toFixed(0)}K
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
