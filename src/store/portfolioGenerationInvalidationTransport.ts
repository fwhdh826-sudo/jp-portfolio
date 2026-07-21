import type { PortfolioGenerationOperation } from './portfolioOperationResult'

export const PORTFOLIO_GENERATION_INVALIDATION_PROTOCOL_VERSION = 1 as const

export const PORTFOLIO_GENERATION_INVALIDATION_CHANNEL =
  'jp-portfolio:portfolio-generation-events:v1'

export const PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY =
  'jp-portfolio:portfolio-generation-event:v1'

const MAX_ID_LENGTH = 128
const MAX_SERIALIZED_BYTES = 1024
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const DEFAULT_DEDUPE_LIMIT = 32

export interface PortfolioGenerationInvalidationEvent {
  protocolVersion: 1
  messageId: string
  senderInstanceId: string
  committedAt: string
  operation: PortfolioGenerationOperation
}

const EVENT_KEYS = [
  'protocolVersion',
  'messageId',
  'senderInstanceId',
  'committedAt',
  'operation',
] as const

const EVENT_KEY_SET: ReadonlySet<string> = new Set(EVENT_KEYS)

// Exhaustive by construction: adding/removing a member of PortfolioGenerationOperation
// without updating this object literal is a compile error.
const PORTFOLIO_GENERATION_OPERATION_MEMBERSHIP: Record<PortfolioGenerationOperation, true> = {
  initialize: true,
  refreshAllData: true,
  importCsv: true,
  importPortfolioSnapshot: true,
  updateHolding: true,
  updateTrust: true,
  setPortfolioPolicy: true,
  setCashAssumptions: true,
  clearCashAssumptionsOverride: true,
  importCashAssumptions: true,
}

export const PORTFOLIO_GENERATION_OPERATIONS: readonly PortfolioGenerationOperation[] =
  Object.keys(PORTFOLIO_GENERATION_OPERATION_MEMBERSHIP) as PortfolioGenerationOperation[]

const PORTFOLIO_GENERATION_OPERATION_SET: ReadonlySet<string> = new Set(
  PORTFOLIO_GENERATION_OPERATIONS,
)

