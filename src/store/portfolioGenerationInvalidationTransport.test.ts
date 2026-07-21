import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createBrowserPortfolioGenerationInvalidationTransport,
  createPortfolioGenerationInstanceId,
  createPortfolioGenerationInvalidationEvent,
  createPortfolioGenerationInvalidationTransport,
  createPortfolioGenerationMessageId,
  parsePortfolioGenerationInvalidationEvent,
  PORTFOLIO_GENERATION_INVALIDATION_CHANNEL,
  PORTFOLIO_GENERATION_INVALIDATION_PROTOCOL_VERSION,
  PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY,
  PORTFOLIO_GENERATION_OPERATIONS,
  type PortfolioGenerationInvalidationBroadcastChannelLike,
  type PortfolioGenerationInvalidationDiagnosticCode,
  type PortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationStorageEventTarget,
  type PortfolioGenerationInvalidationTransportOptions,
} from './portfolioGenerationInvalidationTransport'
import type { PortfolioGenerationOperation } from './portfolioOperationResult'
import { FakeBroadcastChannelHub } from './testing/fakeBroadcastChannelHub'
import { FakeStorageEventHub } from './testing/fakeStorageEventHub'

const BASE_COMMITTED_AT = '2026-07-21T00:00:00.000Z'

function validEvent(
  overrides: Partial<PortfolioGenerationInvalidationEvent> = {},
): PortfolioGenerationInvalidationEvent {
  return {
    protocolVersion: 1,
    messageId: 'message-1',
    senderInstanceId: 'sender-a',
    committedAt: BASE_COMMITTED_AT,
    operation: 'initialize',
    ...overrides,
  }
}

function harness(
  bcHub: FakeBroadcastChannelHub,
  storageHub: FakeStorageEventHub,
  instanceId: string,
  overrides: Partial<PortfolioGenerationInvalidationTransportOptions> = {},
) {
  const storageContext = storageHub.createContext()
  const transport = createPortfolioGenerationInvalidationTransport({
    instanceId,
    createBroadcastChannel: bcHub.createFactory(),
    storage: storageContext.storage,
    storageEventTarget: storageContext.eventTarget,
    ...overrides,
  })
  return { transport, storageContext }
}

function withThrowingClose(
  handle: PortfolioGenerationInvalidationBroadcastChannelLike,
): PortfolioGenerationInvalidationBroadcastChannelLike {
  return {
    ...handle,
    close() {
      throw new Error('close failure')
    },
  }
}

