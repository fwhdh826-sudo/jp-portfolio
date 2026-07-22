import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────
// RA-008-D1: projects the RA-008-B2 runtime's remote-invalidation pending onto a UI-only
// Zustand field (system.crossTabInvalidation), and wires the ONE production clear authority
// (a Web-Lock-verified initialize SUCCESS). This suite is DIRECT: a shared fake
// BroadcastChannel/storage hub feeds real transports into createAppStoreInstanceForTest, so
// receive/flush/clear are exercised through the actual store, not a mock of it. StatusBar/reload
// UI is out of scope (RA-008-D2); this file only covers the store-side projection and clear.
// ─────────────────────────────────────────────────────────────

const loadProbe = vi.hoisted(() => ({
  implementation: null as null | (() => Promise<unknown>),
}))

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async (...args: Parameters<typeof actual.refreshAllData>) => {
      if (loadProbe.implementation) return loadProbe.implementation()
      return actual.refreshAllData(...args)
    },
  }
})

const analysisProbe = vi.hoisted(() => ({ calls: 0, fail: false }))

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
import { createPortfolioCoordinationFailure } from './portfolioOperationResult'
import {
  createPortfolioGenerationInvalidationEvent,
  createPortfolioGenerationInvalidationTransport,
  type PortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationTransport,
} from './portfolioGenerationInvalidationTransport'
import { FakeBroadcastChannelHub } from './testing/fakeBroadcastChannelHub'
import { FakeStorageEventHub } from './testing/fakeStorageEventHub'
import { FakeLockManager } from './testing/fakeLockManager'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import {
  buildPortfolioAnalysisFingerprint,
  createAppStoreInstanceForTest,
  type AppStoreState,
} from './useAppStore'

// ── Fixed clock ──────────────────────────────────────────────────────────────
const NOW_MS = Date.parse('2026-07-23T03:00:00.000Z')

// ── Fixtures ─────────────────────────────────────────────────────────────────
const TEST_HOLDING: Holding = {
  code: '2071', name: 'D1 warning-state holding', eval: 300_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const TEST_TRUST: Trust = {
  id: 'd1warn-fund', name: 'D1 warning-state fund', abbr: 'D1W', account: '特定',
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

// ── localStorage mock ─────────────────────────────────────────────────────────
let storage: Record<string, string> = {}
let storageThrowOnSet = false
const localStorageMock = {
  getItem: (key: string): string | null => storage[key] ?? null,
  setItem: (key: string, value: string): void => {
    if (storageThrowOnSet) throw new Error('injected persistence failure')
    storage[key] = value
  },
  removeItem: (key: string): void => { delete storage[key] },
}

// ── Harness helpers ──────────────────────────────────────────────────────────
function harnessTransport(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
): PortfolioGenerationInvalidationTransport {
  const context = storageHub.createContext()
  return createPortfolioGenerationInvalidationTransport({
    instanceId,
    createBroadcastChannel: bcHub.createFactory(),
    storage: context.storage,
    storageEventTarget: context.eventTarget,
  })
}

function remoteEvent(
  overrides: Partial<Parameters<typeof createPortfolioGenerationInvalidationEvent>[0]> = {},
): PortfolioGenerationInvalidationEvent {
  return createPortfolioGenerationInvalidationEvent({
    senderInstanceId: 'external-tab',
    operation: 'importCsv',
    ...overrides,
  })
}

function adapter(manager: FakeLockManager): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 60_000 })
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
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

