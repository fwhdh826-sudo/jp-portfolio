import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const analysisProbe = vi.hoisted(() => ({ calls: 0, fail: false }))

vi.mock('../domain/analysis/computeAnalysis', async importOriginal => {
  const actual = await importOriginal<typeof import('../domain/analysis/computeAnalysis')>()
  return {
    ...actual,
    computeAnalysis: (...args: Parameters<typeof actual.computeAnalysis>) => {
      analysisProbe.calls += 1
      if (analysisProbe.fail) throw new Error('injected analysis failure')
      return actual.computeAnalysis(...args)
    },
  }
})

import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import type { CsvImportProvenance, CsvSyncSummary, Holding, Trust } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
  restorePortfolio,
  restoreTrust,
  restoreLearning,
} from './persist'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
  type PortfolioGenerationLockTimerApi,
} from './portfolioGenerationLock'
import {
  createPortfolioCoordinationFailure,
  type PortfolioGenerationOperation,
} from './portfolioOperationResult'
import { FakeLockManager } from './testing/fakeLockManager'
import {
  createAppStoreInstanceForTest,
  resetPortfolioGenerationLockAdapterForTest,
  setPortfolioGenerationLockAdapterForTest,
  type AppStoreState,
} from './useAppStore'

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()
const storage: Record<string, string> = {}
const storageCounts = { get: 0, set: 0, remove: 0 }
let onStorageSet: ((key: string) => void) | null = null

const TEST_HOLDING: Holding = {
  code: 'RA007C', name: 'RA-007-C holding', eval: 100_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const TEST_TRUST: Trust = {
  id: 'ra007c-fund', name: 'RA-007-C fund', abbr: 'RA7C', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 200_000, pnlPct: 0, dayPct: 0,
  cost: 0.2, mu: 0.1, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0,
  decision: 'HOLD',
}

const localStorageMock = {
  getItem(key: string) {
    storageCounts.get += 1
    return storage[key] ?? null
  },
  setItem(key: string, value: string) {
    storageCounts.set += 1
    onStorageSet?.(key)
    storage[key] = value
  },
  removeItem(key: string) {
    storageCounts.remove += 1
    delete storage[key]
  },
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function adapter(manager: FakeLockManager): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 60_000 })
}

function baselineStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [{ ...TEST_HOLDING }],
    trust: [{ ...TEST_TRUST }],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function immediateAdapter(onRequest: () => void = () => {}): PortfolioGenerationLockAdapter {
  return {
    async runExclusive<T>(
      _operation: PortfolioGenerationOperation,
      callback: () => T | Promise<T>,
    ) {
      onRequest()
      return { ok: true, value: await callback() }
    },
  }
}

function pair(manager = new FakeLockManager()) {
  const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  for (const instance of [a, b]) baselineStore(instance.store)
  return { manager, a, b }
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

function emptyStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
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

function snapshotWithHolding(): string {
  const source = createAppStoreInstanceForTest({
    portfolioGenerationLock: immediateAdapter(),
  })
  source.store.setState(state => ({
    holdings: [{ ...TEST_HOLDING, code: 'LOCK-SNAPSHOT', name: 'lock snapshot', eval: 456_789 }],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      csvLastImportedAt: null,
      csvImportProvenance: null,
      csvSyncSummary: null,
    },
  }))
  return source.store.getState().exportPortfolioSnapshot()
}

function provenance(importedAt = NOW_ISO): CsvImportProvenance {
  return {
    importedAt,
    sourceAsOf: importedAt,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    contentFingerprint: 'fnv1a32:12345678',
    semanticIdentity: `sha256:${'1'.repeat(64)}`,
    sourceFileName: 'lock.csv',
    fileLastModified: null,
  }
}

function syncSummary(importedAt = NOW_ISO): CsvSyncSummary {
  return {
    importedAt,
    stock: { updated: 1, added: 0, removed: 0 },
    trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
  }
}

