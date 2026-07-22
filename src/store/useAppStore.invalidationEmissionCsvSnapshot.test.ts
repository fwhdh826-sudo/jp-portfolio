import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────
// RA-008-C2: connects exactly-once, rollback-aware cross-tab invalidation emission to the two
// remaining durable writers that have a post-commit rollback/ownership window: importCsv and
// importPortfolioSnapshot. Unlike RA-008-C1's 8 writers (no rollback window — emit right after
// persistence success), these two may still roll back or lose ownership AFTER the durable commit
// but BEFORE the local Zustand publish. This suite proves the event is emitted only after that
// window closes: the committed generation is confirmed applied to the local store, never before,
// never after a rollback, and never more than once per transaction.
// ─────────────────────────────────────────────────────────────

const trackerStagingProbe = vi.hoisted(() => ({ shouldThrow: false }))

vi.mock('../domain/learning/trustShortTracker', async importOriginal => {
  const actual = await importOriginal<typeof import('../domain/learning/trustShortTracker')>()
  return {
    ...actual,
    stageTrustExecutionFromCsvSync: (...args: Parameters<typeof actual.stageTrustExecutionFromCsvSync>) => {
      if (trackerStagingProbe.shouldThrow) throw new Error('injected tracker staging failure')
      return actual.stageTrustExecutionFromCsvSync(...args)
    },
  }
})

import type { CsvImportProvenance, Holding, Trust } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
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

