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
// RA-007-E: adversarial FIFO / three-store queue validation. Test-hardening only — confirms the
// SAME injected FakeLockManager queue serializes two AND three concurrently-queued store
// instances in strict request order, that a stale/no-write result in the middle of the queue
// never stalls or skips a later waiter, and that no waiter's callback is invoked more than once.
// ─────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

const BASELINE_HOLDING: Holding = {
  code: '1001', name: 'queue holding', eval: 400_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const BASELINE_TRUST: Trust = {
  id: 'queue-fund', name: 'queue fund', abbr: 'QUE', account: '特定',
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

function csvContent(code: string, evalValue: number): string {
  return [
    'データ基準日時,2026-07-20T11:00:00+09:00',
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    `${code},queue holding,1200,${evalValue},0.00,0.00,2025-01-01`,
  ].join('\n')
}

function csvFile(code = BASELINE_HOLDING.code, evalValue = 444_000): File {
  return new File([csvContent(code, evalValue)], 'queue.csv', { type: 'text/csv' })
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

function newInstance(manager: FakeLockManager) {
  const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  baselineStore(instance.store)
  return instance
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function grantNext(manager: FakeLockManager): void {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
}

function resetCounts(): void {
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  analysisProbe.calls = 0
  loadProbe.calls = 0
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', CountingFileReader)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })))
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
// Section 8: two-store FIFO and grant-order across representative writer-pair combinations
// ─────────────────────────────────────────────────────────────
describe('RA-007-E two-store FIFO grant order', () => {
  async function assertFifoGrantOrder(
    firstTrigger: (a: ReturnType<typeof newInstance>) => Promise<unknown>,
    secondTrigger: (b: ReturnType<typeof newInstance>) => Promise<unknown>,
  ) {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)

    const aPending = firstTrigger(a)
    const bPending = secondTrigger(b)
    await flush()
    // Both requests are queued, in the exact order they were issued.
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2])

    grantNext(manager)
    const aResult = await aPending
    // A's callback (including its final publication and synchronous subscriber) must have fully
    // resolved and released the lock before B is ever granted.
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([2])

    grantNext(manager)
    const bResult = await bPending

    const events = manager.events
    const granted1 = events.findIndex(e => e.type === 'granted' && e.waiterId === 1)
    const resolved1 = events.findIndex(e =>
      (e.type === 'callback_resolved' || e.type === 'callback_rejected') && e.waiterId === 1)
    const granted2 = events.findIndex(e => e.type === 'granted' && e.waiterId === 2)
    expect(granted1).toBeGreaterThanOrEqual(0)
    expect(resolved1).toBeGreaterThan(granted1)
    expect(granted2).toBeGreaterThan(resolved1)

    return { aResult, bResult }
  }

  it('manual (updateHolding) -> CSV: B is stale and never reads its file', async () => {
    const { aResult, bResult } = await assertFifoGrantOrder(
      a => a.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 111 }),
      b => b.store.getState().importCsv(csvFile(BASELINE_HOLDING.code, 222_000)),
    )
    expect(aResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(bResult).toEqual(createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'))
  })

  it('CSV -> snapshot: B is stale relative to A durable CSV commit', async () => {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)
    emptyStore(b.store)

    const aPending = a.store.getState().importCsv(csvFile())
    const bPending = b.store.getState().importPortfolioSnapshot(distinctSnapshotRaw('9201'))
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2])
    grantNext(manager)
    expect(await aPending).toMatchObject({ ok: true, code: 'SUCCESS' })
    grantNext(manager)
    expect(await bPending).toEqual(createPortfolioCoordinationFailure('importPortfolioSnapshot', 'CROSS_TAB_STATE_STALE'))
  })

  it('snapshot -> refresh: B is stale relative to A durable snapshot commit', async () => {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)
    emptyStore(a.store)

    const aPending = a.store.getState().importPortfolioSnapshot(distinctSnapshotRaw('9202'))
    const bPending = b.store.getState().refreshAllData()
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2])
    grantNext(manager)
    expect(await aPending).toMatchObject({ ok: true, code: 'SUCCESS' })
    grantNext(manager)
    expect(await bPending).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
  })

  it('refresh -> initialize: B always bootstraps successfully regardless of A', async () => {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)
    const distinct = [{ ...BASELINE_HOLDING, code: '9203', eval: 900_203 }]
    seedCanonical(a.store.getState(), { holdings: distinct })
    a.store.setState({ holdings: distinct })

    const aPending = a.store.getState().refreshAllData()
    const bPending = b.store.getState().initialize()
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2])
    grantNext(manager)
    expect(await aPending).toMatchObject({ ok: true, code: 'SUCCESS' })
    grantNext(manager)
    const bResult = await bPending
    expect(bResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(b.store.getState().holdings.map(h => h.code)).toEqual(['9203'])
  })

  it('initialize -> manual: B is stale relative to A durable bootstrap commit', async () => {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)
    seedCanonical(a.store.getState(), {
      holdings: [{ ...BASELINE_HOLDING, code: '9204', eval: 900_204 }],
    })

    const aPending = a.store.getState().initialize()
    const bPending = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2])
    grantNext(manager)
    expect(await aPending).toMatchObject({ ok: true, code: 'SUCCESS' })
    grantNext(manager)
    expect(await bPending).toEqual(createPortfolioCoordinationFailure('updateHolding', 'CROSS_TAB_STATE_STALE'))
  })

  it('cash mutation -> policy mutation: B is stale relative to A durable cash commit', async () => {
    const { aResult, bResult } = await assertFifoGrantOrder(
      a => a.store.getState().setCashAssumptions({ grossCash: 5_600_000, safetyReserve: 0, pendingOrderCash: null }),
      b => b.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.22 }),
    )
    expect(aResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(bResult).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'CROSS_TAB_STATE_STALE'))
  })
})

