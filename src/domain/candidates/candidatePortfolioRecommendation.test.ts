import { describe, expect, it } from 'vitest'
import { buildValidCandidateFunnelArtifact } from '../../services/candidateFunnelArtifact.fixtures'
import {
  CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
  CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
  CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
  CANDIDATE_PORTFOLIO_FIT_VERSION,
  type CandidatePortfolioFitRecord,
  type CandidatePortfolioFitResult,
} from '../../types/candidatePortfolioFit'
import type { CandidateFunnelArtifact } from '../../types/candidateFunnelArtifact'
import {
  CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS,
  composeCandidatePortfolioRecommendations,
} from './candidatePortfolioRecommendation'

function artifactCandidate(index: number, overrides: Record<string, unknown> = {}) {
  const base = structuredClone(buildValidCandidateFunnelArtifact()).candidates[2]
  return {
    ...base,
    code: `10${index.toString().padStart(2, '0')}`,
    name: `候補${index}`,
    marketRank: index + 1,
    tier: 'actionable',
    ...overrides,
  }
}

function artifact(candidates = [artifactCandidate(0)]): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact())
  value.candidates = candidates
  value.counts = {
    total: candidates.length,
    excluded: 0,
    screened: 0,
    deepReview: candidates.filter(candidate => candidate.tier === 'deep_review').length,
    actionable: candidates.filter(candidate => candidate.tier === 'actionable').length,
  }
  return value
}

function fitRecord(
  candidate: ReturnType<typeof artifactCandidate>,
  artifactIndex: number,
  overrides: Partial<CandidatePortfolioFitRecord> = {},
): CandidatePortfolioFitRecord {
  return {
    candidateRecordId: `artifact:${artifactIndex}`,
    artifactIndex,
    code: candidate.code,
    normalizedCode: candidate.code,
    candidateMarketRank: candidate.marketRank as number | null,
    candidateTier: candidate.tier as 'actionable' | 'deep_review',
    holdingRelationship: 'new_to_portfolio',
    portfolioFitScore: null,
    portfolioFitRank: null,
    portfolioFitStatus: 'evaluated',
    components: [],
    fitReasons: ['NEW_TO_PORTFOLIO'],
    fitRisks: [],
    ...overrides,
  }
}

function fitResult(
  candidates: ReturnType<typeof artifactCandidate>[],
  overrides: Partial<CandidatePortfolioFitResult> = {},
): CandidatePortfolioFitResult {
  return {
    schemaVersion: CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
    fitVersion: CANDIDATE_PORTFOLIO_FIT_VERSION,
    scoreModel: CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
    targetPopulation: CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
    evaluatedAt: '2026-07-28T00:00:00.000Z',
    candidateGeneratedAt: '2026-07-27T00:00:00.000Z',
    portfolioSourceAsOf: '2026-07-27T00:00:00.000Z',
    portfolioFreshness: 'fresh',
    status: 'evaluated',
    capacity: { assetClass: 'JP_STOCK', status: 'available', reasons: [] },
    records: candidates.map((candidate, index) => fitRecord(candidate, index)),
    degradationReasons: [],
    qualityGate: {
      inputTargetCount: candidates.length,
      outputRecordCount: candidates.length,
      hardFailIds: [],
      warningIds: [],
    },
    ...overrides,
  }
}

function compose(
  candidates = [artifactCandidate(0)],
  fitOverrides: Partial<CandidatePortfolioFitResult> = {},
  gates = { dataQualitySuppressed: false, noTrade: false, safeModeActive: false },
  artifactOverrides: Record<string, unknown> = {},
) {
  return composeCandidatePortfolioRecommendations({
    artifact: Object.assign(artifact(candidates), artifactOverrides),
    fitResult: fitResult(candidates, fitOverrides),
    gates,
  })
}

