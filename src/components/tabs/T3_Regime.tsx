import { useAppStore } from '../../store/useAppStore'

export function T3_Regime() {
  const market   = useAppStore(s => s.market)
  const metrics  = useAppStore(s => s.metrics)
  const analysis = useAppStore(s => s.analysis)
  const holdings = useAppStore(s => s.holdings)
  const news     = useAppStore(s => s.news)
  const learning = useAppStore(s => s.learning)

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

  // Best AI debate holding
  const bestDebate = analysis.length > 0
    ? analysis.reduce((best, a) => a.debate.debateScore > best.debate.debateScore ? a : best, analysis[0])
    : null
  const bestHolding = bestDebate ? holdings.find(h => h.code === bestDebate.code) : null

  return (
    <div className="tab-panel">

      {/* ── テクニカル分析テーブル ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">テクニカル分析 <span className="badge ai">銘柄別</span></div>
        <div className="tw">
          <table className="dt">
            <thead>
              <tr>
                <th>銘柄</th>
                <th>MA</th>
                <th>RSI</th>
                <th>MACD</th>
                <th>出来高</th>
                <th>3M%</th>
                <th>シグナル</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map(h => {
                const techScore = (h.ma ? 4 : 0) + (h.macd ? 4 : 0) + (h.rsi < 30 ? 4 : h.rsi > 70 ? -2 : 2) + (h.vol ? 2 : 0) + (h.mom3m > 0 ? 4 : 0)
                const sig = techScore >= 12 ? 'bull' : techScore >= 6 ? 'neu' : 'bear'
                return (
                  <tr key={h.code}>
                    <td>
                      {h.code}<br />
                      <span style={{ fontSize: 9, color: 'var(--d)' }}>{h.name.slice(0, 6)}</span>
                    </td>
                    <td><span className={`signal ${h.ma ? 'bull' : 'bear'}`}>{h.ma ? '◎' : '✗'}</span></td>
                    <td style={{ color: h.rsi > 70 ? 'var(--r)' : h.rsi < 30 ? 'var(--g)' : 'var(--w)' }}>{h.rsi}</td>
                    <td><span className={`signal ${h.macd ? 'bull' : 'bear'}`}>{h.macd ? 'GC' : 'DC'}</span></td>
                    <td><span className={`signal ${h.vol ? 'bull' : 'neu'}`}>{h.vol ? '↑' : '─'}</span></td>
                    <td className={h.mom3m >= 0 ? 'p' : 'n'}>{h.mom3m >= 0 ? '+' : ''}{h.mom3m}%</td>
                    <td>
                      <span className={`signal ${sig}`}>
                        {sig === 'bull' ? 'BUY' : sig === 'bear' ? 'SELL' : 'HOLD'}
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

      {/* ── ファンダメンタル分析テーブル ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">ファンダメンタル分析 <span className="badge live">銘柄別</span></div>
        <div className="tw">
          <table className="dt">
            <thead>
              <tr>
                <th>銘柄</th>
                <th>ROE</th>
                <th>PER</th>
                <th>PBR</th>
                <th>EPS成長</th>
                <th>CF</th>
                <th>D/E</th>
                <th>配当G</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map(h => (
                <tr key={h.code}>
                  <td>
                    {h.code}<br />
                    <span style={{ fontSize: 9, color: 'var(--d)' }}>{h.name.slice(0, 6)}</span>
                  </td>
                  <td style={{ color: h.roe >= 12 ? 'var(--g)' : h.roe >= 8 ? 'var(--a)' : 'var(--r)' }}>
                    {h.roe.toFixed(1)}%
                  </td>
                  <td style={{ color: h.per > 30 ? 'var(--r)' : h.per > 20 ? 'var(--a)' : 'var(--g)' }}>
                    {h.per.toFixed(1)}x
                  </td>
                  <td style={{ color: h.pbr > 3 ? 'var(--a)' : 'var(--w)' }}>
                    {h.pbr.toFixed(2)}x
                  </td>
                  <td className={h.epsG >= 10 ? 'p' : h.epsG >= 0 ? '' : 'n'}>
                    {h.epsG >= 0 ? '+' : ''}{h.epsG.toFixed(1)}%
                  </td>
                  <td>
                    <span style={{ color: h.cfOk ? 'var(--g)' : 'var(--r)' }}>{h.cfOk ? '◎' : '✗'}</span>
                  </td>
                  <td style={{ color: h.de > 5 ? 'var(--r)' : h.de > 2 ? 'var(--a)' : 'var(--g)' }}>
                    {h.de.toFixed(1)}
                  </td>
                  <td className={h.divG >= 5 ? 'p' : 'wh'}>
                    {h.divG >= 0 ? '+' : ''}{h.divG.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tw-hint">← 横スクロール可 →</div>
      </div>

      {/* ── レジームカード ── */}
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

      {/* ── 移動平均 ── */}
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

      {/* ── BOJ ── */}
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

      {/* ── スコア分布 ── */}
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

      {/* ── 7AI 討論結果 ── */}
      {bestDebate && bestHolding && (
        <div className="card">
          <div className="card-title">
            7AI 討論結果 <span className="badge ai">最高スコア銘柄</span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--c)', marginBottom: 8 }}>
            {bestHolding.code} {bestHolding.name} — 討論スコア: {bestDebate.debate.debateScore}/100
          </div>
          {bestDebate.debate.agents.map((agent, i) => (
            <div key={i} style={{
              background: 'var(--bg3)', border: '1px solid var(--b1)',
              borderRadius: 8, padding: '8px 12px', marginBottom: 6,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--w)' }}>
                  {agent.agent}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)' }}>
                  {agent.style} — {agent.score}/100
                </span>
              </div>
              {agent.bullPoints.slice(0, 1).map((p, j) => (
                <div key={j} style={{ fontSize: 10, color: 'var(--g)', marginBottom: 2 }}>▲ {p}</div>
              ))}
              {agent.bearPoints.slice(0, 1).map((p, j) => (
                <div key={j} style={{ fontSize: 10, color: 'var(--r)' }}>▼ {p}</div>
              ))}
            </div>
          ))}
          {/* 7軸 */}
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(bestDebate.debate.sevenAxis).map(([k, v]) => (
              <div key={k} style={{ flex: '1 1 70px' }}>
                <div style={{ fontSize: 8, color: 'var(--d)', marginBottom: 2 }}>{k}</div>
                <div className="sb">
                  <div className="sb-fill" style={{
                    width: `${v}%`,
                    background: v >= 65 ? 'var(--g)' : v >= 40 ? 'var(--a)' : 'var(--r)',
                  }} />
                </div>
              </div>
            ))}
          </div>
          {/* ニュース関連銘柄 */}
          {news && news.stockNews.filter(n => n.tickers.includes(bestHolding.code)).length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px solid var(--b1)', paddingTop: 8 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>関連ニュース</div>
              {news.stockNews.filter(n => n.tickers.includes(bestHolding.code)).slice(0, 2).map(n => (
                <div key={n.id} style={{ fontSize: 10, color: n.sentimentScore > 0.3 ? 'var(--g)' : n.sentimentScore < -0.3 ? 'var(--r)' : 'var(--d)', marginBottom: 3 }}>
                  {n.title.slice(0, 50)}…
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 自己強化アルゴリズム ── */}
      {learning && (
        <div className="card">
          <div className="card-title">
            自己強化アルゴリズム <span className="badge live">prediction vs actual</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
            <div className="kpi">
              <div className="l">総判定数</div>
              <div className="v wh">{learning.summary.total}</div>
            </div>
            <div className="kpi">
              <div className="l">勝率</div>
              <div className="v" style={{ color: learning.summary.accuracy >= 55 ? 'var(--g)' : learning.summary.accuracy >= 45 ? 'var(--a)' : 'var(--r)' }}>
                {learning.summary.accuracy.toFixed(1)}%
              </div>
            </div>
            <div className="kpi">
              <div className="l">平均報酬</div>
              <div className="v" style={{ color: learning.summary.avgReward >= 0 ? 'var(--g)' : 'var(--r)' }}>
                {learning.summary.avgReward >= 0 ? '+' : ''}{learning.summary.avgReward.toFixed(3)}
              </div>
            </div>
            <div className="kpi">
              <div className="l">最終更新</div>
              <div className="v wh" style={{ fontSize: 11 }}>
                {learning.lastUpdated.slice(5, 16).replace('T', ' ')}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 8, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
            判定別精度
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
            {(['BUY', 'HOLD', 'SELL'] as const).map(key => {
              const s = learning.summary.byDecision[key]
              return (
                <div key={key} style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--b1)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: key === 'BUY' ? 'var(--g)' : key === 'SELL' ? 'var(--r)' : 'var(--c)', marginBottom: 2 }}>
                    {key}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--w)' }}>
                    {s.accuracy.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--d)' }}>
                    {s.wins}勝 / {s.losses}敗 / {s.flats}保留
                  </div>
                </div>
              )
            })}
          </div>

          <div style={{ marginBottom: 8, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
            推奨重み（次サイクル）
          </div>
          <div style={{ fontSize: 10, color: learning.summary.total >= 20 ? 'var(--g)' : 'var(--a)', marginBottom: 6 }}>
            {learning.summary.total >= 20
              ? '現在この重みを分析ロジックに適用中'
              : `適用保留（適用まであと ${Math.max(0, 20 - learning.summary.total)} 件）`}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {Object.entries(learning.suggestedWeights).map(([k, v]) => (
              <span key={k} style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                color: 'var(--c)',
                background: 'rgba(104,150,200,.12)',
                border: '1px solid var(--c2)',
                borderRadius: 8,
                padding: '2px 8px',
              }}>
                {k}:{' '}{(v * 100).toFixed(1)}%
              </span>
            ))}
          </div>

          {learning.summary.driftSignals.length > 0 && (
            <div style={{ borderTop: '1px solid var(--b1)', paddingTop: 8 }}>
              {learning.summary.driftSignals.map((sig, i) => (
                <div key={i} style={{ fontSize: 10, color: 'var(--a)', marginBottom: 3 }}>
                  • {sig}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