// ─────────────────────────────────────────────────────────────
// Section 9: three-store queue
// ─────────────────────────────────────────────────────────────
describe('RA-007-E three-store queue', () => {
  it('A policy success, B stale updateHolding, C bootstrap initialize: strict FIFO grant order, zero starvation, zero duplicate callbacks', async () => {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)
    const c = newInstance(manager)

    const aPending = a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.22 })
    const bPending = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    const cPending = c.store.getState().initialize()
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2, 3])

    resetCounts()

    grantNext(manager)
    const aResult = await aPending
    expect(aResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([2, 3])

    const setsBeforeB = storageCounts.set
    grantNext(manager)
    const bResult = await bPending
    expect(bResult).toEqual(createPortfolioCoordinationFailure('updateHolding', 'CROSS_TAB_STATE_STALE'))
    // B's own grant window performed zero additional writes (its stale rejection precedes any
    // candidate construction, analysis, or persistence).
    expect(storageCounts.set).toBe(setsBeforeB)
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([3])

    grantNext(manager)
    const cResult = await cPending
    expect(cResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(c.store.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.22)

    const events = manager.events
    const grantedOrder = events.filter(e => e.type === 'granted').map(e => e.waiterId)
    expect(grantedOrder).toEqual([1, 2, 3])
    const releasedOrder = events.filter(e => e.type === 'released').map(e => e.waiterId)
    expect(releasedOrder).toEqual([1, 2, 3])
    // Every waiter was granted and released exactly once — zero starvation, zero duplicate
    // callback invocation.
    for (const id of [1, 2, 3]) {
      expect(events.filter(e => e.type === 'granted' && e.waiterId === id)).toHaveLength(1)
      expect(events.filter(e =>
        (e.type === 'callback_resolved' || e.type === 'callback_rejected') && e.waiterId === id,
      )).toHaveLength(1)
    }
  })

  it('A no-write NO_CHANGE, B updateHolding success, C stale refresh: the queue continues past a no-write first waiter', async () => {
    const manager = new FakeLockManager()
    const a = newInstance(manager)
    const b = newInstance(manager)
    const c = newInstance(manager)

    const aPending = a.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval })
    const bPending = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    const cPending = c.store.getState().refreshAllData()
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2, 3])

    resetCounts()
    grantNext(manager)
    const aResult = await aPending
    expect(aResult).toMatchObject({ ok: true, code: 'NO_CHANGE' })
    expect(storageCounts.set).toBe(0)
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)

    grantNext(manager)
    const bResult = await bPending
    expect(bResult).toMatchObject({ ok: true, code: 'SUCCESS' })

    grantNext(manager)
    const cResult = await cPending
    expect(cResult).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))

    const grantedOrder = manager.events.filter(e => e.type === 'granted').map(e => e.waiterId)
    expect(grantedOrder).toEqual([1, 2, 3])
  })
})
