import { useAppStore } from '../store/useAppStore'
import {
  selectBuyList,
  selectIsLoading,
  selectSellList,
  selectTotalEval,
  selectTotalPnl,
} from '../store/selectors'
import { TAB_META_BY_ID } from '../constants/tabs'
import { formatDateTime, formatJPYAuto } from '../utils/format'

function getRegimeLabel(regime: 'bull' | 'neutral' | 'bear') {
  if (regime === 'bull') return { label: '強気', tone: 'positive' as const }
  if (regime === 'bear') return { label: '弱気', tone: 'negative' as const }
  return { label: '中立', tone: 'caution' as const }
}

export function StatusBar() {
  const activeTab = useAppStore(s => s.activeTab)
  const system = useAppStore(s => s.system)
  const market = useAppStore(s => s.market)
  const macro = useAppStore(s => s.macro)
  const news = useAppStore(s => s.news)
  const metrics = useAppStore(s => s.metrics)
  const holdings = useAppStore(s => s.holdings)
  const trust = useAppStore(s => s.trust)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const refresh = useAppStore(s => s.refreshAllData)
  const totalEval = useAppStore(selectTotalEval)
  const totalPnl = useAppStore(selectTotalPnl)
  const buyList = useAppStore(selectBuyList)
  const sellList = useAppStore(selectSellList)
  const isLoading = useAppStore(selectIsLoading)

  const activeMeta = TAB_META_BY_ID[activeTab]
  const regime = getRegimeLabel(market.regime)
  const mitsuEval = holdings.filter(h => h.mitsu).reduce((sum, holding) => sum + holding.eval, 0)
  const mitsuRatio = totalEval > 0 ? (mitsuEval / totalEval) * 100 : 0
  const totalTrustEval = trust.reduce((sum, item) => sum + item.eval, 0)
  const overseasTrustEval = trust
    .filter(item => item.policy === 'OVERSEAS_LONGTERM')
    .reduce((sum, item) => sum + item.eval, 0)
  const overseasTrustRatio = totalTrustEval > 0 ? (overseasTrustEval / totalTrustEval) * 100 : 0
  const primaryMessage = system.error
    ? 'データ更新が失敗しています。再読込してから判断してください。'
    : sellList.length > 0
    ? `${sellList.length}銘柄に縮小または撤退シグナルがあります。`
    : buyList.length > 0
    ? `${buyList.length}銘柄に追加候補があります。執行順を確認してください。`
    : '大きな売買シグナルはありません。現状維持を基準に確認してください。'
  const workspaceHero = {
    T1: {
      eyebrow: 'Execution Workspace',
      label: 'Execution focus',
      copy: primaryMessage,
      notes: [
        `BUY ${buyList.length}`,
        `SELL ${sellList.length}`,
        `三菱比率 ${mitsuRatio.toFixed(1)}%`,
      ],
    },
    T2: {
      eyebrow: 'Holdings Workspace',
      label: 'Holdings focus',
      copy: `${holdings.length}銘柄を保有中です。ロック銘柄と集中比率を優先確認してください。`,
      notes: [
        `保有 ${holdings.length}`,
        `三菱比率 ${mitsuRatio.toFixed(1)}%`,
        `総評価額 ${formatJPYAuto(totalEval)}`,
      ],
    },
    T3: {
      eyebrow: 'Analysis Workspace',
      label: 'Analysis focus',
      copy: `${regime.label}レジームです。テクニカルとファンダの上位差分を先に確認してください。`,
      notes: [
        `Sharpe ${metrics ? metrics.sharpe.toFixed(2) : '—'}`,
        `ニュース ${news?.meta.totalCount ?? 0}`,
        `VIX ${market.vix.toFixed(1)}`,
      ],
    },
    T4: {
      eyebrow: 'Risk Workspace',
      label: 'Risk focus',
      copy: `CVaRと最大DDを基準に、相関の高い組み合わせから先に監視します。`,
      notes: [
        `CVaR ${metrics ? `${(metrics.cvar * 100).toFixed(1)}%` : '—'}`,
        `MDD ${metrics ? `${(metrics.mdd * 100).toFixed(1)}%` : '—'}`,
        `SQ ${sqCalendar?.nextSQ ? `残り${sqCalendar.nextSQ.dayUntil}日` : '未取得'}`,
      ],
    },
    T5: {
      eyebrow: 'Planning Workspace',
      label: 'Planning focus',
      copy: `売買計画は BUY候補 ${buyList.length} / SELL候補 ${sellList.length} を基準に組み立てます。`,
      notes: [
        `BUY ${buyList.length}`,
        `SELL ${sellList.length}`,
        `分析 ${system.analysisLastRunAt ? '済み' : '未実行'}`,
      ],
    },
    T6: {
      eyebrow: 'News Workspace',
      label: 'Coverage focus',
      copy: `${news?.meta.totalCount ?? 0}件のニュースを集約中です。重要度の高い材料から順に判断へ反映します。`,
      notes: [
        `市場 ${news?.meta.marketCount ?? 0}`,
        `個別 ${news?.meta.stockCount ?? 0}`,
        `重複除去 ${news?.meta.duplicateRemoved ?? 0}`,
      ],
    },
    T7: {
      eyebrow: 'Trust Workspace',
      label: 'Trust focus',
      copy: `${trust.length}本の投信を監視中です。役割別の配分差分と曜日シグナルを確認してください。`,
      notes: [
        `投信 ${trust.length}`,
        `海外比率 ${trust.length > 0 ? `${overseasTrustRatio.toFixed(1)}%` : '—'}`,
        `更新 ${system.lastUpdated ? formatDateTime(system.lastUpdated) : '未取得'}`,
      ],
    },
  }[activeTab]

  const summaryItems = [
    { label: '総評価額', value: formatJPYAuto(totalEval), tone: 'neutral' },
    { label: '含み損益', value: `${totalPnl >= 0 ? '+' : ''}${formatJPYAuto(totalPnl)}`, tone: totalPnl >= 0 ? 'positive' : 'negative' },
    { label: 'Sharpe', value: metrics ? metrics.sharpe.toFixed(2) : '—', tone: metrics && metrics.sharpe >= 1 ? 'positive' : 'neutral' },
    { label: 'CVaR 95%', value: metrics ? `${(metrics.cvar * 100).toFixed(1)}%` : '—', tone: metrics && Math.abs(metrics.cvar) > 0.2 ? 'negative' : 'neutral' },
  ] as const

  const marketItems = [
    { label: '日経平均', value: market.nikkei.toLocaleString('ja-JP'), delta: `${market.nikkeiChgPct >= 0 ? '+' : ''}${market.nikkeiChgPct.toFixed(2)}%`, tone: market.nikkeiChgPct >= 0 ? 'positive' : 'negative' },
    { label: 'VIX', value: market.vix.toFixed(1), delta: macro ? `${macro.vixChg >= 0 ? '+' : ''}${macro.vixChg.toFixed(2)}` : '—', tone: market.vix >= 25 ? 'negative' : market.vix >= 20 ? 'caution' : 'positive' },
    { label: 'ドル円', value: macro ? macro.usdjpy.toFixed(2) : '—', delta: macro ? `${macro.usdjpyChgPct >= 0 ? '+' : ''}${macro.usdjpyChgPct.toFixed(2)}%` : '—', tone: 'neutral' },
    { label: '次回SQ', value: sqCalendar?.nextSQ ? sqCalendar.nextSQ.date.slice(5) : '—', delta: sqCalendar?.nextSQ ? `残り${sqCalendar.nextSQ.dayUntil}営業日` : '日程なし', tone: (sqCalendar?.nextSQ?.dayUntil ?? 99) <= 3 ? 'negative' : (sqCalendar?.nextSQ?.dayUntil ?? 99) <= 7 ? 'caution' : 'neutral' },
  ] as const

  const sourceItems = [
    { label: '分析', value: system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行' },
    { label: 'ニュース', value: system.dataTimestamps?.news ? formatDateTime(system.dataTimestamps.news) : '未取得' },
    { label: 'マクロ', value: system.dataTimestamps?.macro ? formatDateTime(system.dataTimestamps.macro) : '未取得' },
  ]

  return (
    <header className="status-shell">
      <div className="status-shell__top">
        <div className="status-shell__context">
          <div className="status-shell__eyebrow">{workspaceHero.eyebrow}</div>
          <h1 className="status-shell__title">{activeMeta.title}</h1>
          <p className="status-shell__description">{activeMeta.description}</p>
        </div>

        <div className="status-shell__actions">
          <div className="status-shell__meta">
            <span className={`tone-chip tone-chip--${regime.tone}`}>{regime.label}</span>
            <span className="tone-chip tone-chip--neutral">v{system.version}</span>
            <span className="status-shell__timestamp">
              最終更新 {system.lastUpdated ? formatDateTime(system.lastUpdated) : '未更新'}
            </span>
          </div>
          <button
            className={`status-shell__refresh${isLoading ? ' is-loading' : ''}`}
            onClick={() => {
              void refresh()
            }}
            disabled={isLoading}
            type="button"
          >
            {isLoading ? '更新中...' : 'データ更新'}
          </button>
        </div>
      </div>

      <div className="status-shell__hero">
        <div className="status-shell__hero-main">
          <div className="status-shell__hero-label">{workspaceHero.label}</div>
          <div className="status-shell__hero-copy">{workspaceHero.copy}</div>
          <div className="status-shell__hero-notes">
            {workspaceHero.notes.map(note => (
              <span
                key={note}
                className={`note-pill${note.includes('三菱比率') && mitsuRatio > 35 ? ' is-warning' : ''}`}
              >
                {note}
              </span>
            ))}
          </div>
        </div>

        <div className="status-shell__hero-metrics">
          {summaryItems.map(item => (
            <div key={item.label} className={`summary-tile summary-tile--${item.tone}`}>
              <div className="summary-tile__label">{item.label}</div>
              <div className="summary-tile__value">{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="status-shell__market-grid">
        {marketItems.map(item => (
          <div key={item.label} className={`market-tile market-tile--${item.tone}`}>
            <div className="market-tile__label">{item.label}</div>
            <div className="market-tile__value">{item.value}</div>
            <div className="market-tile__delta">{item.delta}</div>
          </div>
        ))}
      </div>

      <div className="status-shell__footer">
        <div className="status-shell__sources">
          {sourceItems.map(item => (
            <div key={item.label} className="source-pill">
              <span className="source-pill__label">{item.label}</span>
              <span className="source-pill__value">{item.value}</span>
            </div>
          ))}
        </div>
        {system.error && <div className="status-shell__error">{system.error}</div>}
      </div>
    </header>
  )
}
