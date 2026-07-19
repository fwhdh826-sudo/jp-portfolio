import { describe, expect, it, vi } from 'vitest'
import type { PortfolioSnapshotImportResult } from '../../store/useAppStore'
import type {
  ManualMutationResult,
  ManualPortfolioMutationOperation,
} from '../../store/portfolioOperationResult'
import {
  createPortfolioOperationSingleFlight,
  executeManualMutationUiFlow,
  executeSnapshotImportUiFlow,
  manualMutationFeedback,
  snapshotImportFeedback,
  type PendingPortfolioOperation,
  type PortfolioOperationFeedback,
} from './T9_Settings'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const MANUAL_UI_OPERATIONS = [
  'setPortfolioPolicy',
  'setCashAssumptions',
  'clearCashAssumptionsOverride',
  'importCashAssumptions',
] as const

describe('RA-007-B1 T9 async portfolio actions', () => {
  it('snapshot stays pending with no success until the awaited action resolves', async () => {
    const gate = deferred<PortfolioSnapshotImportResult>()
    const pending: PendingPortfolioOperation[] = []
    const feedback: Array<PortfolioOperationFeedback | null> = []

    const running = executeSnapshotImportUiFlow(
      () => gate.promise,
      value => pending.push(value),
      value => feedback.push(value),
    )

    expect(pending).toEqual(['importPortfolioSnapshot'])
    expect(feedback).toEqual([null])
    gate.resolve({ ok: true, code: 'SUCCESS' })
    await expect(running).resolves.toEqual({ ok: true, code: 'SUCCESS' })
    expect(feedback[feedback.length - 1]).toEqual({ tone: 'success', message: 'snapshotをインポートしました。' })
    expect(pending[pending.length - 1]).toBeNull()
  })

  it('snapshot coordination failure clears pending and never emits success', async () => {
    const pending: PendingPortfolioOperation[] = []
    const feedback: Array<PortfolioOperationFeedback | null> = []
    const result: PortfolioSnapshotImportResult = {
      ok: false,
      operation: 'importPortfolioSnapshot',
      code: 'LOCAL_OPERATION_BUSY',
      retryable: true,
    }

    await executeSnapshotImportUiFlow(
      async () => result,
      value => pending.push(value),
      value => feedback.push(value),
    )

    expect(feedback[feedback.length - 1]).toMatchObject({ tone: 'error' })
    expect(feedback[feedback.length - 1]?.message).toContain('完了後に再試行')
    expect(pending[pending.length - 1]).toBeNull()
    expect(feedback).not.toContainEqual(expect.objectContaining({ tone: 'success' }))
  })

  it.each(MANUAL_UI_OPERATIONS)('%s stays pending and reports success only after resolve', async operation => {
    const gate = deferred<ManualMutationResult>()
    const pending: PendingPortfolioOperation[] = []
    const feedback: Array<PortfolioOperationFeedback | null> = []
    const running = executeManualMutationUiFlow(
      operation,
      () => gate.promise,
      value => pending.push(value),
      value => feedback.push(value),
    )

    expect(pending).toEqual([operation])
    expect(feedback).toEqual([null])
    gate.resolve({ ok: true, operation, code: 'SUCCESS' })
    await running
    expect(feedback[feedback.length - 1]).toMatchObject({ tone: 'success' })
    expect(pending[pending.length - 1]).toBeNull()
  })

  it('manual NO_CHANGE is informative rather than a premature success', async () => {
    const feedback: Array<PortfolioOperationFeedback | null> = []
    await executeManualMutationUiFlow(
      'setPortfolioPolicy',
      async () => ({ ok: true, operation: 'setPortfolioPolicy', code: 'NO_CHANGE' }),
      () => undefined,
      value => feedback.push(value),
    )
    expect(feedback[feedback.length - 1]).toEqual({ tone: 'info', message: '変更はありません。' })
  })

  it.each([
    ['LOCAL_OPERATION_BUSY', '完了後に再試行'],
    ['PORTFOLIO_GENERATION_CONFLICT', '再読み込み'],
    ['MANUAL_ANALYSIS_ERROR', '再計算に失敗'],
    ['MANUAL_PERSISTENCE_ERROR', '保存できません'],
    ['MANUAL_PUBLISH_ERROR', '画面反映に失敗'],
  ] as const)('%s maps to sanitized failure feedback with no success', (code, expected) => {
    const result = code === 'LOCAL_OPERATION_BUSY' || code === 'PORTFOLIO_GENERATION_CONFLICT'
      ? {
          ok: false as const,
          operation: 'setPortfolioPolicy' as const,
          code,
          retryable: code === 'LOCAL_OPERATION_BUSY',
        }
      : {
          ok: false as const,
          operation: 'setPortfolioPolicy' as const,
          code,
          retryable: true as const,
        }
    const feedback = manualMutationFeedback(result)
    expect(feedback).toMatchObject({ tone: 'error' })
    expect(feedback.message).toContain(expected)
    expect(feedback.message).not.toMatch(/stack|cause|sentinel/i)
  })

  it.each([
    ['WEB_LOCK_UNAVAILABLE', 'この環境では安全な複数タブ同期を利用できません。対応ブラウザのHTTPS環境で再読み込みしてください。'],
    ['WEB_LOCK_TIMEOUT', '別タブの処理待機がタイムアウトしました。別タブを確認して再試行してください。'],
    ['WEB_LOCK_ABORTED', '処理開始前に操作が中断されました。再試行してください。'],
    ['WEB_LOCK_REQUEST_FAILED', '安全な排他制御を開始できませんでした。再読み込み後に再試行してください。'],
    ['CROSS_TAB_STATE_STALE', '別タブで更新された状態を検出しました。画面を再読み込みしてください。'],
    ['PORTFOLIO_GENERATION_CONFLICT', '保存世代の競合を検出しました。画面を再読み込みしてください。'],
  ] as const)('%s uses the exact shared manual/snapshot coordination message', (code, message) => {
    const manual: ManualMutationResult = {
      ok: false,
      operation: 'setPortfolioPolicy',
      code,
      retryable: code === 'WEB_LOCK_UNAVAILABLE' || code === 'CROSS_TAB_STATE_STALE' ||
        code === 'PORTFOLIO_GENERATION_CONFLICT' ? false : true,
    }
    const snapshot: PortfolioSnapshotImportResult = {
      ok: false,
      operation: 'importPortfolioSnapshot',
      code,
      retryable: manual.retryable,
    }
    expect(manualMutationFeedback(manual)).toEqual({ tone: 'error', message })
    expect(snapshotImportFeedback(snapshot)).toEqual({ tone: 'error', message })
    expect(message).not.toMatch(/stack|cause|sentinel/i)
  })

  it('success and failure both release pending, including rejected raw exceptions', async () => {
    const pending: PendingPortfolioOperation[] = []
    const feedback: Array<PortfolioOperationFeedback | null> = []
    await executeManualMutationUiFlow(
      'setCashAssumptions',
      async () => { throw new Error('raw sentinel stack') },
      value => pending.push(value),
      value => feedback.push(value),
    )
    expect(pending).toEqual(['setCashAssumptions', null])
    expect(feedback[feedback.length - 1]).toMatchObject({ tone: 'error' })
    expect(feedback[feedback.length - 1]?.message).not.toContain('raw sentinel')
  })

  it('single-flight guard prevents duplicate actions and releases after success or failure', async () => {
    const gate = deferred<number>()
    const action = vi.fn(() => gate.promise)
    const singleFlight = createPortfolioOperationSingleFlight()
    const first = singleFlight.run(action)
    const duplicate = singleFlight.run(action)
    expect(action).toHaveBeenCalledTimes(1)
    await expect(duplicate).resolves.toBeNull()
    gate.resolve(1)
    await expect(first).resolves.toBe(1)

    await expect(singleFlight.run(async () => { throw new Error('failure') })).rejects.toThrow('failure')
    await expect(singleFlight.run(async () => 2)).resolves.toBe(2)
  })

  it('snapshot domain errors retain only the existing sanitized message', () => {
    const result: PortfolioSnapshotImportResult = {
      ok: false,
      code: 'INVALID_SNAPSHOT',
      error: 'snapshot形式が不正です。',
    }
    expect(snapshotImportFeedback(result)).toEqual({
      tone: 'error',
      message: 'snapshot形式が不正です。',
    })
  })

  it('manual feedback contains no user data fields for every public manual operation', () => {
    const operations: ManualPortfolioMutationOperation[] = [
      'updateHolding',
      'updateTrust',
      'setPortfolioPolicy',
      'setCashAssumptions',
      'clearCashAssumptionsOverride',
      'importCashAssumptions',
    ]
    for (const operation of operations) {
      const result: ManualMutationResult = { ok: true, operation, code: 'SUCCESS' }
      expect(Object.keys(result).sort()).toEqual(['code', 'ok', 'operation'])
      expect(manualMutationFeedback(result).message).toBe('変更を保存しました。')
    }
  })
})
