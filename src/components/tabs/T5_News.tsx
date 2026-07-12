/**
 * T5_News — ニュース / 材料
 * Phase 5: 市場概況 + 情報源階層 + 5カテゴリ判断支援ニュース
 * 表示順: 市場概況 → 情報源優先順位 → ニュース一覧
 */
import { useMemo, useState, useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectIsLoading } from '../../store/selectors'
import { formatRelativeTime, formatDateTime } from '../../utils/format'
import { resolveNewsDisplayText, limitNewsPerTicker, NEWS_DISPLAY_LIMITS } from '../../utils/newsDisplay'
import type { NewsItem } from '../../types'
import type { MarketNewsItemV13 } from '../../types/news'
import type { MarketIntelData } from '../../types/market_intel'
import { MacroIntelPanel, NewsCardV13, EarningsCalendarCard } from '../v13'

// ─────────────────────────────────────────────────────────────
// 情報源レイヤー定義（優先順位）
// ─────────────────────────────────────────────────────────────
const SOURCE_LAYERS: Record<string, 'primary' | 'trusted' | 'aux'> = {
  // 第1層: 一次情報
  nikkei: 'primary', jpx: 'primary', boj: 'primary', fed: 'primary',
  tdnet: 'primary', meti: 'primary', cabinet: 'primary', mof: 'primary',
  tse: 'primary', edinet: 'primary',
  // 第2層: 信頼できる報道
  bloomberg: 'trusted', reuters: 'trusted', wsj: 'trusted', ft: 'trusted',
  toyo: 'trusted', mainichi: 'trusted', yomiuri: 'trusted', nhk: 'trusted',
  yahoo_finance: 'trusted', sbiz: 'trusted', nikkei_jp: 'trusted',
  minkabu: 'trusted', kabutan: 'trusted',
  // 第3層: 補助センチメント（参考のみ・売買判断の主根拠に使わない）
  twitter: 'aux', x: 'aux', reddit: 'aux', stocktwits: 'aux',
  sns: 'aux', blog: 'aux', note: 'aux', youtube: 'aux',
}

function getSourceLayer(source: string): 'primary' | 'trusted' | 'aux' {
  const key = source.toLowerCase().replace(/[^a-z0-9_]/g, '')
  return SOURCE_LAYERS[key] ?? 'trusted'
}

const LAYER_LABELS: Record<string, { label: string; short: string; cls: string }> = {
  primary: { label: '第1層: 一次情報',       short: '一次', cls: 'source1' },
  trusted: { label: '第2層: 信頼できる報道',  short: '報道', cls: 'source2' },
  aux:     { label: '第3層: 補助センチメント', short: '補助', cls: 'source3' },
}

// ─────────────────────────────────────────────────────────────
// 型・ヘルパー
// ─────────────────────────────────────────────────────────────
type NewsCategory = 'market' | 'holding' | 'candidate' | 'jpfund' | 'globalfund'
type ExtNewsCategory = NewsCategory | 'v13source'

function getImpactCls(item: NewsItem): 'positive' | 'negative' | 'neutral' | 'caution' {
  const impact = item.impact ?? (
    item.sentimentScore > 0.25 ? 'positive' :
    item.sentimentScore < -0.25 ? 'negative' : 'neutral'
  )
  if (impact === 'positive') return 'positive'
  if (impact === 'negative') return 'negative'
  return item.importance >= 0.7 ? 'caution' : 'neutral'
}

function getImpactLabel(cls: string): string {
  return cls === 'positive' ? 'プラス' : cls === 'negative' ? 'マイナス' : cls === 'caution' ? '要注意' : '中立'
}

function getImportanceLabel(imp: number) {
  if (imp >= 0.75) return { text: '高', cls: 'high' }
  if (imp >= 0.45) return { text: '中', cls: 'medium' }
  return { text: '低', cls: 'low' }
}

