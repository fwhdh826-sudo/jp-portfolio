import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadProbe = vi.hoisted(() => ({
  calls: 0,
  implementation: null as null | (() => Promise<unknown>),
}))

const analysisProbe = vi.hoisted(() => ({ calls: 0, throwNext: false }))

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async () => {
      loadProbe.calls += 1
      if (loadProbe.implementation) return loadProbe.implementation()
      return actual.refreshAllData({ bustCache: true })
    },
  }
})

vi.mock('../domain/analysis/computeAnalysis', async importOriginal => {
  const actual = await importOriginal<typeof import('../domain/analysis/computeAnalysis')>()
  return {
    ...actual,
    computeAnalysis: (...args: Parameters<typeof actual.computeAnalysis>) => {
      analysisProbe.calls += 1
      if (analysisProbe.throwNext) {
        analysisProbe.throwNext = false
        throw new Error('injected analysis failure')
      }
      return actual.computeAnalysis(...args)
    },
  }
})

import type { CsvImportProvenance } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import {
  DEFAULT_CANDIDATES_NEWS_DATA,
  DEFAULT_CANDIDATES_STOCKS_DATA,
  DEFAULT_REGIME_STATE,
  DEFAULT_SAFE_MODE_SNAPSHOT,
  DEFAULT_TIER_A_ALERTS_SNAPSHOT,
  DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
} from '../services/loadStaticData'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'
import {
  acquirePortfolioOperation,
  releasePortfolioOperation,
  useAppStore,
  type PortfolioOperationTicket,
} from './useAppStore'

type OperationName = 'initialize' | 'refresh' | 'csv' | 'snapshot'
type ActionResult = void | Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> |
  ReturnType<ReturnType<typeof useAppStore.getState>['importPortfolioSnapshot']>

const FIXED_NOW = new Date('2026-07-19T03:00:00.000Z')
const CANONICAL_KEY = 'v13_csv_import_committed_generation'
const TRACKER_KEY = 'v95_trust_short_tracker'

const VALID_CSV = [
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  'テスト投信,10000,250000,5.00,0.10,',
].join('\n')

let fileReadStarts = 0
class CountingFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    fileReadStarts += 1
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const storage: Record<string, string> = {}
const storageCounts = {
  get: 0,
  set: 0,
  remove: 0,
  setByKey: {} as Record<string, number>,
  removeByKey: {} as Record<string, number>,
}
let storageSetHook: ((key: string, value: string) => void) | null = null
let storageThrowOnSet = false

const localStorageMock = {
  getItem: (key: string) => {
    storageCounts.get += 1
    return storage[key] ?? null
  },
  setItem: (key: string, value: string) => {
    storageCounts.set += 1
    storageCounts.setByKey[key] = (storageCounts.setByKey[key] ?? 0) + 1
    if (storageThrowOnSet) throw new Error('injected persistence failure')
    storage[key] = value
    storageSetHook?.(key, value)
  },
  removeItem: (key: string) => {
    storageCounts.remove += 1
    storageCounts.removeByKey[key] = (storageCounts.removeByKey[key] ?? 0) + 1
    delete storage[key]
  },
}

let fetchStarts = 0
let fetchImplementation: (input: RequestInfo | URL) => Promise<Response>

const baseMarket = useAppStore.getState().market
const baseState = useAppStore.getState()
let snapshotSequence = 0
let notifications = 0
let unsubscribeNotifications: (() => void) | null = null
const cleanupTickets: PortfolioOperationTicket[] = []

