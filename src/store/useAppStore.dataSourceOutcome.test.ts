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
  it('statusはsuccessにならない／lastUpdatedを偽更新しない事はないが（他が成功のため進む）／error到達可能', async () => {
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
    expect(system.dataSourceOutcome).toEqual({ loaded: 16, total: 17 })
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
