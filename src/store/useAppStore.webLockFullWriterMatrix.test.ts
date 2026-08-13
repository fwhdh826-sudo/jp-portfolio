import type { CashAssumptions } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadProbe = vi.hoisted(() => ({
  calls: 0,
  implementation: null as null | (() => Promise<unknown>),
}))

const analysisProbe = vi.hoisted(() => ({ calls: 0, fail: false }))

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async (...args: Parameters<typeof actual.refreshAllData>) => {
      loadProbe.calls += 1
      if (loadProbe.implementation) return loadProbe.implementation()
      return actual.refreshAllData(...args)
    },
  }
})

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
import type { Holding, Trust } from '../types'
import { CSV_IMPORT_GENERATION_SCHEMA_V5, persistCsvImportTransaction } from './persist'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
} from './portfolioGenerationLock'
import { createPortfolioCoordinationFailure } from './portfolioOperationResult'
import { FakeLockManager } from './testing/fakeLockManager'
import {
  createAppStoreInstanceForTest,
  resetPortfolioGenerationLockAdapterForTest,
  type AppStoreState,
} from './useAppStore'

// ─────────────────────────────────────────────────────────────
// RA-007-E: adversarial full-writer (10 writer) two-tab / same-store matrix.
// This suite is test-hardening only — it asserts the existing RA-007-A..D2 contract across
// every one of the 10 portfolio writers pairwise, plus same-store nested reentry. It must never
// weaken an assertion to match production behavior; if production violates the documented
// contract, the corresponding case must fail RED and be reported as BLOCKED, not adjusted.
// ─────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

const BASELINE_HOLDING: Holding = {
  code: '1001', name: 'matrix holding', eval: 400_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const BASELINE_TRUST: Trust = {
  id: 'matrix-fund', name: 'matrix fund', abbr: 'MTX', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 250_000, pnlPct: 0, dayPct: 0,
  cost: 0.2, mu: 0.1, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0,
  decision: 'HOLD',
}

const BASELINE_CASH_ASSUMPTIONS: CashAssumptions = {
  source: 'MANUAL',
  grossCash: 1_200_000,
  safetyReserve: 0,
  pendingOrderCash: null,
  updatedAt: NOW_ISO,
}

class CountingFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const storage: Record<string, string> = {}
const storageCounts = { get: 0, set: 0, remove: 0 }

const localStorageMock = {
  getItem(key: string) {
    storageCounts.get += 1
    return storage[key] ?? null
  },
  setItem(key: string, value: string) {
    storageCounts.set += 1
    storage[key] = value
  },
  removeItem(key: string) {
    storageCounts.remove += 1
    delete storage[key]
  },
}

let fetchCalls: string[] = []

function adapter(manager: FakeLockManager): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 60_000 })
}

function immediateAdapter(): PortfolioGenerationLockAdapter {
  return {
    async runExclusive(_operation, callback) {
      return { ok: true, value: await callback() }
    },
  }
}

function baselineStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [{ ...BASELINE_HOLDING }],
    trust: [{ ...BASELINE_TRUST }],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...BASELINE_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function emptyStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [], trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    analysis: [], metrics: null, officialDecision: null,
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function seedCanonical(
  state: AppStoreState,
  overrides: Partial<{
    holdings: Holding[]
    trust: Trust[]
    portfolioPolicy: AppStoreState['portfolioPolicy']
    cashAssumptions: AppStoreState['cashAssumptions']
  }> = {},
): void {
  persistCsvImportTransaction({
    holdings: overrides.holdings ?? state.holdings,
    trust: overrides.trust ?? state.trust,
    learning: state.learning,
    csvImportedAt: null,
    provenance: null,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-07-20', total: 0, evalById: {} },
    portfolioPolicy: overrides.portfolioPolicy ?? state.portfolioPolicy,
    cashAssumptions: overrides.cashAssumptions ?? state.cashAssumptions,
    origin: 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

function pair(manager = new FakeLockManager()) {
  const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  for (const instance of [a, b]) baselineStore(instance.store)
  return { manager, a, b }
}

function csvContent(evalValue: number): string {
  return [
    'データ基準日時,2026-07-20T11:00:00+09:00',
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    `${BASELINE_HOLDING.code},${BASELINE_HOLDING.name},1200,${evalValue},0.00,0.00,2025-01-01`,
  ].join('\n')
}

function csvFileWithEval(evalValue: number): File {
  return new File([csvContent(evalValue)], 'matrix.csv', { type: 'text/csv' })
}

function distinctSnapshotRaw(code: string): string {
  const source = createAppStoreInstanceForTest({ portfolioGenerationLock: immediateAdapter() })
  source.store.setState(state => ({
    holdings: [{ ...BASELINE_HOLDING, code, name: 'snapshot holding', eval: 777_000 }],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
  return source.store.getState().exportPortfolioSnapshot()
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function resetCounts(): void {
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  analysisProbe.calls = 0
  loadProbe.calls = 0
  fetchCalls = []
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', CountingFileReader)
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    fetchCalls.push(String(url))
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  }))
  Object.keys(storage).forEach(key => delete storage[key])
  resetCounts()
  analysisProbe.fail = false
  loadProbe.implementation = null
})

afterEach(() => {
  resetPortfolioGenerationLockAdapterForTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────
// Writer registry
// ─────────────────────────────────────────────────────────────

const ALL_WRITERS = [
  'initialize',
  'refreshAllData',
  'importCsv',
  'importPortfolioSnapshot',
  'updateHolding',
  'updateTrust',
  'setPortfolioPolicy',
  'setCashAssumptions',
  'clearCashAssumptionsOverride',
  'importCashAssumptions',
] as const

type WriterKey = typeof ALL_WRITERS[number]
type Instance = ReturnType<typeof createAppStoreInstanceForTest>

// Each "first" trigger drives the given instance to a durable SUCCESS that changes the portfolio
// projection away from the shared baseline. Every trigger is invoked only after `pair()` has set
// identical baseline content on both instances.
const FIRST_TRIGGERS: Record<WriterKey, (instance: Instance) => Promise<unknown>> = {
  initialize: instance => {
    seedCanonical(instance.store.getState(), {
      holdings: [{ ...BASELINE_HOLDING, code: '9001', eval: 900_001 }],
    })
    return instance.store.getState().initialize()
  },
  refreshAllData: instance => {
    const distinct = [{ ...BASELINE_HOLDING, code: '9002', eval: 900_002 }]
    seedCanonical(instance.store.getState(), { holdings: distinct })
    instance.store.setState({ holdings: distinct })
    return instance.store.getState().refreshAllData()
  },
  importCsv: instance => instance.store.getState().importCsv(csvFileWithEval(444_000)),
  importPortfolioSnapshot: instance => {
    emptyStore(instance.store)
    return instance.store.getState().importPortfolioSnapshot(distinctSnapshotRaw('9003'))
  },
  updateHolding: instance => instance.store.getState().updateHolding(
    BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 111 },
  ),
  updateTrust: instance => instance.store.getState().updateTrust(
    BASELINE_TRUST.id, { eval: BASELINE_TRUST.eval + 111 },
  ),
  setPortfolioPolicy: instance => instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.25 }),
  setCashAssumptions: instance => instance.store.getState().setCashAssumptions({
    grossCash: 4_999_999,
    safetyReserve: 0,
    pendingOrderCash: null,
  }),
  clearCashAssumptionsOverride: instance => instance.store.getState().clearCashAssumptionsOverride(),
  importCashAssumptions: instance => instance.store.getState().importCashAssumptions({
    grossCash: 6_700_000,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt: NOW_ISO,
  }),
}

// Each "second" trigger is invoked on an instance still holding the untouched shared baseline.
const SECOND_TRIGGERS: Record<WriterKey, (instance: Instance) => Promise<unknown>> = {
  initialize: instance => instance.store.getState().initialize(),
  refreshAllData: instance => instance.store.getState().refreshAllData(),
  importCsv: instance => instance.store.getState().importCsv(csvFileWithEval(123_000)),
  importPortfolioSnapshot: instance => instance.store.getState().importPortfolioSnapshot(
    instance.store.getState().exportPortfolioSnapshot(),
  ),
  updateHolding: instance => instance.store.getState().updateHolding(
    BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 222 },
  ),
  updateTrust: instance => instance.store.getState().updateTrust(
    BASELINE_TRUST.id, { eval: BASELINE_TRUST.eval + 222 },
  ),
  setPortfolioPolicy: instance => instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.22 }),
  setCashAssumptions: instance => instance.store.getState().setCashAssumptions({
    grossCash: 2,
    safetyReserve: 0,
    pendingOrderCash: null,
  }),
  clearCashAssumptionsOverride: instance => instance.store.getState().clearCashAssumptionsOverride(),
  importCashAssumptions: instance => instance.store.getState().importCashAssumptions({
    grossCash: 4,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt: NOW_ISO,
  }),
}