function seedCanonical(state: AppStoreState): void {
  persistCsvImportTransaction({
    holdings: state.holdings,
    trust: state.trust,
    learning: state.learning,
    csvImportedAt: null,
    provenance: null,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-07-23', total: 0, evalById: {} },
    portfolioPolicy: state.portfolioPolicy,
    cashAssumptions: state.cashAssumptions,
    origin: 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

/** A store wired to a FakeLockManager (for tests that need to control grant timing). */
function createHarnessInstance(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
  manager: FakeLockManager,
) {
  const transport = harnessTransport(bcHub, storageHub, instanceId)
  const created = createAppStoreInstanceForTest({
    portfolioGenerationLock: adapter(manager),
    portfolioGenerationInvalidation: { instanceId, transport },
  })
  baselineStore(created.store)
  return created
}

/** A store wired to an immediate (auto-granting) lock adapter, for straight-line success/failure tests. */
function immediateInstance(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
) {
  const transport = harnessTransport(bcHub, storageHub, instanceId)
  const created = createAppStoreInstanceForTest({
    portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
    portfolioGenerationInvalidation: { instanceId, transport },
  })
  baselineStore(created.store)
  return created
}

function csvFile(evalValue: number): File {
  const content = [
    'データ基準日時,2026-07-23T02:00:00+09:00',
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    `${TEST_HOLDING.code},${TEST_HOLDING.name},1200,${evalValue},0.00,0.00,2025-01-01`,
  ].join('\n')
  return new File([content], 'd1-warning-state.csv', { type: 'text/csv' })
}

function snapshotRawFor(code: string): string {
  const source = createAppStoreInstanceForTest()
  source.store.setState(state => ({
    holdings: [{ ...TEST_HOLDING, code, eval: 555_000 }],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
  }))
  const raw = source.store.getState().exportPortfolioSnapshot()
  source.controls.dispose()
  return raw
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', CountingFileReader)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: () => Promise.resolve({}) })))
  storage = {}
  storageThrowOnSet = false
  analysisProbe.calls = 0
  analysisProbe.fail = false
  loadProbe.implementation = null
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────
// Initial state and callback binding
// ─────────────────────────────────────────────────────────────

describe('initial state and callback binding', () => {
  it('starts with no warning and a bound flush callback', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())

    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().hasInvalidationFlushCallback).toBe(true)

    a.controls.dispose()
  })

  it('binds one independent callback per store, and never subscribes to the transport beyond the runtime creation subscription', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const a = createHarnessInstance(bcHub, storageHub, 'a', manager)
    const b = createHarnessInstance(bcHub, storageHub, 'b', manager)

    expect(bcHub.participantCount).toBe(2)
    expect(a.controls.inspect().hasInvalidationFlushCallback).toBe(true)
    expect(b.controls.inspect().hasInvalidationFlushCallback).toBe(true)

    a.controls.dispose()
    expect(a.controls.inspect().hasInvalidationFlushCallback).toBe(false)
    expect(b.controls.inspect().hasInvalidationFlushCallback).toBe(true)

    b.controls.dispose()
  })

  it('the default test factory never touches a real browser transport backend', () => {
    const created = createAppStoreInstanceForTest()
    expect(created.controls.inspect().hasInvalidationFlushCallback).toBe(true)
    expect(created.store.getState().system.crossTabInvalidation).toBeUndefined()
    created.controls.dispose()
  })

  it('flushes an event recorded before the store/callback existed, once binding completes', () => {
    const earlyEvent = remoteEvent({ messageId: 'pre-bind' })
    const preBoundTransport: PortfolioGenerationInvalidationTransport = {
      publish: () => {},
      // Fires synchronously inside createAppStoreRuntime, strictly before
      // createAppStoreStateCreator can bind flushPendingToStore.
      subscribe: listener => { listener(earlyEvent); return () => {} },
      dispose: () => {},
    }
    const created = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'pre-bind', transport: preBoundTransport },
    })

    expect(created.controls.inspect().pendingInvalidation).toMatchObject({ messageId: 'pre-bind' })
    expect(created.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    created.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Idle receive
// ─────────────────────────────────────────────────────────────

describe('idle receive', () => {
  it('projects a stale warning with exactly one publish and one subscriber notification, leaving every portfolio/analysis reference untouched', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    const before = a.store.getState()
    let notifications = 0
    const unsubscribe = a.store.subscribe(() => { notifications += 1 })

    publisher.publish(remoteEvent())

    const after = a.store.getState()
    expect(after).not.toBe(before)
    expect(after.system).not.toBe(before.system)
    expect(after.system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(notifications).toBe(1)
    for (const key of [
      'holdings', 'trust', 'portfolioPolicy', 'cashAssumptions', 'market', 'macro',
      'analysis', 'metrics', 'universe', 'zeroPlan', 'stockPlan', 'trustPlan', 'officialDecision',
    ] as const) {
      expect(after[key]).toBe(before[key])
    }
    expect(after.activeTab).toBe(before.activeTab)
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)

    unsubscribe()
    a.controls.dispose()
    publisher.dispose()
  })

  it('never leaks event fields (messageId/senderInstanceId/committedAt/operation) into the published warning', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ operation: 'updateHolding' }))

    const warning = a.store.getState().system.crossTabInvalidation
    expect(warning && Object.keys(warning)).toEqual(['status'])
    expect(warning).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Duplicate delivery / latest-event collapse
// ─────────────────────────────────────────────────────────────

describe('duplicate and latest-event collapse', () => {
  it('a dual-channel delivery of the same logical event still publishes only once', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })

    publisher.publish(remoteEvent({ messageId: 'dual-1' }))

    expect(notifications).toBe(1)
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })

  it('a second logical event while already stale collapses pending to the latest, with zero additional publication', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })

    publisher.publish(remoteEvent({ messageId: 'first' }))
    expect(notifications).toBe(1)
    const stateAfterFirst = a.store.getState()

    publisher.publish(remoteEvent({ messageId: 'second' }))

    expect(notifications).toBe(1)
    expect(a.store.getState()).toBe(stateAfterFirst)
    expect(a.controls.inspect().pendingInvalidation).toMatchObject({ messageId: 'second' })
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(2)

    a.controls.dispose()
    publisher.dispose()
  })

  it('keeps the latest arrival as pending even when its committedAt is earlier than an already-collapsed event (fail-closed arrival order)', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'later-committed', committedAt: '2026-07-23T05:00:00.000Z' }))
    publisher.publish(remoteEvent({ messageId: 'earlier-committed', committedAt: '2026-07-23T01:00:00.000Z' }))

    expect(a.controls.inspect().pendingInvalidation?.messageId).toBe('earlier-committed')
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// No side effects on receive
// ─────────────────────────────────────────────────────────────

