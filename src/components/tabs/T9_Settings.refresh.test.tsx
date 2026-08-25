import { describe, expect, it, vi } from 'vitest'
import { createPortfolioLoadSingleFlight, REFRESH_BUTTON_LABELS, type PortfolioLoadFeedback } from '../portfolioLoadUi'
import { executeSettingsRefreshFlow } from './T9_Settings'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t9Source from './T9_Settings.tsx?raw'

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

describe('UI-9H H-P1-2/H-P1-3: T9 refreshButton は REFRESH_BUTTON_LABELS をベースに local override する', () => {
  it('portfolioLoadButtonState の呼出しが ...REFRESH_BUTTON_LABELS をspreadしている（idleのみlocal override）', () => {
    expect(t9Source).toContain('...REFRESH_BUTTON_LABELS,')
    expect(t9Source).toContain("idle: '今すぐ更新',")
  })
  it('⏳付き旧表記・ASCII三点リーダが再現しないことをsource上で保証する', () => {
    expect(t9Source).not.toMatch(/⏳\s*読込中/)
    expect(t9Source).not.toMatch(/⏳\s*更新中/)
    expect(t9Source).not.toMatch(/読込中\.\.\./)
    expect(t9Source).not.toMatch(/更新中\.\.\./)
    expect(t9Source).not.toMatch(/実行中\.\.\./)
  })
  it('CSV取込中バナーがcanonical表記（取込中…）である', () => {
    expect(t9Source).toContain("'取込中…'")
  })
  it('別の処理を実行中… はU+2026で統一されている（local override）', () => {
    expect(t9Source).toContain('別の処理を実行中…')
  })
  it('REFRESH_BUTTON_LABELS 自体の回帰guard', () => {
    expect(REFRESH_BUTTON_LABELS.globallyLoading).toBe('読込中…')
    expect(REFRESH_BUTTON_LABELS.locallyPending).toBe('更新中…')
  })
})
