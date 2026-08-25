import { describe, expect, it, vi } from 'vitest'
import { createPortfolioLoadSingleFlight, REFRESH_BUTTON_LABELS, type PortfolioLoadFeedback } from '../portfolioLoadUi'
import { executeNewsRefreshFlow } from './T5_News'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t5Source from './T5_News.tsx?raw'

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

describe('UI-9H H-P1-2/H-P1-3: T5 refreshButton は REFRESH_BUTTON_LABELS を参照する', () => {
  it('portfolioLoadButtonState の呼出しが共有定数 REFRESH_BUTTON_LABELS をそのまま渡している', () => {
    expect(t5Source).toContain('portfolioLoadButtonState(isLoading, refreshPending, REFRESH_BUTTON_LABELS)')
  })
  it('旧ASCII三点リーダ表記（"..."）へ戻すmutationが再現しないことをsource上で保証する', () => {
    expect(t5Source).not.toMatch(/読込中\.\.\./)
    expect(t5Source).not.toMatch(/更新中\.\.\./)
    expect(t5Source).not.toMatch(/読み込み中\.\.\./)
  })
  it('news_v13.json読込中バナーがcanonical表記（読込中…）である', () => {
    expect(t5Source).toContain('news_v13.json を読込中…')
  })
  it('REFRESH_BUTTON_LABELS 自体の回帰guard', () => {
    expect(REFRESH_BUTTON_LABELS.globallyLoading).toBe('読込中…')
  })
})
