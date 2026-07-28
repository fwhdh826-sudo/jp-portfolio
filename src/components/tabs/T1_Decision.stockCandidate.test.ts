// P5-B003: T1の新規個別株候補詳細セクション（StockCandidateSection）が使う
// 表示専用の純関数（formatStockMetric / sortStockCandidatesForDisplay）の回帰guard。
import { describe, it, expect } from 'vitest'
import { formatStockMetric, sortStockCandidatesForDisplay } from './T1_Decision'
// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'

const t1Source = readFileSync(
  new URL('./T1_Decision.tsx', import.meta.url),
  'utf8',
)
const panelSource = readFileSync(
  new URL('../candidates/CandidateFunnelPanel.tsx', import.meta.url),
  'utf8',
)

describe('formatStockMetric', () => {
  it('nullのとき「—」を返す', () => {
    expect(formatStockMetric(null)).toBe('—')
  })

  it('undefinedのとき「—」を返す', () => {
    expect(formatStockMetric(undefined)).toBe('—')
  })

  it('数値をそのまま文字列化する', () => {
    expect(formatStockMetric(9.9)).toBe('9.9')
  })

  it('suffixを付与できる', () => {
    expect(formatStockMetric(10.23, '%')).toBe('10.23%')
  })

  it('0はnullとして扱わず「0」を表示する', () => {
    expect(formatStockMetric(0)).toBe('0')
  })
})

describe('sortStockCandidatesForDisplay', () => {
  it('BUY_NEW → WATCH → BLOCKED の順にグループ化する', () => {
    const candidates = [
      { action: 'BLOCKED', score: 90, code: 'a' },
      { action: 'BUY_NEW', score: 50, code: 'b' },
      { action: 'WATCH', score: 70, code: 'c' },
    ]
    const result = sortStockCandidatesForDisplay(candidates)
    expect(result.map(c => c.code)).toEqual(['b', 'c', 'a'])
  })

  it('同一action内はscore降順', () => {
    const candidates = [
      { action: 'WATCH', score: 50, code: 'low' },
      { action: 'WATCH', score: 90, code: 'high' },
      { action: 'WATCH', score: 70, code: 'mid' },
    ]
    const result = sortStockCandidatesForDisplay(candidates)
    expect(result.map(c => c.code)).toEqual(['high', 'mid', 'low'])
  })

  it('元配列を破壊しない（非破壊ソート）', () => {
    const candidates = [
      { action: 'WATCH', score: 50, code: 'a' },
      { action: 'BUY_NEW', score: 90, code: 'b' },
    ]
    const original = [...candidates]
    sortStockCandidatesForDisplay(candidates)
    expect(candidates).toEqual(original)
  })

  it('空配列を渡すと空配列を返す', () => {
    expect(sortStockCandidatesForDisplay([])).toEqual([])
  })
})

describe('P5-B005-C-B3 frozen T1 composition protection', () => {
  it('C-B3-T59 keeps StockCandidateSection immediately before CandidateFunnelPanel', () => {
    const withoutJsxComments = t1Source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(withoutJsxComments).toMatch(
      /<StockCandidateSection\s*\/>\s*<CandidateFunnelPanel\s*\/>/,
    )
  })

  it('C-B3-T60 preserves StockList, StockDetail, and market candidate ordering', () => {
    expect(t1Source).toContain('function StockList')
    expect(t1Source).toContain('function StockDetail')
    expect(t1Source).toContain('sortStockCandidatesForDisplay')
    expect(t1Source).toContain("BUY_NEW: 0")
    expect(t1Source).toContain("WATCH: 1")
    expect(t1Source).toContain("BLOCKED: 2")
    expect(panelSource).not.toContain('.reverse()')
    expect(panelSource).toContain('return leftRank - rightRank || left.artifactIndex - right.artifactIndex')
  })
})
