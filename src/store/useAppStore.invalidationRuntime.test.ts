import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────
// RA-008-B2: AppStoreRuntime cross-tab invalidation transport integration.
// This suite covers runtime creation/injection, receive-side bookkeeping (local monotonic
// sequence, pending collapse), the "no Zustand/Web Lock/writer side effect" negative contract,
// active-operation coexistence, the (production-unused) clear-watermark test seam, reset/dispose
// lifecycle, cross-instance isolation, the 10-writer no-publish proof, and SSR/default-runtime
// browser-only safety. It intentionally does not exercise writer emission, Zustand pending
// flush, or verified-clear wiring — those remain RA-008-C/D.
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
      throw new Error('invalidation runtime load fixture was not installed')
    },
  }
})

import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import type { Holding, Trust } from '../types'
import {
  DEFAULT_CANDIDATES_NEWS_DATA,
  DEFAULT_CANDIDATES_STOCKS_DATA,
  DEFAULT_REGIME_STATE,
  DEFAULT_SAFE_MODE_SNAPSHOT,
  DEFAULT_TIER_A_ALERTS_SNAPSHOT,
  DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
} from '../services/loadStaticData'
import { CSV_IMPORT_GENERATION_SCHEMA_V5, persistCsvImportTransaction } from './persist'
import type { PortfolioGenerationLockAdapter } from './portfolioGenerationLock'
import {
  createPortfolioGenerationInvalidationEvent,
  createPortfolioGenerationInvalidationTransport,
  type PortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationTransport,
  type PortfolioGenerationInvalidationTransportOptions,
} from './portfolioGenerationInvalidationTransport'
import { FakeBroadcastChannelHub } from './testing/fakeBroadcastChannelHub'
import { FakeStorageEventHub } from './testing/fakeStorageEventHub'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { createAppStoreInstanceForTest } from './useAppStore'

// ── Shared harness helpers ──────────────────────────────────────────────────

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

function withPublishSpy(
  transport: PortfolioGenerationInvalidationTransport,
): { transport: PortfolioGenerationInvalidationTransport; publishCount: () => number } {
  const state = { count: 0 }
  return {
    transport: {
      publish: event => { state.count += 1; transport.publish(event) },
      subscribe: listener => transport.subscribe(listener),
      dispose: () => transport.dispose(),
    },
    publishCount: () => state.count,
  }
}

function createNoopSpyTransport(): {
  transport: PortfolioGenerationInvalidationTransport
  publishCount: () => number
} {
  const state = { count: 0 }
  return {
    transport: {
      publish: () => { state.count += 1 },
      subscribe: () => () => {},
      dispose: () => {},
    },
    publishCount: () => state.count,
  }
}

function createCountingLockAdapter(): {
  adapter: PortfolioGenerationLockAdapter
  callCount: () => number
} {
  const state = { count: 0 }
  return {
    adapter: {
      async runExclusive(_operation, callback) {
        state.count += 1
        return { ok: true, value: await callback() }
      },
    },
    callCount: () => state.count,
  }
}

