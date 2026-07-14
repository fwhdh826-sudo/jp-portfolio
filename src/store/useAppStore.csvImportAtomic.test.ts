import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding, Trust } from '../types'
import { useAppStore } from './useAppStore'

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
  }
}

describe('T9-A001/A002: structured CSV result and atomic store commit', () => {
  const storage: Record<string, string> = {}
  let storageWriteCount = 0
  let failStorageWriteAt: number | null = null
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storageWriteCount += 1
      if (storageWriteCount === failStorageWriteAt) throw new Error('forced quota failure')
      storage[key] = value
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  beforeEach(() => {
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    storageWriteCount = 0
    failStorageWriteAt = null
    useAppStore.setState(state => ({
      holdings: [holding()],
      trust: [trust()],
      correlation: null,
      market: baseMarket,
      safeMode: baseSafeMode,
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
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

  it('persistence write failure rolls all keys back and leaves the store generation unchanged', async () => {
    storage.v81_portfolio = 'old-portfolio'
    storage.v81_trust = 'old-trust'
    storage.v10_csv_imported_at = 'old-imported-at'
    storage.v13_csv_sync_summary = 'old-summary'
    storage.v91_learning = 'old-learning'
    const persistedBefore = { ...storage }
    const stateBefore = relevantState()
    failStorageWriteAt = 2

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: false,
      code: 'PERSISTENCE_ERROR',
      persistence: { status: 'rolled_back' },
    })
    expect(relevantState()).toEqual(stateBefore)
    expect(storage).toEqual(persistedBefore)
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
})
