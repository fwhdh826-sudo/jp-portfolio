import type { AllocationPlanSnapshotState } from './index'
import type {
  AssetClass,
  BlockedReason,
  InstrumentKind,
  LimitingFactor,
  WarningReason,
} from './allocationPlan'
import type {
  ClassFullCause,
  SnapshotExecutability,
} from '../store/allocationPlanSelectors'

/** 世代識別。T2 / T7 が同一世代を読んでいることの唯一の証拠。 */
export interface AllocationConsumerGeneration {
  readonly snapshotId: string
  readonly generatedAt: string
  readonly sourceHoldingsSnapshotId: string
  readonly sourceSettingsVersion: string
  /** 候補ファネル世代。診断・equality 表明用。projection の gate ではない。 */
  readonly sourceCandidateGenerationId: string | null
}

export interface AllocationClassProjection {
  readonly assetClass: AssetClass
  readonly currentAmount: number
  readonly targetAmount: number
  readonly targetRatio: number
  readonly targetGap: number
  readonly overweightAmount: number
  readonly maximumAmount: number | null
  readonly hardHeadroom: number
  readonly softHeadroom: number
  readonly effectiveHeadroom: number
  readonly availableBudget: number
  readonly allocatedAmount: number
  readonly remainingHeadroom: number
  readonly instrumentPlanCount: number
  readonly classFullCause: ClassFullCause | null
  readonly blockedReasons: readonly BlockedReason[]
  readonly warningReasons: readonly WarningReason[]
  readonly limitingFactors: readonly LimitingFactor[]
}

export interface AllocationInstrumentProjection {
  readonly instrumentId: string
  readonly assetClass: AssetClass
  readonly kind: InstrumentKind
  readonly relationship: 'new_to_portfolio' | 'already_held' | 'unknown'
  readonly buyKind: 'BUY_NEW' | 'BUY_MORE'
  readonly role: string | null
  readonly currentAmount: number
  readonly instrumentTargetGap: number | null
  readonly classHeadroom: number
  readonly effectiveInstrumentHeadroom: number
  readonly estimatedMaximumAmount: number
  readonly independentMaximum: number
  readonly simultaneouslyExecutableAmount: number
  readonly allocatedAmount: number
  readonly finalSuggestedAmount: number
  readonly executable: boolean
  readonly calculationSnapshotId: string
  readonly blockedReasons: readonly BlockedReason[]
  readonly warningReasons: readonly WarningReason[]
  readonly limitingFactors: readonly LimitingFactor[]
}

export type AllocationConsumerSnapshot =
  | {
      readonly availability: 'available'
      readonly status: AllocationPlanSnapshotState
      readonly generation: AllocationConsumerGeneration
      readonly snapshotExecutability: SnapshotExecutability
      readonly totalAssets: number
      readonly grossCash: number
      readonly deployableCash: number
      readonly shortTermBudget: number
      readonly longTermBudget: number
      readonly remainingUnallocatedCash: number
      readonly marketMode: 'normal' | 'caution' | 'emergency'
      readonly regime: 'bull' | 'neutral' | 'bear'
      readonly classes: readonly AllocationClassProjection[]
      readonly instruments: readonly AllocationInstrumentProjection[]
      readonly blockedReasons: readonly BlockedReason[]
      readonly warnings: readonly WarningReason[]
    }
  | {
      readonly availability: 'unavailable'
      readonly status: AllocationPlanSnapshotState
      readonly reasonKind: 'NOT_CALCULATED' | 'INVALIDATED' | 'UNKNOWN_REASON_CODE'
    }