function seedCanonical(
  state: AppStoreState,
  overrides: Partial<{
    holdings: Holding[]
    trust: AppStoreState['trust']
    portfolioPolicy: AppStoreState['portfolioPolicy']
    cashAssumptions: AppStoreState['cashAssumptions']
    csvImportedAt: string | null
    provenance: CsvImportProvenance | null
    syncSummary: CsvSyncSummary | null
  }> = {},
): void {
  persistCsvImportTransaction({
    holdings: overrides.holdings ?? state.holdings,
    trust: overrides.trust ?? state.trust,
    learning: state.learning,
    csvImportedAt: overrides.csvImportedAt ?? null,
    provenance: overrides.provenance ?? null,
    syncSummary: overrides.syncSummary ?? null,
    trustShortSnapshot: { date: '2026-07-20', total: 0, evalById: {} },
    portfolioPolicy: overrides.portfolioPolicy ?? state.portfolioPolicy,
    cashAssumptions: overrides.cashAssumptions ?? state.cashAssumptions,
    origin: overrides.provenance ? 'csv' : 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

function resetCounts(): void {
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  analysisProbe.calls = 0
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  Object.keys(storage).forEach(key => delete storage[key])
  resetCounts()
  analysisProbe.fail = false
  onStorageSet = null
})

afterEach(() => {
  resetPortfolioGenerationLockAdapterForTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RA-007-C runtime injection and pre-grant invariants', () => {
  it('creates adapters lazily, injects isolated A/B adapters, and fails unavailable without fallback', async () => {
    const navigatorGetter = vi.fn(() => undefined)
    Object.defineProperty(globalThis, 'navigator', { configurable: true, get: navigatorGetter })
    const productionAdapter = createPortfolioGenerationLockAdapter()
    expect(navigatorGetter).not.toHaveBeenCalled()

    const manager = new FakeLockManager()
    const aAdapter = adapter(manager)
    const bAdapter = adapter(manager)
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: aAdapter })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: bAdapter })
    expect(a.store).not.toBe(b.store)
    expect(aAdapter).not.toBe(bAdapter)

    const unavailable = createAppStoreInstanceForTest({ portfolioGenerationLock: productionAdapter })
    let notifications = 0
    unavailable.store.subscribe(() => { notifications += 1 })
    resetCounts()
    const result = await unavailable.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(result).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'WEB_LOCK_UNAVAILABLE'))
    expect({ storageCounts, analysis: analysisProbe.calls, notifications }).toEqual({
      storageCounts: { get: 0, set: 0, remove: 0 }, analysis: 0, notifications: 0,
    })
  })

  it('holds the local ticket while manual waits and rejects same-store duplicate before a second request', async () => {
    const { manager, a } = pair()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    resetCounts()
    const pending = a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    await flush()
    expect(a.controls.inspect().activeOperationKind).toBe('manual')
    expect(manager.requests).toHaveLength(1)
    expect(storageCounts.get).toBe(0)
    expect(analysisProbe.calls).toBe(0)
    expect(notifications).toBe(0)
    const duplicate = await a.store.getState().updateHolding('missing', { eval: 1 })
    expect(duplicate).toEqual(createPortfolioCoordinationFailure('updateHolding', 'LOCAL_OPERATION_BUSY'))
    expect(manager.requests).toHaveLength(1)
    await grant(manager, pending)
    expect(a.controls.inspect().activeOperationKind).toBeNull()
  })

  it('keeps snapshot parse outside the lock but state/storage/transaction/cache work after grant', async () => {
    const { manager, a } = pair()
    emptyStore(a.store)
    const raw = snapshotWithHolding()
    resetCounts()
    const before = a.store.getState()
    const pending = a.store.getState().importPortfolioSnapshot(raw)
    await flush()
    expect(manager.requests).toHaveLength(1)
    expect(storageCounts.get).toBe(0)
    expect(analysisProbe.calls).toBe(0)
    expect(a.store.getState()).toBe(before)
    expect(a.controls.inspect()).toMatchObject({
      activeOperationKind: 'snapshot', activeGenerationOrigin: null, hasSnapshotCache: false,
    })
    const duplicate = await a.store.getState().importPortfolioSnapshot(raw)
    expect(duplicate).toEqual(createPortfolioCoordinationFailure('importPortfolioSnapshot', 'LOCAL_OPERATION_BUSY'))
    expect(manager.requests).toHaveLength(1)
    expect((await grant(manager, pending)).ok).toBe(true)
  })

  it('returns request failure and externally injected aborted results unchanged and permits retry', async () => {
    let requestAttempts = 0
    const requestFailure = createPortfolioGenerationLockAdapter({
      lockManager: {
        request: (_name, _options, callback) => {
          requestAttempts += 1
          if (requestAttempts === 1) throw new Error('request failed')
          return Promise.resolve(callback({} as Lock))
        },
      },
    })
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: requestFailure })
    expect(await instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 }))
      .toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'WEB_LOCK_REQUEST_FAILED'))
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(await instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 }))
      .toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(requestAttempts).toBe(2)

    const abortedAdapter: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_ABORTED')
      },
    }
    const aborted = createAppStoreInstanceForTest({ portfolioGenerationLock: abortedAdapter })
    expect(await aborted.store.getState().updateTrust('missing', { eval: 1 }))
      .toEqual(createPortfolioCoordinationFailure('updateTrust', 'WEB_LOCK_ABORTED'))
    expect(aborted.controls.inspect().activeOperationKind).toBeNull()
  })

  it('keeps invalid snapshot parse side-effect free and returns snapshot lock failure as coordination', async () => {
    let requests = 0
    const parseFailure = createAppStoreInstanceForTest({
      portfolioGenerationLock: immediateAdapter(() => { requests += 1 }),
    })
    resetCounts()
    expect(await parseFailure.store.getState().importPortfolioSnapshot('{invalid')).toMatchObject({
      ok: false, code: 'INVALID_SNAPSHOT',
    })
    expect({ requests, writes: storageCounts.set, analysis: analysisProbe.calls }).toEqual({
      requests: 0, writes: 0, analysis: 0,
    })

    const raw = snapshotWithHolding()
    const lockFailure: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_REQUEST_FAILED')
      },
    }
    const snapshotFailure = createAppStoreInstanceForTest({ portfolioGenerationLock: lockFailure })
    emptyStore(snapshotFailure.store)
    resetCounts()
    expect(await snapshotFailure.store.getState().importPortfolioSnapshot(raw)).toEqual(
      createPortfolioCoordinationFailure('importPortfolioSnapshot', 'WEB_LOCK_REQUEST_FAILED'),
    )
    expect({ reads: storageCounts.get, writes: storageCounts.set, analysis: analysisProbe.calls })
      .toEqual({ reads: 0, writes: 0, analysis: 0 })
  })
})

