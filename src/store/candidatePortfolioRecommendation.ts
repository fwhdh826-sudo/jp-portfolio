import type { OfficialDecision, OfficialDecisionItem } from '../types'
import type { CandidatePortfolioRecommendation } from '../types/candidatePortfolioRecommendation'

function isValidRecommendation(
  recommendation: CandidatePortfolioRecommendation,
): boolean {
  return (
    (recommendation.action === 'BUY_NEW' || recommendation.action === 'WATCH') &&
    Number.isInteger(recommendation.artifactIndex) &&
    recommendation.artifactIndex >= 0 &&
    recommendation.candidateRecordId === `artifact:${recommendation.artifactIndex}` &&
    recommendation.code.length > 0 &&
    recommendation.name.length > 0 &&
    (recommendation.marketRank === null ||
      (Number.isInteger(recommendation.marketRank) && recommendation.marketRank > 0)) &&
    recommendation.reason.length > 0
  )
}

export function appendCandidatePortfolioRecommendations(
  baseDecision: OfficialDecision | null,
  recommendations: readonly CandidatePortfolioRecommendation[],
): OfficialDecision | null {
  if (baseDecision === null) return null
  if (!recommendations.every(isValidRecommendation)) return baseDecision
  if (recommendations.length === 0) return baseDecision

  const items: OfficialDecisionItem[] = recommendations.map(recommendation => ({
    id: `candidate-funnel-${recommendation.artifactIndex}`,
    assetType: 'stock',
    code: recommendation.code,
    name: recommendation.name,
    action: recommendation.action,
    reason: recommendation.reason,
    source: 'candidate',
    isCandidate: true,
    candidateSource: 'candidate_funnel',
  }))

  return {
    ...baseDecision,
    actions: [...baseDecision.actions, ...items],
  }
}
