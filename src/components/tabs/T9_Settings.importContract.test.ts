import { describe, expect, it } from 'vitest'
import type { SbiFullExportImportResult } from '../../store/useAppStore'
import { executeCsvImportUiFlow } from './T9_Settings'

// OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-01): T9's production import UI flow is wired to
// importSbiPortfolioFullExport — these fixtures use SbiFullExportImportResult's own shape.

function successResult(): Extract<SbiFullExportImportResult, { ok: true; code: 'SUCCESS' }> {
  return {
    ok: true,
    code: 'SUCCESS',
    message: '取込みが完了しました',
    imported: {
      stock: { added: 0, updated: 1, removed: 0 },
      trust: { updated: 0, zeroed: 0 },
    },
    importedAt: '2026-07-15T00:00:00.000Z',
    authorityStatus: 'COMPLETE',
  }
}

describe('T9-A001: truthful CSV UI flow', () => {
  it('a valid extension does not emit success while import is pending', async () => {
    let resolveImport!: (result: SbiFullExportImportResult) => void
    const results: Array<{ ok: boolean; message: string } | null> = []
    const pending = executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      () => new Promise(resolve => { resolveImport = resolve }),
      result => results.push(result),
    )

    await Promise.resolve()
    expect(results).toEqual([null])

    resolveImport(successResult())
    await pending
    expect(results[results.length - 1]).toMatchObject({ ok: true })
  })

  it('parser/store failure clears an old success and renders the structured error message', async () => {
    const results: Array<{ ok: boolean; message: string } | null> = [{ ok: true, message: 'old success' }]
    const failure: SbiFullExportImportResult = {
      ok: false,
      code: 'UNKNOWN_ERROR',
      message: 'CSVを解析できませんでした',
    }

    await executeCsvImportUiFlow(
      new File(['bad'], 'portfolio.csv'),
      async () => failure,
      result => results.push(result),
    )

    expect(results).toEqual([
      { ok: true, message: 'old success' },
      null,
      { ok: false, message: 'CSVを解析できませんでした' },
    ])
  })

  it('invalid extension is rejected without calling the store action', async () => {
    let called = false
    const results: Array<{ ok: boolean; message: string } | null> = []

    await executeCsvImportUiFlow(
      new File(['x'], 'portfolio.txt'),
      async () => { called = true; return successResult() },
      result => results.push(result),
    )

    expect(called).toBe(false)
    expect(results[results.length - 1]).toMatchObject({ ok: false })
  })

  it.each([
    ['UNKNOWN_ERROR', 'CSV取込中に予期しないエラーが発生しました。再試行してください。'],
    ['IMPORT_CONFLICT', '取込中に分析条件が変更されました。再試行してください。'],
    ['STALE_SOURCE', 'CSVのデータ基準日時が不正です。状態は変更されていません。'],
  ] as const)('%s structured failure is shown as failure and never as stale success', async (code, message) => {
    const feedback: Array<{ ok: boolean; message: string } | null> = [{ ok: true, message: 'old success' }]
    const failure: SbiFullExportImportResult = { ok: false, code, message }

    const result = await executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      async () => failure,
      value => feedback.push(value),
    )

    expect(result).toEqual(failure)
    expect(feedback).toEqual([{ ok: true, message: 'old success' }, null, { ok: false, message }])
  })

  it('duplicate no-op is truthful info feedback rather than green success', async () => {
    const duplicate: SbiFullExportImportResult = {
      ok: true,
      code: 'DUPLICATE_FULL_EXPORT',
      message: '同じ内容のCSVは取込み済みです',
      importedAt: '2026-07-15T00:00:00.000Z',
    }
    const feedback: Array<{ ok: boolean; message: string; tone?: 'info' } | null> = []

    await executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      async () => duplicate,
      value => feedback.push(value),
    )

    expect(feedback[feedback.length - 1]).toEqual({ ok: true, tone: 'info', message: duplicate.message })
  })

  it('AUTHORITY_NOT_PASS is shown as failure with the structured message, never a stale success', async () => {
    const failure: SbiFullExportImportResult = {
      ok: false,
      code: 'AUTHORITY_NOT_PASS',
      message: 'CSVは完全な取込対象ポートフォリオであることを証明できませんでした。状態は変更されていません。',
      reasons: ['EXPECTED_SECTION_ABSENT'],
    }
    const feedback: Array<{ ok: boolean; message: string } | null> = [{ ok: true, message: 'old success' }]

    await executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      async () => failure,
      value => feedback.push(value),
    )

    expect(feedback[feedback.length - 1]).toEqual({ ok: false, message: failure.message })
  })

  it('passes explicit unknown-provenance confirmation only when requested', async () => {
    let receivedConfirmation = false
    await executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      async (_file, options) => {
        receivedConfirmation = options?.confirmUnknownProvenance === true
        return successResult()
      },
      () => undefined,
      { confirmUnknownProvenance: true },
    )

    expect(receivedConfirmation).toBe(true)
  })

  it('passes the destructive-change confirmationToken only when requested', async () => {
    let receivedToken: string | undefined
    await executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      async (_file, options) => {
        receivedToken = options?.confirmationToken
        return successResult()
      },
      () => undefined,
      { confirmationToken: 'sha256:abc' },
    )

    expect(receivedToken).toBe('sha256:abc')
  })
})
