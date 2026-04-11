import { useAppStore } from '../store/useAppStore'
import { selectTotalEval, selectTotalPnl, selectIsLoading } from '../store/selectors'
import { formatJPYAuto, formatPctRaw } from '../utils/format'

export function StatusBar() {
  const system    = useAppStore(s => s.system)
  const market    = useAppStore(s => s.market)
  const macro     = useAppStore(s => s.macro)
  const metrics   = useAppStore(s => s.metrics)
  const holdings  = useAppStore(s => s.holdings)
  const totalEval = useAppStore(selectTotalEval)
  const totalPnl  = useAppStore(selectTotalPnl)
  const isLoading = useAppStore(selectIsLoading)
  const refresh   = useAppStore(s => s.refreshAllData)

  const pnlPct   = totalEval > 0 ? (totalPnl / (totalEval - totalPnl)) * 100 : 0
  const pnlColor = pnlPct >= 0 ? 'var(--g)' : 'var(--r)'
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
  const uptimeStr = now.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit', weekday: 'short' })

  // ティッカー
  const tickers = holdings.map(h => ({ code: h.code, name: h.name, pnlPct: h.pnlPct, warn: h.pnlPct < -15 || h.pnlPct > 100 }))
  const tickerDbl = [...tickers, ...tickers]

  // マクロ4指標（朝メモ形式）
  const macroItems: { label: string; val: string; chg: string; isUp: boolean | null }[] = macro
    ? [
        {
          label: 'S&P500',
          val: macro.sp500.toLocaleString('en-US', { maximumFractionDigits: 0 }),
          chg: formatPctRaw(macro.sp500ChgPct, 1),
          isUp: macro.sp500ChgPct >= 0,
        },
        {
          label: 'VIX',
          val: macro.vix.toFixed(2),
          chg: macro.vixChg >= 0 ? `+${macro.vixChg.toFixed(2)}` : `${macro.vixChg.toFixed(2)}`,
          isUp: macro.vixChg < 0,  // VIXは下落が"良い"
        },
        {
          label: 'ドル円',
          val: macro.usdjpy.toFixed(2),
          chg: formatPctRaw(macro.usdjpyChgPct, 2),
          isUp: null,  // 中立表示
        },
        {
          label: 'NY原油',
          val: macro.nyCrude.toFixed(2),
          chg: formatPctRaw(macro.nyCrudeChgPct, 1),
          isUp: macro.nyCrudeChgPct >= 0,
        },
      ]
    : []

  return (
    <header className="v5-hdr">
      {/* ── Row1: ロゴ + バッジ + 日時 + レジーム + 更新ボタン ── */}
      <div className="hdr1">
        <div className="logo">JP株OS <em>v9.1</em></div>
        <div className="ver-badge">PORTFOLIO ENGINE</div>
        <div className="uptime">{uptimeStr}</div>
        <div className={`market-pill ${regimePill.cls}`}>{regimePill.lbl}</div>
        <button
          className={`hdr-refresh-btn${isLoading ? ' spinning' : ''}`}
          onClick={refresh}
          disabled={isLoading}
          title="全データ更新"
        >
          ↺
        </button>
      </div>

      {/* ── Row2: マクロ4指標（朝メモ形式）── */}
      {macroItems.length > 0 && (
        <div className="macro-strip">
          {macroItems.map(item => (
            <div key={item.label} className="macro-cell">
              <span className="macro-label">{item.label}</span>
              <span className="macro-val">{item.val}</span>
              <span
                className="macro-chg"
                style={{
                  color: item.isUp === null
                    ? 'var(--d)'
                    : item.isUp ? 'var(--g)' : 'var(--r)',
                  background: item.isUp === null
                    ? 'rgba(74,96,112,.25)'
                    : item.isUp ? 'rgba(45,212,160,.18)' : 'rgba(232,64,90,.18)',
                  border: `1px solid ${item.isUp === null ? 'var(--b1)' : item.isUp ? 'var(--g2)' : 'var(--r2)'}55`,
                }}
              >
                {item.chg}
              </span>
            </div>
          ))}
          {/* 日経VI + SQ情報 */}
          {macro && (
            <div className="macro-cell">
              <span className="macro-label">日経VI</span>
              <span className="macro-val">{macro.nikkeiVI.toFixed(1)}</span>
              <span
                className="macro-chg"
                style={{
                  color: macro.nikkeiVIChg < 0 ? 'var(--g)' : macro.nikkeiVIChg > 2 ? 'var(--r)' : 'var(--a)',
                  background: macro.nikkeiVIChg < 0 ? 'rgba(45,212,160,.18)' : macro.nikkeiVIChg > 2 ? 'rgba(232,64,90,.18)' : 'rgba(212,160,23,.18)',
                  border: `1px solid ${macro.nikkeiVIChg < 0 ? 'var(--g2)' : macro.nikkeiVIChg > 2 ? 'var(--r2)' : 'var(--a2)'}55`,
                }}
              >
                {macro.nikkeiVIChg >= 0 ? '+' : ''}{macro.nikkeiVIChg.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Row3: 目標進捗バー ── */}
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

      {/* ── Row4: stat-strip ── */}
      <div className="stat-strip">
        <div className="stat">
          <span className="l">評価額</span>
          <span className="v wh">{formatJPYAuto(totalEval)}</span>
        </div>
        <div className="stat">
          <span className="l">含み損益</span>
          <span className={`v ${totalPnl >= 0 ? 'p' : 'n'}`}>
            {totalPnl >= 0 ? '+' : ''}{formatJPYAuto(totalPnl)}
          </span>
        </div>
        <div className="stat">
          <span className="l">σ(PF)</span>
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
          <span className="v wh">{market.nikkei.toLocaleString('ja-JP')}</span>
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

      {/* ── エラーバー ── */}
      {system.error && (
        <div className="alert-bar">
          <span style={{ animation: 'blink .6s ease infinite', flexShrink: 0 }}>⚡</span>
          <span className="alert-txt">✗ {system.error}</span>
        </div>
      )}

      {/* ── ティッカー（銘柄名スクロール）── */}
      {tickerDbl.length > 0 && (
        <div className="ticker">
          <div className="ticker-inner">
            {tickerDbl.map((item, i) => (
              <span key={i} className="ti">
                <span className="tc">{item.name}{item.warn ? '⚠' : ''}</span>
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
