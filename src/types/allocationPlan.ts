export const ALLOCATION_PLAN_SCHEMA_VERSION = 'allocation-plan-1' as const
export const ALLOCATION_PLAN_AUTHORITY_VERSION = 'hr-allocation-plan-v1' as const

export type AssetClass = 'JP_STOCK' | 'JP_TRUST' | 'OVERSEAS_TRUST' | 'GOLD' | 'CASH' | 'CASH_RESERVE'
export type InstrumentKind = 'jp_stock' | 'jp_trust' | 'global_trust' | 'gold'
export type BuyKind = 'BUY_NEW' | 'BUY_MORE'
export type MarketMode = 'normal' | 'caution' | 'emergency'
export type Regime = 'bull' | 'neutral' | 'bear'
export type AllocationMode = 'RANK_SEQUENTIAL_SINGLE_EXECUTION'

export type LimitingFactor =
  | 'DEPLOYABLE_CASH' | 'CLASS_HEADROOM' | 'INSTRUMENT_HEADROOM'
  | 'TARGET_GAP' | 'MAX_POSITION' | 'SECTOR' | 'CONCENTRATION'
  | 'LIQUIDITY' | 'LOT_SIZE' | 'AVAILABLE_BUDGET'
  | 'SIMULTANEOUS_BUDGET' | 'MINIMUM_UNIT'
  | 'JP_STOCK_RATIO_CAP' | 'JP_STOCK_AMOUNT_CAP' | 'JP_TRUST_REMAINING_TARGET'

export type BlockedReason =
  | 'INVALID_NUMERIC_INPUT' | 'CASH_AUTHORITY_UNAVAILABLE' | 'CASH_AUTHORITY_STALE'
  | 'CASH_NEGATIVE' | 'POLICY_AUTHORITY_UNAVAILABLE' | 'CLASS_TARGET_MISSING'
  | 'CLASS_CAP_MISSING' | 'CLASS_FULL' | 'JP_STOCK_CAP'
  | 'JP_TRUST_TARGET_REACHED' | 'INSUFFICIENT_CASH' | 'BELOW_MINIMUM_UNIT'
  | 'INSTRUMENT_AUTHORITY_UNAVAILABLE' | 'JP_STOCK_EXECUTION_DATA_UNAVAILABLE'
  | 'SAFE_MODE_ACTIVE' | 'SAFE_MODE_UNAVAILABLE' | 'DQ_SUPPRESSED'
  | 'NO_TRADE_EMERGENCY' | 'MARKET_DATA_STALE' | 'HOLDINGS_STALE'
  | 'CASH_DATA_STALE' | 'CANDIDATE_INPUT_INVALID' | 'CROSS_TAB_STALE'
  | 'TIER_A_HARD_VIOLATION' | 'TARGET_AUTHORITY_UNAVAILABLE'

export type WarningReason =
  | 'PENDING_ORDER_AUTHORITY_UNAVAILABLE' | 'FEE_AUTHORITY_UNAVAILABLE'
  | 'SECTOR_AUTHORITY_PARTIAL' | 'CONCENTRATION_UNAVAILABLE'
  | 'LIQUIDITY_UNAVAILABLE' | 'INSTRUMENT_TARGET_UNAVAILABLE'
  | 'CONFIDENCE_UNKNOWN' | 'MARKET_CAUTION' | 'TIER_A_SOFT_ALERT'
  | 'CANDIDATE_INPUT_STALE' | 'HOLDINGS_DATA_STALE' | 'CASH_DATA_STALE'
  | 'PORTFOLIO_SOURCE_PARTIAL' | 'ESTIMATE_ONLY' | 'NOT_SELECTED_FOR_EXECUTION'

export type AllocationBehavior =
  | 'BLOCK_AND_ZERO' | 'HOLD_EXISTING_ONLY' | 'DISPLAY_MAX_WITH_WARNING'
  | 'DISPLAY_ESTIMATE_ONLY' | 'NORMAL'

