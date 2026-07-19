import { describe, expect, it, vi } from 'vitest'
import { createPortfolioLoadSingleFlight, type PortfolioLoadFeedback } from '../portfolioLoadUi'
import { executeSettingsRefreshFlow } from './T9_Settings'

describe('RA-007-B2 T9 refresh caller', () => {
  it('uses load-specific pending and blocks duplicate refresh calls', async () => {
    let resolve!: (value: { ok: false; operation: 'refreshAllData'; code: 'LOCAL_OPERATION_BUSY'; retryable: true }) => void
    const promise = new Promise<{ ok: false; operation: 'refreshAllData'; code: 'LOCAL_OPERATION_BUSY'; retryable: true }>(res => { resolve = res })
    const action = vi.fn(() => promise)
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const singleFlight = createPortfolioLoadSingleFlight()
    const first = executeSettingsRefreshFlow(action, singleFlight, value => pending.push(value), value => feedback.push(value))
    const duplicate = executeSettingsRefreshFlow(action, singleFlight, value => pending.push(value), value => feedback.push(value))
    expect(action).toHaveBeenCalledTimes(1)
    expect(pending).toEqual([true])
    expect(feedback).toEqual([null])
    resolve({ ok: false, operation: 'refreshAllData', code: 'LOCAL_OPERATION_BUSY', retryable: true })
    await Promise.all([first, duplicate])
    expect(pending).toEqual([true, false])
    expect(feedback[feedback.length - 1]?.message).toContain('完了後に再試行')
  })

  it('clears failure on SUCCESS, sanitizes rejection, and releases for retry', async () => {
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const singleFlight = createPortfolioLoadSingleFlight()
    await executeSettingsRefreshFlow(
      async () => { throw new Error('raw settings sentinel stack') },
      singleFlight,
      () => undefined,
      value => feedback.push(value),
    )
    expect(JSON.stringify(feedback)).not.toContain('raw settings sentinel')
    await executeSettingsRefreshFlow(
      async () => ({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' }),
      singleFlight,
      () => undefined,
      value => feedback.push(value),
    )
    expect(feedback[feedback.length - 1]).toBeNull()
  })
})