const MATRIX_PAIRS: ReadonlyArray<readonly [WriterKey, WriterKey]> =
  ALL_WRITERS.flatMap(first => ALL_WRITERS.map(second => [first, second] as const))

// Verifies that the specific change committed by each "first" writer survives a bootstrap
// initialize on the second store. Manual mutations (updateHolding/updateTrust/setPortfolioPolicy/
// setCashAssumptions/clearCashAssumptionsOverride/importCashAssumptions) persist through the
// legacy per-field keys when no canonical generation is committed yet, so only the field each
// writer actually touches carries durable authority — unrelated fields fall back to the coded
// initial defaults rather than to instance A's untouched in-memory baseline. CSV/snapshot/
// initialize/refresh always commit the full canonical envelope, so those are checked in full.
const BOOTSTRAP_CHECKS: Record<WriterKey, (b: Instance) => void> = {
  initialize: b => expect(b.store.getState().holdings.map(h => h.code)).toEqual(['9001']),
  refreshAllData: b => expect(b.store.getState().holdings.map(h => h.code)).toEqual(['9002']),
  importCsv: b => expect(
    b.store.getState().holdings.find(h => h.code === BASELINE_HOLDING.code)?.eval,
  ).toBe(444_000),
  importPortfolioSnapshot: b => expect(b.store.getState().holdings.map(h => h.code)).toEqual(['9003']),
  updateHolding: b => expect(
    b.store.getState().holdings.find(h => h.code === BASELINE_HOLDING.code)?.eval,
  ).toBe(BASELINE_HOLDING.eval + 111),
  updateTrust: b => expect(
    b.store.getState().trust.find(t => t.id === BASELINE_TRUST.id)?.eval,
  ).toBe(BASELINE_TRUST.eval + 111),
  setPortfolioPolicy: b => expect(b.store.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.25),
  setCashAssumptions: b => expect(b.store.getState().cashAssumptions).toMatchObject({
    source: 'MANUAL',
    grossCash: 4_999_999,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt: expect.any(String),
  }),
  clearCashAssumptionsOverride: b => expect(b.store.getState().cashAssumptions.source).toBe('DEFAULT'),
  importCashAssumptions: b => expect(b.store.getState().cashAssumptions).toMatchObject({
    source: 'MANUAL',
    grossCash: 6_700_000,
    safetyReserve: 0,
    pendingOrderCash: null,
    // CASH-AUTH-1: import は取り込み元の時刻をそのまま引き継ぐ（現在時刻で上書きしない）
    updatedAt: NOW_ISO,
  }),
}

