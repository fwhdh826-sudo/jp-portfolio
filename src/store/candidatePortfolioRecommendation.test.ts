// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { OfficialDecision } from '../types'
import type { CandidatePortfolioRecommendation } from '../types/candidatePortfolioRecommendation'
import { appendCandidatePortfolioRecommendations } from './candidatePortfolioRecommendation'

function decision(): OfficialDecision {
  return {
    generatedAt: '2026-07-28T00:00:00.000Z',
    source: 'committee',
    headline: '判断',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions: [{
      id: 'base',
      assetType: 'portfolio',
      name: '既存判断',
      action: 'HOLD',
      reason: '既存理由',
      source: 'committee',
    }],
    risks: ['既存リスク'],
    rationale: ['既存根拠'],
  }
}

function recommendation(overrides: Partial<CandidatePortfolioRecommendation> = {}): CandidatePortfolioRecommendation {
  return {
    candidateRecordId: 'artifact:0',
    artifactIndex: 0,
    code: '1001',
    name: '候補',
    marketRank: 1,
    action: 'BUY_NEW',
    reason: '市場候補ファネルの重点候補で、未保有照合と日本株枠の余力を確認しました。売買執行・金額算定は未実施です。',
    allocation: null,
    ...overrides,
  }
}

describe('P5-B005-C-D OfficialDecision adapter', () => {
  it('C-C-T31 projects exact OfficialDecision item', () => {
    const result = appendCandidatePortfolioRecommendations(decision(), [recommendation()])
    expect(result?.actions[result.actions.length - 1]).toEqual({
      id: 'candidate-funnel-0',
      assetType: 'stock',
      code: '1001',
      name: '候補',
      action: 'BUY_NEW',
      reason: recommendation().reason,
      source: 'candidate',
      isCandidate: true,
      candidateSource: 'candidate_funnel',
    })
  })
  it('C-C-T32 BUY_NEW has no amount/score/sizing', () => {
    const actions = appendCandidatePortfolioRecommendations(decision(), [recommendation()])?.actions ?? []
    const item = actions[actions.length - 1]
    expect(item).not.toHaveProperty('amount')
    expect(item).not.toHaveProperty('candidateScore')
    expect(item).not.toHaveProperty('suggestedAmount')
    expect(item).not.toHaveProperty('maxAmount')
    expect(item).not.toHaveProperty('candidateSizingTier')
  })
  it('C-C-T33 WATCH has no trade/sizing fields', () => {
    const actions = appendCandidatePortfolioRecommendations(decision(), [recommendation({ action: 'WATCH' })])?.actions ?? []
    const item = actions[actions.length - 1]
    expect(item?.action).toBe('WATCH')
    expect(item).not.toHaveProperty('amount')
    expect(item).not.toHaveProperty('constraintsPassed')
    expect(item).not.toHaveProperty('constraintsBlocked')
  })
  it('C-C-T34 retains base order and appends only', () => {
    const base = decision()
    const result = appendCandidatePortfolioRecommendations(base, [recommendation()])
    expect(result).not.toBe(base)
    expect(result?.actions[0]).toBe(base.actions[0])
    expect(result?.risks).toBe(base.risks)
    expect(result?.rationale).toBe(base.rationale)
  })
  it('C-C-T35 keeps null base null', () => {
    expect(appendCandidatePortfolioRecommendations(null, [recommendation()])).toBeNull()
  })
  it('C-C-T36 adapter validation failure leaves base unchanged', () => {
    const base = decision()
    expect(appendCandidatePortfolioRecommendations(base, [recommendation({ candidateRecordId: 'wrong' })])).toBe(base)
  })
  it('C-C-T37 retains one evaluatedAt authority', () => {
    const base = decision()
    const result = appendCandidatePortfolioRecommendations(base, [recommendation()])
    expect(result?.generatedAt).toBe(base.generatedAt)
    expect(result?.actions[result.actions.length - 1]).not.toHaveProperty('generatedAt')
  })
  it('C-C-T38 canonical none/invalid produces no item', () => {
    const base = decision()
    expect(appendCandidatePortfolioRecommendations(base, [])).toBe(base)
  })
  it('C-C-T39 exact commit projection has no ambient portfolio fallback', () => {
    const actions = appendCandidatePortfolioRecommendations(decision(), [recommendation()])?.actions ?? []
    const item = actions[actions.length - 1]
    expect(item).not.toHaveProperty('holdings')
    expect(item).not.toHaveProperty('cash')
    expect(item).not.toHaveProperty('account')
  })
  it('C-C-T40 domain and adapter contain no restore/storage/network', () => {
    const domainSource = readFileSync(new URL('../domain/candidates/candidatePortfolioRecommendation.ts', import.meta.url), 'utf8')
    const adapterSource = readFileSync(new URL('./candidatePortfolioRecommendation.ts', import.meta.url), 'utf8')
    for (const source of [domainSource, adapterSource]) {
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/)
      expect(source).not.toMatch(/restoreCsv|persistCsv|setState|Date\.now|Math\.random/)
    }
  })
})