function publishedData() {
  return {
    market: { data: baseMarket, source: 'static' },
    correlation: { data: null, source: 'static' },
    news: { data: null, source: 'none' },
    trust: { data: null, source: 'static', lastUpdated: null },
    holdingsSnapshot: { data: null, source: 'none', lastUpdated: null },
    macro: { data: null, source: 'none' },
    nikkeiVI: { data: null, source: 'none' },
    sq: { data: null, source: 'none' },
    margin: { data: null, source: 'none' },
    flows: { data: null, source: 'none' },
    candidatesNews: { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' },
    candidatesStocks: { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'default' },
    regimeState: { data: DEFAULT_REGIME_STATE, source: 'default', generatedAt: null },
    safeMode: { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'default', lastChecked: null },
    tierAViolations: { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'default', generatedAt: null },
    tierAAlerts: { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'default', generatedAt: null },
  }
}

function resetStore() {
  useAppStore.setState({
    ...baseState,
    holdings: [],
    trust: [],
    correlation: null,
    market: baseMarket,
    safeMode: DEFAULT_SAFE_MODE_SNAPSHOT,
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    candidatesNews: DEFAULT_CANDIDATES_NEWS_DATA,
    candidatesStocks: DEFAULT_CANDIDATES_STOCKS_DATA,
    regimeState: DEFAULT_REGIME_STATE,
    learning: null,
    universe: null,
    zeroPlan: null,
    stockPlan: null,
    trustPlan: null,
    stockCandidates: [],
    analysis: [],
    metrics: null,
    officialDecision: null,
    system: {
      ...baseState.system,
      status: 'idle',
      error: null,
      csvLastImportedAt: null,
      csvImportProvenance: null,
      csvSyncSummary: null,
      analysisLastRunAt: null,
    },
  })
}

function resetCounters() {
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  storageCounts.setByKey = {}
  storageCounts.removeByKey = {}
  fetchStarts = 0
  fileReadStarts = 0
  analysisProbe.calls = 0
  loadProbe.calls = 0
  notifications = 0
}

function csvFile(content = VALID_CSV): File {
  return new File([content], 'portfolio.csv', { type: 'text/csv' })
}

function provenance(sequence: number): CsvImportProvenance {
  const hex = sequence.toString(16)
  return {
    importedAt: '2026-07-19T02:00:00.000Z',
    sourceAsOf: '2026-07-19T01:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${hex.padStart(64, '0')}`,
    contentFingerprint: `fnv1a32:${hex.padStart(8, '0')}`,
    sourceFileName: `snapshot-${sequence}.csv`,
    fileLastModified: '2026-07-19T01:30:00.000Z',
  }
}

function snapshotRaw(overrides: Record<string, unknown> = {}): string {
  snapshotSequence += 1
  const csvImportProvenance = provenance(snapshotSequence)
  const payload: Record<string, unknown> = {
    schemaVersion: 'portfolio-snapshot-3',
    exportedAt: '2026-07-19T02:30:00.000Z',
    csvImportedAt: csvImportProvenance.importedAt,
    csvImportProvenance,
    source: 'manual',
    holdings: [{ code: `SNAP-${snapshotSequence}`, name: 'snapshot銘柄', eval: 100_000, pnlPct: 0 }],
    trust: [],
    portfolioPolicy: null,
    cashAssumptions: null,
    ...overrides,
  }
  payload.snapshotGenerationIdentity = computeSnapshotGenerationIdentity({
    holdings: payload.holdings as never[],
    trust: payload.trust as never[],
    portfolioPolicy: payload.portfolioPolicy as null,
    cashAssumptions: payload.cashAssumptions as null,
    csvImportedAt: payload.csvImportedAt as string,
    csvImportProvenance: payload.csvImportProvenance as CsvImportProvenance,
  })
  return JSON.stringify(payload)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function sideEffectSnapshot() {
  return {
    storageGet: storageCounts.get,
    storageSet: storageCounts.set,
    storageRemove: storageCounts.remove,
    canonicalWrite: storageCounts.setByKey[CANONICAL_KEY] ?? 0,
    trackerWrite: storageCounts.setByKey[TRACKER_KEY] ?? 0,
    setByKey: { ...storageCounts.setByKey },
    removeByKey: { ...storageCounts.removeByKey },
    notifications,
    fetchStarts,
    fileReadStarts,
    analysisCalls: analysisProbe.calls,
    storeIdentity: useAppStore.getState(),
  }
}

async function invokeOperation(operation: OperationName): Promise<ActionResult> {
  if (operation === 'initialize') return useAppStore.getState().initialize()
  if (operation === 'refresh') return useAppStore.getState().refreshAllData()
  if (operation === 'csv') return useAppStore.getState().importCsv(csvFile())
  return useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
}

function assertBlockedResult(operation: OperationName, result: ActionResult) {
  if (operation === 'initialize' || operation === 'refresh') {
    expect(result).toBeUndefined()
  } else if (operation === 'csv') {
    expect(result).toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })
  } else {
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_IMPORT_BLOCKED' })
  }
}

async function startPendingOperation(operation: Exclude<OperationName, 'snapshot'>) {
  if (operation === 'initialize' || operation === 'refresh') {
    const gate = deferred<unknown>()
    loadProbe.implementation = () => gate.promise
    const promise = invokeOperation(operation)
    await Promise.resolve()
    return {
      finish: async () => {
        gate.resolve(publishedData())
        await promise
      },
    }
  }

  const gate = deferred<ArrayBuffer>()
  const file = {
    name: 'pending.csv',
    arrayBuffer: () => gate.promise,
  } as File
  const promise = useAppStore.getState().importCsv(file)
  await Promise.resolve()
  return {
    finish: async () => {
      gate.resolve(new TextEncoder().encode(VALID_CSV).buffer)
      await promise
    },
  }
}

