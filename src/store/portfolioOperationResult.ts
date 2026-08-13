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
  | 'reconfirmCashAssumptions'
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

export type ManualPortfolioMutationOperation = Extract<
  PortfolioGenerationOperation,
  | 'updateHolding'
  | 'updateTrust'
  | 'setPortfolioPolicy'
  | 'setCashAssumptions'
  | 'clearCashAssumptionsOverride'
  | 'reconfirmCashAssumptions'
  | 'importCashAssumptions'
>

export type PortfolioLoadOperation = Extract<
  PortfolioGenerationOperation,
  'initialize' | 'refreshAllData'
>

export type PortfolioLoadSuccessCode = 'SUCCESS'

export type PortfolioLoadFailureCode =
  | 'LOAD_RESTORE_ERROR'
  | 'LOAD_DATA_ERROR'
  | 'LOAD_ANALYSIS_ERROR'
  | 'LOAD_PERSISTENCE_ERROR'
  | 'LOAD_PUBLISH_ERROR'

export type PortfolioLoadResult =
  | {
      ok: true
      operation: PortfolioLoadOperation
      code: PortfolioLoadSuccessCode
    }
  | (PortfolioCoordinationFailure & {
      operation: PortfolioLoadOperation
    })
  | {
      ok: false
      operation: PortfolioLoadOperation
      code: PortfolioLoadFailureCode
      retryable: boolean
    }

export const PORTFOLIO_LOAD_RETRYABILITY = {
  LOAD_RESTORE_ERROR: false,
  LOAD_DATA_ERROR: true,
  LOAD_ANALYSIS_ERROR: true,
  LOAD_PERSISTENCE_ERROR: true,
  LOAD_PUBLISH_ERROR: false,
} as const satisfies Record<PortfolioLoadFailureCode, boolean>

export function createPortfolioLoadSuccess(
  operation: PortfolioLoadOperation,
): Extract<PortfolioLoadResult, { ok: true }> {
  return { ok: true, operation, code: 'SUCCESS' }
}

export function createPortfolioLoadFailure(
  operation: PortfolioLoadOperation,
  code: PortfolioLoadFailureCode,
): Extract<PortfolioLoadResult, { ok: false; code: PortfolioLoadFailureCode }> {
  return { ok: false, operation, code, retryable: PORTFOLIO_LOAD_RETRYABILITY[code] }
}

export type ManualMutationSuccessCode = 'SUCCESS' | 'NO_CHANGE'

export type ManualMutationFailureCode =
  | 'MANUAL_ANALYSIS_ERROR'
  | 'MANUAL_PERSISTENCE_ERROR'
  | 'MANUAL_PUBLISH_ERROR'

export type ManualMutationResult =
  | {
      ok: true
      operation: ManualPortfolioMutationOperation
      code: ManualMutationSuccessCode
    }
  | (PortfolioCoordinationFailure & {
      operation: ManualPortfolioMutationOperation
    })
  | {
      ok: false
      operation: ManualPortfolioMutationOperation
      code: ManualMutationFailureCode
      retryable: true
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

export function createPortfolioCoordinationFailure<TOperation extends PortfolioGenerationOperation>(
  operation: TOperation,
  code: PortfolioCoordinationErrorCode,
): PortfolioCoordinationFailure & { operation: TOperation } {
  return {
    ok: false,
    operation,
    code,
    retryable: isPortfolioCoordinationRetryable(code),
  }
}

export function createManualMutationSuccess(
  operation: ManualPortfolioMutationOperation,
  code: ManualMutationSuccessCode,
): Extract<ManualMutationResult, { ok: true }> {
  return { ok: true, operation, code }
}

export function createManualMutationFailure(
  operation: ManualPortfolioMutationOperation,
  code: ManualMutationFailureCode,
): Extract<ManualMutationResult, { ok: false; code: ManualMutationFailureCode }> {
  return { ok: false, operation, code, retryable: true }
}
