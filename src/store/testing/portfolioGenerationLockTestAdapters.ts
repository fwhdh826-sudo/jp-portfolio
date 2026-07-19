import type { PortfolioGenerationLockAdapter } from '../portfolioGenerationLock'
import type { PortfolioGenerationOperation } from '../portfolioOperationResult'

/**
 * Test-only adapter for existing single-store regression suites. Cross-tab tests must use the
 * shared FakeLockManager instead so queueing, ownership, timeout, and release stay observable.
 */
export function createImmediatePortfolioGenerationLockAdapterForTest(): PortfolioGenerationLockAdapter {
  return {
    async runExclusive<T>(
      _operation: PortfolioGenerationOperation,
      callback: () => T | Promise<T>,
    ) {
      return { ok: true, value: await callback() }
    },
  }
}
