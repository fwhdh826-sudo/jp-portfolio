import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'

const sectorColors: Record<string, string> = {
  '金融':    '#6896c8',
  'HR/テック':'#2dd4a0',
  'ゲーム':  '#a78bfa',
  'エネルギー':'#f97316',
  '精密':    '#e879f9',
  '医療':    '#22c55e',
  '内需':    '#fbbf24',
  '重工':    '#94a3b8',
  '通信':    '#06b6d4',
}

function getSectorColor(sector: string): string {
  return sectorColors[sector] ?? '#4a6070'
}

export function T2_Holdings() {
  const holdings  = useAppStore(s => s.holdings)
  const analysis  = useAppStore(s => s.analysis)
  const metrics   = useAppStore(s => s.metrics)
  const totalEval = useAppStore(selectTotalEval)

  const [expandedCode, setExpandedCode] = useState<string | null>(null)

  const decisionClass = (d: string) =>
    d === 'BUY' ? 'buy' : d === 'SELL' ? 'sell' : 'hold'

  // ── セクター集中度 ──────────────────────────────────────────
  const sectorGroups = holdings.reduce<Record<string, number>>((acc, h) => {
    acc[h.sector] = (acc[h.sector] || 0) + h.eval
    return acc
  }, {})

  const sectorEntries = Object.entries(sectorGroups).sort((a, b) => b[1] - a[1])

  // ── 機関投資家スコア計算 ────────────────────────────────────
  const calcInstScore = (code: string) => {
    const h = holdings.find(x => x.code === code)
    if (!h) return { gs: 0, ms: 0, bw: 0, citadel: 0 }
    // GS Fundamental: roe, epsG, per, cfOk → 30点
    const gs = Math.round(
      (h.roe >= 12 ? 8 : h.roe >= 8 ? 5 : 2) +
      (h.epsG >= 10 ? 8 : h.epsG >= 0 ? 5 : 0) +
      (h.per <= 15 ? 8 : h.per <= 25 ? 5 : 2) +
      (h.cfOk ? 6 : 0)
    )
    // MS Technical: ma, macd, rsi, mom3m → 20点
    const ms = Math.round(
      (h.ma ? 5 : 0) +
      (h.macd ? 5 : 0) +
      (h.rsi < 70 && h.rsi > 30 ? 5 : 2) +
      (h.mom3m > 0 ? 5 : 0)
    )
    // BW Risk: sigma, pnlPct → 20点
    const bw = Math.round(
      (h.sigma < 0.25 ? 10 : h.sigma < 0.35 ? 7 : 3) +
      (h.pnlPct >= 0 ? 10 : h.pnlPct >= -10 ? 6 : 2)
    )
    // Citadel: vol, mom3m → 10点
    const citadel = Math.round(
      (h.vol ? 5 : 0) +
      (h.mom3m > 5 ? 5 : h.mom3m > 0 ? 3 : 0)
    )
    return { gs, ms, bw, citadel }
  }

  return (
    <div className="tab-panel">

      {/* ── セクター集中度バー ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">セクター集中度</div>
        {/* 積み上げ横バー */}
        <div className="conc">
          {sectorEntries.map(([sector, evalSum]) => {
            const pct = totalEval > 0 ? (evalSum / totalEval * 100) : 0
            const col = getSectorColor(sector)
            return (
              <div
                key={sector}
                className="cs"
                style={{ width: `${pct}%`, background: col, minWidth: pct > 3 ? undefined : 0 }}
                title={`${sector}: ${pct.toFixed(1)}%`}
              >
                {pct >= 8 ? `${pct.toFixed(0)}%` : ''}
              </div>
            )
          })}
        </div>
        {/* 凡例 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 8 }}>
          {sectorEntries.map(([sector, evalSum]) => {
            const pct = totalEval > 0 ? (evalSum / totalEval * 100) : 0
            const col = getSectorColor(sector)
            return (
              <div key={sector} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: col, flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
                  {sector} {pct.toFixed(1)}%
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── KPI グリッド ── */}
      {metrics && (
        <div className="kpi-row">
          <div className="kpi">
            <div className="l">期待リターン</div>
            <div className="v" style={{ color: metrics.mu >= 0 ? 'var(--g)' : 'var(--r)' }}>
              {(metrics.mu * 100).toFixed(1)}%
            </div>
          </div>
          <div className="kpi">
            <div className="l">σ</div>
            <div className="v wh">{(metrics.sigma * 100).toFixed(1)}%</div>
          </div>
          <div className="kpi">
            <div className="l">Sharpe</div>
            <div className="v" style={{
              color: metrics.sharpe >= 1 ? 'var(--g)' : metrics.sharpe >= 0.5 ? 'var(--a)' : 'var(--r)',
            }}>
              {metrics.sharpe.toFixed(2)}
            </div>
          </div>
          <div className="kpi">
            <div className="l">最大DD(推定)</div>
            <div className="v n">{(metrics.mdd * 100).toFixed(1)}%</div>
          </div>
        </div>
      )}

      {/* 追加指標 */}
      {metrics && (
        <div className="kpi-row" style={{ marginBottom: 12 }}>
          <div className="kpi">
            <div className="l">Sortino</div>
            <div className="v" style={{ color: metrics.sortino >= 1 ? 'var(--g)' : 'var(--a)' }}>
              {metrics.sortino.toFixed(2)}
            </div>
          </div>
          <div className="kpi">
            <div className="l">Calmar</div>
            <div className="v" style={{ color: metrics.calmar >= 0.5 ? 'var(--g)' : 'var(--a)' }}>
              {metrics.calmar.toFixed(2)}
            </div>
          </div>
          <div className="kpi">
            <div className="l">CVaR 95%</div>
            <div className="v n">{(metrics.cvar * 100).toFixed(1)}%</div>
          </div>
          <div className="kpi">
            <div className="l">総評価額</div>
            <div className="v wh">
              {metrics.totalEval >= 1e6
                ? `¥${(metrics.totalEval / 1e6).toFixed(2)}M`
                : `¥${(metrics.totalEval / 1000).toFixed(0)}K`}
            </div>
          </div>
        </div>
      )}

      {/* ── 保有銘柄テーブル ── */}
      <div className="card">
        <div className="card-title">
          保有銘柄 <span className="badge live">AUTO</span>
          <span style={{ fontSize: 10, color: 'var(--d)', fontWeight: 400, marginLeft: 8 }}>🏛 をタップで機関分析展開</span>
        </div>
        <div className="tw">
          <table className="dt">
            <thead>
              <tr>
                {['銘柄', '評価額', '損益率', '比率', 'スコア', 'σ', '判定', '機関'].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {holdings.map(h => {
                const a = analysis.find(x => x.code === h.code)
                const w = totalEval > 0 ? (h.eval / totalEval * 100).toFixed(1) : '0.0'
                const decision  = a?.decision ?? 'HOLD'
                const warnConc  = parseFloat(w) > 15
                const rowClass  = decision === 'SELL' ? 'hl-s' : decision === 'BUY' ? 'hl-b' : ''
                const isExpanded = expandedCode === h.code
                return (
                  <>
                    <tr key={h.code} className={rowClass}>
                      <td>
                        <div style={{ color: 'var(--w)', fontWeight: 600, fontSize: 12 }}>{h.code}</div>
                        <div style={{ fontSize: 9, color: 'var(--d)', marginTop: 1 }}>{h.name}</div>
                      </td>
                      <td className="wh">¥{(h.eval / 1000).toFixed(0)}K</td>
                      <td className={h.pnlPct >= 0 ? 'p' : 'n'}>
                        {h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(2)}%
                      </td>
                      <td style={{ color: warnConc ? 'var(--r)' : 'var(--w)' }}>{w}%</td>
                      <td className="wh">{a?.totalScore ?? '─'}</td>
                      <td className="wh">
                        {(h.sigma * 100).toFixed(1)}%
                        <span className="d" style={{ fontSize: 8, marginLeft: 3 }}>
                          {h.sigmaSource === 'yfinance' ? '実' : '推'}
                        </span>
                      </td>
                      <td>
                        <span className={`vd ${h.lock ? 'lock' : decisionClass(decision)}`}>
                          {h.lock ? '🔒' : decision}
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={() => setExpandedCode(isExpanded ? null : h.code)}
                          style={{
                            background: 'var(--bg3)', border: '1px solid var(--b1)',
                            borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--c)',
                          }}
                        >
                          🏛
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (() => {
                      const inst = calcInstScore(h.code)
                      const bars = [
                        { label: 'GS Fundamental', val: inst.gs, max: 30, col: '#6896c8' },
                        { label: 'MS Technical',   val: inst.ms, max: 20, col: '#2dd4a0' },
                        { label: 'BW Risk',        val: inst.bw, max: 20, col: '#a78bfa' },
                        { label: 'Citadel QMM',    val: inst.citadel, max: 10, col: '#f97316' },
                      ]
                      return (
                        <tr key={`${h.code}_inst`}>
                          <td colSpan={8} style={{ padding: '10px 14px', background: 'rgba(104,150,200,.05)', borderLeft: '3px solid var(--c)' }}>
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--c)', marginBottom: 8 }}>
                              🏛 機関投資家分析 — {h.code} {h.name}
                            </div>
                            {bars.map(b => (
                              <div key={b.label} style={{ marginBottom: 5 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--d)', marginBottom: 2 }}>
                                  <span>{b.label}</span>
                                  <span style={{ color: b.col }}>{b.val}/{b.max}</span>
                                </div>
                                <div className="sb">
                                  <div className="sb-fill" style={{ width: `${(b.val / b.max) * 100}%`, background: b.col }} />
                                </div>
                              </div>
                            ))}
                            <div style={{ fontSize: 9, color: 'var(--d)', marginTop: 6 }}>
                              合計: {inst.gs + inst.ms + inst.bw + inst.citadel}/80点
                            </div>
                          </td>
                        </tr>
                      )
                    })()}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="tw-hint">← 横スクロール可 →</div>
      </div>

      {/* ── PnL バーチャート ── */}
      <div className="card">
        <div className="card-title">含み損益 分布</div>
        {[...holdings]
          .sort((a, b) => b.pnlPct - a.pnlPct)
          .map(h => {
            const absMax = Math.max(...holdings.map(x => Math.abs(x.pnlPct)), 1)
            const barW   = Math.abs(h.pnlPct) / absMax * 100
            return (
              <div key={h.code} className="pnl-bar-item">
                <span className="pnl-bar-name">{h.code}</span>
                <div className="pnl-bar-track">
                  <div
                    className="pnl-bar-fill"
                    style={{
                      width: `${barW}%`,
                      background: h.pnlPct >= 0 ? 'var(--g2)' : 'var(--r2)',
                    }}
                  />
                </div>
                <span className={`pnl-bar-val ${h.pnlPct >= 0 ? 'p' : 'n'}`}>
                  {h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(1)}%
                </span>
              </div>
            )
          })}
      </div>
    </div>
  )
}