// ─────────────────────────────────────────────────────────────
// 10x10 ordered-pair matrix (100 cases)
// ─────────────────────────────────────────────────────────────
describe('RA-007-E full 10x10 writer matrix', () => {
  it.each(MATRIX_PAIRS)('first=%s -> second=%s', async (first, second) => {
    const { manager, a, b } = pair()

    const firstPending = FIRST_TRIGGERS[first](a)
    const firstResult = await grant(manager, firstPending)
    expect(firstResult).toMatchObject({ ok: true })

    resetCounts()
    let notifications = 0
    const unsubscribe = b.store.subscribe(() => { notifications += 1 })
    const bBefore = b.store.getState()
    const secondPending = SECOND_TRIGGERS[second](b)
    const secondResult = await grant(manager, secondPending)
    unsubscribe()

    if (second === 'initialize') {
      // initialize is a bootstrap: it always adopts the latest durable generation and never
      // reports CROSS_TAB_STATE_STALE, regardless of what the first writer did.
      expect(secondResult).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect((secondResult as { code: string }).code).not.toBe('CROSS_TAB_STATE_STALE')
      BOOTSTRAP_CHECKS[first](b)
    } else {
      // Every non-bootstrap second writer must fail closed with zero prework application, zero
      // analysis, zero persistence, zero publication, and zero subscriber notification.
      expect(secondResult).toEqual(createPortfolioCoordinationFailure(second, 'CROSS_TAB_STATE_STALE'))
      expect(notifications).toBe(0)
      expect(analysisProbe.calls).toBe(0)
      expect(storageCounts.set).toBe(0)
      expect(b.store.getState()).toBe(bBefore)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// Projection-equivalent refresh: market/news-only prework changes must not block a later refresh.
// ─────────────────────────────────────────────────────────────
describe('RA-007-E projection-equivalent refresh continuation', () => {
  it('a refresh that only changes market/news does not stale a following refresh on the same store', async () => {
    const { manager, a } = pair()
    const first = await grant(manager, a.store.getState().refreshAllData())
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const second = await grant(manager, a.store.getState().refreshAllData())
    expect(second).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// ─────────────────────────────────────────────────────────────
// Same-store nested reentry matrix (5 outer x 10 inner = 50 cases)
// ─────────────────────────────────────────────────────────────
describe('RA-007-E same-store nested reentry matrix', () => {
  const OUTER_WRITERS: readonly WriterKey[] = [
    'initialize', 'refreshAllData', 'importCsv', 'importPortfolioSnapshot', 'setPortfolioPolicy',
  ]
  const REENTRY_PAIRS: ReadonlyArray<readonly [WriterKey, WriterKey]> =
    OUTER_WRITERS.flatMap(outer => ALL_WRITERS.map(inner => [outer, inner] as const))

  it.each(REENTRY_PAIRS)('outer=%s triggers inner=%s exactly LOCAL_OPERATION_BUSY', async (outer, inner) => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    if (outer === 'importPortfolioSnapshot') emptyStore(instance.store)
    const outerSnapshotRaw = outer === 'importPortfolioSnapshot' ? distinctSnapshotRaw('9004') : ''

    let notifications = 0
    let nestedResult: unknown = null
    const unsubscribe = instance.store.subscribe(() => {
      notifications += 1
      if (nestedResult === null) nestedResult = SECOND_TRIGGERS[inner](instance)
    })

    const requestsBeforeOuter = manager.requests.length
    const outerPending: Promise<unknown> = (
      outer === 'initialize' ? instance.store.getState().initialize()
      : outer === 'refreshAllData' ? instance.store.getState().refreshAllData()
      : outer === 'importCsv' ? instance.store.getState().importCsv(csvFileWithEval(321_000))
      : outer === 'importPortfolioSnapshot'
        ? instance.store.getState().importPortfolioSnapshot(outerSnapshotRaw)
      : instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.19 })
    )
    await flush()
    const requestsAfterQueue = manager.requests.length
    const outerResult = await grant(manager, outerPending)
    unsubscribe()

    expect(outerResult).toMatchObject({ ok: true })
    // importCsv additionally sets system.status = 'loading' as its very first synchronous
    // publish (pre-existing CSV transaction behavior, unrelated to the Web Lock lifecycle), so it
    // notifies subscribers twice (loading, then the final commit); every other writer here
    // performs exactly one synchronous set() and therefore notifies exactly once. The nested
    // probe still only ever fires on the FIRST notification (`nestedResult === null` guard) and
    // the Web Lock is still held for both notifications, so nested-reentry safety is unaffected.
    expect(notifications).toBe(outer === 'importCsv' ? 2 : 1)
    expect(nestedResult).not.toBeNull()
    await expect(nestedResult).resolves.toEqual(createPortfolioCoordinationFailure(inner, 'LOCAL_OPERATION_BUSY'))
    // The nested call must never issue an additional Web Lock request: request count observed
    // right before grant (i.e. after the nested call already ran inside the subscriber) equals
    // the count observed when the outer request was first queued.
    expect(manager.requests.length).toBe(requestsAfterQueue)
    expect(requestsAfterQueue).toBe(requestsBeforeOuter + 1)
  })
})
