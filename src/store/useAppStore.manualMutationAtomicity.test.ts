import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, Holding } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { INITIAL_TRUST } from '../constants/trust'
import { STATIC_MARKET } from '../constants/market'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
  restoreCsvImportGeneration,
} from './persist'
import {
  acquirePortfolioOperation,
  releasePortfolioOperation,
  useAppStore,
  type PortfolioOperationKind,
} from './useAppStore'

type StoreState = ReturnType<typeof useAppStore.getState>
type ManualAction = () => void

const TEST_HOLDING: Holding = {
  code: 'RA006', name: 'RA-006 test holding', eval: 100_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}
const HOLDING_CODE = TEST_HOLDING.code
const TRUST_ID = INITIAL_TRUST[0].id
const CSV_IMPORTED_AT = '2026-07-18T03:00:00.000Z'

function provenance(): CsvImportProvenance {
  return {
    importedAt: CSV_IMPORTED_AT,
    sourceAsOf: '2026-07-18T02:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${'6'.repeat(64)}`,
    contentFingerprint: 'fnv1a32:66666666',
    sourceFileName: 'ra-006.csv',
    fileLastModified: '2026-07-18T02:30:00.000Z',
  }
}

function expectCompleteGeneration(state: StoreState): void {
  expect(state.analysis).toHaveLength(state.holdings.length)
  expect(state.metrics).not.toBeNull()
  expect(state.universe).not.toBeNull()
  expect(state.holdings.every(holding => {
    const analysis = state.analysis.find(item => item.code === holding.code)
    return analysis !== undefined && holding.score === analysis.totalScore && holding.decision === analysis.decision
  })).toBe(true)
  expect(state.officialDecision).not.toBeNull()
  expect(state.zeroPlan).not.toBeNull()
  expect(state.stockPlan).not.toBeNull()
  expect(state.trustPlan).not.toBeNull()
}

function expectPortfolioReferencesUnchanged(before: StoreState): void {
  const after = useAppStore.getState()
  expect(after.holdings).toBe(before.holdings)
  expect(after.trust).toBe(before.trust)
  expect(after.portfolioPolicy).toBe(before.portfolioPolicy)
  expect(after.cashAssumptions).toBe(before.cashAssumptions)
  expect(after.analysis).toBe(before.analysis)
  expect(after.metrics).toBe(before.metrics)
  expect(after.universe).toBe(before.universe)
  expect(after.learning).toBe(before.learning)
  expect(after.officialDecision).toBe(before.officialDecision)
  expect(after.zeroPlan).toBe(before.zeroPlan)
  expect(after.stockPlan).toBe(before.stockPlan)
  expect(after.trustPlan).toBe(before.trustPlan)
  expect(after.stockCandidates).toBe(before.stockCandidates)
}

