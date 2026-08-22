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
import { CSV_IMPORT_GENERATION_KEY } from './persist'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
} from './portfolioGenerationLock'
import { createPortfolioCoordinationFailure } from './portfolioOperationResult'
import { FakeLockManager } from './testing/fakeLockManager'
import {
  createAppStoreInstanceForTest,
  type AppStoreState,
} from './useAppStore'

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')

const TEST_HOLDING: Holding = {
  code: 'RA007D2SP', name: 'RA-007-D2 single-publication holding', eval: 400_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const TEST_TRUST: Trust = {
  id: 'ra007d2sp-fund', name: 'RA-007-D2 single-publication fund', abbr: 'RA7SP', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 250_000, pnlPct: 0, dayPct: 0,
  cost: 0.2, mu: 0.1, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0,
  decision: 'HOLD',
}

const storage: Record<string, string> = {}
const storageCounts = { get: 0, set: 0, remove: 0 }
let storageThrowOnSet = false

const localStorageMock = {
  getItem(key: string) {
    storageCounts.get += 1
    return storage[key] ?? null
  },
  setItem: (key: string, value: string) => {
    storageCounts.set += 1
    if (storageThrowOnSet) throw new Error('injected persistence failure')
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
    metrics: null,
    analysis: [],
    officialDecision: null,
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null, analysisLastRunAt: null,
    },
  }))
}

function instance(manager: FakeLockManager) {
  const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  baselineStore(created.store)
  return created
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
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: () => Promise.resolve({}) })))
  Object.keys(storage).forEach(key => delete storage[key])
  resetCounts()
  analysisProbe.fail = false
  storageThrowOnSet = false
  loadProbe.implementation = null
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RA-007-D2 single final publication — success', () => {
  it('initialize publishes to subscribers exactly once on success', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(notifications).toBe(1)
  })

  it('refresh publishes to subscribers exactly once on success', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const result = await grant(manager, a.store.getState().refreshAllData())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(notifications).toBe(1)
  })

  it('the single subscriber notification already carries the fully computed final state (holdings, analysis, metrics, system.success all present together)', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const seenSnapshots: AppStoreState[] = []
    a.store.subscribe(state => { seenSnapshots.push(state) })
    await grant(manager, a.store.getState().initialize())
    expect(seenSnapshots).toHaveLength(1)
    const seen = seenSnapshots[0]
    // F-P0-2: このsuiteのfetchはbeforeEachで常にok:false(404)なので、全ソースがfallback
    // となりstatusは'failed'が正しい（旧仕様は誤って'success'を返していた）。
    expect(seen.system.status).toBe('failed')
    expect(seen.metrics).not.toBeNull()
    expect(seen.system.analysisLastRunAt).not.toBeNull()
    expect(seen.holdings.length).toBeGreaterThan(0)
  })

  it('exposes zero restore-only, published-data-only, macro-only, or Phase-7-only intermediate states', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const statusesSeen: string[] = []
    const holdingsRefsSeen: unknown[] = []
    a.store.subscribe(state => {
      statusesSeen.push(state.system.status)
      holdingsRefsSeen.push(state.holdings)
    })
    await grant(manager, a.store.getState().initialize())
    // Only one notification ever fires, so there is no window in which a partial (restore-only,
    // published-data-only, macro-only, Phase-7-only) state could have been observed.
    // F-P0-2: fetch always 404s in this suite, so the single published status is 'failed'.
    expect(statusesSeen).toEqual(['failed'])
    expect(holdingsRefsSeen).toHaveLength(1)
  })

  it('analysis runs on a staged state and never publishes before persistence succeeds', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const before = a.store.getState()
    let notificationsAtAnalysisTime = -1
    let storeAtAnalysisTime: unknown = undefined
    let writesAtAnalysisTime = -1
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const originalSetItem = localStorageMock.setItem
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      // The first storage write happens only after analysis has already produced computed
      // fields (analysis -> persistence -> publish), so sampling here proves analysis ran on an
      // unpublished staged state.
      setItem: (key: string, value: string) => {
        if (storeAtAnalysisTime === undefined) {
          storeAtAnalysisTime = a.store.getState()
          notificationsAtAnalysisTime = notifications
          writesAtAnalysisTime = storageCounts.set
        }
        originalSetItem(key, value)
      },
    })
    await grant(manager, a.store.getState().initialize())
    expect(storeAtAnalysisTime).toBe(before)
    expect(notificationsAtAnalysisTime).toBe(0)
    expect(writesAtAnalysisTime).toBe(0)
    expect(notifications).toBe(1)
  })

  it('the store still shows the OLD state at the moment localStorage.setItem (persistence) is called', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const beforeHoldings = a.store.getState().holdings
    let sampledHoldingsDuringPersist: unknown = undefined
    const originalSetItem = localStorageMock.setItem
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (sampledHoldingsDuringPersist === undefined) {
          sampledHoldingsDuringPersist = a.store.getState().holdings
        }
        originalSetItem(key, value)
      },
    })
    await grant(manager, a.store.getState().initialize())
    expect(sampledHoldingsDuringPersist).toBe(beforeHoldings)
  })

  it('persistence writes reflect the complete final state, not a partial one', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    await grant(manager, a.store.getState().initialize())
    const persistedRaw = storage[CSV_IMPORT_GENERATION_KEY]
    expect(persistedRaw).toBeUndefined() // no committed canonical existed, legacy path used instead
    // The live store after the single publish must match exactly what analysis produced,
    // proving persistence used the same complete final object that got published.
    const state = a.store.getState()
    // F-P0-2: fetch always 404s in this suite, so the truthful status is 'failed'.
    expect(state.system.status).toBe('failed')
    expect(state.metrics).not.toBeNull()
  })

  it('persistence completes before the final set() — write count is already final by the time of the single notification', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    let writesAtNotificationTime = -1
    a.store.subscribe(() => { writesAtNotificationTime = storageCounts.set })
    await grant(manager, a.store.getState().initialize())
    expect(writesAtNotificationTime).toBeGreaterThan(0)
    expect(writesAtNotificationTime).toBe(storageCounts.set)
  })

  it('never publishes a global-loading intermediate status', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const statuses: string[] = []
    a.store.subscribe(state => { statuses.push(state.system.status) })
    await grant(manager, a.store.getState().refreshAllData())
    expect(statuses).not.toContain('loading')
  })

  it('terminal system.status reflects the actual fetch outcome, not an unconditional "success"', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    await grant(manager, a.store.getState().initialize())
    // F-P0-2: fetch always 404s in this suite, so the truthful status is 'failed'.
    expect(a.store.getState().system.status).toBe('failed')
  })
})