function createStore(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
  lockAdapter: PortfolioGenerationLockAdapter = createImmediatePortfolioGenerationLockAdapterForTest(),
) {
  const transport = harnessTransport(bcHub, storageHub, instanceId)
  return createAppStoreInstanceForTest({
    portfolioGenerationLock: lockAdapter,
    portfolioGenerationInvalidation: { instanceId, transport },
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

// ─────────────────────────────────────────────────────────────
// Runtime creation
// ─────────────────────────────────────────────────────────────

describe('runtime creation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('holds the injected instanceId', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'injected-instance-id')

    expect(instance.controls.inspect().invalidationInstanceId).toBe('injected-instance-id')
    instance.controls.dispose()
  })

  it('holds the injected transport for delivery without exposing the transport object via inspect', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    const inspected = instance.controls.inspect() as unknown as Record<string, unknown>
    expect(inspected.transport).toBeUndefined()
    expect(Object.keys(inspected)).not.toContain('transport')

    publisher.publish(remoteEvent())
    expect(instance.controls.inspect().pendingInvalidation).not.toBeNull()

    instance.controls.dispose()
    publisher.dispose()
  })

  it('registers exactly one subscription per store on a shared hub backend', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')

    expect(bcHub.participantCount).toBe(1)
    expect(storageHub.listenerCount(1)).toBe(1)
    instance.controls.dispose()
  })

  it('never constructs a real BroadcastChannel for the default test factory', () => {
    let constructed = 0
    class SpyBroadcastChannel {
      constructor(_name: string) { constructed += 1 }
      postMessage(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal('BroadcastChannel', SpyBroadcastChannel)
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('localStorage', undefined)

    const instance = createAppStoreInstanceForTest()

    expect(constructed).toBe(0)
    instance.controls.dispose()
  })

  it('gives two default test stores independent instanceIds', () => {
    const a = createAppStoreInstanceForTest()
    const b = createAppStoreInstanceForTest()

    expect(a.controls.inspect().invalidationInstanceId).not.toBe(b.controls.inspect().invalidationInstanceId)
    a.controls.dispose()
    b.controls.dispose()
  })

  it('gives two stores on a shared hub independent subscriptions', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'a')
    const b = createStore(bcHub, storageHub, 'b')

    expect(bcHub.participantCount).toBe(2)
    a.controls.dispose()
    b.controls.dispose()
  })

  it('never calls transport.publish during runtime creation', () => {
    const { transport, publishCount } = createNoopSpyTransport()
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'spy', transport },
    })

    expect(publishCount()).toBe(0)
    instance.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Receive
// ─────────────────────────────────────────────────────────────

describe('receive', () => {
  it('records a pending invalidation delivered only via the BroadcastChannel channel', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const transport = harnessTransport(bcHub, storageHub, 'a', { storage: null, storageEventTarget: null })
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'a', transport },
    })
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ operation: 'updateHolding' }))

    expect(instance.controls.inspect().pendingInvalidation).toMatchObject({
      senderInstanceId: 'external-tab',
      operation: 'updateHolding',
    })
    instance.controls.dispose()
    publisher.dispose()
  })

  it('records a pending invalidation delivered only via the storage channel', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const transport = harnessTransport(bcHub, storageHub, 'a', { createBroadcastChannel: null })
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'a', transport },
    })
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ operation: 'updateTrust' }))

    expect(instance.controls.inspect().pendingInvalidation).toMatchObject({ operation: 'updateTrust' })
    instance.controls.dispose()
    publisher.dispose()
  })

  it('collapses a dual-channel delivery of the same logical event into a single receive', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'dual-1' }))

    expect(instance.controls.inspect().invalidationReceiveSequence).toBe(1)
    instance.controls.dispose()
    publisher.dispose()
  })

  it('increments the local receive sequence once per new logical event', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'seq-1' }))
    expect(instance.controls.inspect().invalidationReceiveSequence).toBe(1)

    publisher.publish(remoteEvent({ messageId: 'seq-2' }))
    expect(instance.controls.inspect().invalidationReceiveSequence).toBe(2)

    instance.controls.dispose()
    publisher.dispose()
  })

  it('collapses pending to only the most recently received event', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'collapse-1', operation: 'updateHolding' }))
    publisher.publish(remoteEvent({ messageId: 'collapse-2', operation: 'updateTrust' }))

    expect(instance.controls.inspect().pendingInvalidation).toMatchObject({
      messageId: 'collapse-2',
      operation: 'updateTrust',
      receivedSequence: 2,
    })
    instance.controls.dispose()
    publisher.dispose()
  })

  it('uses arrival order rather than committedAt order to decide which event is pending', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'later-committed', committedAt: '2026-07-20T05:00:00.000Z' }))
    publisher.publish(remoteEvent({ messageId: 'earlier-committed', committedAt: '2026-07-20T01:00:00.000Z' }))

    const pending = instance.controls.inspect().pendingInvalidation
    expect(pending?.messageId).toBe('earlier-committed')
    expect(pending?.receivedSequence).toBe(2)
    instance.controls.dispose()
    publisher.dispose()
  })

  it('keeps arrival order as the tiebreaker when committedAt values are identical', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    const sameCommittedAt = '2026-07-20T02:00:00.000Z'

    publisher.publish(remoteEvent({ messageId: 'same-time-1', committedAt: sameCommittedAt }))
    publisher.publish(remoteEvent({ messageId: 'same-time-2', committedAt: sameCommittedAt }))

    expect(instance.controls.inspect().pendingInvalidation?.messageId).toBe('same-time-2')
    instance.controls.dispose()
    publisher.dispose()
  })

  it('carries no portfolio data fields in the pending payload', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ operation: 'updateHolding' }))

    const pending = instance.controls.inspect().pendingInvalidation
    expect(pending && Object.keys(pending).sort()).toEqual(
      ['committedAt', 'messageId', 'operation', 'receivedSequence', 'senderInstanceId'].sort(),
    )
    instance.controls.dispose()
    publisher.dispose()
  })

  it('never calls its own transport.publish in response to a receive', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const raw = harnessTransport(bcHub, storageHub, 'a')
    const { transport, publishCount } = withPublishSpy(raw)
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'a', transport },
    })
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent())

    expect(publishCount()).toBe(0)
    instance.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Zustand warning projection (RA-008-D1)
