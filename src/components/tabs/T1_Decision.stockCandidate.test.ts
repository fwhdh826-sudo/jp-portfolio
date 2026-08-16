// CAND-SYN-1D: T1の候補判断セクション（CandidateDecisionSection）が使う
// 表示専用の純関数（formatStockMetric）の回帰guard、および T0/T1 が
// candidateDecisionSynthesis の canonical order（再ソート禁止・D13）のまま
// 描画することの構成guard。
import { describe, it, expect } from 'vitest'
import { formatStockMetric } from './T1_Decision'
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

describe('CAND-SYN-1D frozen T1 composition protection', () => {
  it('D13/T61 keeps CandidateDecisionSection immediately before CandidateFunnelPanel', () => {
    const withoutJsxComments = t1Source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(withoutJsxComments).toMatch(
      /<CandidateDecisionSection\s*\/>\s*<CandidateFunnelPanel\s*\/>/,
    )
  })

  it('D13/T62 preserves StockList/StockDetail (holding views, unrelated to candidate synthesis)', () => {
    expect(t1Source).toContain('function StockList')
    expect(t1Source).toContain('function StockDetail')
    expect(panelSource).not.toContain('.reverse()')
    expect(panelSource).toContain('return leftRank - rightRank || left.artifactIndex - right.artifactIndex')
  })

  it('D13/T63 no second ranking: legacy stockCandidates score-sort helper is retired', () => {
    expect(t1Source).not.toContain('sortStockCandidatesForDisplay')
    expect(t1Source).not.toContain('STOCK_ACTION_ORDER')
  })

  it('D13/T64 CandidateDecisionSection renders synthesis.decisions before synthesis.watchList, concatenated only (no re-sort)', () => {
    const section = t1Source.slice(
      t1Source.indexOf('function CandidateDecisionSection'),
      t1Source.indexOf('function CandidateDecisionSection') + 2000,
    )
    expect(section).toContain('decisions.map(entry =>')
    expect(section).toContain('watchList.map(entry =>')
    expect(section.indexOf('decisions.map(entry =>')).toBeLessThan(section.indexOf('watchList.map(entry =>'))
    expect(section).not.toMatch(/\.sort\(/)
  })

  it('D13/T65 no legacy money field (maxAmount/検討上限) appears in the candidate section', () => {
    const section = t1Source.slice(
      t1Source.indexOf('function CandidateDecisionSection'),
      t1Source.indexOf('function CandidateDecisionSection') + 2000,
    )
    expect(section).not.toContain('maxAmount')
    expect(section).not.toContain('検討上限')
  })
})
