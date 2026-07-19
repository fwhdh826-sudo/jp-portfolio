// P4.5-A013-T6a: T9のCsvSyncSummaryPanelが使う表示専用の純関数
// （computeCsvSyncSummaryDisplay）の回帰guard。componentレンダリングなしで
// 「summaryあり/なし」「unknown/ambiguousの警告有無」を固定する。
import { describe, it, expect } from 'vitest'
import {
  CSV_METADATA_STORAGE_DETAIL,
  computeCsvSourceAsOfDisplay,
  computeCsvSyncSummaryDisplay,
} from './T9_Settings'
import type { CsvImportProvenance, CsvSyncSummary } from '../../types'

function makeSummary(overrides: Partial<CsvSyncSummary> = {}): CsvSyncSummary {
  return {
    importedAt: '2026-07-11T05:00:00.000Z',
    stock: { updated: 2, added: 1, removed: 1 },
    trust: { updated: 3, reheld: 1, zeroed: 1, unknownFunds: [], ambiguousFundIds: [] },
    ...overrides,
  }
}

describe('computeCsvSyncSummaryDisplay', () => {
  it('summaryがnullのとき: hasSummary=falseで内訳・警告は全てnull（T9: 未取込表示に対応）', () => {
    const result = computeCsvSyncSummaryDisplay(null)
    expect(result.hasSummary).toBe(false)
    expect(result.hasWarning).toBe(false)
    expect(result.importedAtLabel).toBeNull()
    expect(result.stockLine).toBeNull()
    expect(result.trustLine).toBeNull()
    expect(result.unknownFundsWarning).toBeNull()
    expect(result.ambiguousWarning).toBeNull()
  })

  it('summaryがundefinedのときもhasSummary=false', () => {
    expect(computeCsvSyncSummaryDisplay(undefined).hasSummary).toBe(false)
  })

  it('summaryがあり unknown/ambiguous両方0件のとき: 内訳を表示しhasWarning=false（T9: 個別株/投信内訳表示）', () => {
    const result = computeCsvSyncSummaryDisplay(makeSummary())
    expect(result.hasSummary).toBe(true)
    expect(result.hasWarning).toBe(false)
    expect(result.stockLine).toBe('個別株: 更新2 / 新規1 / 売却反映1')
    expect(result.trustLine).toBe('投信: 更新3 / 再保有反映1 / 解約反映1 / 未登録0 / 曖昧照合0')
    expect(result.unknownFundsWarning).toBeNull()
    expect(result.ambiguousWarning).toBeNull()
  })

  it('unknown fundが1件以上あるとき: hasWarning=trueかつ名称を含む警告文言（T9: unknown fund警告表示）', () => {
    const result = computeCsvSyncSummaryDisplay(makeSummary({
      trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [{ name: '謎の投信', eval: 50_000 }], ambiguousFundIds: [] },
    }))
    expect(result.hasWarning).toBe(true)
    expect(result.unknownFundsWarning).toContain('謎の投信')
    expect(result.unknownFundsWarning).toContain('1件')
    expect(result.ambiguousWarning).toBeNull()
  })

  it('ambiguousFundIdsが1件以上あるとき: hasWarning=trueかつidを含む警告文言（T9: ambiguous警告表示）', () => {
    const result = computeCsvSyncSummaryDisplay(makeSummary({
      trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: ['dup_toku', 'dup_nisa'] },
    }))
    expect(result.hasWarning).toBe(true)
    expect(result.ambiguousWarning).toContain('dup_toku')
    expect(result.ambiguousWarning).toContain('dup_nisa')
    expect(result.ambiguousWarning).toContain('2件')
    expect(result.unknownFundsWarning).toBeNull()
  })

  it('unknown/ambiguousが両方あるとき両方の警告文言を返す', () => {
    const result = computeCsvSyncSummaryDisplay(makeSummary({
      trust: {
        updated: 0, reheld: 0, zeroed: 0,
        unknownFunds: [{ name: '謎の投信', eval: 1 }],
        ambiguousFundIds: ['dup_a'],
      },
    }))
    expect(result.hasWarning).toBe(true)
    expect(result.unknownFundsWarning).not.toBeNull()
    expect(result.ambiguousWarning).not.toBeNull()
  })
})

function provenance(
  sourceAsOf: string | null,
  confidence: 'authoritative' | 'weak' | 'unknown',
): CsvImportProvenance {
  return {
    importedAt: '2026-07-18T00:00:00.000Z',
    sourceAsOf,
    sourceAsOfKind: confidence === 'authoritative'
      ? 'csv_explicit'
      : confidence === 'weak'
        ? 'filename'
        : 'unknown',
    sourceAsOfConfidence: confidence,
    semanticIdentity: `sha256:${'1'.repeat(64)}`,
    contentFingerprint: 'fnv1a32:12345678',
    sourceFileName: 'portfolio.csv',
    fileLastModified: null,
  }
}

describe('RA-005 CSV metadata UI honesty', () => {
  it('authoritative sourceAsOf keeps the CSV明示 label', () => {
    expect(computeCsvSourceAsOfDisplay(
      provenance('2026-07-17T00:00:00.000Z', 'authoritative'),
    )).toContain('CSV明示')
  })

  it('weak sourceAsOf remains reference information', () => {
    expect(computeCsvSourceAsOfDisplay(
      provenance('2026-07-17T00:00:00.000Z', 'weak'),
    )).toContain('参考情報')
  })

  it('unknown sourceAsOf says import operation time is not a freshness substitute', () => {
    expect(computeCsvSourceAsOfDisplay(provenance(null, 'unknown')))
      .toBe('不明（取込操作時刻を鮮度の代用には使用しません）')
  })

  it('storage wording states the 90-day immutable-reference contract and removes indefinite retention', () => {
    expect(CSV_METADATA_STORAGE_DETAIL).toContain('最大90日保持')
    expect(CSV_METADATA_STORAGE_DETAIL).toContain('CSV基準時刻を優先')
    expect(CSV_METADATA_STORAGE_DETAIL).toContain('保存し直しても鮮度は更新されません')
    expect(CSV_METADATA_STORAGE_DETAIL).not.toContain('無期限')
  })
})
