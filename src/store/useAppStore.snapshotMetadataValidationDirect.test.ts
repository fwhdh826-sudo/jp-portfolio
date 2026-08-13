import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'

beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { CsvImportProvenance } from '../types'
import type { PortfolioSnapshotData } from '../utils/portfolioSnapshotTransfer'

const NOW_MS = Date.parse('2026-07-19T00:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()
const FUTURE_ISO = new Date(NOW_MS + 1).toISOString()
const PROVENANCE_ERROR =
  'snapshotのCSV provenanceに現在時刻より未来または不正な日時が含まれるため、取込を中断しました。'
const CSV_IMPORTED_AT_ERROR =
  'snapshotのCSV取込操作時刻が現在時刻より未来または不正なため、取込を中断しました。'

function provenance(importedAt: string): CsvImportProvenance {
  return {
    importedAt,
    sourceAsOf: NOW_ISO,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    contentFingerprint: 'fnv1a32:aaaaaaaa',
    semanticIdentity: `sha256:${'a'.repeat(64)}`,
    sourceFileName: 'portfolio.csv',
    fileLastModified: null,
  }
}

function parsedSnapshot(input: {
  importedAt: string
  code: string
}): PortfolioSnapshotData {
  return {
    schemaVersion: 'portfolio-snapshot-3',
    exportedAt: NOW_ISO,
    csvImportedAt: NOW_ISO,
    csvImportProvenance: provenance(input.importedAt),
    snapshotGenerationIdentity: `sha256:${'b'.repeat(64)}`,
    holdings: [{
      code: input.code,
      name: 'RA-005 direct metadata validation fixture',
      eval: 100_000,
      pnlPct: 0,
    }],
    trust: [],
    portfolioPolicy: null,
    cashAssumptions: null,
  }
}

async function loadIsolatedHarness(rejectedSnapshot: PortfolioSnapshotData) {
  vi.resetModules()

  const validSnapshot = parsedSnapshot({ importedAt: NOW_ISO, code: 'RA005-VALID-RETRY' })
  const parseMock = vi.fn()
    .mockReturnValueOnce({ ok: true as const, data: rejectedSnapshot })
    .mockReturnValueOnce({ ok: true as const, data: validSnapshot })
  const directCounters = { analysis: 0, tracker: 0 }

  vi.doMock('../utils/portfolioSnapshotTransfer', async importOriginal => {
    const actual = await importOriginal<typeof import('../utils/portfolioSnapshotTransfer')>()
    return { ...actual, parsePortfolioSnapshotImport: parseMock }
  })
  vi.doMock('../domain/analysis/computeAnalysis', async importOriginal => {
    const actual = await importOriginal<typeof import('../domain/analysis/computeAnalysis')>()
    return {
      ...actual,
      computeAnalysis: (...args: Parameters<typeof actual.computeAnalysis>) => {
        directCounters.analysis += 1
        return actual.computeAnalysis(...args)
      },
    }
  })
  vi.doMock('../domain/learning/trustShortTracker', async importOriginal => {
    const actual = await importOriginal<typeof import('../domain/learning/trustShortTracker')>()
    return {
      ...actual,
      stageTrustExecutionFromCsvSync: (
        ...args: Parameters<typeof actual.stageTrustExecutionFromCsvSync>
      ) => {
        directCounters.tracker += 1
        return actual.stageTrustExecutionFromCsvSync(...args)
      },
    }
  })

  const { CSV_IMPORT_GENERATION_KEY } = await import('./persist')
  const storage: Record<string, string> = {}
  const storageCounts = {
    canonical: { get: 0, set: 0, remove: 0 },
    legacy: { get: 0, set: 0, remove: 0 },
  }
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      const group = key === CSV_IMPORT_GENERATION_KEY
        ? storageCounts.canonical
        : storageCounts.legacy
      group.get += 1
      return storage[key] ?? null
    },
    setItem: (key: string, value: string) => {
      const group = key === CSV_IMPORT_GENERATION_KEY
        ? storageCounts.canonical
        : storageCounts.legacy
      group.set += 1
      storage[key] = value
    },
    removeItem: (key: string) => {
      const group = key === CSV_IMPORT_GENERATION_KEY
        ? storageCounts.canonical
        : storageCounts.legacy
      group.remove += 1
      delete storage[key]
    },
  })

  const { useAppStore, setPortfolioGenerationLockAdapterForTest } = await import('./useAppStore')
  const { createImmediatePortfolioGenerationLockAdapterForTest } =
    await import('./testing/portfolioGenerationLockTestAdapters')
  setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest())
  useAppStore.setState(state => ({
    holdings: [],
    trust: [],
    learning: null,
    correlation: null,
    portfolioPolicy: { jpStockMaxRatio: 0.1 },
    cashAssumptions: {
      source: 'DEFAULT',
      grossCash: 0,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: null,
    },
    analysis: [],
    metrics: null,
    officialDecision: null,
    system: {
      ...state.system,
      status: 'idle',
      error: null,
      csvLastImportedAt: null,
      csvImportProvenance: null,
      csvSyncSummary: null,
    },
  }))
  directCounters.analysis = 0
  directCounters.tracker = 0
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)

  return {
    CSV_IMPORT_GENERATION_KEY,
    directCounters,
    parseMock,
    storage,
    storageCounts,
    useAppStore,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../utils/portfolioSnapshotTransfer')
  vi.doUnmock('../domain/analysis/computeAnalysis')
  vi.doUnmock('../domain/learning/trustShortTracker')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RA-005-FINAL-AUDIT-FIX: field-isolated provenance timestamp validation', () => {
  it.each([
    {
      label: 'future provenance.importedAt',
      importedAt: FUTURE_ISO,
      raw: 'future-provenance-imported-at',
    },
    {
      label: 'malformed provenance.importedAt',
      importedAt: 'not-a-timestamp',
      raw: 'malformed-provenance-imported-at',
    },
  ])('$label is rejected by the provenance validator with zero side effects and releases the coordinator', async ({
    importedAt,
    raw,
  }) => {
    const harness = await loadIsolatedHarness(parsedSnapshot({
      importedAt,
      code: 'RA005-REJECTED',
    }))
    const before = harness.useAppStore.getState()
    const beforeRefs = {
      holdings: before.holdings,
      trust: before.trust,
      policy: before.portfolioPolicy,
      cash: before.cashAssumptions,
      system: before.system,
    }
    const observedStates: typeof before[] = []
    const unsubscribe = harness.useAppStore.subscribe(state => observedStates.push(state))

    const rejected = await harness.useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    expect(harness.parseMock).toHaveBeenNthCalledWith(1, raw)
    expect(rejected).toEqual({
      ok: false,
      code: 'INVALID_SNAPSHOT_PROVENANCE',
      error: PROVENANCE_ERROR,
    })
    if (rejected.ok) throw new Error('expected provenance rejection')
    expect('error' in rejected ? rejected.error : null).not.toBe(CSV_IMPORTED_AT_ERROR)
    expect(harness.storageCounts).toEqual({
      canonical: { get: 0, set: 0, remove: 0 },
      legacy: { get: 0, set: 0, remove: 0 },
    })
    expect(harness.directCounters).toEqual({ analysis: 0, tracker: 0 })
    expect(observedStates).toEqual([])

    const after = harness.useAppStore.getState()
    expect(after).toBe(before)
    expect(after.holdings).toBe(beforeRefs.holdings)
    expect(after.trust).toBe(beforeRefs.trust)
    expect(after.portfolioPolicy).toBe(beforeRefs.policy)
    expect(after.cashAssumptions).toBe(beforeRefs.cash)
    expect(after.system).toBe(beforeRefs.system)
    expect(after.system.csvLastImportedAt).toBeNull()
    expect(after.system.csvImportProvenance).toBeNull()
    expect(after.system.csvSyncSummary).toBeNull()
    expect(harness.storage[harness.CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(Object.values(harness.storage).join('')).not.toContain(importedAt)
    expect(JSON.stringify({
      csvLastImportedAt: after.system.csvLastImportedAt,
      csvImportProvenance: after.system.csvImportProvenance,
      csvSyncSummary: after.system.csvSyncSummary,
    })).not.toContain(importedAt)

    const retry = await harness.useAppStore.getState().importPortfolioSnapshot('valid-retry')
    expect(harness.parseMock).toHaveBeenNthCalledWith(2, 'valid-retry')
    expect(retry).not.toMatchObject({ code: 'LOCAL_OPERATION_BUSY' })
    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(harness.directCounters.analysis).toBeGreaterThan(0)
    expect(harness.directCounters.tracker).toBeGreaterThan(0)
    expect(harness.storage[harness.CSV_IMPORT_GENERATION_KEY]).toBeDefined()
  })
})
