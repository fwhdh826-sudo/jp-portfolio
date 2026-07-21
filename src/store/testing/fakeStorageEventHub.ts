import type {
  PortfolioGenerationInvalidationStorageEventLike,
  PortfolioGenerationInvalidationStorageEventTarget,
  PortfolioGenerationInvalidationStorageLike,
} from '../portfolioGenerationInvalidationTransport'

export type FakeStorageEventType =
  | 'set'
  | 'set_failed'
  | 'remove'
  | 'delivered'

export interface FakeStorageEvent {
  readonly type: FakeStorageEventType
  readonly contextId: number
  readonly key: string
}

export interface FakeStorageContext {
  readonly contextId: number
  readonly storage: PortfolioGenerationInvalidationStorageLike
  readonly eventTarget: PortfolioGenerationInvalidationStorageEventTarget
}

type StorageListener = (event: PortfolioGenerationInvalidationStorageEventLike) => void

interface ContextState {
  readonly id: number
  listeners: StorageListener[]
}

export class FakeStorageEventHub {
  private readonly store = new Map<string, string>()
  private nextContextId = 1
  private readonly contexts = new Map<number, ContextState>()
  private readonly eventLog: FakeStorageEvent[] = []
  private writeCountValue = 0
  private readonly shouldThrowOnSetItem = new Map<number, boolean>()

  createContext(): FakeStorageContext {
    const id = this.nextContextId
    this.nextContextId += 1
    const state: ContextState = { id, listeners: [] }
    this.contexts.set(id, state)

    const hub = this

    const storage: PortfolioGenerationInvalidationStorageLike = {
      getItem(key: string): string | null {
        return hub.store.has(key) ? (hub.store.get(key) as string) : null
      },
      setItem(key: string, value: string): void {
        if (hub.shouldThrowOnSetItem.get(id)) {
          hub.record('set_failed', id, key)
          throw new Error('fake storage setItem failure')
        }
        hub.store.set(key, value)
        hub.writeCountValue += 1
        hub.record('set', id, key)
        hub.deliver(id, key, value)
      },
      removeItem(key: string): void {
        hub.store.delete(key)
        hub.record('remove', id, key)
      },
    }

    const eventTarget: PortfolioGenerationInvalidationStorageEventTarget = {
      addEventListener(_type: 'storage', listener: StorageListener): void {
        state.listeners.push(listener)
      },
      removeEventListener(_type: 'storage', listener: StorageListener): void {
        const index = state.listeners.indexOf(listener)
        if (index >= 0) state.listeners.splice(index, 1)
      },
    }

    return { contextId: id, storage, eventTarget }
  }

  setSetItemShouldThrow(contextId: number, shouldThrow: boolean): void {
    this.shouldThrowOnSetItem.set(contextId, shouldThrow)
  }

  injectRaw(key: string, newValue: string | null, excludeContextId?: number): void {
    for (const [id, state] of this.contexts) {
      if (id === excludeContextId) continue
      for (const listener of state.listeners.slice()) {
        this.record('delivered', id, key)
        listener({ key, newValue })
      }
    }
  }

  get events(): readonly FakeStorageEvent[] {
    return this.eventLog.slice()
  }

  get writeCount(): number {
    return this.writeCountValue
  }

  listenerCount(contextId: number): number {
    return this.contexts.get(contextId)?.listeners.length ?? 0
  }

  private deliver(senderContextId: number, key: string, newValue: string | null): void {
    for (const [id, state] of this.contexts) {
      if (id === senderContextId) continue
      for (const listener of state.listeners.slice()) {
        this.record('delivered', id, key)
        listener({ key, newValue })
      }
    }
  }

  private record(type: FakeStorageEventType, contextId: number, key: string): void {
    this.eventLog.push({ type, contextId, key })
  }
}