function withThrowingRemoveEventListener(
  target: PortfolioGenerationInvalidationStorageEventTarget,
): PortfolioGenerationInvalidationStorageEventTarget {
  return {
    ...target,
    removeEventListener() {
      throw new Error('removeEventListener failure')
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Constants and schema
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('exposes the exact protocol version', () => {
    expect(PORTFOLIO_GENERATION_INVALIDATION_PROTOCOL_VERSION).toBe(1)
  })

  it('exposes the exact channel name', () => {
    expect(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL).toBe(
      'jp-portfolio:portfolio-generation-events:v1',
    )
  })

  it('exposes the exact storage key', () => {
    expect(PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY).toBe(
      'jp-portfolio:portfolio-generation-event:v1',
    )
  })

  it('keeps the runtime operation list in sync with the PortfolioGenerationOperation type', () => {
    const expectedOperations: PortfolioGenerationOperation[] = [
      'initialize',
      'refreshAllData',
      'importCsv',
      'importPortfolioSnapshot',
      'updateHolding',
      'updateTrust',
      'setPortfolioPolicy',
      'setCashAssumptions',
      'clearCashAssumptionsOverride',
      'importCashAssumptions',
    ]
    expect([...PORTFOLIO_GENERATION_OPERATIONS].sort()).toEqual([...expectedOperations].sort())
    expectTypeOf<PortfolioGenerationOperation>().toEqualTypeOf<typeof expectedOperations[number]>()
  })
})

describe('parsePortfolioGenerationInvalidationEvent', () => {
  it('accepts a well-formed event', () => {
    const event = validEvent()
    expect(parsePortfolioGenerationInvalidationEvent(event)).toEqual(event)
  })

  it('rejects an event with a portfolio-data field bolted on, even when otherwise valid', () => {
    const withHoldings = { ...validEvent(), holdings: [{ code: '1234', qty: 100 }] }
    expect(parsePortfolioGenerationInvalidationEvent(withHoldings)).toBeNull()
  })

  const rejectionCases: Array<[string, unknown]> = [
    ['missing field', (() => {
      const event = validEvent() as unknown as Record<string, unknown>
      delete event.operation
      return event
    })()],
    ['extra field', { ...validEvent(), extraField: 'nope' }],
    ['wrong protocol version', { ...validEvent(), protocolVersion: 2 }],
    ['stringified protocol version', { ...validEvent(), protocolVersion: '1' }],
    ['unknown operation', { ...validEvent(), operation: 'deleteEverything' }],
    ['empty messageId', { ...validEvent(), messageId: '' }],
    ['oversized messageId', { ...validEvent(), messageId: 'x'.repeat(129) }],
    ['empty senderInstanceId', { ...validEvent(), senderInstanceId: '' }],
    ['oversized senderInstanceId', { ...validEvent(), senderInstanceId: 'x'.repeat(129) }],
    ['non-string committedAt', { ...validEvent(), committedAt: 12345 }],
    ['non-ISO committedAt', { ...validEvent(), committedAt: 'not-a-date' }],
    ['non-canonical ISO committedAt (missing milliseconds)', {
      ...validEvent(),
      committedAt: '2026-07-21T00:00:00Z',
    }],
    ['non-canonical ISO committedAt (timezone offset)', {
      ...validEvent(),
      committedAt: '2026-07-21T09:00:00+09:00',
    }],
    ['array input', [validEvent()]],
    ['null input', null],
    ['string input', 'not an object'],
    ['number input', 42],
  ]

  it.each(rejectionCases)('rejects: %s', (_label, input) => {
    expect(parsePortfolioGenerationInvalidationEvent(input)).toBeNull()
  })

  it('rejects a committedAt far enough in the future to exceed the allowed skew', () => {
    const nowMs = Date.parse(BASE_COMMITTED_AT)
    const tooFarFuture = new Date(nowMs + 10 * 60 * 1000).toISOString()
    expect(
      parsePortfolioGenerationInvalidationEvent(validEvent({ committedAt: tooFarFuture }), { nowMs }),
    ).toBeNull()
  })

  it('accepts a committedAt within the allowed future skew', () => {
    const nowMs = Date.parse(BASE_COMMITTED_AT)
    const withinSkew = new Date(nowMs + 4 * 60 * 1000).toISOString()
    expect(
      parsePortfolioGenerationInvalidationEvent(validEvent({ committedAt: withinSkew }), { nowMs }),
    ).not.toBeNull()
  })

  it('does not throw and rejects payloads whose property getters throw', () => {
    const malicious: Record<string, unknown> = {}
    for (const key of ['protocolVersion', 'messageId', 'senderInstanceId', 'committedAt', 'operation']) {
      Object.defineProperty(malicious, key, {
        enumerable: true,
        get(): never {
          throw new Error(`getter boom: ${key}`)
        },
      })
    }
    expect(() => parsePortfolioGenerationInvalidationEvent(malicious)).not.toThrow()
    expect(parsePortfolioGenerationInvalidationEvent(malicious)).toBeNull()
  })

  it('rejects a __proto__ prototype-pollution payload without throwing or polluting Object.prototype', () => {
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"messageId":"m","senderInstanceId":"s",'
        + '"committedAt":"2026-07-21T00:00:00.000Z","operation":"initialize"}',
    )
    expect(() => parsePortfolioGenerationInvalidationEvent(malicious)).not.toThrow()
    expect(parsePortfolioGenerationInvalidationEvent(malicious)).toBeNull()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('never throws regardless of exotic input shapes', () => {
    const inputs: unknown[] = [undefined, true, Symbol('x'), () => {}, new Map(), new Date(), new Proxy({}, {
      ownKeys() {
        throw new Error('ownKeys boom')
      },
    })]
    for (const input of inputs) {
      expect(() => parsePortfolioGenerationInvalidationEvent(input)).not.toThrow()
    }
  })

  it('rejects a storage-sourced event once the serialized size clearly exceeds the byte limit', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'receiver', { createBroadcastChannel: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transport.subscribe(event => received.push(event))

    const oversized = `{"padding":"${'x'.repeat(2000)}"}`
    storageHub.injectRaw(PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY, oversized)

    expect(received).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Identity and event creation helpers
// ---------------------------------------------------------------------------

describe('identity helpers', () => {
  it('creates non-empty instance and message ids', () => {
    expect(createPortfolioGenerationInstanceId().length).toBeGreaterThan(0)
    expect(createPortfolioGenerationMessageId().length).toBeGreaterThan(0)
  })

  it('produces two distinct real ids across separate calls', () => {
    expect(createPortfolioGenerationInstanceId()).not.toBe(createPortfolioGenerationInstanceId())
  })

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid-value' })
    expect(createPortfolioGenerationInstanceId()).toBe('fixed-uuid-value')
    expect(createPortfolioGenerationMessageId()).toBe('fixed-uuid-value')
  })

  it('falls back to a non-empty synthetic id when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    const id = createPortfolioGenerationInstanceId()
    expect(id.length).toBeGreaterThan(0)
    expect(id).toMatch(/^instance-fb-\d+-[a-z0-9]+$/)
  })

  it('falls back to a non-empty synthetic id when crypto.randomUUID throws', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('randomUUID boom')
      },
    })
    const id = createPortfolioGenerationMessageId()
    expect(id).toMatch(/^message-fb-\d+-[a-z0-9]+$/)
  })

  it('produces distinct fallback ids across repeated calls', () => {
    vi.stubGlobal('crypto', undefined)
    const first = createPortfolioGenerationInstanceId()
    const second = createPortfolioGenerationInstanceId()
    expect(first).not.toBe(second)
  })

  it('does not embed obviously sensitive substrings in generated ids', () => {
    vi.stubGlobal('crypto', undefined)
    const id = createPortfolioGenerationInstanceId()
    for (const forbidden of ['holdings', 'trust', 'cash', 'csv', 'snapshot', 'policy']) {
      expect(id.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('produces an event via the helper that passes the validator', () => {
    const created = createPortfolioGenerationInvalidationEvent({
      senderInstanceId: createPortfolioGenerationInstanceId(),
      operation: 'updateHolding',
    })
    expect(parsePortfolioGenerationInvalidationEvent(created)).toEqual(created)
  })

  it('produces a canonical ISO committedAt by default', () => {
    const created = createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'sender-x',
      operation: 'updateTrust',
    })
    expect(new Date(created.committedAt).toISOString()).toBe(created.committedAt)
  })
})

// ---------------------------------------------------------------------------
// Broadcast delivery
// ---------------------------------------------------------------------------

describe('BroadcastChannel-only delivery', () => {
  it('delivers a published event from A to B', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'refreshAllData',
    }))

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ operation: 'refreshAllData', senderInstanceId: 'tab-a' })
  })

  it('does not deliver a self-published event back to the publisher', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transport.subscribe(event => received.push(event))

    transport.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'initialize',
    }))

    expect(received).toHaveLength(0)
  })

  it('does not deliver across different channel names', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportC } = harness(bcHub, storageHub, 'tab-c', {
      storage: null,
      channelName: 'jp-portfolio:other-channel:v1',
    })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportC.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'initialize',
    }))

    expect(received).toHaveLength(0)
  })

  it('notifies multiple subscribers in registration order', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const callOrder: string[] = []
    transportB.subscribe(() => callOrder.push('first'))
    transportB.subscribe(() => callOrder.push('second'))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'initialize',
    }))

    expect(callOrder).toEqual(['first', 'second'])
  })

  it('stops notifying a listener after it unsubscribes', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    const unsubscribe = transportB.subscribe(event => received.push(event))
    unsubscribe()

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'initialize',
    }))

    expect(received).toHaveLength(0)
  })

  it('treats duplicate registrations of the same listener as independent subscriptions', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    let callCount = 0
    const listener = () => { callCount += 1 }
    const unsubscribeFirst = transportB.subscribe(listener)
    transportB.subscribe(listener)

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize', messageId: 'dup-listener-1',
    }))
    expect(callCount).toBe(2)

    unsubscribeFirst()
    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize', messageId: 'dup-listener-2',
    }))
    expect(callCount).toBe(3)
  })

  it('ignores a malformed broadcast payload without delivering it', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    const rawSender = bcHub.createFactory()(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    rawSender.postMessage({ garbage: true })

    expect(received).toHaveLength(0)
  })

  it('ignores an unknown protocol version broadcast', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    const rawSender = bcHub.createFactory()(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    rawSender.postMessage({ ...validEvent(), protocolVersion: 2 })

    expect(received).toHaveLength(0)
  })

  it('continues notifying later listeners after an earlier one throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    let secondCalled = false
    transportB.subscribe(() => {
      throw new Error('first listener boom')
    })
    transportB.subscribe(() => {
      secondCalled = true
    })

    expect(() => transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'initialize',
    }))).not.toThrow()

    expect(secondCalled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Storage delivery
// ---------------------------------------------------------------------------

describe('storage-only delivery', () => {
  it('delivers a published event from A to B via the storage marker', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { createBroadcastChannel: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'importCsv',
    }))

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ operation: 'importCsv', senderInstanceId: 'tab-a' })
  })

  it('does not deliver a self-written storage marker back to the writer', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-a', { createBroadcastChannel: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transport.subscribe(event => received.push(event))

    transport.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'initialize',
    }))

    expect(received).toHaveLength(0)
  })

  it('ignores a storage event for a different key', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    storageHub.injectRaw('some-other-key', JSON.stringify(validEvent()))

    expect(received).toHaveLength(0)
  })

  it('ignores a storage event with a null newValue', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    storageHub.injectRaw(PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY, null)

    expect(received).toHaveLength(0)
  })

  it('ignores a storage event whose newValue is malformed JSON', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    storageHub.injectRaw(PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY, '{not json')

    expect(received).toHaveLength(0)
  })

  it('ignores a storage event whose newValue is syntactically valid JSON but the wrong shape', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    storageHub.injectRaw(
      PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY,
      JSON.stringify({ foo: 'bar' }),
    )

    expect(received).toHaveLength(0)
  })

  it('does not deliver twice when the marker is overwritten before the previous value is read', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { createBroadcastChannel: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize', messageId: 'marker-1',
    }))
    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'refreshAllData', messageId: 'marker-2',
    }))

    expect(received).toHaveLength(2)
    expect(received.map(event => event.messageId)).toEqual(['marker-1', 'marker-2'])
  })

  it('does not emit a second storage event when the marker is later removed', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: unknown[] = []
    transport.subscribe(event => received.push(event))

    expect(storageHub.events.some(event => event.type === 'remove')).toBe(false)
  })

  it('stops delivering to a context after removeEventListener is called via unsubscribe/dispose', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport, storageContext } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    transport.subscribe(() => {})
    expect(storageHub.listenerCount(storageContext.contextId)).toBe(1)

    transport.dispose()
    expect(storageHub.listenerCount(storageContext.contextId)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Option B dual publish
// ---------------------------------------------------------------------------

describe('dual publish (Option B)', () => {
  it('publishes the same logical event to both BroadcastChannel and storage', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'setPortfolioPolicy',
    }))

    expect(bcHub.events.some(event => event.type === 'posted')).toBe(true)
    expect(storageHub.events.some(event => event.type === 'set')).toBe(true)
  })

  it('delivers exactly once to B even though both transports are wired', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'setCashAssumptions',
      messageId: 'dual-1',
    }))

    expect(received).toHaveLength(1)
  })

  it('deduplicates when the storage marker arrives before a deferred BroadcastChannel delivery', () => {
    const bcHub = new FakeBroadcastChannelHub()
    bcHub.setSynchronousDelivery(false)
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a',
      operation: 'importCsv',
      messageId: 'ordering-1',
    }))

    expect(received).toHaveLength(1)
    expect(bcHub.pendingDeliveryCount).toBe(1)

    bcHub.flush()
    expect(received).toHaveLength(1)
  })

  it('ignores a second delivery with the same message id even when payload fields differ', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'receiver', { storage: null })
    const rawSender = bcHub.createFactory()(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const received: PortfolioGenerationInvalidationEvent[] = []
    transport.subscribe(event => received.push(event))

    rawSender.postMessage(validEvent({ messageId: 'dup-payload-1', operation: 'initialize' }))
    rawSender.postMessage(validEvent({ messageId: 'dup-payload-1', operation: 'refreshAllData' }))

    expect(received).toHaveLength(1)
    expect(received[0].operation).toBe('initialize')
  })

  it('delivers both when message ids differ', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'receiver', { storage: null })
    const rawSender = bcHub.createFactory()(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const received: PortfolioGenerationInvalidationEvent[] = []
    transport.subscribe(event => received.push(event))

    rawSender.postMessage(validEvent({ messageId: 'distinct-1' }))
    rawSender.postMessage(validEvent({ messageId: 'distinct-2' }))

    expect(received).toHaveLength(2)
  })

  it('holds at most 32 recent message ids and evicts the oldest (FIFO) beyond that', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'receiver', { storage: null })
    const rawSender = bcHub.createFactory()(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const received: string[] = []
    transport.subscribe(event => received.push(event.messageId))

    for (let index = 1; index <= 32; index += 1) {
      rawSender.postMessage(validEvent({ messageId: `m-${index}` }))
    }
    expect(received).toHaveLength(32)

    rawSender.postMessage(validEvent({ messageId: 'm-1' }))
    expect(received).toHaveLength(32)

    rawSender.postMessage(validEvent({ messageId: 'm-33' }))
    expect(received).toHaveLength(33)

    rawSender.postMessage(validEvent({ messageId: 'm-1' }))
    expect(received).toHaveLength(34)
    expect(received.filter(id => id === 'm-1')).toHaveLength(2)
  })

  it('does not consume the dedupe cache for malformed or self-originated events', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'receiver', { storage: null })
    const rawSender = bcHub.createFactory()(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const received: PortfolioGenerationInvalidationEvent[] = []
    transport.subscribe(event => received.push(event))

    rawSender.postMessage({ ...validEvent({ messageId: 'shared-id' }), operation: 'not-an-operation' })
    expect(received).toHaveLength(0)

    rawSender.postMessage(validEvent({ messageId: 'shared-id', senderInstanceId: 'receiver' }))
    expect(received).toHaveLength(0)

    rawSender.postMessage(validEvent({ messageId: 'shared-id' }))
    expect(received).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Fail-soft
// ---------------------------------------------------------------------------

describe('fail-soft behavior', () => {
  it('falls back to storage delivery when BroadcastChannel is unsupported', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { createBroadcastChannel: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { createBroadcastChannel: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))

    expect(received).toHaveLength(1)
  })

  it('falls back to BroadcastChannel delivery when storage is unavailable', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))

    expect(received).toHaveLength(1)
  })

  it('still delivers via storage when the BroadcastChannel constructor throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    bcHub.failNextConstruction(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    expect(() => transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))).not.toThrow()

    expect(received).toHaveLength(1)
  })

  it('still attempts storage delivery when BroadcastChannel.postMessage throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    let capturedParticipantId: number | null = null
    const trackingFactory = (channelName: string) => {
      const handle = bcHub.createFactory()(channelName)
      capturedParticipantId = (handle as unknown as { participantId: number }).participantId
      return handle
    }
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', {
      createBroadcastChannel: trackingFactory,
    })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    bcHub.setPostMessageShouldThrow(capturedParticipantId as unknown as number, true)

    expect(() => transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))).not.toThrow()

    expect(received).toHaveLength(1)
  })

  it('preserves the BroadcastChannel result when storage.setItem throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA, storageContext } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    storageHub.setSetItemShouldThrow(storageContext.contextId, true)

    expect(() => transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))).not.toThrow()

    expect(received).toHaveLength(1)
  })

  it('never throws from publish even when both channels fail', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    let capturedParticipantId: number | null = null
    const trackingFactory = (channelName: string) => {
      const handle = bcHub.createFactory()(channelName)
      capturedParticipantId = (handle as unknown as { participantId: number }).participantId
      return handle
    }
    const { transport: transportA, storageContext } = harness(bcHub, storageHub, 'tab-a', {
      createBroadcastChannel: trackingFactory,
    })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => received.push(event))

    bcHub.setPostMessageShouldThrow(capturedParticipantId as unknown as number, true)
    storageHub.setSetItemShouldThrow(storageContext.contextId, true)

    expect(() => transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))).not.toThrow()

    expect(received).toHaveLength(0)
  })

  it('never throws from publish when the diagnostic sink itself throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    bcHub.failNextConstruction(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const storageHub = new FakeStorageEventHub()
    const throwingSink = {
      report: (_code: PortfolioGenerationInvalidationDiagnosticCode) => {
        throw new Error('diagnostic sink boom')
      },
    }
    const { transport } = harness(bcHub, storageHub, 'tab-a', { diagnosticSink: throwingSink })

    expect(() => transport.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))).not.toThrow()
  })

  it('never throws from publish when a subscribed listener throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    transportB.subscribe(() => {
      throw new Error('listener boom')
    })

    expect(() => transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))).not.toThrow()
  })

  it('does not throw and does not deliver an invalid outbound event', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: unknown[] = []
    transportB.subscribe(event => received.push(event))

    const invalid = { ...validEvent(), operation: 'not-a-real-operation' } as unknown as PortfolioGenerationInvalidationEvent

    expect(() => transportA.publish(invalid)).not.toThrow()
    expect(received).toHaveLength(0)
    expect(bcHub.events.some(event => event.type === 'posted')).toBe(false)
    expect(storageHub.events.some(event => event.type === 'set')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe('dispose lifecycle', () => {
  it('closes the BroadcastChannel', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-a')

    transport.dispose()

    expect(bcHub.events.some(event => event.type === 'closed')).toBe(true)
  })

  it('removes the storage listener', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport, storageContext } = harness(bcHub, storageHub, 'tab-a')

    expect(storageHub.listenerCount(storageContext.contextId)).toBe(1)
    transport.dispose()
    expect(storageHub.listenerCount(storageContext.contextId)).toBe(0)
  })

  it('is idempotent: a second dispose call has no additional effect', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-a')

    transport.dispose()
    expect(() => transport.dispose()).not.toThrow()

    const closedEvents = bcHub.events.filter(event => event.type === 'closed')
    expect(closedEvents).toHaveLength(1)
  })

  it('prevents further publishing after dispose', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport } = harness(bcHub, storageHub, 'tab-a')
    transport.dispose()

    const eventCountBefore = bcHub.events.length + storageHub.events.length
    transport.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))
    const eventCountAfter = bcHub.events.length + storageHub.events.length

    expect(eventCountAfter).toBe(eventCountBefore)
  })

  it('prevents further receiving after dispose', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const received: unknown[] = []
    transportB.subscribe(event => received.push(event))
    transportB.dispose()

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))

    expect(received).toHaveLength(0)
  })

  it('returns a no-op unsubscribe when subscribing after dispose', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    transportB.dispose()

    const received: unknown[] = []
    const unsubscribe = transportB.subscribe(event => received.push(event))
    expect(() => unsubscribe()).not.toThrow()

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize',
    }))
    expect(received).toHaveLength(0)
  })

  it('does not throw when BroadcastChannel.close throws during dispose', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const storageContext = storageHub.createContext()
    const transport = createPortfolioGenerationInvalidationTransport({
      instanceId: 'tab-a',
      createBroadcastChannel: name => withThrowingClose(bcHub.createFactory()(name)),
      storage: storageContext.storage,
      storageEventTarget: storageContext.eventTarget,
    })

    expect(() => transport.dispose()).not.toThrow()
  })

  it('does not throw when storageEventTarget.removeEventListener throws during dispose', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const storageContext = storageHub.createContext()
    const transport = createPortfolioGenerationInvalidationTransport({
      instanceId: 'tab-a',
      createBroadcastChannel: bcHub.createFactory(),
      storage: storageContext.storage,
      storageEventTarget: withThrowingRemoveEventListener(storageContext.eventTarget),
    })

    expect(() => transport.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Instance separation
// ---------------------------------------------------------------------------

describe('instance separation', () => {
  it('disposing one instance does not affect another sharing the same hub backend', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b')
    const { transport: transportC } = harness(bcHub, storageHub, 'tab-c')
    const received: unknown[] = []
    transportC.subscribe(event => received.push(event))

    transportA.dispose()

    transportB.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-b', operation: 'initialize',
    }))

    expect(received).toHaveLength(1)
  })

  it('keeps dedupe caches independent across instances sharing the same hub backend', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    const { transport: transportB } = harness(bcHub, storageHub, 'tab-b', { storage: null })
    const { transport: transportC } = harness(bcHub, storageHub, 'tab-c', { storage: null })
    const receivedB: PortfolioGenerationInvalidationEvent[] = []
    const receivedC: PortfolioGenerationInvalidationEvent[] = []
    transportB.subscribe(event => receivedB.push(event))
    transportC.subscribe(event => receivedC.push(event))

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize', messageId: 'shared-across-instances',
    }))
    expect(receivedB).toHaveLength(1)
    expect(receivedC).toHaveLength(1)

    transportA.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'tab-a', operation: 'initialize', messageId: 'shared-across-instances',
    }))
    expect(receivedB).toHaveLength(1)
    expect(receivedC).toHaveLength(1)
  })

  it('does not share subscribers across instances backed by the same hub', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: transportA } = harness(bcHub, storageHub, 'tab-a', { storage: null })
    harness(bcHub, storageHub, 'tab-b', { storage: null })
    const receivedA: unknown[] = []
    transportA.subscribe(event => receivedA.push(event))

    expect(receivedA).toHaveLength(0)
  })

  it('fans out to three participants and stops delivering to a disposed third participant', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const { transport: publisher } = harness(bcHub, storageHub, 'publisher')
    const { transport: subscriberA } = harness(bcHub, storageHub, 'tab-a')
    const { transport: subscriberB } = harness(bcHub, storageHub, 'tab-b')
    const { transport: subscriberC } = harness(bcHub, storageHub, 'tab-c')
    const receivedA: PortfolioGenerationInvalidationEvent[] = []
    const receivedB: PortfolioGenerationInvalidationEvent[] = []
    const receivedC: PortfolioGenerationInvalidationEvent[] = []
    subscriberA.subscribe(event => receivedA.push(event))
    subscriberB.subscribe(event => receivedB.push(event))
    subscriberC.subscribe(event => receivedC.push(event))

    publisher.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'publisher', operation: 'initialize', messageId: 'fanout-1',
    }))
    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(1)
    expect(receivedC).toHaveLength(1)

    subscriberC.dispose()

    publisher.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'publisher', operation: 'refreshAllData', messageId: 'fanout-2',
    }))
    expect(receivedA).toHaveLength(2)
    expect(receivedB).toHaveLength(2)
    expect(receivedC).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Browser capability behavior
