import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, CsvSyncSummary, Holding } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { INITIAL_TRUST } from '../constants/trust'
import { STATIC_MARKET } from '../constants/market'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V4,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
  restorePortfolio,
  restoreTrust,
  restoreCsvImportGeneration,
  restoreCsvImportGenerationFromRaw,
} from './persist'
import {
  acquirePortfolioOperation,
  readLastAppliedSnapshotGenerationForTest,
  resetPortfolioGenerationTestSeams,
  releasePortfolioOperation,
  setManualPublishBeforeApplyHookForTest,
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
    resetPortfolioGenerationTestSeams()
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

  const operationPhases: Array<{ phase: string; activeKind: PortfolioOperationKind }> = [
    { phase: 'initialize pending', activeKind: 'initialize' },
    { phase: 'refresh pending', activeKind: 'refresh' },
    { phase: 'CSV READING', activeKind: 'csv' },
    { phase: 'CSV ANALYZING', activeKind: 'csv' },
    { phase: 'CSV PREPARED', activeKind: 'csv' },
    { phase: 'snapshot transaction', activeKind: 'snapshot' },
  ]

  it.each(operationPhases.flatMap(operationPhase => successCases.map(action => ({
    ...operationPhase,
    ...action,
  }))))('$phase rejects $name with zero side effects and keeps the outer owner', ({ invoke, activeKind }) => {
    const ticket = acquirePortfolioOperation(activeKind)
    if (!ticket) throw new Error('failed to acquire test operation')
    const before = useAppStore.getState()
    const cacheBefore = readLastAppliedSnapshotGenerationForTest()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    invoke()

    unsubscribe()
    expect(useAppStore.getState()).toBe(before)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
    expect(readLastAppliedSnapshotGenerationForTest()).toBe(cacheBefore)
    expect(acquirePortfolioOperation('manual')).toBeNull()
    expect(releasePortfolioOperation(ticket)).toBe(true)
  })

  function seedCanonical(options: {
    schemaVersion?: typeof CSV_IMPORT_GENERATION_SCHEMA_V4 | typeof CSV_IMPORT_GENERATION_SCHEMA_V5
    csvImportedAt?: string | null
    csvImportProvenance?: CsvImportProvenance | null
    origin?: 'csv' | 'snapshot' | null
    syncSummary?: CsvSyncSummary | null
  } = {}): string {
    const state = useAppStore.getState()
    const csvImportedAt = Object.prototype.hasOwnProperty.call(options, 'csvImportedAt')
      ? options.csvImportedAt ?? null
      : state.system.csvLastImportedAt
    const csvImportProvenance = Object.prototype.hasOwnProperty.call(options, 'csvImportProvenance')
      ? options.csvImportProvenance ?? null
      : state.system.csvImportProvenance ?? null
    const snapshotTransferIdentity = computeSnapshotGenerationIdentity({
      holdings: state.holdings,
      trust: state.trust,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      csvImportedAt,
      csvImportProvenance,
    })
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt,
      provenance: csvImportProvenance,
      syncSummary: options.syncSummary ?? null,
      trustShortSnapshot: { date: '2026-07-18', total: 0, evalById: {} },
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: options.origin ?? 'snapshot',
      snapshotTransferIdentity,
    }, undefined, undefined, { schemaVersion: options.schemaVersion ?? CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const raw = storage[CSV_IMPORT_GENERATION_KEY]
    getItem.mockClear()
    setItem.mockClear()
    removeItem.mockClear()
    events.length = 0
    return raw
  }

  function primeSnapshotCache(): void {
    const desiredState = useAppStore.getState()
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
    const snapshot = useAppStore.getState().exportPortfolioSnapshot()
    useAppStore.setState(state => ({
      holdings: [],
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
    delete storage[CSV_IMPORT_GENERATION_KEY]
    expect(useAppStore.getState().importPortfolioSnapshot(snapshot)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(readLastAppliedSnapshotGenerationForTest()).not.toBeNull()
    useAppStore.setState(desiredState, true)
    getItem.mockClear()
    setItem.mockClear()
    removeItem.mockClear()
    events.length = 0
  }

  it.each(([CSV_IMPORT_GENERATION_SCHEMA_V4, CSV_IMPORT_GENERATION_SCHEMA_V5] as const)
    .flatMap(schemaVersion => successCases.map(action => ({ schemaVersion, ...action }))))(
    '$schemaVersion $name rewrites one canonical generation with published transfer identity',
    ({ schemaVersion, invoke, assertInput }) => {
    primeSnapshotCache()
    seedCanonical({ schemaVersion })
    const before = useAppStore.getState()
    const callbackEvidence: Array<{
      state: StoreState
      canonicalRaw: string | null
      cache: ReturnType<typeof readLastAppliedSnapshotGenerationForTest>
      nestedTicket: ReturnType<typeof acquirePortfolioOperation>
    }> = []
    const unsubscribe = useAppStore.subscribe(state => {
      callbackEvidence.push({
        state,
        canonicalRaw: storage[CSV_IMPORT_GENERATION_KEY] ?? null,
        cache: readLastAppliedSnapshotGenerationForTest(),
        nestedTicket: acquirePortfolioOperation('manual'),
      })
    })
    invoke()
    unsubscribe()

    const published = useAppStore.getState()
    assertInput(published)
    expect(callbackEvidence).toHaveLength(1)
    const callback = callbackEvidence[0]
    expect(callback.state).toBe(published)
    assertInput(callback.state)
    expectCompleteGeneration(callback.state)
    expect(callback.cache).toBeNull()
    expect(callback.nestedTicket).toBeNull()
    expect(callback.canonicalRaw).not.toBeNull()
    const callbackGeneration = restoreCsvImportGenerationFromRaw(callback.canonicalRaw)
    if (callbackGeneration.status !== 'committed') throw new Error('expected callback canonical generation')
    expect(callbackGeneration.schemaVersion).toBe(schemaVersion)
    expect(callbackGeneration.payload.holdings).toEqual(callback.state.holdings)
    expect(callbackGeneration.payload.trust).toEqual(callback.state.trust)
    expect(callbackGeneration.payload.portfolioPolicy).toEqual(callback.state.portfolioPolicy)
    expect(callbackGeneration.payload.cashAssumptions).toEqual(callback.state.cashAssumptions)
    expect(callbackGeneration.payload.csvImportedAt).toBe(before.system.csvLastImportedAt)
    expect(callbackGeneration.payload.provenance).toEqual(before.system.csvImportProvenance)
    expect(callbackGeneration.payload.snapshotTransferIdentity).toBe(computeSnapshotGenerationIdentity({
      holdings: callback.state.holdings,
      trust: callback.state.trust,
      portfolioPolicy: callback.state.portfolioPolicy,
      cashAssumptions: callback.state.cashAssumptions,
      csvImportedAt: callback.state.system.csvLastImportedAt,
      csvImportProvenance: callback.state.system.csvImportProvenance ?? null,
    }))
    expect(callback.state.system.csvLastImportedAt).toBe(before.system.csvLastImportedAt)
    expect(callback.state.system.csvImportProvenance).toEqual(before.system.csvImportProvenance)
    expect(callback.state.system.csvSyncSummary).toBe(before.system.csvSyncSummary)
    const generation = restoreCsvImportGeneration()
    expect(generation.status).toBe('committed')
    if (generation.status !== 'committed') throw new Error('expected canonical generation')
    expect(generation.schemaVersion).toBe(schemaVersion)
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
    expect(readLastAppliedSnapshotGenerationForTest()).toBeNull()
    const nextTicket = acquirePortfolioOperation('manual')
    expect(nextTicket).not.toBeNull()
    if (nextTicket) expect(releasePortfolioOperation(nextTicket)).toBe(true)
    const writesAfterCommit = setItem.mock.calls.length
    useAppStore.getState().setPortfolioPolicy({
      jpStockMaxRatio: useAppStore.getState().portfolioPolicy.jpStockMaxRatio,
    })
    expect(setItem).toHaveBeenCalledTimes(writesAfterCommit)
  })

  const canonicalSchemas = [CSV_IMPORT_GENERATION_SCHEMA_V4, CSV_IMPORT_GENERATION_SCHEMA_V5] as const

  it.each(canonicalSchemas)('%s aligned metadata succeeds and preserves the published identity inputs', schemaVersion => {
    seedCanonical({ schemaVersion })
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    unsubscribe()

    const published = useAppStore.getState()
    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed generation')
    expect(generation.schemaVersion).toBe(schemaVersion)
    expect(generation.payload.csvImportedAt).toBe(published.system.csvLastImportedAt)
    expect(generation.payload.provenance).toEqual(published.system.csvImportProvenance)
    expect(generation.payload.snapshotTransferIdentity).toBe(computeSnapshotGenerationIdentity({
      holdings: published.holdings,
      trust: published.trust,
      portfolioPolicy: published.portfolioPolicy,
      cashAssumptions: published.cashAssumptions,
      csvImportedAt: published.system.csvLastImportedAt,
      csvImportProvenance: published.system.csvImportProvenance ?? null,
    }))
    expect(notifications).toBe(1)
  })

  it.each(canonicalSchemas)('%s aligned null metadata succeeds without canonical fallback', schemaVersion => {
    useAppStore.setState(state => ({
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    seedCanonical({ schemaVersion, csvImportedAt: null, csvImportProvenance: null })
    useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed generation')
    expect(generation.payload.csvImportedAt).toBeNull()
    expect(generation.payload.provenance).toBeNull()
    expect(generation.payload.snapshotTransferIdentity).toBe(computeSnapshotGenerationIdentity({
      holdings: useAppStore.getState().holdings,
      trust: useAppStore.getState().trust,
      portfolioPolicy: useAppStore.getState().portfolioPolicy,
      cashAssumptions: useAppStore.getState().cashAssumptions,
      csvImportedAt: null,
      csvImportProvenance: null,
    }))
  })

  const mismatchCases: Array<{
    name: string
    canonicalImportedAt: string | null
    canonicalProvenance: CsvImportProvenance | null
    publishedImportedAt: string | null
    publishedProvenance: CsvImportProvenance | null | Record<string, unknown>
    expectedDifferences: string[]
  }> = [
    {
      name: 'canonical importedAt nonnull / published null',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: null,
      publishedImportedAt: null,
      publishedProvenance: null,
      expectedDifferences: ['importedAt'],
    },
    {
      name: 'canonical importedAt null / published nonnull',
      canonicalImportedAt: null,
      canonicalProvenance: null,
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: null,
      expectedDifferences: ['importedAt'],
    },
    {
      name: 'canonical provenance object / published null',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: provenance(),
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: null,
      expectedDifferences: ['provenance'],
    },
    {
      name: 'canonical provenance null / published object',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: null,
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: provenance(),
      expectedDifferences: ['provenance'],
    },
    {
      name: 'top-level importedAt mismatch with both provenance null',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: null,
      publishedImportedAt: '2026-07-18T03:00:00.001Z',
      publishedProvenance: null,
      expectedDifferences: ['importedAt'],
    },
    {
      name: 'provenance importedAt mismatch',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: provenance(),
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: { ...provenance(), importedAt: '2026-07-18T03:00:00.001Z' },
      expectedDifferences: ['provenance.importedAt'],
    },
    {
      name: 'sourceAsOf mismatch',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: provenance(),
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: { ...provenance(), sourceAsOf: '2026-07-18T01:59:59.999Z' },
      expectedDifferences: ['provenance.sourceAsOf'],
    },
    {
      name: 'semanticIdentity mismatch',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: provenance(),
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: { ...provenance(), semanticIdentity: `sha256:${'7'.repeat(64)}` },
      expectedDifferences: ['provenance.semanticIdentity'],
    },
    {
      name: 'contentFingerprint mismatch',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: provenance(),
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: { ...provenance(), contentFingerprint: 'fnv1a32:77777777' },
      expectedDifferences: ['provenance.contentFingerprint'],
    },
    {
      name: 'TTL-expired canonical metadata invalidated by RA-005',
      canonicalImportedAt: '2026-01-01T00:00:00.000Z',
      canonicalProvenance: null,
      publishedImportedAt: null,
      publishedProvenance: null,
      expectedDifferences: ['importedAt'],
    },
    {
      name: 'future canonical metadata invalidated by RA-005',
      canonicalImportedAt: '2099-01-01T00:00:00.000Z',
      canonicalProvenance: null,
      publishedImportedAt: null,
      publishedProvenance: null,
      expectedDifferences: ['importedAt'],
    },
    {
      name: 'malformed published provenance',
      canonicalImportedAt: CSV_IMPORTED_AT,
      canonicalProvenance: provenance(),
      publishedImportedAt: CSV_IMPORTED_AT,
      publishedProvenance: { ...provenance(), sourceAsOfKind: 'malformed' },
      expectedDifferences: ['provenance.sourceAsOfKind'],
    },
  ]

  function metadataDifferencePaths(testCase: typeof mismatchCases[number]): string[] {
    const differences: string[] = []
    if (testCase.canonicalImportedAt !== testCase.publishedImportedAt) differences.push('importedAt')
    const canonical = testCase.canonicalProvenance
    const published = testCase.publishedProvenance
    if (canonical === null || published === null) {
      if (canonical !== published) differences.push('provenance')
      return differences
    }
    for (const field of Object.keys(canonical) as Array<keyof CsvImportProvenance>) {
      if (canonical[field] !== published[field]) differences.push(`provenance.${field}`)
    }
    return differences
  }

  it.each(canonicalSchemas.flatMap(schemaVersion => mismatchCases.map(testCase => ({
    schemaVersion,
    ...testCase,
  }))))('$schemaVersion blocks $name before analysis or persistence and releases the ticket', testCase => {
    expect(metadataDifferencePaths(testCase)).toEqual(testCase.expectedDifferences)
    seedCanonical({
      schemaVersion: testCase.schemaVersion,
      csvImportedAt: testCase.canonicalImportedAt,
      csvImportProvenance: testCase.canonicalProvenance,
    })
    useAppStore.setState(state => ({
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: testCase.publishedImportedAt,
        csvImportProvenance: testCase.publishedProvenance as CsvImportProvenance | null,
      },
    }))
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]
    let analysisReads = 0
    const throwingMarket = new Proxy(STATIC_MARKET, {
      get() {
        analysisReads += 1
        throw new Error('alignment must stop before analysis')
      },
    })
    useAppStore.setState({ market: throwingMarket })
    getItem.mockClear()
    setItem.mockClear()
    removeItem.mockClear()
    const before = useAppStore.getState()
    const cacheBefore = readLastAppliedSnapshotGenerationForTest()
    const observed: StoreState[] = []
    const unsubscribe = useAppStore.subscribe(state => { observed.push(state) })

    useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
    unsubscribe()

    expect(analysisReads).toBe(0)
    expectPortfolioReferencesUnchanged(before)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(getItem.mock.calls.every(([key]) => key === CSV_IMPORT_GENERATION_KEY)).toBe(true)
    expect(observed).toHaveLength(1)
    expect(observed[0].system.status).toBe('error')
    expect(observed[0].system.error).toBe(
      '保存済みCSVメタデータを現在の公開状態と安全に一致させられないため、手動変更を中止しました。CSVまたはportfolio snapshotを再取込してから再試行してください。',
    )
    expect(readLastAppliedSnapshotGenerationForTest()).toBe(cacheBefore)
    const ticket = acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(releasePortfolioOperation(ticket)).toBe(true)

    useAppStore.setState(state => ({
      market: STATIC_MARKET,
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: CSV_IMPORTED_AT,
        csvImportProvenance: provenance(),
      },
    }))
    seedCanonical({ schemaVersion: testCase.schemaVersion })
    let retryNotifications = 0
    const unsubscribeRetry = useAppStore.subscribe(() => { retryNotifications += 1 })
    useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
    unsubscribeRetry()
    expect(retryNotifications).toBe(1)
    expect(useAppStore.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.17)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
  })

  it.each(canonicalSchemas)('%s CSV-origin manual replacement preserves nonnull syncSummary and origin', schemaVersion => {
    const summary: CsvSyncSummary = {
      importedAt: CSV_IMPORTED_AT,
      stock: { updated: 2, added: 1, removed: 0 },
      trust: { updated: 3, reheld: 1, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
    }
    useAppStore.setState(state => ({ system: { ...state.system, csvSyncSummary: summary } }))
    seedCanonical({ schemaVersion, origin: 'csv', syncSummary: summary })
    useAppStore.getState().updateTrust(TRUST_ID, { eval: 123_456 })
    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed generation')
    expect(generation.payload.origin).toBe('csv')
    expect(generation.payload.csvImportedAt).toBe(CSV_IMPORTED_AT)
    expect(generation.payload.syncSummary).toEqual(summary)
    expect(generation.payload.snapshotTransferIdentity).toBe(computeSnapshotGenerationIdentity({
      holdings: generation.payload.holdings,
      trust: generation.payload.trust,
      portfolioPolicy: generation.payload.portfolioPolicy!,
      cashAssumptions: generation.payload.cashAssumptions!,
      csvImportedAt: generation.payload.csvImportedAt ?? null,
      csvImportProvenance: generation.payload.provenance ?? null,
    }))
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

  it.each([
    ['updateHolding', () => useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })],
    ['updateTrust', () => useAppStore.getState().updateTrust(TRUST_ID, { eval: 222_222 })],
  ] as const)('%s rolls portfolio back when the trust write fails and a later retry succeeds', (_name, invoke) => {
    const oldHoldings = [{ ...TEST_HOLDING, eval: 101_010 }]
    const oldTrust = INITIAL_TRUST.map(fund => ({ ...fund, eval: fund.id === TRUST_ID ? 202_020 : fund.eval }))
    storage.v81_portfolio = JSON.stringify({ data: oldHoldings, savedAt: 1 })
    storage.v81_trust = JSON.stringify({ data: oldTrust, savedAt: 1 })
    const previousPortfolioRaw = storage.v81_portfolio
    const previousTrustRaw = storage.v81_trust
    const before = useAppStore.getState()
    const observed: StoreState[] = []
    const unsubscribe = useAppStore.subscribe(state => { observed.push(state) })
    setItem.mockImplementation((key: string, value: string) => {
      if (key === 'v81_trust' && JSON.parse(value).savedAt !== 1) throw new Error('trust quota')
      storage[key] = value
    })

    invoke()

    expectPortfolioReferencesUnchanged(before)
    expect(observed).toHaveLength(1)
    expect(observed[0].system.status).toBe('error')
    expect(storage.v81_portfolio).toBe(previousPortfolioRaw)
    expect(storage.v81_trust).toBe(previousTrustRaw)
    expect(restorePortfolio()).toEqual(oldHoldings)
    expect(restoreTrust()).toEqual(oldTrust)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()

    setItem.mockImplementation((key: string, value: string) => { storage[key] = value })
    invoke()
    unsubscribe()
    expect(useAppStore.getState()).not.toBe(before)
    expect(observed).toHaveLength(2)
  })

  it('rolls portfolio and trust back when the learning write fails', () => {
    const priorPortfolio = JSON.stringify({ data: [{ ...TEST_HOLDING, eval: 1 }], savedAt: 1 })
    const priorTrust = JSON.stringify({ data: INITIAL_TRUST, savedAt: 1 })
    const priorLearning = JSON.stringify({ data: { lastUpdated: 'old' }, savedAt: 1 })
    storage.v81_portfolio = priorPortfolio
    storage.v81_trust = priorTrust
    storage.v91_learning = priorLearning
    const emptyDecisionSummary = { count: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0 }
    useAppStore.setState({ learning: {
      lastUpdated: '2026-07-18T00:00:00.000Z',
      baselineCount: 0,
      baseline: [],
      outcomes: [],
      summary: {
        total: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        accuracy: 0,
        avgReward: 0,
        byDecision: {
          BUY: { ...emptyDecisionSummary },
          HOLD: { ...emptyDecisionSummary },
          SELL: { ...emptyDecisionSummary },
        },
        driftSignals: [],
      },
      suggestedWeights: {
        fundamental: 0.3,
        market: 0.2,
        technical: 0.2,
        news: 0.1,
        quality: 0.1,
        risk: 0.1,
      },
    } })
    const before = useAppStore.getState()
    setItem.mockImplementation((key: string, value: string) => {
      if (key === 'v91_learning' && JSON.parse(value).savedAt !== 1) throw new Error('learning quota')
      storage[key] = value
    })

    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 333_333 })

    expectPortfolioReferencesUnchanged(before)
    expect(storage.v81_portfolio).toBe(priorPortfolio)
    expect(storage.v81_trust).toBe(priorTrust)
    expect(storage.v91_learning).toBe(priorLearning)
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

  it.each(successCases)('manual subscriber reentry during $name rejects all six manual actions', ({ invoke, assertInput }) => {
    seedCanonical()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => {
      notifications += 1
      for (const nested of successCases) nested.invoke()
    })

    invoke()
    unsubscribe()

    expect(notifications).toBe(1)
    assertInput(useAppStore.getState())
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
    const firstGeneration = restoreCsvImportGeneration()
    if (firstGeneration.status !== 'committed') throw new Error('expected first committed generation')
    expect(firstGeneration.payload.holdings).toEqual(useAppStore.getState().holdings)
    expect(firstGeneration.payload.trust).toEqual(useAppStore.getState().trust)
    expect(firstGeneration.payload.portfolioPolicy).toEqual(useAppStore.getState().portfolioPolicy)
    expect(firstGeneration.payload.cashAssumptions).toEqual(useAppStore.getState().cashAssumptions)
    const ticket = acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(releasePortfolioOperation(ticket)).toBe(true)
    const nextEval = (useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval ?? 0) + 1
    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: nextEval })
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(nextEval)
    expect(setItem).toHaveBeenCalledTimes(2)
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

  it('setCashAssumptions uses one operation clock for candidate, canonical, and published values', () => {
    seedCanonical()
    const operationNowMs = Date.parse('2026-07-19T06:07:08.009Z')
    let calls = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1
      return calls === 1 ? operationNowMs : operationNowMs - calls
    })

    useAppStore.getState().setCashAssumptions({ cashDeposits: 123_456, standbyFunds: 654_321 })

    const expectedTimestamp = new Date(operationNowMs).toISOString()
    const published = useAppStore.getState()
    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed generation')
    expect(calls).toBe(1)
    expect(published.cashAssumptions.manualUpdatedAt).toBe(expectedTimestamp)
    expect(generation.payload.cashAssumptions?.manualUpdatedAt).toBe(expectedTimestamp)
    expect(JSON.parse(storage[CSV_IMPORT_GENERATION_KEY]).manifest.savedAt).toBe(operationNowMs)
    nowSpy.mockRestore()
  })

  it('restores the exact previous snapshot cache when final manual publish throws before state apply', () => {
    primeSnapshotCache()
    seedCanonical()
    const previousCache = readLastAppliedSnapshotGenerationForTest()
    expect(previousCache).not.toBeNull()
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]
    const rootBefore = useAppStore.getState()
    const rawError = new Error('RA-006 pre-apply test sentinel')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    setManualPublishBeforeApplyHookForTest(() => { throw rawError })

    expect(() => useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })).not.toThrow()

    expect(useAppStore.getState()).toBe(rootBefore)
    expectPortfolioReferencesUnchanged(rootBefore)
    expect(notifications).toBe(0)
    expect(readLastAppliedSnapshotGenerationForTest()).toBe(previousCache)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(canonicalBefore)
    const physicallyCommitted = restoreCsvImportGeneration()
    if (physicallyCommitted.status !== 'committed') throw new Error('expected physically committed generation')
    expect(physicallyCommitted.payload.holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval)
      .toBe(rootBefore.holdings.find(item => item.code === HOLDING_CODE)?.eval)
    expect(useAppStore.getState().system.error).toBe(rootBefore.system.error)
    expect(useAppStore.getState().system.error ?? '').not.toContain(rawError.message)
    expect(errorSpy).toHaveBeenCalledWith(
      '[useAppStore] manual portfolio publish observer failed',
      rawError,
    )
    const ticket = acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(releasePortfolioOperation(ticket)).toBe(true)

    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    unsubscribe()
    expect(notifications).toBe(1)
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
    expect(readLastAppliedSnapshotGenerationForTest()).toBeNull()
  })

  it('invalidates snapshot cache before the final subscriber and later returns the exact provenance result', () => {
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
    expect(readLastAppliedSnapshotGenerationForTest()).not.toBeNull()
    let cacheSeenBySubscriber: ReturnType<typeof readLastAppliedSnapshotGenerationForTest> | undefined
    let reentrantManualState: StoreState | undefined
    let reentrantSnapshotResult: ReturnType<StoreState['importPortfolioSnapshot']> | undefined
    const unsubscribe = useAppStore.subscribe(() => {
      cacheSeenBySubscriber = readLastAppliedSnapshotGenerationForTest()
      useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 })
      reentrantManualState = useAppStore.getState()
      reentrantSnapshotResult = useAppStore.getState().importPortfolioSnapshot(raw)
    })
    useAppStore.getState().updateHolding(HOLDING_CODE, { eval: 222_222 })
    unsubscribe()
    expect(cacheSeenBySubscriber).toBeNull()
    expect(reentrantManualState?.portfolioPolicy).toEqual(DEFAULT_PORTFOLIO_POLICY)
    expect(reentrantSnapshotResult).toMatchObject({ ok: false, code: 'SNAPSHOT_IMPORT_BLOCKED' })
    const canonicalBeforeRetry = storage[CSV_IMPORT_GENERATION_KEY]
    const beforeRetry = useAppStore.getState()
    const writesBeforeRetry = setItem.mock.calls.length
    const removesBeforeRetry = removeItem.mock.calls.length
    let retryNotifications = 0
    const unsubscribeRetry = useAppStore.subscribe(() => { retryNotifications += 1 })
    const repeated = useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribeRetry()

    expect(repeated).toEqual({
      ok: false,
      code: 'SNAPSHOT_PROVENANCE_UNKNOWN',
      error: 'データ基準情報のないsnapshotでは、この端末の保有データを上書きできません。',
    })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBeforeRetry)
    expect(readLastAppliedSnapshotGenerationForTest()).toBeNull()
    expect(useAppStore.getState().holdings).toBe(beforeRetry.holdings)
    expect(useAppStore.getState().trust).toBe(beforeRetry.trust)
    expect(useAppStore.getState().portfolioPolicy).toBe(beforeRetry.portfolioPolicy)
    expect(useAppStore.getState().cashAssumptions).toBe(beforeRetry.cashAssumptions)
    expect(retryNotifications).toBe(0)
    expect(setItem).toHaveBeenCalledTimes(writesBeforeRetry)
    expect(removeItem).toHaveBeenCalledTimes(removesBeforeRetry)
    expect(useAppStore.getState().holdings.find(item => item.code === HOLDING_CODE)?.eval).toBe(222_222)
  })
})