export interface SafetyState {
  safeMode: 'inactive' | 'active' | 'stale' | 'unavailable'
  marketData: 'fresh' | 'stale'
  holdings: 'fresh' | 'stale' | 'partial'
  cash: 'known_fresh' | 'unknown' | 'stale'
  target: 'known' | 'unknown'
  pendingOrders: 'known' | 'unknown'
  candidateArtifact: 'fresh' | 'stale' | 'invalid'
  dqViolation: boolean
  tierA: 'normal' | 'soft' | 'hard'
  crossTab: 'current' | 'stale'
  noTrade: 'normal' | 'caution' | 'emergency'
}

export interface CashInput {
  grossCash: number | null
  safetyReserve: number
  pendingOrderCash: number | null
  dataUncertaintyReserve: number
}

export interface BudgetInput { shortTermBudget: number; longTermBudget: number }

export interface CashModel {
  grossCash: number
  safetyReserve: number
  pendingOrderCash: number
  dataUncertaintyReserve: number
  shortTermBudget: number
  longTermBudget: number
  deployableCash: number
  blockedReasons: BlockedReason[]
  warnings: WarningReason[]
}

export interface AssetClassPolicy {
  assetClass: AssetClass
  targetRatio: number
  maximumRatio: number | null
  maximumAmountJpy: number | null
}

export interface InstrumentPolicy {
  instrumentId: string
  targetAmountJpy: number | null
  maxPositionAmountJpy: number | null
  sectorHeadroomJpy: number | null
  concentrationHeadroomJpy: number | null
  liquidityHeadroomJpy: number | null
  defaultMaxPositionShare: number
  defaultMaxSectorShare: number
  minimumPurchaseUnitJpy: number | null
}

export interface RoundingPolicy { kind: InstrumentKind; purchaseUnitJpy: number }

export interface AllocationPolicy {
  jpStockMaxRatio: number | null
  jpStockMaxAmountJpy: number | null
  jpStockCapRegimeMode: 'policy_only' | 'min_with_regime'
  assetClassPolicies: readonly AssetClassPolicy[]
  instrumentPolicies: readonly InstrumentPolicy[]
  roundingPolicies: readonly RoundingPolicy[]
  allocationMode: AllocationMode
  buyNewBaseShare: number
  buyMoreBaseShare: number
  confidenceUnknownFactor: number
  executionPriceBufferRatio: number
}

export interface AssetClassInput { assetClass: AssetClass; currentAmount: number }

export interface AssetClassPlan {
  assetClass: AssetClass
  currentAmount: number
  targetAmount: number
  targetRatio: number
  minimumAmount: number | null
  maximumAmount: number | null
  targetGap: number
  hardHeadroom: number
  softHeadroom: number
  effectiveHeadroom: number
  overweightAmount: number
  availableBudget: number
  allocatedAmount: number
  remainingHeadroom: number
  limitingFactors: LimitingFactor[]
  blockedReasons: BlockedReason[]
  warningReasons: WarningReason[]
}

export interface DomesticStockHeadroom {
  ratioCapAmount: number | null
  amountCap: number | null
  effectiveDomesticStockCap: number
  currentDomesticStockAmount: number
  domesticStockHardHeadroom: number
  limitingFactors: LimitingFactor[]
  blockedReasons: BlockedReason[]
}

export interface InstrumentInput {
  instrumentId: string
  assetClass: AssetClass
  kind: InstrumentKind
  relationship: 'new_to_portfolio' | 'already_held' | 'unknown'
  currentAmount: number
  role: string | null
  reason: string
  priceJpy: number | null
  lotSizeShares: number | null
}

export interface InstrumentHeadroomInput extends InstrumentInput {
  classHeadroom: number | null
  availableBudget: number | null
  policy: InstrumentPolicy | null
}

