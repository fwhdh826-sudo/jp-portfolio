// ═══════════════════════════════════════════════════════════
// P4.5-A004: ニュース表示ヘルパー（表示専用 — 判断ロジックへの影響なし）
// 日本語優先表示のfallback順序と、掲載件数の制限を一元化する。
// ═══════════════════════════════════════════════════════════
import type { NewsItem } from '../types'

// ── 掲載件数の目安（P4.5-A004） ─────────────────────────────
export const NEWS_DISPLAY_LIMITS = {
  /** T0ホーム: 重要ニュースのみ少数表示 */
  T0_HOME: 5,
  /** News詳細タブ「市場全体」カテゴリ: 十分な件数を確保 */
  NEWS_TAB_MARKET: 20,
  /** 保有銘柄/候補銘柄カテゴリ全体の上限（1銘柄あたり上限とは別に、全体もこの件数で頭打ち） */
  NEWS_TAB_PER_STOCK_CATEGORY_TOTAL: 20,
  /** 保有銘柄/候補銘柄ニュース: 1銘柄あたりの上限件数 */
  PER_TICKER_MAX: 3,
} as const

export interface NewsDisplayText {
  title: string
  summary: string
  /** true: titleJa等の日本語フィールドがなく、翻訳ステータスも未完了・原文表示中（「海外記事」ラベル対象） */
  isUntranslated: boolean
}

/**
 * 日本語優先のtitle/summaryを解決する。
 * 優先順位: titleJa/summaryJa（翻訳済み） > title/summary（原文フォールバック）。
 * 外部翻訳APIは呼ばない — 既存JSONフィールドの参照のみ。
 */
export function resolveNewsDisplayText(
  item: Pick<NewsItem, 'title' | 'summary' | 'titleJa' | 'summaryJa' | 'translationStatus'>,
): NewsDisplayText {
  const title = item.titleJa?.trim() || item.title
  const summary = item.summaryJa?.trim() || item.summary
  const isUntranslated =
    !item.titleJa?.trim() &&
    item.translationStatus !== 'ja-original' &&
    item.translationStatus !== 'translated'
  return { title, summary, isUntranslated }
}

/**
 * 銘柄コードに紐づくニュースを「1銘柄あたり最大maxPerTicker件」に間引く。
 * tickersが空の記事（キーワード一致等でヒットした市場記事）は対象外としてそのまま通す
 * — 銘柄非紐付け記事まで削ると「候補銘柄ニュース」タブが薄くなりすぎるため。
 * 表示順序（呼び出し側で重要度順ソート済みの配列）は維持する。
 */
export function limitNewsPerTicker(items: NewsItem[], maxPerTicker: number): NewsItem[] {
  const perTickerCount = new Map<string, number>()
  return items.filter(item => {
    if (item.tickers.length === 0) return true
    const underLimit = item.tickers.some(t => (perTickerCount.get(t) ?? 0) < maxPerTicker)
    if (!underLimit) return false
    item.tickers.forEach(t => perTickerCount.set(t, (perTickerCount.get(t) ?? 0) + 1))
    return true
  })
}