// ---------------------------------------------------------------------------

describe('browser capability handling', () => {
  it('does not throw when BroadcastChannel, localStorage, and window are all absent', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('window', undefined)

    expect(() =>
      createBrowserPortfolioGenerationInvalidationTransport({ instanceId: 'a' }),
    ).not.toThrow()
  })

  it('behaves as a working no-op transport when both channels are unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('window', undefined)

    const transport = createBrowserPortfolioGenerationInvalidationTransport({ instanceId: 'a' })
    const received: unknown[] = []
    const unsubscribe = transport.subscribe(event => received.push(event))

    expect(() => transport.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'a', operation: 'initialize',
    }))).not.toThrow()
    expect(received).toHaveLength(0)
    expect(() => unsubscribe()).not.toThrow()
    expect(() => transport.dispose()).not.toThrow()
  })

  it('does not throw when BroadcastChannel is absent but storage is present', () => {
    const storageHub = new FakeStorageEventHub()
    const context = storageHub.createContext()

    expect(() =>
      createPortfolioGenerationInvalidationTransport({
        instanceId: 'a',
        createBroadcastChannel: null,
        storage: context.storage,
        storageEventTarget: context.eventTarget,
      }),
    ).not.toThrow()
  })

  it('does not throw when BroadcastChannel is present but storage is absent', () => {
    const bcHub = new FakeBroadcastChannelHub()

    expect(() =>
      createPortfolioGenerationInvalidationTransport({
        instanceId: 'a',
        createBroadcastChannel: bcHub.createFactory(),
        storage: null,
        storageEventTarget: null,
      }),
    ).not.toThrow()
  })

  it('does not throw when the BroadcastChannel constructor throws', () => {
    const bcHub = new FakeBroadcastChannelHub()
    bcHub.failNextConstruction(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)

    expect(() =>
      createPortfolioGenerationInvalidationTransport({
        instanceId: 'a',
        createBroadcastChannel: bcHub.createFactory(),
        storage: null,
        storageEventTarget: null,
      }),
    ).not.toThrow()
  })

  it('does not throw when the localStorage getter throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get(): never {
        throw new Error('localStorage boom')
      },
    })
    try {
      expect(() =>
        createPortfolioGenerationInvalidationTransport({
          instanceId: 'a',
          createBroadcastChannel: null,
        }),
      ).not.toThrow()
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('does not throw when window.addEventListener throws', () => {
    vi.stubGlobal('window', {
      addEventListener() {
        throw new Error('addEventListener boom')
      },
      removeEventListener() {},
    })

    expect(() =>
      createPortfolioGenerationInvalidationTransport({
        instanceId: 'a',
        createBroadcastChannel: null,
      }),
    ).not.toThrow()
  })

  it('never constructs a Node global BroadcastChannel from the browser factory when window is absent', () => {
    let constructed = 0
    class NodeGlobalBroadcastChannel {
      constructor(_name: string) { constructed += 1 }
      postMessage(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal('BroadcastChannel', NodeGlobalBroadcastChannel)
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('localStorage', undefined)

    const transport = createBrowserPortfolioGenerationInvalidationTransport({ instanceId: 'node-a' })
    expect(constructed).toBe(0)

    const received: unknown[] = []
    transport.subscribe(event => received.push(event))
    expect(() => transport.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'node-a', operation: 'initialize',
    }))).not.toThrow()
    expect(received).toHaveLength(0)
    expect(constructed).toBe(0)
    expect(() => transport.dispose()).not.toThrow()
  })

  it('uses the BroadcastChannel backend from the browser factory once window is present', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const fakeFactory = bcHub.createFactory()
    class BroadcastChannelStub {
      private readonly handle: PortfolioGenerationInvalidationBroadcastChannelLike
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
    vi.stubGlobal('BroadcastChannel', BroadcastChannelStub)
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
    })
    vi.stubGlobal('localStorage', undefined)

    createBrowserPortfolioGenerationInvalidationTransport({ instanceId: 'browser-a' })

    expect(bcHub.participantCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SSR / module import safety
// ---------------------------------------------------------------------------

describe('SSR and Node import safety', () => {
  it('does not access window, localStorage, BroadcastChannel, or crypto during module import', async () => {
    vi.resetModules()
    let windowReads = 0
    let localStorageReads = 0
    let broadcastChannelReads = 0
    let cryptoReads = 0

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      get() {
        windowReads += 1
        return undefined
      },
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        localStorageReads += 1
        return undefined
      },
    })
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      get() {
        broadcastChannelReads += 1
        return undefined
      },
    })
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      get() {
        cryptoReads += 1
        return undefined
      },
    })

    try {
      await import('./portfolioGenerationInvalidationTransport')
      expect(windowReads).toBe(0)
      expect(localStorageReads).toBe(0)
      expect(broadcastChannelReads).toBe(0)
      expect(cryptoReads).toBe(0)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
      Reflect.deleteProperty(globalThis, 'localStorage')
      Reflect.deleteProperty(globalThis, 'BroadcastChannel')
      Reflect.deleteProperty(globalThis, 'crypto')
    }
  })
})