export interface CandidateInput {
  instrumentId: string
  buyKind: BuyKind
  marketRank: number | null
  artifactIndex: number
  confidence: number | null
}

export interface PurchaseAmountInput {
  calculationSnapshotId: string
  authorityVersion: typeof ALLOCATION_PLAN_AUTHORITY_VERSION
  kind: InstrumentKind
  buyKind: BuyKind
  deployableCash: number
  classHeadroom: number
  instrumentHeadroom: number
  targetGap: number | null
  confidence: number | null
  remainingSimultaneousBudget: number
  baseShare: number
  confidenceUnknownFactor: number
  roundingUnitJpy: number
  minimumPurchaseUnitJpy: number
  priceJpy: number | null
  lotSizeShares: number | null
  executionPriceBufferRatio: number
  behavior: AllocationBehavior
  behaviorBlockedReasons: readonly BlockedReason[]
  behaviorWarnings: readonly WarningReason[]
}

export interface PurchaseAmountResult {
  rawSuggestedAmount: number
  cappedSuggestedAmount: number
  roundedSuggestedAmount: number
  finalSuggestedAmount: number
  estimatedMaximumAmount: number
  roundingLoss: number
  executable: boolean
  limitingFactors: LimitingFactor[]
  blockedReasons: BlockedReason[]
  warningReasons: WarningReason[]
  calculationSnapshotId: string
  authorityVersion: typeof ALLOCATION_PLAN_AUTHORITY_VERSION
}

export interface InstrumentPlan extends InstrumentInput, PurchaseAmountResult {
  buyKind: BuyKind
  targetAmount: number | null
  classHeadroom: number
  instrumentTargetGap: number | null
  instrumentMaxPositionHeadroom: number | null
  sectorHeadroom: number | null
  concentrationHeadroom: number | null
  liquidityHeadroom: number | null
  lotSizeHeadroom: number | null
  effectiveInstrumentHeadroom: number
  independentMaximum: number
  simultaneouslyExecutableAmount: number
  allocatedAmount: number
  limitingFactors: LimitingFactor[]
  blockedReasons: BlockedReason[]
  warningReasons: WarningReason[]
}

export interface JpTrustPlanSummary {
  jpTrustTargetAmount: number
  jpTrustCurrentAmount: number
  jpTrustRemainingTarget: number
  jpTrustClassHeadroom: number
  jpTrustProposedAmount: number
  availableShortTermBudget: number
}

export interface AllocationPlanInput {
  generatedAt: string
  snapshotId: string
  authorityVersion: typeof ALLOCATION_PLAN_AUTHORITY_VERSION
  sourceHoldingsSnapshotId: string
  sourceSettingsVersion: string
  cash: CashInput
  budgets: BudgetInput
  policy: AllocationPolicy
  assetClasses: readonly AssetClassInput[]
  instruments: readonly InstrumentInput[]
  candidates: readonly CandidateInput[]
  safetyState: SafetyState
  regime: Regime
  marketMode: MarketMode
}

export interface AllocationPlanSnapshot {
  authorityVersion: typeof ALLOCATION_PLAN_AUTHORITY_VERSION
  schemaVersion: typeof ALLOCATION_PLAN_SCHEMA_VERSION
  snapshotId: string
  generatedAt: string
  sourceHoldingsSnapshotId: string
  sourceSettingsVersion: string
  totalAssets: number
  grossCash: number
  deployableCash: number
  shortTermBudget: number
  longTermBudget: number
  marketMode: MarketMode
  regime: Regime
  assetClassPlans: AssetClassPlan[]
  instrumentPlans: InstrumentPlan[]
  remainingUnallocatedCash: number
  blockedReasons: BlockedReason[]
  warnings: WarningReason[]
  not_for_trading: true
  privacyMode: 'local_only'
  persistence: 'none'
}

export interface InvariantResult {
  ok: boolean
  violated: Array<`I-${string}`>
}
