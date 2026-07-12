/**
 * Market Intelligence UI Types — Card 4-10
 * backend/engine/market_intel/ の出力に対応する UI 専用型定義。
 * backend との型共有は行わず、フロントエンド専用として定義する。
 */

export type MacroSignalDirection = 'positive' | 'negative' | 'neutral'
export type MacroSignalStrength  = 'weak' | 'moderate' | 'strong'
export type MarketIntelRiskLevel = 'low' | 'medium' | 'high' | 'crisis'
export type MarketIntelSourceStatus = 'ok' | 'error' | 'rate_limited' | 'timeout'

export interface MacroSignalUI {
  tag: string
  strength: MacroSignalStrength
  direction: MacroSignalDirection
}

export interface MarketNarrativeUI {
  headline: string
  body_lines: string[]
  keywords_summary: string[]
  sentiment_label: 'bullish' | 'neutral' | 'bearish'
  sentiment_score: number    // 0–100
  method: 'rule_stub' | 'narrator_fn'
}

/** market_intel.json のルート型（static fixture） */
export interface MarketIntelData {
  fetched_at: string
  vix: number
  nikkei_5d_return: number
  nikkei_60ma: number
  nikkei_200ma: number
  sp500_dd_30d: number
  usdjpy: number
  risk_level: MarketIntelRiskLevel
  signals: MacroSignalUI[]
  narrative: MarketNarrativeUI
  sources_status: Record<string, MarketIntelSourceStatus>
}

/**
 * EarningsEventUI — public/data/earnings_calendar.json の実際のフォーマットに合わせた型。
 * （news.ts の EarningsEvent とはフィールド名が異なる）
 */
export interface EarningsEventUI {
  code: string
  name: string
  date: string                                      // YYYY-MM-DD
  session: 'before_open' | 'after_close' | string
  importance: 'high' | 'medium' | 'low' | string
  memo?: string
}
