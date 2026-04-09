import { useState, useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectSellList, selectHoldList, selectTotalEval } from '../../store/selectors'
import type { HoldingAnalysis } from '../../types'

// ── Portfolio Health Score 計算 ──────────────────────────────
function calcHealth(analysis: HoldingAnalysis[]) {
  if (analysis.length === 0) return { score: 0, ret: 0, risk: 0, exec: 0, div: 0 }
  const avgScore = analysis.reduce((s, a) => s + a.totalScore, 0) / analysis.length
  const sellRatio = analysis.filter(a => a.decision === 'SELL').length / analysis.length
  const buyRatio  = analysis.filter(a => a.decision === 'BUY').length  / analysis.length
  const ret  = Math.round(avgScore * 0.4)
  const risk = Math.round((1 - sellRatio) * 30)
  const exec = Math.round(buyRatio * 20)
  const div  = Math.round(Math.min(analysis.length / 15, 1) * 10)
  return { score: Math.min(100, ret + risk + exec + div), ret, risk, exec, div }
}

function healthStatus(score: number): { label: string; color: string } {
  if (score >= 80) return { label: '◎ 優良 — 維持推奨',         color: 'var(--g)' }
  if (score >= 60) return { label: '○ 良好 — 微調整余地あり',    color: 'var(--a)' }
  if (score >= 40) return { label: '⚠ 問題あり — 即アクション必要', color: 'var(--a)' }
  return             { label: '✗ 要緊急対応',                    color: 'var(--r)' }
}