// ─────────────────────────────────────────────────────────────
// Superseded contract: B2 asserted "idle remote receive touches Zustand not at all." D1 adds a
// display-only projection of runtime pending onto system.crossTabInvalidation, so an idle receive
// now publishes exactly once (system reference only) and notifies subscribers exactly once.
// storage/Web Lock/active-operation independence — and full flush/clear semantics — are covered
// in useAppStore.invalidationWarningState.test.ts; this suite only re-asserts that the B2
// negative contract (no storage write, no Web Lock call, no operation ticket disturbance) still
// holds once that projection exists.

describe('zustand warning projection', () => {
  it('projects an idle remote receive as a system-only warning: one publish, portfolio references unchanged, no storage/lock/operation side effects', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { adapter, callCount } = createCountingLockAdapter()
    const instance = createStore(bcHub, storageHub, 'a', adapter)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    let writes = 0
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { writes += 1 },
      removeItem: () => {},
    })

    const stateBefore = instance.store.getState()
    let notifications = 0
    const unsubscribe = instance.store.subscribe(() => { notifications += 1 })

    publisher.publish(remoteEvent())

    const stateAfter = instance.store.getState()
    expect(stateAfter).not.toBe(stateBefore)
    expect(stateAfter.system).not.toBe(stateBefore.system)
    expect(stateAfter.system.crossTabInvalidation).toEqual({ status: 'stale' })
    expect(stateAfter.holdings).toBe(stateBefore.holdings)
    expect(stateAfter.trust).toBe(stateBefore.trust)
    expect(stateAfter.portfolioPolicy).toBe(stateBefore.portfolioPolicy)
    expect(stateAfter.cashAssumptions).toBe(stateBefore.cashAssumptions)
    expect(stateAfter.analysis).toBe(stateBefore.analysis)
    expect(notifications).toBe(1)
    expect(writes).toBe(0)
    expect(callCount()).toBe(0)
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(instance.controls.inspect().activeGenerationOrigin).toBeNull()
    expect(instance.controls.inspect().pendingInvalidation).not.toBeNull()

    unsubscribe()
    instance.controls.dispose()
    publisher.dispose()
    vi.unstubAllGlobals()
  })
})

// ─────────────────────────────────────────────────────────────
// Active operation
// ─────────────────────────────────────────────────────────────