// ---------------------------------------------------------------------------
// Fake hub self-exclusion (hub-level, independent of transport self suppression)
// ---------------------------------------------------------------------------

describe('fake hub sender self-exclusion', () => {
  it('FakeBroadcastChannelHub never delivers a participant message back to that same participant', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const factory = bcHub.createFactory()
    const participantA = factory(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const participantB = factory(PORTFOLIO_GENERATION_INVALIDATION_CHANNEL)
    const receivedByA: unknown[] = []
    const receivedByB: unknown[] = []
    participantA.addEventListener('message', event => receivedByA.push(event.data))
    participantB.addEventListener('message', event => receivedByB.push(event.data))

    participantA.postMessage({ marker: 'from-a' })

    expect(receivedByA).toHaveLength(0)
    expect(receivedByB).toHaveLength(1)
  })

  it('FakeStorageEventHub never delivers a context write back to that same context', () => {
    const storageHub = new FakeStorageEventHub()
    const contextA = storageHub.createContext()
    const contextB = storageHub.createContext()
    const receivedByA: unknown[] = []
    const receivedByB: unknown[] = []
    contextA.eventTarget.addEventListener('storage', event => receivedByA.push(event.newValue))
    contextB.eventTarget.addEventListener('storage', event => receivedByB.push(event.newValue))

    contextA.storage.setItem('some-key', 'some-value')

    expect(receivedByA).toHaveLength(0)
    expect(receivedByB).toHaveLength(1)
  })
})
