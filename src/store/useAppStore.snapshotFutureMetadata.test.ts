import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'

const directCounters = vi.hoisted(() => ({ analysis: 0, tracker: 0 }))

vi.mock('../domain/analysis/computeAnalysis', async importOriginal => {
  const actual = await importOriginal<typeof import('../domain/analysis/computeAnalysis')>()
  return {
    ...actual,
    computeAnalysis: (...args: Parameters<typeof actual.computeAnalysis>) => {
      directCounters.analysis += 1
      return actual.computeAnalysis(...args)
    },
  }
})

vi.mock('../domain/learning/trustShortTracker', async importOriginal => {
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

import { CSV_IMPORT_GENERATION_KEY } from './persist'
import { useAppStore } from './useAppStore'

const NOW_MS = Date.parse('2026-07-19T00:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()
const FUTURE_ISO = new Date(NOW_MS + 1).toISOString()
const PAST_ISO = new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString()

const baselineState = useAppStore.getState()

function provenance(overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    importedAt: NOW_ISO,
    sourceAsOf: NOW_ISO,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${'a'.repeat(64)}`,
    contentFingerprint: 'fnv1a32:aaaaaaaa',
    sourceFileName: 'snapshot.csv',
    fileLastModified: null,
    ...overrides,
  }
}

function snapshotRaw(input: {
  csvImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
  code?: string
}): string {
  const payload = {
    schemaVersion: 'portfolio-snapshot-3',
    // exportedAt is deliberately future: it is not CSV metadata or freshness authority.
    exportedAt: '2099-12-31T23:59:59.000Z',
    csvImportedAt: input.csvImportedAt,
    csvImportProvenance: input.csvImportProvenance,
    source: 'manual',
    holdings: [{
      code: input.code ?? 'RA005-FUTURE',
      name: 'RA-005 future metadata fixture',
      eval: 100_000,
      pnlPct: 0,
    }],
    trust: [],
    portfolioPolicy: null,
    cashAssumptions: null,
    snapshotGenerationIdentity: '',
  }
  payload.snapshotGenerationIdentity = computeSnapshotGenerationIdentity({
    holdings: payload.holdings,
    trust: payload.trust,
    portfolioPolicy: payload.portfolioPolicy,
    cashAssumptions: payload.cashAssumptions,
    csvImportedAt: payload.csvImportedAt,
    csvImportProvenance: payload.csvImportProvenance,
  })
  return JSON.stringify(payload)
}

describe('RA-005-REAUDIT-FIX: public snapshot future metadata boundary', () => {
  const storage: Record<string, string> = {}
  const storageCounts = {
    canonical: { get: 0, set: 0, remove: 0 },
    legacy: { get: 0, set: 0, remove: 0 },
  }

  function resetStorageCounts() {
    for (const group of Object.values(storageCounts)) {
      group.get = 0
      group.set = 0
      group.remove = 0
    }
  }

  function resetStore() {
    useAppStore.setState(state => ({
      holdings: [],
      trust: [],
      learning: null,
      correlation: null,
      market: baselineState.market,
      safeMode: baselineState.safeMode,
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      candidatesNews: baselineState.candidatesNews,
      candidatesStocks: baselineState.candidatesStocks,
      regimeState: baselineState.regimeState,
      universe: null,
      zeroPlan: null,
      stockPlan: null,
      trustPlan: null,
      stockCandidates: [],
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
  }

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key]
    resetStorageCounts()
    directCounters.analysis = 0
    directCounters.tracker = 0
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        const group = key === CSV_IMPORT_GENERATION_KEY ? storageCounts.canonical : storageCounts.legacy
        group.get += 1
        return storage[key] ?? null
      },
      setItem: (key: string, value: string) => {
        const group = key === CSV_IMPORT_GENERATION_KEY ? storageCounts.canonical : storageCounts.legacy
        group.set += 1
        storage[key] = value
      },
      removeItem: (key: string) => {
        const group = key === CSV_IMPORT_GENERATION_KEY ? storageCounts.canonical : storageCounts.legacy
        group.remove += 1
        delete storage[key]
      },
    })
    resetStore()
    resetStorageCounts()
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const futureCases = [
    {
      label: 'csvImportedAt is analysisNow + 1ms',
      raw: () => snapshotRaw({ csvImportedAt: FUTURE_ISO, csvImportProvenance: null }),
      expectedError: 'snapshotのCSV取込操作時刻が現在時刻より未来または不正なため、取込を中断しました。',
    },
    {
      label: 'provenance.importedAt is analysisNow + 1ms',
      raw: () => snapshotRaw({
        csvImportedAt: FUTURE_ISO,
        csvImportProvenance: provenance({ importedAt: FUTURE_ISO }),
      }),
      expectedError: 'snapshotのCSV取込操作時刻が現在時刻より未来または不正なため、取込を中断しました。',
    },
    {
      label: 'authoritative provenance.sourceAsOf is analysisNow + 1ms',
      raw: () => snapshotRaw({
        csvImportedAt: NOW_ISO,
        csvImportProvenance: provenance({ sourceAsOf: FUTURE_ISO }),
      }),
      expectedError: 'snapshotのCSV provenanceに現在時刻より未来または不正な日時が含まれるため、取込を中断しました。',
    },
  ]

  it.each(futureCases)('$label rejects before every observable side effect and permits a valid retry', ({ raw, expectedError }) => {
    const before = useAppStore.getState()
    const beforeRefs = {
      holdings: before.holdings,
      trust: before.trust,
      policy: before.portfolioPolicy,
      cash: before.cashAssumptions,
    }
    let subscriberCount = 0
    const unsubscribe = useAppStore.subscribe(() => { subscriberCount += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(raw())
    unsubscribe()

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_SNAPSHOT_PROVENANCE',
      error: expectedError,
    })
    expect(storageCounts).toEqual({
      canonical: { get: 0, set: 0, remove: 0 },
      legacy: { get: 0, set: 0, remove: 0 },
    })
    expect(directCounters).toEqual({ analysis: 0, tracker: 0 })
    expect(subscriberCount).toBe(0)
    expect(useAppStore.getState()).toBe(before)
    expect(useAppStore.getState().holdings).toBe(beforeRefs.holdings)
    expect(useAppStore.getState().trust).toBe(beforeRefs.trust)
    expect(useAppStore.getState().portfolioPolicy).toBe(beforeRefs.policy)
    expect(useAppStore.getState().cashAssumptions).toBe(beforeRefs.cash)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    expect(useAppStore.getState().system.csvImportProvenance).toBeNull()
    expect(useAppStore.getState().system.csvSyncSummary).toBeNull()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()

    const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw({
      csvImportedAt: NOW_ISO,
      csvImportProvenance: provenance(),
      code: 'RA005-RETRY',
    }))
    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(directCounters.analysis).toBeGreaterThan(0)
    expect(directCounters.tracker).toBeGreaterThan(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeDefined()
  })

  it.each([
    ['exact analysisNow', NOW_ISO, provenance()],
    ['stale past metadata', PAST_ISO, provenance({ importedAt: PAST_ISO, sourceAsOf: PAST_ISO })],
    ['null metadata', null, null],
  ] as const)('%s reaches the normal empty-target policy', (_label, csvImportedAt, csvImportProvenance) => {
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotRaw({
      csvImportedAt,
      csvImportProvenance,
      code: `RA005-${_label}`,
    }))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBe(csvImportedAt)
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(csvImportProvenance)
  })

  it('actual future snapshot E2E has zero immediate exposure and remains clean through refresh/initialize before valid retry state', async () => {
    const futureRaw = snapshotRaw({
      csvImportedAt: NOW_ISO,
      csvImportProvenance: provenance({ sourceAsOf: FUTURE_ISO }),
      code: 'RA005-E2E-FUTURE',
    })
    let subscriberCount = 0
    const unsubscribe = useAppStore.subscribe(() => { subscriberCount += 1 })

    const rejected = useAppStore.getState().importPortfolioSnapshot(futureRaw)
    unsubscribe()

    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE' })
    expect(storageCounts.canonical.set).toBe(0)
    expect(subscriberCount).toBe(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect([
      useAppStore.getState().system.csvLastImportedAt,
      useAppStore.getState().system.csvImportProvenance,
      useAppStore.getState().system.csvSyncSummary,
    ]).not.toContain(FUTURE_ISO)

    const validRetry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw({
      csvImportedAt: NOW_ISO,
      csvImportProvenance: provenance(),
      code: 'RA005-E2E-VALID',
    }))
    expect(validRetry).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain(FUTURE_ISO)

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    })))
    await useAppStore.getState().refreshAllData()
    await useAppStore.getState().initialize()

    const t9Inputs = {
      csvLastImportedAt: useAppStore.getState().system.csvLastImportedAt,
      csvImportProvenance: useAppStore.getState().system.csvImportProvenance,
      csvSyncSummary: useAppStore.getState().system.csvSyncSummary,
    }
    expect(JSON.stringify(t9Inputs)).not.toContain(FUTURE_ISO)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain(FUTURE_ISO)
  })
})
