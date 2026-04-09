import { useAppStore } from '../../store/useAppStore'

export function T5_Backtest() {
  const analysis = useAppStore(s => s.analysis)
  const metrics  = useAppStore(s => s.metrics)
  const system   = useAppStore(s => s.system)

  const buy  = analysis.filter(a => a.decision === 'BUY')
  const hold = analysis.filter(a => a.decision === 'HOLD')
  const sell = analysis.filter(a => a.decision === 'SELL')

  const avgEV   = analysis.length > 0
    ? (analysis.reduce((s, a) => s + a.ev, 0) / analysis.length * 100).toFixed(2)
    : '─'
  const avgConf = analysis.length > 0
    ? (analysis.reduce((s, a) => s + a.confidence, 0) / analysis.length * 100).toFixed(0)
    : '─'
  const avgScore = analysis.length > 0
    ? (analysis.reduce((s, a) => s + a.totalScore, 0) / analysis.length).toFixed(1)
    : '─'

  return (
    <div className="tab-panel">
      {/* 最終分析日時 */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: 10 }}>
        最終分析: {system.analysisLastRunAt?.slice(0, 19).replace('T', ' ') ?? '─'}
      </div>

      {/* BUY/HOLD/SELL件数 */}
      <div className="grid3r" style={{ marginBottom: 10 }}>
        {[
          { label: 'BUY',  n: buy.length,  color: 'var(--g)',  sub: 'score≥75 & EV>0' },
          { label: 'HOLD', n: hold.length, color: 'var(--c)',  sub: 'score≥50' },
          { label: 'SELL', n: sell.length, color: 'var(--r)',  sub: 'score<50' },
        ].map(c => (
          <div key={c.label} style={{
            background: `${c.color}11`,
            border: `1px solid ${c.color}33`,
            borderRadius: 10,
            padding: '12px 10px',
            textAlign: 'center',
          }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 28, fontWeight: 700, color: c.color }}>
              {c.n}
            </div>
            <div style={{ fontFamily: 'var(--head)', fontSize: 9, color: c.color, letterSpacing: '.08em', margin: '2px 0' }}>
              {c.label}
            </div>
            <div style={{ fontSize: 9, color: 'var(--d)' }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* スコア/EV/信頼度 */}
      <div className="kpi-row">
        <div className="kpi">
          <div className="l">平均スコア</div>
          <div className="v wh">{avgScore}</div>
        </div>
        <div className="kpi">
          <div className="l">平均EV</div>
          <div className="v" style={{ color: parseFloat(avgEV) >= 0 ? 'var(--g)' : 'var(--r)' }}>
            {avgEV}%
          </div>
        </div>
        <div className="kpi">
          <div className="l">平均Confidence</div>
          <div className="v wh">{avgConf}%</div>
        </div>
        <div className="kpi">
          <div className="l">評価銘柄数</div>
          <div className="v wh">{analysis.length}</div>
        </div>
      </div>

      {/* リスク指標 */}
      {metrics && (
        <div className="card">
          <div className="card-title">ポートフォリオ リスク指標</div>
          <div className="rg-grid">
            {[
              { label: 'Sharpe',  val: metrics.sharpe.toFixed(2),  ok: metrics.sharpe >= 1.0,  thr: '≥1.0' },
              { label: 'Sortino', val: metrics.sortino.toFixed(2), ok: metrics.sortino >= 1.5, thr: '≥1.5' },
              { label: 'Calmar',  val: metrics.calmar.toFixed(2),  ok: metrics.calmar >= 1.0,  thr: '≥1.0' },
            ].map(m => (
              <div key={m.label} className="rg">
                <div className="l">{m.label}</div>
                <div className="v" style={{ color: m.ok ? 'var(--g)' : 'var(--a)' }}>{m.val}</div>
                <div className="s">閾値 {m.thr}</div>
                <div className="rg-bar">
                  <div
                    className="rg-fill"
                    style={{
                      width: `${Math.min(100, parseFloat(m.val) / parseFloat(m.thr.replace('≥', '')) * 100)}%`,
                      background: m.ok ? 'var(--g2)' : 'var(--a)',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--b1)', paddingTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 11 }}>
            <span className="d">最大DD: <span className="n">{(metrics.mdd * 100).toFixed(1)}%</span></span>
            <span className="d">CVaR95%: <span className="n">{(metrics.cvar * 100).toFixed(1)}%</span></span>
            <span className="d">期待リターン: <span style={{ color: metrics.mu >= 0 ? 'var(--g)' : 'var(--r)' }}>{(metrics.mu * 100).toFixed(1)}%</span></span>
          </div>
        </div>
      )}

      {/* スコアブレークダウン */}
      {analysis.length > 0 && (
        <div className="card">
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

      <div className="card c-glow">
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--c)' }}>
          ℹ️ バックテスト履歴はCSV取込時に自動記録されます（将来実装）。
          現時点は現在スナップショットの分析結果を表示しています。
        </span>
      </div>
    </div>
  )
}
