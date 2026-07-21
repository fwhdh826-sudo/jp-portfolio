import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────
// RA-008-C1: connects exactly-once cross-tab invalidation emission to the 8 durable writer
// commit boundaries that have no rollback window (initialize, refreshAllData, updateHolding,
// updateTrust, setPortfolioPolicy, setCashAssumptions, clearCashAssumptionsOverride,
// importCashAssumptions). importCsv/importPortfolioSnapshot are out of scope (RA-008-C2).
// This suite is DIRECT: two/three independent AppStoreRuntime instances share a fake
// BroadcastChannel/storage hub, and a spy transport records exactly what each writer publishes.
// ─────────────────────────────────────────────────────────────

const loadProbe = vi.hoisted(() => ({
  implementation: null as null | (() => Promise<unknown>),
}))

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async () => {
      if (loadProbe.implementation) return loadProbe.implementation()
      throw new Error('invalidation emission load fixture was not installed')
    },
  }
})

import type { CashAssumptions, CsvImportProvenance, Holding, Trust } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { STATIC_MARKET } from '../constants/market'
import {
  DEFAULT_CANDIDATES_NEWS_DATA,
  DEFAULT_CANDIDATES_STOCKS_DATA,
  DEFAULT_REGIME_STATE,
  DEFAULT_SAFE_MODE_SNAPSHOT,
  DEFAULT_TIER_A_ALERTS_SNAPSHOT,
  DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
} from '../services/loadStaticData'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
} from './persist'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
} from './portfolioGenerationLock'
import { createPortfolioCoordinationFailure, type PortfolioCoordinationErrorCode } from './portfolioOperationResult'
import {
  createPortfolioGenerationInvalidationTransport,
  type PortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationTransport,
  type PortfolioGenerationInvalidationTransportOptions,
} from './portfolioGenerationInvalidationTransport'
import { FakeBroadcastChannelHub } from './testing/fakeBroadcastChannelHub'
import { FakeStorageEventHub } from './testing/fakeStorageEventHub'
import { FakeLockManager } from './testing/fakeLockManager'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { createAppStoreInstanceForTest } from './useAppStore'

