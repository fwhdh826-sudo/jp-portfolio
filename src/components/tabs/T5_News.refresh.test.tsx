import { describe, expect, it, vi } from 'vitest'
import { createPortfolioLoadSingleFlight, type PortfolioLoadFeedback } from '../portfolioLoadUi'
import { executeNewsRefreshFlow } from './T5_News'

describe('RA-007-B2 T5 refresh caller', () => {
  it('prevents duplicate actions and has no success feedback before completion', async () => {
    let resolve!: (value: { ok: true; operation: 'refreshAllData'; code: 'SUCCESS' }) => void
    const promise = new Promise<{ ok: true; operation: 'refreshAllData'; code: 'SUCCESS' }>(res => { resolve = res })
    const action = vi.fn(() => promise)
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const singleFlight = createPortfolioLoadSingleFlight()
    const first = executeNewsRefreshFlow(action, singleFlight, value => pending.push(value), value => feedback.push(value))
    const duplicate = executeNewsRefreshFlow(action, singleFlight, value => pending.push(value), value => feedback.push(value))
    expect(action).toHaveBeenCalledTimes(1)
    expect(pending).toEqual([true])
    expect(feedback).toEqual([null])
    resolve({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    await Promise.all([first, duplicate])
    expect(pending).toEqual([true, false])
    expect(feedback).toEqual([null, null])
  })

  it('shows sanitized failure, clears pending, and permits retry', async () => {
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const singleFlight = createPortfolioLoadSingleFlight()
    await executeNewsRefreshFlow(
      async () => { throw new Error('raw news sentinel stack') },
      singleFlight,
      value => pending.push(value),
      value => feedback.push(value),
    )
    expect(pending).toEqual([true, false])
    expect(JSON.stringify(feedback)).not.toContain('raw news sentinel')
    await executeNewsRefreshFlow(
      async () => ({ ok: false, operation: 'refreshAllData', code: 'LOAD_ANALYSIS_ERROR', retryable: true }),
      singleFlight,
      value => pending.push(value),
      value => feedback.push(value),
    )
    expect(feedback[feedback.length - 1]?.message).toContain('再計算')
  })
})