// ── DecisionCard ─────────────────────────────────────────────
function DecisionCard({ code, totalScore, ev, decision, confidence, debate }: HoldingAnalysis) {
  const holding = useAppStore(s => s.holdings.find(h => h.code === code))
  if (!holding) return null

  const verdictClass = decision === 'BUY' ? 'buy' : decision === 'SELL' ? 'sell' : 'hold'
  const borderColor  = decision === 'BUY' ? 'var(--g)' : decision === 'SELL' ? 'var(--r)' : 'var(--c)'
  const bgColor      = decision === 'BUY' ? 'rgba(45,212,160,.06)'
                     : decision === 'SELL' ? 'rgba(232,64,90,.06)' : 'rgba(104,150,200,.06)'

  const topBull = debate.agents.flatMap(a => a.bullPoints).slice(0, 2)
  const topBear = debate.agents.flatMap(a => a.bearPoints).slice(0, 1)

  return (
    <div style={{
      background: bgColor,
      border: `1px solid ${borderColor}44`,
      borderLeft: `3px solid ${borderColor}`,
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 8,
    }}>
      {/* ヘッダー行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>{code}</span>
        <span style={{ color: 'var(--w)', fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {holding.name}
        </span>
        <span className={`vd ${verdictClass}`}>{decision}</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: borderColor,
          background: `${borderColor}22`, border: `1px solid ${borderColor}55`,
          borderRadius: 12, padding: '2px 8px', flexShrink: 0,
        }}>
          {totalScore}/100
        </span>
      </div>

      {/* KPI 3列 */}
      <div className="kpi-row" style={{ marginBottom: 8 }}>
        <div className="kpi" style={{ minWidth: 0 }}>
          <div className="l">EV</div>
          <div className="v" style={{ color: ev >= 0 ? 'var(--g)' : 'var(--r)', fontSize: 14 }}>
            {ev >= 0 ? '+' : ''}{(ev * 100).toFixed(1)}%
          </div>
        </div>
        <div className="kpi" style={{ minWidth: 0 }}>
          <div className="l">Confidence</div>
          <div className="v wh" style={{ fontSize: 14 }}>{(confidence * 100).toFixed(0)}%</div>
        </div>
        <div className="kpi" style={{ minWidth: 0 }}>
          <div className="l">σ</div>
          <div className="v wh" style={{ fontSize: 14 }}>
            {(holding.sigma * 100).toFixed(1)}%
            <span className="d" style={{ fontSize: 9, marginLeft: 3 }}>
              {holding.sigmaSource === 'yfinance' ? '実' : '推'}
            </span>
          </div>
        </div>
      </div>

      {/* 理由（強気/弱気ポイント） */}
      {(topBull.length > 0 || topBear.length > 0) ? (
        <div style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>
          {topBull.map((p, i) => <div key={`b${i}`} style={{ color: 'var(--g)' }}>▲ {p}</div>)}
          {topBear.map((p, i) => <div key={`r${i}`} style={{ color: 'var(--r)' }}>▼ {p}</div>)}
        </div>
      ) : (
        <div className="d" style={{ fontSize: 11, marginBottom: 8 }}>
          AIスコア: {debate.debateScore}/100 — データ蓄積中
        </div>
      )}

      {/* 7軸スコアバー */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {Object.entries(debate.sevenAxis).map(([k, v]) => (
          <div key={k} style={{ flex: '1 1 56px' }}>
            <div style={{ fontSize: 8, color: 'var(--d)', marginBottom: 2 }}>{k}</div>
            <div className="sb">
              <div
                className="sb-fill"
                style={{
                  width: `${v}%`,
                  background: v >= 65 ? 'var(--g)' : v >= 40 ? 'var(--a)' : 'var(--r)',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Action interfaces ─────────────────────────────────────────
interface ActionItem {
  id: string
  text: string
  detail: string
  tag: 'urgent' | 'normal'
}

function loadActions(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('v83_actions') || '{}') as Record<string, boolean>
  } catch { return {} }
}

function saveActions(state: Record<string, boolean>) {
  localStorage.setItem('v83_actions', JSON.stringify(state))
}

// ── T1_Decision ───────────────────────────────────────────────
export function T1_Decision() {
  const buyList   = useAppStore(selectBuyList)
  const sellList  = useAppStore(selectSellList)
  const holdList  = useAppStore(selectHoldList)
  const analysis  = useAppStore(s => s.analysis)
  const metrics   = useAppStore(s => s.metrics)
  const holdings  = useAppStore(s => s.holdings)
  const importCsv = useAppStore(s => s.importCsv)
  const system    = useAppStore(s => s.system)
  const totalEval = useAppStore(selectTotalEval)

  const health = calcHealth(analysis)
  const hs     = healthStatus(health.score)

  // ── Today's Actions state ─────────────────────────────────
  const [actionDone, setActionDone] = useState<Record<string, boolean>>(loadActions)

  useEffect(() => {
    saveActions(actionDone)
  }, [actionDone])

  const toggleAction = (id: string) => {
    setActionDone(prev => ({ ...prev, [id]: !prev[id] }))
  }

  // Build action list: top 3 sell + 2 generic
  const actions: ActionItem[] = [
    ...sellList.slice(0, 3).map(a => ({
      id: `sell_${a.code}`,
      text: `${a.code} を売却`,
      detail: `スコア${a.totalScore}/100 — EV: ${(a.ev * 100).toFixed(1)}% — 即実行推奨`,
      tag: 'urgent' as const,
    })),
    {
      id: 'rescore',
      text: '全銘柄スコア再計算 → レジーム反映',
      detail: 'CSVを最新に更新してから実行',
      tag: 'normal' as const,
    },
    {
      id: 'deploy_check',
      text: `¥300万 デプロイ条件チェック`,
      detail: '下記デプロイ条件を全て確認',
      tag: 'normal' as const,
    },
  ]

  // ── Deploy conditions ─────────────────────────────────────
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval, 0) / Math.max(totalEval, 1) * 100

  const cond = [
    { label: 'SELL銘柄ゼロ',    met: sellList.length === 0 },
    { label: 'Sharpe ≥1.0',     met: (metrics?.sharpe ?? 0) >= 1.0 },
    { label: '三菱集中 ≤35%',    met: mitsuW <= 35 },
    { label: 'σ ≤25%',          met: (metrics?.sigma ?? 1) <= 0.25 },
  ]
  const allMet = cond.every(c => c.met)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void importCsv(file)
  }

  return (
    <div className="tab-panel">
      {/* ── TODAY'S ACTIONS ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>
          TODAY'S ACTIONS <span className="badge ai">動的生成</span>
        </div>
        {actions.map(action => {
          const done = !!actionDone[action.id]
          return (
            <div
              key={action.id}
              className={`action-check-row${done ? ' done' : ''}`}
              onClick={() => toggleAction(action.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 6px', borderRadius: 6, cursor: 'pointer',
                opacity: done ? 0.5 : 1,
                borderBottom: '1px solid var(--b1)',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <div style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                border: `2px solid ${done ? 'var(--g)' : 'var(--b1)'}`,
                background: done ? 'var(--g3)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--g)',
              }}>
                {done ? '✓' : '○'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 12, color: done ? 'var(--d)' : 'var(--w)',
                  textDecoration: done ? 'line-through' : 'none',
                }}>
                  {action.text}
                </div>
                <div style={{ fontSize: 10, color: 'var(--d)', marginTop: 2 }}>{action.detail}</div>
              </div>
              <div style={{
                flexShrink: 0,
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '2px 7px', borderRadius: 10,
                background: action.tag === 'urgent' ? 'rgba(232,64,90,.18)' : 'rgba(104,150,200,.15)',
                color: action.tag === 'urgent' ? 'var(--r)' : 'var(--c)',
                border: `1px solid ${action.tag === 'urgent' ? 'var(--r2)' : 'var(--b1)'}`,
              }}>
                {action.tag === 'urgent' ? '即実行' : 'normal'}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── デプロイ条件チェッカー ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>
          デプロイ条件チェッカー{' '}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: allMet ? 'var(--g)' : 'var(--r)',
            background: allMet ? 'rgba(45,212,160,.15)' : 'rgba(232,64,90,.15)',
            border: `1px solid ${allMet ? 'var(--g2)' : 'var(--r2)'}`,
            borderRadius: 10, padding: '2px 8px', marginLeft: 6,
          }}>
            {allMet ? '✓ 全条件クリア' : `${cond.filter(c => !c.met).length}件 未達`}
          </span>
        </div>
        <div className="dc-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {cond.map(c => (
            <div key={c.label} className={`dc-row`} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              flex: '1 1 45%', padding: '7px 10px', borderRadius: 8,
              background: c.met ? 'rgba(45,212,160,.06)' : 'rgba(232,64,90,.06)',
              border: `1px solid ${c.met ? 'var(--g3)' : 'rgba(232,64,90,.3)'}`,
            }}>
              <span className={`dc-pill ${c.met ? 'dc-met' : 'dc-unmet'}`} style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: c.met ? 'var(--g)' : 'var(--r)',
              }}>
                {c.met ? '✓' : '✗'}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: c.met ? 'var(--w)' : 'var(--d)' }}>
                {c.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Portfolio Health Score ── */}
      <div style={{
        background: 'linear-gradient(135deg,#0a1a10,#060e08)',
        border: '2px solid var(--g3)', borderRadius: 10,
        padding: '14px 14px 10px', marginBottom: 9,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <div style={{ fontFamily: 'var(--head)', fontSize: 9, color: 'var(--g)', letterSpacing: '.18em', marginBottom: 3 }}>
              PORTFOLIO HEALTH SCORE
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 46, color: 'var(--g)', textShadow: '0 0 20px rgba(45,212,160,.3)', lineHeight: 1, fontWeight: 700, letterSpacing: '-.02em' }}>
              {health.score}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: hs.color, marginTop: 2 }}>
              {hs.label}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>銘柄数</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 20, color: 'var(--d)' }}>{analysis.length}</div>
          </div>
        </div>
        {/* Breakdown bars */}
        {[
          { label: 'リターン質', val: health.ret,  max: 40, col: 'var(--g2)' },
          { label: 'リスク管理', val: health.risk, max: 30, col: 'var(--a)' },
          { label: '執行精度',  val: health.exec, max: 20, col: 'var(--c)' },
          { label: '分散度',    val: health.div,  max: 10, col: 'var(--g2)' },
        ].map(b => (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)', fontSize: 9, marginBottom: 4 }}>
            <span style={{ color: 'var(--d)', minWidth: 62 }}>{b.label}</span>
            <div className="sb">
              <div className="sb-fill" style={{ width: `${(b.val / b.max) * 100}%`, background: b.col }} />
            </div>
            <span style={{ minWidth: 26, color: 'var(--w)', textAlign: 'right' }}>{b.val}</span>
          </div>
        ))}
      </div>

      {/* ── EV Engine ── */}
      {metrics && (
        <div className="ev-box">
          <div>
            <div className="ev-label">
              PORTFOLIO EV ENGINE <span className="badge live">LIVE</span>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginTop: 2 }}>
              σ={`${(metrics.sigma * 100).toFixed(1)}%`}　Sharpe={metrics.sharpe.toFixed(2)}　Sortino={metrics.sortino.toFixed(2)}　Calmar={metrics.calmar.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="ev-label">CVaR 95%</div>
            <div className={`ev-val${metrics.cvar < 0 ? ' neg' : ''}`}>
              {metrics.cvar < 0 ? '' : '+'}{(metrics.cvar * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      )}

      {/* ── CSV D&D ── */}
      <div
        className="csv-drop"
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        style={{ marginBottom: 10 }}
      >
        <input type="file" accept=".csv" onChange={handleFileChange} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
          📁 SBI証券CSVをドロップ or タップして選択
        </div>
        {system.csvLastImportedAt && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--g)', marginTop: 5 }}>
            最終取込: {system.csvLastImportedAt.slice(0, 10)}
          </div>
        )}
      </div>

      {/* ── Error ── */}
      {system.error && (
        <div className="card r-glow" style={{ marginBottom: 10 }}>
          <span style={{ color: 'var(--r)', fontFamily: 'var(--mono)', fontSize: 12 }}>
            ✗ {system.error}
          </span>
        </div>
      )}

      {/* ── BUY ── */}
      {buyList.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ color: 'var(--g)' }}>
            ▲ BUY — {buyList.length}銘柄
          </div>
          {buyList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* ── HOLD ── */}
      {holdList.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ color: 'var(--c)' }}>
            ● HOLD — {holdList.length}銘柄
          </div>
          {holdList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* ── SELL ── */}
      {sellList.length > 0 && (
        <section>
          <div className="card-title" style={{ color: 'var(--r)' }}>
            ▼ SELL — {sellList.length}銘柄
          </div>
          {sellList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* 空状態 */}
      {buyList.length === 0 && sellList.length === 0 && holdList.length === 0 && (
        <div style={{ color: 'var(--d)', textAlign: 'center', padding: 48, fontFamily: 'var(--mono)' }}>
          分析データを読み込み中...
        </div>
      )}
    </div>
  )
}
