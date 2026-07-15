import { describe, expect, it } from 'vitest'
import type { CsvImportResult } from '../../store/useAppStore'
import { executeCsvImportUiFlow } from './T9_Settings'

function successResult(): CsvImportResult {
  return {
    ok: true,
    code: 'SUCCESS',
    message: '取込みが完了しました',
    imported: {
      stock: { updated: 1, added: 0, removed: 0 },
      trust: { updated: 0, reheld: 0, zeroed: 0, unknown: 0, ambiguous: 0 },
    },
    warnings: [],
    analysisCommitted: true,
    officialDecisionCommitted: true,
    persistence: { status: 'committed' },
    importedAt: '2026-07-15T00:00:00.000Z',
  }
}

describe('T9-A001: truthful CSV UI flow', () => {
  it('a valid extension does not emit success while import is pending', async () => {
    let resolveImport!: (result: CsvImportResult) => void
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
    const failure: CsvImportResult = {
      ok: false,
      code: 'PARSE_ERROR',
      message: 'CSVを解析できませんでした',
      warnings: [],
      analysisCommitted: false,
      officialDecisionCommitted: false,
      persistence: { status: 'not_attempted' },
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
  ] as const)('%s structured failure is shown as failure and never as stale success', async (code, message) => {
    const feedback: Array<{ ok: boolean; message: string } | null> = [{ ok: true, message: 'old success' }]
    const failure: CsvImportResult = {
      ok: false,
      code,
      message,
      warnings: [],
      analysisCommitted: false,
      officialDecisionCommitted: false,
      persistence: { status: 'not_attempted' },
    }

    const result = await executeCsvImportUiFlow(
      new File(['csv'], 'portfolio.csv'),
      async () => failure,
      value => feedback.push(value),
    )

    expect(result).toEqual(failure)
    expect(feedback).toEqual([{ ok: true, message: 'old success' }, null, { ok: false, message }])
  })
})