function isPortfolioGenerationOperation(
  value: string,
): value is PortfolioGenerationOperation {
  return PORTFOLIO_GENERATION_OPERATION_SET.has(value)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ParsePortfolioGenerationInvalidationEventOptions {
  nowMs?: number
}

export function parsePortfolioGenerationInvalidationEvent(
  input: unknown,
  options: ParsePortfolioGenerationInvalidationEventOptions = {},
): PortfolioGenerationInvalidationEvent | null {
  try {
    if (!isPlainRecord(input)) return null

    let keys: string[]
    try {
      keys = Object.keys(input)
    } catch {
      return null
    }
    if (keys.length !== EVENT_KEYS.length) return null
    for (const key of keys) {
      if (!EVENT_KEY_SET.has(key)) return null
    }

    let protocolVersion: unknown
    let messageId: unknown
    let senderInstanceId: unknown
    let committedAt: unknown
    let operation: unknown
    try {
      protocolVersion = input.protocolVersion
      messageId = input.messageId
      senderInstanceId = input.senderInstanceId
      committedAt = input.committedAt
      operation = input.operation
    } catch {
      return null
    }

    if (protocolVersion !== PORTFOLIO_GENERATION_INVALIDATION_PROTOCOL_VERSION) return null

    if (
      typeof messageId !== 'string'
      || messageId.length === 0
      || messageId.length > MAX_ID_LENGTH
    ) {
      return null
    }

    if (
      typeof senderInstanceId !== 'string'
      || senderInstanceId.length === 0
      || senderInstanceId.length > MAX_ID_LENGTH
    ) {
      return null
    }

    if (typeof operation !== 'string' || !isPortfolioGenerationOperation(operation)) {
      return null
    }

    if (typeof committedAt !== 'string') return null

    let committedAtDate: Date
    let canonicalCommittedAt: string
    try {
      committedAtDate = new Date(committedAt)
      canonicalCommittedAt = committedAtDate.toISOString()
    } catch {
      return null
    }
    if (canonicalCommittedAt !== committedAt) return null

    const nowMs = options.nowMs ?? Date.now()
    if (committedAtDate.getTime() - nowMs > MAX_FUTURE_SKEW_MS) return null

    const candidate: PortfolioGenerationInvalidationEvent = {
      protocolVersion: PORTFOLIO_GENERATION_INVALIDATION_PROTOCOL_VERSION,
      messageId,
      senderInstanceId,
      committedAt,
      operation,
    }

    let serializedBytes: number
    try {
      serializedBytes = utf8ByteLength(JSON.stringify(candidate))
    } catch {
      return null
    }
    if (serializedBytes > MAX_SERIALIZED_BYTES) return null

    return candidate
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Identity and event creation helpers
// ---------------------------------------------------------------------------

let fallbackIdSequence = 0

function createFallbackId(prefix: string): string {
  fallbackIdSequence += 1
  const randomSegment = Math.random().toString(36).slice(2, 10)
  return `${prefix}-fb-${fallbackIdSequence}-${randomSegment}`
}

function tryRandomUUID(): string | null {
  try {
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (!cryptoRef || typeof cryptoRef.randomUUID !== 'function') return null
    const id = cryptoRef.randomUUID()
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

function generateId(prefix: string): string {
  return tryRandomUUID() ?? createFallbackId(prefix)
}

export function createPortfolioGenerationInstanceId(): string {
  return generateId('instance')
}

export function createPortfolioGenerationMessageId(): string {
  return generateId('message')
}

export interface CreatePortfolioGenerationInvalidationEventInput {
  senderInstanceId: string
  operation: PortfolioGenerationOperation
  committedAt?: string
  messageId?: string
}

export function createPortfolioGenerationInvalidationEvent(
  input: CreatePortfolioGenerationInvalidationEventInput,
): PortfolioGenerationInvalidationEvent {
  return {
    protocolVersion: PORTFOLIO_GENERATION_INVALIDATION_PROTOCOL_VERSION,
    messageId: input.messageId ?? createPortfolioGenerationMessageId(),
    senderInstanceId: input.senderInstanceId,
    committedAt: input.committedAt ?? new Date().toISOString(),
    operation: input.operation,
  }
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface PortfolioGenerationInvalidationTransport {
  publish(event: PortfolioGenerationInvalidationEvent): void
  subscribe(
    listener: (event: PortfolioGenerationInvalidationEvent) => void,
  ): () => void
  dispose(): void
}

export interface PortfolioGenerationInvalidationBroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void
}

export type PortfolioGenerationInvalidationBroadcastChannelFactory = (
  channelName: string,
) => PortfolioGenerationInvalidationBroadcastChannelLike

export interface PortfolioGenerationInvalidationStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PortfolioGenerationInvalidationStorageEventLike {
  key: string | null
  newValue: string | null
}

export interface PortfolioGenerationInvalidationStorageEventTarget {
  addEventListener(
    type: 'storage',
    listener: (event: PortfolioGenerationInvalidationStorageEventLike) => void,
  ): void
  removeEventListener(
    type: 'storage',
    listener: (event: PortfolioGenerationInvalidationStorageEventLike) => void,
  ): void
}

export type PortfolioGenerationInvalidationDiagnosticCode =
  | 'broadcast_constructor_failed'
  | 'broadcast_publish_failed'
  | 'storage_publish_failed'
  | 'invalid_broadcast_event'
  | 'invalid_storage_event'
  | 'listener_failed'
  | 'dispose_failed'

export interface PortfolioGenerationInvalidationDiagnosticSink {
  report(code: PortfolioGenerationInvalidationDiagnosticCode): void
}

const NOOP_DIAGNOSTIC_SINK: PortfolioGenerationInvalidationDiagnosticSink = {
  report: () => {},
}

export interface PortfolioGenerationInvalidationTransportOptions {
  instanceId: string
  channelName?: string
  storageKey?: string
  createBroadcastChannel?: PortfolioGenerationInvalidationBroadcastChannelFactory | null
  storage?: PortfolioGenerationInvalidationStorageLike | null
  storageEventTarget?: PortfolioGenerationInvalidationStorageEventTarget | null
  now?: () => number
  diagnosticSink?: PortfolioGenerationInvalidationDiagnosticSink
  dedupeLimit?: number
}

class RecentMessageIdCache {
  private readonly limit: number
  private readonly seen = new Set<string>()
  private readonly order: string[] = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  has(id: string): boolean {
    return this.seen.has(id)
  }

  add(id: string): void {
    if (this.seen.has(id)) return
    this.seen.add(id)
    this.order.push(id)
    if (this.order.length > this.limit) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  clear(): void {
    this.seen.clear()
    this.order.length = 0
  }
}

function resolveDefaultBroadcastChannelFactory():
  | PortfolioGenerationInvalidationBroadcastChannelFactory
  | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null
    return (channelName: string) =>
      new BroadcastChannel(
        channelName,
      ) as unknown as PortfolioGenerationInvalidationBroadcastChannelLike
  } catch {
    return null
  }
}

function resolveDefaultStorage(): PortfolioGenerationInvalidationStorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const storage = localStorage
    return storage ? storage : null
  } catch {
    return null
  }
}

function resolveDefaultStorageEventTarget():
  | PortfolioGenerationInvalidationStorageEventTarget
  | null {
  try {
    if (typeof window === 'undefined') return null
    const target = window
    return target
      ? (target as unknown as PortfolioGenerationInvalidationStorageEventTarget)
      : null
  } catch {
    return null
  }
}

export function createPortfolioGenerationInvalidationTransport(
  options: PortfolioGenerationInvalidationTransportOptions,
): PortfolioGenerationInvalidationTransport {
  const instanceId = options.instanceId
  const channelName = options.channelName ?? PORTFOLIO_GENERATION_INVALIDATION_CHANNEL
  const storageKey = options.storageKey ?? PORTFOLIO_GENERATION_INVALIDATION_STORAGE_KEY
  const now = options.now ?? (() => Date.now())
  const diagnosticSink = options.diagnosticSink ?? NOOP_DIAGNOSTIC_SINK
  const dedupe = new RecentMessageIdCache(options.dedupeLimit ?? DEFAULT_DEDUPE_LIMIT)

  let disposed = false
  let nextListenerId = 1
  const listenerEntries: Array<{
    id: number
    listener: (event: PortfolioGenerationInvalidationEvent) => void
  }> = []

  function reportDiagnostic(code: PortfolioGenerationInvalidationDiagnosticCode): void {
    try {
      diagnosticSink.report(code)
    } catch {
      // diagnostic sink failures must never affect transport behavior
    }
  }

  function dispatchToListeners(event: PortfolioGenerationInvalidationEvent): void {
    const snapshot = listenerEntries.slice()
    for (const entry of snapshot) {
      try {
        entry.listener(event)
      } catch {
        reportDiagnostic('listener_failed')
      }
    }
  }

  function handleIncoming(raw: unknown, source: 'broadcast' | 'storage'): void {
    if (disposed) return
    const parsed = parsePortfolioGenerationInvalidationEvent(raw, { nowMs: now() })
    if (!parsed) {
      reportDiagnostic(source === 'broadcast' ? 'invalid_broadcast_event' : 'invalid_storage_event')
      return
    }
    if (parsed.senderInstanceId === instanceId) return
    if (dedupe.has(parsed.messageId)) return
    dedupe.add(parsed.messageId)
    dispatchToListeners(parsed)
  }

  // -------------------------------------------------------------------
  // BroadcastChannel setup
  // -------------------------------------------------------------------

  let broadcastChannel: PortfolioGenerationInvalidationBroadcastChannelLike | null = null
  let broadcastListenerAttached = false

  function onBroadcastMessage(event: { data: unknown }): void {
    handleIncoming(event?.data, 'broadcast')
  }

  {
    const factory = options.createBroadcastChannel === null
      ? null
      : options.createBroadcastChannel ?? resolveDefaultBroadcastChannelFactory()
    if (factory) {
      try {
        broadcastChannel = factory(channelName)
      } catch {
        reportDiagnostic('broadcast_constructor_failed')
        broadcastChannel = null
      }
      if (broadcastChannel) {
        try {
          broadcastChannel.addEventListener('message', onBroadcastMessage)
          broadcastListenerAttached = true
        } catch {
          reportDiagnostic('broadcast_constructor_failed')
          broadcastChannel = null
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // Storage setup
  // -------------------------------------------------------------------

  const storage = options.storage === null ? null : options.storage ?? resolveDefaultStorage()
  const storageEventTarget = options.storageEventTarget === null
    ? null
    : options.storageEventTarget ?? resolveDefaultStorageEventTarget()
  let storageListenerAttached = false

  function onStorageEvent(event: PortfolioGenerationInvalidationStorageEventLike): void {
    if (disposed) return
    if (event.key !== storageKey) return
    if (typeof event.newValue !== 'string') return
    if (utf8ByteLength(event.newValue) > MAX_SERIALIZED_BYTES) return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.newValue)
    } catch {
      return
    }
    handleIncoming(parsed, 'storage')
  }

  if (storageEventTarget) {
    try {
      storageEventTarget.addEventListener('storage', onStorageEvent)
      storageListenerAttached = true
    } catch {
      // fail-soft: no storage delivery available for this transport instance
    }
  }

  return {
    publish(event: PortfolioGenerationInvalidationEvent): void {
      if (disposed) return
      const validated = parsePortfolioGenerationInvalidationEvent(event, { nowMs: now() })
      if (!validated) return

      if (broadcastChannel) {
        try {
          broadcastChannel.postMessage(validated)
        } catch {
          reportDiagnostic('broadcast_publish_failed')
        }
      }

      if (storage) {
        try {
          storage.setItem(storageKey, JSON.stringify(validated))
        } catch {
          reportDiagnostic('storage_publish_failed')
        }
      }
    },

    subscribe(
      listener: (event: PortfolioGenerationInvalidationEvent) => void,
    ): () => void {
      if (disposed) return () => {}
      const id = nextListenerId
      nextListenerId += 1
      listenerEntries.push({ id, listener })
      let active = true
      return () => {
        if (!active) return
        active = false
        const index = listenerEntries.findIndex(entry => entry.id === id)
        if (index >= 0) listenerEntries.splice(index, 1)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true

      if (broadcastChannel) {
        if (broadcastListenerAttached) {
          try {
            broadcastChannel.removeEventListener('message', onBroadcastMessage)
          } catch {
            reportDiagnostic('dispose_failed')
          }
        }
        try {
          broadcastChannel.close()
        } catch {
          reportDiagnostic('dispose_failed')
        }
        broadcastChannel = null
      }

      if (storageEventTarget && storageListenerAttached) {
        try {
          storageEventTarget.removeEventListener('storage', onStorageEvent)
        } catch {
          reportDiagnostic('dispose_failed')
        }
      }

      listenerEntries.length = 0
      dedupe.clear()
    },
  }
}

export function createBrowserPortfolioGenerationInvalidationTransport(
  options: { instanceId: string },
): PortfolioGenerationInvalidationTransport {
  // SSR/Node import safety: a Node runtime may expose a global `BroadcastChannel`
  // (and, less commonly, a `localStorage`/`window` polyfill) with no browser tab
  // behind it. Gate all backends on `window` so this factory never wires up a
  // real cross-process channel outside a browser tab.
  const isBrowserEnvironment = typeof window !== 'undefined'
  return createPortfolioGenerationInvalidationTransport({
    instanceId: options.instanceId,
    createBroadcastChannel: isBrowserEnvironment ? undefined : null,
    storage: isBrowserEnvironment ? undefined : null,
    storageEventTarget: isBrowserEnvironment ? undefined : null,
  })
}
