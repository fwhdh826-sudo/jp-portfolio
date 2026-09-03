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
    // P5-B005-B3-C-V2-R1 FIX F: CandidateDecisionSection へ rawFunnelAvailable の
    // 導出（synthesis 連携待ちと raw funnel 可用性の分離文言）を追加したため、
    // 走査窓を 2000 → 2800 に拡張。decisions→watchList 順・再ソート禁止の意図は不変。
    const section = t1Source.slice(
      t1Source.indexOf('function CandidateDecisionSection'),
      t1Source.indexOf('function CandidateDecisionSection') + 2800,
    )
    expect(section).toContain('decisions.map(entry =>')
    expect(section).toContain('watchList.map(entry =>')
    expect(section.indexOf('decisions.map(entry =>')).toBeLessThan(section.indexOf('watchList.map(entry =>'))
    expect(section).not.toMatch(/\.sort\(/)
  })

  it('D13/T65 no legacy money field (maxAmount/検討上限) appears in the candidate section', () => {
    const section = t1Source.slice(
      t1Source.indexOf('function CandidateDecisionSection'),
      t1Source.indexOf('function CandidateDecisionSection') + 2800,
    )
    expect(section).not.toContain('maxAmount')
    expect(section).not.toContain('検討上限')
  })

  // P5-B005-B3-C-V2-R1 P3: synthesis entry card の候補スコア label を raw funnel と
  // 揃える（「スコア」→「市場スコア」）。
  it('R1-P3 synthesis entry card labels the candidate score as 市場スコア (matches raw funnel card)', () => {
    expect(t1Source).toContain('市場スコア {entry.candidateQuality.marketScore.toFixed(1)}')
    expect(t1Source).not.toMatch(/\bスコア {entry\.candidateQuality\.marketScore/)
  })

  // P5-B005-B3-C-V2-R1 FIX F: raw funnel available + synthesis pending の文言分離。
  it('R1-F CandidateDecisionSection distinguishes raw funnel availability from synthesis linkage wait', () => {
    const section = t1Source.slice(
      t1Source.indexOf('function CandidateDecisionSection'),
      t1Source.indexOf('function CandidateDecisionSection') + 2800,
    )
    expect(section).toContain('isCandidateFunnelRawAvailable')
    expect(section).toContain('rawFunnelAvailable')
    expect(section).toContain('ポートフォリオ連携結果を更新中です')
    expect(section).toContain('市場候補ファネルは下に表示しています')
  })
})
