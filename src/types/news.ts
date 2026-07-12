// ═══════════════════════════════════════════════════════════
// News Aggregator Types — v13.3
// 参照: 05_master_plan.md Section 5 / 07_spec.md Section 11.3
// 既存の NewsItem (index.ts) とは別名で定義し、衝突を避ける
// ═══════════════════════════════════════════════════════════

/** 8ニュースソースID */
export type NewsSourceId =
  | 'bloomberg'
  | 'reuters'
  | 'yahoo_finance_jp'
  | 'minkabu'
  | 'shikiho_online'
  | 'tdnet'
  | 'edinet'
  | 'jpx'

/** 各ソースの稼働状況 */
export type NewsSourceStatus = 'ok' | 'error' | 'rate_limited' | 'timeout'

/** ニュースカテゴリ */
export type NewsCategory =
  | 'macro'
  | 'international'
  | 'japan'
  | 'markets'
  | 'earnings'
  | 'disclosure'
  | 'regulatory'
  | 'individual_stocks'
  | 'market_structure'

/** v13.3 マルチソース対応 NewsItem（既存 NewsItem とは別） */
export interface MarketNewsItemV13 {
  source_id: NewsSourceId
  title: string
  summary: string
  url: string
  published_at: string           // ISO8601
  language: 'ja' | 'en'
  category: NewsCategory[]
  related_tickers: string[]      // 4桁銘柄コード
  sentiment_score: number        // -1.0 ~ +1.0
  importance_score: number       // 0 ~ 100
}

/** 銘柄別ニュースサマリー */
export interface TickerNewsSummary {
  items_count: number
  avg_sentiment: number
  max_importance: number
  key_themes: string[]
}

/** 保有銘柄別ニュース（holdings_news.json 準拠） */
export interface HoldingsNewsV13 {
  fetched_at: string
  tracked_tickers: string[]
  items_by_ticker: Record<string, MarketNewsItemV13[]>
  summary_per_ticker: Record<string, TickerNewsSummary>
}

/** 候補銘柄別ニュース（candidates_news.json 準拠） */
export interface CandidatesNewsV13 {
  fetched_at: string
  tracked_tickers: string[]
  items_by_ticker: Record<string, MarketNewsItemV13[]>
  summary_per_ticker: Record<string, TickerNewsSummary>
}

/** 決算カレンダーの1件 */
export interface EarningsEvent {
  ticker: string
  company: string
  date: string                   // YYYY-MM-DD
  time: 'before_open' | 'after_close' | 'unknown'
  consensus_eps: number | null
  actual_eps: number | null
}

/** 決算カレンダー（earnings_calendar.json 準拠） */
export interface EarningsCalendar {
  fetched_at: string
  this_week: EarningsEvent[]
  next_week: EarningsEvent[]
}

/** 各ソースの稼働状況マップ（news_sources_status.json 準拠） */
export type NewsSourcesStatus = Record<NewsSourceId, NewsSourceStatus>

/** 8ソース統合後の全体ニュース（market_news_aggregated.json 準拠） */
export interface NewsAggregatedV13 {
  fetched_at: string
  sources_status: NewsSourcesStatus
  total_items: number
  deduplicated_items: number
  categories: Partial<Record<NewsCategory, MarketNewsItemV13[]>>
  top_items: MarketNewsItemV13[]  // 重要度上位
}

// ═══════════════════════════════════════════════════════════
// candidates_news.json schema: candidates-news-1
// P4-A9c-data-4c: role-unit candidates news types
// ═══════════════════════════════════════════════════════════

export type CandidatesNewsRoleKey =
  | 'jp_broad'
  | 'jp_semiconductor'
  | 'us_broad'
  | 'us_growth'
  | 'global_broad'
  | 'gold'
  | 'reit'
  | 'dividend'
  | 'macro_risk'
  | 'fx'
  | 'rates'
  | 'commodity'
  | 'geopolitical'

export interface CandidatesNewsItem {
  title: string
  source: string
  sentiment: string
  sentimentScore: number
  publishedAt: string | null
  url: string | null
  tags: string[]
  /** P4.5-A005: news.json側でpopulateされていれば引き継がれる日本語タイトル（任意項目） */
  titleJa?: string
}

export interface CandidatesNewsRoleEntry {
  avgSentiment: number
  negativeCount: number
  positiveCount: number
  neutralCount: number
  sourceCount: number
  itemCount: number
  isStale: boolean
  topNegativeTitle: string | null
  topPositiveTitle: string | null
  items: CandidatesNewsItem[]
}

export interface CandidatesNewsData {
  schemaVersion: 'candidates-news-1'
  updatedAt: string
  sourceUpdatedAt: string | null
  staleThresholdHours: number
  assetClassNews: Record<CandidatesNewsRoleKey, CandidatesNewsRoleEntry>
  meta: {
    excludedTags: string[]
    excludedCategories: string[]
    excludedCount: number
    minItemsForSignal: number
    generator: string
    [key: string]: unknown
  }
}
