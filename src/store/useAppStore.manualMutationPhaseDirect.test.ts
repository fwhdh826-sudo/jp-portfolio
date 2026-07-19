import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadProbe = vi.hoisted(() => ({
  calls: 0,
  implementation: null as null | (() => Promise<unknown>),
}))

const analysisProbe = vi.hoisted(() => ({ calls: 0 }))

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
      return actual.computeAnalysis(...args)
    },
  }
})

import type { Holding } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { INITIAL_TRUST } from '../constants/trust'
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
  readLastAppliedSnapshotGenerationForTest,
  releasePortfolioOperation,
  resetPortfolioGenerationTestSeams,
  setPortfolioGenerationPhaseObserverForTest,
  useAppStore,
} from './useAppStore'

const CANONICAL_KEY = 'v13_csv_import_committed_generation'
const HOLDING_CODE = '1001'
const TRUST_ID = INITIAL_TRUST[0].id
const TEST_HOLDING: Holding = {
  code: HOLDING_CODE,
  name: 'phase test holding',
  eval: 100_000,
  pnlPct: 0,
  mu: 0.1,
  sigma: 0.2,
  sigmaSource: 'static',
  beta: 1,
  sector: 'test',
  target: 0,
  alert: 0,
  lock: false,
  mitsu: false,
  ma: false,
  rsi: 50,
  macd: false,
  vol: false,
  mom3m: 0,
  roe: 0,
  per: 0,
  pbr: 0,
  epsG: 0,
  cfOk: false,
  de: 0,
  divG: 0,
  score: 0,
  decision: 'HOLD',
  ev: 0,
}

const VALID_CSV = [
  'データ基準日時,2026-07-19T00:00:00.000Z',
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  `${HOLDING_CODE},phase test holding,1200,150000,8.00,0.50,2025-01-01`,
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  `${INITIAL_TRUST[0].name},10000,250000,5.00,0.10,`,
].join('\n')

class TestFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  readAsArrayBuffer(file: File): void {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const baseState = useAppStore.getState()
const storage: Record<string, string> = {}
const storageCounts = { get: 0, set: 0, remove: 0 }
const localStorageMock = {
  getItem: (key: string) => {
    storageCounts.get += 1
    return storage[key] ?? null
  },
  setItem: (key: string, value: string) => {
    storageCounts.set += 1
    storage[key] = value
  },
  removeItem: (key: string) => {
    storageCounts.remove += 1
    delete storage[key]
  },
}

function publishedData() {
  return {
    market: { data: baseState.market, source: 'static' },
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

function csvFile(content = VALID_CSV): File {
  return new File([content], 'phase.csv', { type: 'text/csv' })
}

function resetStore(options: { empty?: boolean } = {}): void {
  useAppStore.setState({
    ...baseState,
    holdings: options.empty ? [] : [{ ...TEST_HOLDING }],
    trust: options.empty ? [] : INITIAL_TRUST.map(fund => ({ ...fund })),
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: options.empty
      ? { ...DEFAULT_CASH_ASSUMPTIONS }
      : {
          cashDeposits: 10,
          standbyFunds: 20,
          manualOverrideEnabled: true,
          manualUpdatedAt: '2026-07-18T00:00:00.000Z',
        },
    analysis: [],
    metrics: null,
    learning: null,
    universe: null,
    officialDecision: null,
    zeroPlan: null,
    stockPlan: null,
    trustPlan: null,
    stockCandidates: [],
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

const actionNames = [
  'updateHolding',
  'updateTrust',
  'setPortfolioPolicy',
  'setCashAssumptions',
  'clearCashAssumptionsOverride',
  'importCashAssumptions',
] as const

function invokeAllManualActions(): void {
  const state = useAppStore.getState()
  state.updateHolding(HOLDING_CODE, { eval: 999_001 })
  state.updateTrust(TRUST_ID, { eval: 999_002 })
  state.setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
  state.setCashAssumptions({ cashDeposits: 999_003, standbyFunds: 999_004 })
  state.clearCashAssumptionsOverride()
  state.importCashAssumptions({
    cashDeposits: 999_005,
    standbyFunds: 999_006,
    manualUpdatedAt: '2026-07-19T01:00:00.000Z',
  })
}

let notifications = 0
let unsubscribe: (() => void) | null = null
let warningSpy: ReturnType<typeof vi.spyOn>

function assertSixActionsBlockedInActualOperation(): void {
  const rootBefore = useAppStore.getState()
  const cacheBefore = readLastAppliedSnapshotGenerationForTest()
  const countsBefore = { ...storageCounts }
  const analysisBefore = analysisProbe.calls
  const notificationsBefore = notifications
  const warningsBefore = warningSpy.mock.calls.length

  invokeAllManualActions()

  expect(useAppStore.getState()).toBe(rootBefore)
  expect(readLastAppliedSnapshotGenerationForTest()).toBe(cacheBefore)
  expect(storageCounts).toEqual(countsBefore)
  expect(analysisProbe.calls).toBe(analysisBefore)
  expect(notifications).toBe(notificationsBefore)
  expect(warningSpy.mock.calls.slice(warningsBefore).map(([message]) => message)).toEqual(
    actionNames.map(name => `[useAppStore] rejected portfolio operation while another operation is active: ${name}`),
  )
  expect(acquirePortfolioOperation('manual')).toBeNull()
}

function expectOwnerReleasedAndManualRetrySucceeds(): void {
  const probe = acquirePortfolioOperation('manual')
  expect(probe).not.toBeNull()
  if (probe) expect(releasePortfolioOperation(probe)).toBe(true)
  if (!useAppStore.getState().holdings.some(item => item.code === HOLDING_CODE)) {
    useAppStore.setState({ holdings: [{ ...TEST_HOLDING }] })
  }
  const writesBefore = storageCounts.set
  useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
  expect(useAppStore.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.17)
  expect(storageCounts.set).toBeGreaterThan(writesBefore)
}

beforeEach(() => {
  const leaked = acquirePortfolioOperation('manual')
  if (leaked === null) throw new Error('operation owner leaked from previous test')
  expect(releasePortfolioOperation(leaked)).toBe(true)
  resetPortfolioGenerationTestSeams()
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', TestFileReader)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })))
  for (const key of Object.keys(storage)) delete storage[key]
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  analysisProbe.calls = 0
  loadProbe.calls = 0
  loadProbe.implementation = async () => publishedData()
  resetStore()
  notifications = 0
  unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
  warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
  resetPortfolioGenerationTestSeams()
  const probe = acquirePortfolioOperation('manual')
  expect(probe, 'outer operation owner must be released').not.toBeNull()
  if (probe) expect(releasePortfolioOperation(probe)).toBe(true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RA-006-REAUDIT-F004 actual operation phase matrix', () => {
  it.each([
    ['initialize', () => useAppStore.getState().initialize()],
    ['refresh', () => useAppStore.getState().refreshAllData()],
  ] as const)('%s public operation stays pending while all six manual actions are blocked', async (_name, start) => {
    const gate = deferred<ReturnType<typeof publishedData>>()
    loadProbe.implementation = () => gate.promise
    let settled = false
    const outer = start().then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(loadProbe.calls).toBe(1)
    assertSixActionsBlockedInActualOperation()

    gate.resolve(publishedData())
    await outer
    expect(settled).toBe(true)
    expect(useAppStore.getState().system).toMatchObject({ status: 'success', error: null })
    expect(analysisProbe.calls).toBeGreaterThan(0)
    expectOwnerReleasedAndManualRetrySucceeds()
  })

  it('public CSV remains in actual READING while File.arrayBuffer is pending', async () => {
    const gate = deferred<ArrayBuffer>()
    const pendingFile = { name: 'pending.csv', arrayBuffer: () => gate.promise } as File
    let settled = false
    const outer = useAppStore.getState().importCsv(pendingFile).then(result => {
      settled = true
      return result
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    assertSixActionsBlockedInActualOperation()

    gate.resolve(new TextEncoder().encode(VALID_CSV).buffer)
    const result = await outer
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(storage[CANONICAL_KEY]).toBeDefined()
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(150_000)
    expectOwnerReleasedAndManualRetrySucceeds()
  })

  it.each(['ANALYZING', 'PREPARED'] as const)(
    'public CSV reaches actual %s, blocks all six actions, and completes through original analysis',
    async targetPhase => {
      let phaseEvidence = 0
      let originalAnalysisCallsAfterPhase = 0
      setPortfolioGenerationPhaseObserverForTest((origin, phase) => {
        if (origin !== 'csv' || phase !== targetPhase) return
        phaseEvidence += 1
        const analysisBefore = analysisProbe.calls
        assertSixActionsBlockedInActualOperation()
        originalAnalysisCallsAfterPhase = analysisBefore
      })

      const result = await useAppStore.getState().importCsv(csvFile())

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(phaseEvidence).toBe(1)
      expect(analysisProbe.calls).toBeGreaterThanOrEqual(originalAnalysisCallsAfterPhase)
      if (targetPhase === 'ANALYZING') {
        expect(analysisProbe.calls).toBeGreaterThan(originalAnalysisCallsAfterPhase)
      }
      expect(storage[CANONICAL_KEY]).toBeDefined()
      expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(150_000)
      expectOwnerReleasedAndManualRetrySucceeds()
    },
  )

  it('public snapshot reaches its actual ANALYZING transaction and blocks all six actions', () => {
    resetStore({ empty: true })
    useAppStore.setState({ holdings: [{ ...TEST_HOLDING, eval: 321_000 }], trust: [] })
    const snapshot = useAppStore.getState().exportPortfolioSnapshot()
    resetStore({ empty: true })
    for (const key of Object.keys(storage)) delete storage[key]
    storageCounts.get = 0
    storageCounts.set = 0
    storageCounts.remove = 0
    notifications = 0
    let phaseEvidence = 0
    setPortfolioGenerationPhaseObserverForTest((origin, phase) => {
      if (origin !== 'snapshot' || phase !== 'ANALYZING') return
      phaseEvidence += 1
      assertSixActionsBlockedInActualOperation()
    })

    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(phaseEvidence).toBe(1)
    expect(analysisProbe.calls).toBeGreaterThan(0)
    expect(storage[CANONICAL_KEY]).toBeDefined()
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(321_000)
    expectOwnerReleasedAndManualRetrySucceeds()
  })

  it('test seams are disabled after reset and do not observe or inject normal operations', async () => {
    let phaseCalls = 0
    setPortfolioGenerationPhaseObserverForTest(() => { phaseCalls += 1 })
    resetPortfolioGenerationTestSeams()

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(phaseCalls).toBe(0)
    expectOwnerReleasedAndManualRetrySucceeds()
  })
})
