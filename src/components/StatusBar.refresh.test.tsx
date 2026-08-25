import { describe, expect, it, vi } from 'vitest'
import { createPortfolioLoadSingleFlight, REFRESH_BUTTON_LABELS, type PortfolioLoadFeedback } from './portfolioLoadUi'
import { executeStatusBarRefreshClickFlow, executeStatusBarRefreshFlow } from './StatusBar'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import statusBarSource from './StatusBar.tsx?raw'

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

  it('RA-008-D2: cross-tab stale gating leaves executeStatusBarRefreshFlow itself untouched', async () => {
    // executeStatusBarRefreshFlow's own single-flight contract (tested above) is unaffected by
    // RA-008-D2 — the stale gate lives entirely in the new executeStatusBarRefreshClickFlow wrapper.
    const action = vi.fn(async () => ({ ok: true as const, operation: 'refreshAllData' as const, code: 'SUCCESS' as const }))
    const singleFlight = createPortfolioLoadSingleFlight()
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []

    await executeStatusBarRefreshClickFlow(true, action, singleFlight, v => pending.push(v), v => feedback.push(v))
    expect(action).not.toHaveBeenCalled()

    await executeStatusBarRefreshClickFlow(false, action, singleFlight, v => pending.push(v), v => feedback.push(v))
    expect(action).toHaveBeenCalledTimes(1)
  })
})

describe('UI-9H H-P1-2: StatusBar refreshButton は REFRESH_BUTTON_LABELS を参照する', () => {
  it('portfolioLoadButtonState の呼出しが共有定数 REFRESH_BUTTON_LABELS をそのまま渡している（手書きlabelオブジェクトを持たない）', () => {
    expect(statusBarSource).toContain('portfolioLoadButtonState(isLoading, refreshPending, REFRESH_BUTTON_LABELS)')
  })
  it('旧mutation（手書きlabelオブジェクトへ戻す）が再現しないことをsource上で保証する', () => {
    expect(statusBarSource).not.toMatch(/globallyLoading:\s*['"`]読込中\.\.\.['"`]/)
    expect(statusBarSource).not.toContain("globallyLoading: '読込中…',\n    locallyPending: '更新中…',")
  })
  it('REFRESH_BUTTON_LABELS は正典表記を保持する（参照先の定数自体の回帰guard）', () => {
    expect(REFRESH_BUTTON_LABELS.globallyLoading).toBe('読込中…')
    expect(REFRESH_BUTTON_LABELS.locallyPending).toBe('更新中…')
  })
})
