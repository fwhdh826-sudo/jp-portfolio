import { useAppStore } from '../store/useAppStore'
import { selectTotalEval, selectTotalPnl, selectIsLoading } from '../store/selectors'

export function StatusBar() {
  const system    = useAppStore(s => s.system)
  const market    = useAppStore(s => s.market)
  const metrics   = useAppStore(s => s.metrics)
  const holdings  = useAppStore(s => s.holdings)
  const totalEval = useAppStore(selectTotalEval)
  const totalPnl  = useAppStore(selectTotalPnl)
  const isLoading = useAppStore(selectIsLoading)
  const refresh   = useAppStore(s => s.refreshAllData)

  // フォーマット
  const fmtY = (n: number) =>
    n >= 1e6 ? `¥${(n / 1e6).toFixed(2)}M` : `¥${(n / 1000).toFixed(0)}K`
  const pnlPct = totalEval > 0 ? (totalPnl / (totalEval - totalPnl)) * 100 : 0
  const pnlColor = pnlPct >= 0 ? 'var(--g)' : 'var(--r)'

  // 目標進捗（+15%/年）
  const progress = Math.min(100, Math.max(0, pnlPct / 15 * 100))

  // 三菱G集中度
  const mitsuEval = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval, 0)
  const mitsuW    = totalEval > 0 ? (mitsuEval / totalEval * 100) : 0

  // レジームpill
  const regimePill = market.regime === 'bull'
    ? { cls: 'bull',    lbl: '▲ BULL' }
    : market.regime === 'bear'
    ? { cls: 'bear',    lbl: '▼ BEAR' }
    : { cls: 'neutral', lbl: '● NEUTRAL' }

  // 日時
  const now = new Date()
  const uptimeStr = now.toLocaleDateString('ja-JP', {
    month: '2-digit', day: '2-digit', weekday: 'short',
  })

  // ティッカー（holdings × 2 でシームレスループ）
  const tickers = holdings.map(h => ({
    code:   h.code,
    pnlPct: h.pnlPct,
    warn:   h.pnlPct < -15 || h.pnlPct > 100,
  }))
  const tickerDbl = [...tickers, ...tickers]

  return (
    <header className="v5-hdr">
      {/* hdr1: ロゴ + バッジ + 日時 + レジームpill + 更新ボタン */}
      <div className="hdr1">
        <div className="logo">JP株OS <em>v8.3</em></div>
        <div className="ver-badge">DECISION OS</div>
        <div className="uptime">{uptimeStr}</div>
        <div className={`market-pill ${regimePill.cls}`}>{regimePill.lbl}</div>
        <button
          className={`hdr-refresh-btn${isLoading ? ' spinning' : ''}`}
          onClick={refresh}
          disabled={isLoading}
          title="データ更新"
        >
          ↺
        </button>
      </div>

      {/* tgt-bar: 目標進捗バー + Sharpe */}
      <div className="tgt-bar">
        <span className="tgt-label">目標+15%/年</span>
        <div className="tgt-track">
          <div className="tgt-fill" style={{ width: `${progress}%`, background: pnlColor }} />
        </div>
        <span className="tgt-val" style={{ color: pnlColor }}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginLeft: 4 }}>
          Sharpe
        </span>
        <span className="tgt-val" style={{
          marginLeft: 2,
          color: metrics
            ? (metrics.sharpe >= 1 ? 'var(--g)' : metrics.sharpe >= 0.5 ? 'var(--a)' : 'var(--r)')
            : 'var(--d)',
        }}>
          {metrics ? metrics.sharpe.toFixed(2) : '─'}
        </span>
      </div>

      {/* stat-strip: 水平スクロール数値列 */}
      <div className="stat-strip">
        <div className="stat">
          <span className="l">評価額</span>
          <span className="v wh">{fmtY(totalEval)}</span>
        </div>
        <div className="stat">
          <span className="l">含み損益</span>
          <span className={`v ${totalPnl >= 0 ? 'p' : 'n'}`}>
            {totalPnl >= 0 ? '+' : ''}{fmtY(totalPnl)}
          </span>
        </div>
        <div className="stat">
          <span className="l">σ</span>
          <span className="v w">
            {metrics ? `${(metrics.sigma * 100).toFixed(1)}%` : '─'}
          </span>
        </div>
        <div className="stat">
          <span className="l">CVaR 95%</span>
          <span className="v n">
            {metrics ? `${(metrics.cvar * 100).toFixed(1)}%` : '─'}
          </span>
        </div>
        <div className="stat">
          <span className="l">日経</span>
          <span className="v wh">{market.nikkei.toLocaleString()}</span>
        </div>
        <div className="stat">
          <span className="l">VIX</span>
          <span className={`v ${market.vix > 25 ? 'n' : market.vix > 20 ? 'w' : 'wh'}`}>
            {market.vix}
          </span>
        </div>
        {mitsuW > 40 && (
          <div className="stat">
            <span className="l">三菱集中</span>
            <span className="v n blink">{mitsuW.toFixed(1)}%⚠</span>
          </div>
        )}
        <div className="stat">
          <span className="l">相関</span>
          <span className={`v ${system.dataSourceStatus.correlation === 'loaded' ? 'p' : 'd'}`}>
            {system.dataSourceStatus.correlation === 'loaded' ? '✓' : '─'}
          </span>
        </div>
        <div className="stat">
          <span className="l">状態</span>
          <span className="v" style={{
            color: system.status === 'loading' ? 'var(--a)'
                 : system.status === 'error'   ? 'var(--r)'
                 : 'var(--g)',
          }}>
            {system.status === 'loading' ? '更新中' : system.status === 'error' ? 'ERR' : 'LIVE'}
          </span>
        </div>
      </div>

      {/* alert-bar: エラー時のみ */}
      {system.error && (
        <div className="alert-bar">
          <span style={{ animation: 'blink .6s ease infinite', flexShrink: 0 }}>⚡</span>
          <span className="alert-txt">✗ {system.error}</span>
        </div>
      )}

      {/* ticker: 銘柄横スクロール */}
      {tickerDbl.length > 0 && (
        <div className="ticker">
          <div className="ticker-inner">
            {tickerDbl.map((item, i) => (
              <span key={i} className="ti">
                <span className="tc">{item.code}{item.warn ? '⚠' : ''}</span>
                <span className={item.pnlPct >= 0 ? 'chp' : 'chn'}>
                  {item.pnlPct >= 0 ? '▲' : '▼'}{Math.abs(item.pnlPct).toFixed(1)}%
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </header>
  )
}