// ── Fixtures ─────────────────────────────────────────────────────────────────
const HOLDING: Holding = {
  code: '2001', name: 'c2 holding', eval: 300_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const TRUST: Trust = {
  id: 'c2-fund', name: 'c2 fund', abbr: 'C2F', account: '特定',
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

// ── localStorage mock (module-scoped so individual tests can reconfigure) ────────────────────
let storage: Record<string, string> = {}
const failWriteKeys = new Set<string>()
const failReadKeys = new Set<string>()
const failRemoveKeys = new Set<string>()
let failAllWrites = false
let storageReentry: ((key: string) => void) | null = null
function defaultGetItem(key: string): string | null {
  if (failReadKeys.has(key)) throw new Error(`forced read failure (${key})`)
  return storage[key] ?? null
}
function defaultSetItem(key: string, value: string): void {
  if (failAllWrites || failWriteKeys.has(key)) throw new Error(`forced write failure (${key})`)
  storage[key] = value
  storageReentry?.(key)
}
function defaultRemoveItem(key: string): void {
  if (failRemoveKeys.has(key)) throw new Error(`forced remove failure (${key})`)
  delete storage[key]
}
const getItem = vi.fn(defaultGetItem)
const setItem = vi.fn(defaultSetItem)
const removeItem = vi.fn(defaultRemoveItem)
const lsMock = { getItem, setItem, removeItem }

// Individual tests may install a bespoke `mockImplementation` (e.g. call-counter-based ownership
// races). `mockReset()` — not `mockClear()` — is required here so that override does not leak
// into the next test; the default implementation is then reinstalled explicitly.
function resetLocalStorageMock(): void {
  storage = {}
  failWriteKeys.clear()
  failReadKeys.clear()
  failRemoveKeys.clear()
  failAllWrites = false
  storageReentry = null
  getItem.mockReset().mockImplementation(defaultGetItem)
  setItem.mockReset().mockImplementation(defaultSetItem)
  removeItem.mockReset().mockImplementation(defaultRemoveItem)
}

// ── CSV fixtures ─────────────────────────────────────────────────────────────
function csvContent(evalValue = 444_000, sourceAsOf = '2026-07-22T02:00:00+09:00'): string {
  return [
    `データ基準日時,${sourceAsOf}`,
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    `${HOLDING.code},${HOLDING.name},1200,${evalValue},0.00,0.00,2025-01-01`,
  ].join('\n')
}

function csvFile(evalValue?: number, sourceAsOf?: string): File {
  return new File([csvContent(evalValue, sourceAsOf)], 'emission.csv', { type: 'text/csv' })
}

// ── Snapshot fixtures ────────────────────────────────────────────────────────
function hexFingerprint(tag: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < tag.length; index += 1) {
    hash ^= tag.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function provenance(tag: string, sourceAsOf: string, overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    importedAt: sourceAsOf,
    sourceAsOf,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    contentFingerprint: `fnv1a32:${hexFingerprint(tag)}`,
    sourceFileName: `snap-${tag}.csv`,
    fileLastModified: null,
    ...overrides,
  }
}

function buildSnapshotRaw(config: {
  code?: string
  evalValue?: number
  csvImportedAt?: string | null
  provenance?: CsvImportProvenance | null
} = {}): string {
  const source = createAppStoreInstanceForTest()
  source.store.setState(state => ({
    holdings: [{ ...HOLDING, code: config.code ?? 'SNAP-1', eval: config.evalValue ?? 777_000 }],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      csvLastImportedAt: config.csvImportedAt ?? null,
      csvImportProvenance: config.provenance ?? null,
      csvSyncSummary: null,
    },
  }))
  const raw = source.store.getState().exportPortfolioSnapshot()
  source.controls.dispose()
  return raw
}

// ── Harness: independent runtimes sharing one fake cross-tab hub ────────────────────────────
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

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

function seedBaseline(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [{ ...HOLDING }],
    trust: [{ ...TRUST }],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      status: 'idle', error: null,
      csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function seedAuthoritativeCanonical(holdings: Holding[], trust: Trust[], provenanceValue: CsvImportProvenance, importedAt: string): void {
  persistCsvImportTransaction({
    holdings,
    trust,
    learning: null,
    csvImportedAt: importedAt,
    provenance: provenanceValue,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
    portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
    cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
    origin: 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
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
  expect(event).not.toHaveProperty('csvFilename')
  expect(event).not.toHaveProperty('content')
  expect(event).not.toHaveProperty('receipt')
  expect(event).not.toHaveProperty('rollbackStatus')
  expect(event).not.toHaveProperty('error')
  expect(event).not.toHaveProperty('officialDecision')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('FileReader', CountingFileReader)
  resetLocalStorageMock()
  vi.stubGlobal('localStorage', lsMock)
  trackerStagingProbe.shouldThrow = false
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  trackerStagingProbe.shouldThrow = false
})

// ─────────────────────────────────────────────────────────────
// Normal success: exact event fields, recipient pending 1, sender pending 0, dual delivery
// ─────────────────────────────────────────────────────────────

describe('normal success', () => {
  it('CSV: emits exactly 1 well-formed event; recipient pending 1, sender pending 0, dual delivery receiveSequence 1', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-success')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-csv-success')
    seedBaseline(a.store)

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expectExactEventShape(events[0], 'importCsv', 'sender-csv-success')
    expect(new Date(events[0].committedAt).getTime()).toBeGreaterThanOrEqual(NOW_MS)

    const bPending = b.controls.inspect().pendingInvalidation
    expect(bPending?.operation).toBe('importCsv')
    expect(bPending?.messageId).toBe(events[0].messageId)
    expect(bPending?.receivedSequence).toBe(1)
    expect(b.controls.inspect().invalidationReceiveSequence).toBe(1)
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    a.controls.dispose()
    b.controls.dispose()
  })

  it('CSV: committedAt reflects the generation commit clock, not a fresh clock read at emit time', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-clock')
    seedBaseline(a.store)
    // Advance the clock strictly after COMMITTED (persistence has already captured its own
    // commit timestamp) but before PUBLISHED/emit — a naive Date.now()-at-emit-time
    // implementation would leak this advanced clock into the event.
    a.controls.setPortfolioGenerationPhaseObserver((_origin, phase) => {
      if (phase === 'COMMITTED') vi.setSystemTime(NOW_MS + 5 * 60 * 1000)
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(events[0].committedAt).toBe(new Date(NOW_MS).toISOString())
    a.controls.dispose()
  })

  it('snapshot: committedAt reflects the generation commit clock, not a fresh clock read at emit time', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-clock')
    a.controls.setPortfolioGenerationPhaseObserver((_origin, phase) => {
      if (phase === 'COMMITTED') vi.setSystemTime(NOW_MS + 5 * 60 * 1000)
    })

    const raw = buildSnapshotRaw({ code: 'SNAP-CLOCK', evalValue: 610_000 })
    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(events[0].committedAt).toBe(new Date(NOW_MS).toISOString())
    a.controls.dispose()
  })

  it('CSV: two independent transactions produce two distinct messageIds', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-unique')
    seedBaseline(a.store)

    await a.store.getState().importCsv(csvFile(444_000, '2026-07-22T02:00:00+09:00'))
    await a.store.getState().importCsv(csvFile(555_000, '2026-07-22T03:00:00+09:00'))

    expect(events).toHaveLength(2)
    expect(events[0].messageId).not.toBe(events[1].messageId)
    a.controls.dispose()
  })

  it('snapshot: emits exactly 1 well-formed event; recipient pending 1, sender pending 0, dual delivery receiveSequence 1', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-success')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-snapshot-success')

    const raw = buildSnapshotRaw({ code: 'SNAP-A', evalValue: 900_000 })
    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expectExactEventShape(events[0], 'importPortfolioSnapshot', 'sender-snapshot-success')

    const bPending = b.controls.inspect().pendingInvalidation
    expect(bPending?.operation).toBe('importPortfolioSnapshot')
    expect(bPending?.messageId).toBe(events[0].messageId)
    expect(bPending?.receivedSequence).toBe(1)
    expect(b.controls.inspect().invalidationReceiveSequence).toBe(1)
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    a.controls.dispose()
    b.controls.dispose()
  })

  it('snapshot: two independent transactions produce two distinct messageIds', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-unique')

    const first = await a.store.getState().importPortfolioSnapshot(buildSnapshotRaw({ code: 'SNAP-U1', evalValue: 1 }))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    // A second commit needs a fresh "no current generation" baseline in BOTH the store and the
    // durable canonical — otherwise either the final currentGenerationExists guard
    // (SNAPSHOT_OVERWRITE_BLOCKED) or a store/canonical mismatch (CROSS_TAB_STATE_STALE) blocks it.
    delete storage[CSV_IMPORT_GENERATION_KEY]
    a.store.setState(state => ({
      holdings: [], trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    const second = await a.store.getState().importPortfolioSnapshot(buildSnapshotRaw({ code: 'SNAP-U2', evalValue: 2 }))
    expect(second).toMatchObject({ ok: true, code: 'SUCCESS' })

    expect(events).toHaveLength(2)
    expect(events[0].messageId).not.toBe(events[1].messageId)
    a.controls.dispose()
  })

  it('snapshot: a projection-unchanged commit (identical re-apply) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-noop')

    const raw = buildSnapshotRaw({ code: 'SNAP-NOOP', evalValue: 500_000 })
    const first = await a.store.getState().importPortfolioSnapshot(raw)
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    events.length = 0

    // Same holdings/trust/policy/cash values, but a distinct provenance/content identity so the
    // duplicate-detection short-circuit (which never reaches persistence at all) is not what's
    // under test here — the second commit legitimately proceeds to persistence and publish, but
    // leaves the tracked projection numerically unchanged.
    a.store.setState(state => ({ system: { ...state.system, csvImportProvenance: null, csvLastImportedAt: null } }))
    const raw2 = buildSnapshotRaw({ code: 'SNAP-NOOP', evalValue: 500_000 })
    const second = await a.store.getState().importPortfolioSnapshot(raw2)

    expect(second).toMatchObject({ ok: true })
    if (second.code === 'SUCCESS') expect(events).toHaveLength(0)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Ordering: no event before/at any pre-apply phase transition; exactly 1 once the committed
// generation is confirmed applied; Web Lock, local ticket, and transaction ownership all still
// held at the moment of emission.
// ─────────────────────────────────────────────────────────────

describe('emit ordering and timing', () => {
  it('CSV: 0 at every phase transition through PUBLISHED, 1 only after full apply; lock+ticket+transaction held at emit', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const lockAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager })
    const phaseEventCounts: Record<string, number> = {}
    let lockHeldAtEmit: boolean | null = null
    let ticketHeldAtEmit: boolean | null = null
    let ownerAtEmit: string | null = null
    let phaseAtEmit: string | null = null

    const probe: { instance: ReturnType<typeof makeInstance>['instance'] | null } = { instance: null }
    const onPublish = () => {
      lockHeldAtEmit = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      ticketHeldAtEmit = probe.instance!.controls.acquirePortfolioOperation('csv') === null
      ownerAtEmit = probe.instance!.controls.inspect().activeGenerationOrigin
      phaseAtEmit = probe.instance!.controls.inspect().activeGenerationPhase
    }
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-order', lockAdapter, onPublish)
    probe.instance = a
    seedBaseline(a.store)
    a.controls.setPortfolioGenerationPhaseObserver((_origin, phase) => {
      phaseEventCounts[phase] = events.length
    })

    const result = await grant(manager, a.store.getState().importCsv(csvFile(444_000)))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    for (const phase of ['READING', 'STAGING', 'ANALYZING', 'PREPARED', 'PERSISTING', 'COMMITTED', 'PUBLISHED']) {
      expect(phaseEventCounts[phase]).toBe(0)
    }
    expect(lockHeldAtEmit).toBe(true)
    expect(ticketHeldAtEmit).toBe(true)
    expect(ownerAtEmit).toBe('csv')
    expect(phaseAtEmit).toBe('PUBLISHED')

    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(events).toHaveLength(1)
    a.controls.dispose()
  })

  it('snapshot: 0 at every phase transition through PUBLISHED, 1 only after full apply; lock+ticket+transaction held at emit', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const manager = new FakeLockManager()
    const lockAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager })
    const phaseEventCounts: Record<string, number> = {}
    let lockHeldAtEmit: boolean | null = null
    let ticketHeldAtEmit: boolean | null = null
    let ownerAtEmit: string | null = null
    let phaseAtEmit: string | null = null

    const probe: { instance: ReturnType<typeof makeInstance>['instance'] | null } = { instance: null }
    const onPublish = () => {
      lockHeldAtEmit = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      ticketHeldAtEmit = probe.instance!.controls.acquirePortfolioOperation('snapshot') === null
      ownerAtEmit = probe.instance!.controls.inspect().activeGenerationOrigin
      phaseAtEmit = probe.instance!.controls.inspect().activeGenerationPhase
    }
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-order', lockAdapter, onPublish)
    probe.instance = a
    a.controls.setPortfolioGenerationPhaseObserver((_origin, phase) => {
      phaseEventCounts[phase] = events.length
    })

    const raw = buildSnapshotRaw({ code: 'SNAP-ORDER', evalValue: 650_000 })
    const result = await grant(manager, a.store.getState().importPortfolioSnapshot(raw))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    for (const phase of ['ANALYZING', 'PERSISTING', 'COMMITTED', 'PUBLISHED']) {
      expect(phaseEventCounts[phase]).toBe(0)
    }
    expect(lockHeldAtEmit).toBe(true)
    expect(ticketHeldAtEmit).toBe(true)
    expect(ownerAtEmit).toBe('snapshot')
    expect(phaseAtEmit).toBe('PUBLISHED')

    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(events).toHaveLength(1)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Applied-but-exception: a post-apply observer/subscriber throw is recovered as SUCCESS via
