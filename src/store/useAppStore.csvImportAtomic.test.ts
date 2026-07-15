import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding, Trust } from '../types'
import { runFullAnalysis, useAppStore } from './useAppStore'
import {
  CSV_IMPORT_GENERATION_KEY,
  persistCsvImportTransaction,
  restoreCsvImportGeneration,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  restoreLearning,
  restorePortfolio,
  restoreTrust,
} from './persist'

class TestFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const originalFileReader = globalThis.FileReader
const baseMarket = useAppStore.getState().market
const baseSafeMode = useAppStore.getState().safeMode
const baseCashAssumptions = useAppStore.getState().cashAssumptions
const baseCandidatesNews = useAppStore.getState().candidatesNews
const baseCandidatesStocks = useAppStore.getState().candidatesStocks
const baseRegimeState = useAppStore.getState().regimeState

function holding(code = '1001', evalValue = 100_000): Holding {
  return {
    code,
    name: `銘柄${code}`,
    eval: evalValue,
    pnlPct: 1,
    mu: 0.08,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1,
    sector: 'テスト',
    target: 0,
    alert: 0,
    lock: false,
    mitsu: false,
    ma: true,
    rsi: 50,
    macd: true,
    vol: false,
    mom3m: 0,
    roe: 10,
    per: 15,
    pbr: 1,
    epsG: 5,
    cfOk: true,
    de: 0.5,
    divG: 1,
    score: 50,
    decision: 'HOLD',
    ev: 0,
  }
}

function trust(): Trust {
  return {
    id: 'fund-1',
    name: 'テスト投信',
    abbr: 'テスト',
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: 200_000,
    pnlPct: 2,
    dayPct: 0,
    cost: 0.2,
    mu: 0.08,
    sigma: 0.15,
    score: 50,
    signal: 'HOLD',
    ev: 0,
    decision: 'HOLD',
  }
}

function shortTrust(): Trust {
  return { ...trust(), policy: 'JAPAN_SHORTTERM' }
}

const VALID_CSV = [
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  'テスト投信,10000,250000,5.00,0.10,',
].join('\n')

function csvFile(content = VALID_CSV) {
  return new File([content], 'portfolio.csv', { type: 'text/csv' })
}

function relevantState() {
  const state = useAppStore.getState()
  return {
    holdings: state.holdings,
    trust: state.trust,
    csvLastImportedAt: state.system.csvLastImportedAt,
    csvSyncSummary: state.system.csvSyncSummary,
    analysis: state.analysis,
    metrics: state.metrics,
    learning: state.learning,
    universe: state.universe,
    zeroPlan: state.zeroPlan,
    stockPlan: state.stockPlan,
    trustPlan: state.trustPlan,
    officialDecision: state.officialDecision,
    stockCandidates: state.stockCandidates,
    candidatesNews: state.candidatesNews,
    candidatesStocks: state.candidatesStocks,
  }
}

function withoutGeneratedTimestamps<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutGeneratedTimestamps) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) =>
      key === 'generatedAt' || key === 'lastUpdatedAt'
        ? []
        : [[key, withoutGeneratedTimestamps(nested)]],
    )) as T
  }
  return value
}