// ─────────────────────────────────────────────────────────────
// 市場概況タイル
// ─────────────────────────────────────────────────────────────
function IndicatorTile({
  name,
  value,
  chg,
  chgPct,
  unit = '',
  decimals = 0,
}: {
  name: string
  value: number | null | undefined
  chg?: number | null
  chgPct?: number | null
  unit?: string
  decimals?: number
}) {
  if (value === null || value === undefined) {
    return (
      <div className="indicator-tile indicator-tile--flat">
        <div className="indicator-tile__name">{name}</div>
        <div className="indicator-tile__value">—</div>
        <div className="indicator-tile__chg">&nbsp;</div>
      </div>
    )
  }
  const changeVal = chgPct ?? chg ?? 0
  const isUp   = changeVal > 0.01
  const isDown = changeVal < -0.01
  const tileCls = isUp ? 'up' : isDown ? 'down' : 'flat'
  const chgCls  = isUp ? 'up' : isDown ? 'down' : ''
  const arrow   = isUp ? '↑' : isDown ? '↓' : ''

  const fmt = (n: number) => n.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const chgStr = chgPct !== null && chgPct !== undefined
    ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`
    : chg !== null && chg !== undefined
      ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`
      : ''

  return (
    <div className={`indicator-tile indicator-tile--${tileCls}`}>
      <div className="indicator-tile__name">{name}</div>
      <div className="indicator-tile__value">
        {arrow && <span style={{ fontSize: '10px', marginRight: '1px', opacity: 0.7 }}>{arrow}</span>}
        {fmt(value)}{unit}
      </div>
      {chgStr && (
        <div className={`indicator-tile__chg indicator-tile__chg--${chgCls}`}>{chgStr}</div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 大型 Market Index Card (UI-12-2: large card + icon badge)
// ─────────────────────────────────────────────────────────────
const MCC_ICON: Record<string, string> = {
  '日経平均': 'JP', 'S&P 500': 'SP', 'NASDAQ': 'ND',
  'USD/JPY': 'FX', 'VIX': 'VX', 'Gold': 'AU',
}

function MarketIndexCard({
  name,
  value,
  chgPct,
  chgAbs,
  prefix = '',
  unit = '',
  decimals = 0,
}: {
  name: string
  value: number | null | undefined
  chgPct?: number | null
  chgAbs?: number | null
  prefix?: string
  unit?: string
  decimals?: number
}) {
  const shortCode = MCC_ICON[name] ?? name.slice(0, 2).toUpperCase()
  if (value === null || value === undefined) {
    return (
      <div className="mcc-index-card mcc-index-card--flat">
        <div className="mcc-index-card__header">
          <span className="mcc-index-card__icon">{shortCode}</span>
          <div className="mcc-index-card__name">{name}</div>
        </div>
        <div className="mcc-index-card__value">—</div>
      </div>
    )
  }
  const change = chgPct ?? chgAbs ?? 0
  const isUp   = change > 0.01
  const isDown = change < -0.01
  const dir    = isUp ? 'up' : isDown ? 'down' : 'flat'
  const fmt    = (n: number) =>
    n.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const chgStr = chgPct !== null && chgPct !== undefined
    ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`
    : chgAbs !== null && chgAbs !== undefined
      ? `${chgAbs >= 0 ? '+' : ''}${chgAbs.toFixed(2)}`
      : null
  const badge = isUp ? '↑ 上昇' : isDown ? '↓ 下落' : '→ 横ばい'
  return (
    <div className={`mcc-index-card mcc-index-card--${dir}`}>
      <div className="mcc-index-card__header">
        <span className="mcc-index-card__icon">{shortCode}</span>
        <div className="mcc-index-card__name">{name}</div>
      </div>
      <div className="mcc-index-card__value">{prefix}{fmt(value)}{unit}</div>
      {chgStr && (
        <div className={`mcc-index-card__chg mcc-index-card__chg--${dir}`}>{chgStr}</div>
      )}
      <span className={`mcc-index-card__badge mcc-index-card__badge--${dir}`}>{badge}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ニュースカード内ヘルパー（表示専用）
// ─────────────────────────────────────────────────────────────

// ImpactBadge: impact/sentimentを大型バッジで表示（表示専用）
function ImpactBadge({ impCls, impLabel }: { impCls: string; impLabel: string }) {
  const styleMap: Record<string, React.CSSProperties> = {
    positive: { background: '#e0f2fe', color: '#0369a1', border: '1.5px solid #38bdf8' },
    negative: { background: '#fef3c7', color: '#92400e', border: '1.5px solid #f59e0b' },
    caution:  { background: '#fef9c3', color: '#78350f', border: '1.5px solid #fbbf24' },
    neutral:  { background: 'var(--color-bg-elevated)', color: 'var(--color-text-subtle)', border: '1.5px solid var(--color-border-subtle)' },
  }
  const iconMap: Record<string, string> = { positive: '▲', negative: '▼', caution: '⚠', neutral: '–' }
  const style: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    padding: '3px 8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
    flexShrink: 0,
    ...(styleMap[impCls] ?? styleMap.neutral),
  }
  return (
    <span style={style}>
      <span style={{ fontSize: '10px' }}>{iconMap[impCls] ?? '–'}</span>
      {impLabel}
    </span>
  )
}

// SentimentBar: sentimentScore(-1〜+1)を中央基点の横バーで表示（表示専用）
function SentimentBar({ score }: { score: number }) {
  const clampedScore = Math.max(-1, Math.min(1, score))
  const isPositive = clampedScore > 0
  const pct = Math.abs(clampedScore) * 50 // 50%が最大幅

  const barColor = clampedScore > 0.25 ? '#38bdf8' : clampedScore < -0.25 ? '#f59e0b' : 'var(--color-border-default, #cbd5e1)'
  const trackStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0,
  }
  const innerStyle: React.CSSProperties = {
    position: 'relative', width: '80px', height: '6px',
    background: 'var(--color-bg-elevated)', borderRadius: '3px',
    overflow: 'hidden',
  }
  const fillStyle: React.CSSProperties = {
    position: 'absolute', top: 0, height: '100%',
    width: `${pct}%`,
    background: barColor, borderRadius: '3px',
    ...(isPositive ? { left: '50%' } : { right: '50%' }),
  }
  const centerLineStyle: React.CSSProperties = {
    position: 'absolute', left: '50%', top: 0, bottom: 0,
    width: '1px', background: 'var(--color-border-subtle)',
  }
  const label = clampedScore > 0.25 ? 'ポジ' : clampedScore < -0.25 ? 'ネガ' : '中立'
  return (
    <span style={trackStyle}>
      <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', flexShrink: 0 }}>感情</span>
      <span style={innerStyle}>
        <span style={centerLineStyle} />
        <span style={fillStyle} />
      </span>
      <span style={{ fontSize: '10px', color: barColor, fontWeight: 700, flexShrink: 0, minWidth: '20px' }}>{label}</span>
    </span>
  )
}

// RelatedHoldingChips: tickersから保有銘柄chipを表示（表示専用）
function RelatedHoldingChips({ tickers, holdings }: { tickers: string[]; holdings: Array<{ code: string; name: string }> }) {
  if (tickers.length === 0) return null
  const holdingSet = new Set(holdings.map(h => h.code))
  const chips = tickers.slice(0, 4).map(code => {
    const h = holdings.find(h => h.code === code)
    const isHolding = holdingSet.has(code)
    const label = h ? `${code} ${h.name}` : code
    return { code, label, isHolding }
  })
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '3px', alignItems: 'center' }}>
      {chips.map(({ code, label, isHolding }) => (
        <span
          key={code}
          style={{
            fontSize: '10px', fontWeight: 700, padding: '1px 5px',
            borderRadius: '4px',
            background: isHolding ? 'var(--color-stock-bg, #eff6ff)' : 'var(--color-bg-elevated)',
            color:      isHolding ? 'var(--color-stock-text, #1e40af)' : 'var(--color-text-muted)',
            border:     isHolding ? '1px solid var(--color-stock-accent, #93c5fd)' : '1px solid var(--color-border-subtle)',
          }}
        >
          {isHolding ? '★ ' : ''}{label}
        </span>
      ))}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// ニュースカード
// ─────────────────────────────────────────────────────────────
function NewsCard({ item, categoryLabel }: { item: NewsItem; categoryLabel: string }) {
  const holdings = useAppStore(s => s.holdings)
  const impCls   = getImpactCls(item)
  const impLabel = getImpactLabel(impCls)
  const { text: impText, cls: impBarCls } = getImportanceLabel(item.importance)
  const layer    = getSourceLayer(item.source)
  const layerInfo = LAYER_LABELS[layer]

  const { title: displayTitle, summary: displaySummary, isUntranslated } = resolveNewsDisplayText(item)

  // 保有銘柄一致チェック（highlight判定）
  const holdingCodes = new Set(holdings.map(h => h.code))
  const hasHoldingMatch = item.tickers.some(c => holdingCodes.has(c))

  // positive/negative の左 border を buy/sell 色変数から観察系中立色へ上書き
  const cardBorderStyle: React.CSSProperties =
    impCls === 'positive' ? { borderLeft: '4px solid #38bdf8' } :  // sky-400
    impCls === 'negative' ? { borderLeft: '4px solid #f59e0b' } :  // amber-500
    {}

  // 保有銘柄一致時はカード背景をごく薄いhighlight
  const holdingHighlightStyle: React.CSSProperties = hasHoldingMatch
    ? { background: 'var(--color-stock-bg-faint, rgba(239,246,255,0.4))' }
    : {}

  return (
    <div className={`news-card news-card--${impCls}`} style={{ ...cardBorderStyle, ...holdingHighlightStyle }}>
      {/* 保有銘柄highlight帯（一致時のみ） */}
      {hasHoldingMatch && (
        <div style={{
          fontSize: '10px', fontWeight: 700,
          color: 'var(--color-stock-text, #1e40af)',
          marginBottom: '4px',
          display: 'flex', alignItems: 'center', gap: '4px',
        }}>
          <span>★</span>
          <span>保有銘柄関連ニュース</span>
        </div>
      )}

      {/* ヘッダー: タイトル + バッジ行 */}
      <div className="news-card__header">
        <div className="news-card__title">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer">{displayTitle}</a>
          ) : displayTitle}
        </div>
        <div className="news-card__chips" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
          {isUntranslated && <span className="news-chip news-chip--lang">EN</span>}
          <ImpactBadge impCls={impCls} impLabel={impLabel} />
          <span className={`news-chip news-chip--${layerInfo.cls}`}>{layerInfo.short}</span>
        </div>
      </div>

      {/* インパクト可視化バー: importance + sentimentScore */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', margin: '6px 0' }}>
        {/* 重要度バー */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>重要度</span>
          <span style={{
            display: 'inline-block', width: '64px', height: '6px',
            background: 'var(--color-bg-elevated)', borderRadius: '3px',
            position: 'relative', overflow: 'hidden',
            verticalAlign: 'middle',
          }}>
            <span style={{
              position: 'absolute', left: 0, top: 0, height: '100%',
              width: `${Math.round(item.importance * 100)}%`,
              background: item.importance >= 0.75 ? '#f59e0b' : item.importance >= 0.45 ? '#60a5fa' : '#94a3b8',
              borderRadius: '3px',
            }} />
          </span>
          <span className={`importance-bar__fill--${impBarCls}`}
            style={{ fontSize: '10px', fontWeight: 700, color: item.importance >= 0.75 ? '#d97706' : item.importance >= 0.45 ? '#2563eb' : 'var(--color-text-muted)' }}>
            {impText}
          </span>
        </span>
        {/* センチメントスコアバー */}
        <SentimentBar score={item.sentimentScore} />
      </div>

      {/* メタ情報 */}
      <div className="news-card__meta">
        <span>{categoryLabel}</span>
        <span>{item.source}</span>
        <span>{formatRelativeTime(item.publishedAt)}</span>
      </div>

      {/* 関連銘柄chips（tickers存在時のみ） */}
      {item.tickers.length > 0 && (
        <div style={{ marginTop: '6px' }}>
          <RelatedHoldingChips tickers={item.tickers} holdings={holdings} />
        </div>
      )}

      {/* 要約（3行clip） */}
      {displaySummary && (
        <div
          className="news-card__summary"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {displaySummary}
        </div>
      )}

      {/* 観察メモ（whyImportant 存在時のみ表示） */}
      {item.whyImportant && (
        <div className="news-card__notes">
          <div className="news-card__notes-row">
            <span className="news-card__notes-label">観察メモ</span>
            <span className="news-card__notes-text">{item.whyImportant}</span>
          </div>
        </div>
      )}

      {/* 第3層警告 */}
      {layer === 'aux' && (
        <div className="news-card__action-row" style={{ color: 'var(--color-text-muted)', fontWeight: 500, fontSize: 11 }}>
          ⚠ 補助センチメント（第3層）— 売買判断の主根拠には使用しない
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────────────────────
export function T5_News() {
  const [cat, setCat] = useState<ExtNewsCategory>('market')
  const [newsV13, setNewsV13] = useState<MarketNewsItemV13[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
        const url = `${base.endsWith('/') ? base : base + '/'}data/news_v13.json`
        const r = await fetch(url, { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json() as { top_items?: MarketNewsItemV13[] }
          setNewsV13(d.top_items ?? [])
        }
      } catch { /* silent */ }
    })()
  }, [])

  const [marketIntel, setMarketIntel] = useState<MarketIntelData | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
        const url = `${base.endsWith('/') ? base : base + '/'}data/market_intel.json`
        const r = await fetch(url, { cache: 'no-store' })
        if (r.ok) setMarketIntel(await r.json() as MarketIntelData)
      } catch { /* silent */ }
    })()
  }, [])

  const market         = useAppStore(s => s.market)
  const macro          = useAppStore(s => s.macro)
  const news           = useAppStore(s => s.news)
  const newsSource     = useAppStore(s => s.system.dataSourceStatus.news)
  const holdings       = useAppStore(s => s.holdings)
  const trust          = useAppStore(s => s.trust)
  const refreshAllData = useAppStore(s => s.refreshAllData)
  const isLoading      = useAppStore(selectIsLoading)
  const buyList        = useAppStore(selectBuyList)

  // ── ニュース分類 ─────────────────────────────────────────────
  const holdingCodes   = useMemo(() => new Set(holdings.map(h => h.code)), [holdings])
  const candidateCodes = useMemo(() => new Set(buyList.map(a => a.code)), [buyList])
  const holdingKw      = useMemo(
    () => holdings.flatMap(h => [h.code, h.name, h.name.replace(/\s/g, '')]),
    [holdings],
  )
  const jpFundKw = useMemo(
    () => trust
      .filter(f => f.policy === 'JAPAN_SHORTTERM')
      .map(f => f.abbr)
      .concat(['日経225', '日経平均', 'TOPIX', '日本株']),
    [trust],
  )
  const globalFundKw = useMemo(
    () => trust
      .filter(f => f.policy !== 'JAPAN_SHORTTERM')
      .map(f => f.abbr)
      .concat(['S&P500', 'NASDAQ', 'FANG', 'オルカン', 'ゴールド', 'REIT', '全世界', '米株']),
    [trust],
  )

  const marketNews = useMemo(
    () => [...(news?.marketNews ?? [])].sort((a, b) => b.importance - a.importance),
    [news],
  )
  const stockNews = useMemo(
    () => [...(news?.stockNews ?? [])].sort((a, b) => b.importance - a.importance),
    [news],
  )

  // P4.5-A004: 1銘柄あたり最大PER_TICKER_MAX件に間引いてから、カテゴリ全体の上限で頭打ちする
  // （紐づく銘柄数が多いときに特定銘柄の記事だけで埋まらないようにする表示専用の調整）
  const holdingNews = useMemo(() => {
    const direct = stockNews.filter(n => n.tickers.some(c => holdingCodes.has(c)))
    const base = direct.length > 0
      ? direct
      : marketNews.filter(n => {
          const text = `${n.title} ${n.summary}`
          return holdingKw.some(kw => kw && text.includes(kw))
        })
    return limitNewsPerTicker(base, NEWS_DISPLAY_LIMITS.PER_TICKER_MAX)
      .slice(0, NEWS_DISPLAY_LIMITS.NEWS_TAB_PER_STOCK_CATEGORY_TOTAL)
  }, [holdingCodes, holdingKw, marketNews, stockNews])

  const candidateNews = useMemo(() => {
    const base = [...stockNews, ...marketNews].filter(n => {
      if (n.tickers.some(c => candidateCodes.has(c))) return true
      return [...candidateCodes].some(c => n.title.includes(c) || n.summary.includes(c))
    })
    return limitNewsPerTicker(base, NEWS_DISPLAY_LIMITS.PER_TICKER_MAX)
      .slice(0, NEWS_DISPLAY_LIMITS.NEWS_TAB_PER_STOCK_CATEGORY_TOTAL)
  }, [candidateCodes, marketNews, stockNews])

  const jpFundNews = useMemo(
    () => [...marketNews, ...stockNews]
      .filter(n => jpFundKw.some(kw => kw && (n.title.includes(kw) || n.summary.includes(kw))))
      .slice(0, 20),
    [jpFundKw, marketNews, stockNews],
  )

  const globalFundNews = useMemo(
    () => [...marketNews, ...stockNews]
      .filter(n => globalFundKw.some(kw => kw && (n.title.includes(kw) || n.summary.includes(kw))))
      .slice(0, 20),
    [globalFundKw, marketNews, stockNews],
  )

  // ── UI-9-2: マーケットキーワード (market_intel + regime + macd) ──
  const keywords = useMemo(() => {
    const kws = new Set<string>()
    if (marketIntel) {
      for (const k of (marketIntel.narrative?.keywords_summary ?? [])) kws.add(k)
      for (const s of (marketIntel.signals ?? [])) kws.add(s.tag)
    }
    kws.add(market.regime === 'bull' ? '強気相場' : market.regime === 'bear' ? '弱気相場' : '中立相場')
    if (market.macd === 'golden') kws.add('MACD陽転')
    if (market.vix < 15) kws.add('低VIX')
    else if (market.vix >= 25) kws.add('VIX警戒')
    return Array.from(kws).filter(Boolean).slice(0, 8)
  }, [marketIntel, market.regime, market.macd, market.vix])

  // ── UI-9-2: 今日の観察（観察・示唆のみ、売買推奨なし）──
  const observations = useMemo(() => {
    const vixLv = market.vix < 15 ? '低リスク水準' : market.vix < 20 ? '通常水準' : market.vix < 25 ? '警戒水準' : '高リスク水準'
    const nkChgStr = `${market.nikkeiChgPct >= 0 ? '+' : ''}${market.nikkeiChgPct.toFixed(2)}%`
    const sp5Str = macro?.sp500ChgPct !== undefined
      ? `S&P500 ${macro.sp500ChgPct >= 0 ? '+' : ''}${macro.sp500ChgPct.toFixed(2)}%`
      : null
    const rsiLv = market.rsi14 > 70 ? '過熱圏に接近' : market.rsi14 > 60 ? '上昇継続' : market.rsi14 > 50 ? 'トレンド圏' : '調整圏の可能性'
    const macdLv = market.macd === 'golden' ? 'MACD陽転（短期上昇モメンタム）' : 'MACD陰転（短期下降モメンタム）'
    const volLv  = market.volume === 'high' ? '出来高増加' : market.volume === 'low' ? '出来高減少' : '出来高普通'
    const fxDir = !macro
      ? '為替データ未取得'
      : macro.usdjpyChgPct > 0.05 ? '円安傾向'
      : macro.usdjpyChgPct < -0.05 ? '円高傾向'
      : '為替横ばい'
    const fxEffect = !macro ? ''
      : macro.usdjpyChgPct > 0.05 ? '海外株投信の円換算 +側'
      : macro.usdjpyChgPct < -0.05 ? '海外株投信の円換算に注意'
      : ''
    return [
      {
        kicker: '今日の見方',
        title: market.regime === 'bull' ? '強気相場継続' : market.regime === 'bear' ? '弱気相場' : '中立相場',
        lines: [
          `日経 ${nkChgStr} の変動`,
          `VIX ${market.vix.toFixed(1)} — ${vixLv}`,
          ...(sp5Str ? [sp5Str] : []),
        ],
      },
      {
        kicker: '株式への示唆',
        title: `RSI ${market.rsi14.toFixed(0)} — ${rsiLv}`,
        lines: [macdLv, volLv],
      },
      {
        kicker: '投資信託への示唆',
        title: fxDir,
        lines: [
          ...(fxEffect ? [fxEffect] : []),
          ...(market.boj ? [`BOJ ${market.boj}（次回 ${market.bojNext}）`] : []),
          market.regime === 'bull' ? '国内株投信 強気相場圏' : market.regime === 'bear' ? '国内株投信 弱気相場圏' : '',
        ].filter(Boolean),
      },
    ]
  }, [market, macro])

  const catItems: Record<NewsCategory, NewsItem[]> = {
    // P4.5-A004: 「市場全体」は元データ無制限だったため、十分な件数(20件程度)で頭打ちする
    market: marketNews.slice(0, NEWS_DISPLAY_LIMITS.NEWS_TAB_MARKET),
    holding: holdingNews,
    candidate: candidateNews,
    jpfund: jpFundNews,
    globalfund: globalFundNews,
  }

  const catLabel: Record<NewsCategory, string> = {
    market: '市場全体',
    holding: '保有銘柄',
    candidate: '候補銘柄',
    jpfund: '国内株投信',
    globalfund: '海外投信',
  }

  const tabs: { id: ExtNewsCategory; label: string }[] = [
    { id: 'market',     label: '市場全体' },
    { id: 'holding',    label: '保有銘柄' },
    { id: 'candidate',  label: '候補銘柄' },
    { id: 'jpfund',     label: '国内株投信' },
    { id: 'globalfund', label: '海外投信' },
    { id: 'v13source',  label: 'v13ソース' },
  ]

  const activeItems: NewsItem[] = cat === 'v13source' ? [] : (catItems[cat as NewsCategory] ?? [])

  return (
    <div className="tab-panel">
      {/* ════════════════════════════════════════
          [0] Markets Intelligence — AI Narrator
          ════════════════════════════════════════ */}
      <MacroIntelPanel />

      {/* ════════════════════════════════════════
          [1] Market Command Center — 大型指数カード
          ════════════════════════════════════════ */}
      <article className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Dark header */}
        <div style={{
          background: 'var(--color-bg-dark-panel)',
          borderRadius: '15px 15px 0 0',
          padding: '12px 18px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
        }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-text-on-navy-sub)', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
              Market Command Center
            </div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--color-text-on-navy)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const }}>
              <span>
                {market.regime === 'bull' ? '↑ 強気相場' : market.regime === 'bear' ? '↓ 弱気相場' : '→ 中立相場'}
              </span>
              <span style={{ fontSize: '11px', fontWeight: 500, color: '#64748b' }}>
                RSI {market.rsi14.toFixed(0)}&nbsp;
                MACD {market.macd === 'golden' ? 'G' : 'D'}&nbsp;
                BOJ {market.boj}
              </span>
            </div>
          </div>
          <button
            className={`status-shell__refresh${isLoading ? ' is-loading' : ''}`}
            onClick={() => { void refreshAllData() }}
            disabled={isLoading}
            type="button"
            style={{ fontSize: '11px' }}
          >
            {isLoading ? '更新中...' : '更新'}
          </button>
        </div>

        {/* Big index card grid */}
        <div style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' as const, marginBottom: '12px' }}>
            主要指数
          </div>
          <div className="mcc-index-grid" style={{ marginBottom: '18px' }}>
            <MarketIndexCard name="日経平均"  value={market.nikkei}           chgPct={market.nikkeiChgPct}  decimals={0} />
            <MarketIndexCard name="S&P 500"  value={macro?.sp500}            chgPct={macro?.sp500ChgPct}   decimals={0} />
            <MarketIndexCard name="NASDAQ"   value={macro?.nasdaq}           chgPct={macro?.nasdaqChgPct}  decimals={0} />
            <MarketIndexCard name="USD/JPY"  value={macro?.usdjpy}           chgPct={macro?.usdjpyChgPct}  decimals={2} />
            <MarketIndexCard name="VIX"      value={macro?.vix ?? market.vix} chgAbs={macro?.vixChg}       decimals={2} />
            <MarketIndexCard name="Gold"     value={macro?.gold}             chgPct={macro?.goldChgPct}    decimals={0} prefix="$" unit="/oz" />
          </div>

          {/* Secondary macro row */}
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' as const, marginBottom: '8px' }}>
            マクロ環境
          </div>
          <div className="market-overview">
            <IndicatorTile name="日経VI"    value={macro?.nikkeiVI}  chg={macro?.nikkeiVIChg}      decimals={1} />
            <IndicatorTile name="米10y金利" value={macro?.ust10y}    decimals={3} unit="%" />
            <IndicatorTile name="日本国債"  value={macro?.jgb10y}    decimals={2} unit="%" />
            <IndicatorTile name="原油(NY)"  value={macro?.nyCrude}   chgPct={macro?.nyCrudeChgPct} decimals={1} unit="$" />
          </div>
          <div style={{ marginTop: '10px', fontSize: '10px', color: 'var(--color-text-muted)', textAlign: 'right' as const }}>
            {news
              ? `総ニュース ${news.meta.totalCount}件 · ニュース更新 ${formatDateTime(news.updatedAt)}`
              : newsSource === 'error'
                ? 'ニュース取得失敗（更新ボタンで再試行）'
                : 'ニュース未取得'}
          </div>
          {news && Date.now() - new Date(news.updatedAt).getTime() > 86400000 && (
            <div style={{ marginTop: '2px', fontSize: '10px', color: 'var(--color-stale-text, #d4a843)', textAlign: 'right' as const }}>
              ⏰ ニュースが古い可能性があります（24時間以上未更新）
            </div>
          )}
        </div>
      </article>

      {/* ════════════════════════════════════════
          [1b] 今日の観察 — 3ブロック示唆カード
          ════════════════════════════════════════ */}
      <article className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div className="section-kicker">今日の市場観察</div>
          <div style={{ fontSize: '10px', color: 'var(--color-text-subtle)', fontStyle: 'italic' }}>
            ※ 観察・示唆のみ
          </div>
        </div>
        <div className="mcc-suggest-grid">
          {observations.map(obs => (
            <div key={obs.kicker} className="mcc-suggest-card">
              <div className="mcc-suggest-card__kicker">{obs.kicker}</div>
              <div className="mcc-suggest-card__title">{obs.title}</div>
              <div className="mcc-suggest-card__body">{obs.lines.join(' · ')}</div>
            </div>
          ))}
        </div>
      </article>

      {/* ════════════════════════════════════════
          [2] 今日のニュース — 重要度上位
          ════════════════════════════════════════ */}
      {marketNews.length > 0 && (
        <article className="card">
          <div className="section-kicker" style={{ marginBottom: 12 }}>今日のニュース — 重要度上位</div>
          <div className="mcc-news-list">
            {marketNews.slice(0, NEWS_DISPLAY_LIMITS.T0_HOME).map(item => {
              const impCls    = getImpactCls(item)
              const impLabel  = getImpactLabel(impCls)
              const { text: impText } = getImportanceLabel(item.importance)
              const layer     = getSourceLayer(item.source)
              const layerInfo = LAYER_LABELS[layer]
              const { title: itemTitle, isUntranslated: itemUntranslated } = resolveNewsDisplayText(item)
              return (
                <div key={item.id} className={`mcc-news-item mcc-news-item--${impCls}`}>
                  <div className="mcc-news-item__body">
                    <div className="mcc-news-item__title">
                      {item.url
                        ? <a href={item.url} target="_blank" rel="noopener noreferrer">{itemTitle}</a>
                        : itemTitle}
                    </div>
                    <div className="mcc-news-item__meta">
                      <ImpactBadge impCls={impCls} impLabel={impLabel} />
                      <span className={`news-chip news-chip--${layerInfo.cls}`}>{layerInfo.short}</span>
                      {itemUntranslated && <span className="news-chip news-chip--lang">EN</span>}
                      <span>{item.source}</span>
                      <span>{formatRelativeTime(item.publishedAt)}</span>
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>重要度</span>
                        <span style={{
                          display: 'inline-block', width: '48px', height: '5px',
                          background: 'var(--color-bg-elevated)', borderRadius: '3px',
                          position: 'relative', overflow: 'hidden', verticalAlign: 'middle',
                        }}>
                          <span style={{
                            position: 'absolute', left: 0, top: 0, height: '100%',
                            width: `${Math.round(item.importance * 100)}%`,
                            background: item.importance >= 0.75 ? '#f59e0b' : item.importance >= 0.45 ? '#60a5fa' : '#94a3b8',
                            borderRadius: '3px',
                          }} />
                        </span>
                        <strong style={{ fontSize: '10px' }}>{impText}</strong>
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </article>
      )}

      {/* ════════════════════════════════════════
          [2b] マーケットキーワード
          ════════════════════════════════════════ */}
      {keywords.length > 0 && (
        <article className="card">
          <div className="section-kicker" style={{ marginBottom: 10 }}>マーケットキーワード</div>
          <div className="mcc-keyword-wrap">
            {keywords.map(kw => (
              <span key={kw} className="mcc-keyword-chip">{kw}</span>
            ))}
          </div>
        </article>
      )}

      {/* ════════════════════════════════════════
          [2c] AI マーケット解説 CTA
          ════════════════════════════════════════ */}
      <article className="card" style={{ padding: '14px 18px' }}>
        <button className="mcc-ai-cta" type="button">
          <span>✦</span>
          <span>AI マーケット解説を見る</span>
        </button>
        <div style={{ fontSize: '10px', color: 'var(--color-text-subtle)', textAlign: 'center' as const, marginTop: '8px' }}>
          ※ AI解説機能は準備中です
        </div>
      </article>

      {/* ════════════════════════════════════════
          [3] カテゴリタブ + ニュースフィード
          ════════════════════════════════════════ */}
      <article className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' as const, gap: 4 }}>
          <div className="section-kicker">ニュースフィード</div>
          <div style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
            第1層: 一次 · 第2層: 報道 · 第3層: 参考のみ
          </div>
        </div>

        {/* カテゴリタブ */}
        <div className="news-cat-tabs" style={{ marginBottom: 16 }}>
          {tabs.map(t => (
            <button
              key={t.id}
              className={`news-cat-tabs__item${cat === t.id ? ' active' : ''}`}
              onClick={() => setCat(t.id)}
              type="button"
            >
              {t.label}
              <span className="news-cat-tabs__count">
                {t.id === 'v13source' ? newsV13.length : catItems[t.id as NewsCategory].length}
              </span>
            </button>
          ))}
        </div>

        {cat === 'v13source' ? (
          newsV13.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {newsV13.map((item, idx) => (
                <NewsCardV13 key={`${item.source_id}-${item.published_at}-${idx}`} item={item} />
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-subtle)', fontSize: 13 }}>
              news_v13.json を読み込み中...
            </div>
          )
        ) : activeItems.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activeItems.map(item => (
              <NewsCard key={item.id} item={item} categoryLabel={catLabel[cat as NewsCategory]} />
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-subtle)', fontSize: 13 }}>
            {cat === 'holding' && holdings.length === 0
              ? '保有銘柄データを取込んでください（CSVインポート）'
              : `${(catLabel as Record<string, string>)[cat] ?? cat}に関連するニュースはまだありません`}
          </div>
        )}
      </article>

      {/* ════════════════════════════════════════
          [4] 決算カレンダー
          ════════════════════════════════════════ */}
      <EarningsCalendarCard />
    </div>
  )
}
