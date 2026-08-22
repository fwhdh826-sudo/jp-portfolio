// UI-9F-A-RUNTIME-STATE-INTEGRITY — F-P0-2 required tests (A〜Eに対応)。
// static loader失敗を握り潰してstoreがsuccess/lastUpdated=nowを publishしないこと、
// 「データ値のfallback」と「取得成功status」が分離されていることをinitialize/refreshAllData
// を実際に駆動して検証する。vacuous回避のため、fixtureごとに異なるsource/data構成を渡し、
// 実装のclassifyDataSourceOutcomes/publishロジックを通す。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadProbe = vi.hoisted(() => ({
  calls: 0,
  implementation: null as null | (() => Promise<unknown>),
}))

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

import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import {
  DEFAULT_CANDIDATES_NEWS_DATA,
  DEFAULT_CANDIDATES_STOCKS_DATA,
  DEFAULT_REGIME_STATE,
  DEFAULT_SAFE_MODE_SNAPSHOT,
  DEFAULT_TIER_A_ALERTS_SNAPSHOT,
  DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
} from '../services/loadStaticData'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
} from './portfolioGenerationLock'
import { FakeLockManager } from './testing/fakeLockManager'
import { createAppStoreInstanceForTest } from './useAppStore'

// F-A-P0-2: importCsvはFileReader経由でCSVを読み込むため、node環境用の最小polyfillを用意する
// （domain/csv/importPortfolioCsv.test.tsと同じ方式）。
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReaderPolyfill {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
    onerror: (() => void) | null = null
    result: ArrayBuffer | null = null
    readAsArrayBuffer(file: File) {
      file.arrayBuffer().then(buf => {
        this.result = buf
        this.onload?.({ target: { result: buf } })
      }).catch(() => {
        this.onerror?.()
      })
    }
  }
  // @ts-expect-error Node環境専用の最小FileReader polyfill
  globalThis.FileReader = NodeFileReaderPolyfill
}

const NOW_MS = Date.parse('2026-08-22T05:00:00.000Z')
const PRIOR_LAST_UPDATED = '2026-08-20T00:00:00.000Z'

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

function adapter(manager: FakeLockManager): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 60_000 })
}