// ── Fixed clock ──────────────────────────────────────────────────────────────
const NOW_MS = Date.parse('2026-07-22T06:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()
const SOURCE_AS_OF_ISO = '2026-07-22T04:00:00.000Z' // 2h before NOW_MS
const IMPORTED_AT_ISO = '2026-07-22T04:00:00.000Z'
const HOLDINGS_SNAPSHOT_LAST_UPDATED_ISO = '2026-07-22T05:00:00.000Z' // 1h before NOW_MS, after SOURCE_AS_OF

const AUTHORITATIVE_PROVENANCE: CsvImportProvenance = {
  importedAt: IMPORTED_AT_ISO,
  sourceAsOf: SOURCE_AS_OF_ISO,
  sourceAsOfKind: 'csv_explicit',
  sourceAsOfConfidence: 'authoritative',
  contentFingerprint: 'fnv1a32:12345678',
  sourceFileName: 'portfolio.csv',
  fileLastModified: null,
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const HOLDING: Holding = {
  code: '2001', name: 'emission holding', eval: 300_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const TRUST: Trust = {
  id: 'emission-fund', name: 'emission fund', abbr: 'EMS', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 200_000, pnlPct: 0, dayPct: 0,
  cost: 0.2, mu: 0.1, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0,
  decision: 'HOLD',
}

class CountingFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null
  readAsArrayBuffer(file: File): void {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

// ── localStorage mock (module-scoped so individual tests can override getItem/setItem) ──────
let storage: Record<string, string> = {}
const getItem = vi.fn((key: string): string | null => storage[key] ?? null)
const setItem = vi.fn((key: string, value: string) => { storage[key] = value })
const removeItem = vi.fn((key: string) => { delete storage[key] })
const lsMock = { getItem, setItem, removeItem }

function resetLocalStorageMock(): void {
  storage = {}
  getItem.mockReset()
  getItem.mockImplementation((key: string) => storage[key] ?? null)
  setItem.mockReset()
  setItem.mockImplementation((key: string, value: string) => { storage[key] = value })
  removeItem.mockReset()
  removeItem.mockImplementation((key: string) => { delete storage[key] })
}

// ── Published-data fixtures for initialize/refreshAllData ───────────────────────────────────
function nullPublishedData() {
  return {
    market: { data: STATIC_MARKET, source: 'static' },
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

function holdingsSnapshotMergePublishedData(nextEval: number) {
  return {
    ...nullPublishedData(),
    holdingsSnapshot: {
      data: { holdings: [{ code: HOLDING.code, eval: nextEval }] },
      source: 'loaded',
      lastUpdated: HOLDINGS_SNAPSHOT_LAST_UPDATED_ISO,
    },
  }
}

function marketOnlyPublishedData() {
  return {
    ...nullPublishedData(),
    market: { data: { ...STATIC_MARKET, last_updated: NOW_ISO }, source: 'loaded' },
  }
}

function newsOnlyPublishedData() {
  return {
    ...nullPublishedData(),
    news: {
      data: {
        updatedAt: NOW_ISO,
        sourceStatus: {},
        marketNews: [],
        stockNews: [],
        meta: { totalCount: 0, marketCount: 0, stockCount: 0, duplicateRemoved: 0 },
      },
      source: 'loaded',
    },
  }
}

function derivedOnlyPublishedData() {
  return {
    ...nullPublishedData(),
    candidatesStocks: { data: { ...DEFAULT_CANDIDATES_STOCKS_DATA, updatedAt: NOW_ISO }, source: 'loaded' },
    regimeState: { data: { ...DEFAULT_REGIME_STATE }, source: 'loaded', generatedAt: NOW_ISO },
  }
}

function throwingMarketPublishedData() {
  // buildStateWithPublishedData itself reads `market.data?.last_updated` for dataTimestamps
  // (before the analysis phase) — that single read must stay safe so the failure surfaces from
  // runFullAnalysis (LOAD_ANALYSIS_ERROR), not from the data-staging step (LOAD_DATA_ERROR).
  const throwingMarket = new Proxy(STATIC_MARKET, {
    get(target, prop): unknown {
      if (prop === 'last_updated') return target.last_updated
      throw new Error('published market read failed')
    },
  })
  return {
    ...nullPublishedData(),
    market: { data: throwingMarket, source: 'loaded' },
  }
}

// ── Harness: two/three independent runtimes sharing one fake hub ────────────────────────────

function harnessTransport(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
  overrides: Partial<PortfolioGenerationInvalidationTransportOptions> = {},
): PortfolioGenerationInvalidationTransport {
  const context = storageHub.createContext()
  return createPortfolioGenerationInvalidationTransport({
    instanceId,
    createBroadcastChannel: bcHub.createFactory(),
    storage: context.storage,
    storageEventTarget: context.eventTarget,
    ...overrides,
  })
}

function makeInstance(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
  lockAdapter: PortfolioGenerationLockAdapter = createImmediatePortfolioGenerationLockAdapterForTest(),
  onPublish?: (event: PortfolioGenerationInvalidationEvent) => void,
) {
  const raw = harnessTransport(bcHub, storageHub, instanceId)
  const events: PortfolioGenerationInvalidationEvent[] = []
  const transport: PortfolioGenerationInvalidationTransport = {
    publish: event => {
      events.push(event)
      onPublish?.(event)
      raw.publish(event)
    },
    subscribe: listener => raw.subscribe(listener),
    dispose: () => raw.dispose(),
  }
  const instance = createAppStoreInstanceForTest({
    portfolioGenerationLock: lockAdapter,
    portfolioGenerationInvalidation: { instanceId, transport },
  })
  return { instance, events }
}

function failingLockAdapter(code: PortfolioCoordinationErrorCode): PortfolioGenerationLockAdapter {
  return {
    async runExclusive(operation) {
      return createPortfolioCoordinationFailure(operation, code)
    },
  }
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

function seedManualBaseline(
  store: ReturnType<typeof createAppStoreInstanceForTest>['store'],
  cashAssumptions: CashAssumptions = { ...DEFAULT_CASH_ASSUMPTIONS },
): void {
  store.setState(state => ({
    holdings: [{ ...HOLDING }],
    trust: [{ ...TRUST }],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions,
    system: {
      ...state.system,
      status: 'idle', error: null,
      csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function seedAuthoritativeCanonical(holdings: Holding[], trust: Trust[]): void {
  persistCsvImportTransaction({
    holdings,
    trust,
    learning: null,
    csvImportedAt: IMPORTED_AT_ISO,
    provenance: AUTHORITATIVE_PROVENANCE,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
    portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
    cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
    origin: 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

function seedRefreshAuthoritativeBaseline(
  store: ReturnType<typeof createAppStoreInstanceForTest>['store'],
  holdings: Holding[],
  trust: Trust[],
): void {
  store.setState(state => ({
    holdings, trust,
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      status: 'idle', error: null,
      csvLastImportedAt: IMPORTED_AT_ISO,
      csvImportProvenance: AUTHORITATIVE_PROVENANCE,
      csvSyncSummary: null,
    },
  }))
  seedAuthoritativeCanonical(holdings, trust)
}

function csvFile(evalValue: number): File {
  const content = [
    'データ基準日時,2026-07-22T02:00:00+09:00',
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    `${HOLDING.code},${HOLDING.name},1200,${evalValue},0.00,0.00,2025-01-01`,
  ].join('\n')
  return new File([content], 'emission.csv', { type: 'text/csv' })
}

function distinctSnapshotRaw(code: string): string {
  const source = createAppStoreInstanceForTest()
  source.store.setState(state => ({
    holdings: [{ ...HOLDING, code, eval: 777_000 }],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
  }))
  const raw = source.store.getState().exportPortfolioSnapshot()
  source.controls.dispose()
  return raw
}

function expectExactEventShape(
  event: PortfolioGenerationInvalidationEvent,
  operation: string,
  senderInstanceId: string,
): void {
  expect(Object.keys(event).sort()).toEqual(
    ['committedAt', 'messageId', 'operation', 'protocolVersion', 'senderInstanceId'].sort(),
  )
  expect(event.operation).toBe(operation)
  expect(event.senderInstanceId).toBe(senderInstanceId)
  expect(event.protocolVersion).toBe(1)
  expect(typeof event.messageId).toBe('string')
  expect(event.messageId.length).toBeGreaterThan(0)
  expect(new Date(event.committedAt).toISOString()).toBe(event.committedAt)
  expect(event).not.toHaveProperty('holdings')
  expect(event).not.toHaveProperty('trust')
  expect(event).not.toHaveProperty('portfolioPolicy')
  expect(event).not.toHaveProperty('cashAssumptions')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('FileReader', CountingFileReader)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  resetLocalStorageMock()
  vi.stubGlobal('localStorage', lsMock)
  loadProbe.implementation = async () => nullPublishedData()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  loadProbe.implementation = null
})

// ─────────────────────────────────────────────────────────────
// Eight writer success: exact event fields, recipient pending 1, sender pending 0
// ─────────────────────────────────────────────────────────────

describe('eight writer success', () => {
  const MANUAL_SUCCESS_INVOCATIONS: Record<
    string,
    (store: ReturnType<typeof createAppStoreInstanceForTest>['store']) => Promise<unknown>
  > = {
    updateHolding: store => store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 }),
    updateTrust: store => store.getState().updateTrust(TRUST.id, { eval: TRUST.eval + 111 }),
    setPortfolioPolicy: store => store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.25 }),
    setCashAssumptions: store => store.getState().setCashAssumptions({
      cashDeposits: 4_444_444, standbyFunds: 555_555,
    }),
    clearCashAssumptionsOverride: store => store.getState().clearCashAssumptionsOverride(),
    importCashAssumptions: store => store.getState().importCashAssumptions({
      cashDeposits: 6_000_000, standbyFunds: 700_000, manualUpdatedAt: NOW_ISO,
    }),
  }

  it.each(Object.keys(MANUAL_SUCCESS_INVOCATIONS))('%s: emits exactly 1 well-formed event; recipient pending 1, sender pending 0', async writer => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, `sender-${writer}`)
    const { instance: b } = makeInstance(bcHub, storageHub, `receiver-${writer}`)

    seedManualBaseline(a.store, writer === 'clearCashAssumptionsOverride'
      ? { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: NOW_ISO }
      : { ...DEFAULT_CASH_ASSUMPTIONS })

    const result = await MANUAL_SUCCESS_INVOCATIONS[writer](a.store)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expectExactEventShape(events[0], writer, `sender-${writer}`)

    const bPending = b.controls.inspect().pendingInvalidation
    expect(bPending).not.toBeNull()
    expect(bPending?.operation).toBe(writer)
    expect(bPending?.senderInstanceId).toBe(`sender-${writer}`)
    expect(bPending?.messageId).toBe(events[0].messageId)
    expect(bPending?.receivedSequence).toBe(1)

    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    a.controls.dispose()
    b.controls.dispose()
  })

  it('initialize: projection-changing bootstrap (holdings snapshot merge) emits exactly 1', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-initialize')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-initialize')

    seedAuthoritativeCanonical([{ ...HOLDING }], [{ ...TRUST }])
    loadProbe.implementation = async () => holdingsSnapshotMergePublishedData(HOLDING.eval + 200_000)

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: true, operation: 'initialize', code: 'SUCCESS' })
    expect(a.store.getState().holdings.find(h => h.code === HOLDING.code)?.eval).toBe(HOLDING.eval + 200_000)
    expect(events).toHaveLength(1)
    expectExactEventShape(events[0], 'initialize', 'sender-initialize')

    const bPending = b.controls.inspect().pendingInvalidation
    expect(bPending?.operation).toBe('initialize')
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    a.controls.dispose()
    b.controls.dispose()
  })

  it('refreshAllData: projection-changing refresh (holdings snapshot merge) emits exactly 1', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-refresh')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-refresh')

    seedRefreshAuthoritativeBaseline(a.store, [{ ...HOLDING }], [{ ...TRUST }])
    loadProbe.implementation = async () => holdingsSnapshotMergePublishedData(HOLDING.eval + 200_000)

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    expect(a.store.getState().holdings.find(h => h.code === HOLDING.code)?.eval).toBe(HOLDING.eval + 200_000)
    expect(events).toHaveLength(1)
    expectExactEventShape(events[0], 'refreshAllData', 'sender-refresh')

    const bPending = b.controls.inspect().pendingInvalidation
    expect(bPending?.operation).toBe('refreshAllData')
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    a.controls.dispose()
    b.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Projection-equivalent load commits: durable commit happens, but the tracked projection is
// unchanged → 0 events.
// ─────────────────────────────────────────────────────────────

// Analysis (score/decision/ev) is recomputed on every load and is itself part of the tracked
// `holdings`/`trust` projection fields. A canonical seeded with raw (un-analyzed) fixture values
// therefore always looks "changed" on the very first load, for a reason that has nothing to do
// with RA-008-C1's contract. Priming with one real load first (which persists its own
// analysis-scored finalState as the new canonical) settles holdings/trust into a fixed point, so
// a second, data-unchanged load is a genuine like-for-like projection comparison.
async function primeSettledLoadInstance(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
): Promise<{ instance: ReturnType<typeof makeInstance>['instance']; events: PortfolioGenerationInvalidationEvent[] }> {
  seedAuthoritativeCanonical([{ ...HOLDING }], [{ ...TRUST }])
  const { instance, events } = makeInstance(bcHub, storageHub, instanceId)
  const primingResult = await instance.store.getState().initialize()
  expect(primingResult).toMatchObject({ ok: true, operation: 'initialize', code: 'SUCCESS' })
  events.length = 0
  return { instance, events }
}

describe('projection-equivalent load commits emit 0', () => {
  it('initialize: re-bootstrap from a canonical that already matches the published baseline', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-init-equiv')

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: true, operation: 'initialize', code: 'SUCCESS' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('refreshAllData: market-only published update leaves the tracked projection untouched', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-market')
    loadProbe.implementation = async () => marketOnlyPublishedData()

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('refreshAllData: news-only published update leaves the tracked projection untouched', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-news')
    loadProbe.implementation = async () => newsOnlyPublishedData()

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('refreshAllData: derived-only (candidates/regime) published update leaves the tracked projection untouched', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-derived')
    loadProbe.implementation = async () => derivedOnlyPublishedData()

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Manual no-change and the setCashAssumptions P3 asymmetry
// ─────────────────────────────────────────────────────────────

describe('manual NO_CHANGE emits 0', () => {
  const NO_CHANGE_INVOCATIONS: Record<
    string,
    (store: ReturnType<typeof createAppStoreInstanceForTest>['store']) => Promise<unknown>
  > = {
    updateHolding: store => store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval }),
    updateTrust: store => store.getState().updateTrust(TRUST.id, { eval: TRUST.eval }),
    setPortfolioPolicy: store => store.getState().setPortfolioPolicy({
      jpStockMaxRatio: DEFAULT_PORTFOLIO_POLICY.jpStockMaxRatio,
    }),
    clearCashAssumptionsOverride: store => store.getState().clearCashAssumptionsOverride(),
  }

  it.each(Object.keys(NO_CHANGE_INVOCATIONS))('%s: identical value is NO_CHANGE, emits 0', async writer => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, `sender-nochange-${writer}`)
    seedManualBaseline(a.store)

    const result = await NO_CHANGE_INVOCATIONS[writer](a.store)

    expect(result).toMatchObject({ ok: true, code: 'NO_CHANGE' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('setCashAssumptions: identical numeric values still emits 1 (P3: manualUpdatedAt always advances → SUCCESS, not NO_CHANGE)', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-cash-p3')
    seedManualBaseline(a.store, {
      cashDeposits: 4_000_000, standbyFunds: 500_000,
      manualOverrideEnabled: true, manualUpdatedAt: '2026-07-01T00:00:00.000Z',
    })

    const result = await a.store.getState().setCashAssumptions({ cashDeposits: 4_000_000, standbyFunds: 500_000 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(events[0].operation).toBe('setCashAssumptions')
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Failure paths: no durable commit happens (or the commit boundary is never reached) → 0 events
// ─────────────────────────────────────────────────────────────

describe('manual failure paths emit 0', () => {
  it('analysis failure emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-manual-analysis-fail')
    seedManualBaseline(a.store)
    const throwingMarket = new Proxy(STATIC_MARKET, { get(): never { throw new Error('analysis failed') } })
    a.store.setState({ market: throwingMarket })

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: false, code: 'MANUAL_ANALYSIS_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence failure emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-manual-persist-fail')
    seedManualBaseline(a.store)
    setItem.mockImplementation(() => { throw new Error('quota exceeded') })

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('stale (durable generation diverged from published state) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-manual-stale')
    seedManualBaseline(a.store)
    persistCsvImportTransaction({
      holdings: [{ ...HOLDING, eval: 999_999 }],
      trust: [{ ...TRUST }],
      learning: null,
      csvImportedAt: null, provenance: null, syncSummary: null,
      trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      origin: 'snapshot',
    }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('conflict (canonical committed by another writer mid-operation) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-manual-conflict')
    seedManualBaseline(a.store)

    persistCsvImportTransaction({
      holdings: [{ ...HOLDING }], trust: [{ ...TRUST }], learning: null,
      csvImportedAt: null, provenance: null, syncSummary: null,
      trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      origin: 'snapshot',
    }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const conflictRaw = storage[CSV_IMPORT_GENERATION_KEY]
    delete storage[CSV_IMPORT_GENERATION_KEY]
    let canonicalReads = 0
    getItem.mockImplementation((key: string) => {
      if (key !== CSV_IMPORT_GENERATION_KEY) return storage[key] ?? null
      canonicalReads += 1
      return canonicalReads === 1 ? null : conflictRaw
    })

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: false, code: 'PORTFOLIO_GENERATION_CONFLICT' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })
})

describe('initialize failure paths emit 0', () => {
  it('restore failure (LOAD_RESTORE_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-init-restore-fail')
    a.controls.setLoadRestoreBeforeReadHook(() => { throw new Error('restore hook failure') })

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: false, operation: 'initialize', code: 'LOAD_RESTORE_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('data failure (LOAD_DATA_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-init-data-fail')
    loadProbe.implementation = async () => { throw new Error('published data fetch failed') }

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: false, operation: 'initialize', code: 'LOAD_DATA_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('analysis failure (LOAD_ANALYSIS_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-init-analysis-fail')
    loadProbe.implementation = async () => throwingMarketPublishedData()

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: false, operation: 'initialize', code: 'LOAD_ANALYSIS_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence failure (LOAD_PERSISTENCE_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-init-persist-fail')
    setItem.mockImplementation(() => { throw new Error('quota exceeded') })

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: false, operation: 'initialize', code: 'LOAD_PERSISTENCE_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })
})

describe('refreshAllData failure paths emit 0', () => {
  it('stale (durable generation diverged from published state) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-stale')
    persistCsvImportTransaction({
      holdings: [{ ...HOLDING, eval: 999_999 }],
      trust: [{ ...TRUST }],
      learning: null,
      csvImportedAt: null, provenance: null, syncSummary: null,
      trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      origin: 'snapshot',
    }, NOW_MS, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('data failure (LOAD_DATA_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-data-fail')
    loadProbe.implementation = async () => { throw new Error('published data fetch failed') }

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: false, operation: 'refreshAllData', code: 'LOAD_DATA_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('analysis failure (LOAD_ANALYSIS_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-analysis-fail')
    loadProbe.implementation = async () => throwingMarketPublishedData()

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: false, operation: 'refreshAllData', code: 'LOAD_ANALYSIS_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence failure (LOAD_PERSISTENCE_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = await primeSettledLoadInstance(bcHub, storageHub, 'sender-refresh-persist-fail')
    setItem.mockImplementation(() => { throw new Error('quota exceeded') })

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: false, operation: 'refreshAllData', code: 'LOAD_PERSISTENCE_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Coordination failures: the writer never reaches alignment/analysis/persistence at all → 0
// ─────────────────────────────────────────────────────────────

describe('coordination failures emit 0', () => {
  it('LOCAL_OPERATION_BUSY emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-busy')
    seedManualBaseline(a.store)
    const ticket = a.controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(events).toHaveLength(0)
    if (ticket) a.controls.releasePortfolioOperation(ticket)
    a.controls.dispose()
  })

  it.each(['WEB_LOCK_UNAVAILABLE', 'WEB_LOCK_TIMEOUT', 'WEB_LOCK_ABORTED', 'WEB_LOCK_REQUEST_FAILED'] as const)(
    '%s emits 0',
    async code => {
      const bcHub = new FakeBroadcastChannelHub()
      const storageHub = new FakeStorageEventHub()
      const { instance: a, events } = makeInstance(bcHub, storageHub, `sender-${code}`, failingLockAdapter(code))
      seedManualBaseline(a.store)

      const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

      expect(result).toMatchObject({ ok: false, code })
      expect(events).toHaveLength(0)
      a.controls.dispose()
    },
  )
})

// ─────────────────────────────────────────────────────────────
// Timing: emit is after persistence, before final publication, while the Web Lock and the local
// ticket are both still held; the count is already 1 by the time subscribers run, and stays 1
// after lock release (no extra emit).
// ─────────────────────────────────────────────────────────────

describe('emit timing', () => {
  it('manual: after persistence, before final set, while lock+ticket held; already 1 for subscribers; stays 1 after release', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const lockAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager })

    const probe: { instance: ReturnType<typeof makeInstance>['instance'] | null } = { instance: null }
    let stateRefAtPublish: unknown = null
    let persistedAtPublish: string | undefined
    let lockHeldAtPublish: boolean | null = null
    let reentryBlockedAtPublish: boolean | null = null

    const onPublish = () => {
      stateRefAtPublish = probe.instance!.store.getState()
      persistedAtPublish = storage.v81_portfolio
      lockHeldAtPublish = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      reentryBlockedAtPublish = probe.instance!.controls.acquirePortfolioOperation('manual') === null
    }
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-timing-manual', lockAdapter, onPublish)
    probe.instance = a
    seedManualBaseline(a.store)
    const stateBeforeCall = a.store.getState()

    let subscriberSawCount = -1
    const unsubscribe = a.store.subscribe(() => { subscriberSawCount = events.length })

    const resultPromise = grant(manager, a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 }))
    const result = await resultPromise
    unsubscribe()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(stateRefAtPublish).toBe(stateBeforeCall) // final set() had not applied yet
    expect(persistedAtPublish).toBeDefined() // durable write already landed
    expect(lockHeldAtPublish).toBe(true)
    expect(reentryBlockedAtPublish).toBe(true)
    expect(subscriberSawCount).toBe(1) // event already recorded by the time subscribers ran

    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(events).toHaveLength(1) // no additional emit after release
    a.controls.dispose()
  })

  it('load (initialize): after persistence, before publish hook; already 1 for subscribers; stays 1 after release', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const lockAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager })

    const probe: { instance: ReturnType<typeof makeInstance>['instance'] | null } = { instance: null }
    let publishHookRan = false
    let lockHeldAtPublish: boolean | null = null
    let reentryBlockedAtPublish: boolean | null = null
    let publishHookAlreadyRanAtEmit: boolean | null = null

    const onPublish = () => {
      lockHeldAtPublish = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      reentryBlockedAtPublish = probe.instance!.controls.acquirePortfolioOperation('initialize') === null
      publishHookAlreadyRanAtEmit = publishHookRan
    }
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-timing-init', lockAdapter, onPublish)
    probe.instance = a
    a.controls.setLoadPublishBeforeApplyHook(() => { publishHookRan = true })
    seedAuthoritativeCanonical([{ ...HOLDING }], [{ ...TRUST }])
    loadProbe.implementation = async () => holdingsSnapshotMergePublishedData(HOLDING.eval + 200_000)

    let subscriberSawCount = -1
    const unsubscribe = a.store.subscribe(() => { subscriberSawCount = events.length })

    const result = await grant(manager, a.store.getState().initialize())
    unsubscribe()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(publishHookAlreadyRanAtEmit).toBe(false) // emit happens before the publish hook fires
    expect(lockHeldAtPublish).toBe(true)
    expect(reentryBlockedAtPublish).toBe(true)
    expect(subscriberSawCount).toBe(1)

    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(events).toHaveLength(1)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Local publish-hook failure after a durable commit: the event has already been emitted and
// stays recorded exactly once, even though the writer itself reports a publish error.
// ─────────────────────────────────────────────────────────────

describe('publish-hook failure after durable commit still leaves exactly 1 event', () => {
  it('manual: MANUAL_PUBLISH_ERROR, event count 1, recipient pending recorded once', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-manual-publish-fail')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-manual-publish-fail')
    seedManualBaseline(a.store)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    a.controls.setManualPublishBeforeApplyHook(() => { throw new Error('publish sentinel') })

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: false, operation: 'updateHolding', code: 'MANUAL_PUBLISH_ERROR' })
    expect(events).toHaveLength(1)
    expect(b.controls.inspect().pendingInvalidation?.operation).toBe('updateHolding')
    errorSpy.mockRestore()
    a.controls.dispose()
    b.controls.dispose()
  })

  it('initialize: LOAD_PUBLISH_ERROR, event count 1, recipient pending recorded once', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-init-publish-fail')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-init-publish-fail')
    seedAuthoritativeCanonical([{ ...HOLDING }], [{ ...TRUST }])
    loadProbe.implementation = async () => holdingsSnapshotMergePublishedData(HOLDING.eval + 200_000)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    a.controls.setLoadPublishBeforeApplyHook(() => { throw new Error('publish sentinel') })

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: false, operation: 'initialize', code: 'LOAD_PUBLISH_ERROR' })
    expect(events).toHaveLength(1)
    expect(b.controls.inspect().pendingInvalidation?.operation).toBe('initialize')
    errorSpy.mockRestore()
    a.controls.dispose()
    b.controls.dispose()
  })

  it('refreshAllData: LOAD_PUBLISH_ERROR, event count 1, recipient pending recorded once', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-refresh-publish-fail')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-refresh-publish-fail')
    seedRefreshAuthoritativeBaseline(a.store, [{ ...HOLDING }], [{ ...TRUST }])
    loadProbe.implementation = async () => holdingsSnapshotMergePublishedData(HOLDING.eval + 200_000)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    a.controls.setLoadPublishBeforeApplyHook(() => { throw new Error('publish sentinel') })

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: false, operation: 'refreshAllData', code: 'LOAD_PUBLISH_ERROR' })
    expect(events).toHaveLength(1)
    expect(b.controls.inspect().pendingInvalidation?.operation).toBe('refreshAllData')
    errorSpy.mockRestore()
    a.controls.dispose()
    b.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Transport fail-soft: publish()/event-creation/backend failures never change the writer's
// operation result, never retry, and never leak the raw injected error.
// ─────────────────────────────────────────────────────────────

describe('transport fail-soft', () => {
  it('publish() throw: writer result and durable commit unaffected, no raw error surfaces', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const raw = harnessTransport(bcHub, storageHub, 'sender-publish-throw')
    const throwingTransport: PortfolioGenerationInvalidationTransport = {
      publish: () => { throw new Error('sentinel: publish threw') },
      subscribe: listener => raw.subscribe(listener),
      dispose: () => raw.dispose(),
    }
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: 'sender-publish-throw', transport: throwingTransport },
    })
    seedManualBaseline(instance.store)

    const result = await instance.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(instance.store.getState().holdings.find(h => h.code === HOLDING.code)?.eval).toBe(HOLDING.eval + 111)
    expect(JSON.stringify(result)).not.toContain('sentinel')
    instance.controls.dispose()
  })

  it('invalid sender instanceId (empty string): writer result unaffected, event silently dropped by the transport', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const transport = harnessTransport(bcHub, storageHub, '')
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: '', transport },
    })
    seedManualBaseline(instance.store)

    const result = await instance.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    instance.controls.dispose()
  })

  it('disposed transport: writer result unaffected, no delivery', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a } = makeInstance(bcHub, storageHub, 'sender-disposed')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-disposed')
    seedManualBaseline(a.store)
    a.controls.dispose()

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(b.controls.inspect().pendingInvalidation).toBeNull()
    b.controls.dispose()
  })

  it('backend failures (BroadcastChannel postMessage throw + storage setItem throw): writer result unaffected', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const context = storageHub.createContext()
    storageHub.setSetItemShouldThrow(context.contextId, true)
    const transport = createPortfolioGenerationInvalidationTransport({
      instanceId: 'sender-backend-fail',
      createBroadcastChannel: bcHub.createFactory(),
      storage: context.storage,
      storageEventTarget: context.eventTarget,
    })
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: 'sender-backend-fail', transport },
    })
    seedManualBaseline(instance.store)
    // Force the BroadcastChannel leg to fail too, by making the participant's postMessage throw
    // once constructed.
    const bcEvents = bcHub.events.filter(e => e.type === 'constructed')
    const participantId = bcEvents[bcEvents.length - 1]?.participantId
    if (participantId !== undefined) bcHub.setPostMessageShouldThrow(participantId, true)

    const result = await instance.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(JSON.stringify(result)).not.toContain('sentinel')
    instance.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Receiver behavior: an active local operation on the RECEIVING side does not block, alter, or
