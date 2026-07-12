// P4.5-A004: ニュース表示ヘルパー（日本語優先表示・1銘柄あたり件数制限）のテスト
import { describe, expect, it } from 'vitest'
import { resolveNewsDisplayText, limitNewsPerTicker } from './newsDisplay'
import type { NewsItem } from '../types'

function makeItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'n1',
    source: 'Bloomberg Markets',
    title: 'Stocks rally as inflation cools',
    summary: 'US equities rose after inflation data came in below expectations.',
    url: 'https://example.com/n1',
    publishedAt: '2026-07-04T00:00:00+00:00',
    sentiment: 'positive',
    sentimentScore: 0.5,
    importance: 0.6,
    tags: [],
    tickers: [],
    ...overrides,
  }
}

describe('resolveNewsDisplayText', () => {
  it('titleJa/summaryJaがある場合はそれを優先表示する', () => {
    const item = makeItem({ titleJa: 'インフレ鈍化で株高', summaryJa: '米インフレ指標が予想を下回り米国株が上昇した。' })
    const r = resolveNewsDisplayText(item)
    expect(r.title).toBe('インフレ鈍化で株高')
    expect(r.summary).toBe('米インフレ指標が予想を下回り米国株が上昇した。')
    expect(r.isUntranslated).toBe(false)
  })

  it('titleJa/summaryJaがない場合は原文にfallbackし、isUntranslated=trueになる', () => {
    const item = makeItem()
    const r = resolveNewsDisplayText(item)
    expect(r.title).toBe('Stocks rally as inflation cools')
    expect(r.summary).toBe('US equities rose after inflation data came in below expectations.')
    expect(r.isUntranslated).toBe(true)
  })

  it('titleJaが空文字の場合も原文にfallbackする', () => {
    const item = makeItem({ titleJa: '', summaryJa: '   ' })
    const r = resolveNewsDisplayText(item)
    expect(r.title).toBe('Stocks rally as inflation cools')
    expect(r.summary).toBe('US equities rose after inflation data came in below expectations.')
    expect(r.isUntranslated).toBe(true)
  })

  it('translationStatus=ja-originalの場合、titleJaがなくてもisUntranslated=falseになる（原文が既に日本語）', () => {
    const item = makeItem({ translationStatus: 'ja-original' })
    const r = resolveNewsDisplayText(item)
    expect(r.isUntranslated).toBe(false)
  })

  it('translationStatus=pendingの場合はisUntranslated=trueのまま（海外記事ラベル対象）', () => {
    const item = makeItem({ translationStatus: 'pending' })
    const r = resolveNewsDisplayText(item)
    expect(r.isUntranslated).toBe(true)
  })
})

describe('limitNewsPerTicker', () => {
  it('同一tickerの記事は1銘柄あたりmaxPerTicker件までに間引かれる', () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `n${i}`, tickers: ['7203'] }))
    const limited = limitNewsPerTicker(items, 3)
    expect(limited).toHaveLength(3)
    expect(limited.map(i => i.id)).toEqual(['n0', 'n1', 'n2'])
  })

  it('tickersが空の記事は上限の対象外で常に通す', () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `n${i}`, tickers: [] }))
    const limited = limitNewsPerTicker(items, 3)
    expect(limited).toHaveLength(5)
  })

  it('複数銘柄の記事が混在する場合、銘柄ごとに独立してカウントする', () => {
    const items = [
      makeItem({ id: 'a1', tickers: ['7203'] }),
      makeItem({ id: 'a2', tickers: ['7203'] }),
      makeItem({ id: 'b1', tickers: ['6501'] }),
      makeItem({ id: 'a3', tickers: ['7203'] }),
      makeItem({ id: 'a4', tickers: ['7203'] }), // 7203の4件目 → 上限(3)超過で除外
      makeItem({ id: 'b2', tickers: ['6501'] }),
    ]
    const limited = limitNewsPerTicker(items, 3)
    expect(limited.map(i => i.id)).toEqual(['a1', 'a2', 'b1', 'a3', 'b2'])
  })

  it('元の並び順（呼び出し側でソート済みの重要度順）を維持する', () => {
    const items = [
      makeItem({ id: 'high', importance: 0.9, tickers: ['7203'] }),
      makeItem({ id: 'mid', importance: 0.5, tickers: ['7203'] }),
      makeItem({ id: 'low', importance: 0.1, tickers: ['7203'] }),
    ]
    const limited = limitNewsPerTicker(items, 2)
    expect(limited.map(i => i.id)).toEqual(['high', 'mid'])
  })
})
