import { useAppStore } from '../../store/useAppStore'

export function T3_Regime() {
  const market   = useAppStore(s => s.market)
  const metrics  = useAppStore(s => s.metrics)
  const analysis = useAppStore(s => s.analysis)

  const regimeColor = market.regime === 'bull' ? 'var(--g)' : market.regime === 'bear' ? 'var(--r)' : 'var(--c)'
  const regimeBg    = market.regime === 'bull' ? 'rgba(45,212,160,.06)' : market.regime === 'bear' ? 'rgba(232,64,90,.06)' : 'rgba(104,150,200,.06)'
  const rsiColor    = market.rsi14 > 70 ? 'var(--r)' : market.rsi14 < 30 ? 'var(--g)' : 'var(--a)'

  const dist = { buy: 0, hold: 0, sell: 0 }
  analysis.forEach(a => {
    if (a.decision === 'BUY') dist.buy++
    else if (a.decision === 'SELL') dist.sell++
    else dist.hold++
  })
  const total = analysis.length || 1

  return (
    <div className="tab-panel">

      {/* レジームカード */}
      <div style={{
        background: regimeBg,
        border: `1px solid ${regimeColor}44`,
        borderLeft: `4px solid ${regimeColor}`,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--head)', fontSize: 9, color: 'var(--d)', letterSpacing: '.15em', marginBottom: 4 }}>
              現在レジーム
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 32, fontWeight: 700, color: regimeColor }}>
              {market.regime.toUpperCase()}
            </div>
          </div>
          <div className="kpi-row" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <div className="kpi" style={{ minWidth: 0 }}>
              <div className="l">日経225</div>
              <div className="v wh">{market.nikkei.toLocaleString()}</div>
            </div>
            <div className="kpi" style={{ minWidth: 0 }}>
              <div className="l">VIX</div>
              <div className="v" style={{ color: market.vix > 25 ? 'var(--r)' : market.vix > 20 ? 'var(--a)' : 'var(--g)' }}>
                {market.vix}
              </div>
            </div>
            <div className="kpi" style={{ minWidth: 0 }}>
              <div className="l">RSI(14)</div>
              <div className="v" style={{ color: rsiColor }}>{market.rsi14}</div>
            </div>
            <div className="kpi" style={{ minWidth: 0 }}>
              <div className="l">MACD</div>
              <div className="v" style={{ color: market.macd === 'golden' ? 'var(--g)' : 'var(--r)', fontSize: 11 }}>
                {market.macd === 'golden' ? 'GC' : 'DC'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 移動平均 */}
      <div className="card">
        <div className="card-title">移動平均 水準</div>
        {[
          { label: 'MA5',  val: market.ma5,  isAbove: market.nikkei > market.ma5 },
          { label: 'MA25', val: market.ma25, isAbove: market.nikkei > market.ma25 },
          { label: 'MA75', val: market.ma75, isAbove: market.nikkei > market.ma75 },
        ].map(m => {
          const pct = Math.abs((market.nikkei - m.val) / m.val * 100)
          return (
            <div key={m.label} className="pr-row">
              <div className="pr-label">
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--d)', minWidth: 40 }}>{m.label}</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--w)' }}>{m.val.toLocaleString()}</span>
                <span style={{ color: m.isAbove ? 'var(--g)' : 'var(--r)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {m.isAbove ? '▲' : '▼'} {pct.toFixed(1)}%
                </span>
              </div>
              <div className="pr-bar">
                <div
                  className="pr-fill"
                  style={{
                    width: `${Math.min(100, pct * 10)}%`,
                    background: m.isAbove ? 'var(--g2)' : 'var(--r2)',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* BOJ */}
      <div className="card">
        <div className="card-title">BOJ 金利</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div className="kpi" style={{ flex: 1 }}>
            <div className="l">現在金利</div>
            <div className="v w">{market.boj}</div>
          </div>
          <div className="kpi" style={{ flex: 1 }}>
            <div className="l">次回観測</div>
            <div className="v wh">{market.bojNext}</div>
          </div>
        </div>
      </div>

      {/* スコア分布 */}
      <div className="card">
        <div className="card-title">判定分布 <span className="badge ai">AI討論</span></div>
        <div className="grid3r" style={{ marginBottom: 10 }}>
          {[
            { label: 'BUY',  n: dist.buy,  color: 'var(--g)' },
            { label: 'HOLD', n: dist.hold, color: 'var(--c)' },
            { label: 'SELL', n: dist.sell, color: 'var(--r)' },
          ].map(d => (
            <div key={d.label} style={{
              background: `${d.color}11`,
              border: `1px solid ${d.color}33`,
              borderRadius: 8,
              padding: '10px 12px',
              textAlign: 'center',
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 700, color: d.color }}>
                {d.n}
              </div>
              <div style={{ fontSize: 9, color: 'var(--d)', marginTop: 2 }}>
                {d.label} / {total}
              </div>
            </div>
          ))}
        </div>
        {metrics && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 11 }}>
            <span className="d">Sharpe: <span className="wh">{metrics.sharpe.toFixed(2)}</span></span>
            <span className="d">Sortino: <span className="wh">{metrics.sortino.toFixed(2)}</span></span>
            <span className="d">CVaR: <span className="n">{(metrics.cvar * 100).toFixed(1)}%</span></span>
          </div>
        )}
      </div>
    </div>
  )
}