// get altered by an incoming remote invalidation.
// ─────────────────────────────────────────────────────────────

describe('active receiver', () => {
  it('B mid-operation when A emits: B pending recorded, B ticket unchanged, no nested lock/Zustand/subscriber effect, B result unaffected', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a } = makeInstance(bcHub, storageHub, 'sender-active-receiver')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-active-receiver')
    seedManualBaseline(a.store)
    seedManualBaseline(b.store)

    const bTicket = b.controls.acquirePortfolioOperation('manual')
    expect(bTicket).not.toBeNull()
    let bSubscriberCalls = 0
    const bUnsubscribe = b.store.subscribe(() => { bSubscriberCalls += 1 })
    const bStateBefore = b.store.getState()

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })

    const bInspect = b.controls.inspect()
    expect(bInspect.pendingInvalidation?.operation).toBe('updateHolding')
    expect(bInspect.activeOperationKind).toBe('manual') // ticket untouched
    expect(b.store.getState()).toBe(bStateBefore) // no Zustand publication
    expect(bSubscriberCalls).toBe(0)

    bUnsubscribe()
    if (bTicket) expect(b.controls.releasePortfolioOperation(bTicket)).toBe(true)
    a.controls.dispose()
    b.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Three-tab fan-out: one commit reaches every other participant exactly once via dual
