import { useAppStore } from '../store/useAppStore'
import { selectIsLoading, selectTotalEval, selectTotalPnl } from '../store/selectors'
import { formatDateTime, formatJPYAuto } from '../utils/format'

function pct(v: number, digits = 2) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

export function StatusBar() {
  const system   = useAppStore(s => s.system)
  const market   = useAppStore(s => s.market)
  const macro    = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const refresh  = useAppStore(s => s.refreshAllData)
  const isLoading = useAppStore(selectIsLoading)
  const totalEval = useAppStore(selectTotalEval)
  const totalPnl  = useAppStore(selectTotalPnl)

  const regime = market.regime
  const regimeLabel = regime === 'bull' ? '強気相場' : regime === 'bear' ? '弱気相場' : '中立相場'
  const regimeCls   = regime === 'bull' ? 'bull' : regime === 'bear' ? 'bear' : 'neutral'

  const indicators = [
    {
      label: '日経平均',
      value: market.nikkei.toLocaleString('ja-JP'),
      delta: pct(market.nikkeiChgPct),
      up: market.nikkeiChgPct >= 0,
    },
    {
      label: 'VIX',
      value: market.vix.toFixed(1),
      delta: macro ? pct(macro.vixChg, 2) : '—',
      up: market.vix < 20,
    },
    {
      label: 'ドル円',
      value: macro ? macro.usdjpy.toFixed(2) : '—',
      delta: macro ? pct(macro.usdjpyChgPct) : '—',
      up: true,
    },
    {
      label: '評価額',
      value: formatJPYAuto(totalEval),
      delta: `${totalPnl >= 0 ? '+' : ''}${formatJPYAuto(totalPnl)}`,
      up: totalPnl >= 0,
    },
  ]

  const sqLabel = sqCalendar?.nextSQ
    ? `SQ残${sqCalendar.nextSQ.dayUntil}日`
    : null

  return (
    <div className="status-bar" role="status" aria-label="市場概況">
      {/* 市場モード */}
      <div className="status-bar__item">
        <span className="status-bar__label">市場モード</span>
        <span className={`status-bar__value regime-${regimeCls}`}>{regimeLabel}</span>
      </div>

      <div className="status-bar__divider" />

      {/* 主要指標 */}
      {indicators.map(ind => (
        <div key={ind.label} className="status-bar__item">
          <span className="status-bar__label">{ind.label}</span>
          <span className={`status-bar__value${ind.up ? ' text-up-bar' : ' text-down-bar'}`}>
            {ind.value}
            {' '}
            <span style={{ fontSize: '10px', opacity: 0.8 }}>{ind.delta}</span>
          </span>
        </div>
      ))}

      {sqLabel && (
        <>
          <div className="status-bar__divider" />
          <div className="status-bar__item">
            <span className="status-bar__label">先物</span>
            <span className="status-bar__value"
              style={{ color: (sqCalendar?.nextSQ?.dayUntil ?? 99) <= 3 ? '#f07575' : 'inherit' }}>
              {sqLabel}
            </span>
          </div>
        </>
      )}

      <div className="status-bar__divider" />

      {/* 更新 */}
      <div className="status-bar__item" style={{ marginLeft: 'auto' }}>
        <span className="status-bar__label">最終更新</span>
        <span className="status-bar__value" style={{ fontSize: '10px' }}>
          {system.lastUpdated ? formatDateTime(system.lastUpdated) : '未更新'}
        </span>
      </div>

      <button
        onClick={() => { void refresh() }}
        disabled={isLoading}
        type="button"
        style={{
          flexShrink: 0,
          fontSize: '10px',
          padding: '3px 10px',
          background: isLoading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.15)',
          color: 'var(--color-text-on-navy)',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '4px',
          cursor: isLoading ? 'default' : 'pointer',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        {isLoading ? '更新中…' : '更新'}
      </button>

      {system.error && (
        <span style={{ fontSize: '10px', color: '#f07575', flexShrink: 0 }}>
          ⚠ データエラー
        </span>
      )}
    </div>
  )
}