function instance(manager: FakeLockManager, priorLastUpdated: string | null) {
  const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
  created.store.setState(state => ({
    holdings: [],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    metrics: null,
    analysis: [],
    officialDecision: null,
    system: {
      ...state.system,
      status: 'initializing', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null, analysisLastRunAt: null,
      lastUpdated: priorLastUpdated,
    },
  }))
  return created
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

function baseMarket() {
  return {
    regime: 'neutral' as const, nikkei: 30000, nikkeiChgPct: 0, vix: 18,
    usdjpy: 150, last_updated: '2026-08-22 05:00',
  }
}

function candidateFunnelArtifact() {
  return structuredClone(buildValidCandidateFunnelArtifact())
}

/** 17ソース全てが本当に取得成功したことを表すfixture。 */
function allLoadedPublishedData() {
  return {
    market: { data: baseMarket(), source: 'loaded' },
    correlation: { data: null, source: 'loaded' },
    news: { data: null, source: 'loaded' },
    trust: { data: [], source: 'static', lastUpdated: null },
    holdingsSnapshot: { data: { holdings: [] }, source: 'static', lastUpdated: null },
    macro: { data: null, source: 'loaded' },
    nikkeiVI: { data: null, source: 'loaded' },
    sq: { data: null, source: 'loaded' },
    margin: { data: null, source: 'loaded' },
    flows: { data: null, source: 'loaded' },
    candidatesNews: { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'loaded' },
    candidatesStocks: { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'loaded' },
    candidateFunnel: { status: 'loaded' as const, data: candidateFunnelArtifact() },
    regimeState: { data: DEFAULT_REGIME_STATE, source: 'loaded', generatedAt: null },
    safeMode: { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'loaded', lastChecked: null },
    tierAViolations: { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'loaded', generatedAt: null },
    tierAAlerts: { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'loaded', generatedAt: null },
  }
}

/** 17ソース全てがfetch/parse失敗でfallbackしたfixture（fail-soft値は入っているが取得は失敗）。 */
function allFallbackPublishedData() {
  return {
    market: { data: baseMarket(), source: 'static' }, // fallback値は「使える」が取得は失敗している
    correlation: { data: null, source: 'static' },
    news: { data: null, source: 'error' },
    trust: { data: null, source: 'static', lastUpdated: null },
    holdingsSnapshot: { data: null, source: 'none', lastUpdated: null },
    macro: { data: null, source: 'none' },
    nikkeiVI: { data: null, source: 'none' },
    sq: { data: null, source: 'none' },
    margin: { data: null, source: 'none' },
    flows: { data: null, source: 'none' },
    candidatesNews: { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' },
    candidatesStocks: { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'default' },
    candidateFunnel: { status: 'unavailable' as const, data: null },
    regimeState: { data: DEFAULT_REGIME_STATE, source: 'default', generatedAt: null },
    safeMode: { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'default', lastChecked: null },
    tierAViolations: { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'default', generatedAt: null },
    tierAAlerts: { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'default', generatedAt: null },
  }
}

function baseMacro() {
  return {
    last_updated: '2026-08-22 05:00', jgb10y: 1.45, ust10y: 4.7, usdjpy: 159.3, usdjpyChgPct: -0.1,
    sp500: 7785.8, sp500ChgPct: -0.2, nasdaq: 26729.2, nasdaqChgPct: -0.3, vix: 14.9, vixChg: 0.7,
    nikkeiVI: 14.16, nikkeiVIChg: 0.6, gold: 4460.1, goldChgPct: 1.8, nyCrude: 82.4, nyCrudeChgPct: 0.1,
  }
}

/**
 * F-A-P0-1: 本番の正常デプロイに一致するfixture。trust/holdings/nikkei_vi.jsonの3ソースは
 * 恒久的に配信されない（trust/holdingsはprivacy方針でリポジトリに一度もコミットされない、
 * nikkei_vi.jsonはgenerator不在のdead legacy source — macro.jsonが自前のnikkeiVIを持つ）。
 * 残り14ソースは全て取得成功しているという「正常な本番」を表す。
 */
function normalProductionPublishedData() {
  return {
    market: { data: baseMarket(), source: 'loaded' },
    correlation: { data: null, source: 'loaded' },
    news: { data: null, source: 'loaded' },
    trust: { data: null, source: 'static', lastUpdated: null }, // privacy: public/data/trust_master.jsonは常に存在しない
    holdingsSnapshot: { data: null, source: 'none', lastUpdated: null }, // privacy: public/data/holdings.jsonは常に存在しない
    macro: { data: baseMacro(), source: 'loaded' },
    nikkeiVI: { data: null, source: 'none' }, // legacy: public/data/nikkei_vi.jsonはgenerator不在で常に存在しない
    sq: { data: null, source: 'loaded' },
    margin: { data: null, source: 'loaded' },
    flows: { data: null, source: 'loaded' },
    candidatesNews: { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'loaded' },
    candidatesStocks: { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'loaded' },
    candidateFunnel: { status: 'loaded' as const, data: candidateFunnelArtifact() },
    regimeState: { data: DEFAULT_REGIME_STATE, source: 'loaded', generatedAt: null },
    safeMode: { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'loaded', lastChecked: null },
    tierAViolations: { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'loaded', generatedAt: null },
    tierAAlerts: { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'loaded', generatedAt: null },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  Object.keys(storage).forEach(key => delete storage[key])
  loadProbe.calls = 0
  loadProbe.implementation = null
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('A: initialize開始時はinitializingであり、success/errorを僭称しない', () => {
  it('initialize呼び出し前のstoreはstatus=initializing（success/error表示に対応する値ではない）', () => {
    const manager = new FakeLockManager()
    const a = instance(manager, null)
    expect(a.store.getState().system.status).toBe('initializing')
    expect(a.store.getState().system.status).not.toBe('success')
    expect(a.store.getState().system.status).not.toBe('error')
  })
})

describe('B: 全loaderが成功した場合のみsuccess', () => {
  it('status=success / lastUpdatedが更新される', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => allLoadedPublishedData()
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.status).toBe('success')
    expect(a.store.getState().system.lastUpdated).toBe(new Date(NOW_MS).toISOString())
    expect(a.store.getState().system.lastUpdated).not.toBe(PRIOR_LAST_UPDATED)
  })
})

describe('C: 1 loaderがHTTP500相当でfallbackした場合', () => {
  it('statusはsuccessにならない／F-A-P1-3: partialではlastUpdatedを進めず前回値を維持する／error到達可能', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...allLoadedPublishedData(),
      market: { data: baseMarket(), source: 'static' }, // market.jsonのみHTTP500でfallback
    })
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const system = a.store.getState().system
    expect(system.status).not.toBe('success')
    expect(system.status).toBe('partial')
    // F-A-P0-1: required source denominatorは14件（trust/holdings/nikkeiVIを除く）。
    expect(system.dataSourceOutcome).toEqual({ loaded: 13, total: 14 })
    // F-A-P1-3: partialではlastUpdatedは「試行時刻」ではなく前回値のまま据え置く。
    expect(system.lastUpdated).toBe(PRIOR_LAST_UPDATED)
  })

  it('全loaderがHTTP500でfallbackした場合、statusはsuccessにならずlastUpdatedも偽更新されない', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => allFallbackPublishedData()
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const system = a.store.getState().system
    expect(system.status).not.toBe('success')
    expect(system.status).toBe('failed')
    // lastUpdatedは「試行時刻」ではなく前回値のまま据え置かれる
    expect(system.lastUpdated).toBe(PRIOR_LAST_UPDATED)
    expect(system.lastUpdated).not.toBe(new Date(NOW_MS).toISOString())
  })

  it('起動時（前回値がnull）に全滅した場合はlastUpdatedがnullのまま（当日時刻を偽装しない）', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, null)
    loadProbe.implementation = async () => allFallbackPublishedData()
    await grant(manager, a.store.getState().initialize())
    expect(a.store.getState().system.lastUpdated).toBeNull()
    expect(a.store.getState().system.status).toBe('failed')
  })
})

