import type {
  AssetClass,
  BlockedReason,
  LimitingFactor,
  WarningReason,
} from './allocationPlan'
import type {
  CandidateHoldingRelationship,
  CandidatePortfolioFitReason,
  CandidatePortfolioFitRisk,
} from './candidatePortfolioFit'
import type { AllocationPlanSnapshotState } from './index'

export const CANDIDATE_DECISION_SYNTHESIS_SCHEMA_VERSION = 'candidate-decision-synthesis-1' as const
export const CANDIDATE_DECISION_SYNTHESIS_AUTHORITY_VERSION = 'cand-syn-v1' as const

export const CANDIDATE_DECISION_SYNTHESIS_DECISION_LIMIT = 3 as const
export const CANDIDATE_DECISION_SYNTHESIS_WATCH_LIMIT = 10 as const

export type SynthesisAction = 'ADD' | 'BUY_NEW' | 'WATCH' | 'BLOCKED'
export type CandidateSynthesisAssetClass = Extract<AssetClass, 'JP_STOCK' | 'JP_TRUST'>
export type CandidateSynthesisRelationship = 'already_held' | 'new_to_portfolio'
export type CandidateSynthesisNamespace = 'jp_stock_funnel' | 'jp_trust_registry'
export type CandidateSynthesisFreshness = 'fresh' | 'stale' | 'degraded' | 'invalid' | 'unavailable'

export const SYNTHESIS_REASON_CODES = [
  'PORTFOLIO_FIT_NOT_APPLICABLE',
  'SELL_CONFLICT_SAME_INSTRUMENT',
  'SAFE_MODE_ACTIVE',
  'SAFE_MODE_UNAVAILABLE',
  'DQ_SUPPRESSED',
  'NO_TRADE_EMERGENCY',
  'CANDIDATE_INPUT_STALE',
  'CANDIDATE_INPUT_INVALID',
  'CASH_AUTHORITY_UNAVAILABLE',
  'CASH_DATA_STALE',
  'HOLDINGS_STALE',
  'HOLDINGS_DATA_STALE',
  'PORTFOLIO_SOURCE_PARTIAL',
  'ESTIMATE_ONLY',
  'EXECUTION_PRICE_UNAVAILABLE',
  'EXECUTION_PRICE_AMBIGUOUS',
] as const
export type SynthesisReasonCode = (typeof SYNTHESIS_REASON_CODES)[number]

export const SYNTHESIS_DATASET_REASONS = [
  'SYNTHESIS_INPUT_INVALID',
  'MISSING_REQUIRED_PROVENANCE',
  'ALLOCATION_CANDIDATE_GENERATION_MISMATCH',
  'ALLOCATION_SNAPSHOT_UNAVAILABLE',
  'ALLOCATION_SNAPSHOT_ID_MISMATCH',
  'MALFORMED_ALLOCATION_PROJECTION',
  'DUPLICATE_INSTRUMENT_ID',
  'DUPLICATE_ENTRY_ID',
  'UNKNOWN_NAMESPACE',
  'UNSUPPORTED_ASSET_CLASS',
  'INVALID_INSTRUMENT_IDENTITY',
  'INVALID_ACTION_RELATIONSHIP',
  'EXECUTION_PRICE_PROVENANCE_MISSING',
  'MISSING_INSTRUMENT_MAPPING',
  'EXECUTION_AUTHORITY_MISMATCH',
] as const
export type SynthesisDatasetReason = (typeof SYNTHESIS_DATASET_REASONS)[number]

export interface CandidateDecisionSynthesisProvenance {
  readonly candidateGenerationId: string
  readonly candidatePublicationState: 'published_pass'
  readonly candidateFreshness: CandidateSynthesisFreshness
  readonly allocationSnapshotId: string
  readonly allocationSnapshotGeneratedAt: string
  readonly allocationSnapshotStatus: AllocationPlanSnapshotState
  readonly sourceHoldingsSnapshotId: string
  readonly sourceSettingsVersion: string
  readonly cashAuthorityUpdatedAt: string | null
  readonly marketDataAsOf: string | null
  readonly portfolioFitEvaluatedAt: string
  readonly candidatesStocksUpdatedAt: string | null
  readonly candidatesStocksSourceUpdatedAt: string | null
  readonly candidatesStocksRunToken: string | null
}

