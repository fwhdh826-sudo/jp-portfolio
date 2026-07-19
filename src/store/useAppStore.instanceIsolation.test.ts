import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadProbe = vi.hoisted(() => ({
  implementation: null as null | (() => Promise<unknown>),
}))

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async () => {
      if (loadProbe.implementation) return loadProbe.implementation()
      throw new Error('instance-isolation load fixture was not installed')
    },
  }
})

import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import type { Holding } from '../types'
import {
  DEFAULT_CANDIDATES_NEWS_DATA,
  DEFAULT_CANDIDATES_STOCKS_DATA,
  DEFAULT_REGIME_STATE,
  DEFAULT_SAFE_MODE_SNAPSHOT,
  DEFAULT_TIER_A_ALERTS_SNAPSHOT,
  DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
} from '../services/loadStaticData'
import {
  acquirePortfolioOperation,
  createAppStoreInstanceForTest as createAppStoreInstanceWithOptionsForTest,
  readLastAppliedSnapshotGenerationForTest,
  releasePortfolioOperation,
  resetPortfolioGenerationLockAdapterForTest,
  resetPortfolioGenerationTestSeams,
  setLoadPublishBeforeApplyHookForTest,
  setLoadRestoreBeforeReadHookForTest,
  setManualPublishBeforeApplyHookForTest,
  setPortfolioGenerationPhaseObserverForTest,
  setPortfolioGenerationLockAdapterForTest,
  useAppStore,
  type AppStoreState,
} from './useAppStore'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'

function createAppStoreInstanceForTest() {
  return createAppStoreInstanceWithOptionsForTest({
    portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
  })
}

class TestFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File): void {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const FIXED_NOW = new Date('2026-07-20T03:00:00.000Z')
const VALID_CSV = [
  'データ基準日時,2026-07-20T02:00:00.000Z',
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  'テスト投信,10000,250000,5.00,0.10,',
].join('\n')

const TEST_HOLDING: Holding = {
  code: 'INSTANCE', name: 'instance test holding', eval: 100_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

const defaultInitialState = useAppStore.getState()

function publishedData() {
  return {
    market: { data: defaultInitialState.market, source: 'static' },
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

function clearStorage(): void {
  Object.keys(storage).forEach(key => delete storage[key])
}

function emptyPortfolioState(state: AppStoreState): Partial<AppStoreState> {
  return {
    holdings: [],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
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
      ...state.system,
      status: 'idle',
      error: null,
      csvLastImportedAt: null,
      csvImportProvenance: null,
      csvSyncSummary: null,
    },
  }
}

async function primeSnapshotCache(
  instance: ReturnType<typeof createAppStoreInstanceForTest>,
  code: string,
): Promise<void> {
  instance.store.setState(state => ({
    ...emptyPortfolioState(state),
    holdings: [{ ...TEST_HOLDING, code, name: `${code}銘柄`, eval: 321_000 }],
  }))
  const snapshot = instance.store.getState().exportPortfolioSnapshot()
  instance.store.setState(state => emptyPortfolioState(state))
  const result = await instance.store.getState().importPortfolioSnapshot(snapshot)
  expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
  expect(instance.controls.inspect().hasSnapshotCache).toBe(true)
}

function deferredFile() {
  let release!: (value: ArrayBuffer) => void
  const file = {
    name: 'pending.csv',
    lastModified: FIXED_NOW.getTime(),
    arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
  } as File
  return {
    file,
    release: () => release(new TextEncoder().encode(VALID_CSV).buffer),
  }
}

beforeEach(() => {
  setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest())
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  vi.stubGlobal('FileReader', TestFileReader)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  loadProbe.implementation = async () => publishedData()
  clearStorage()
  resetPortfolioGenerationTestSeams()
  useAppStore.setState(defaultInitialState, true)
})

afterEach(() => {
  const leaked = acquirePortfolioOperation('initialize')
  expect(leaked, 'default operation ticket leaked').not.toBeNull()
  if (leaked) expect(releasePortfolioOperation(leaked)).toBe(true)
  resetPortfolioGenerationTestSeams()
  resetPortfolioGenerationLockAdapterForTest()
  useAppStore.setState(defaultInitialState, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RA-007-B3 store instance isolation', () => {
  it('creates distinct StoreApi, root state, and action references without changing the default store', () => {
    const defaultBefore = useAppStore.getState()
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()

    expect(a.store).not.toBe(b.store)
    expect(a.store.getState()).not.toBe(b.store.getState())
    expect(a.store.getState().updateHolding).not.toBe(b.store.getState().updateHolding)
    expect(a.store.getState().initialize).not.toBe(b.store.getState().initialize)
    expect(useAppStore.getState()).toBe(defaultBefore)
  })

  it('isolates Zustand state and subscribers in both directions', () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    let aNotifications = 0
    let bNotifications = 0
    const unsubscribeA = a.store.subscribe(() => { aNotifications += 1 })
    const unsubscribeB = b.store.subscribe(() => { bNotifications += 1 })

    a.store.setState({ activeTab: 'T3' })
    expect(a.store.getState().activeTab).toBe('T3')
    expect(b.store.getState().activeTab).toBe('T0')
    expect({ aNotifications, bNotifications }).toEqual({ aNotifications: 1, bNotifications: 0 })

    b.store.setState({ activeTab: 'T5' })
    expect(a.store.getState().activeTab).toBe('T3')
    expect(b.store.getState().activeTab).toBe('T5')
    expect({ aNotifications, bNotifications }).toEqual({ aNotifications: 1, bNotifications: 1 })
    unsubscribeA()
    unsubscribeB()
  })

  it('isolates operation ownership, tokens, wrong-instance release, and cleanup', () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    const aTicket = a.controls.acquirePortfolioOperation('manual')!
    const bTicket = b.controls.acquirePortfolioOperation('manual')!

    expect(aTicket.token).not.toBe(bTicket.token)
    expect(a.controls.inspect().activeOperationKind).toBe('manual')
    expect(b.controls.inspect().activeOperationKind).toBe('manual')
    expect(b.controls.releasePortfolioOperation(aTicket)).toBe(false)
    expect(a.controls.releasePortfolioOperation(bTicket)).toBe(false)
    expect(a.controls.releasePortfolioOperation(aTicket)).toBe(true)
    expect(b.controls.inspect().activeOperationKind).toBe('manual')
    expect(b.controls.releasePortfolioOperation(bTicket)).toBe(true)
  })

  it('keeps default-wrapper ticket ownership independent from factory runtimes', () => {
    const a = createAppStoreInstanceForTest()
    const defaultTicket = acquirePortfolioOperation('manual')!
    const aTicket = a.controls.acquirePortfolioOperation('manual')!

    expect(defaultTicket.token).not.toBe(aTicket.token)
    expect(releasePortfolioOperation(aTicket)).toBe(false)
    expect(a.controls.releasePortfolioOperation(defaultTicket)).toBe(false)
    expect(releasePortfolioOperation(defaultTicket)).toBe(true)
    expect(a.controls.inspect().activeOperationKind).toBe('manual')
    expect(a.controls.releasePortfolioOperation(aTicket)).toBe(true)
  })

  it('blocks nested manual work only in the busy instance while B remains runnable', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    const ticket = a.controls.acquirePortfolioOperation('manual')!

    const blocked = await a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
    const bResult = await b.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })

    expect(blocked).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(bResult).not.toMatchObject({ code: 'LOCAL_OPERATION_BUSY' })
    expect(a.controls.releasePortfolioOperation(ticket)).toBe(true)
  })

  it('does not let an instance ticket block a default manual action', async () => {
    const a = createAppStoreInstanceForTest()
    const ticket = a.controls.acquirePortfolioOperation('manual')!

    const result = await useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })

    expect(result).not.toMatchObject({ code: 'LOCAL_OPERATION_BUSY' })
    expect(a.controls.inspect().activeOperationKind).toBe('manual')
    expect(a.controls.releasePortfolioOperation(ticket)).toBe(true)
  })

  it('subscriber reentry is busy only inside the publishing A instance', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    let nestedA: ReturnType<AppStoreState['setPortfolioPolicy']> | null = null
    let bNotifications = 0
    const unsubscribeA = a.store.subscribe(() => {
      nestedA ??= a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.18 })
    })
    const unsubscribeB = b.store.subscribe(() => { bNotifications += 1 })

    const outer = await a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })

    expect(outer).toMatchObject({ ok: true, code: 'SUCCESS' })
    await expect(nestedA).resolves.toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(bNotifications).toBe(0)
    expect(b.controls.inspect().activeOperationKind).toBeNull()
    unsubscribeA()
    unsubscribeB()
  })

  it('isolates simultaneous generation transactions, phase observers, and cleanup', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    const aPhases: string[] = []
    const bPhases: string[] = []
    a.controls.setPortfolioGenerationPhaseObserver((origin, phase) => { aPhases.push(`${origin}:${phase}`) })
    b.controls.setPortfolioGenerationPhaseObserver((origin, phase) => { bPhases.push(`${origin}:${phase}`) })
    const aPending = deferredFile()
    const bPending = deferredFile()
    const aPromise = a.store.getState().importCsv(aPending.file)
    await Promise.resolve()

    const bTicketDuringA = b.controls.acquirePortfolioOperation('manual')
    expect(bTicketDuringA).not.toBeNull()
    if (bTicketDuringA) expect(b.controls.releasePortfolioOperation(bTicketDuringA)).toBe(true)

    const bPromise = b.store.getState().importCsv(bPending.file)
    await Promise.resolve()
    const bStateWhilePending = b.store.getState()

    expect(a.controls.inspect()).toMatchObject({ activeGenerationOrigin: 'csv', activeGenerationPhase: 'READING' })
    expect(b.controls.inspect()).toMatchObject({ activeGenerationOrigin: 'csv', activeGenerationPhase: 'READING' })
    expect(a.controls.acquirePortfolioOperation('manual')).toBeNull()
    const bPhaseCountBeforeACompletes = bPhases.length

    aPending.release()
    await aPromise
    const aPhaseCountAfterA = aPhases.length
    expect(aPhaseCountAfterA).toBeGreaterThan(0)
    expect(bPhases).toHaveLength(bPhaseCountBeforeACompletes)
    expect(a.controls.inspect().activeGenerationOrigin).toBeNull()
    expect(b.controls.inspect().activeGenerationOrigin).toBe('csv')
    expect(b.store.getState()).toBe(bStateWhilePending)

    bPending.release()
    await bPromise
    expect(bPhases.length).toBeGreaterThan(0)
    expect(aPhases).toHaveLength(aPhaseCountAfterA)
    expect(b.controls.inspect().activeGenerationOrigin).toBeNull()
  })

  it('keeps snapshot caches local through success and manual invalidation', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    await primeSnapshotCache(a, 'CACHE-A')

    expect(a.controls.inspect().hasSnapshotCache).toBe(true)
    expect(b.controls.inspect().hasSnapshotCache).toBe(false)
    expect(readLastAppliedSnapshotGenerationForTest()).toBeNull()

    const holding = a.store.getState().holdings[0]
    const result = await a.store.getState().updateHolding(holding.code, { eval: holding.eval + 1 })
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.controls.inspect().hasSnapshotCache).toBe(false)
    expect(b.controls.inspect().hasSnapshotCache).toBe(false)
    expect(readLastAppliedSnapshotGenerationForTest()).toBeNull()
  })

  it('resets only the selected instance cache and leaves another cache intact', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    await primeSnapshotCache(a, 'RESET-A')
    clearStorage()
    await primeSnapshotCache(b, 'RESET-B')

    a.controls.reset()

    expect(a.controls.inspect().hasSnapshotCache).toBe(false)
    expect(b.controls.inspect().hasSnapshotCache).toBe(true)
    resetPortfolioGenerationTestSeams()
    expect(b.controls.inspect().hasSnapshotCache).toBe(true)
  })

  it('consumes manual hooks once in the owning instance and preserves other seams', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    let aCalls = 0
    let bCalls = 0
    a.controls.setManualPublishBeforeApplyHook(() => { aCalls += 1 })
    b.controls.setManualPublishBeforeApplyHook(() => { bCalls += 1 })

    await a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })

    expect({ aCalls, bCalls }).toEqual({ aCalls: 1, bCalls: 0 })
    expect(a.controls.inspect().hasManualPublishHook).toBe(false)
    expect(b.controls.inspect().hasManualPublishHook).toBe(true)
    a.controls.reset()
    expect(b.controls.inspect().hasManualPublishHook).toBe(true)
    resetPortfolioGenerationTestSeams()
    expect(b.controls.inspect().hasManualPublishHook).toBe(true)
  })

  it('isolates load restore and publish hooks between instances', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    let aRestore = 0
    let aPublish = 0
    let bRestore = 0
    let bPublish = 0
    a.controls.setLoadRestoreBeforeReadHook(() => { aRestore += 1 })
    a.controls.setLoadPublishBeforeApplyHook(() => { aPublish += 1 })
    b.controls.setLoadRestoreBeforeReadHook(() => { bRestore += 1 })
    b.controls.setLoadPublishBeforeApplyHook(() => { bPublish += 1 })

    await a.store.getState().initialize()

    expect({ aRestore, aPublish, bRestore, bPublish }).toEqual({
      aRestore: 1,
      aPublish: 1,
      bRestore: 0,
      bPublish: 0,
    })
    expect(a.controls.inspect()).toMatchObject({ hasLoadRestoreHook: false, hasLoadPublishHook: false })
    expect(b.controls.inspect()).toMatchObject({ hasLoadRestoreHook: true, hasLoadPublishHook: true })

    await b.store.getState().initialize()
    expect({ aRestore, aPublish, bRestore, bPublish }).toEqual({
      aRestore: 1,
      aPublish: 1,
      bRestore: 1,
      bPublish: 1,
    })
  })

  it('keeps default test-seam wrappers compatible and isolated from factory resets', async () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()
    let defaultManual = 0
    let defaultRestore = 0
    let defaultPublish = 0
    let defaultPhases = 0
    setManualPublishBeforeApplyHookForTest(() => { defaultManual += 1 })
    setLoadRestoreBeforeReadHookForTest(() => { defaultRestore += 1 })
    setLoadPublishBeforeApplyHookForTest(() => { defaultPublish += 1 })
    setPortfolioGenerationPhaseObserverForTest(() => { defaultPhases += 1 })
    a.controls.setManualPublishBeforeApplyHook(() => undefined)
    b.controls.setManualPublishBeforeApplyHook(() => undefined)

    a.controls.reset()
    await useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
    await useAppStore.getState().initialize()

    expect({ defaultManual, defaultRestore, defaultPublish }).toEqual({
      defaultManual: 1,
      defaultRestore: 1,
      defaultPublish: 1,
    })
    expect(defaultPhases).toBe(0)
    expect(b.controls.inspect().hasManualPublishHook).toBe(true)

    resetPortfolioGenerationTestSeams()
    expect(b.controls.inspect().hasManualPublishHook).toBe(true)
  })
})
