import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectSellList, selectHoldList } from '../../store/selectors'
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

// ── T1_Decision ───────────────────────────────────────────────
export function T1_Decision() {
  const buyList   = useAppStore(selectBuyList)
  const sellList  = useAppStore(selectSellList)
  const holdList  = useAppStore(selectHoldList)
  const analysis  = useAppStore(s => s.analysis)
  const metrics   = useAppStore(s => s.metrics)
  const importCsv = useAppStore(s => s.importCsv)
  const system    = useAppStore(s => s.system)

  const health = calcHealth(analysis)
  const hs     = healthStatus(health.score)

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