describe('D: JSONスキーマ不正・parse失敗として扱われるfallbackも同様にfailure伝播する', () => {
  it('candidate_funnel.jsonがinvalid(parse/validation失敗)でも、statusはsuccessにならない', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...allLoadedPublishedData(),
      candidateFunnel: { status: 'invalid' as const, data: null },
    })
    await grant(manager, a.store.getState().initialize())
    const system = a.store.getState().system
    expect(system.status).not.toBe('success')
    expect(system.status).toBe('partial')
  })

  it('candidates_news.jsonがschema不正でdefaultにfallbackしても、statusはsuccessにならない', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...allLoadedPublishedData(),
      candidatesNews: { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' },
    })
    await grant(manager, a.store.getState().initialize())
    expect(a.store.getState().system.status).not.toBe('success')
    expect(a.store.getState().system.status).toBe('partial')
  })
})

describe('E: fallback値が利用可能でもfetch failureをsuccess扱いしない', () => {
  it('marketのfallback値(STATIC_MARKET相当)は表示できる実データだが、取得失敗そのものはsuccessと扱わない', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...allLoadedPublishedData(),
      market: { data: baseMarket(), source: 'static' },
    })
    await grant(manager, a.store.getState().initialize())
    const state = a.store.getState()
    // fallback値そのものは公開される（fail-soft data fallbackは維持）
    expect(state.market).toEqual(baseMarket())
    // しかし取得成功statusとしては扱わない
    expect(state.system.status).not.toBe('success')
    expect(state.system.dataSourceStatus.market).toBe('static')
  })
})

describe('F/G/H: loading→success / loading→error(failed) / loading→empty(data-unavailable) を区別する', () => {
  it('F: initializing→success', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, null)
    expect(a.store.getState().system.status).toBe('initializing')
    loadProbe.implementation = async () => allLoadedPublishedData()
    await grant(manager, a.store.getState().initialize())
    expect(a.store.getState().system.status).toBe('success')
  })

  it('G: initializing→failed（error到達可能な状態）', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, null)
    expect(a.store.getState().system.status).toBe('initializing')
    loadProbe.implementation = async () => allFallbackPublishedData()
    await grant(manager, a.store.getState().initialize())
    expect(a.store.getState().system.status).toBe('failed')
  })

  it('H: initializing→partial（一部データ未取得。emptyでもsuccessでもない別状態として区別される）', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, null)
    expect(a.store.getState().system.status).toBe('initializing')
    loadProbe.implementation = async () => ({
      ...allLoadedPublishedData(),
      news: { data: null, source: 'error' },
      macro: { data: null, source: 'none' },
    })
    await grant(manager, a.store.getState().initialize())
    const status = a.store.getState().system.status
    expect(status).not.toBe('initializing')
    expect(status).not.toBe('success')
    expect(status).not.toBe('failed')
    expect(status).toBe('partial')
  })
})

