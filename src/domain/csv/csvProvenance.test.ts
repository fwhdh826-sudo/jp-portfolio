import { describe, expect, it } from 'vitest'
import type { CsvImportProvenance } from '../../types'
import {
  buildCsvSourceProvenance,
  evaluateCsvImportMonotonicity,
} from './csvProvenance'

const semanticA = {
  trustSectionSeen: true,
  rows: [{ assetType: 'stock', code: '1001', name: '銘柄1001', eval: 100_000 }],
}
const semanticB = {
  trustSectionSeen: true,
  rows: [{ assetType: 'stock', code: '1001', name: '銘柄1001', eval: 200_000 }],
}

function source(
  text: string,
  options: { name?: string; lastModified?: number; semantic?: unknown } = {},
) {
  return buildCsvSourceProvenance({
    text,
    fileName: options.name ?? 'portfolio.csv',
    fileLastModified: options.lastModified ?? 0,
    semanticContent: options.semantic ?? semanticA,
  })
}

function imported(
  sourceProvenance: ReturnType<typeof source>,
  importedAt = '2026-07-15T03:00:00.000Z',
): CsvImportProvenance {
  return { importedAt, ...sourceProvenance }
}

describe('T9-A004: CSV source provenance extraction', () => {
  it('uses an explicit CSV snapshot timestamp as authoritative provenance', () => {
    expect(source('データ基準日時,2026-07-15T09:00:00+09:00')).toMatchObject({
      sourceAsOf: '2026-07-15T00:00:00.000Z',
      sourceAsOfKind: 'csv_explicit',
      sourceAsOfConfidence: 'authoritative',
    })
  })

  it('treats an explicit export/download time as weak, not authoritative', () => {
    expect(source('出力日時,2026-07-15T09:00:00+09:00')).toMatchObject({
      sourceAsOfKind: 'csv_exported_at',
      sourceAsOfConfidence: 'weak',
    })
  })

  it('uses a filename date only as weak provenance', () => {
    expect(source('', { name: 'portfolio_2026-07-15_090000.csv' })).toMatchObject({
      sourceAsOf: '2026-07-15T00:00:00.000Z',
      sourceAsOfKind: 'filename',
      sourceAsOfConfidence: 'weak',
    })
  })

  it('uses File.lastModified only as weak provenance', () => {
    const lastModified = Date.parse('2026-07-15T10:00:00+09:00')
    expect(source('', { lastModified })).toMatchObject({
      sourceAsOf: '2026-07-15T01:00:00.000Z',
      sourceAsOfKind: 'file_last_modified',
      sourceAsOfConfidence: 'weak',
    })
  })

  it('does not substitute browser import time when every source timestamp is missing', () => {
    expect(source('')).toMatchObject({
      sourceAsOf: null,
      sourceAsOfKind: 'unknown',
      sourceAsOfConfidence: 'unknown',
    })
  })

  it('explicit CSV time wins when filename date conflicts', () => {
    expect(source('データ基準日時,2026-07-10T09:00:00+09:00', {
      name: 'portfolio_2026-07-15.csv',
    })).toMatchObject({ sourceAsOf: '2026-07-10T00:00:00.000Z', sourceAsOfKind: 'csv_explicit' })
  })

  it('explicit CSV time wins when File.lastModified conflicts', () => {
    expect(source('データ基準日時,2026-07-10T09:00:00+09:00', {
      lastModified: Date.parse('2026-07-15T09:00:00+09:00'),
    })).toMatchObject({ sourceAsOf: '2026-07-10T00:00:00.000Z', sourceAsOfKind: 'csv_explicit' })
  })

  it('an old CSV copied today remains old when it contains an explicit source time', () => {
    expect(source('データ基準日時,2026-06-01T09:00:00+09:00', {
      lastModified: Date.parse('2026-07-15T09:00:00+09:00'),
    }).sourceAsOf).toBe('2026-06-01T00:00:00.000Z')
  })

  it('a newer explicit source time remains newer even with an older filesystem timestamp', () => {
    expect(source('データ基準日時,2026-07-15T09:00:00+09:00', {
      lastModified: Date.parse('2026-06-01T09:00:00+09:00'),
    }).sourceAsOf).toBe('2026-07-15T00:00:00.000Z')
  })

  it('semantic fingerprint ignores raw whitespace/line-ending/encoding representation', () => {
    const first = source('raw A\r\n', { semantic: semanticA })
    const second = source(' raw B \n', { semantic: semanticA })
    expect(first.contentFingerprint).toBe(second.contentFingerprint)
  })

  it('semantic fingerprint changes when normalized portfolio source content changes', () => {
    expect(source('', { semantic: semanticA }).contentFingerprint)
      .not.toBe(source('', { semantic: semanticB }).contentFingerprint)
  })
})

