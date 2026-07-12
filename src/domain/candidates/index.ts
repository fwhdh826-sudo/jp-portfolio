export type { CandidateAssetType, CandidateDecisionAction, CandidateConstraintState, CandidateItem } from './candidateTypes'
export type { RawCandidate } from './buildCandidateUniverse'
export type { ConstraintContext, ConstraintResult } from './applyCandidateConstraints'
export { buildCandidateUniverse } from './buildCandidateUniverse'
export { applyCandidateConstraints } from './applyCandidateConstraints'
export { scoreCandidates } from './scoreCandidates'

// P5-B002b-1: 新規個別株候補（candidates_stocks.json由来。officialDecision未接続）
export type {
  StockCandidateAction,
  StockCandidateConstraintState,
  StockCandidateItem,
  StockCandidateScoreResult,
  StockCandidateGateContext,
  StockCandidateGateResult,
  StockCandidatePlanContext,
} from './stockCandidates'
export {
  buildStockCandidatePlan,
  computeStockCandidateScore,
  applyStockCandidateGates,
  resolveStockCandidateAction,
  computeJpStockHeadroom,
  excludeHeldStockCandidates,
  isCandidatesStocksUsable,
  STOCK_VOL_HARD_LIMIT,
  STOCK_VOL_SOFT_LIMIT,
  MIN_USABLE_AXES,
} from './stockCandidates'