describe('refreshAllDataでも同一の集計ロジックが適用される', () => {
  it('refreshAllDataが全滅した場合もstatus=failed・lastUpdated据え置き', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => allLoadedPublishedData()
    await grant(manager, a.store.getState().initialize())
    expect(a.store.getState().system.status).toBe('success')
    const afterInitializeLastUpdated = a.store.getState().system.lastUpdated

    loadProbe.implementation = async () => allFallbackPublishedData()
    await grant(manager, a.store.getState().refreshAllData())
    const system = a.store.getState().system
    expect(system.status).toBe('failed')
    expect(system.lastUpdated).toBe(afterInitializeLastUpdated)
  })
})

// UI-9F-A-R1-RUNTIME-STATE-REMEDIATION — F-A-P0-1 required tests.
// trust/holdings/nikkei_vi.jsonの3ソースは本番で恒久的に取得不能（privacy方針 + generator不在）
// であり、これを分母に含めると正常な本番でもstatusが永久にpartialになる（独立監査 F-A-P0-1）。
// required-source denominator（14件）だけでsuccess/partial/failedが決まることを実測する。
describe('F-A-P0-1: required-source policy — privacy/local/legacyソースは分母から除外される', () => {
  it('本番の正常デプロイ（trust/holdings/nikkeiVIが恒久欠落）でもstatus=successに到達する', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => normalProductionPublishedData()
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const system = a.store.getState().system
    expect(system.status).toBe('success')
    expect(system.dataSourceOutcome).toEqual({ loaded: 14, total: 14 })
    expect(system.lastUpdated).toBe(new Date(NOW_MS).toISOString())
  })

  it('required 1件（market）が500相当でfallbackするとpartial。trust/holdings/nikkeiVI欠落は影響しない', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...normalProductionPublishedData(),
      market: { data: baseMarket(), source: 'static' },
    })
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const system = a.store.getState().system
    expect(system.status).toBe('partial')
    expect(system.dataSourceOutcome).toEqual({ loaded: 13, total: 14 })
    // F-A-P1-3: partialではlastUpdatedを進めない。
    expect(system.lastUpdated).toBe(PRIOR_LAST_UPDATED)
  })

  it('required 14件が全滅するとfailed（trust/holdings/nikkeiVIは元々分母に含まれないため無関係）', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...normalProductionPublishedData(),
      market: { data: baseMarket(), source: 'static' },
      correlation: { data: null, source: 'static' },
      news: { data: null, source: 'error' },
      macro: { data: null, source: 'none' },
      sq: { data: null, source: 'none' },
      margin: { data: null, source: 'none' },
      flows: { data: null, source: 'none' },
      candidatesNews: { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' },
      candidatesStocks: { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'default' },
      candidateFunnel: { status: 'unavailable' as const, data: null },
      regimeState: { data: DEFAULT_REGIME_STATE, source: 'default', generatedAt: null },
      safeMode: { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'default', lastChecked: null },
      tierAViolations: { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'default', generatedAt: null },
      tierAAlerts: { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'default', generatedAt: null },
    })
    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const system = a.store.getState().system
    expect(system.status).toBe('failed')
    expect(system.dataSourceOutcome).toEqual({ loaded: 0, total: 14 })
    expect(system.lastUpdated).toBe(PRIOR_LAST_UPDATED)
  })

  it('required source（candidateFunnel）がinvalid JSON相当でも degraded（successにならない）', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => ({
      ...normalProductionPublishedData(),
      candidateFunnel: { status: 'invalid' as const, data: null },
    })
    await grant(manager, a.store.getState().initialize())
    const system = a.store.getState().system
    expect(system.status).not.toBe('success')
    expect(system.status).toBe('partial')
    expect(system.dataSourceOutcome).toEqual({ loaded: 13, total: 14 })
  })

  // F-A-P0-1 mutation probe: この分離を戻す（=17ソース全件を分母に含める）とREDになることの
  // 固定用。旧ロジック（classifyDataSourceOutcomesがtrust/holdings/nikkeiVIも分母に含める）へ
  // 戻すと、本番相当fixtureでもstatusが恒久的にpartialになりこのテストはREDになる。
  it('[mutation guard] 本番相当（trust/holdings/nikkeiVI欠落）でstatus!==successなら回帰', async () => {
    const manager = new FakeLockManager()
    const a = instance(manager, PRIOR_LAST_UPDATED)
    loadProbe.implementation = async () => normalProductionPublishedData()
    await grant(manager, a.store.getState().initialize())
    expect(a.store.getState().system.status).toBe('success')
  })
})