beforeEach(() => {
  const lockProbe = acquirePortfolioOperation('initialize')
  if (lockProbe === null) throw new Error('operation coordinator leaked from a previous test')
  expect(releasePortfolioOperation(lockProbe)).toBe(true)

  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  vi.stubGlobal('FileReader', CountingFileReader)
  vi.stubGlobal('localStorage', localStorageMock)
  fetchImplementation = async () => { throw new Error('fetch unavailable in coordinator test') }
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    fetchStarts += 1
    return fetchImplementation(input)
  })

  Object.keys(storage).forEach(key => delete storage[key])
  storageSetHook = null
  storageThrowOnSet = false
  analysisProbe.throwNext = false
  loadProbe.implementation = async () => publishedData()
  resetStore()
  resetCounters()
  unsubscribeNotifications = useAppStore.subscribe(() => { notifications += 1 })
})

afterEach(() => {
  unsubscribeNotifications?.()
  unsubscribeNotifications = null
  for (const ticket of cleanupTickets.splice(0)) releasePortfolioOperation(ticket)
  const probe = acquirePortfolioOperation('initialize')
  expect(probe, 'operation coordinator must be released after every test').not.toBeNull()
  if (probe) expect(releasePortfolioOperation(probe)).toBe(true)
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('RA-003 Phase A: operation coordinator unit contract', () => {
  it('inactive acquire returns a Symbol token and preserves kind', () => {
    const ticket = acquirePortfolioOperation('initialize')
    expect(ticket).not.toBeNull()
    if (!ticket) return
    cleanupTickets.push(ticket)
    expect(typeof ticket.token).toBe('symbol')
    expect(ticket.kind).toBe('initialize')
  })

  it('same-kind second acquire is rejected without a queue', () => {
    const owner = acquirePortfolioOperation('csv')!
    cleanupTickets.push(owner)
    expect(acquirePortfolioOperation('csv')).toBeNull()
  })

  it('different-kind second acquire is rejected', () => {
    const owner = acquirePortfolioOperation('initialize')!
    cleanupTickets.push(owner)
    expect(acquirePortfolioOperation('snapshot')).toBeNull()
  })

  it('non-owner release is false and cannot unlock the owner', () => {
    const owner = acquirePortfolioOperation('refresh')!
    cleanupTickets.push(owner)
    const fake = { token: Symbol('fake'), kind: 'refresh' } as PortfolioOperationTicket
    expect(releasePortfolioOperation(fake)).toBe(false)
    expect(acquirePortfolioOperation('csv')).toBeNull()
  })

  it('a copied ticket with the owner token is still not the owner object', () => {
    const owner = acquirePortfolioOperation('snapshot')!
    cleanupTickets.push(owner)
    const copied = { token: owner.token, kind: owner.kind }
    expect(releasePortfolioOperation(copied)).toBe(false)
    expect(acquirePortfolioOperation('initialize')).toBeNull()
  })

  it('owner release succeeds and permits reacquire', () => {
    const owner = acquirePortfolioOperation('refresh')!
    expect(releasePortfolioOperation(owner)).toBe(true)
    const next = acquirePortfolioOperation('csv')!
    cleanupTickets.push(next)
    expect(next.token).not.toBe(owner.token)
  })

  it('double release of the same ticket is false', () => {
    const owner = acquirePortfolioOperation('csv')!
    expect(releasePortfolioOperation(owner)).toBe(true)
    expect(releasePortfolioOperation(owner)).toBe(false)
  })

  it('release itself does not notify Zustand or write storage/tracker', () => {
    const owner = acquirePortfolioOperation('initialize')!
    const before = sideEffectSnapshot()
    expect(releasePortfolioOperation(owner)).toBe(true)
    expect(sideEffectSnapshot()).toEqual(before)
  })
})

describe('RA-003 Phase B: direct 16-operation exclusion matrix', () => {
  const operations: OperationName[] = ['initialize', 'refresh', 'csv', 'snapshot']

  for (const first of operations) {
    for (const second of operations) {
      it(`${first} in-flight -> ${second} fail-fast with blocked side effect 0`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        if (first !== 'snapshot') {
          const pending = await startPendingOperation(first)
          const before = sideEffectSnapshot()
          const result = await invokeOperation(second)
          const after = sideEffectSnapshot()

          assertBlockedResult(second, result)
          expect(after).toEqual(before)
          expect(warn).toHaveBeenCalledTimes(second === 'initialize' || second === 'refresh' || second === 'snapshot' ? 1 : 0)
          await pending.finish()
          return
        }

        let nestedResult: ActionResult = undefined
        let before: ReturnType<typeof sideEffectSnapshot> | null = null
        let after: ReturnType<typeof sideEffectSnapshot> | null = null
        let nestedPromise: Promise<ActionResult> | null = null
        let fired = false
        const unsubscribe = useAppStore.subscribe(() => {
          if (fired) return
          fired = true
          before = sideEffectSnapshot()
          nestedPromise = invokeOperation(second)
          after = sideEffectSnapshot()
        })

        const outer = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
        unsubscribe()
        if (nestedPromise) nestedResult = await nestedPromise

        expect(outer).toMatchObject({ ok: true, code: 'SUCCESS' })
        assertBlockedResult(second, nestedResult)
        expect(after).toEqual(before)
        expect(warn).toHaveBeenCalledTimes(second === 'initialize' || second === 'refresh' || second === 'snapshot' ? 1 : 0)
      })
    }
  }
})

describe('RA-003 Phase C: key race regressions', () => {
  for (const first of ['initialize', 'refresh'] as const) {
    it(`${first} -> snapshot is blocked, then retry reaches normal snapshot policy`, async () => {
      const pending = await startPendingOperation(first)
      const before = sideEffectSnapshot()
      const blocked = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
      expect(blocked).toMatchObject({ ok: false, code: 'SNAPSHOT_IMPORT_BLOCKED' })
      expect(sideEffectSnapshot()).toEqual(before)

      await pending.finish()
      const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
      expect(retry.code).not.toBe('SNAPSHOT_IMPORT_BLOCKED')
    })

    it(`${first} lock survives system.status sentinel destruction for all four second operations`, async () => {
      const pending = await startPendingOperation(first)
      useAppStore.setState(state => ({ system: { ...state.system, status: 'error', error: 'sentinel changed' } }))
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const before = sideEffectSnapshot()

      const results: ActionResult[] = []
      for (const second of ['initialize', 'refresh', 'csv', 'snapshot'] as const) {
        results.push(await invokeOperation(second))
      }

      assertBlockedResult('initialize', results[0])
      assertBlockedResult('refresh', results[1])
      assertBlockedResult('csv', results[2])
      assertBlockedResult('snapshot', results[3])
      expect(sideEffectSnapshot()).toEqual(before)
      expect(warning).toHaveBeenCalledTimes(3)
      await pending.finish()
    })
  }

  it('one snapshot subscriber synchronously reenters all four operations without deadlock', async () => {
    const nested: Partial<Record<OperationName, Promise<ActionResult>>> = {}
    let fired = false
    const unsubscribe = useAppStore.subscribe(() => {
      if (fired) return
      fired = true
      for (const operation of ['initialize', 'refresh', 'csv', 'snapshot'] as const) {
        nested[operation] = invokeOperation(operation)
      }
    })

    const outer = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    unsubscribe()
    expect(outer).toMatchObject({ ok: true, code: 'SUCCESS' })
    for (const operation of ['initialize', 'refresh', 'csv', 'snapshot'] as const) {
      assertBlockedResult(operation, await nested[operation])
    }
  })
})

describe('RA-003 Phase D: failure releases owner and permits retry', () => {
  it.each([
    ['initialize fetch failure', 'initialize'],
    ['refresh fetch failure', 'refresh'],
  ] as const)('%s', async (_label, operation) => {
    loadProbe.implementation = async () => { throw new Error('injected fetch failure') }
    await invokeOperation(operation)
    expect(useAppStore.getState().system).toMatchObject({ status: 'error', error: 'injected fetch failure' })

    loadProbe.implementation = async () => publishedData()
    await invokeOperation(operation)
    expect(useAppStore.getState().system.status).not.toBe('loading')
  })

  it.each([
    ['initialize analysis throw', 'initialize'],
    ['refresh analysis throw', 'refresh'],
  ] as const)('%s', async (_label, operation) => {
    analysisProbe.throwNext = true
    await invokeOperation(operation)
    expect(useAppStore.getState().system).toMatchObject({ status: 'error', error: 'injected analysis failure' })
    await invokeOperation(operation)
    expect(useAppStore.getState().system.status).not.toBe('loading')
  })

  it.each([
    ['initialize persistence failure', 'initialize'],
    ['refresh persistence failure', 'refresh'],
  ] as const)('%s', async (_label, operation) => {
    storageThrowOnSet = true
    await invokeOperation(operation)
    storageThrowOnSet = false
    await invokeOperation(operation)
    expect(useAppStore.getState().system.status).not.toBe('loading')
  })

  it('CSV parse failure releases coordinator and retry is not IMPORT_IN_PROGRESS', async () => {
    const failure = await useAppStore.getState().importCsv(csvFile(''))
    expect(failure).toMatchObject({ ok: false, code: 'NO_VALID_ROWS' })
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.code).not.toBe('IMPORT_IN_PROGRESS')
  })

  it('CSV analysis failure releases coordinator and retry succeeds', async () => {
    analysisProbe.throwNext = true
    const failure = await useAppStore.getState().importCsv(csvFile())
    expect(failure).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.code).not.toBe('IMPORT_IN_PROGRESS')
  })

  it('CSV pre-persist CAS conflict keeps external bytes and releases coordinator', async () => {
    const gate = deferred<ArrayBuffer>()
    const pendingFile = { name: 'pending.csv', arrayBuffer: () => gate.promise } as File
    const promise = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    storage[CANONICAL_KEY] = 'third-party-bytes'
    gate.resolve(new TextEncoder().encode(VALID_CSV).buffer)
    const failure = await promise
    expect(failure).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(storage[CANONICAL_KEY]).toBe('third-party-bytes')

    delete storage[CANONICAL_KEY]
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.code).not.toBe('IMPORT_IN_PROGRESS')
  })

  it('CSV ownership loss preserves third-party bytes, releases coordinator, and permits retry', async () => {
    const externalRaw = 'third-party-csv-generation'
    let replaced = false
    storageSetHook = key => {
      if (key !== CANONICAL_KEY || replaced) return
      replaced = true
      storage[CANONICAL_KEY] = externalRaw
    }

    const failure = await useAppStore.getState().importCsv(csvFile())
    storageSetHook = null
    expect(replaced).toBe(true)
    expect(failure).toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      persistence: { status: 'ownership_lost' },
    })
    expect(storage[CANONICAL_KEY]).toBe(externalRaw)

    delete storage[CANONICAL_KEY]
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.code).not.toBe('IMPORT_IN_PROGRESS')
  })

  it('snapshot parse failure releases coordinator and retry reaches normal policy', () => {
    const failure = useAppStore.getState().importPortfolioSnapshot('not-json')
    expect(failure).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
    const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(retry.code).not.toBe('SNAPSHOT_IMPORT_BLOCKED')
  })

  it('snapshot analysis failure releases coordinator and retry succeeds', () => {
    analysisProbe.throwNext = true
    const failure = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(failure).toMatchObject({ ok: false, code: 'SNAPSHOT_ANALYSIS_ERROR' })
    const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(retry.code).not.toBe('SNAPSHOT_IMPORT_BLOCKED')
  })

  it('snapshot persistence failure releases coordinator and retry succeeds', () => {
    storageThrowOnSet = true
    const failure = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(failure).toMatchObject({ ok: false, code: 'SNAPSHOT_PERSISTENCE_ERROR' })
    storageThrowOnSet = false
    const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(retry.code).not.toBe('SNAPSHOT_IMPORT_BLOCKED')
  })

  it('snapshot ownership loss preserves third-party bytes, releases coordinator, and permits retry', () => {
    const externalRaw = 'third-party-snapshot-generation'
    let replaced = false
    storageSetHook = key => {
      if (key !== CANONICAL_KEY || replaced) return
      replaced = true
      storage[CANONICAL_KEY] = externalRaw
    }

    const failure = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    storageSetHook = null
    expect(replaced).toBe(true)
    expect(failure).toMatchObject({ ok: false, code: 'SNAPSHOT_OWNERSHIP_LOST' })
    expect(storage[CANONICAL_KEY]).toBe(externalRaw)

    delete storage[CANONICAL_KEY]
    const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(retry.code).not.toBe('SNAPSHOT_IMPORT_BLOCKED')
  })

  it('throwing subscriber cannot leak coordinator and retry reaches normal policy', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unsubscribe = useAppStore.subscribe(() => { throw new Error('subscriber throw') })
    const first = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    unsubscribe()
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(error).toHaveBeenCalled()
    const retry = useAppStore.getState().importPortfolioSnapshot(snapshotRaw())
    expect(retry.code).not.toBe('SNAPSHOT_IMPORT_BLOCKED')
  })

  it('non-owner release attempt cannot unlock an in-flight action', async () => {
    const pending = await startPendingOperation('refresh')
    const fake = { token: Symbol('attacker'), kind: 'refresh' } as PortfolioOperationTicket
    expect(releasePortfolioOperation(fake)).toBe(false)
    expect(await useAppStore.getState().importCsv(csvFile())).toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })
    await pending.finish()
    expect((await useAppStore.getState().importCsv(csvFile())).code).not.toBe('IMPORT_IN_PROGRESS')
  })
})