describe('no side effects on receive', () => {
  it('reads/writes zero storage, requests the Web Lock zero times, runs analysis zero times, and never re-publishes to its own transport', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const rawTransport = harnessTransport(bcHub, storageHub, 'a')
    const publishCounter = { count: 0 }
    const spyTransport: PortfolioGenerationInvalidationTransport = {
      publish: event => { publishCounter.count += 1; rawTransport.publish(event) },
      subscribe: listener => rawTransport.subscribe(listener),
      dispose: () => rawTransport.dispose(),
    }
    const a = createAppStoreInstanceForTest({
      portfolioGenerationLock: adapter(manager),
      portfolioGenerationInvalidation: { instanceId: 'a', transport: spyTransport },
    })
    baselineStore(a.store)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    let reads = 0
    let writes = 0
    vi.stubGlobal('localStorage', {
      getItem: () => { reads += 1; return null },
      setItem: () => { writes += 1 },
      removeItem: () => {},
    })

    publisher.publish(remoteEvent())

    expect(reads).toBe(0)
    expect(writes).toBe(0)
    expect(manager.requests.length).toBe(0)
    expect(analysisProbe.calls).toBe(0)
    expect(publishCounter.count).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Active operation defer
// ─────────────────────────────────────────────────────────────

describe('active operation defer', () => {
  it('defers publication while a manual ticket is held, and flushes exactly once after a valid release', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    const ticket = a.controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()

    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })

    publisher.publish(remoteEvent({ operation: 'setPortfolioPolicy' }))

    expect(notifications).toBe(0)
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().activeOperationKind).toBe('manual')

    expect(a.controls.releasePortfolioOperation(ticket!)).toBe(true)

    expect(notifications).toBe(1)
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    // Flush only projects the warning; it never clears the runtime pending (only a verified
    // initialize does that).
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not flush on a wrong-owner release, and keeps the existing true/false release contract', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    const ticket = a.controls.acquirePortfolioOperation('manual')
    publisher.publish(remoteEvent())
    const wrongTicket = { token: Symbol('wrong'), kind: 'manual' as const }

    expect(a.controls.releasePortfolioOperation(wrongTicket)).toBe(false)
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().activeOperationKind).toBe('manual')

    expect(a.controls.releasePortfolioOperation(ticket!)).toBe(true)
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })

  it('flushes only once the operation (and thus the Web Lock) has actually released, not while the ticket is still held', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const a = createHarnessInstance(bcHub, storageHub, 'a', manager)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })

    const pending = a.store.getState().refreshAllData()
    publisher.publish(remoteEvent())
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(notifications).toBe(0)

    const result = await grant(manager, pending)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    // One publish from refreshAllData's own final state, one from the deferred flush after release.
    expect(notifications).toBe(2)

    a.controls.dispose()
    publisher.dispose()
  })

  it('still flushes after the deferring operation itself fails, as long as its ticket released validly', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const a = createHarnessInstance(bcHub, storageHub, 'a', manager)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    storageThrowOnSet = true
    const pending = a.store.getState().refreshAllData()
    publisher.publish(remoteEvent())
    const result = await grant(manager, pending)
    storageThrowOnSet = false

    expect(result).toMatchObject({ ok: false, code: 'LOAD_PERSISTENCE_ERROR' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Initialize verified clear
// ─────────────────────────────────────────────────────────────

describe('initialize verified clear', () => {
  it('clears an existing warning and the runtime pending in the SAME single initialize publication', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(notifications).toBe(1)
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().pendingInvalidation).toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(a.controls.inspect().invalidationReceiveSequence)

    a.controls.dispose()
    publisher.dispose()
  })

  it('clears even on a projection-equivalent success (durable already matches the published baseline)', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()

    a.controls.dispose()
    publisher.dispose()
  })

  it('clears even on a projection-changing success (durable canonical differs from the in-memory baseline)', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    seedCanonical(a.store.getState())
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not clear on a publish-hook failure: warning, pending, and watermark all survive', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())
    const sequenceBefore = a.controls.inspect().invalidationReceiveSequence

    a.controls.setLoadPublishBeforeApplyHook(() => { throw new Error('publish sentinel') })
    const result = await a.store.getState().initialize()

    expect(result).toEqual({ ok: false, operation: 'initialize', code: 'LOAD_PUBLISH_ERROR', retryable: false })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(sequenceBefore)

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not clear on restore failure', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'

    const result = await a.store.getState().initialize()

    expect(result).toMatchObject({ ok: false, code: 'LOAD_RESTORE_ERROR' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not clear on data failure', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    loadProbe.implementation = async () => { throw new Error('injected network failure') }
    const result = await a.store.getState().initialize()
    loadProbe.implementation = null

    expect(result).toMatchObject({ ok: false, code: 'LOAD_DATA_ERROR' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not clear on analysis failure', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    analysisProbe.fail = true
    const result = await a.store.getState().initialize()
    analysisProbe.fail = false

    expect(result).toMatchObject({ ok: false, code: 'LOAD_ANALYSIS_ERROR' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not clear on persistence failure', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())
    const sequenceBefore = a.controls.inspect().invalidationReceiveSequence

    storageThrowOnSet = true
    const result = await a.store.getState().initialize()
    storageThrowOnSet = false

    expect(result).toMatchObject({ ok: false, code: 'LOAD_PERSISTENCE_ERROR' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    // RA-008-D1-V mutation coverage: the runtime pending/watermark must survive a persistence
    // failure exactly like the Zustand-level warning does — the clear authority is a *verified*
    // initialize SUCCESS, and persistence failing before that verification must leave both layers
    // untouched, not just the displayed field.
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(sequenceBefore)

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not clear on Web Lock failure', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const unavailableAdapter: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_UNAVAILABLE')
      },
    }
    const transport = harnessTransport(bcHub, storageHub, 'a')
    const a = createAppStoreInstanceForTest({
      portfolioGenerationLock: unavailableAdapter,
      portfolioGenerationInvalidation: { instanceId: 'a', transport },
    })
    baselineStore(a.store)
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().initialize()

    expect(result).toEqual(createPortfolioCoordinationFailure('initialize', 'WEB_LOCK_UNAVAILABLE'))
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    publisher.dispose()
  })

  it('still clears when a synchronous subscriber throws after the final state has actually applied', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let notifications = 0
    a.store.subscribe(() => { notifications += 1; throw new Error('subscriber threw') })

    const result = await a.store.getState().initialize()

    expect(result).toEqual({ ok: true, operation: 'initialize', code: 'SUCCESS' })
    expect(notifications).toBe(1)
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().pendingInvalidation).toBeNull()
    errorSpy.mockRestore()

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Event during / after initialize
// ─────────────────────────────────────────────────────────────

describe('event received during initialize, and after clear', () => {
  it('an event arriving while the ticket is held stays deferred, then is absorbed by that same initialize success', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    const pending = a.store.getState().initialize()
    publisher.publish(remoteEvent())
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()

    const result = await pending

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().pendingInvalidation).toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(a.controls.inspect().invalidationReceiveSequence)

    a.controls.dispose()
    publisher.dispose()
  })

  it('re-shows the warning for a genuinely new event arriving after clear, even with an older committedAt (fail-closed)', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    await a.store.getState().initialize()
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    const sequenceAtClear = a.controls.inspect().invalidationReceiveSequence

    publisher.publish(remoteEvent({ committedAt: '2020-01-01T00:00:00.000Z' }))

    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(sequenceAtClear + 1)

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Operations that never clear the warning
// ─────────────────────────────────────────────────────────────

describe('operations that never clear the warning', () => {
  it('refreshAllData SUCCESS leaves an existing warning, the runtime pending, and the watermark in place', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)

    a.controls.dispose()
    publisher.dispose()
  })

  it('a manual mutation SUCCESS (setPortfolioPolicy) leaves an existing warning, the runtime pending, and the watermark in place', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.25 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)

    a.controls.dispose()
    publisher.dispose()
  })

  it('a CSV import SUCCESS leaves an existing warning, the runtime pending, and the watermark in place', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result.ok).toBe(true)
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)

    a.controls.dispose()
    publisher.dispose()
  })

  it('a portfolio snapshot import SUCCESS leaves an existing warning, the runtime pending, and the watermark in place', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    a.store.setState(state => ({
      holdings: [], trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const result = await a.store.getState().importPortfolioSnapshot(snapshotRawFor('9101'))

    expect(result.ok).toBe(true)
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)

    a.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Reset / dispose
// ─────────────────────────────────────────────────────────────

describe('reset and dispose', () => {
  it('reset clears the Zustand warning together with runtime pending/sequence/watermark, without affecting another store', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const a = createHarnessInstance(bcHub, storageHub, 'a', manager)
    const b = createHarnessInstance(bcHub, storageHub, 'b', manager)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent())
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(b.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.reset()

    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(a.controls.inspect().pendingInvalidation).toBeNull()
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(0)
    expect(a.controls.inspect().invalidationClearWatermark).toBe(0)
    expect(b.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    publisher.publish(remoteEvent({ messageId: 'post-reset' }))
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    a.controls.dispose()
    b.controls.dispose()
    publisher.dispose()
  })

  it('dispose unbinds the flush callback: further events publish zero times, is idempotent, and other stores are unaffected', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const a = createHarnessInstance(bcHub, storageHub, 'a', manager)
    const b = createHarnessInstance(bcHub, storageHub, 'b', manager)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    a.controls.dispose()
    expect(a.controls.inspect().hasInvalidationFlushCallback).toBe(false)

    let notifications = 0
    a.store.subscribe(() => { notifications += 1 })
    publisher.publish(remoteEvent())

    expect(notifications).toBe(0)
    expect(a.store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(b.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    expect(() => a.controls.dispose()).not.toThrow()
    expect(a.controls.inspect().hasInvalidationFlushCallback).toBe(false)

    b.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Persistence exclusion and analysis/projection isolation
// ─────────────────────────────────────────────────────────────

describe('persistence exclusion and analysis isolation', () => {
  it('never appears in the canonical persisted payload', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    seedCanonical(a.store.getState())
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    await a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })

    const raw = storage[CSV_IMPORT_GENERATION_KEY]
    expect(raw).toBeDefined()
    expect(raw).not.toMatch(/crossTabInvalidation/)

    a.controls.dispose()
    publisher.dispose()
  })

  it('never appears in a portfolio snapshot export', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    const raw = a.store.getState().exportPortfolioSnapshot()
    expect(raw).not.toMatch(/crossTabInvalidation/)

    a.controls.dispose()
    publisher.dispose()
  })

  it('never appears in the cross-tab invalidation event payload a writer publishes', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const rawTransport = harnessTransport(bcHub, storageHub, 'a')
    let published: PortfolioGenerationInvalidationEvent | null = null
    const spyTransport: PortfolioGenerationInvalidationTransport = {
      publish: event => { published = event; rawTransport.publish(event) },
      subscribe: listener => rawTransport.subscribe(listener),
      dispose: () => rawTransport.dispose(),
    }
    const a = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: 'a', transport: spyTransport },
    })
    baselineStore(a.store)
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())

    await a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.13 })

    expect(published).not.toBeNull()
    expect(JSON.stringify(published)).not.toMatch(/crossTabInvalidation/)

    a.controls.dispose()
    publisher.dispose()
  })

  it('does not affect the analysis fingerprint', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createHarnessInstance(bcHub, storageHub, 'a', new FakeLockManager())
    const clean = a.store.getState()
    const warned: AppStoreState = {
      ...clean,
      system: { ...clean.system, crossTabInvalidation: { status: 'stale' } },
    }

    expect(buildPortfolioAnalysisFingerprint(warned)).toBe(buildPortfolioAnalysisFingerprint(clean))

    a.controls.dispose()
  })

  it('does not make refresh spuriously stale: the durable-alignment projection ignores the warning field', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = immediateInstance(bcHub, storageHub, 'a')
    seedCanonical(a.store.getState())
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    publisher.publish(remoteEvent())
    expect(a.store.getState().system.crossTabInvalidation).toEqual({ status: 'stale' })

    const result = await a.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })

    a.controls.dispose()
    publisher.dispose()
  })
})
