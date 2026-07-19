import type { LockManagerLike } from '../portfolioGenerationLock'

export type FakeLockEventType =
  | 'requested'
  | 'queued'
  | 'granted'
  | 'callback_resolved'
  | 'callback_rejected'
  | 'released'
  | 'aborted'

export interface FakeLockEvent {
  readonly type: FakeLockEventType
  readonly name: string
  readonly waiterId: number
}

export interface FakeLockRequestRecord {
  readonly name: string
  readonly options: LockOptions
  readonly waiterId: number
}

interface PendingWaiter {
  readonly id: number
  readonly name: string
  readonly options: LockOptions
  readonly callback: (lock: Lock | null) => unknown | PromiseLike<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (reason?: unknown) => void
  abortListener: (() => void) | null
  granted: boolean
}

function createAbortError(): Error {
  const error = new Error('The lock request was aborted')
  error.name = 'AbortError'
  return error
}

export class FakeLockManager implements LockManagerLike {
  private readonly queues = new Map<string, PendingWaiter[]>()
  private readonly held = new Map<string, PendingWaiter>()
  private readonly eventLog: FakeLockEvent[] = []
  private readonly requestLog: FakeLockRequestRecord[] = []
  private nextWaiterId = 1

  get events(): readonly FakeLockEvent[] {
    return this.eventLog.slice()
  }

  get requests(): readonly FakeLockRequestRecord[] {
    return this.requestLog.slice()
  }

  request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const id = this.nextWaiterId
    this.nextWaiterId += 1

    return new Promise<T>((resolve, reject) => {
      const waiter: PendingWaiter = {
        id,
        name,
        options,
        callback,
        resolve: value => resolve(value as T),
        reject,
        abortListener: null,
        granted: false,
      }

      this.requestLog.push({ name, options, waiterId: id })
      this.record('requested', waiter)

      const signal = options.signal
      if (signal?.aborted) {
        this.record('aborted', waiter)
        reject(createAbortError())
        return
      }

      if (signal) {
        waiter.abortListener = () => this.abortPending(waiter)
        signal.addEventListener('abort', waiter.abortListener, { once: true })
      }

      const queue = this.queues.get(name) ?? []
      queue.push(waiter)
      this.queues.set(name, queue)
      this.record('queued', waiter)

      if (signal?.aborted) this.abortPending(waiter)
    })
  }

  grantNext(name: string): boolean {
    if (this.held.has(name)) return false
    const queue = this.queues.get(name)
    if (!queue || queue.length === 0) return false

    const waiter = queue.shift()
    if (!waiter) return false
    if (queue.length === 0) this.queues.delete(name)

    waiter.granted = true
    this.detachAbortListener(waiter)
    this.held.set(name, waiter)
    this.record('granted', waiter)

    const lock: Lock = {
      name,
      mode: waiter.options.mode ?? 'exclusive',
    }

    Promise.resolve()
      .then(() => waiter.callback(lock))
      .then(
        value => {
          this.record('callback_resolved', waiter)
          this.release(waiter)
          waiter.resolve(value)
        },
        error => {
          this.record('callback_rejected', waiter)
          this.release(waiter)
          waiter.reject(error)
        },
      )

    return true
  }

  isHeld(name: string): boolean {
    return this.held.has(name)
  }

  pendingCount(name?: string): number {
    if (name !== undefined) return this.queues.get(name)?.length ?? 0
    let count = 0
    for (const queue of this.queues.values()) count += queue.length
    return count
  }

  pendingWaiterIds(name: string): readonly number[] {
    return (this.queues.get(name) ?? []).map(waiter => waiter.id)
  }

  private abortPending(waiter: PendingWaiter): void {
    if (waiter.granted) return
    const queue = this.queues.get(waiter.name)
    if (!queue) return
    const index = queue.indexOf(waiter)
    if (index < 0) return

    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(waiter.name)
    this.detachAbortListener(waiter)
    this.record('aborted', waiter)
    waiter.reject(createAbortError())
  }

  private release(waiter: PendingWaiter): void {
    if (this.held.get(waiter.name) !== waiter) return
    this.held.delete(waiter.name)
    this.record('released', waiter)
  }

  private detachAbortListener(waiter: PendingWaiter): void {
    if (!waiter.abortListener || !waiter.options.signal) return
    waiter.options.signal.removeEventListener('abort', waiter.abortListener)
    waiter.abortListener = null
  }

  private record(type: FakeLockEventType, waiter: PendingWaiter): void {
    this.eventLog.push({ type, name: waiter.name, waiterId: waiter.id })
  }
}
