import { describe, expect, it, vi } from 'vitest'
import { createPortfolioLoadSingleFlight, type PortfolioLoadFeedback } from './portfolioLoadUi'
import { executeStatusBarRefreshFlow } from './StatusBar'

describe('RA-007-B2 StatusBar refresh caller', () => {
  it('single-flights duplicate refresh, holds pending, and clears it after failure', async () => {
    let resolve!: (value: { ok: false; operation: 'refreshAllData'; code: 'LOAD_DATA_ERROR'; retryable: true }) => void
    const promise = new Promise<{ ok: false; operation: 'refreshAllData'; code: 'LOAD_DATA_ERROR'; retryable: true }>(res => { resolve = res })
    const action = vi.fn(() => promise)
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const singleFlight = createPortfolioLoadSingleFlight()
    const first = executeStatusBarRefreshFlow(action, singleFlight, value => pending.push(value), value => feedback.push(value))
    let firstSettled = false
    void first.then(() => { firstSettled = true })
    const duplicate = executeStatusBarRefreshFlow(action, singleFlight, value => pending.push(value), value => feedback.push(value))
    await Promise.resolve()
    expect(action).toHaveBeenCalledTimes(1)
    expect(firstSettled).toBe(false)
    expect(pending).toEqual([true])
    expect(feedback).toEqual([null])
    resolve({ ok: false, operation: 'refreshAllData', code: 'LOAD_DATA_ERROR', retryable: true })
    await Promise.all([first, duplicate])
    expect(pending).toEqual([true, false])
    expect(feedback[feedback.length - 1]?.message).toContain('最新データ')
  })

  it('sanitizes raw rejection and permits retry', async () => {
    const singleFlight = createPortfolioLoadSingleFlight()
    const feedback: Array<PortfolioLoadFeedback | null> = []
    await executeStatusBarRefreshFlow(
      async () => { throw new Error('raw status sentinel') },
      singleFlight,
      () => undefined,
      value => feedback.push(value),
    )
    expect(JSON.stringify(feedback)).not.toContain('raw status sentinel')
    await executeStatusBarRefreshFlow(
      async () => ({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' }),
      singleFlight,
      () => undefined,
      value => feedback.push(value),
    )
    expect(feedback[feedback.length - 1]).toBeNull()
  })
})