describe('T9-A004: pure CSV monotonicity policy', () => {
  const explicitOld = imported(source('データ基準日時,2026-07-14T09:00:00+09:00'))
  const explicitNew = imported(source('データ基準日時,2026-07-15T09:00:00+09:00', { semantic: semanticB }))

  it('allows a newer authoritative source generation', () => {
    expect(evaluateCsvImportMonotonicity({ incoming: explicitNew, current: explicitOld, currentGenerationExists: true }).decision)
      .toBe('ALLOW_NEWER')
  })

  it('rejects an older authoritative source generation as stale', () => {
    expect(evaluateCsvImportMonotonicity({ incoming: explicitOld, current: explicitNew, currentGenerationExists: true }).decision)
      .toBe('REJECT_STALE')
  })

  it('same source time and same semantic content is an idempotent duplicate', () => {
    const repeated = imported({ ...source('データ基準日時,2026-07-14T09:00:00+09:00') })
    expect(evaluateCsvImportMonotonicity({ incoming: repeated, current: explicitOld, currentGenerationExists: true }).decision)
      .toBe('DUPLICATE')
  })

  it('newer authoritative provenance with unchanged content is allowed to advance provenance', () => {
    const newerSameContent = imported(source('データ基準日時,2026-07-15T09:00:00+09:00'))
    expect(evaluateCsvImportMonotonicity({
      incoming: newerSameContent,
      current: explicitOld,
      currentGenerationExists: true,
    }).decision).toBe('ALLOW_NEWER')
  })

  it('older authoritative provenance with identical content is a no-op preserving current provenance', () => {
    expect(evaluateCsvImportMonotonicity({
      incoming: explicitOld,
      current: imported(source('データ基準日時,2026-07-15T09:00:00+09:00')),
      currentGenerationExists: true,
    }).decision).toBe('DUPLICATE')
  })

  it('same authoritative source time with different content is a conflict', () => {
    const conflict = imported(source('データ基準日時,2026-07-14T09:00:00+09:00', { semantic: semanticB }))
    expect(evaluateCsvImportMonotonicity({ incoming: conflict, current: explicitOld, currentGenerationExists: true }).decision)
      .toBe('REJECT_CONFLICT')
  })

  it('rejects incoming unknown provenance when current provenance is authoritative', () => {
    expect(evaluateCsvImportMonotonicity({
      incoming: imported(source('', { semantic: semanticB })),
      current: explicitOld,
      currentGenerationExists: true,
    }).decision).toBe('REJECT_UNKNOWN_DOWNGRADE')
  })

  it('allows an authoritative first-known source over a committed unknown provenance', () => {
    expect(evaluateCsvImportMonotonicity({
      incoming: explicitNew,
      current: imported(source('', { semantic: semanticA })),
      currentGenerationExists: true,
    }).decision).toBe('ALLOW_FIRST_KNOWN')
  })

  it('both unknown with identical content is a duplicate', () => {
    const current = imported(source(''))
    expect(evaluateCsvImportMonotonicity({ incoming: imported(source('')), current, currentGenerationExists: true }).decision)
      .toBe('DUPLICATE')
  })

  it('both unknown with different content requires rejection instead of using import time', () => {
    expect(evaluateCsvImportMonotonicity({
      incoming: imported(source('', { semantic: semanticB }), '2099-01-01T00:00:00.000Z'),
      current: imported(source('', { semantic: semanticA }), '2020-01-01T00:00:00.000Z'),
      currentGenerationExists: true,
    }).decision).toBe('REJECT_UNKNOWN_DOWNGRADE')
  })

  it('weak timestamps never outrank an authoritative timestamp', () => {
    expect(evaluateCsvImportMonotonicity({
      incoming: imported(source('', {
        name: 'portfolio_2099-01-01.csv',
        semantic: semanticB,
      })),
      current: explicitOld,
      currentGenerationExists: true,
    }).decision).toBe('REJECT_UNKNOWN_DOWNGRADE')
  })

  it('same weak timestamp with different content remains confirmation-required, not authoritative conflict', () => {
    const weakCurrent = imported(source('', {
      name: 'portfolio_2026-07-15.csv',
      semantic: semanticA,
    }))
    const weakIncoming = imported(source('', {
      name: 'portfolio_2026-07-15.csv',
      semantic: semanticB,
    }))
    expect(evaluateCsvImportMonotonicity({
      incoming: weakIncoming,
      current: weakCurrent,
      currentGenerationExists: true,
    }).decision).toBe('REJECT_UNKNOWN_DOWNGRADE')
  })

  it('a first import is allowed even when its provenance is unknown', () => {
    expect(evaluateCsvImportMonotonicity({
      incoming: imported(source('')),
      current: null,
      currentGenerationExists: false,
    }).decision).toBe('ALLOW_FIRST_IMPORT')
  })
})