describe('RA-007-C two-store serialization and stale policy', () => {
  it('serializes A updateHolding then B updateTrust FIFO and rejects B stale with zero B publish/write', async () => {
    const { manager, a, b } = pair()
    const holdingCode = a.store.getState().holdings[0].code
    const trustId = b.store.getState().trust[0].id
    let bNotifications = 0
    b.store.subscribe(() => { bNotifications += 1 })
    const aPending = a.store.getState().updateHolding(holdingCode, { eval: 222_222 })
    const bPending = b.store.getState().updateTrust(trustId, { eval: 333_333 })
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toHaveLength(2)
    expect(a.controls.inspect().activeOperationKind).toBe('manual')
    expect(b.controls.inspect().activeOperationKind).toBe('manual')
    const aResult = await grant(manager, aPending)
    const writesAfterA = storageCounts.set
    const analysisAfterA = analysisProbe.calls
    expect(aResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    const bResult = await grant(manager, bPending)
    expect(bResult).toEqual(createPortfolioCoordinationFailure('updateTrust', 'CROSS_TAB_STATE_STALE'))
    expect(storageCounts.set).toBe(writesAfterA)
    expect(analysisProbe.calls).toBe(analysisAfterA)
    expect(bNotifications).toBe(0)
  })

  it('lets B proceed after A NO_CHANGE and after A pre-persistence analysis failure', async () => {
    const first = pair()
    const trustId = first.b.store.getState().trust[0].id
    const aNoChange = first.a.store.getState().updateHolding('missing', { eval: 1 })
    const bAfterNoChange = first.b.store.getState().updateTrust(trustId, { eval: 321_000 })
    expect(await grant(first.manager, aNoChange)).toMatchObject({ ok: true, code: 'NO_CHANGE' })
    expect(await grant(first.manager, bAfterNoChange)).toMatchObject({ ok: true, code: 'SUCCESS' })

    Object.keys(storage).forEach(key => delete storage[key])
    resetCounts()
    const second = pair()
    const code = second.a.store.getState().holdings[0].code
    const id = second.b.store.getState().trust[0].id
    analysisProbe.fail = true
    const aFailure = second.a.store.getState().updateHolding(code, { eval: 654_321 })
    const bAfterFailure = second.b.store.getState().updateTrust(id, { eval: 765_432 })
    expect(await grant(second.manager, aFailure)).toMatchObject({ ok: false, code: 'MANUAL_ANALYSIS_ERROR' })
    analysisProbe.fail = false
    expect(await grant(second.manager, bAfterFailure)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('makes B and A stale after A durable persistence plus pre-apply publish failure, then allows explicit realignment retry', async () => {
    const { manager, a, b } = pair()
    const code = a.store.getState().holdings[0].code
    const trustId = b.store.getState().trust[0].id
    a.controls.setManualPublishBeforeApplyHook(() => { throw new Error('pre-apply') })
    const aFailure = a.store.getState().updateHolding(code, { eval: 987_654 })
    const bPending = b.store.getState().updateTrust(trustId, { eval: 222_000 })
    expect(await grant(manager, aFailure)).toMatchObject({ ok: false, code: 'MANUAL_PUBLISH_ERROR' })
    expect(await grant(manager, bPending)).toEqual(
      createPortfolioCoordinationFailure('updateTrust', 'CROSS_TAB_STATE_STALE'),
    )
    const aAgain = a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(manager, aAgain)).toEqual(
      createPortfolioCoordinationFailure('setPortfolioPolicy', 'CROSS_TAB_STATE_STALE'),
    )

    const durableHoldings = restorePortfolio()
    const durableTrust = restoreTrust()
    expect(durableHoldings).not.toBeNull()
    expect(durableTrust).not.toBeNull()
    // RA-009-B1: a real reload/initialize also restores legacy learning, so a durable
    // realignment simulation must include it — otherwise B's stale (unset) learning would
    // itself now be flagged as diverged from A's durably persisted legacy learning generation.
    b.store.setState({ holdings: durableHoldings!, trust: durableTrust!, learning: restoreLearning() })
    const retry = b.store.getState().updateTrust(trustId, { eval: 222_000 })
    expect(await grant(manager, retry)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it.each([
    ['snapshot then manual', 'snapshot-manual'],
    ['manual then snapshot', 'manual-snapshot'],
    ['snapshot then snapshot', 'snapshot-snapshot'],
  ] as const)('%s returns stale for the queued B writer', async (_label, kind) => {
    const { manager, a, b } = pair()
    const raw = snapshotWithHolding()
    if (kind !== 'manual-snapshot') {
      emptyStore(a.store)
      emptyStore(b.store)
    }
    const code = a.store.getState().holdings[0]?.code
    const aPending = (kind === 'manual-snapshot'
      ? a.store.getState().updateHolding(code, { eval: 111_222 })
      : a.store.getState().importPortfolioSnapshot(raw)) as Promise<
        Awaited<ReturnType<AppStoreState['updateHolding']>> |
        Awaited<ReturnType<AppStoreState['importPortfolioSnapshot']>>
      >
    const bPending = (kind === 'snapshot-manual'
      ? b.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
      : b.store.getState().importPortfolioSnapshot(raw)) as Promise<
        Awaited<ReturnType<AppStoreState['setPortfolioPolicy']>> |
        Awaited<ReturnType<AppStoreState['importPortfolioSnapshot']>>
      >
    expect(await grant(manager, aPending)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(await grant(manager, bPending)).toMatchObject({
      ok: false, code: 'CROSS_TAB_STATE_STALE', retryable: false,
    })
    expect(b.controls.inspect()).toMatchObject({ activeOperationKind: null, hasSnapshotCache: false })
  })
})

describe('RA-007-C lock lifetime, timeout, and scope', () => {
  it('holds lock and ticket through persistence, final publish, subscriber, and nested rejection', async () => {
    const { manager, a, b } = pair()
    const code = a.store.getState().holdings[0].code
    const raw = a.store.getState().exportPortfolioSnapshot()
    const heldDuringWrites: boolean[] = []
    onStorageSet = () => heldDuringWrites.push(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME))
    let heldInSubscriber = false
    let ticketInSubscriber: string | null = null
    let requestsInSubscriber = -1
    let nestedManual: ReturnType<AppStoreState['setPortfolioPolicy']> | null = null
    let nestedSnapshot: ReturnType<AppStoreState['importPortfolioSnapshot']> | null = null
    a.store.subscribe(() => {
      heldInSubscriber = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      ticketInSubscriber = a.controls.inspect().activeOperationKind
      requestsInSubscriber = manager.requests.length
      nestedManual = a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
      nestedSnapshot = a.store.getState().importPortfolioSnapshot(raw)
    })
    const aPending = a.store.getState().updateHolding(code, { eval: 454_545 })
    const bPending = b.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    await flush()
    expect(await grant(manager, aPending)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(heldDuringWrites.length).toBeGreaterThan(0)
    expect(heldDuringWrites.every(Boolean)).toBe(true)
    expect(heldInSubscriber).toBe(true)
    expect(ticketInSubscriber).toBe('manual')
    expect(requestsInSubscriber).toBe(2)
    expect(await nestedManual!).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'LOCAL_OPERATION_BUSY'))
    expect(await nestedSnapshot!).toEqual(createPortfolioCoordinationFailure('importPortfolioSnapshot', 'LOCAL_OPERATION_BUSY'))
    expect(manager.requests).toHaveLength(2)
    expect(manager.events.findIndex(event => event.type === 'released')).toBeGreaterThan(
      manager.events.findIndex(event => event.type === 'callback_resolved'),
    )
    expect(await grant(manager, bPending)).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE' })
  })

  it('times out before grant, releases the local ticket, and retries successfully', async () => {
    let timeoutCallback: (() => void) | null = null
    const timerApi: PortfolioGenerationLockTimerApi = {
      setTimeout(callback) { timeoutCallback = callback; return 1 as ReturnType<typeof setTimeout> },
      clearTimeout() { timeoutCallback = null },
    }
    const manager = new FakeLockManager()
    const timeoutAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 10, timerApi })
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: timeoutAdapter })
    const pending = instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    await flush()
    expect(analysisProbe.calls).toBe(0)
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback!()
    expect(await pending).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'WEB_LOCK_TIMEOUT'))
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.pendingCount()).toBe(0)

    const retry = instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(manager, retry)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('RA-007-D2: connects initialize and refresh to the same injected Web Lock as CSV', async () => {
    let requests = 0
    const countingAdapter = immediateAdapter(() => { requests += 1 })
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: countingAdapter })
    await instance.store.getState().initialize()
    expect(requests).toBe(1)
    await instance.store.getState().refreshAllData()
    expect(requests).toBe(2)
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    await instance.store.getState().importCsv({ name: 'no-lock.csv' } as File)
    expect(requests).toBe(3)
  })
})