describe('P5-B005-C-D pure recommendation policy', () => {
  it('C-C-T06 actionable evaluated new available clear becomes BUY_NEW', () => {
    expect(compose()[0]).toMatchObject({ action: 'BUY_NEW', reason: CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.BUY_NEW })
  })
  it('C-C-T07 deep_review becomes WATCH', () => {
    expect(compose([artifactCandidate(0, { tier: 'deep_review' })])[0]).toMatchObject({ action: 'WATCH', reason: CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.DEEP_REVIEW })
  })
  it('C-C-T08 already_held is omitted', () => {
    const candidates = [artifactCandidate(0)]
    expect(compose(candidates, { records: [fitRecord(candidates[0], 0, { holdingRelationship: 'already_held' })] })).toEqual([])
  })
  it('C-C-T09 holding_match_unknown is omitted', () => {
    const candidates = [artifactCandidate(0)]
    expect(compose(candidates, { records: [fitRecord(candidates[0], 0, { holdingRelationship: 'holding_match_unknown' })] })).toEqual([])
  })
  it('C-C-T10 invalid dataset is empty', () => {
    expect(compose(undefined, { status: 'invalid' })).toEqual([])
  })
  it('C-C-T11 unavailable dataset is empty', () => {
    expect(compose(undefined, { status: 'unavailable' })).toEqual([])
  })
  it('C-C-T12 hard fail is empty', () => {
    expect(compose(undefined, { qualityGate: { inputTargetCount: 1, outputRecordCount: 1, hardFailIds: ['PF-QG-01-CANDIDATE_CONTRACT'], warningIds: [] } })).toEqual([])
  })
  it('C-C-T13 dataset partial becomes WATCH', () => {
    expect(compose(undefined, { status: 'partial' })[0]).toMatchObject({ action: 'WATCH', reason: CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.PARTIAL })
  })
  it('C-C-T14 record partial becomes WATCH', () => {
    const candidates = [artifactCandidate(0)]
    expect(compose(candidates, { records: [fitRecord(candidates[0], 0, { portfolioFitStatus: 'partial' })] })[0]).toMatchObject({ action: 'WATCH', reason: CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.PARTIAL })
  })
  for (const [id, status] of [['C-C-T15', 'constrained'], ['C-C-T16', 'unknown'], ['C-C-T17', 'unavailable']] as const) {
    it(`${id} ${status} capacity becomes WATCH`, () => {
      expect(compose(undefined, { capacity: { assetClass: 'JP_STOCK', status, reasons: [] } })[0]).toMatchObject({ action: 'WATCH', reason: CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.CAPACITY })
    })
  }
  it('C-C-T18 DQ WATCH uses exact copy', () => {
    expect(compose(undefined, {}, { dataQualitySuppressed: true, noTrade: false, safeModeActive: false })[0].reason).toBe(CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.DATA_QUALITY)
  })
  it('C-C-T19 noTrade WATCH uses exact copy', () => {
    expect(compose(undefined, {}, { dataQualitySuppressed: false, noTrade: true, safeModeActive: false })[0].reason).toBe(CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.NO_TRADE)
  })
  it('C-C-T20 SAFE_MODE WATCH uses exact copy', () => {
    expect(compose(undefined, {}, { dataQualitySuppressed: false, noTrade: false, safeModeActive: true })[0].reason).toBe(CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.SAFE_MODE)
  })
  it('C-C-T21 multiple downgrade precedence is DQ then noTrade then SAFE_MODE then partial then capacity', () => {
    const result = compose(undefined, { status: 'partial', capacity: { assetClass: 'JP_STOCK', status: 'unknown', reasons: [] } }, { dataQualitySuppressed: true, noTrade: true, safeModeActive: true })
    expect(result[0].reason).toBe(CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.DATA_QUALITY)
  })
  it('C-C-T22 orders by marketRank ascending', () => {
    const candidates = [
      artifactCandidate(0, { marketRank: 3, marketScore: 99 }),
      artifactCandidate(1, { marketRank: 1, marketScore: 1 }),
      artifactCandidate(2, { marketRank: 2, marketScore: 50 }),
    ]
    expect(compose(candidates).map(row => row.marketRank)).toEqual([1, 2, 3])
  })
  it('C-C-T23 puts null and invalid rank last', () => {
    const candidates = [artifactCandidate(0, { marketRank: null }), artifactCandidate(1, { marketRank: -1 }), artifactCandidate(2, { marketRank: 1 })]
    expect(compose(candidates).map(row => row.artifactIndex)).toEqual([2, 0, 1])
    expect(compose(candidates).map(row => row.marketRank)).toEqual([1, null, null])
  })
  it('C-C-T24 uses artifactIndex for equal-rank tie', () => {
    const candidates = [artifactCandidate(0, { marketRank: 1 }), artifactCandidate(1, { marketRank: 1 })]
    expect(compose(candidates).map(row => row.artifactIndex)).toEqual([0, 1])
  })
  it('C-C-T25 caps output at three', () => {
    expect(compose([0, 1, 2, 3, 4].map(index => artifactCandidate(index)))).toHaveLength(3)
  })
  it('C-C-T26 keeps duplicate codes independent', () => {
    const candidates = [artifactCandidate(0, { code: '7777' }), artifactCandidate(1, { code: '7777' })]
    expect(compose(candidates).map(row => row.candidateRecordId)).toEqual(['artifact:0', 'artifact:1'])
  })
  it('C-C-T27 omits two-leg identity mismatch and ambiguous exact records', () => {
    const candidates = [artifactCandidate(0)]
    const exact = fitRecord(candidates[0], 0)
    expect(compose(candidates, { records: [exact, { ...exact }] })).toEqual([])
    expect(compose(candidates, { records: [{ ...exact, code: '9999' }] })).toEqual([])
  })
  it('C-C-T28 omits non-F2 tiers', () => {
    expect(compose([artifactCandidate(0, { tier: 'screened' })])).toEqual([])
  })
  it('C-C-T29 leaves artifact and fit result immutable', () => {
    const candidates = [artifactCandidate(0), artifactCandidate(1)]
    const artifactValue = artifact(candidates)
    const fitValue = fitResult(candidates)
    const beforeArtifact = structuredClone(artifactValue)
    const beforeFit = structuredClone(fitValue)
    composeCandidatePortfolioRecommendations({ artifact: artifactValue, fitResult: fitValue, gates: { dataQualitySuppressed: false, noTrade: false, safeModeActive: false } })
    expect(artifactValue).toEqual(beforeArtifact)
    expect(fitValue).toEqual(beforeFit)
  })
  it('C-C-T30 is deterministic across replay and timezone', () => {
    const candidates = [artifactCandidate(0), artifactCandidate(1)]
    const input = { artifact: artifact(candidates), fitResult: fitResult(candidates), gates: { dataQualitySuppressed: false, noTrade: false, safeModeActive: false } }
    expect(composeCandidatePortfolioRecommendations(input)).toEqual(composeCandidatePortfolioRecommendations(structuredClone(input)))
  })
})
