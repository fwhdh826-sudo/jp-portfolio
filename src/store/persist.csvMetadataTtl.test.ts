import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, CsvSyncSummary } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  isCsvMetadataReferenceWithinTtl,
  persistCsvImportTransaction,
  resolveCsvMetadataReferenceEpochMs,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  type CsvImportPersistencePayload,
} from './persist'

const DAY_MS = 24 * 60 * 60 * 1000
const CSV_TTL_MS = 90 * DAY_MS
const NOW_MS = Date.parse('2026-07-19T00:00:00.000Z')
const CSV_IMPORTED_AT_KEY = 'v10_csv_imported_at'
const CSV_SYNC_SUMMARY_KEY = 'v13_csv_sync_summary'

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

function summary(importedAt: string): CsvSyncSummary {
  return {
    importedAt,
    stock: { updated: 1, added: 0, removed: 0 },
    trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
  }
}

function provenance(
  importedAt: string,
  sourceAsOf: string | null,
  confidence: 'authoritative' | 'weak' | 'unknown',
): CsvImportProvenance {
  return {
    importedAt,
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

function canonicalPayload(options: {
  importedAt?: string | null
  sourceAsOf?: string | null
  confidence?: 'authoritative' | 'weak' | 'unknown'
  origin?: 'csv' | 'snapshot'
} = {}): CsvImportPersistencePayload {
  const importedAt = options.importedAt === undefined ? iso(NOW_MS - DAY_MS) : options.importedAt
  const confidence = options.confidence ?? 'authoritative'
  const sourceAsOf = options.sourceAsOf === undefined ? iso(NOW_MS - DAY_MS) : options.sourceAsOf
  const origin = options.origin ?? 'csv'
  const csvProvenance = importedAt === null
    ? null
    : provenance(importedAt, confidence === 'unknown' ? null : sourceAsOf, confidence)
  return {
    holdings: [],
    trust: [],
    learning: null,
    csvImportedAt: importedAt,
    provenance: csvProvenance,
    syncSummary: origin === 'csv' && importedAt !== null ? summary(importedAt) : null,
    trustShortSnapshot: { date: '2026-07-19', total: 0, evalById: {} },
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    origin,
    snapshotTransferIdentity: origin === 'snapshot' ? `sha256:${'2'.repeat(64)}` : null,
  }
}

function checksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

describe('RA-005 CSV metadata TTL reference contract', () => {
  const storage: Record<string, string> = {}
  const setItem = vi.fn((key: string, value: string) => { storage[key] = value })
  const removeItem = vi.fn((key: string) => { delete storage[key] })

  beforeEach(() => {
    Object.keys(storage).forEach(key => delete storage[key])
    setItem.mockClear()
    removeItem.mockClear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem,
      removeItem,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  describe('pure reference helper', () => {
    it('authoritative sourceAsOf has priority over every importedAt fallback', () => {
      const sourceAsOf = iso(NOW_MS - 10 * DAY_MS)
      const importedAt = iso(NOW_MS - DAY_MS)
      expect(resolveCsvMetadataReferenceEpochMs({
        provenance: provenance(importedAt, sourceAsOf, 'authoritative'),
        csvImportedAt: importedAt,
        importedAt,
        legacySnapshotAt: importedAt,
        syncSummaryImportedAt: importedAt,
      })).toBe(Date.parse(sourceAsOf))
    })

    it('uses importedAt fallbacks in the documented immutable priority order', () => {
      const values = [1, 2, 3, 4, 5].map(days => iso(NOW_MS - days * DAY_MS))
      const weak = provenance(values[2], iso(NOW_MS + DAY_MS), 'weak')
      expect(resolveCsvMetadataReferenceEpochMs({ provenance: weak, csvImportedAt: values[0], importedAt: values[1], legacySnapshotAt: values[3], syncSummaryImportedAt: values[4] })).toBe(Date.parse(values[0]))
      expect(resolveCsvMetadataReferenceEpochMs({ provenance: weak, importedAt: values[1], legacySnapshotAt: values[3], syncSummaryImportedAt: values[4] })).toBe(Date.parse(values[1]))
      expect(resolveCsvMetadataReferenceEpochMs({ provenance: weak, legacySnapshotAt: values[3], syncSummaryImportedAt: values[4] })).toBe(Date.parse(values[2]))
      expect(resolveCsvMetadataReferenceEpochMs({ legacySnapshotAt: values[3], syncSummaryImportedAt: values[4] })).toBe(Date.parse(values[3]))
      expect(resolveCsvMetadataReferenceEpochMs({ syncSummaryImportedAt: values[4] })).toBe(Date.parse(values[4]))
    })

    it('does not use weak sourceAsOf, savedAt-like clocks, or current time as source proof', () => {
      const importedAt = iso(NOW_MS - 91 * DAY_MS)
      expect(isCsvMetadataReferenceWithinTtl({
        provenance: provenance(importedAt, iso(NOW_MS), 'weak'),
        csvImportedAt: importedAt,
      }, NOW_MS)).toBe(false)
      expect(resolveCsvMetadataReferenceEpochMs({})).toBeNull()
    })

    it.each([
      ['exactly 90 days', NOW_MS - CSV_TTL_MS, true],
      ['89d 23:59:59', NOW_MS - CSV_TTL_MS + 1000, true],
      ['90 days + 1ms', NOW_MS - CSV_TTL_MS - 1, false],
      ['future by 1ms', NOW_MS + 1, false],
    ] as const)('%s follows the closed boundary contract', (_label, referenceMs, expected) => {
      expect(isCsvMetadataReferenceWithinTtl({ csvImportedAt: iso(referenceMs) }, NOW_MS)).toBe(expected)
    })

    it('malformed, missing, and invalid now timestamps fail closed', () => {
      expect(isCsvMetadataReferenceWithinTtl({ csvImportedAt: '2026-02-30T00:00:00Z' }, NOW_MS)).toBe(false)
      expect(isCsvMetadataReferenceWithinTtl({}, NOW_MS)).toBe(false)
      expect(isCsvMetadataReferenceWithinTtl({ csvImportedAt: iso(NOW_MS) }, Number.NaN)).toBe(false)
    })

    it('authoritative sourceAsOf at the same instant in Z and +09:00 has the same boundary result', () => {
      const z = '2026-04-20T00:00:00.000Z'
      const jst = '2026-04-20T09:00:00.000+09:00'
      const importedAt = iso(NOW_MS - DAY_MS)
      const zInput = { provenance: provenance(importedAt, z, 'authoritative') }
      const jstInput = { provenance: provenance(importedAt, jst, 'authoritative') }
      expect(resolveCsvMetadataReferenceEpochMs(zInput))
        .toBe(resolveCsvMetadataReferenceEpochMs(jstInput))
      expect(isCsvMetadataReferenceWithinTtl(zInput, NOW_MS))
        .toBe(isCsvMetadataReferenceWithinTtl(jstInput, NOW_MS))
    })
  })

  describe('canonical authoritative and weak/unknown matrix', () => {
    it.each([
      ['89d 23:59:59', NOW_MS - CSV_TTL_MS + 1000, true],
      ['exact 90d', NOW_MS - CSV_TTL_MS, true],
      ['90d + 1ms', NOW_MS - CSV_TTL_MS - 1, false],
      ['future', NOW_MS + 1, false],
    ] as const)('authoritative sourceAsOf %s controls both metadata restores', (_label, referenceMs, expected) => {
      const importedAt = iso(NOW_MS - DAY_MS)
      const payload = canonicalPayload({ importedAt, sourceAsOf: iso(referenceMs) })
      persistCsvImportTransaction(payload, NOW_MS)
      const rawBefore = storage[CSV_IMPORT_GENERATION_KEY]
      setItem.mockClear()
      removeItem.mockClear()

      expect(restoreCsvImportedAt(NOW_MS)).toBe(expected ? importedAt : null)
      expect(restoreCsvSyncSummary(NOW_MS)).toEqual(expected ? payload.syncSummary : null)
      expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(rawBefore)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it('current manifest savedAt cannot revive an old authoritative sourceAsOf', () => {
      const payload = canonicalPayload({ sourceAsOf: iso(NOW_MS - CSV_TTL_MS - 1) })
      persistCsvImportTransaction(payload, NOW_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
    })

    it('old manifest savedAt cannot expire a new authoritative sourceAsOf', () => {
      const payload = canonicalPayload({ sourceAsOf: iso(NOW_MS - DAY_MS) })
      persistCsvImportTransaction(payload, NOW_MS - 365 * DAY_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBe(payload.csvImportedAt)
      expect(restoreCsvSyncSummary(NOW_MS)).toEqual(payload.syncSummary)
    })

    it('re-saving identical payload with a new savedAt leaves TTL results and source metadata unchanged', () => {
      const payload = canonicalPayload({ sourceAsOf: iso(NOW_MS - CSV_TTL_MS - 1) })
      persistCsvImportTransaction(payload, NOW_MS - DAY_MS)
      const before = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
      const beforeResult = [restoreCsvImportedAt(NOW_MS), restoreCsvSyncSummary(NOW_MS)]

      persistCsvImportTransaction(payload, NOW_MS)
      const after = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
      expect([restoreCsvImportedAt(NOW_MS), restoreCsvSyncSummary(NOW_MS)]).toEqual(beforeResult)
      expect(after.manifest.savedAt).not.toBe(before.manifest.savedAt)
      expect(after.payload.csvImportedAt).toBe(before.payload.csvImportedAt)
      expect(after.payload.provenance).toEqual(before.payload.provenance)
    })

    it('snapshot transfer savedAt cannot refresh old source metadata and keeps summary null', () => {
      const payload = canonicalPayload({
        origin: 'snapshot',
        sourceAsOf: iso(NOW_MS - CSV_TTL_MS - 1),
      })
      persistCsvImportTransaction(payload, NOW_MS - DAY_MS)
      const beforeResult = [restoreCsvImportedAt(NOW_MS), restoreCsvSyncSummary(NOW_MS)]

      persistCsvImportTransaction(payload, NOW_MS)
      expect([restoreCsvImportedAt(NOW_MS), restoreCsvSyncSummary(NOW_MS)]).toEqual(beforeResult)
      expect(beforeResult).toEqual([null, null])
      expect(JSON.parse(storage[CSV_IMPORT_GENERATION_KEY]).payload.syncSummary).toBeNull()
    })

    it.each(['weak', 'unknown'] as const)('%s sourceAsOf uses immutable importedAt fallback', confidence => {
      const importedAt = iso(NOW_MS - CSV_TTL_MS)
      const payload = canonicalPayload({
        importedAt,
        sourceAsOf: confidence === 'weak' ? iso(NOW_MS + DAY_MS) : null,
        confidence,
      })
      persistCsvImportTransaction(payload, NOW_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBe(importedAt)
      expect(restoreCsvSyncSummary(NOW_MS)).toEqual(payload.syncSummary)
    })

    it.each(['weak', 'unknown'] as const)('%s importedAt older than 90 days expires and resave cannot revive it', confidence => {
      const importedAt = iso(NOW_MS - CSV_TTL_MS - 1)
      const payload = canonicalPayload({
        importedAt,
        sourceAsOf: confidence === 'weak' ? iso(NOW_MS) : null,
        confidence,
      })
      persistCsvImportTransaction(payload, NOW_MS - DAY_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
      persistCsvImportTransaction(payload, NOW_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
    })

    it('future importedAt and a generation with no CSV timestamps fail closed', () => {
      persistCsvImportTransaction(canonicalPayload({
        importedAt: iso(NOW_MS + 1),
        sourceAsOf: null,
        confidence: 'unknown',
      }), NOW_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()

      persistCsvImportTransaction(canonicalPayload({
        origin: 'snapshot', importedAt: null, sourceAsOf: null, confidence: 'unknown',
      }), NOW_MS)
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
    })

    it('malformed canonical sourceAsOf remains schema-invalid and fails closed', () => {
      const importedAt = iso(NOW_MS - DAY_MS)
      const invalidProvenance = provenance(importedAt, iso(NOW_MS - DAY_MS), 'authoritative') as any
      invalidProvenance.sourceAsOf = '2026-02-30T00:00:00Z'
      const invalidPayload = {
        holdings: [], trust: [], learning: null, importedAt,
        syncSummary: summary(importedAt),
        trustShortSnapshot: { date: '2026-07-19', total: 0, evalById: {} },
        provenance: invalidProvenance,
      }
      const serializedPayload = JSON.stringify(invalidPayload)
      storage[CSV_IMPORT_GENERATION_KEY] = JSON.stringify({
        manifest: {
          schemaVersion: 'csv-import-generation-2', generationId: 'malformed-source',
          savedAt: NOW_MS, committed: true, payloadChecksum: checksum(serializedPayload),
        },
        payload: invalidPayload,
      })
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
    })
  })

  describe('legacy importedAt and summary matrix', () => {
    it.each([
      ['exact 90d', NOW_MS - CSV_TTL_MS, true],
      ['90d + 1ms', NOW_MS - CSV_TTL_MS - 1, false],
      ['future', NOW_MS + 1, false],
    ] as const)('legacy CsvSnapshot.at %s is the reference, not wrapper savedAt', (_label, atMs, expected) => {
      storage[CSV_IMPORTED_AT_KEY] = JSON.stringify({ at: iso(atMs), savedAt: NOW_MS })
      expect(restoreCsvImportedAt(NOW_MS)).toBe(expected ? iso(atMs) : null)
      expect(storage[CSV_IMPORTED_AT_KEY] === undefined).toBe(!expected && atMs < NOW_MS)
    })

    it('legacy importedAt malformed value fails closed without using wrapper savedAt', () => {
      storage[CSV_IMPORTED_AT_KEY] = JSON.stringify({ at: 'not-a-timestamp', savedAt: NOW_MS })
      expect(restoreCsvImportedAt(NOW_MS)).toBeNull()
    })

    it('legacy summary uses summary.importedAt and removes only stale valid metadata', () => {
      const stale = summary(iso(NOW_MS - CSV_TTL_MS - 1))
      storage[CSV_SYNC_SUMMARY_KEY] = JSON.stringify({ data: stale, savedAt: NOW_MS })
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
      expect(storage[CSV_SYNC_SUMMARY_KEY]).toBeUndefined()

      const boundary = summary(iso(NOW_MS - CSV_TTL_MS))
      storage[CSV_SYNC_SUMMARY_KEY] = JSON.stringify({ data: boundary, savedAt: 1 })
      expect(restoreCsvSyncSummary(NOW_MS)).toEqual(boundary)
    })

    it.each([
      ['future', summary(iso(NOW_MS + 1))],
      ['malformed importedAt', { ...summary(iso(NOW_MS)), importedAt: '2026-02-30T00:00:00Z' }],
      ['malformed summary shape', { importedAt: iso(NOW_MS) }],
    ])('legacy summary %s fails closed', (_label, data) => {
      storage[CSV_SYNC_SUMMARY_KEY] = JSON.stringify({ data, savedAt: NOW_MS })
      expect(restoreCsvSyncSummary(NOW_MS)).toBeNull()
    })
  })
})