// generation-identity confirmation, and the exactly-once guard still fires exactly once (from
// the catch path, since the normal path never reached its own emit call).
// ─────────────────────────────────────────────────────────────

describe('applied-but-exception paths still emit exactly 1', () => {
  // useAppStore.ts's own api.subscribe wrapper (see reportSubscriberException) already swallows
  // any exception a plain store.subscribe() listener throws, so a throwing subscriber never
  // actually reaches importCsv/importPortfolioSnapshot's outer catch — it only proves subscriber
  // failures don't break the writer, which is a good thing to lock in but not RA-008-C1/C2's
  // "applied but exception before result determination" boundary. The phase observer, by
  // contrast, is called unwrapped inside setPortfolioGenerationTransactionPhase — throwing there
  // right at the PUBLISHED transition (i.e. immediately after set() has already applied state)
  // is the precise, unswallowed injection point this scenario needs.
  it('CSV: subscriber exceptions never break the writer (swallowed, does not affect result or emission)', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-subscriber-swallow')
    seedBaseline(a.store)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let subscriberCalls = 0
    const unsubscribe = a.store.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        subscriberCalls += 1
        throw new Error('injected subscriber failure')
      }
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))
    unsubscribe()

    expect(subscriberCalls).toBe(1)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', persistence: { status: 'committed' } })
    expect(events).toHaveLength(1)
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('CSV: a throwing PUBLISHED-transition phase observer (state already applied) is recovered as SUCCESS with event count 1', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-applied-exception')
    seedBaseline(a.store)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let observerHits = 0
    a.controls.setPortfolioGenerationPhaseObserver((_origin, phase) => {
      if (phase === 'PUBLISHED') {
        observerHits += 1
        throw new Error('injected phase-observer failure right after state apply')
      }
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(observerHits).toBe(1)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', persistence: { status: 'committed' } })
    expect(a.store.getState().holdings.find(h => h.code === HOLDING.code)?.eval).toBe(444_000)
    expect(events).toHaveLength(1)
    expect(events[0].operation).toBe('importCsv')
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('snapshot: subscriber exceptions never break the writer (swallowed, does not affect result or emission)', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-subscriber-swallow')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let subscriberCalls = 0
    const unsubscribe = a.store.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        subscriberCalls += 1
        throw new Error('injected subscriber failure')
      }
    })

    const raw = buildSnapshotRaw({ code: 'SNAP-SUBSWALLOW', evalValue: 715_000 })
    const result = await a.store.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    expect(subscriberCalls).toBe(1)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('snapshot: a throwing PUBLISHED-transition phase observer (state already applied) is recovered as SUCCESS with event count 1', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snapshot-applied-exception')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let observerHits = 0
    a.controls.setPortfolioGenerationPhaseObserver((_origin, phase) => {
      if (phase === 'PUBLISHED') {
        observerHits += 1
        throw new Error('injected phase-observer failure right after state apply')
      }
    })

    const raw = buildSnapshotRaw({ code: 'SNAP-EXC', evalValue: 720_000 })
    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(observerHits).toBe(1)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.store.getState().holdings.some(h => h.code === 'SNAP-EXC')).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0].operation).toBe('importPortfolioSnapshot')
    errorSpy.mockRestore()
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// CSV no-emission: every failure/rollback/ownership-loss/coordination path commits nothing (or
// rolls back what it committed) and must never emit.
// ─────────────────────────────────────────────────────────────

