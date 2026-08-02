import type {
  AllocationPlanSnapshotState,
  OfficialDecision,
  OfficialDecisionItem,
} from '../types'
import type { AllocationPlanSnapshot } from '../types/allocationPlan'
import type {
  CandidateArtifactAllocationFreshness,
  CandidatePortfolioRecommendation,
} from '../types/candidatePortfolioRecommendation'
import { candidateAllocationInstrumentId } from '../domain/candidates/candidatePortfolioRecommendation'
import {
  orderBlockedReasons,
  orderLimitingFactors,
  orderWarningReasons,
  snapshotExecutability,
} from './allocationPlanSelectors'

export interface CandidateAllocationProjectionInput {
  readonly recommendations: readonly CandidatePortfolioRecommendation[]
  readonly snapshot: AllocationPlanSnapshot | null
  readonly snapshotStatus: AllocationPlanSnapshotState
  readonly snapshotCandidateGenerationId: string | null
  readonly sourceCandidateGenerationId: string
  readonly sourceCandidateFreshness: CandidateArtifactAllocationFreshness
}

function unavailableRecommendations(
  recommendations: readonly CandidatePortfolioRecommendation[],
): readonly CandidatePortfolioRecommendation[] {
  if (recommendations.every(recommendation => recommendation.allocation === null)) {
    return recommendations
  }
  return recommendations.map(recommendation => ({ ...recommendation, allocation: null }))
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Exact identity join from an already-built snapshot. This function copies
 * authority fields only: it performs no monetary calculation, rounding,
 * ranking, reason generation, or executability decision.
 */
export function projectCandidatePortfolioRecommendations(
  input: CandidateAllocationProjectionInput,
): readonly CandidatePortfolioRecommendation[] {
  const unavailable = () => unavailableRecommendations(input.recommendations)
  if (
    input.snapshot === null ||
    input.snapshotStatus === 'absent' ||
    input.snapshotStatus === 'invalid' ||
    input.snapshotStatus === 'stale' ||
    input.snapshotCandidateGenerationId === null ||
    input.sourceCandidateGenerationId.length === 0 ||
    input.snapshotCandidateGenerationId !== input.sourceCandidateGenerationId
  ) return unavailable()
  const snapshotBlockedReasons = orderBlockedReasons(input.snapshot.blockedReasons)
  const snapshotWarningReasons = orderWarningReasons(input.snapshot.warnings)
  if (
    input.snapshot.snapshotId.length === 0 ||
    input.snapshot.generatedAt.length === 0 ||
    input.snapshot.sourceHoldingsSnapshotId.length === 0 ||
    input.snapshot.sourceSettingsVersion.length === 0 ||
    snapshotBlockedReasons === null ||
    snapshotWarningReasons === null
  ) return unavailable()

  const recommendationIds = new Map<CandidatePortfolioRecommendation, string>()
  const seenRecommendationIds = new Set<string>()
  for (const recommendation of input.recommendations) {
    const instrumentId = candidateAllocationInstrumentId(recommendation.code)
    if (instrumentId === null || seenRecommendationIds.has(instrumentId)) return unavailable()
    seenRecommendationIds.add(instrumentId)
    recommendationIds.set(recommendation, instrumentId)
  }

  const planById = new Map<string, AllocationPlanSnapshot['instrumentPlans'][number]>()
  for (const plan of input.snapshot.instrumentPlans) {
    if (planById.has(plan.instrumentId)) return unavailable()
    planById.set(plan.instrumentId, plan)
  }
  const projected = input.recommendations.map(recommendation => {
    const instrumentId = recommendationIds.get(recommendation)
    const plan = instrumentId === undefined ? undefined : planById.get(instrumentId)
    if (
      plan === undefined ||
      plan.assetClass !== 'JP_STOCK' ||
      plan.calculationSnapshotId !== input.snapshot?.snapshotId
    ) return { ...recommendation, allocation: null }
    const classPlans = input.snapshot.assetClassPlans.filter(
      classPlan => classPlan.assetClass === plan.assetClass,
    )
    if (classPlans.length !== 1) return { ...recommendation, allocation: null }
    const classPlan = classPlans[0]
    const classBlockedReasons = orderBlockedReasons(classPlan.blockedReasons)
    const classWarningReasons = orderWarningReasons(classPlan.warningReasons)
    const classLimitingFactors = orderLimitingFactors(classPlan.limitingFactors)
    const blockedReasons = orderBlockedReasons(plan.blockedReasons)
    const warningReasons = orderWarningReasons(plan.warningReasons)
    const limitingFactors = orderLimitingFactors([
      ...classPlan.limitingFactors,
      ...plan.limitingFactors,
    ])
    if (
      classBlockedReasons === null ||
      classWarningReasons === null ||
      classLimitingFactors === null ||
      blockedReasons === null ||
      warningReasons === null ||
      limitingFactors === null ||
      !isNonNegativeInteger(plan.estimatedMaximumAmount) ||
      !isNonNegativeInteger(plan.finalSuggestedAmount) ||
      !isNonNegativeInteger(plan.classHeadroom) ||
      !isNonNegativeInteger(plan.effectiveInstrumentHeadroom) ||
      !isNonNegativeInteger(classPlan.remainingHeadroom)
    ) return { ...recommendation, allocation: null }
    return {
      ...recommendation,
      allocation: {
        snapshotId: input.snapshot.snapshotId,
        snapshotGeneratedAt: input.snapshot.generatedAt,
        snapshotStatus: input.snapshotStatus,
        snapshotExecutability: snapshotExecutability(input.snapshot),
        sourceCandidateGenerationId: input.sourceCandidateGenerationId,
        sourceCandidateFreshness: input.sourceCandidateFreshness,
        sourceHoldingsSnapshotId: input.snapshot.sourceHoldingsSnapshotId,
        sourceSettingsVersion: input.snapshot.sourceSettingsVersion,
        instrumentId: plan.instrumentId,
        assetClass: plan.assetClass,
        estimatedMaximumAmount: plan.estimatedMaximumAmount,
        finalSuggestedAmount: plan.finalSuggestedAmount,
        executable: plan.executable,
        classHeadroom: plan.classHeadroom,
        instrumentHeadroom: plan.effectiveInstrumentHeadroom,
        remainingHeadroom: classPlan.remainingHeadroom,
        blockedReasons,
        warningReasons,
        limitingFactors,
      },
    } satisfies CandidatePortfolioRecommendation
  })

  return projected
}

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
