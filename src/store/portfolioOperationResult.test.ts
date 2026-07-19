import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createPortfolioCoordinationFailure,
  isPortfolioCoordinationRetryable,
  PORTFOLIO_COORDINATION_RETRYABILITY,
  type PortfolioCoordinationErrorCode,
  type PortfolioGenerationOperation,
} from './portfolioOperationResult'

const OPERATIONS = [
  'initialize',
  'refreshAllData',
  'importCsv',
  'importPortfolioSnapshot',
  'updateHolding',
  'updateTrust',
  'setPortfolioPolicy',
  'setCashAssumptions',
  'clearCashAssumptionsOverride',
  'importCashAssumptions',
] as const satisfies readonly PortfolioGenerationOperation[]

const ERROR_CODES = [
  'LOCAL_OPERATION_BUSY',
  'WEB_LOCK_UNAVAILABLE',
  'WEB_LOCK_TIMEOUT',
  'WEB_LOCK_ABORTED',
  'WEB_LOCK_REQUEST_FAILED',
  'CROSS_TAB_STATE_STALE',
  'PORTFOLIO_GENERATION_CONFLICT',
] as const satisfies readonly PortfolioCoordinationErrorCode[]

describe('portfolio operation coordination taxonomy', () => {
  it('defines exactly the ten portfolio generation operations', () => {
    expectTypeOf<PortfolioGenerationOperation>()
      .toEqualTypeOf<(typeof OPERATIONS)[number]>()
    expect(OPERATIONS).toHaveLength(10)
  })

  it('defines exactly the seven coordination error codes without WEB_LOCK_BUSY', () => {
    expectTypeOf<PortfolioCoordinationErrorCode>()
      .toEqualTypeOf<(typeof ERROR_CODES)[number]>()
    expectTypeOf<Extract<PortfolioCoordinationErrorCode, 'WEB_LOCK_BUSY'>>()
      .toEqualTypeOf<never>()
    expect(ERROR_CODES).not.toContain('WEB_LOCK_BUSY')
  })

  it('uses the fixed retryability mapping as the single runtime source', () => {
    expect(PORTFOLIO_COORDINATION_RETRYABILITY).toEqual({
      LOCAL_OPERATION_BUSY: true,
      WEB_LOCK_UNAVAILABLE: false,
      WEB_LOCK_TIMEOUT: true,
      WEB_LOCK_ABORTED: true,
      WEB_LOCK_REQUEST_FAILED: true,
      CROSS_TAB_STATE_STALE: false,
      PORTFOLIO_GENERATION_CONFLICT: false,
    })
    for (const code of ERROR_CODES) {
      expect(isPortfolioCoordinationRetryable(code))
        .toBe(PORTFOLIO_COORDINATION_RETRYABILITY[code])
    }
  })

  it.each(OPERATIONS)('constructs a sanitized failure for %s', operation => {
    const failure = createPortfolioCoordinationFailure(operation, 'WEB_LOCK_TIMEOUT')
    expect(failure).toEqual({
      ok: false,
      operation,
      code: 'WEB_LOCK_TIMEOUT',
      retryable: true,
    })
    expect(Object.keys(failure).sort()).toEqual([
      'code',
      'ok',
      'operation',
      'retryable',
    ])
    expect(failure).not.toHaveProperty('error')
    expect(failure).not.toHaveProperty('message')
    expect(failure).not.toHaveProperty('stack')
    expect(failure).not.toHaveProperty('cause')
  })
})