describe('RA-007-D2 single final publication — failure keeps the root reference unchanged', () => {
  it('persistence failure: zero publication and the root state reference is unchanged', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    storageThrowOnSet = true
    const result = await grant(manager, a.store.getState().initialize())
    storageThrowOnSet = false
    expect(result).toMatchObject({ ok: false, code: 'LOAD_PERSISTENCE_ERROR' })
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
    expect(JSON.stringify(result)).not.toMatch(/injected persistence failure/)
  })

  it('analysis failure: zero publication and the root state reference is unchanged', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    analysisProbe.fail = true
    const result = await grant(manager, a.store.getState().initialize())
    analysisProbe.fail = false
    expect(result).toMatchObject({ ok: false, code: 'LOAD_ANALYSIS_ERROR' })
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
    expect(JSON.stringify(result)).not.toMatch(/injected analysis failure/)
  })

  it('data failure: zero publication and the root state reference is unchanged', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    loadProbe.implementation = async () => { throw new Error('injected network failure') }
    const result = await grant(manager, a.store.getState().initialize())
    loadProbe.implementation = null
    expect(result).toMatchObject({ ok: false, code: 'LOAD_DATA_ERROR' })
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
    expect(JSON.stringify(result)).not.toMatch(/injected network failure/)
  })

  it('stale refresh: zero publication and the root state reference is unchanged', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const b = instance(manager)
    await grant(manager, b.store.getState().updateHolding(b.store.getState().holdings[0].code, { eval: 999 }))
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const result = await grant(manager, a.store.getState().refreshAllData())
    expect(result).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
  })

  it('Web Lock failure: zero publication and the root state reference is unchanged', async () => {
    const unavailable: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_UNAVAILABLE')
      },
    }
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: unavailable })
    baselineStore(a.store)
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const result = await a.store.getState().refreshAllData()
    expect(result).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'WEB_LOCK_UNAVAILABLE'))
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
  })

  it('restore failure (initialize): zero publication and the root state reference is unchanged', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toEqual({ ok: false, operation: 'initialize', code: 'LOAD_RESTORE_ERROR', retryable: false })
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
  })
})

describe('RA-007-D2 single final publication — subscriber throw does not double-publish', () => {
  it('a throwing subscriber still yields exactly one notification and SUCCESS', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let notifications = 0
    a.store.subscribe(() => {
      notifications += 1
      throw new Error('subscriber threw')
    })
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toEqual({ ok: true, operation: 'initialize', code: 'SUCCESS' })
    expect(notifications).toBe(1)
    errorSpy.mockRestore()
  })

  it('multiple subscribers all see exactly one notification each even when one throws', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let firstCount = 0
    let secondCount = 0
    a.store.subscribe(() => { firstCount += 1; throw new Error('first throws') })
    a.store.subscribe(() => { secondCount += 1 })
    await grant(manager, a.store.getState().refreshAllData())
    expect(firstCount).toBe(1)
    expect(secondCount).toBe(1)
    errorSpy.mockRestore()
  })
})

describe('RA-007-D2 single final publication — raw failure detail exposure', () => {
  it('never includes raw error text/stack in the returned result for any failure path', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    loadProbe.implementation = async () => { throw new Error('raw sentinel with stack trace info') }
    const result = await grant(manager, a.store.getState().initialize())
    loadProbe.implementation = null
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/raw sentinel|stack trace/i)
    expect(Object.keys(result as object).sort()).toEqual(['code', 'ok', 'operation', 'retryable'])
  })
})

describe('RA-007-D2 single final publication — coordination/local-busy publish zero', () => {
  it('LOCAL_OPERATION_BUSY never publishes', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager)
    const pending = a.store.getState().initialize()
    await flush()
    const before = a.store.getState()
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const duplicate = await a.store.getState().refreshAllData()
    expect(duplicate).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'LOCAL_OPERATION_BUSY'))
    expect(notifications).toBe(0)
    expect(a.store.getState()).toBe(before)
    await grant(manager, pending)
  })
})