describe('T9-A001/A002: structured CSV result and atomic store commit', () => {
  const storage: Record<string, string> = {}
  let storageWriteCount = 0
  let failStorageWriteAt: number | null = null
  let storageReentry: ((key: string) => void) | null = null
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storageWriteCount += 1
      if (storageWriteCount === failStorageWriteAt) throw new Error('forced quota failure')
      storage[key] = value
      storageReentry?.(key)
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  beforeEach(() => {
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    storageWriteCount = 0
    failStorageWriteAt = null
    storageReentry = null
    useAppStore.setState(state => ({
      holdings: [holding()],
      trust: [trust()],
      correlation: null,
      market: baseMarket,
      safeMode: baseSafeMode,
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: baseCashAssumptions,
      candidatesNews: baseCandidatesNews,
      candidatesStocks: baseCandidatesStocks,
      regimeState: baseRegimeState,
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
        csvLastImportedAt: '2026-07-01T00:00:00.000Z',
        csvSyncSummary: null,
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalFileReader) globalThis.FileReader = originalFileReader
  })

  it('valid import returns structured success only after analysis, officialDecision, persistence, and commit', async () => {
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: true,
      analysisCommitted: true,
      officialDecisionCommitted: true,
      persistence: { status: 'committed' },
    })
    if (!result.ok) throw new Error('expected successful import')
    expect(result.imported.stock.updated).toBe(1)
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(useAppStore.getState().trust[0].eval).toBe(250_000)
    expect(useAppStore.getState().analysis.length).toBeGreaterThan(0)
    expect(useAppStore.getState().officialDecision).not.toBeNull()
    expect(useAppStore.getState().system.csvLastImportedAt).not.toBe('2026-07-01T00:00:00.000Z')

    const state = useAppStore.getState()
    const physical = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY]) as {
      manifest: { generationId: string }
    }
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(physical.manifest.generationId).toBe(restored.generationId)
    expect(restored.payload.holdings).toEqual(state.holdings)
    expect(restored.payload.trust).toEqual(state.trust)
    expect(restored.payload.learning).toEqual(state.learning)
    expect(restored.payload.importedAt).toBe(state.system.csvLastImportedAt)
    expect(restorePortfolio()).toEqual(state.holdings)
    expect(restoreTrust()).toEqual(state.trust)
    expect(restoreLearning()).toEqual(state.learning)
    expect(restoreCsvImportedAt()).toBe(state.system.csvLastImportedAt)
    expect(restoreCsvSyncSummary()).toEqual(state.system.csvSyncSummary)
  })

  it('subscribers observe exactly one portfolio-generation commit, never new holdings with an old decision', async () => {
    const generations: Array<{
      holdingEval: number
      analysisLength: number
      hasOfficialDecision: boolean
    }> = []
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.holdings !== previous.holdings ||
        state.trust !== previous.trust ||
        state.analysis !== previous.analysis ||
        state.officialDecision !== previous.officialDecision
      ) {
        generations.push({
          holdingEval: state.holdings[0]?.eval ?? 0,
          analysisLength: state.analysis.length,
          hasOfficialDecision: state.officialDecision !== null,
        })
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(result.ok).toBe(true)
    expect(generations).toEqual([{
      holdingEval: 150_000,
      analysisLength: 1,
      hasOfficialDecision: true,
    }])
  })

  it('R1: a throwing final-commit subscriber cannot turn a durable published generation into false failure', async () => {
    let laterSubscriberCalls = 0
    const unsubscribeThrowing = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) throw new Error('observer exploded after commit')
    })
    const unsubscribeLater = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) laterSubscriberCalls += 1
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribeThrowing()
    unsubscribeLater()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', persistence: { status: 'committed' } })
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { holdings: [{ eval: 150_000 }] },
    })
    expect(useAppStore.getState().system.status).toBe('success')
    expect(laterSubscriberCalls).toBe(1)

    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })

  it('R4: manual portfolio actions rebuild the complete canonical payload in one replacement', async () => {
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
    const before = restoreCsvImportGeneration()
    if (before.status !== 'committed') throw new Error('expected committed generation')

    useAppStore.getState().updateHolding('1001', { eval: 175_000 })
    const afterHolding = restoreCsvImportGeneration()
    if (afterHolding.status !== 'committed') throw new Error('expected committed generation')
    expect(afterHolding.payload.holdings[0].eval).toBe(175_000)
    expect(afterHolding.payload.trust).toEqual(before.payload.trust)
    expect(afterHolding.payload.importedAt).toBe(before.payload.importedAt)
    expect(afterHolding.payload.syncSummary).toEqual(before.payload.syncSummary)

    useAppStore.getState().updateTrust('fund-1', { eval: 275_000 })
    const afterTrust = restoreCsvImportGeneration()
    if (afterTrust.status !== 'committed') throw new Error('expected committed generation')
    expect(afterTrust.payload.holdings[0].eval).toBe(175_000)
    expect(afterTrust.payload.trust[0].eval).toBe(275_000)
    expect(afterTrust.payload.importedAt).toBe(before.payload.importedAt)
    expect(afterTrust.payload.syncSummary).toEqual(before.payload.syncSummary)
  })

  it('parser/no-valid-rows failure returns NO_VALID_ROWS and leaves all relevant state and persistence unchanged', async () => {
    const before = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile(''))

    expect(result).toMatchObject({ ok: false, code: 'NO_VALID_ROWS', persistence: { status: 'not_attempted' } })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('full-sync guard rejection returns FULL_SYNC_GUARD_REJECTED and commits nothing', async () => {
    useAppStore.setState({ holdings: [holding('1001'), holding('1002'), holding('1003')] })
    const before = relevantState()
    const guardedCsv = VALID_CSV.replace('1001,銘柄1001', '9999,別銘柄')
    const result = await useAppStore.getState().importCsv(csvFile(guardedCsv))

    expect(result).toMatchObject({ ok: false, code: 'FULL_SYNC_GUARD_REJECTED' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('analysis exception after parse/full-sync returns ANALYSIS_ERROR without exposing a partial generation', async () => {
    const currentMarket = useAppStore.getState().market
    const throwingMarket = new Proxy(currentMarket, {
      get(target, property) {
        if (property === 'regime') throw new Error('forced analysis failure')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ market: throwingMarket })
    const before = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('officialDecision generation failure is not swallowed and commits nothing', async () => {
    const currentSafeMode = useAppStore.getState().safeMode
    const throwingSafeMode = new Proxy(currentSafeMode, {
      get(target, property) {
        if (property === 'safe_mode') throw new Error('forced official decision failure')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ safeMode: throwingSafeMode })
    const before = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'OFFICIAL_DECISION_ERROR' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('F001: analysis failure does not mutate the pre-existing trust-short snapshot', async () => {
    const oldSnapshot = '{"date":"2026-07-01","total":200000,"evalById":{"fund-1":200000}}'
    storage.v95_trust_short_snapshot = oldSnapshot
    vi.stubGlobal('window', { localStorage: localStorageMock })
    useAppStore.setState({ trust: [shortTrust()] })
    const currentMarket = useAppStore.getState().market
    const throwingMarket = new Proxy(currentMarket, {
      get(target, property) {
        if (property === 'regime') throw new Error('forced analysis failure after staging')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ market: throwingMarket })
    const before = structuredClone(relevantState())

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    expect(structuredClone(relevantState())).toEqual(before)
    expect(storage.v95_trust_short_snapshot).toBe(oldSnapshot)
  })

  it('FileReader failure returns FILE_READ_ERROR and commits nothing', async () => {
    const before = relevantState()
    const brokenFile = {
      name: 'broken.csv',
      arrayBuffer: () => Promise.reject(new Error('disk read failed')),
    } as File
    const result = await useAppStore.getState().importCsv(brokenFile)

    expect(result).toMatchObject({ ok: false, code: 'FILE_READ_ERROR' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('R2: async onload callback exceptions settle structurally, release loading, and allow retry', async () => {
    class CallbackThrowReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      readAsArrayBuffer() {
        queueMicrotask(() => {
          try {
            this.onload?.({
              target: { get result() { throw new Error('async result getter exploded') } },
            } as unknown as ProgressEvent<FileReader>)
          } catch {
            // Event callback exceptions are reported outside the Promise by browsers.
          }
        })
      }
    }
    vi.stubGlobal('FileReader', CallbackThrowReader)

    const settled = await Promise.race([
      useAppStore.getState().importCsv(csvFile()),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 40)),
    ])

    expect(settled).not.toBe('timeout')
    expect(settled).toMatchObject({ ok: false, code: 'FILE_READ_ERROR' })
    expect(useAppStore.getState().system.status).not.toBe('loading')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()

    vi.stubGlobal('FileReader', TestFileReader)
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })

  it('persistence write failure rolls all keys back and leaves the store generation unchanged', async () => {
    storage.v81_portfolio = 'old-portfolio'
    storage.v81_trust = 'old-trust'
    storage.v10_csv_imported_at = 'old-imported-at'
    storage.v13_csv_sync_summary = 'old-summary'
    storage.v91_learning = 'old-learning'
    const persistedBefore = { ...storage }
    const stateBefore = relevantState()
    failStorageWriteAt = 1

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: false,
      code: 'PERSISTENCE_ERROR',
      persistence: { status: 'rolled_back' },
    })
    expect(relevantState()).toEqual(stateBefore)
    expect(storage).toEqual(persistedBefore)
  })

  it('deep state and all portfolio-generation references remain unchanged on forced persistence failure', async () => {
    useAppStore.setState(runFullAnalysis(useAppStore.getState()))
    const beforeReferences = relevantState()
    const beforeDeep = structuredClone(beforeReferences)
    let portfolioNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.holdings !== previous.holdings || state.trust !== previous.trust ||
        state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision ||
        state.learning !== previous.learning || state.universe !== previous.universe ||
        state.zeroPlan !== previous.zeroPlan || state.stockPlan !== previous.stockPlan ||
        state.trustPlan !== previous.trustPlan || state.stockCandidates !== previous.stockCandidates
      ) portfolioNotifications += 1
    })
    failStorageWriteAt = 1

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' })
    expect(relevantState()).toEqual(beforeReferences)
    expect(structuredClone(relevantState())).toEqual(beforeDeep)
    expect(portfolioNotifications).toBe(0)
  })

  it('a second import while one is pending is explicitly rejected', async () => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const first = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    const second = await useAppStore.getState().importCsv(csvFile())
    expect(second).toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })

    release(new TextEncoder().encode(VALID_CSV).buffer)
    await first
  })

  it('F002: a cash dependency mutation while reading the CSV causes an explicit conflict', async () => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const first = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    useAppStore.getState().setCashAssumptions({ cashDeposits: 9_000_000, standbyFunds: 8_000_000 })
    release(new TextEncoder().encode(VALID_CSV).buffer)

    await expect(first).resolves.toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(useAppStore.getState().cashAssumptions).toMatchObject({
      cashDeposits: 9_000_000,
      standbyFunds: 8_000_000,
    })
    expect(useAppStore.getState().holdings[0].eval).toBe(100_000)

    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })

  it('canonical changed after transaction capture is rejected by pre-write CAS and remains retryable', async () => {
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
    const previousGlobal = structuredClone(relevantState())
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const importing = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    const previous = restoreCsvImportGeneration()
    if (previous.status !== 'committed') throw new Error('expected committed generation')
    persistCsvImportTransaction({
      ...previous.payload,
      holdings: previous.payload.holdings.map(item => ({ ...item, eval: 888_000 })),
    }, previous.savedAt + 1)
    const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
    release(new TextEncoder().encode(VALID_CSV.replace('150000,8.00', '175000,8.00')).buffer)

    await expect(importing).resolves.toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      persistence: { status: 'not_attempted' },
    })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(relevantState()).toEqual(previousGlobal)
    expect(restorePortfolio()?.[0].eval).toBe(888_000)
    expect(useAppStore.getState().system.status).toBe('error')

    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['standby cash', () => useAppStore.getState().setCashAssumptions({ cashDeposits: 1_000_000, standbyFunds: 7_000_000 })],
    ['portfolio policy', () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.15 })],
    ['market refresh dependency', () => useAppStore.setState(state => ({ market: { ...state.market, nikkeiChgPct: state.market.nikkeiChgPct + 0.01 } }))],
    ['SAFE_MODE dependency', () => useAppStore.setState(state => ({
      safeMode: { ...state.safeMode, safe_mode: { ...state.safeMode.safe_mode, active: !state.safeMode.safe_mode.active } },
    }))],
  ])('concurrent %s mutation cannot silently commit stale analysis', async (_label, mutate) => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File
    const first = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    mutate()
    release(new TextEncoder().encode(VALID_CSV).buffer)

    await expect(first).resolves.toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(useAppStore.getState().holdings[0].eval).toBe(100_000)
    expect(useAppStore.getState().system.status).not.toBe('loading')
  })

  it.each([
    ['cash', () => useAppStore.setState(state => ({
      cashAssumptions: { ...state.cashAssumptions, cashDeposits: state.cashAssumptions.cashDeposits + 123_456 },
    }))],
    ['market', () => useAppStore.setState(state => ({
      market: { ...state.market, nikkeiChgPct: state.market.nikkeiChgPct + 3.25 },
    }))],
    ['policy', () => useAppStore.setState(state => ({
      portfolioPolicy: { jpStockMaxRatio: state.portfolioPolicy.jpStockMaxRatio + 0.01 },
    }))],
    ['SAFE_MODE', () => useAppStore.setState(state => ({
      safeMode: { ...state.safeMode, safe_mode: { ...state.safeMode.safe_mode, active: !state.safeMode.safe_mode.active } },
    }))],
  ])('R5: synchronous storage reentry changing %s cannot publish stale derived SUCCESS', async (_label, mutate) => {
    let fired = false
    storageReentry = () => {
      if (fired) return
      fired = true
      mutate()
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    storageReentry = null
    const state = useAppStore.getState()
    const recomputed = runFullAnalysis(state, { requireOfficialDecision: true })

    expect(result.ok).toBe(true)
    expect(withoutGeneratedTimestamps(state.analysis)).toEqual(withoutGeneratedTimestamps(recomputed.analysis))
    expect(withoutGeneratedTimestamps(state.universe)).toEqual(withoutGeneratedTimestamps(recomputed.universe))
    expect(withoutGeneratedTimestamps(state.zeroPlan)).toEqual(withoutGeneratedTimestamps(recomputed.zeroPlan))
    expect(withoutGeneratedTimestamps(state.stockPlan)).toEqual(withoutGeneratedTimestamps(recomputed.stockPlan))
    expect(withoutGeneratedTimestamps(state.trustPlan)).toEqual(withoutGeneratedTimestamps(recomputed.trustPlan))
    expect(withoutGeneratedTimestamps(state.officialDecision)).toEqual(withoutGeneratedTimestamps(recomputed.officialDecision))
  })

  it('R5: repeated mixed action/public-set reentry is rejected for the critical section and remains retryable', async () => {
    const cashBefore = useAppStore.getState().cashAssumptions
    const policyBefore = useAppStore.getState().portfolioPolicy
    storageReentry = () => {
      useAppStore.getState().setCashAssumptions({ cashDeposits: 9_000_000, standbyFunds: 8_000_000 })
      useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.2 })
      useAppStore.setState(state => ({ market: { ...state.market, nikkeiChgPct: 99 } }))
      useAppStore.setState(state => ({
        safeMode: { ...state.safeMode, safe_mode: { ...state.safeMode.safe_mode, active: true } },
      }))
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    storageReentry = null
    const state = useAppStore.getState()
    const recomputed = runFullAnalysis(state, { requireOfficialDecision: true })

    expect(result.ok).toBe(true)
    expect(state.cashAssumptions).toEqual(cashBefore)
    expect(state.portfolioPolicy).toEqual(policyBefore)
    expect(withoutGeneratedTimestamps(state.officialDecision)).toEqual(withoutGeneratedTimestamps(recomputed.officialDecision))
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('R5: a final-publish subscriber cannot synchronously replace dependencies before later observers run', async () => {
    const marketBefore = useAppStore.getState().market
    let laterObservedConsistent = false
    const unsubscribeMutating = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        useAppStore.setState(current => ({
          market: { ...current.market, nikkeiChgPct: current.market.nikkeiChgPct + 42 },
        }))
      }
    })
    const unsubscribeLater = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        const recomputed = runFullAnalysis(state, { requireOfficialDecision: true })
        laterObservedConsistent = withoutGeneratedTimestamps(state.officialDecision) === null
          ? recomputed.officialDecision === null
          : JSON.stringify(withoutGeneratedTimestamps(state.officialDecision)) ===
            JSON.stringify(withoutGeneratedTimestamps(recomputed.officialDecision))
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribeMutating()
    unsubscribeLater()

    expect(result.ok).toBe(true)
    expect(useAppStore.getState().market).toEqual(marketBefore)
    expect(laterObservedConsistent).toBe(true)
  })

  it('F1: nested import from a publish subscriber is rejected without releasing the outer mutation guard', async () => {
    const marketBefore = useAppStore.getState().market
    let nestedResult: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> | null = null
    let nestedPromise: Promise<void> | null = null
    let nestedAttempts = 0
    const unsubscribeNested = useAppStore.subscribe((state, previous) => {
      if (state.holdings === previous.holdings || nestedAttempts > 0) return
      nestedAttempts += 1
      nestedPromise = useAppStore.getState().importCsv(csvFile()).then(result => {
        nestedResult = result
      })
    })
    const unsubscribeMutating = useAppStore.subscribe((state, previous) => {
      if (state.holdings === previous.holdings) return
      useAppStore.setState(current => ({
        market: { ...current.market, nikkeiChgPct: current.market.nikkeiChgPct + 42 },
      }))
    })

    const outerResult = await useAppStore.getState().importCsv(csvFile())
    if (nestedPromise) await nestedPromise
    unsubscribeNested()
    unsubscribeMutating()

    expect(outerResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(nestedResult).toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })
    expect(useAppStore.getState().market).toEqual(marketBefore)
    expect(useAppStore.getState().system.status).toBe('success')
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('F2: tracker mutation during canonical write cannot publish stale tracker-derived SUCCESS', async () => {
    const nextTracker = JSON.stringify({
      entries: [{
        date: '2026-07-15', decision: 'BULL', confidence: 90, executed: true,
        outcome: 'win', nikkeiChgPct: 1, futuresChgPct: 1, conditionsPassed: 5,
        vix: 15, nikkeiVI: 18, volatilitySpread: 0, updatedAt: '2026-07-15T00:00:00.000Z',
      }],
    })
    let fired = false
    let nestedResult: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> | null = null
    let nestedPromise: Promise<void> | null = null
    storageReentry = () => {
      if (fired) return
      fired = true
      storage.v95_trust_short_tracker = nextTracker
      nestedPromise = useAppStore.getState().importCsv(csvFile()).then(value => { nestedResult = value })
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    if (nestedPromise) await nestedPromise
    storageReentry = null

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(nestedResult).toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(storage.v95_trust_short_tracker).toBeUndefined()
    expect(useAppStore.getState().holdings[0].eval).toBe(100_000)
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('C1: valid external canonical replacement loses exact-byte ownership without publishing or rollback', async () => {
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
    const previousGlobalEval = useAppStore.getState().holdings[0].eval
    const previousRaw = storage[CSV_IMPORT_GENERATION_KEY]
    const previous = restoreCsvImportGeneration()
    if (previous.status !== 'committed') throw new Error('expected committed baseline generation')

    persistCsvImportTransaction({
      ...previous.payload,
      holdings: previous.payload.holdings.map(item => ({ ...item, eval: 999_000 })),
    }, previous.savedAt + 1)
    const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
    storage[CSV_IMPORT_GENERATION_KEY] = previousRaw

    let transactionCommittedRaw: string | null = null
    let replaced = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || replaced) return
      replaced = true
      transactionCommittedRaw = storage[key]
      storage[key] = externalRaw
    }

    const nextCsv = VALID_CSV.replace('150000,8.00', '175000,8.00')
    const result = await useAppStore.getState().importCsv(csvFile(nextCsv))
    storageReentry = null

    expect(transactionCommittedRaw).not.toBeNull()
    expect(transactionCommittedRaw).not.toBe(externalRaw)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(result).toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      persistence: { status: 'ownership_lost' },
    })
    expect(useAppStore.getState().holdings[0].eval).toBe(previousGlobalEval)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { holdings: [{ eval: 999_000 }] },
    })
    expect(restorePortfolio()?.[0].eval).toBe(999_000)
    expect(useAppStore.getState().system.status).toBe('error')

    storageReentry = null
    await expect(useAppStore.getState().importCsv(csvFile(nextCsv))).resolves.toMatchObject({ ok: true })
  })

  it('C2: sell-lock boundary crossing keeps analysis, plans, and official decision on one transaction clock', async () => {
    vi.useFakeTimers()
    const analysisNow = new Date('2026-07-15T14:00:00.000Z').getTime()
    const afterThreshold = analysisNow + 12 * 60 * 60 * 1000
    vi.setSystemTime(analysisNow)
    useAppStore.setState(state => ({
      holdings: [{
        ...holding(),
        mu: -0.2,
        sigma: 0.5,
        beta: 1.5,
        ma: false,
        rsi: 80,
        macd: false,
        mom3m: -20,
        roe: 0,
        per: 100,
        epsG: -30,
        cfOk: false,
        de: 10,
        divG: 0,
      }],
      system: {
        ...state.system,
        dataSourceStatus: {
          ...state.system.dataSourceStatus,
          market: 'loaded',
          safeMode: 'loaded',
        },
        dataTimestamps: {
          ...state.system.dataTimestamps,
          market: new Date(analysisNow).toISOString(),
          safeMode: new Date(analysisNow).toISOString(),
        } as NonNullable<typeof state.system.dataTimestamps>,
      },
    }))
    const boundaryCsv = VALID_CSV.replace('2025-01-01', '2026-04-17')

    class BoundaryCrossingReader extends TestFileReader {
      override readAsArrayBuffer(file: File) {
        file.arrayBuffer()
          .then(result => {
            vi.setSystemTime(afterThreshold)
            this.onload?.({ target: { result } })
          })
          .catch(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', BoundaryCrossingReader)

    try {
      const result = await useAppStore.getState().importCsv(csvFile(boundaryCsv))
      const state = useAppStore.getState()
      const analysis = state.analysis.find(item => item.code === '1001')
      const stockRow = state.stockPlan?.rows.find(item => item.code === '1001')
      const zeroAction = state.zeroPlan?.proposals.find(item => item.code === '1001')
      const officialAction = state.officialDecision?.actions.find(item => item.code === '1001')

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(state.system.analysisLastRunAt).toBe(new Date(analysisNow).toISOString())
      expect(state.stockPlan?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(state.zeroPlan?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(state.trustPlan?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(state.officialDecision?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(analysis?.debate.recommendedAction).toContain('売却不可期間中')
      expect(stockRow?.locked).toBe(true)
      expect(zeroAction?.action).toBe('WAIT')
      expect(officialAction?.action).toBe('HOLD')

      vi.stubGlobal('FileReader', TestFileReader)
      const nextResult = await useAppStore.getState().importCsv(csvFile(boundaryCsv))
      const nextState = useAppStore.getState()
      const nextAnalysis = nextState.analysis.find(item => item.code === '1001')
      const nextStockRow = nextState.stockPlan?.rows.find(item => item.code === '1001')
      const nextZeroAction = nextState.zeroPlan?.proposals.find(item => item.code === '1001')
      const nextOfficialAction = nextState.officialDecision?.actions.find(item => item.code === '1001')

      expect(nextResult).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(nextState.system.analysisLastRunAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.stockPlan?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.zeroPlan?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.trustPlan?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.officialDecision?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextAnalysis?.debate.recommendedAction).not.toContain('売却不可期間中')
      expect(nextStockRow?.locked).toBe(false)
      expect(nextZeroAction?.action).toBe('SELL')
      expect(nextOfficialAction?.action).toBe('SELL')
    } finally {
      vi.stubGlobal('FileReader', TestFileReader)
      vi.useRealTimers()
    }
  })

  it('F3: persistence-time clock crossing cannot change a transaction-scoped analysis result', async () => {
    vi.useFakeTimers()
    const analysisNow = new Date('2026-07-15T14:00:00.000Z').getTime()
    vi.setSystemTime(analysisNow)
    storage.v95_trust_short_tracker = JSON.stringify({
      entries: [{
        date: '2026-06-15', decision: 'BULL', confidence: 90, executed: true,
        outcome: 'win', nikkeiChgPct: 1, futuresChgPct: 1, conditionsPassed: 5,
        vix: 15, nikkeiVI: 18, volatilitySpread: 0, updatedAt: '2026-06-15T00:00:00.000Z',
      }],
    })
    useAppStore.setState(state => ({
      cashAssumptions: {
        cashDeposits: 4_000_000,
        standbyFunds: 1_000_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: new Date(analysisNow - 167 * 60 * 60 * 1000).toISOString(),
      },
      system: {
        ...state.system,
        dataSourceStatus: {
          ...state.system.dataSourceStatus,
          market: 'loaded',
          safeMode: 'loaded',
        },
        dataTimestamps: {
          ...state.system.dataTimestamps,
          market: new Date(analysisNow - 23 * 60 * 60 * 1000).toISOString(),
          safeMode: new Date(analysisNow - 95 * 60 * 60 * 1000).toISOString(),
        } as NonNullable<typeof state.system.dataTimestamps>,
      },
    }))
    let fired = false
    storageReentry = () => {
      if (fired) return
      fired = true
      vi.setSystemTime(analysisNow + 2 * 60 * 60 * 1000)
    }

    try {
      const result = await useAppStore.getState().importCsv(csvFile())
      storageReentry = null
      const state = useAppStore.getState()
      const fixedRecomputed = runFullAnalysis(state, {
        requireOfficialDecision: true,
        nowMs: analysisNow,
      } as { requireOfficialDecision: true; nowMs: number })

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(state.system.analysisLastRunAt).toBe(new Date(analysisNow).toISOString())
      expect(withoutGeneratedTimestamps(state.officialDecision))
        .toEqual(withoutGeneratedTimestamps(fixedRecomputed.officialDecision))
      expect(state.officialDecision?.dataQualitySuppressed).toBe(false)
      expect(state.trustPlan?.performance30d.trackedDays).toBe(1)

      const nextResult = await useAppStore.getState().importCsv(csvFile())
      expect(nextResult).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(useAppStore.getState().officialDecision?.dataQualitySuppressed).toBe(true)
      expect(useAppStore.getState().trustPlan?.performance30d.trackedDays).toBe(0)
    } finally {
      storageReentry = null
      vi.useRealTimers()
    }
  })

  it('multiple nested publish attempts plus a throwing observer preserve one outer generation and retryability', async () => {
    const nestedResults: Array<Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>>> = []
    const nestedPromises: Promise<void>[] = []
    const subscribeNested = () => useAppStore.subscribe((state, previous) => {
      if (state.holdings === previous.holdings) return
      nestedPromises.push(useAppStore.getState().importCsv(csvFile()).then(result => { nestedResults.push(result) }))
    })
    const unsubscribeFirst = subscribeNested()
    const unsubscribeThrowing = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) throw new Error('nested observer failure')
    })
    const unsubscribeSecond = subscribeNested()
    let laterCalls = 0
    const unsubscribeLater = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) laterCalls += 1
    })

    const outer = await useAppStore.getState().importCsv(csvFile())
    await Promise.all(nestedPromises)
    unsubscribeFirst()
    unsubscribeThrowing()
    unsubscribeSecond()
    unsubscribeLater()

    expect(outer).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(nestedResults).toHaveLength(2)
    expect(nestedResults.every(result => !result.ok && result.code === 'IMPORT_IN_PROGRESS')).toBe(true)
    expect(laterCalls).toBe(1)
    expect(useAppStore.getState().system.status).toBe('success')
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('R6: absent canonical permits legacy trust snapshot baseline and PUBLISHED rejects nested telemetry import', async () => {
    useAppStore.setState({ trust: [shortTrust()] })
    storage.v95_trust_short_snapshot = JSON.stringify({
      date: '2026-07-01',
      total: 1,
      evalById: { 'fund-1': 0 },
    })
    let nestedResult: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> | null = null
    let nestedPromise: Promise<void> | null = null
    storageReentry = key => {
      if (key !== 'v95_trust_short_tracker' || nestedPromise) return
      nestedPromise = useAppStore.getState().importCsv(csvFile()).then(result => { nestedResult = result })
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    if (nestedPromise) await nestedPromise
    storageReentry = null

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(storage.v95_trust_short_tracker).toBeDefined()
    expect(nestedResult).toMatchObject({ ok: false, code: 'IMPORT_IN_PROGRESS' })
    expect(useAppStore.getState().system.status).toBe('success')
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('R6: present-invalid canonical forbids legacy trust snapshot fallback', async () => {
    useAppStore.setState({ trust: [shortTrust()] })
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    storage.v95_trust_short_snapshot = JSON.stringify({
      date: '2026-07-01',
      total: 1,
      evalById: { 'fund-1': 0 },
    })

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(storage.v95_trust_short_tracker).toBeUndefined()
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed' })
  })

  it('F004: an unexpected staging exception is structured and always releases loading', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Number.NaN)
    const before = structuredClone(relevantState())
    try {
      const result = await useAppStore.getState().importCsv(csvFile())
      expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
      expect(useAppStore.getState().system.status).not.toBe('loading')
      expect(structuredClone(relevantState())).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })
})