describe('RA-007-C stale projection', () => {
  it.each([
    ['holdings', (state: AppStoreState) => ({ holdings: state.holdings.map((h, index) => index === 0 ? { ...h, eval: h.eval + 1 } : h) })],
    ['trust', (state: AppStoreState) => ({ trust: state.trust.map((f, index) => index === 0 ? { ...f, eval: f.eval + 1 } : f) })],
    ['portfolioPolicy', (_state: AppStoreState) => ({ portfolioPolicy: { jpStockMaxRatio: 0.12 } })],
    ['cashAssumptions', (state: AppStoreState) => ({ cashAssumptions: { ...state.cashAssumptions, cashDeposits: state.cashAssumptions.cashDeposits + 1 } })],
    ['csvLastImportedAt', (state: AppStoreState) => ({ system: { ...state.system, csvLastImportedAt: null } })],
    ['provenance', (state: AppStoreState) => ({ system: { ...state.system, csvImportProvenance: null } })],
    ['sync summary', (state: AppStoreState) => ({ system: { ...state.system, csvSyncSummary: null } })],
  ] as const)('detects %s differences before analysis/write/publish', async (field, mutate) => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    const metadata = field === 'csvLastImportedAt' || field === 'provenance' || field === 'sync summary'
    const state = instance.store.getState()
    const p = provenance()
    const summary = syncSummary()
    seedCanonical(state, metadata ? { csvImportedAt: NOW_ISO, provenance: p, syncSummary: summary } : {})
    if (metadata) instance.store.setState(current => ({ system: {
      ...current.system, csvLastImportedAt: NOW_ISO, csvImportProvenance: p, csvSyncSummary: summary,
    } }))
    instance.store.setState(current => mutate(current))
    resetCounts()
    let notifications = 0
    instance.store.subscribe(() => { notifications += 1 })
    const pending = instance.store.getState().updateHolding('missing', { eval: 1 })
    const result = await grant(manager, pending)
    expect(result).toEqual(createPortfolioCoordinationFailure('updateHolding', 'CROSS_TAB_STATE_STALE'))
    expect({ analysis: analysisProbe.calls, writes: storageCounts.set, notifications })
      .toEqual({ analysis: 0, writes: 0, notifications: 0 })
  })

  it('ignores derived/market/news differences and normalizes expired/future metadata with one nowMs', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    const oldAt = '2026-01-01T00:00:00.000Z'
    seedCanonical(instance.store.getState(), { csvImportedAt: oldAt, provenance: null, syncSummary: null })
    instance.store.setState(state => ({
      analysis: [{ ...state.analysis[0], code: 'DERIVED-ONLY' }].filter(Boolean) as AppStoreState['analysis'],
      market: { ...state.market, vix: state.market.vix + 1 },
      news: state.news === null ? null : { ...state.news },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    const pending = instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(manager, pending)).toMatchObject({ ok: true, code: 'SUCCESS' })

    Object.keys(storage).forEach(key => delete storage[key])
    const future = pair()
    const futureAt = '2099-01-01T00:00:00.000Z'
    seedCanonical(future.a.store.getState(), { csvImportedAt: futureAt, provenance: null, syncSummary: null })
    const futurePending = future.a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(future.manager, futurePending)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('classifies canonical invalid by domain, permits no-evidence first mutation, and fails partial legacy closed', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    const manual = instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(manager, manual)).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })

    emptyStore(instance.store)
    const snapshot = instance.store.getState().importPortfolioSnapshot(snapshotWithHolding())
    expect(await grant(manager, snapshot)).toMatchObject({ ok: false, code: 'SNAPSHOT_CANONICAL_INVALID' })

    Object.keys(storage).forEach(key => delete storage[key])
    const fresh = pair()
    const first = fresh.a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(fresh.manager, first)).toMatchObject({ ok: true, code: 'SUCCESS' })

    Object.keys(storage).forEach(key => delete storage[key])
    storage.v13_portfolio_policy = JSON.stringify({ data: DEFAULT_PORTFOLIO_POLICY, savedAt: NOW_MS })
    const partial = pair()
    const rejected = partial.a.store.getState().updateHolding('missing', { eval: 1 })
    expect(await grant(partial.manager, rejected)).toEqual(
      createPortfolioCoordinationFailure('updateHolding', 'CROSS_TAB_STATE_STALE'),
    )
  })

  it('keeps default override and factory runtimes isolated and reset creates a fresh production adapter', async () => {
    let defaultCalls = 0
    const defaultAdapter = immediateAdapter(() => { defaultCalls += 1 })
    setPortfolioGenerationLockAdapterForTest(defaultAdapter)
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const pendingA = a.store.getState().updateHolding('missing', { eval: 1 })
    await flush()
    expect(defaultCalls).toBe(0)
    expect(b.controls.acquirePortfolioOperation('manual')).not.toBeNull()
    b.controls.reset()
    expect(await grant(manager, pendingA)).toMatchObject({ ok: true, code: 'NO_CHANGE' })
    resetPortfolioGenerationLockAdapterForTest()
    expect(a.controls.inspect().activeOperationKind).toBeNull()
    expect(b.controls.inspect().activeOperationKind).toBeNull()
  })
})