// UI-9F-A-R1-RUNTIME-STATE-REMEDIATION — F-A-P0-2 required tests.
// CSV / portfolio-snapshot importはportfolio generationのauthorityであってdata-source fetchの
// authorityではない。取込成功時にsystem.statusを無条件'success'へ上書きすると、取得できていない
// データソースがあるにもかかわらず「更新成功」を偽装する（独立監査 F-A-P0-2）。取込前のdata-source
// health（dataSourceOutcome由来のstatus）が取込後も維持されることを実測する。
describe('F-A-P0-2: CSV/snapshot importはdata-source truth(system.status)を上書きしない', () => {
  const STOCK_CSV = [
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
  ].join('\n')

  function makeCsvFile(content: string): File {
    return new File([content], 'portfolio.csv')
  }

  function seed(created: ReturnType<typeof createAppStoreInstanceForTest>, priorStatus: 'success' | 'partial' | 'failed', dataSourceOutcome: { loaded: number; total: number }) {
    created.store.setState(s => ({
      holdings: [],
      trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...s.system,
        status: priorStatus,
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
        lastUpdated: PRIOR_LAST_UPDATED,
        dataSourceOutcome,
      },
    }))
  }

  it('partial → CSV取込 → partial（dataSourceOutcomeは改変されない）', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    seed(created, 'partial', { loaded: 13, total: 14 })
    const result = await grant(manager, created.store.getState().importCsv(makeCsvFile(STOCK_CSV)))
    expect(result.ok).toBe(true)
    const system = created.store.getState().system
    expect(system.status).toBe('partial')
    expect(system.dataSourceOutcome).toEqual({ loaded: 13, total: 14 })
  })

  it('failed → portfolio snapshot取込 → failed（dataSourceOutcomeは改変されない）', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    seed(created, 'failed', { loaded: 0, total: 14 })
    // 自分自身の現状態をexportし、そのまま同一内容をimportする（roundtrip）。
    // このtestの目的はsnapshotの内容そのものではなく、取込成功後のstatus保存/復元。
    const snapshotJson = created.store.getState().exportPortfolioSnapshot()
    const result = await grant(manager, created.store.getState().importPortfolioSnapshot(snapshotJson))
    expect(result.ok).toBe(true)
    const system = created.store.getState().system
    expect(system.status).toBe('failed')
    expect(system.dataSourceOutcome).toEqual({ loaded: 0, total: 14 })
  })

  it('success → CSV取込 → success（回帰防止。取込成功自体は引き続き反映される）', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    seed(created, 'success', { loaded: 14, total: 14 })
    const result = await grant(manager, created.store.getState().importCsv(makeCsvFile(STOCK_CSV)))
    expect(result.ok).toBe(true)
    const system = created.store.getState().system
    expect(system.status).toBe('success')
    expect(system.dataSourceOutcome).toEqual({ loaded: 14, total: 14 })
  })

  // F-A-P0-2 mutation probe: この保存/復元ロジックを戻す（=status:'success'を無条件上書き）と
  // REDになることの固定用。
  it('[mutation guard] partial状態でCSV取込してもsuccessへ僭称されない', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    seed(created, 'partial', { loaded: 13, total: 14 })
    await grant(manager, created.store.getState().importCsv(makeCsvFile(STOCK_CSV)))
    expect(created.store.getState().system.status).not.toBe('success')
  })

  // R1-P2-1（独立再監査ui-9f-a-r1-independent-reaudit.md指摘）: DUPLICATE_CSV経路
  // （useAppStore.ts:3595）専用のテストが無く、この経路だけstatus:'success'に戻しても
  // 全テストがGREENのままだった。同一内容CSVを2回取込みDUPLICATE_CSV分岐を実際に踏む。
  it('DUPLICATE_CSV（同一内容の再取込）でもpartialのままsuccessへ僭称されない', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    seed(created, 'partial', { loaded: 13, total: 14 })
    const csv = `データ基準日時,2026-08-21T09:00:00+09:00\n${STOCK_CSV}`

    const first = await grant(manager, created.store.getState().importCsv(makeCsvFile(csv)))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().system.status).toBe('partial')

    const second = await grant(manager, created.store.getState().importCsv(makeCsvFile(csv)))
    expect(second).toMatchObject({ ok: true, code: 'DUPLICATE_CSV' })
    const system = created.store.getState().system
    expect(system.status).toBe('partial')
    expect(system.dataSourceOutcome).toEqual({ loaded: 13, total: 14 })
  })

  // R1-P1-1（独立再監査 指摘・HIGH）: dataSourceOutcomeはinitialize()/refreshAllData()の
  // publishが一度も成功していない間はundefinedのまま（新規storeの初期値、またはLOAD_RESTORE_ERROR
  // 等でinitialize()がset()に到達しなかった場合は恒久的にundefined）。この状態でCSV/snapshot
  // importが成功すると、0ソースしか取得していないのにstatus:'success'を僭称しうる —
  // これは本チケットが除去したはずの欠陥の再発である。outcome未知の間はsuccessを主張せず、
  // data-source取得が未完了であることを表すinitializingへsettleしなければならない。
  it('[R1-P1-1] dataSourceOutcomeがundefinedのままCSV取込してもsuccessへ僭称しない', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    created.store.setState(s => ({
      holdings: [],
      trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...s.system,
        status: 'initializing',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
        lastUpdated: null,
        dataSourceOutcome: undefined,
      },
    }))
    const result = await grant(manager, created.store.getState().importCsv(makeCsvFile(STOCK_CSV)))
    expect(result.ok).toBe(true)
    const system = created.store.getState().system
    expect(system.status).not.toBe('success')
    expect(system.status).toBe('initializing')
    expect(system.dataSourceOutcome).toBeUndefined()
  })

  it('[R1-P1-1] dataSourceOutcomeがundefinedのままsnapshot取込してもsuccessへ僭称しない', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    created.store.setState(s => ({
      holdings: [],
      trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...s.system,
        status: 'initializing',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
        lastUpdated: null,
        dataSourceOutcome: undefined,
      },
    }))
    const snapshotJson = created.store.getState().exportPortfolioSnapshot()
    const result = await grant(manager, created.store.getState().importPortfolioSnapshot(snapshotJson))
    expect(result.ok).toBe(true)
    const system = created.store.getState().system
    expect(system.status).not.toBe('success')
    expect(system.status).toBe('initializing')
    expect(system.dataSourceOutcome).toBeUndefined()
  })

  it('[R3-A] undefined outcome: CSV errorから正常CSV retry後はstale errorを消し、hidden errorにもfalse successにもならない', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })

    const failed = await grant(manager, created.store.getState().importCsv(makeCsvFile('not,a,portfolio,csv')))
    expect(failed).toMatchObject({ ok: false })
    const failedSystem = created.store.getState().system
    expect(failedSystem.status).toBe('error')
    expect(failedSystem.error).toEqual(expect.any(String))
    expect(failedSystem.error).not.toBe('')
    const staleCsvError = failedSystem.error

    const recovered = await grant(manager, created.store.getState().importCsv(makeCsvFile(STOCK_CSV)))
    expect(recovered).toMatchObject({ ok: true, code: 'SUCCESS' })
    const recoveredSystem = created.store.getState().system
    expect(recoveredSystem.dataSourceOutcome).toBeUndefined()
    expect(recoveredSystem.status).toBe('initializing')
    expect(recoveredSystem.status).not.toBe('success')
    expect(recoveredSystem.status === 'error' && recoveredSystem.error === null).toBe(false)
    expect(recoveredSystem.error).toBeNull()
    expect(recoveredSystem.error).not.toBe(staleCsvError)
  })

  it('[R3-B] undefined outcome: CSV errorから正常snapshot retry後もstale errorを消し、状態整合性を保つ', async () => {
    const manager = new FakeLockManager()
    const created = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const snapshotJson = created.store.getState().exportPortfolioSnapshot()

    const failed = await grant(manager, created.store.getState().importCsv(makeCsvFile('not,a,portfolio,csv')))
    expect(failed).toMatchObject({ ok: false })
    const failedSystem = created.store.getState().system
    expect(failedSystem.status).toBe('error')
    expect(failedSystem.error).toEqual(expect.any(String))
    expect(failedSystem.error).not.toBe('')
    const staleCsvError = failedSystem.error

    const recovered = await grant(manager, created.store.getState().importPortfolioSnapshot(snapshotJson))
    expect(recovered).toMatchObject({ ok: true, code: 'SUCCESS' })
    const recoveredSystem = created.store.getState().system
    expect(recoveredSystem.dataSourceOutcome).toBeUndefined()
    expect(recoveredSystem.status).toBe('initializing')
    expect(recoveredSystem.status).not.toBe('success')
    expect(recoveredSystem.status === 'error' && recoveredSystem.error === null).toBe(false)
    expect(recoveredSystem.error).toBeNull()
    expect(recoveredSystem.error).not.toBe(staleCsvError)
  })
})
