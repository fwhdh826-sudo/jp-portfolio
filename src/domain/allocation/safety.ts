import type {
  AllocationBehavior,
  BlockedReason,
  BuyKind,
  SafetyState,
  WarningReason,
} from '../../types/allocationPlan'
import { unique } from './numeric'

export interface SafetyDecision {
  behavior: AllocationBehavior
  blockedReasons: BlockedReason[]
  warnings: WarningReason[]
}

const PRIORITY: Record<AllocationBehavior, number> = {
  NORMAL: 0,
  DISPLAY_MAX_WITH_WARNING: 1,
  DISPLAY_ESTIMATE_ONLY: 2,
  HOLD_EXISTING_ONLY: 3,
  BLOCK_AND_ZERO: 4,
}

export function evaluateSafetyBehavior(
  state: SafetyState,
  buyKind: BuyKind,
): SafetyDecision {
  let behavior: AllocationBehavior = 'NORMAL'
  const blockedReasons: BlockedReason[] = []
  const warnings: WarningReason[] = []
  const apply = (next: AllocationBehavior): void => {
    if (PRIORITY[next] > PRIORITY[behavior]) behavior = next
  }
  const unsafe = (reason: BlockedReason): void => {
    apply(buyKind === 'BUY_NEW' ? 'BLOCK_AND_ZERO' : 'HOLD_EXISTING_ONLY')
    blockedReasons.push(reason)
  }

  if (state.safeMode === 'active') unsafe('SAFE_MODE_ACTIVE')
  if (state.safeMode === 'stale' || state.safeMode === 'unavailable') {
    unsafe('SAFE_MODE_UNAVAILABLE')
  }
  if (state.marketData === 'stale') unsafe('MARKET_DATA_STALE')
  if (state.dqViolation) unsafe('DQ_SUPPRESSED')
  if (state.tierA === 'hard') unsafe('TIER_A_HARD_VIOLATION')
  if (state.crossTab === 'stale') {
    apply('BLOCK_AND_ZERO')
    blockedReasons.push('CROSS_TAB_STALE')
  }
  if (state.noTrade === 'emergency') {
    apply('BLOCK_AND_ZERO')
    blockedReasons.push('NO_TRADE_EMERGENCY')
  }

  if (state.holdings === 'stale') {
    if (buyKind === 'BUY_NEW') {
      apply('BLOCK_AND_ZERO')
      blockedReasons.push('HOLDINGS_STALE')
    } else {
      apply('DISPLAY_MAX_WITH_WARNING')
      warnings.push('HOLDINGS_DATA_STALE')
    }
  } else if (state.holdings === 'partial') {
    apply('DISPLAY_ESTIMATE_ONLY')
    warnings.push('PORTFOLIO_SOURCE_PARTIAL')
  }

  if (state.cash === 'unknown') {
    apply('BLOCK_AND_ZERO')
    blockedReasons.push('CASH_AUTHORITY_UNAVAILABLE')
  } else if (state.cash === 'stale') {
    if (buyKind === 'BUY_NEW') {
      apply('BLOCK_AND_ZERO')
      blockedReasons.push('CASH_DATA_STALE')
    } else {
      apply('DISPLAY_MAX_WITH_WARNING')
      warnings.push('CASH_DATA_STALE')
    }
  }
  if (state.target === 'unknown') {
    apply('BLOCK_AND_ZERO')
    blockedReasons.push('TARGET_AUTHORITY_UNAVAILABLE')
  }
  if (state.candidateArtifact === 'invalid' && buyKind === 'BUY_NEW') {
    apply('BLOCK_AND_ZERO')
    blockedReasons.push('CANDIDATE_INPUT_INVALID')
  } else if (state.candidateArtifact === 'stale' && buyKind === 'BUY_NEW') {
    apply('DISPLAY_ESTIMATE_ONLY')
    warnings.push('CANDIDATE_INPUT_STALE')
  }
  if (state.tierA === 'soft') {
    apply('DISPLAY_MAX_WITH_WARNING')
    warnings.push('TIER_A_SOFT_ALERT')
  }
  if (state.noTrade === 'caution') {
    apply('DISPLAY_MAX_WITH_WARNING')
    warnings.push('MARKET_CAUTION')
  }

  return {
    behavior,
    blockedReasons: unique(blockedReasons),
    warnings: unique(warnings),
  }
}