describe('CSV no-emission paths', () => {
  it('DUPLICATE_CSV emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-dup')
    seedBaseline(a.store)
    const content = csvContent(444_000, '2026-07-22T02:00:00+09:00')
    await expect(a.store.getState().importCsv(new File([content], 'a.csv', { type: 'text/csv' })))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    events.length = 0

    const result = await a.store.getState().importCsv(new File([content], 'a.csv', { type: 'text/csv' }))

    expect(result).toMatchObject({ ok: true, code: 'DUPLICATE_CSV' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('parse failure (NO_VALID_ROWS) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-parse')
    seedBaseline(a.store)

    const result = await a.store.getState().importCsv(new File([''], 'empty.csv', { type: 'text/csv' }))

    expect(result.ok).toBe(false)
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('monotonic stale (STALE_CSV) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-stale')
    seedBaseline(a.store)
    await a.store.getState().importCsv(csvFile(444_000, '2026-07-22T02:00:00+09:00'))
    events.length = 0

    const result = await a.store.getState().importCsv(csvFile(111_000, '2026-07-22T01:00:00+09:00'))

    expect(result).toMatchObject({ ok: false, code: 'STALE_CSV' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('provenance conflict (CSV_PROVENANCE_CONFLICT) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-conflict')
    seedBaseline(a.store)
    await a.store.getState().importCsv(csvFile(444_000, '2026-07-22T02:00:00+09:00'))
    events.length = 0

    const result = await a.store.getState().importCsv(csvFile(999_000, '2026-07-22T02:00:00+09:00'))

    expect(result).toMatchObject({ ok: false, code: 'CSV_PROVENANCE_CONFLICT' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('analysis failure (ANALYSIS_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-analysis')
    seedBaseline(a.store)
    const currentMarket = a.store.getState().market
    a.store.setState({
      market: new Proxy(currentMarket, {
        get(target, property) {
          if (property === 'regime') throw new Error('forced analysis failure')
          return Reflect.get(target, property)
        },
      }),
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('officialDecision failure (OFFICIAL_DECISION_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-official')
    seedBaseline(a.store)
    const currentSafeMode = a.store.getState().safeMode
    a.store.setState({
      safeMode: new Proxy(currentSafeMode, {
        get(target, property) {
          if (property === 'safe_mode') throw new Error('forced official-decision failure')
          return Reflect.get(target, property)
        },
      }),
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'OFFICIAL_DECISION_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('pre-persist fingerprint conflict (canonical changed mid-transaction) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-cas')
    seedBaseline(a.store)
    persistCsvImportTransaction({
      holdings: [{ ...HOLDING }], trust: [{ ...TRUST }], learning: null,
      csvImportedAt: null, provenance: null, syncSummary: null,
      trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY, cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
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

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence error (single write failure) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-perr')
    seedBaseline(a.store)
    failWriteKeys.add(CSV_IMPORT_GENERATION_KEY)

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence indeterminate emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-indet')
    seedBaseline(a.store)
    let armed = false
    setItem.mockImplementation((key: string, value: string) => {
      if (key === CSV_IMPORT_GENERATION_KEY) {
        storage[key] = value
        armed = true
        throw new Error('raw completion notification failure')
      }
      storage[key] = value
    })
    getItem.mockImplementation((key: string) => {
      if (key === CSV_IMPORT_GENERATION_KEY && armed) {
        armed = false
        throw new Error('raw commit-check read failure')
      }
      return storage[key] ?? null
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_INDETERMINATE', persistence: { status: 'indeterminate' } })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('post-persist fingerprint mismatch, rollback success emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-fp-rollback-ok')
    seedBaseline(a.store)
    let fired = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || fired) return
      fired = true
      storage.v95_trust_short_tracker = JSON.stringify({
        entries: [{
          date: '2026-07-22', decision: 'BULL', confidence: 90, executed: true,
          outcome: 'win', nikkeiChgPct: 1, futuresChgPct: 1, conditionsPassed: 5,
          vix: 15, nikkeiVI: 18, volatilitySpread: 0, updatedAt: '2026-07-22T00:00:00.000Z',
        }],
      })
    }

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT', persistence: { status: 'rolled_back' } })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('post-persist fingerprint mismatch, rollback failure emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-fp-rollback-fail')
    seedBaseline(a.store)
    let fired = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || fired) return
      fired = true
      storage.v95_trust_short_tracker = JSON.stringify({
        entries: [{
          date: '2026-07-22', decision: 'BULL', confidence: 90, executed: true,
          outcome: 'win', nikkeiChgPct: 1, futuresChgPct: 1, conditionsPassed: 5,
          vix: 15, nikkeiVI: 18, volatilitySpread: 0, updatedAt: '2026-07-22T00:00:00.000Z',
        }],
      })
      // Both rollback legs (canonical removeItem + tracker removeItem) target a null
      // previousRaw/raw, so making removeItem fail for either key forces rollback_failed.
      failRemoveKeys.add(CSV_IMPORT_GENERATION_KEY)
      failRemoveKeys.add('v95_trust_short_tracker')
    }

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR', persistence: { status: 'rollback_failed' } })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('initial post-commit ownership lost emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-own-initial')
    seedBaseline(a.store)
    const externalRaw = 'external-transaction-bytes-initial'
    let replaced = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || replaced) return
      replaced = true
      storage[key] = externalRaw
    }

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT', persistence: { status: 'ownership_lost' } })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('final pre-publish ownership lost emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-own-final')
    seedBaseline(a.store)
    const externalRaw = 'external-transaction-bytes-final'
    let canonicalWritten = false
    let postCommitReads = 0
    getItem.mockImplementation((key: string) => {
      if (key !== CSV_IMPORT_GENERATION_KEY) return storage[key] ?? null
      if (!canonicalWritten) return storage[key] ?? null
      postCommitReads += 1
      if (postCommitReads === 1) return storage[key] ?? null // initial ownership check: still ours
      return externalRaw // final ownership check: replaced externally
    })
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
    })

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT', persistence: { status: 'ownership_lost' } })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('unexpected exception before apply, rollback success emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-exc-rollback-ok')
    seedBaseline(a.store)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let canonicalWritten = false
    let injected = false
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
    })
    const stateBeforeProxy = a.store.getState()
    a.store.setState(new Proxy(stateBeforeProxy, {
      get(target, property, receiver) {
        if (property === 'holdings' && canonicalWritten && !injected) {
          injected = true
          throw new Error('injected failure after durable commit, before apply')
        }
        return Reflect.get(target, property, receiver)
      },
    }), true)

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(injected).toBe(true)
    expect(result).toMatchObject({ ok: false, persistence: { status: 'rolled_back' } })
    expect(events).toHaveLength(0)
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('unexpected exception before apply, rollback failure emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-exc-rollback-fail')
    seedBaseline(a.store)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let canonicalWritten = false
    let injected = false
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
    })
    const stateBeforeProxy = a.store.getState()
    a.store.setState(new Proxy(stateBeforeProxy, {
      get(target, property, receiver) {
        if (property === 'holdings' && canonicalWritten && !injected) {
          injected = true
          failRemoveKeys.add(CSV_IMPORT_GENERATION_KEY)
          throw new Error('injected failure after durable commit, before apply')
        }
        return Reflect.get(target, property, receiver)
      },
    }), true)

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(injected).toBe(true)
    expect(result).toMatchObject({ ok: false, persistence: { status: 'rollback_failed' } })
    expect(events).toHaveLength(0)
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('coordination failure (LOCAL_OPERATION_BUSY) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-busy')
    seedBaseline(a.store)
    const ticket = a.controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(events).toHaveLength(0)
    if (ticket) a.controls.releasePortfolioOperation(ticket)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Snapshot no-emission: every failure/rollback/ownership-loss/coordination path commits nothing
// (or rolls back what it committed) and must never emit.
// ─────────────────────────────────────────────────────────────

describe('snapshot no-emission paths', () => {
  it('DUPLICATE_SNAPSHOT emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-dup')
    const raw = buildSnapshotRaw({ code: 'SNAP-DUP', evalValue: 300_000 })
    await a.store.getState().importPortfolioSnapshot(raw)
    events.length = 0

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('invalid snapshot (malformed JSON) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-invalid')

    const result = await a.store.getState().importPortfolioSnapshot('not valid json{{{')

    expect(result.ok).toBe(false)
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('provenance rejection (future csvImportedAt) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-future')
    const future = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString()
    const raw = buildSnapshotRaw({
      code: 'SNAP-FUTURE', evalValue: 100_000,
      csvImportedAt: future,
      provenance: provenance('future', future),
    })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('overwrite blocked (unrecognized generation against existing data) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-blocked')
    seedBaseline(a.store)
    // A strictly newer, non-conflicting provenance clears the monotonicity gate, so the
    // rejection under test is specifically the final currentGenerationExists guard, not an
    // earlier provenance-comparison rejection.
    a.store.setState(state => ({
      system: { ...state.system, csvImportProvenance: provenance('blocked-base', '2026-07-22T01:00:00.000Z') },
    }))
    const raw = buildSnapshotRaw({
      code: 'SNAP-BLOCKED', evalValue: 250_000,
      csvImportedAt: '2026-07-22T03:00:00.000Z',
      provenance: provenance('blocked-new', '2026-07-22T03:00:00.000Z'),
    })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('stale (older sourceAsOf than current canonical) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-stale')
    const later = provenance('later', '2026-07-22T02:00:00.000Z')
    a.store.setState(state => ({
      holdings: [{ ...HOLDING }], trust: [{ ...TRUST }],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY }, cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: later.importedAt, csvImportProvenance: later, csvSyncSummary: null },
    }))
    seedAuthoritativeCanonical([{ ...HOLDING }], [{ ...TRUST }], later, later.importedAt)
    const raw = buildSnapshotRaw({
      code: HOLDING.code, evalValue: 111_000,
      csvImportedAt: '2026-07-21T00:00:00.000Z',
      provenance: provenance('earlier', '2026-07-21T00:00:00.000Z'),
    })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_STALE' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('provenance conflict (same sourceAsOf, different content) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-provconflict')
    const baseline = provenance('base', '2026-07-22T02:00:00.000Z')
    a.store.setState(state => ({
      holdings: [{ ...HOLDING }], trust: [{ ...TRUST }],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY }, cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: baseline.importedAt, csvImportProvenance: baseline, csvSyncSummary: null },
    }))
    seedAuthoritativeCanonical([{ ...HOLDING }], [{ ...TRUST }], baseline, baseline.importedAt)
    const raw = buildSnapshotRaw({
      code: HOLDING.code, evalValue: 999_000,
      csvImportedAt: '2026-07-22T02:00:00.000Z',
      provenance: provenance('different', '2026-07-22T02:00:00.000Z'),
    })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_CONFLICT' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('analysis failure (SNAPSHOT_ANALYSIS_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-analysis')
    const currentMarket = a.store.getState().market
    a.store.setState({
      market: new Proxy(currentMarket, {
        get(target, property) {
          if (property === 'regime') throw new Error('forced snapshot analysis failure')
          return Reflect.get(target, property)
        },
      }),
    })
    const raw = buildSnapshotRaw({ code: 'SNAP-ANALYSIS', evalValue: 400_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_ANALYSIS_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('tracker baseline staging failure (SNAPSHOT_ANALYSIS_ERROR) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-tracker')
    trackerStagingProbe.shouldThrow = true
    const raw = buildSnapshotRaw({ code: 'SNAP-TRACKER', evalValue: 410_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_ANALYSIS_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence conflict (CAS mismatch) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-cas')
    persistCsvImportTransaction({
      holdings: [{ ...HOLDING }], trust: [{ ...TRUST }], learning: null,
      csvImportedAt: null, provenance: null, syncSummary: null,
      trustShortSnapshot: { date: '2026-07-22', total: 0, evalById: {} },
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY, cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
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
    const raw = buildSnapshotRaw({ code: 'SNAP-CAS', evalValue: 420_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence error (single write failure) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-perr')
    failWriteKeys.add(CSV_IMPORT_GENERATION_KEY)
    const raw = buildSnapshotRaw({ code: 'SNAP-PERR', evalValue: 430_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PERSISTENCE_ERROR' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('persistence indeterminate emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-indet')
    let armed = false
    setItem.mockImplementation((key: string, value: string) => {
      if (key === CSV_IMPORT_GENERATION_KEY) {
        storage[key] = value
        armed = true
        throw new Error('raw completion notification failure')
      }
      storage[key] = value
    })
    getItem.mockImplementation((key: string) => {
      if (key === CSV_IMPORT_GENERATION_KEY && armed) {
        armed = false
        throw new Error('raw commit-check read failure')
      }
      return storage[key] ?? null
    })
    const raw = buildSnapshotRaw({ code: 'SNAP-INDET', evalValue: 440_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PERSISTENCE_INDETERMINATE', persistence: { status: 'indeterminate' } })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('initial post-commit ownership lost emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-own-initial')
    const externalRaw = 'external-snapshot-bytes-initial'
    let replaced = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || replaced) return
      replaced = true
      storage[key] = externalRaw
    }
    const raw = buildSnapshotRaw({ code: 'SNAP-OWN1', evalValue: 450_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OWNERSHIP_LOST' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('final pre-publish ownership lost emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-own-final')
    const externalRaw = 'external-snapshot-bytes-final'
    let canonicalWritten = false
    let postCommitReads = 0
    getItem.mockImplementation((key: string) => {
      if (key !== CSV_IMPORT_GENERATION_KEY) return storage[key] ?? null
      if (!canonicalWritten) return storage[key] ?? null
      postCommitReads += 1
      if (postCommitReads === 1) return storage[key] ?? null
      return externalRaw
    })
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
    })
    const raw = buildSnapshotRaw({ code: 'SNAP-OWN2', evalValue: 460_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OWNERSHIP_LOST' })
    expect(events).toHaveLength(0)
    a.controls.dispose()
  })

  it('unexpected exception before apply, rollback success emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-exc-rollback-ok')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let canonicalWritten = false
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
    })
    const stateBeforeProxy = a.store.getState()
    // Gated on canonicalWritten so the trap does not fire during the pre-commit alignment read
    // (which also touches `.system`) — only once the durable commit has actually landed, exactly
    // the "committed but not yet applied" window this test targets.
    a.store.setState(new Proxy(stateBeforeProxy, {
      get(target, property, receiver) {
        if (property === 'system' && canonicalWritten) throw new Error('injected failure after commit, before apply')
        return Reflect.get(target, property, receiver)
      },
    }), true)
    const raw = buildSnapshotRaw({ code: 'SNAP-EXCOK', evalValue: 470_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PERSISTENCE_ERROR' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(events).toHaveLength(0)
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('unexpected exception before apply, rollback failure emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-exc-rollback-fail')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let canonicalWritten = false
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
    })
    const stateBeforeProxy = a.store.getState()
    a.store.setState(new Proxy(stateBeforeProxy, {
      get(target, property, receiver) {
        if (property === 'system' && canonicalWritten) {
          failRemoveKeys.add(CSV_IMPORT_GENERATION_KEY)
          throw new Error('injected failure after commit, before apply')
        }
        return Reflect.get(target, property, receiver)
      },
    }), true)
    const raw = buildSnapshotRaw({ code: 'SNAP-EXCFAIL', evalValue: 480_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PERSISTENCE_ERROR' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeTypeOf('string')
    expect(events).toHaveLength(0)
    errorSpy.mockRestore()
    a.controls.dispose()
  })

  it('coordination failure (LOCAL_OPERATION_BUSY) emits 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-busy')
    const ticket = a.controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    const raw = buildSnapshotRaw({ code: 'SNAP-BUSY', evalValue: 490_000 })

    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(events).toHaveLength(0)
    if (ticket) a.controls.releasePortfolioOperation(ticket)
    a.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Transport fail-soft: publish()/backend/sender-id failures never change the writer's durable
// result, never retry, and never leak the raw injected error — for both writers.
// ─────────────────────────────────────────────────────────────

describe('transport fail-soft', () => {
  it('CSV: publish() throw does not affect the durable result or expose the raw error', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const raw = harnessTransport(bcHub, storageHub, 'sender-csv-publish-throw')
    let publishCalls = 0
    const throwingTransport: PortfolioGenerationInvalidationTransport = {
      publish: () => { publishCalls += 1; throw new Error('sentinel: publish threw') },
      subscribe: listener => raw.subscribe(listener),
      dispose: () => raw.dispose(),
    }
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: 'sender-csv-publish-throw', transport: throwingTransport },
    })
    seedBaseline(instance.store)

    const result = await instance.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(publishCalls).toBe(1)
    expect(JSON.stringify(result)).not.toContain('sentinel')
    instance.controls.dispose()
  })

  it('snapshot: publish() throw does not affect the durable result or expose the raw error', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const raw = harnessTransport(bcHub, storageHub, 'sender-snap-publish-throw')
    let publishCalls = 0
    const throwingTransport: PortfolioGenerationInvalidationTransport = {
      publish: () => { publishCalls += 1; throw new Error('sentinel: publish threw') },
      subscribe: listener => raw.subscribe(listener),
      dispose: () => raw.dispose(),
    }
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: 'sender-snap-publish-throw', transport: throwingTransport },
    })

    const snapRaw = buildSnapshotRaw({ code: 'SNAP-PTHROW', evalValue: 500_000 })
    const result = await instance.store.getState().importPortfolioSnapshot(snapRaw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(publishCalls).toBe(1)
    expect(JSON.stringify(result)).not.toContain('sentinel')
    instance.controls.dispose()
  })

  it('CSV: disposed transport does not affect the durable result and delivers nothing', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a } = makeInstance(bcHub, storageHub, 'sender-csv-disposed')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-csv-disposed')
    seedBaseline(a.store)
    a.controls.dispose()

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(b.controls.inspect().pendingInvalidation).toBeNull()
    b.controls.dispose()
  })

  it('snapshot: invalid sender instanceId (empty string) does not affect the durable result', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const transport = harnessTransport(bcHub, storageHub, '')
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: '', transport },
    })

    const snapRaw = buildSnapshotRaw({ code: 'SNAP-EMPTYID', evalValue: 510_000 })
    const result = await instance.store.getState().importPortfolioSnapshot(snapRaw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    instance.controls.dispose()
  })

  it('CSV: BroadcastChannel + storage backend failures do not affect the durable result', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const context = storageHub.createContext()
    storageHub.setSetItemShouldThrow(context.contextId, true)
    const transport = createPortfolioGenerationInvalidationTransport({
      instanceId: 'sender-csv-backend-fail',
      createBroadcastChannel: bcHub.createFactory(),
      storage: context.storage,
      storageEventTarget: context.eventTarget,
    })
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: 'sender-csv-backend-fail', transport },
    })
    seedBaseline(instance.store)
    const bcEvents = bcHub.events.filter(e => e.type === 'constructed')
    const participantId = bcEvents[bcEvents.length - 1]?.participantId
    if (participantId !== undefined) bcHub.setPostMessageShouldThrow(participantId, true)

    const result = await instance.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(JSON.stringify(result)).not.toContain('sentinel')
    instance.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Receiver behavior and multi-tab fan-out: active local operation on the receiving side is
