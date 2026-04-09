import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'

export function T2_Holdings() {
  const holdings  = useAppStore(s => s.holdings)
  const analysis  = useAppStore(s => s.analysis)
  const metrics   = useAppStore(s => s.metrics)
  const totalEval = useAppStore(selectTotalEval)

  const decisionClass = (d: string) =>
    d === 'BUY' ? 'buy' : d === 'SELL' ? 'sell' : 'hold'

  return (
    <div className="tab-panel">

      {/* KPI グリッド */}
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

      {/* 保有銘柄テーブル */}
      <div className="card">
        <div className="card-title">
          保有銘柄 <span className="badge live">AUTO</span>
        </div>
        <div className="tw">
          <table className="dt">
            <thead>
              <tr>
                {['銘柄', '評価額', '損益率', '比率', 'スコア', 'σ', '判定'].map(h => (
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
                return (
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
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="tw-hint">← 横スクロール可 →</div>
      </div>

      {/* PnL バーチャート */}
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