describe('active operation', () => {
  it('records pending during an active operation without disturbing the ticket, and keeps pending after release', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { adapter, callCount } = createCountingLockAdapter()
    const instance = createStore(bcHub, storageHub, 'a', adapter)
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    const ticket = instance.controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()

    publisher.publish(remoteEvent({ operation: 'setPortfolioPolicy' }))

    expect(instance.controls.inspect().pendingInvalidation).toMatchObject({ operation: 'setPortfolioPolicy' })
    expect(instance.controls.inspect().activeOperationKind).toBe('manual')
    expect(callCount()).toBe(0)

    expect(instance.controls.releasePortfolioOperation(ticket!)).toBe(true)
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(instance.controls.inspect().pendingInvalidation).not.toBeNull()

    instance.controls.dispose()
    publisher.dispose()
  })

  it('does not affect an in-flight writer operation result when a remote event arrives mid-operation', async () => {
    class DeferredFileReader {
      onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
      onerror: (() => void) | null = null
      readAsArrayBuffer(file: File): void {
        file.arrayBuffer()
          .then(result => this.onload?.({ target: { result } }))
          .catch(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', DeferredFileReader)
    const storage: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value },
      removeItem: (key: string) => { delete storage[key] },
    })

    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    let release!: (value: ArrayBuffer) => void
    const csv = [
      'データ基準日時,2026-07-20T02:00:00.000Z',
      '株式（現物/特定預り）',
      '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
      '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
    ].join('\n')
    const file = {
      name: 'pending.csv',
      lastModified: Date.parse('2026-07-20T03:00:00.000Z'),
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const resultPromise = instance.store.getState().importCsv(file)
    await Promise.resolve()
    await Promise.resolve()

    publisher.publish(remoteEvent({ operation: 'importCsv' }))
    expect(instance.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(instance.controls.inspect().activeGenerationOrigin).toBe('csv')

    release(new TextEncoder().encode(csv).buffer)
    const result = await resultPromise

    expect(result.ok).toBe(true)
    expect(instance.controls.inspect().pendingInvalidation).not.toBeNull()

    instance.controls.dispose()
    publisher.dispose()
    vi.unstubAllGlobals()
  })
})

// ─────────────────────────────────────────────────────────────
// Clear watermark (RA-008-D seam; not called from production in B2)
// ─────────────────────────────────────────────────────────────

describe('clear watermark', () => {
  it('clears pending and sets the watermark to the current receive sequence', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'clear-1' }))
    expect(instance.controls.inspect().invalidationReceiveSequence).toBe(1)

    instance.controls.clearPendingInvalidationAfterVerifiedAlignment()

    expect(instance.controls.inspect().pendingInvalidation).toBeNull()
    expect(instance.controls.inspect().invalidationClearWatermark).toBe(1)

    instance.controls.dispose()
    publisher.dispose()
  })

  it('treats a delayed event with an older committedAt arriving after clear as a new pending (fail-closed)', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'recent', committedAt: '2026-07-20T09:00:00.000Z' }))
    instance.controls.clearPendingInvalidationAfterVerifiedAlignment()
    expect(instance.controls.inspect().pendingInvalidation).toBeNull()

    publisher.publish(remoteEvent({ messageId: 'delayed-old', committedAt: '2026-07-19T00:00:00.000Z' }))

    expect(instance.controls.inspect().pendingInvalidation).toMatchObject({ messageId: 'delayed-old' })
    expect(instance.controls.inspect().invalidationReceiveSequence).toBe(2)

    instance.controls.dispose()
    publisher.dispose()
  })

  it('does not clear pending merely from receiving an event, and re-stamps an already-null watermark harmlessly', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const instance = createStore(bcHub, storageHub, 'a')

    instance.controls.clearPendingInvalidationAfterVerifiedAlignment()
    expect(instance.controls.inspect().pendingInvalidation).toBeNull()
    expect(instance.controls.inspect().invalidationClearWatermark).toBe(0)

    instance.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────

describe('reset', () => {
  it('clears pending/sequence/watermark, keeps the subscription alive, and does not affect another store', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'a')
    const b = createStore(bcHub, storageHub, 'b')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    publisher.publish(remoteEvent({ messageId: 'pre-reset' }))
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(b.controls.inspect().pendingInvalidation).not.toBeNull()

    a.controls.reset()

    expect(a.controls.inspect()).toMatchObject({
      pendingInvalidation: null,
      invalidationReceiveSequence: 0,
      invalidationClearWatermark: 0,
      hasInvalidationSubscription: true,
    })
    expect(b.controls.inspect().pendingInvalidation).not.toBeNull()

    publisher.publish(remoteEvent({ messageId: 'post-reset' }))
    expect(a.controls.inspect().pendingInvalidation).toMatchObject({ messageId: 'post-reset' })

    a.controls.dispose()
    b.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Dispose
// ─────────────────────────────────────────────────────────────

describe('dispose', () => {
  it('unsubscribes and disposes the transport exactly once, is idempotent, and stops further delivery', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'a')
    const publisher = harnessTransport(bcHub, storageHub, 'external')
    expect(bcHub.participantCount).toBe(2)

    a.controls.dispose()

    expect(bcHub.participantCount).toBe(1)
    expect(a.controls.inspect()).toMatchObject({
      invalidationDisposed: true,
      hasInvalidationSubscription: false,
      pendingInvalidation: null,
    })

    publisher.publish(remoteEvent({ messageId: 'after-dispose' }))
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    expect(() => a.controls.dispose()).not.toThrow()
    expect(a.controls.inspect().invalidationDisposed).toBe(true)

    a.controls.reset()
    expect(a.controls.inspect().hasInvalidationSubscription).toBe(false)

    publisher.dispose()
  })

  it('does not affect other stores sharing the hub when one store is disposed', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'a')
    const b = createStore(bcHub, storageHub, 'b')
    const publisher = harnessTransport(bcHub, storageHub, 'external')

    a.controls.dispose()
    expect(bcHub.participantCount).toBe(2)

    publisher.publish(remoteEvent())
    expect(b.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    b.controls.dispose()
    publisher.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Instance isolation
// ─────────────────────────────────────────────────────────────

describe('instance isolation', () => {
  it('delivers a B-originated event only to A, and an A-originated event only to B', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'runtime-a')
    const b = createStore(bcHub, storageHub, 'runtime-b')
    // These "as sender" transports simulate the future RA-008-C emission: an event whose
    // senderInstanceId equals B's own instanceId is self-suppressed by B but genuinely
    // remote to A, and vice versa -- proving pending/sequence bookkeeping is per-runtime.
    const bAsSender = harnessTransport(bcHub, storageHub, 'runtime-b')
    const aAsSender = harnessTransport(bcHub, storageHub, 'runtime-a')

    bAsSender.publish(remoteEvent({ senderInstanceId: 'runtime-b', operation: 'updateHolding' }))
    expect(a.controls.inspect().pendingInvalidation).toMatchObject({ operation: 'updateHolding' })
    expect(b.controls.inspect().pendingInvalidation).toBeNull()

    aAsSender.publish(remoteEvent({ senderInstanceId: 'runtime-a', operation: 'updateTrust' }))
    expect(b.controls.inspect().pendingInvalidation).toMatchObject({ operation: 'updateTrust' })
    expect(a.controls.inspect().pendingInvalidation).toMatchObject({ operation: 'updateHolding' })

    a.controls.dispose()
    b.controls.dispose()
    bAsSender.dispose()
    aAsSender.dispose()
  })

  it('keeps clear, reset, and dispose local to the acted-upon instance', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'runtime-a')
    const b = createStore(bcHub, storageHub, 'runtime-b')
    const external = harnessTransport(bcHub, storageHub, 'external')

    external.publish(remoteEvent({ messageId: 'iso-1' }))
    expect(a.controls.inspect().pendingInvalidation).not.toBeNull()
    expect(b.controls.inspect().pendingInvalidation).not.toBeNull()

    a.controls.clearPendingInvalidationAfterVerifiedAlignment()
    expect(a.controls.inspect().pendingInvalidation).toBeNull()
    expect(b.controls.inspect().pendingInvalidation).not.toBeNull()

    external.publish(remoteEvent({ messageId: 'iso-2' }))
    a.controls.reset()
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(0)
    expect(b.controls.inspect().invalidationReceiveSequence).toBe(2)

    a.controls.dispose()
    expect(bcHub.participantCount).toBe(2)
    external.publish(remoteEvent({ messageId: 'iso-3' }))
    expect(b.controls.inspect().invalidationReceiveSequence).toBe(3)
    expect(a.controls.inspect().pendingInvalidation).toBeNull()

    b.controls.dispose()
    external.dispose()
  })

  it('fans out one external event to three stores independently and stops delivering to a disposed one', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const a = createStore(bcHub, storageHub, 'runtime-a')
    const b = createStore(bcHub, storageHub, 'runtime-b')
    const c = createStore(bcHub, storageHub, 'runtime-c')
    const external = harnessTransport(bcHub, storageHub, 'external')

    external.publish(remoteEvent({ messageId: 'fan-1' }))
    for (const store of [a, b, c]) {
      expect(store.controls.inspect().invalidationReceiveSequence).toBe(1)
    }

    c.controls.dispose()
    external.publish(remoteEvent({ messageId: 'fan-2' }))
    expect(a.controls.inspect().invalidationReceiveSequence).toBe(2)
    expect(b.controls.inspect().invalidationReceiveSequence).toBe(2)
    expect(c.controls.inspect().invalidationReceiveSequence).toBe(1)

    a.controls.dispose()
    b.controls.dispose()
    external.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// Negative emission: 10 writers must never call transport.publish in B2
// ─────────────────────────────────────────────────────────────

describe('writer emission (all 10 writers, fixed-harness baseline)', () => {
  const NOW_MS = Date.parse('2026-07-21T03:00:00.000Z')
  const NOW_ISO = new Date(NOW_MS).toISOString()

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

  const storage: Record<string, string> = {}
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
  }

  function publishedData() {
    return {
      market: { data: null, source: 'static' },
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

  function baselineStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
    store.setState(state => ({
      holdings: [{ ...HOLDING }],
      trust: [{ ...TRUST }],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...state.system,
        status: 'idle', error: null, csvLastImportedAt: null,
        csvImportProvenance: null, csvSyncSummary: null,
      },
    }))
  }

  function seedCanonical(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
    const state = store.getState()
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-07-21', total: 0, evalById: {} },
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: 'snapshot',
    }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
  }

  function csvFile(evalValue: number): File {
    const content = [
      'データ基準日時,2026-07-21T02:00:00+09:00',
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

  const WRITER_INVOCATIONS: Record<string, (
    instance: ReturnType<typeof createAppStoreInstanceForTest>,
  ) => Promise<unknown>> = {
    initialize: instance => {
      seedCanonical(instance.store)
      return instance.store.getState().initialize()
    },
    refreshAllData: instance => {
      seedCanonical(instance.store)
      return instance.store.getState().refreshAllData()
    },
    importCsv: instance => instance.store.getState().importCsv(csvFile(444_000)),
    importPortfolioSnapshot: instance => {
      instance.store.setState(state => ({
        holdings: [], trust: [],
        portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
        cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
        system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
      }))
      return instance.store.getState().importPortfolioSnapshot(distinctSnapshotRaw('9101'))
    },
    updateHolding: instance => instance.store.getState().updateHolding(HOLDING.code, { eval: HOLDING.eval + 111 }),
    updateTrust: instance => instance.store.getState().updateTrust(TRUST.id, { eval: TRUST.eval + 111 }),
    setPortfolioPolicy: instance => instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.25 }),
    setCashAssumptions: instance => instance.store.getState().setCashAssumptions({
      grossCash: 4_999_999,
      safetyReserve: 0,
      pendingOrderCash: null,
    }),
    clearCashAssumptionsOverride: instance => instance.store.getState().clearCashAssumptionsOverride(),
    importCashAssumptions: instance => instance.store.getState().importCashAssumptions({
      grossCash: 6_700_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: NOW_ISO,
    }),
  }

  // RA-008-C1 connected initialize/refreshAllData and the 6 manual writers, which emit exactly 1
  // invalidation on a projection-changing commit. RA-008-C2 connects the remaining 2 rollback-aware
  // writers (importCsv/importPortfolioSnapshot), which emit only after their post-commit
  // rollback/ownership window closes and the committed generation is confirmed applied to the
  // local store. This fixed WRITER_INVOCATIONS/baselineStore pair does not change every one of the
  // 10 writers' projections — initialize/refreshAllData here bootstrap/refresh from a canonical
  // that already matches the published baseline (a no-op commit), and clearCashAssumptionsOverride
  // starts from a baseline with no active override (NO_CHANGE) — so each row documents the actual
  // expected count for THIS harness. Full success/no-change/failure emission coverage for all 10
  // target writers lives in useAppStore.invalidationEmissionManualLoad.test.ts (8 non-rollback
  // writers) and useAppStore.invalidationEmissionCsvSnapshot.test.ts (CSV/snapshot).
  const WRITER_EXPECTED_PUBLISH_COUNT: Record<string, number> = {
    initialize: 0,
    refreshAllData: 0,
    importCsv: 1,
    importPortfolioSnapshot: 1,
    updateHolding: 1,
    updateTrust: 1,
    setPortfolioPolicy: 1,
    setCashAssumptions: 1,
    clearCashAssumptionsOverride: 0,
    importCashAssumptions: 1,
  }

  const ALL_WRITERS = Object.keys(WRITER_INVOCATIONS)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    vi.stubGlobal('localStorage', localStorageMock)
    vi.stubGlobal('FileReader', CountingFileReader)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    Object.keys(storage).forEach(key => delete storage[key])
    loadProbe.implementation = async () => publishedData()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    loadProbe.implementation = null
  })

  it.each(ALL_WRITERS)('%s calls transport.publish the expected number of times', async writer => {
    const { transport, publishCount } = createNoopSpyTransport()
    const instance = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
      portfolioGenerationInvalidation: { instanceId: `emission-${writer}`, transport },
    })
    baselineStore(instance.store)

    await WRITER_INVOCATIONS[writer](instance)

    expect(publishCount()).toBe(WRITER_EXPECTED_PUBLISH_COUNT[writer])
    instance.controls.dispose()
  })
})