// unaffected; every other participant sees pending exactly once; a disposed participant sees
// nothing.
// ─────────────────────────────────────────────────────────────

describe('receiver and fan-out', () => {
  it('CSV: B mid-operation when A emits — B pending recorded, B ticket/state/subscribers unaffected', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a } = makeInstance(bcHub, storageHub, 'sender-csv-active-receiver')
    const { instance: b } = makeInstance(bcHub, storageHub, 'receiver-csv-active-receiver')
    seedBaseline(a.store)
    seedBaseline(b.store)

    const bTicket = b.controls.acquirePortfolioOperation('manual')
    expect(bTicket).not.toBeNull()
    let bSubscriberCalls = 0
    const bUnsubscribe = b.store.subscribe(() => { bSubscriberCalls += 1 })
    const bStateBefore = b.store.getState()

    const result = await a.store.getState().importCsv(csvFile(444_000))
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })

    const bInspect = b.controls.inspect()
    expect(bInspect.pendingInvalidation?.operation).toBe('importCsv')
    expect(bInspect.activeOperationKind).toBe('manual')
    expect(b.store.getState()).toBe(bStateBefore)
    expect(bSubscriberCalls).toBe(0)
    expect(bInspect.activeGenerationOrigin).toBeNull()

    bUnsubscribe()
    if (bTicket) expect(b.controls.releasePortfolioOperation(bTicket)).toBe(true)
    a.controls.dispose()
    b.controls.dispose()
  })

  it('three-tab fan-out: CSV commit on A reaches B and C exactly once, disposed D gets 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'fanout-csv-a')
    const { instance: b } = makeInstance(bcHub, storageHub, 'fanout-csv-b')
    const { instance: c } = makeInstance(bcHub, storageHub, 'fanout-csv-c')
    const { instance: d } = makeInstance(bcHub, storageHub, 'fanout-csv-d')
    seedBaseline(a.store)
    d.controls.dispose()

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    const bInspect = b.controls.inspect()
    const cInspect = c.controls.inspect()
    expect(bInspect.pendingInvalidation?.operation).toBe('importCsv')
    expect(cInspect.pendingInvalidation?.operation).toBe('importCsv')
    expect(bInspect.invalidationReceiveSequence).toBe(1)
    expect(cInspect.invalidationReceiveSequence).toBe(1)
    expect(d.controls.inspect().pendingInvalidation).toBeNull()
    expect(d.controls.inspect().invalidationReceiveSequence).toBe(0)

    a.controls.dispose()
    b.controls.dispose()
    c.controls.dispose()
  })

  it('three-tab fan-out: snapshot commit on A reaches B and C exactly once, disposed D gets 0', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'fanout-snap-a')
    const { instance: b } = makeInstance(bcHub, storageHub, 'fanout-snap-b')
    const { instance: c } = makeInstance(bcHub, storageHub, 'fanout-snap-c')
    const { instance: d } = makeInstance(bcHub, storageHub, 'fanout-snap-d')
    d.controls.dispose()

    const raw = buildSnapshotRaw({ code: 'SNAP-FANOUT', evalValue: 520_000 })
    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    const bInspect = b.controls.inspect()
    const cInspect = c.controls.inspect()
    expect(bInspect.pendingInvalidation?.operation).toBe('importPortfolioSnapshot')
    expect(cInspect.pendingInvalidation?.operation).toBe('importPortfolioSnapshot')
    expect(bInspect.invalidationReceiveSequence).toBe(1)
    expect(cInspect.invalidationReceiveSequence).toBe(1)
    expect(d.controls.inspect().pendingInvalidation).toBeNull()

    a.controls.dispose()
    b.controls.dispose()
    c.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Regression guards: neither writer double-emits, and the manual-writer emit-boundary contract
// established by RA-008-C1 is unaffected by this change.
// ─────────────────────────────────────────────────────────────

describe('regression guards', () => {
  it('CSV: successful import emits exactly 1, never 2', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-csv-exactly-once')
    seedBaseline(a.store)

    const result = await a.store.getState().importCsv(csvFile(444_000))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events.length).toBe(1)
    a.controls.dispose()
  })

  it('snapshot: successful import emits exactly 1, never 2', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-snap-exactly-once')

    const raw = buildSnapshotRaw({ code: 'SNAP-ONCE', evalValue: 530_000 })
    const result = await a.store.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events.length).toBe(1)
    a.controls.dispose()
  })

  it('manual writer (updateHolding) still emits exactly 1 on a projection-changing commit', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { instance: a, events } = makeInstance(bcHub, storageHub, 'sender-manual-regression')
    seedBaseline(a.store)

    const result = await a.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(events).toHaveLength(1)
    expect(events[0].operation).toBe('updateHolding')
    a.controls.dispose()
  })
})
