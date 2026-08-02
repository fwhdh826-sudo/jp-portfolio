import type { CandidateFunnelArtifact } from './candidateFunnelArtifact'
import type { CandidatePortfolioFitResult } from './candidatePortfolioFit'
import type {
  AssetClass,
  BlockedReason,
  LimitingFactor,
  WarningReason,
} from './allocationPlan'
import type { AllocationPlanSnapshotState } from './index'

export type CandidatePortfolioRecommendationAction = 'BUY_NEW' | 'WATCH'

export interface CandidatePortfolioRecommendationInput {
  readonly artifact: CandidateFunnelArtifact
  readonly fitResult: CandidatePortfolioFitResult
  readonly gates: {
    readonly dataQualitySuppressed: boolean
    readonly noTrade: boolean
    readonly safeModeActive: boolean
  }
}

export interface CandidatePortfolioRecommendation {
  readonly candidateRecordId: string
  readonly artifactIndex: number
  readonly code: string
  readonly name: string
  readonly marketRank: number | null
  readonly action: CandidatePortfolioRecommendationAction
  readonly reason: string
  readonly allocation: CandidateAllocationProjection | null
}

export type CandidateArtifactAllocationFreshness = 'fresh' | 'stale'
export type CandidateSnapshotExecutability =
  | 'NOT_CALCULATED'
  | 'BLOCKED_AT_INPUT_OR_CLASS'
  | 'NO_CANDIDATES'
  | 'CALCULATED_NOT_EXECUTABLE'
  | 'EXECUTABLE'

/**
 * Read-only view of one canonical AllocationPlanSnapshot instrument plan.
 * Every monetary value is copied verbatim from the snapshot; consumers must not
 * derive, round, rank, or otherwise reinterpret these fields.
 */
export interface CandidateAllocationProjection {
  readonly snapshotId: string
  readonly snapshotGeneratedAt: string
  readonly snapshotStatus: AllocationPlanSnapshotState
  readonly snapshotExecutability: CandidateSnapshotExecutability
  readonly sourceCandidateGenerationId: string
  readonly sourceCandidateFreshness: CandidateArtifactAllocationFreshness
  readonly sourceHoldingsSnapshotId: string
  readonly sourceSettingsVersion: string
  readonly instrumentId: string
  readonly assetClass: AssetClass
  readonly estimatedMaximumAmount: number
  readonly finalSuggestedAmount: number
  readonly executable: boolean
  readonly classHeadroom: number
  readonly instrumentHeadroom: number
  readonly remainingHeadroom: number
  readonly blockedReasons: readonly BlockedReason[]
  readonly warningReasons: readonly WarningReason[]
  readonly limitingFactors: readonly LimitingFactor[]
}
