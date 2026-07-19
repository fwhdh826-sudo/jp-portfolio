import { describe, expect, it } from 'vitest'
import type { PortfolioLoadFeedback } from './components/portfolioLoadUi'
import { executeAppInitializeUiFlow } from './App'

describe('RA-007-B2 App initialization flow', () => {
  it('awaits initialize and shows no banner before or after SUCCESS', async () => {
    let resolve!: (value: { ok: true; operation: 'initialize'; code: 'SUCCESS' }) => void
    const promise = new Promise<{ ok: true; operation: 'initialize'; code: 'SUCCESS' }>(res => { resolve = res })
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const running = executeAppInitializeUiFlow(() => promise, () => true, value => feedback.push(value))
    expect(feedback).toEqual([])
    resolve({ ok: true, operation: 'initialize', code: 'SUCCESS' })
    await running
    expect(feedback).toEqual([null])
  })

  it('suppresses StrictMode LOCAL_OPERATION_BUSY but displays other fixed failures', async () => {
    const feedback: Array<PortfolioLoadFeedback | null> = []
    await executeAppInitializeUiFlow(
      async () => ({ ok: false, operation: 'initialize', code: 'LOCAL_OPERATION_BUSY', retryable: true }),
      () => true,
      value => feedback.push(value),
    )
    await executeAppInitializeUiFlow(
      async () => ({ ok: false, operation: 'initialize', code: 'LOAD_RESTORE_ERROR', retryable: false }),
      () => true,
      value => feedback.push(value),
    )
    expect(feedback[0]).toBeNull()
    expect(feedback[1]?.message).toContain('復元')
  })

  it('does not update local state after cleanup and sanitizes raw rejection while active', async () => {
    let active = true
    let reject!: (reason?: unknown) => void
    const promise = new Promise<never>((_resolve, rej) => { reject = rej })
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const running = executeAppInitializeUiFlow(() => promise, () => active, value => feedback.push(value))
    active = false
    reject(new Error('raw initialize sentinel stack'))
    await running
    expect(feedback).toEqual([])

    active = true
    await executeAppInitializeUiFlow(
      async () => { throw new Error('raw initialize sentinel stack') },
      () => active,
      value => feedback.push(value),
    )
    expect(feedback[0]?.message).not.toContain('raw initialize sentinel')
  })
})
