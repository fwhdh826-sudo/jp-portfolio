import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'

export function T4_Correlation() {
  const corr     = useAppStore(s => s.correlation)
  const holdings = useAppStore(s => s.holdings)
  const metrics  = useAppStore(s => s.metrics)
  const totalEval = useAppStore(selectTotalEval)
  const analysis  = useAppStore(s => s.analysis)

  const [showMatrix, setShowMatrix] = useState(false)

  // 三菱集中度
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval, 0) / Math.max(totalEval, 1) * 100

  // ── リスクゲージ ──────────────────────────────────────────────
  const gauges = [
    {
      label: '三菱集中', val: mitsuW, max: 100,
      warn: mitsuW > 35, unit: '%', threshStr: '上限35%',
      displayVal: mitsuW.toFixed(1),
    },
    {
      label: 'σ (PF)', val: (metrics?.sigma ?? 0) * 100, max: 100,
      warn: (metrics?.sigma ?? 0) > 0.25, unit: '%', threshStr: '目標≤25%',
      displayVal: ((metrics?.sigma ?? 0) * 100).toFixed(1),
    },
    {
      label: 'Sharpe', val: metrics?.sharpe ?? 0, max: 3,
      warn: (metrics?.sharpe ?? 0) < 1, unit: '', threshStr: '目標≥1.0',
      displayVal: (metrics?.sharpe ?? 0).toFixed(2),
    },
    {
      label: 'Calmar', val: metrics?.calmar ?? 0, max: 3,
      warn: (metrics?.calmar ?? 0) < 0.5, unit: '', threshStr: '目標≥0.5',
      displayVal: (metrics?.calmar ?? 0).toFixed(2),
    },
    {
      label: 'CVaR 95%', val: Math.abs((metrics?.cvar ?? 0) * 100), max: 30,
      warn: Math.abs(metrics?.cvar ?? 0) > 0.20, unit: '%', threshStr: '上限20%',
      displayVal: Math.abs((metrics?.cvar ?? 0) * 100).toFixed(1),
    },
    {
      label: '最大DD', val: Math.abs((metrics?.mdd ?? 0) * 100), max: 50,
      warn: Math.abs(metrics?.mdd ?? 0) > 0.30, unit: '%', threshStr: '上限30%',
      displayVal: Math.abs((metrics?.mdd ?? 0) * 100).toFixed(1),
    },
  ]

  // ── ストレステスト ────────────────────────────────────────────
  const sigma = metrics?.sigma ?? 0.25
  const scenarios = [
    {
      name: 'A: リスクオフ（日経-15%）',
      impact: sigma * -15,
      detail: '関税強化・ドル高・新興国売り',
    },
    {
      name: 'B: BOJ利上げサプライズ',
      impact: sigma * -8,
      detail: '金融株↑ 成長株↓ 三菱G集中▼改善',
    },
    {
      name: 'C: 強気相場（日経+20%）',
      impact: sigma * 12,
      detail: '全面買い・レバレッジ回復・μ改善',
    },
  ]

  // ── レッドフラッグ ────────────────────────────────────────────
  interface RedFlag { code: string; flag: string; sev: 'HIGH' | 'MED'; detail: string }
  const flags: RedFlag[] = []
  holdings.forEach(h => {
    if (h.epsG < -15) flags.push({ code: h.code, flag: 'EPS急落', sev: 'HIGH', detail: `${h.epsG.toFixed(1)}%` })
    if (h.per > 50)   flags.push({ code: h.code, flag: '高PER',   sev: 'MED',  detail: `PER ${h.per.toFixed(0)}x` })
    if (h.pnlPct < -20) flags.push({ code: h.code, flag: '含み損大', sev: 'HIGH', detail: `${h.pnlPct.toFixed(1)}%` })
    if (h.sigma > 0.45) flags.push({ code: h.code, flag: '高ボラ',  sev: 'MED',  detail: `σ ${(h.sigma*100).toFixed(1)}%` })
    if (h.de > 5)     flags.push({ code: h.code, flag: '高D/E',   sev: 'MED',  detail: `D/E ${h.de.toFixed(1)}` })
  })
  // SELLフラグ
  analysis.filter(a => a.decision === 'SELL').forEach(a => {
    if (!flags.find(f => f.code === a.code && f.flag === 'SELL判定')) {
      flags.push({ code: a.code, flag: 'SELL判定', sev: 'HIGH', detail: `スコア${a.totalScore}` })
    }
  })

  // ── 相関行列 ─────────────────────────────────────────────────
  const corrVal = (ci: string, cj: string): number => {
    if (!corr) return 0
    const ki = ci + '.T', kj = cj + '.T'
    return corr.matrix[ki]?.[kj] ?? 0
  }
  const corrColor = (v: number) => {
    if (v >= 0.7)  return 'var(--r)'
    if (v >= 0.4)  return 'var(--a)'
    if (v <= -0.1) return 'var(--g)'
    return 'var(--d)'
  }
  const corrBg = (v: number) => {
    if (v >= 0.7)  return 'rgba(232,64,90,.22)'
    if (v >= 0.4)  return 'rgba(212,160,23,.16)'
    if (v <= -0.1) return 'rgba(45,212,160,.14)'
    return 'transparent'
  }
  const codes = holdings.map(h => h.code)

  return (
    <div className="tab-panel">

      {/* ── リスクゲージ 6項目 ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">リスクゲージ</div>
        <div className="rg-grid">
          {gauges.map(g => {
            const pct = Math.min(100, (g.val / g.max) * 100)
            return (
              <div key={g.label} className="rg">
                <div className="l">{g.label}</div>
                <div className="v" style={{ color: g.warn ? 'var(--r)' : 'var(--g)' }}>
                  {g.displayVal}{g.unit}
                </div>
                <div className="s" style={{ color: g.warn ? 'var(--r)' : 'var(--d)' }}>{g.threshStr}</div>
                <div className="rg-bar">
                  <div
                    className="rg-fill"
                    style={{
                      width: `${pct}%`,
                      background: g.warn ? 'var(--r2)' : 'var(--g2)',
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── ストレステスト 3シナリオ ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">ストレステスト シナリオ</div>
        {scenarios.map(sc => (
          <div key={sc.name} className="ss" style={{
            background: 'var(--bg3)', border: '1px solid var(--b1)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 6,
          }}>
            <div className="ss-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--w)' }}>{sc.name}</span>
              <span className="ss-val" style={{
                fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700,
                color: sc.impact >= 0 ? 'var(--g)' : 'var(--r)',
              }}>
                {sc.impact >= 0 ? '+' : ''}{sc.impact.toFixed(1)}%
              </span>
            </div>
            <div className="ss-detail" style={{ fontSize: 10, color: 'var(--d)' }}>{sc.detail}</div>
          </div>
        ))}
      </div>

      {/* ── レッドフラッグ ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">
          レッドフラッグ検出{' '}
          {flags.length > 0 && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--r)', background: 'rgba(232,64,90,.15)',
              border: '1px solid var(--r2)', borderRadius: 10, padding: '1px 7px', marginLeft: 6,
            }}>
              {flags.length}件
            </span>
          )}
        </div>
        {flags.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--g)', padding: '8px 0' }}>
            ✓ レッドフラッグなし — ポートフォリオ健全
          </div>
        ) : (
          flags.map((f, i) => (
            <div key={i} className="log" style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 0', borderBottom: '1px solid var(--b1)',
            }}>
              <span className="log-ts" style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--w)', minWidth: 52,
              }}>
                {f.code}
              </span>
              <span className={`log-tag ${f.sev === 'HIGH' ? 'lt-sell' : 'lt-hold'}`}>
                {f.flag}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginLeft: 'auto' }}>
                {f.detail}
              </span>
            </div>
          ))
        )}
      </div>

      {/* ── 相関行列（collapsible） ── */}
      <div className="card">
        <button
          onClick={() => setShowMatrix(prev => !prev)}
          style={{
            width: '100%', textAlign: 'left', background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <div className="card-title" style={{ flex: 1, margin: 0 }}>
            相関行列 {corr ? <span className="badge live">実測</span> : <span className="badge">未ロード</span>}
          </div>
          <span style={{ color: 'var(--d)', fontSize: 12 }}>{showMatrix ? '▲' : '▼'}</span>
        </button>

        {showMatrix && (
          corr ? (
            <>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: 8, marginTop: 8 }}>
                更新: {corr.last_updated} / 期間: {corr.period}
              </div>
              <div className="tw">
                <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'var(--mono)' }}>
                  <thead>
                    <tr>
                      <th style={{ padding: '4px 8px', color: 'var(--d)', background: 'var(--bg3)' }}></th>
                      {codes.map(c => (
                        <th key={c} style={{
                          padding: '4px 6px', color: 'var(--w)', background: 'var(--bg3)',
                          writingMode: 'vertical-rl', textOrientation: 'mixed', height: 56, fontSize: 9,
                        }}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {codes.map(ci => {
                      const hi = holdings.find(h => h.code === ci)
                      return (
                        <tr key={ci}>
                          <td style={{ padding: '4px 8px', color: 'var(--w)', whiteSpace: 'nowrap', fontSize: 9, background: 'var(--bg3)', position: 'sticky', left: 0 }}>
                            {ci} <span style={{ color: 'var(--d)' }}>{hi?.name?.slice(0, 4)}</span>
                          </td>
                          {codes.map(cj => {
                            const v = corrVal(ci, cj)
                            const isDiag = ci === cj
                            return (
                              <td key={cj} style={{
                                padding: '3px 4px',
                                textAlign: 'center',
                                background: isDiag ? 'rgba(45,212,160,.1)' : corrBg(v),
                                color: isDiag ? 'var(--g)' : corrColor(v),
                                fontWeight: isDiag ? 700 : 400,
                                minWidth: 36,
                              }}>
                                {isDiag ? '1.00' : v.toFixed(2)}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
                {[
                  { label: '高相関 ≥0.7', color: 'var(--r)' },
                  { label: '中相関 ≥0.4', color: 'var(--a)' },
                  { label: '低相関 <0.4', color: 'var(--d)' },
                  { label: '負相関 <0',   color: 'var(--g)' },
                ].map(l => (
                  <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{
                      width: 10, height: 10, borderRadius: 2,
                      background: `${l.color}44`, border: `1px solid ${l.color}`,
                    }} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>{l.label}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '12px 0' }}>
              相関データ未ロード — GitHub Actions が毎平日 8:30 JST に自動生成します
            </div>
          )
        )}
      </div>
    </div>
  )
}