// BroadcastChannel+storage delivery, and a disposed participant receives nothing.
// ─────────────────────────────────────────────────────────────

describe('three-tab fan-out', () => {
  it('A commits: B and C each get pending 1, A stays 0, disposed D gets 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'fanout-a')
    const { instance: b } = makeInstance(bcHub, storageHub, 'fanout-b')
    const { instance: c } = makeInstance(bcHub, storageHub, 'fanout-c')
    const { instance: d } = makeInstance(bcHub, storageHub, 'fanout-d')
    seedManualBaseline(a.store)
    d.controls.dispose()

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    const bInspect = b.controls.inspect()
    const cInspect = c.controls.inspect()
    expect(bInspect.pendingInvalidation?.operation).toBe('updateHolding')
    expect(cInspect.pendingInvalidation?.operation).toBe('updateHolding')
    // Dual BroadcastChannel+storage delivery of the same logical event advances each recipient's
    // local receive sequence by exactly 1, not 2 (transport-level messageId dedupe).
    expect(bInspect.invalidationReceiveSequence).toBe(1)
    expect(cInspect.invalidationReceiveSequence).toBe(1)
    expect(bInspect.pendingInvalidation?.receivedSequence).toBe(1)
    expect(cInspect.pendingInvalidation?.receivedSequence).toBe(1)

    expect(d.controls.inspect().pendingInvalidation).toBeNull()
    expect(d.controls.inspect().invalidationReceiveSequence).toBe(0)

    a.controls.dispose()
    b.controls.dispose()
    c.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Scope guard: importCsv/importPortfolioSnapshot are explicitly out of RA-008-C1 scope. Even a
// real, successful, projection-changing commit through either must emit 0 (RA-008-C2 territory).
// ─────────────────────────────────────────────────────────────

describe('CSV/snapshot scope guard', () => {
  it('importCsv success emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-scope')
    seedManualBaseline(a.store)

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result.ok).toBe(true)
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('importPortfolioSnapshot success emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-scope')
    a.store.setState(state => ({
      holdings: [], trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))

    const result = await a.store.getState().importPortfolioSnapshot(distinctSnapshotRaw('9101'))

    expect(result.ok).toBe(true)
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })
})
