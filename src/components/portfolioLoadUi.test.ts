import { describe, expect, it, vi } from 'vitest'
import type { PortfolioLoadResult } from '../store/portfolioOperationResult'
import {
  createPortfolioLoadSingleFlight,
  executePortfolioLoadUiFlow,
  portfolioLoadButtonState,
  portfolioLoadFeedback,
  CROSS_TAB_STATE_STALE_MESSAGE,
  PORTFOLIO_LOAD_REJECTION_FEEDBACK,
  type PortfolioLoadFeedback,
} from './portfolioLoadUi'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const FAILURE_CASES: Array<[PortfolioLoadResult, string]> = [
  [{ ok: false, operation: 'refreshAllData', code: 'LOCAL_OPERATION_BUSY', retryable: true }, '別のポートフォリオ処理'],
  [{ ok: false, operation: 'refreshAllData', code: 'WEB_LOCK_UNAVAILABLE', retryable: false }, '複数タブ同期'],
  [{ ok: false, operation: 'refreshAllData', code: 'WEB_LOCK_TIMEOUT', retryable: true }, 'タイムアウト'],
  [{ ok: false, operation: 'refreshAllData', code: 'WEB_LOCK_ABORTED', retryable: true }, '中断'],
  [{ ok: false, operation: 'refreshAllData', code: 'WEB_LOCK_REQUEST_FAILED', retryable: true }, '排他制御'],
  [{ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false }, '別タブ'],
  [{ ok: false, operation: 'refreshAllData', code: 'PORTFOLIO_GENERATION_CONFLICT', retryable: false }, '保存世代'],
  [{ ok: false, operation: 'refreshAllData', code: 'LOAD_RESTORE_ERROR', retryable: false }, '復元'],
  [{ ok: false, operation: 'refreshAllData', code: 'LOAD_DATA_ERROR', retryable: true }, '最新データ'],
  [{ ok: false, operation: 'refreshAllData', code: 'LOAD_ANALYSIS_ERROR', retryable: true }, '再計算'],
  [{ ok: false, operation: 'refreshAllData', code: 'LOAD_PERSISTENCE_ERROR', retryable: true }, '保存'],
  [{ ok: false, operation: 'refreshAllData', code: 'LOAD_PUBLISH_ERROR', retryable: false }, '画面へ反映'],
]

describe('RA-007-B2 portfolio load UI contract', () => {
  it('derives disabled, aria-busy, and pending labels from global and local loading state', () => {
    const labels = { idle: '更新', globallyLoading: '読込中', locallyPending: '更新中' }
    expect(portfolioLoadButtonState(false, false, labels)).toEqual({
      disabled: false,
      ariaBusy: false,
      label: '更新',
    })
    expect(portfolioLoadButtonState(true, false, labels)).toEqual({
      disabled: true,
      ariaBusy: false,
      label: '読込中',
    })
    expect(portfolioLoadButtonState(true, true, labels)).toEqual({
      disabled: true,
      ariaBusy: true,
      label: '更新中',
    })
  })

  it('SUCCESS has no feedback', () => {
    expect(portfolioLoadFeedback({ ok: true, operation: 'initialize', code: 'SUCCESS' })).toBeNull()
  })

  it.each(FAILURE_CASES)('maps %s to a fixed sanitized message', (result, expected) => {
    const feedback = portfolioLoadFeedback(result)
    expect(feedback).toMatchObject({ tone: 'error' })
    expect(feedback?.message).toContain(expected)
    expect(feedback?.message).not.toMatch(/raw|sentinel|stack|cause/i)
  })

  it('RA-008-D2: CROSS_TAB_STATE_STALE resolves to the exported shared constant', () => {
    expect(CROSS_TAB_STATE_STALE_MESSAGE).toBe('別タブで更新された状態を検出しました。画面を再読み込みしてください。')
    const feedback = portfolioLoadFeedback({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    expect(feedback?.message).toBe(CROSS_TAB_STATE_STALE_MESSAGE)
  })

  it('RA-008-D2: other coordination messages are unaffected by the shared constant extraction', () => {
    const cases: Array<[PortfolioLoadResult, string]> = [
      [{ ok: false, operation: 'refreshAllData', code: 'WEB_LOCK_UNAVAILABLE', retryable: false }, '複数タブ同期'],
      [{ ok: false, operation: 'refreshAllData', code: 'PORTFOLIO_GENERATION_CONFLICT', retryable: false }, '保存世代'],
    ]
    for (const [result, expected] of cases) {
      expect(portfolioLoadFeedback(result)?.message).toContain(expected)
    }
  })

  it('keeps pending until success resolves and emits no premature feedback', async () => {
    const gate = deferred<PortfolioLoadResult>()
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []
    const running = executePortfolioLoadUiFlow(
      () => gate.promise,
      value => pending.push(value),
      value => feedback.push(value),
    )
    expect(pending).toEqual([true])
    expect(feedback).toEqual([null])
    gate.resolve({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    await expect(running).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(pending).toEqual([true, false])
    expect(feedback).toEqual([null, null])
  })

  it('clears pending after structured failure and raw rejection without exposing raw details', async () => {
    const pending: boolean[] = []
    const feedback: Array<PortfolioLoadFeedback | null> = []
    await executePortfolioLoadUiFlow(
      async () => ({ ok: false, operation: 'refreshAllData', code: 'LOAD_DATA_ERROR', retryable: true }),
      value => pending.push(value),
      value => feedback.push(value),
    )
    await executePortfolioLoadUiFlow(
      async () => { throw new Error('raw sentinel stack') },
      value => pending.push(value),
      value => feedback.push(value),
    )
    expect(pending).toEqual([true, false, true, false])
    expect(feedback).toContainEqual(expect.objectContaining({ message: expect.stringContaining('最新データ') }))
    expect(feedback[feedback.length - 1]).toEqual(PORTFOLIO_LOAD_REJECTION_FEEDBACK)
    expect(JSON.stringify(feedback)).not.toContain('raw sentinel')
  })

  it('single-flight blocks duplicates and releases after success and rejection', async () => {
    const gate = deferred<number>()
    const action = vi.fn(() => gate.promise)
    const singleFlight = createPortfolioLoadSingleFlight()
    const first = singleFlight.run(action)
    await expect(singleFlight.run(action)).resolves.toBeNull()
    expect(action).toHaveBeenCalledTimes(1)
    gate.resolve(1)
    await expect(first).resolves.toBe(1)
    await expect(singleFlight.run(async () => { throw new Error('failure') })).rejects.toThrow('failure')
    await expect(singleFlight.run(async () => 2)).resolves.toBe(2)
  })
})
