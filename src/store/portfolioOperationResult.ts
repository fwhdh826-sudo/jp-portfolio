export type PortfolioGenerationOperation =
  | 'initialize'
  | 'refreshAllData'
  | 'importCsv'
  | 'importPortfolioSnapshot'
  | 'updateHolding'
  | 'updateTrust'
  | 'setPortfolioPolicy'
  | 'setCashAssumptions'
  | 'clearCashAssumptionsOverride'
  | 'importCashAssumptions'

export type PortfolioCoordinationErrorCode =
  | 'LOCAL_OPERATION_BUSY'
  | 'WEB_LOCK_UNAVAILABLE'
  | 'WEB_LOCK_TIMEOUT'
  | 'WEB_LOCK_ABORTED'
  | 'WEB_LOCK_REQUEST_FAILED'
  | 'CROSS_TAB_STATE_STALE'
  | 'PORTFOLIO_GENERATION_CONFLICT'

export interface PortfolioCoordinationFailure {
  ok: false
  operation: PortfolioGenerationOperation
  code: PortfolioCoordinationErrorCode
  retryable: boolean
}

export const PORTFOLIO_COORDINATION_RETRYABILITY = {
  LOCAL_OPERATION_BUSY: true,
  WEB_LOCK_UNAVAILABLE: false,
  WEB_LOCK_TIMEOUT: true,
  WEB_LOCK_ABORTED: true,
  WEB_LOCK_REQUEST_FAILED: true,
  CROSS_TAB_STATE_STALE: false,
  PORTFOLIO_GENERATION_CONFLICT: false,
} as const satisfies Record<PortfolioCoordinationErrorCode, boolean>

export function isPortfolioCoordinationRetryable(
  code: PortfolioCoordinationErrorCode,
): boolean {
  return PORTFOLIO_COORDINATION_RETRYABILITY[code]
}

export function createPortfolioCoordinationFailure(
  operation: PortfolioGenerationOperation,
  code: PortfolioCoordinationErrorCode,
): PortfolioCoordinationFailure {
  return {
    ok: false,
    operation,
    code,
    retryable: isPortfolioCoordinationRetryable(code),
  }
}
