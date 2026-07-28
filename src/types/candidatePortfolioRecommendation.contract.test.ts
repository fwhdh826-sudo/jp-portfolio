// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  CandidatePortfolioRecommendation,
  CandidatePortfolioRecommendationAction,
  CandidatePortfolioRecommendationInput,
} from './candidatePortfolioRecommendation'

const typesSource = readFileSync(new URL('./candidatePortfolioRecommendation.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const domainSource = readFileSync(new URL('../domain/candidates/candidatePortfolioRecommendation.ts', import.meta.url), 'utf8')
const adapterSource = readFileSync(new URL('../store/candidatePortfolioRecommendation.ts', import.meta.url), 'utf8')

describe('P5-B005-C-D recommendation type contract', () => {
  it('C-C-T01 exact readonly input/output shape compiles', () => {
    const inputKeys = ['artifact', 'fitResult', 'gates'] satisfies readonly (keyof CandidatePortfolioRecommendationInput)[]
    const outputKeys = [
      'candidateRecordId', 'artifactIndex', 'code', 'name', 'marketRank', 'action', 'reason',
    ] satisfies readonly (keyof CandidatePortfolioRecommendation)[]
    expect(inputKeys).toHaveLength(3)
    expect(outputKeys).toHaveLength(7)
    expect(typesSource.match(/readonly /g)?.length).toBeGreaterThanOrEqual(10)
  })

  it('C-C-T02 action is exactly BUY_NEW/WATCH', () => {
    const actions = ['BUY_NEW', 'WATCH'] satisfies CandidatePortfolioRecommendationAction[]
    expect(actions).toEqual(['BUY_NEW', 'WATCH'])
    expect(typesSource).toContain("'BUY_NEW' | 'WATCH'")
    expect(`${domainSource}\n${adapterSource}`).not.toMatch(/BUY_MORE|BLOCKED|SELL/)
  })

  it('C-C-T03 has no score/rank/amount/sizing/order surface', () => {
    for (const forbidden of ['portfolioFitScore', 'portfolioFitRank', 'amount', 'quantity', 'shares', 'sizing', 'order', 'BUY_MORE', 'SELL']) {
      expect(typesSource).not.toContain(forbidden)
    }
    expect(adapterSource).not.toMatch(/candidateScore|suggestedAmount|maxAmount|candidateSizingTier|\bamount\b|\bquantity\b|\bshares\b|\bsizing\b|\border\b/)
    expect(typesSource).toContain('marketRank')
  })

  it('C-C-T04 source adds only candidate_funnel', () => {
    const candidateSource = indexSource.match(/candidateSource\?: ([^\n]+)/)?.[1] ?? ''
    expect(candidateSource).toContain("'candidate_funnel'")
    expect(candidateSource.match(/candidate_funnel/g)).toHaveLength(1)
  })

  it('C-C-T05 AppState and fit contract remain unchanged', () => {
    const appStateBlock = indexSource.slice(indexSource.indexOf('export interface AppState'), indexSource.indexOf('export const INITIAL_STATE'))
    expect(appStateBlock).not.toContain('candidatePortfolioRecommendation')
    expect(appStateBlock).not.toContain('portfolioFitResult')
    expect(typesSource).not.toContain('AppState')
  })
})