export interface CandidateDecisionSynthesisEntry {
  readonly entryId: string
  readonly instrumentId: string
  readonly assetClass: CandidateSynthesisAssetClass
  readonly displayName: string
  readonly code: string | null
  readonly action: SynthesisAction
  readonly rank: number
  readonly relationship: CandidateSynthesisRelationship
  readonly candidateQuality: {
    readonly source: 'candidate_funnel' | 'trust_registry'
    readonly marketRank: number | null
    readonly marketScore: number | null
    readonly tier: 'actionable' | 'deep_review' | null
    readonly dataConfidence: number | null
    readonly selectedReasons: readonly string[]
    readonly riskReasons: readonly string[]
  }
  readonly portfolioFit: {
    readonly status: 'evaluated' | 'partial' | 'unavailable' | 'invalid' | 'not_evaluated'
    readonly relationship: CandidateHoldingRelationship | null
    readonly reasons: readonly CandidatePortfolioFitReason[]
    readonly risks: readonly CandidatePortfolioFitRisk[]
    readonly hardGatePassed: boolean
  }
  readonly allocationRole: {
    readonly assetClassTargetGap: number
    readonly assetClassTargetRatio: number
    readonly classHeadroom: number
    readonly instrumentHeadroom: number
  }
  readonly money:
    | {
        readonly kind: 'EXECUTABLE'
        readonly executableAmountJpy: number
        readonly calculationSnapshotId: string
      }
    | {
        readonly kind: 'NOT_EXECUTABLE'
        readonly executableAmountJpy: 0
      }
  readonly blockingReasons: readonly BlockedReason[]
  readonly warnings: readonly WarningReason[]
  readonly limitingFactors: readonly LimitingFactor[]
  readonly whyThis: readonly SynthesisReasonCode[]
  readonly whyNotExecutable: readonly SynthesisReasonCode[]
}

export interface CandidateDecisionSynthesisSnapshot {
  readonly schemaVersion: typeof CANDIDATE_DECISION_SYNTHESIS_SCHEMA_VERSION
  readonly authorityVersion: typeof CANDIDATE_DECISION_SYNTHESIS_AUTHORITY_VERSION
  readonly synthesisId: string
  readonly generatedAt: string
  readonly status: 'available' | 'unavailable' | 'invalid'
  readonly provenance: CandidateDecisionSynthesisProvenance
  readonly decisions: readonly CandidateDecisionSynthesisEntry[]
  readonly watchList: readonly CandidateDecisionSynthesisEntry[]
  readonly datasetReasons: readonly SynthesisDatasetReason[]
  readonly privacyMode: 'local_only'
  readonly persistence: 'none'
  readonly not_for_trading: true
}

/** Canonical class authority supplied by AllocationPlan; synthesis never recomputes it. */
export interface CandidateSynthesisClassNeed {
  readonly targetGap: number | null
  readonly targetAmount: number | null
  readonly blockedReasons: readonly BlockedReason[]
}

/**
 * Normalized, already-authoritative AllocationPlan projection. The field name
 * makes the monetary provenance explicit: finalSuggestedAmount is not a
 * candidate score, limit, estimate, or legacy sizing field.
 */
export interface CandidateSynthesisCanonicalAllocation {
  readonly relationship: 'already_held' | 'new_to_portfolio' | 'unknown'
  readonly executable: boolean
  readonly finalSuggestedAmount: number
  readonly calculationSnapshotId: string
  readonly classNeed: CandidateSynthesisClassNeed
  readonly allocationRole: CandidateDecisionSynthesisEntry['allocationRole']
  readonly blockedReasons: readonly BlockedReason[]
  readonly warnings: readonly WarningReason[]
  readonly limitingFactors: readonly LimitingFactor[]
}

export interface CandidateDecisionSynthesisCandidateInput {
  readonly instrumentId: string
  readonly assetClass: CandidateSynthesisAssetClass
  readonly namespace: CandidateSynthesisNamespace
  readonly displayName: string
  readonly code: string | null
  readonly artifactIndex: number
  readonly candidateQuality: CandidateDecisionSynthesisEntry['candidateQuality']
  readonly portfolioFit: CandidateDecisionSynthesisEntry['portfolioFit']
  readonly canonicalAllocation: CandidateSynthesisCanonicalAllocation
  readonly whyThis: readonly SynthesisReasonCode[]
  readonly whyNotExecutable: readonly SynthesisReasonCode[]
  readonly usesCandidatesStocksExecutionPrice: boolean
}

/**
 * The canonical AllocationPlan single-execution result, supplied verbatim.
 * I-SYN-EXEC-1 compares synthesis against it; synthesis never elects a
 * different money winner and never recomputes the amount.
 */
export interface CandidateDecisionSynthesisCanonicalExecution {
  readonly instrumentId: string | null
  readonly executableAmountJpy: number
}

export interface CandidateDecisionSynthesisInput {
  readonly generatedAt: string
  readonly provenance: CandidateDecisionSynthesisProvenance
  readonly allocationPlanCandidateGenerationId: string
  readonly canonicalExecution: CandidateDecisionSynthesisCanonicalExecution
  readonly candidates: readonly CandidateDecisionSynthesisCandidateInput[]
  readonly datasetReasons: readonly SynthesisDatasetReason[]
}

export type CandidateDecisionSynthesisInvariantId =
  | 'I-SYN-1' | 'I-SYN-2' | 'I-SYN-3' | 'I-SYN-4'
  | 'I-SYN-5' | 'I-SYN-6' | 'I-SYN-7' | 'I-SYN-8'
  | 'I-SYN-EXEC-1'

export interface CandidateDecisionSynthesisInvariantResult {
  readonly ok: boolean
  readonly violated: readonly CandidateDecisionSynthesisInvariantId[]
}

export interface CandidateDecisionSynthesisInvariantContext {
  readonly allocationPlanCandidateGenerationId: string
  readonly usesCandidatesStocksExecutionPrice: boolean
  readonly expectedSynthesisId: string
  readonly canonicalExecution: CandidateDecisionSynthesisCanonicalExecution
}
