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
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
} from './persist'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
  type PortfolioGenerationLockTimerApi,
} from './portfolioGenerationLock'
import { createPortfolioCoordinationFailure } from './portfolioOperationResult'
import { FakeLockManager } from './testing/fakeLockManager'
import {
  createAppStoreInstanceForTest,
  resetPortfolioGenerationLockAdapterForTest,
  type AppStoreState,
} from './useAppStore'

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

const TEST_HOLDING: Holding = {
  code: 'RA007D2', name: 'RA-007-D2 holding', eval: 500_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const TEST_TRUST: Trust = {
  id: 'ra007d2-fund', name: 'RA-007-D2 fund', abbr: 'RA7D2', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 300_000, pnlPct: 0, dayPct: 0,
  cost: 0.2, mu: 0.1, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0,
  decision: 'HOLD',
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
let phase7Response: { ok: boolean; status: number; json: () => Promise<unknown> } = {
  ok: false, status: 404, json: () => Promise.resolve({}),
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function adapter(manager: FakeLockManager, timeoutMs = 60_000): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs })
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

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
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
  phase7Response = { ok: false, status: 404, json: () => Promise.resolve({}) }
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    fetchCalls.push(url)
    if (String(url).includes('stock_scores_6axis')) return Promise.resolve(phase7Response)
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
// Prework
// ─────────────────────────────────────────────────────────────
describe('RA-007-D2 network prework ordering', () => {
  it('initialize starts loadPublishedData and the phase7 fetch exactly once each', async () => {
    const { manager, a } = pair()
    resetCounts()
    const pending = a.store.getState().initialize()
    await grant(manager, pending)
    expect(loadProbe.calls).toBe(1)
    expect(fetchCalls.filter(u => u.includes('stock_scores_6axis'))).toHaveLength(1)
  })

  it('refresh starts loadPublishedData exactly once and never fetches phase7', async () => {
    const { manager, a } = pair()
    resetCounts()
    const pending = a.store.getState().refreshAllData()
    await grant(manager, pending)
    expect(loadProbe.calls).toBe(1)
    expect(fetchCalls.filter(u => u.includes('stock_scores_6axis'))).toHaveLength(0)
  })

  it('starts network prework only after the local ticket, and before the Web Lock request', async () => {
    const { manager, a } = pair()
    resetCounts()
    const pending = a.store.getState().initialize()
    await flush()
    // Prework has started (loadPublishedData already called) and the lock has already been
    // requested — both happen synchronously before the grant, in ticket -> prework -> lock order.
    expect(loadProbe.calls).toBe(1)
    expect(manager.requests).toHaveLength(1)
    await grant(manager, pending)
  })

  it('duplicate same-store call performs zero additional network requests', async () => {
    const { manager, a } = pair()
    resetCounts()
    const pending = a.store.getState().initialize()
    await flush()
    const duplicate = await a.store.getState().initialize()
    expect(duplicate).toEqual(createPortfolioCoordinationFailure('initialize', 'LOCAL_OPERATION_BUSY'))
    expect(loadProbe.calls).toBe(1)
    expect(manager.requests).toHaveLength(1)
    await grant(manager, pending)
  })

  it('duplicate same-store call requests the Web Lock zero additional times', async () => {
    const { manager, a } = pair()
    resetCounts()
    const pending = a.store.getState().refreshAllData()
    await flush()
    await a.store.getState().refreshAllData()
    expect(manager.requests).toHaveLength(1)
    await grant(manager, pending)
  })

  it('performs zero state or storage reads before grant', async () => {
    const { manager, a } = pair()
    resetCounts()
    const pending = a.store.getState().initialize()
    await flush()
    expect(storageCounts.get).toBe(0)
    await grant(manager, pending)
  })

  it('never reads Zustand state (get()) before grant', async () => {
    const { manager, a } = pair()
    const root = a.store.getState()
    let holdingsReads = 0
    const holdings = root.holdings
    Object.defineProperty(root, 'holdings', {
      configurable: true,
      get: () => { holdingsReads += 1; return holdings },
    })
    const pending = a.store.getState().refreshAllData()
    await flush()
    expect(holdingsReads).toBe(0)
    await grant(manager, pending)
  })

  it('performs zero publication before grant', async () => {
    const { manager, a } = pair()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const pending = a.store.getState().refreshAllData()
    await flush()
    expect(notifications).toBe(0)
    await grant(manager, pending)
  })

  it('prework continues to progress while the request is queued behind another pending request', async () => {
    const { manager, a, b } = pair()
    const aPending = a.store.getState().updateHolding(a.store.getState().holdings[0].code, { eval: 1 })
    await flush()
    const bPending = b.store.getState().initialize()
    await flush()
    // b's prework already started even though b is still queued behind a's pending request.
    expect(loadProbe.calls).toBe(1)
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toHaveLength(2)
    await grant(manager, aPending)
    await grant(manager, bPending)
  })
})

// ─────────────────────────────────────────────────────────────
// Capability / settled outcomes
// ─────────────────────────────────────────────────────────────
describe('RA-007-D2 Web Lock capability results and settled prework', () => {
  it('classifies WEB_LOCK_UNAVAILABLE and permits a later retry', async () => {
    const unavailable: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_UNAVAILABLE')
      },
    }
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: unavailable })
    baselineStore(instance.store)
    const result = await instance.store.getState().initialize()
    expect(result).toEqual(createPortfolioCoordinationFailure('initialize', 'WEB_LOCK_UNAVAILABLE'))

    const manager = new FakeLockManager()
    const retryInstance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(retryInstance.store)
    const retry = retryInstance.store.getState().initialize()
    await expect(grant(manager, retry)).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('classifies WEB_LOCK_TIMEOUT before grant and permits a later retry', async () => {
    let timeoutCallback: (() => void) | null = null
    const timerApi: PortfolioGenerationLockTimerApi = {
      setTimeout(callback) { timeoutCallback = callback; return 1 as ReturnType<typeof setTimeout> },
      clearTimeout() { timeoutCallback = null },
    }
    const manager = new FakeLockManager()
    const timeoutAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 10, timerApi })
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: timeoutAdapter })
    baselineStore(instance.store)
    const pending = instance.store.getState().refreshAllData()
    await flush()
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback!()
    await expect(pending).resolves.toEqual(createPortfolioCoordinationFailure('refreshAllData', 'WEB_LOCK_TIMEOUT'))
    expect(instance.controls.inspect().activeOperationKind).toBeNull()

    const retry = instance.store.getState().refreshAllData()
    await expect(grant(manager, retry)).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('classifies WEB_LOCK_ABORTED unchanged', async () => {
    const abortedAdapter: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_ABORTED')
      },
    }
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: abortedAdapter })
    baselineStore(instance.store)
    expect(await instance.store.getState().initialize())
      .toEqual(createPortfolioCoordinationFailure('initialize', 'WEB_LOCK_ABORTED'))
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
  })

  it('classifies WEB_LOCK_REQUEST_FAILED and permits a later retry', async () => {
    let attempts = 0
    const requestFailure = createPortfolioGenerationLockAdapter({
      lockManager: {
        request: (_name, _options, callback) => {
          attempts += 1
          if (attempts === 1) throw new Error('request failed')
          return Promise.resolve(callback({} as Lock))
        },
      },
    })
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: requestFailure })
    baselineStore(instance.store)
    expect(await instance.store.getState().refreshAllData())
      .toEqual(createPortfolioCoordinationFailure('refreshAllData', 'WEB_LOCK_REQUEST_FAILED'))
    expect(await instance.store.getState().refreshAllData()).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(attempts).toBe(2)
  })

  it('never leaks a raw network rejection: settled prework absorbs it as LOAD_DATA_ERROR with zero unhandled rejections', async () => {
    const nodeProcess = (globalThis as Record<string, unknown>).process as { on: Function; off: Function } | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    nodeProcess?.on('unhandledRejection', onUnhandled)
    try {
      loadProbe.implementation = () => Promise.reject(new Error('raw network sentinel'))
      const { manager, a } = pair()
      const pending = a.store.getState().initialize()
      const result = await grant(manager, pending)
      expect(result).toEqual({ ok: false, operation: 'initialize', code: 'LOAD_DATA_ERROR', retryable: true })
      expect(JSON.stringify(result)).not.toContain('raw network sentinel')
      await flush()
      expect(unhandled).toEqual([])
    } finally {
      nodeProcess?.off('unhandledRejection', onUnhandled)
    }
  })

  it('a late prework rejection after timeout is still captured with zero unhandled rejections', async () => {
    const nodeProcess = (globalThis as Record<string, unknown>).process as { on: Function; off: Function } | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    nodeProcess?.on('unhandledRejection', onUnhandled)
    try {
      let rejectFetch!: (reason: unknown) => void
      loadProbe.implementation = () => new Promise((_resolve, reject) => { rejectFetch = reject })
      let timeoutCallback: (() => void) | null = null
      const timerApi: PortfolioGenerationLockTimerApi = {
        setTimeout(callback) { timeoutCallback = callback; return 1 as ReturnType<typeof setTimeout> },
        clearTimeout() { timeoutCallback = null },
      }
      const manager = new FakeLockManager()
      const timeoutAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 10, timerApi })
      const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: timeoutAdapter })
      baselineStore(instance.store)
      const pending = instance.store.getState().initialize()
      await flush()
      timeoutCallback!()
      await expect(pending).resolves.toEqual(createPortfolioCoordinationFailure('initialize', 'WEB_LOCK_TIMEOUT'))
      rejectFetch(new Error('late rejection after timeout'))
      await flush()
      expect(unhandled).toEqual([])
    } finally {
      nodeProcess?.off('unhandledRejection', onUnhandled)
    }
  })

  it('WEB_LOCK_TIMEOUT permits retry and WEB_LOCK_REQUEST_FAILED permits retry (both already covered above) — duplicate network request stays at exactly one per attempt', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager, 10) })
    baselineStore(instance.store)
    resetCounts()
    const pending = instance.store.getState().initialize()
    await grant(manager, pending)
    expect(loadProbe.calls).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────