describe('RA-006 manual mutation coordinator and atomic publish', () => {
  const storage: Record<string, string> = {}
  const events: string[] = []
  const getItem = vi.fn((key: string): string | null => storage[key] ?? null)
  const setItem = vi.fn((key: string, value: string) => {
    events.push(`persist:${key}`)
    storage[key] = value
  })
  const removeItem = vi.fn((key: string) => {
    events.push(`remove:${key}`)
    delete storage[key]
  })

  const successCases: Array<{
    name: string
    invoke: ManualAction
    assertInput: (state: StoreState) => void
    legacyKeys: string[]
  }> = [
    {
      name: 'updateHolding',
      invoke: () => useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 987_654 }),
      assertInput: state => expect(state.holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(987_654),
      legacyKeys: ['v81_portfolio', 'v81_trust'],
    },
    {
      name: 'updateTrust',
      invoke: () => useAppStore.getState().updateTrust(TRUST_ID, { eval: 876_543 }),
      assertInput: state => expect(state.trust.find(item => item.id === TRUST_ID)?.eval).toBe(876_543),
      legacyKeys: ['v81_portfolio', 'v81_trust'],
    },
    {
      name: 'setPortfolioPolicy',
      invoke: () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 }),
      assertInput: state => expect(state.portfolioPolicy).toEqual({ jpStockMaxRatio: 0.17 }),
      legacyKeys: ['v13_portfolio_policy'],
    },
    {
      name: 'setCashAssumptions',
      invoke: () => useAppStore.getState().setCashAssumptions({ cashDeposits: 1234.6, standbyFunds: -1 }),
      assertInput: state => expect(state.cashAssumptions).toMatchObject({
        cashDeposits: 1_235,
        standbyFunds: 0,
        manualOverrideEnabled: true,
      }),
      legacyKeys: ['v13_cash_assumptions'],
    },
    {
      name: 'clearCashAssumptionsOverride',
      invoke: () => useAppStore.getState().clearCashAssumptionsOverride(),
      assertInput: state => expect(state.cashAssumptions).toEqual({
        cashDeposits: 333,
        standbyFunds: 444,
        manualOverrideEnabled: false,
        manualUpdatedAt: null,
      }),
      legacyKeys: ['v13_cash_assumptions'],
    },
    {
      name: 'importCashAssumptions',
      invoke: () => useAppStore.getState().importCashAssumptions({
        cashDeposits: 5555.4,
        standbyFunds: Number.NaN,
        manualUpdatedAt: '2026-07-01T00:00:00.000Z',
      }),
      assertInput: state => expect(state.cashAssumptions).toEqual({
        cashDeposits: 5_555,
        standbyFunds: 0,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-01T00:00:00.000Z',
      }),
      legacyKeys: ['v13_cash_assumptions'],
    },
  ]

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key]
    events.length = 0
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem })
    getItem.mockClear()
    getItem.mockImplementation((key: string) => storage[key] ?? null)
    setItem.mockClear()
    setItem.mockImplementation((key: string, value: string) => {
      events.push(`persist:${key}`)
      storage[key] = value
    })
    removeItem.mockClear()
    removeItem.mockImplementation((key: string) => {
      events.push(`remove:${key}`)
      delete storage[key]
    })
    useAppStore.setState(state => ({
      holdings: [{ ...TEST_HOLDING }],
      trust: INITIAL_TRUST.map(fund => ({ ...fund })),
      market: STATIC_MARKET,
      analysis: [],
      metrics: null,
      universe: null,
      learning: null,
      officialDecision: null,
      zeroPlan: null,
      stockPlan: null,
      trustPlan: null,
      stockCandidates: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: {
        cashDeposits: 333,
        standbyFunds: 444,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-17T00:00:00.000Z',
      },
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: CSV_IMPORTED_AT,
        csvImportProvenance: provenance(),
        csvSyncSummary: null,
      },
    }))
    getItem.mockClear()
    setItem.mockClear()
    removeItem.mockClear()
    events.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(successCases)('$name persists before one complete subscriber publication', ({ invoke, assertInput, legacyKeys }) => {
    const observed: StoreState[] = []
    const unsubscribe = useAppStore.subscribe(state => {
      events.push('publish')
      observed.push(state)
    })

    invoke()
    unsubscribe()

    expect(observed).toHaveLength(1)
    assertInput(observed[0])
    expectCompleteGeneration(observed[0])
    expect(events[events.length - 1]).toBe('publish')
    expect(events.some(event => event.startsWith('persist:'))).toBe(true)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(legacyKeys.every(key => storage[key] !== undefined)).toBe(true)
    const ticket = acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(releasePortfolioOperation(ticket)).toBe(true)
  })

  const noOpCases: Array<{ name: string; invoke: ManualAction }> = [
    { name: 'missing holding code', invoke: () => useAppStore.getState().updateHolding('missing', { eval: 1 }) },
    { name: 'unchanged holding patch', invoke: () => {
      const holding = useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)!
      useAppStore.getState().updateHolding(HOLDING_CODE, { eval: holding.eval })
    } },
    { name: 'missing trust id', invoke: () => useAppStore.getState().updateTrust('missing', { eval: 1 }) },
    { name: 'unchanged trust patch', invoke: () => {
      const fund = useAppStore.getState().trust.find(item => item.id === TRUST_ID)!
      useAppStore.getState().updateTrust(TRUST_ID, { eval: fund.eval })
    } },
    { name: 'same policy', invoke: () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: DEFAULT_PORTFOLIO_POLICY.jpStockMaxRatio }) },
    { name: 'identical imported cash assumptions', invoke: () => useAppStore.getState().importCashAssumptions({
      cashDeposits: 333,
      standbyFunds: 444,
      manualUpdatedAt: '2026-07-17T00:00:00.000Z',
    }) },
  ]

  it.each(noOpCases)('$name is a root-identity no-op with zero storage and subscriber effects', ({ invoke }) => {
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    invoke()
    unsubscribe()

    expect(useAppStore.getState()).toBe(before)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
  })

  it('already-cleared cash override is directly a root-identity no-op', () => {
    useAppStore.setState({ cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS } })
    getItem.mockClear()
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    useAppStore.getState().clearCashAssumptionsOverride()
    unsubscribe()
    expect(useAppStore.getState()).toBe(before)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
  })

  it.each(successCases.map((action, index) => ({
    ...action,
    activeKind: (['initialize', 'refresh', 'csv', 'snapshot', 'initialize', 'refresh'] as PortfolioOperationKind[])[index],
  })))('$name is rejected with zero side effects while $activeKind is active', ({ invoke, activeKind }) => {
    const ticket = acquirePortfolioOperation(activeKind)
    if (!ticket) throw new Error('failed to acquire test operation')
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    invoke()

    unsubscribe()
    expect(useAppStore.getState()).toBe(before)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
    expect(releasePortfolioOperation(ticket)).toBe(true)
  })

  function seedCanonical(): string {
    const state = useAppStore.getState()
    const csvImportProvenance = state.system.csvImportProvenance ?? null
    const snapshotTransferIdentity = computeSnapshotGenerationIdentity({
      holdings: state.holdings,
      trust: state.trust,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      csvImportedAt: state.system.csvLastImportedAt,
      csvImportProvenance,
    })
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt: state.system.csvLastImportedAt,
      provenance: csvImportProvenance,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-07-18', total: 0, evalById: {} },
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: 'snapshot',
      snapshotTransferIdentity,
    }, undefined, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const raw = storage[CSV_IMPORT_GENERATION_KEY]
    getItem.mockClear()
    setItem.mockClear()
    removeItem.mockClear()
    events.length = 0
    return raw
  }

  it.each(successCases.slice(0, 4))('$name rewrites one v5 canonical generation with published transfer identity', ({ invoke, assertInput }) => {
    seedCanonical()
    invoke()

    const published = useAppStore.getState()
    assertInput(published)
    const generation = restoreCsvImportGeneration()
    expect(generation.status).toBe('committed')
    if (generation.status !== 'committed') throw new Error('expected canonical generation')
    expect(generation.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(generation.payload.holdings).toEqual(published.holdings)
    expect(generation.payload.trust).toEqual(published.trust)
    expect(generation.payload.portfolioPolicy).toEqual(published.portfolioPolicy)
    expect(generation.payload.cashAssumptions).toEqual(published.cashAssumptions)
    expect(generation.payload.csvImportedAt).toBe(CSV_IMPORTED_AT)
    expect(generation.payload.provenance).toEqual(published.system.csvImportProvenance)
    expect(generation.payload.origin).toBe('snapshot')
    expect(generation.payload.syncSummary).toBeNull()
    expect(generation.payload.snapshotTransferIdentity).toBe(computeSnapshotGenerationIdentity({
      holdings: published.holdings,
      trust: published.trust,
      portfolioPolicy: published.portfolioPolicy,
      cashAssumptions: published.cashAssumptions,
      csvImportedAt: published.system.csvLastImportedAt,
      csvImportProvenance: published.system.csvImportProvenance ?? null,
    }))
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
  })

  it('canonical persistence failure publishes no portfolio generation, preserves bytes, and permits retry', () => {
    const previousRaw = seedCanonical()
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    setItem.mockImplementation(() => { throw new Error('quota') })

    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })

    expectPortfolioReferencesUnchanged(before)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(previousRaw)
    expect(Object.keys(storage)).toEqual([CSV_IMPORT_GENERATION_KEY])
    expect(notifications).toBe(1)
    expect(useAppStore.getState().system.status).toBe('error')

    setItem.mockImplementation((key: string, value: string) => { storage[key] = value })
    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    unsubscribe()
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
  })

  it('present-invalid canonical stops before analysis and legacy fallback', () => {
    storage[CSV_IMPORT_GENERATION_KEY] = '{present-invalid'
    let analysisReads = 0
    const throwingMarket = new Proxy(STATIC_MARKET, {
      get() {
        analysisReads += 1
        throw new Error('analysis must not run')
      },
    })
    useAppStore.setState({ market: throwingMarket })
    getItem.mockClear()
    const before = useAppStore.getState()

    useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })

    expectPortfolioReferencesUnchanged(before)
    expect(analysisReads).toBe(0)
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe('{present-invalid')
  })

  it.each([
    ['holding/trust', () => useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })],
    ['policy', () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })],
    ['cash', () => useAppStore.getState().setCashAssumptions({ cashDeposits: 222_222, standbyFunds: 333_333 })],
  ] as const)('%s analysis failure has zero persistence/portfolio publication and a valid retry succeeds', (_category, invoke) => {
    let analysisReads = 0
    const throwingMarket = new Proxy(STATIC_MARKET, {
      get() {
        analysisReads += 1
        throw new Error('analysis failed')
      },
    })
    useAppStore.setState({ market: throwingMarket })
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    invoke()

    expect(analysisReads).toBeGreaterThan(0)
    expectPortfolioReferencesUnchanged(before)
    expect(setItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)

    useAppStore.setState({ market: STATIC_MARKET })
    notifications = 0
    getItem.mockClear()
    invoke()
    unsubscribe()
    expect(useAppStore.getState()).not.toBe(before)
    expect(notifications).toBe(1)
  })

  it('reentrant manual subscriber creates only the first generation', () => {
    seedCanonical()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => {
      notifications += 1
      useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
    })

    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    unsubscribe()

    expect(notifications).toBe(1)
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
    expect(useAppStore.getState().portfolioPolicy).toEqual(DEFAULT_PORTFOLIO_POLICY)
    expect(storage.v13_portfolio_policy).toBeUndefined()
    expect(setItem).toHaveBeenCalledTimes(1)
    const generation = restoreCsvImportGeneration()
    expect(generation).toMatchObject({
      status: 'committed',
      payload: { portfolioPolicy: DEFAULT_PORTFOLIO_POLICY },
    })
  })

  it('manual publish subscriber cannot start initialize, refresh, CSV, or snapshot operations', async () => {
    let initializeResult: Promise<void> | undefined
    let refreshResult: Promise<void> | undefined
    let csvResult: ReturnType<StoreState['importCsv']> | undefined
    let snapshotResult: ReturnType<StoreState['importPortfolioSnapshot']> | undefined
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => {
      notifications += 1
      const state = useAppStore.getState()
      initializeResult = state.initialize()
      refreshResult = state.refreshAllData()
      csvResult = state.importCsv({} as File)
      snapshotResult = state.importPortfolioSnapshot('{not-read-while-blocked')
    })

    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    unsubscribe()

    await initializeResult
    await refreshResult
    await expect(csvResult).resolves.toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })
    expect(snapshotResult).toMatchObject({ ok: false, code: 'SNAPSHOT_IMPORT_BLOCKED' })
    expect(notifications).toBe(1)
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
  })

  it('throwing subscriber cannot undo the durable state or leak the manual ticket', () => {
    seedCanonical()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let calls = 0
    const unsubscribe = useAppStore.subscribe(() => {
      calls += 1
      throw new Error('subscriber throw')
    })

    expect(() => useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })).not.toThrow()
    expect(calls).toBe(1)
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
    expect(() => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })).not.toThrow()
    expect(calls).toBe(2)
    expect(useAppStore.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.17)
    unsubscribe()
    expect(errorSpy).toHaveBeenCalled()
    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed generation')
    const published = useAppStore.getState()
    expect(generation.payload.snapshotTransferIdentity).toBe(computeSnapshotGenerationIdentity({
      holdings: published.holdings,
      trust: published.trust,
      portfolioPolicy: published.portfolioPolicy,
      cashAssumptions: published.cashAssumptions,
      csvImportedAt: published.system.csvLastImportedAt,
      csvImportProvenance: published.system.csvImportProvenance ?? null,
    }))
  })

  it('successful manual mutation invalidates same-session snapshot duplicate evidence', () => {
    useAppStore.setState(state => ({
      holdings: [{ ...TEST_HOLDING, eval: 111_111 }],
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
    const raw = useAppStore.getState().exportPortfolioSnapshot()
    useAppStore.setState(state => ({
      holdings: [],
      trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    delete storage[CSV_IMPORT_GENERATION_KEY]

    expect(useAppStore.getState().importPortfolioSnapshot(raw)).toMatchObject({ ok: true, code: 'SUCCESS' })
    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    const repeated = useAppStore.getState().importPortfolioSnapshot(raw)

    expect(repeated.code).not.toBe('DUPLICATE_SNAPSHOT')
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
  })
})