// ─────────────────────────────────────────────────────────────
// SSR / default runtime safety
// ─────────────────────────────────────────────────────────────

describe('SSR / default runtime safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('imports without throwing and never constructs a real BroadcastChannel when window is absent, even if a Node global BroadcastChannel exists', async () => {
    let constructed = 0
    class NodeGlobalBroadcastChannel {
      constructor(_name: string) { constructed += 1 }
      postMessage(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.resetModules()
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('BroadcastChannel', NodeGlobalBroadcastChannel)
    vi.stubGlobal('localStorage', undefined)

    await expect(import('./useAppStore')).resolves.toBeDefined()
    expect(constructed).toBe(0)
  })

  it('uses the BroadcastChannel factory for the default runtime once window is present', async () => {
    const bcHub = new FakeBroadcastChannelHub()
    const fakeFactory = bcHub.createFactory()
    class BroadcastChannelStub {
      private readonly handle: ReturnType<typeof fakeFactory>
      constructor(channelName: string) {
        this.handle = fakeFactory(channelName)
      }
      postMessage(message: unknown): void { this.handle.postMessage(message) }
      close(): void { this.handle.close() }
      addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void {
        this.handle.addEventListener(type, listener)
      }
      removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void {
        this.handle.removeEventListener(type, listener)
      }
    }
    vi.resetModules()
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('BroadcastChannel', BroadcastChannelStub)
    vi.stubGlobal('localStorage', undefined)

    await import('./useAppStore')

    expect(bcHub.participantCount).toBe(1)
  })

  it('fails soft when the browser BroadcastChannel constructor throws during default runtime creation', async () => {
    class ThrowingBroadcastChannel {
      constructor(_name: string) { throw new Error('constructor boom') }
      postMessage(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.resetModules()
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('BroadcastChannel', ThrowingBroadcastChannel)
    vi.stubGlobal('localStorage', undefined)

    await expect(import('./useAppStore')).resolves.toBeDefined()
  })
})