// Initialize bootstrap semantics
// ─────────────────────────────────────────────────────────────
describe('RA-007-D2 initialize bootstrap semantics', () => {
  it('bootstraps from the latest durable canonical even when local Zustand state is stale', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    const durableHolding = { ...TEST_HOLDING, code: 'DURABLE', eval: 999_000 }
    seedCanonical(a.store.getState(), { holdings: [durableHolding] })
    // Local state still shows the stale baseline holding, not the durable one.
    a.store.setState({ holdings: [{ ...TEST_HOLDING, code: 'STALE-LOCAL', eval: 1 }] })

    const pending = a.store.getState().initialize()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().holdings.map(h => h.code)).toEqual(['DURABLE'])
  })

  it('never returns CROSS_TAB_STATE_STALE', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    seedCanonical(a.store.getState())
    a.store.setState({ holdings: [{ ...TEST_HOLDING, code: 'DIFFERENT', eval: 42 }] })
    const pending = a.store.getState().initialize()
    const result = await grant(manager, pending)
    expect(result).not.toMatchObject({ code: 'CROSS_TAB_STATE_STALE' })
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('canonical invalid returns LOAD_RESTORE_ERROR with zero legacy fallback, zero network application, zero analysis, zero persistence, zero publication', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    storage.v81_portfolio = JSON.stringify({ data: [{ ...TEST_HOLDING, code: 'LEGACY-SHOULD-NOT-APPLY' }], savedAt: NOW_MS })
    resetCounts()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const before = a.store.getState()

    const pending = a.store.getState().initialize()
    const result = await grant(manager, pending)

    expect(result).toEqual({ ok: false, operation: 'initialize', code: 'LOAD_RESTORE_ERROR', retryable: false })
    expect(a.store.getState()).toBe(before)
    expect(a.store.getState().holdings.some(h => h.code === 'LEGACY-SHOULD-NOT-APPLY')).toBe(false)
    expect(analysisProbe.calls).toBe(0)
    expect(notifications).toBe(0)
  })

  it('canonical absent restores from legacy without double-applying cash/policy defaults', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    storage.v81_portfolio = JSON.stringify({ data: [{ ...TEST_HOLDING, code: 'LEGACY-OK' }], savedAt: NOW_MS })
    storage.v13_cash_assumptions = JSON.stringify({
      data: { cashDeposits: 7_000_000, standbyFunds: 1_000_000, manualOverrideEnabled: true, manualUpdatedAt: NOW_ISO },
      savedAt: NOW_MS,
    })
    const pending = a.store.getState().initialize()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().holdings.map(h => h.code)).toEqual(['LEGACY-OK'])
    expect(a.store.getState().cashAssumptions.cashDeposits).toBe(7_000_000)
  })

  it('durable evidence absent bootstraps from the initial default state', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const defaultHoldings = a.store.getState().holdings
    const pending = a.store.getState().initialize()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().holdings).toEqual(defaultHoldings)
  })

  it('manual success then initialize succeeds', async () => {
    const { manager, a } = pair()
    const first = a.store.getState().updateHolding(a.store.getState().holdings[0].code, { eval: 1 })
    await grant(manager, first)
    const initializeResult = await grant(manager, a.store.getState().initialize())
    expect(initializeResult).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('snapshot import then initialize succeeds', async () => {
    const { manager, a, b } = pair()
    b.store.setState({ holdings: [{ ...TEST_HOLDING, code: 'SNAP-BOOTSTRAP', eval: 850_000 }] })
    const raw = b.store.getState().exportPortfolioSnapshot()
    emptyStore(a.store)
    const snapshotResult = await grant(manager, a.store.getState().importPortfolioSnapshot(raw))
    expect(snapshotResult).toMatchObject({ ok: true })
    const initializeResult = await grant(manager, a.store.getState().initialize())
    expect(initializeResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().holdings.map(h => h.code)).toEqual(['SNAP-BOOTSTRAP'])
  })

  it('initialize then initialize (FIFO) both succeed across two stores sharing the same lock', async () => {
    const { manager, a, b } = pair()
    const first = a.store.getState().initialize()
    const second = b.store.getState().initialize()
    await flush()
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toHaveLength(2)
    const firstResult = await grant(manager, first)
    expect(firstResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    const secondResult = await grant(manager, second)
    expect(secondResult).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// ─────────────────────────────────────────────────────────────
// Refresh stale fail-closed semantics
// ─────────────────────────────────────────────────────────────
describe('RA-007-D2 refresh stale fail-closed semantics', () => {
  it('aligned refresh succeeds', async () => {
    const { manager, a } = pair()
    const pending = a.store.getState().refreshAllData()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it.each([
    ['manual', (a: ReturnType<typeof createAppStoreInstanceForTest>, manager: FakeLockManager) =>
      grant(manager, a.store.getState().updateHolding(a.store.getState().holdings[0].code, { eval: 2 }))],
  ] as const)('%s success on B then refresh on A is stale', async (_label, mutate) => {
    const { manager, a, b } = pair()
    await mutate(b, manager)
    const refreshResult = await grant(manager, a.store.getState().refreshAllData())
    expect(refreshResult).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
  })

  it('snapshot success on B then refresh on A is stale', async () => {
    const { manager, a, b } = pair()
    const source = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(new FakeLockManager()) })
    source.store.setState({ holdings: [{ ...TEST_HOLDING, code: 'SNAP-DIFFERENT', eval: 650_000 }] })
    const raw = source.store.getState().exportPortfolioSnapshot()
    emptyStore(b.store)
    const snapshotResult = await grant(manager, b.store.getState().importPortfolioSnapshot(raw))
    expect(snapshotResult).toMatchObject({ ok: true })
    const refreshResult = await grant(manager, a.store.getState().refreshAllData())
    expect(refreshResult).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
  })

  it('CSV success on B then refresh on A is stale', async () => {
    const { manager, a, b } = pair()
    emptyStore(b.store)
    const csvContent = [
      'データ基準日時,2026-07-20T11:00:00+09:00',
      '株式（現物/特定預り）',
      '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
      '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
    ].join('\n')
    const file = new File([csvContent], 'p.csv', { type: 'text/csv' })
    const csvResult = await grant(manager, b.store.getState().importCsv(file))
    expect(csvResult).toMatchObject({ ok: true })
    const refreshResult = await grant(manager, a.store.getState().refreshAllData())
    expect(refreshResult).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
  })

  it('initialize changes A projection, then a second refresh on A is stale relative to B', async () => {
    const { manager, a, b } = pair()
    seedCanonical(a.store.getState(), { holdings: [{ ...TEST_HOLDING, code: 'INIT-CHANGED' }] })
    await grant(manager, a.store.getState().initialize())
    const refreshResult = await grant(manager, b.store.getState().refreshAllData())
    expect(refreshResult).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
  })

  it('refresh that changes A projection makes a queued refresh on B stale', async () => {
    const { manager, a, b } = pair()
    const p1 = a.store.getState().refreshAllData()
    await grant(manager, p1)
    seedCanonical(a.store.getState(), { holdings: [{ ...TEST_HOLDING, code: 'REFRESH-CHANGED' }] })
    // A's local projection now differs from B's stale published projection.
    a.store.setState({ holdings: [{ ...TEST_HOLDING, code: 'REFRESH-CHANGED' }] })
    const refreshResult = await grant(manager, b.store.getState().refreshAllData())
    expect(refreshResult).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
  })

  it('a preceding refresh that only changes market/news data does not block a following refresh', async () => {
    const { manager, a } = pair()
    const first = await grant(manager, a.store.getState().refreshAllData())
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const second = await grant(manager, a.store.getState().refreshAllData())
    expect(second).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('a preceding LOAD_DATA_ERROR leaves durable state untouched and permits the next operation', async () => {
    const { manager, a } = pair()
    loadProbe.implementation = async () => { throw new Error('injected') }
    const failed = await grant(manager, a.store.getState().refreshAllData())
    expect(failed).toMatchObject({ ok: false, code: 'LOAD_DATA_ERROR' })
    loadProbe.implementation = null
    const next = await grant(manager, a.store.getState().refreshAllData())
    expect(next).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('a preceding LOAD_ANALYSIS_ERROR leaves durable state untouched and permits the next operation', async () => {
    const { manager, a } = pair()
    analysisProbe.fail = true
    const failed = await grant(manager, a.store.getState().refreshAllData())
    expect(failed).toMatchObject({ ok: false, code: 'LOAD_ANALYSIS_ERROR' })
    analysisProbe.fail = false
    const next = await grant(manager, a.store.getState().refreshAllData())
    expect(next).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('a LOAD_PERSISTENCE_ERROR with zero commit permits the next operation', async () => {
    const { manager, a } = pair()
    const originalSetItem = localStorageMock.setItem
    let throwOnSet = false
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (throwOnSet) throw new Error('injected persistence failure')
        originalSetItem(key, value)
      },
    })
    throwOnSet = true
    const failed = await grant(manager, a.store.getState().refreshAllData())
    expect(failed).toMatchObject({ ok: false, code: 'LOAD_PERSISTENCE_ERROR' })
    throwOnSet = false
    const next = await grant(manager, a.store.getState().refreshAllData())
    expect(next).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('canonical invalid returns LOAD_PERSISTENCE_ERROR, never misclassified as stale', async () => {
    const { manager, a } = pair()
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    const result = await grant(manager, a.store.getState().refreshAllData())
    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'LOAD_PERSISTENCE_ERROR', retryable: true })
  })

  it('stale refresh applies zero prework results, zero analysis, zero persistence, zero publication', async () => {
    const { manager, a, b } = pair()
    await grant(manager, b.store.getState().updateHolding(b.store.getState().holdings[0].code, { eval: 3 }))
    resetCounts()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const before = a.store.getState()
    const result = await grant(manager, a.store.getState().refreshAllData())
    expect(result).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
    expect(analysisProbe.calls).toBe(0)
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────
// Lock lifetime
// ─────────────────────────────────────────────────────────────
describe('RA-007-D2 lock lifetime', () => {
  it('holds the lock and local ticket through restore, data await, analysis, persistence, publish, and subscriber; nested operations are LOCAL_OPERATION_BUSY with zero nested Web Lock requests', async () => {
    const { manager, a, b } = pair()
    const heldSamples: boolean[] = []
    let heldInSubscriber = false
    let ticketInSubscriber: string | null = null
    let requestsInSubscriber = -1
    let nestedInitialize: ReturnType<AppStoreState['initialize']> | null = null
    let nestedRefresh: ReturnType<AppStoreState['refreshAllData']> | null = null
    let nestedManual: ReturnType<AppStoreState['setPortfolioPolicy']> | null = null
    let nestedSnapshot: ReturnType<AppStoreState['importPortfolioSnapshot']> | null = null

    const originalSetItem = localStorageMock.setItem
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        heldSamples.push(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME))
        originalSetItem(key, value)
      },
    })

    a.store.subscribe(() => {
      heldInSubscriber = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      ticketInSubscriber = a.controls.inspect().activeOperationKind
      requestsInSubscriber = manager.requests.length
      nestedInitialize = a.store.getState().initialize()
      nestedRefresh = a.store.getState().refreshAllData()
      nestedManual = a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
      nestedSnapshot = a.store.getState().importPortfolioSnapshot(a.store.getState().exportPortfolioSnapshot())
    })

    const requestsBeforeGrant = manager.requests.length
    const pending = a.store.getState().initialize()
    await flush()
    const result = await grant(manager, pending)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(heldSamples.length).toBeGreaterThan(0)
    expect(heldSamples.every(Boolean)).toBe(true)
    expect(heldInSubscriber).toBe(true)
    expect(ticketInSubscriber).toBe('initialize')
    expect(requestsInSubscriber).toBe(requestsBeforeGrant + 1)

    expect(await nestedInitialize!).toEqual(createPortfolioCoordinationFailure('initialize', 'LOCAL_OPERATION_BUSY'))
    expect(await nestedRefresh!).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'LOCAL_OPERATION_BUSY'))
    expect(await nestedManual!).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'LOCAL_OPERATION_BUSY'))
    expect(await nestedSnapshot!).toEqual(createPortfolioCoordinationFailure('importPortfolioSnapshot', 'LOCAL_OPERATION_BUSY'))
    expect(manager.requests).toHaveLength(requestsBeforeGrant + 1)
    expect(manager.events.findIndex(e => e.type === 'released')).toBeGreaterThan(
      manager.events.findIndex(e => e.type === 'callback_resolved'),
    )

    // Web Lock is released only after the synchronous subscriber completes; the next grant for
    // an independent store proceeds normally afterward (initialize always succeeds regardless
    // of alignment, so this isolates the "next grant happens" claim from projection drift caused
    // by analysis-derived fields differing between the two stores' holdings).
    const bPending = b.store.getState().initialize()
    await expect(grant(manager, bPending)).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('CSV import is still blocked while initialize holds the ticket', async () => {
    const { manager, a } = pair()
    const pending = a.store.getState().initialize()
    await flush()
    const csvFile = new File(['x'], 'p.csv', { type: 'text/csv' })
    const nestedCsv = await a.store.getState().importCsv(csvFile)
    expect(nestedCsv).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    await grant(manager, pending)
  })

  it('a nested manual mutation is LOCAL_OPERATION_BUSY while refresh holds the ticket', async () => {
    const { manager, a } = pair()
    const pending = a.store.getState().refreshAllData()
    await flush()
    const nested = await a.store.getState().updateHolding(a.store.getState().holdings[0].code, { eval: 1 })
    expect(nested).toEqual(createPortfolioCoordinationFailure('updateHolding', 'LOCAL_OPERATION_BUSY'))
    await grant(manager, pending)
  })
})

// ─────────────────────────────────────────────────────────────
// Publish failure and subscriber-throw semantics
// ─────────────────────────────────────────────────────────────
describe('RA-007-D2 publish hook failure and subscriber throw', () => {
  it('publish hook failure after persistence success: durable committed, local staged state not applied, LOAD_PUBLISH_ERROR, then next refresh is stale and next initialize can still succeed', async () => {
    const { manager, a } = pair()
    a.controls.setLoadPublishBeforeApplyHook(() => { throw new Error('publish sentinel') })
    const before = a.store.getState()
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toEqual({ ok: false, operation: 'initialize', code: 'LOAD_PUBLISH_ERROR', retryable: false })
    expect(a.store.getState()).toBe(before)

    const staleRefresh = await grant(manager, a.store.getState().refreshAllData())
    expect(staleRefresh).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))

    const bootstrapInitialize = await grant(manager, a.store.getState().initialize())
    expect(bootstrapInitialize).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('a throwing subscriber after apply still yields SUCCESS with zero double publication and zero raw error exposure', async () => {
    const { manager, a } = pair()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let notifications = 0
    a.store.subscribe(() => {
      notifications += 1
      throw new Error('raw subscriber sentinel')
    })
    const result = await grant(manager, a.store.getState().refreshAllData())
    expect(result).toEqual({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    expect(notifications).toBe(1)
    expect(errorSpy).toHaveBeenCalled()
    const loggedRaw = errorSpy.mock.calls.some(args =>
      args.some(arg => arg instanceof Error && arg.message.includes('raw subscriber sentinel')),
    )
    expect(loggedRaw).toBe(true)
    errorSpy.mockRestore()
  })
})
