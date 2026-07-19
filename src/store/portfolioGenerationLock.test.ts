import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createPortfolioGenerationLockAdapter,
  DEFAULT_PORTFOLIO_GENERATION_LOCK_TIMEOUT_MS,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type LockManagerLike,
} from './portfolioGenerationLock'
import { FakeLockManager } from './testing/fakeLockManager'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function harness(timeoutMs = DEFAULT_PORTFOLIO_GENERATION_LOCK_TIMEOUT_MS) {
  const lockManager = new FakeLockManager()
  const adapter = createPortfolioGenerationLockAdapter({ lockManager, timeoutMs })
  return { adapter, lockManager }
}

function eventTypes(lockManager: FakeLockManager, name = PORTFOLIO_GENERATION_LOCK_NAME) {
  return lockManager.events
    .filter(event => event.name === name)
    .map(event => event.type)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('lazy Web Lock capability detection', () => {
  it('does not access navigator, locks, or secure context during module import', async () => {
    vi.resetModules()
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext')
    let navigatorReads = 0
    let secureReads = 0
    const locks = Object.create(null)
    Object.defineProperty(locks, 'request', {
      configurable: true,
      get: () => { throw new Error('request must remain lazy') },
    })
    const navigatorValue = Object.create(null)
    Object.defineProperty(navigatorValue, 'locks', {
      configurable: true,
      get: () => { throw new Error('locks must remain lazy') },
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get: () => {
        navigatorReads += 1
        return navigatorValue
      },
    })
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable: true,
      get: () => {
        secureReads += 1
        return true
      },
    })

    try {
      await import('./portfolioGenerationLock')
      expect(navigatorReads).toBe(0)
      expect(secureReads).toBe(0)
    } finally {
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
      if (secureDescriptor) {
        Object.defineProperty(globalThis, 'isSecureContext', secureDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, 'isSecureContext')
      }
    }
  })

  it('classifies an absent navigator as unavailable without running the callback', async () => {
    vi.stubGlobal('navigator', undefined)
    const callback = vi.fn()
    const result = await createPortfolioGenerationLockAdapter()
      .runExclusive('initialize', callback)
    expect(result).toEqual({
      ok: false,
      operation: 'initialize',
      code: 'WEB_LOCK_UNAVAILABLE',
      retryable: false,
    })
    expect(callback).not.toHaveBeenCalled()
  })

  it('classifies an insecure context as unavailable', async () => {
    vi.stubGlobal('navigator', { locks: new FakeLockManager() })
    vi.stubGlobal('isSecureContext', false)
    const result = await createPortfolioGenerationLockAdapter()
      .runExclusive('refreshAllData', vi.fn())
    expect(result).toMatchObject({ ok: false, code: 'WEB_LOCK_UNAVAILABLE' })
  })

  it('classifies a missing locks property as unavailable', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', true)
    const result = await createPortfolioGenerationLockAdapter()
      .runExclusive('importCsv', vi.fn())
    expect(result).toMatchObject({ ok: false, code: 'WEB_LOCK_UNAVAILABLE' })
  })

  it('classifies a missing request function as unavailable', async () => {
    vi.stubGlobal('navigator', { locks: {} })
    vi.stubGlobal('isSecureContext', true)
    const result = await createPortfolioGenerationLockAdapter()
      .runExclusive('importPortfolioSnapshot', vi.fn())
    expect(result).toMatchObject({ ok: false, code: 'WEB_LOCK_UNAVAILABLE' })
  })

  it('classifies a throwing locks getter as request failed', async () => {
    const navigatorValue = Object.create(null)
    Object.defineProperty(navigatorValue, 'locks', {
      configurable: true,
      get: () => { throw new Error('broken locks getter') },
    })
    vi.stubGlobal('navigator', navigatorValue)
    vi.stubGlobal('isSecureContext', true)
    const result = await createPortfolioGenerationLockAdapter()
      .runExclusive('initialize', vi.fn())
    expect(result).toEqual({
      ok: false,
      operation: 'initialize',
      code: 'WEB_LOCK_REQUEST_FAILED',
      retryable: true,
    })
  })

  it('classifies a synchronous request throw as request failed', async () => {
    const lockManager: LockManagerLike = {
      request() { throw new Error('request invocation failed') },
    }
    const callback = vi.fn()
    const result = await createPortfolioGenerationLockAdapter({ lockManager })
      .runExclusive('initialize', callback)
    expect(result).toMatchObject({ ok: false, code: 'WEB_LOCK_REQUEST_FAILED' })
    expect(callback).not.toHaveBeenCalled()
  })

  it('accepts the native LockManager type without an adapter assertion', () => {
    const build = (lockManager: LockManager) =>
      createPortfolioGenerationLockAdapter({ lockManager })
    expectTypeOf(build).parameter(0).toEqualTypeOf<LockManager>()
  })
})

describe('request options and successful lock lifetime', () => {
  it('requests the exact fixed name in exclusive mode without ifAvailable or steal', async () => {
    const { adapter, lockManager } = harness()
    const resultPromise = adapter.runExclusive('initialize', () => 'done')
    expect(lockManager.requests).toHaveLength(1)
    expect(lockManager.requests[0].name).toBe(PORTFOLIO_GENERATION_LOCK_NAME)
    expect(lockManager.requests[0].options.mode).toBe('exclusive')
    expect(Object.prototype.hasOwnProperty.call(
      lockManager.requests[0].options,
      'ifAvailable',
    )).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(
      lockManager.requests[0].options,
      'steal',
    )).toBe(false)
    expect(lockManager.requests[0].options.signal).toBeInstanceOf(AbortSignal)
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 'done' })
  })

  it('does not run the callback before grant and runs it exactly once after grant', async () => {
    const { adapter, lockManager } = harness()
    const callback = vi.fn(() => 7)
    const resultPromise = adapter.runExclusive('refreshAllData', callback)
    expect(callback).not.toHaveBeenCalled()
    expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 7 })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
  })

  it('returns a synchronous callback value', async () => {
    const { adapter, lockManager } = harness()
    const resultPromise = adapter.runExclusive('importCsv', () => 123)
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 123 })
  })

  it('returns an asynchronous callback value', async () => {
    const { adapter, lockManager } = harness()
    const resultPromise = adapter.runExclusive('importCsv', async () => 'async-value')
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 'async-value' })
  })

  it('preserves the generic result type', async () => {
    const { adapter, lockManager } = harness()
    const resultPromise = adapter.runExclusive('initialize', () => ({ id: 17 as const }))
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    const result = await resultPromise
    if (!result.ok) throw new Error('expected successful generic result')
    expectTypeOf(result.value).toEqualTypeOf<{ id: 17 }>()
    expect(result.value).toEqual({ id: 17 })
  })

  it('holds the lock until an asynchronous callback completes then releases automatically', async () => {
    const { adapter, lockManager } = harness()
    const completion = deferred<string>()
    const resultPromise = adapter.runExclusive('initialize', () => completion.promise)
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await flushMicrotasks()
    expect(lockManager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    completion.resolve('complete')
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 'complete' })
    expect(lockManager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(eventTypes(lockManager)).toEqual([
      'requested',
      'queued',
      'granted',
      'callback_resolved',
      'released',
    ])
  })

  it('allows the next waiter to acquire after automatic release', async () => {
    const { adapter, lockManager } = harness()
    const order: number[] = []
    const first = adapter.runExclusive('initialize', () => { order.push(1) })
    const second = adapter.runExclusive('refreshAllData', () => { order.push(2) })
    expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    await first
    expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    await second
    expect(order).toEqual([1, 2])
  })
})

describe('deterministic FakeLockManager queue semantics', () => {
  it('grants three same-name waiters in FIFO order with no callback overlap', async () => {
    const { adapter, lockManager } = harness()
    const order: number[] = []
    let activeCallbacks = 0
    let maximumActive = 0
    const run = (id: number) => adapter.runExclusive('initialize', async () => {
      activeCallbacks += 1
      maximumActive = Math.max(maximumActive, activeCallbacks)
      order.push(id)
      await Promise.resolve()
      activeCallbacks -= 1
    })
    const requests = [run(1), run(2), run(3)]
    expect(lockManager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2, 3])
    for (const request of requests) {
      expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
      await request
    }
    expect(order).toEqual([1, 2, 3])
    expect(maximumActive).toBe(1)
  })

  it('keeps different lock names independent', async () => {
    const lockManager = new FakeLockManager()
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    const first = lockManager.request('first', { mode: 'exclusive' }, () => firstGate.promise)
    const second = lockManager.request('second', { mode: 'exclusive' }, () => secondGate.promise)
    expect(lockManager.grantNext('first')).toBe(true)
    expect(lockManager.grantNext('second')).toBe(true)
    await flushMicrotasks()
    expect(lockManager.isHeld('first')).toBe(true)
    expect(lockManager.isHeld('second')).toBe(true)
    firstGate.resolve()
    secondGate.resolve()
    await Promise.all([first, second])
    expect(lockManager.isHeld('first')).toBe(false)
    expect(lockManager.isHeld('second')).toBe(false)
  })

  it('records callback completion before release in deterministic order', async () => {
    const lockManager = new FakeLockManager()
    const request = lockManager.request('ordered', { mode: 'exclusive' }, () => 'ok')
    lockManager.grantNext('ordered')
    await expect(request).resolves.toBe('ok')
    expect(eventTypes(lockManager, 'ordered')).toEqual([
      'requested', 'queued', 'granted', 'callback_resolved', 'released',
    ])
  })

  it('removes an aborted waiter and never invokes its callback', async () => {
    const lockManager = new FakeLockManager()
    const controller = new AbortController()
    const callback = vi.fn()
    const request = lockManager.request(
      'abortable',
      { mode: 'exclusive', signal: controller.signal },
      callback,
    )
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(lockManager.pendingCount('abortable')).toBe(0)
    expect(lockManager.grantNext('abortable')).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(eventTypes(lockManager, 'abortable')).toEqual(['requested', 'queued', 'aborted'])
  })

  it('releases after a direct callback rejection and grants the next waiter', async () => {
    const lockManager = new FakeLockManager()
    const error = new Error('fake callback failure')
    const first = lockManager.request('shared-name', { mode: 'exclusive' }, () => {
      throw error
    })
    const second = lockManager.request('shared-name', { mode: 'exclusive' }, () => 'next')
    lockManager.grantNext('shared-name')
    await expect(first).rejects.toBe(error)
    expect(lockManager.isHeld('shared-name')).toBe(false)
    expect(lockManager.grantNext('shared-name')).toBe(true)
    await expect(second).resolves.toBe('next')
    expect(eventTypes(lockManager, 'shared-name')).toEqual([
      'requested', 'queued', 'requested', 'queued',
      'granted', 'callback_rejected', 'released',
      'granted', 'callback_resolved', 'released',
    ])
  })
})

describe('pending timeout state machine', () => {
  it('remains pending at 14,999ms and times out exactly at 15,000ms', async () => {
    vi.useFakeTimers()
    const { adapter } = harness()
    let settled = false
    const resultPromise = adapter.runExclusive('initialize', vi.fn())
    void resultPromise.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      operation: 'initialize',
      code: 'WEB_LOCK_TIMEOUT',
      retryable: true,
    })
  })

  it('aborts and removes the timed-out waiter without invoking its callback', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const callback = vi.fn()
    const resultPromise = adapter.runExclusive('importCsv', callback)
    await vi.advanceTimersByTimeAsync(15_000)
    await resultPromise
    expect(callback).not.toHaveBeenCalled()
    expect(lockManager.pendingCount(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(0)
    expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    expect(eventTypes(lockManager)).toEqual(['requested', 'queued', 'aborted'])
  })

  it('cleans the timer and external abort listener after timeout', async () => {
    vi.useFakeTimers()
    const { adapter } = harness()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const resultPromise = adapter.runExclusive(
      'initialize',
      vi.fn(),
      { signal: controller.signal },
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await resultPromise
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a later waiter to succeed after timeout queue removal', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const first = adapter.runExclusive('initialize', vi.fn())
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    const second = adapter.runExclusive('refreshAllData', () => 'next')
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(second).resolves.toEqual({ ok: true, value: 'next' })
  })
})

describe('external abort state machine', () => {
  it('maps a pending external abort to WEB_LOCK_ABORTED and callback zero', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const controller = new AbortController()
    const callback = vi.fn()
    const resultPromise = adapter.runExclusive(
      'initialize', callback, { signal: controller.signal },
    )
    controller.abort()
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      operation: 'initialize',
      code: 'WEB_LOCK_ABORTED',
      retryable: true,
    })
    expect(callback).not.toHaveBeenCalled()
    expect(lockManager.pendingCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('short-circuits an already-aborted signal before request and timer creation', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const controller = new AbortController()
    controller.abort()
    const callback = vi.fn()
    const result = await adapter.runExclusive(
      'initialize', callback, { signal: controller.signal },
    )
    expect(result).toMatchObject({ ok: false, code: 'WEB_LOCK_ABORTED' })
    expect(lockManager.requests).toHaveLength(0)
    expect(callback).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows the next waiter to succeed after external abort', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const controller = new AbortController()
    const first = adapter.runExclusive('initialize', vi.fn(), { signal: controller.signal })
    controller.abort()
    await first
    const second = adapter.runExclusive('initialize', () => 'recovered')
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(second).resolves.toEqual({ ok: true, value: 'recovered' })
  })

  it('uses external abort when abort happens before timeout', async () => {
    vi.useFakeTimers()
    const { adapter } = harness()
    const controller = new AbortController()
    const resultPromise = adapter.runExclusive('initialize', vi.fn(), {
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(14_999)
    controller.abort()
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toMatchObject({ code: 'WEB_LOCK_ABORTED' })
  })

  it('uses timeout when timeout happens before external abort', async () => {
    vi.useFakeTimers()
    const { adapter } = harness()
    const controller = new AbortController()
    const resultPromise = adapter.runExclusive('initialize', vi.fn(), {
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(15_000)
    controller.abort()
    await expect(resultPromise).resolves.toMatchObject({ code: 'WEB_LOCK_TIMEOUT' })
  })
})

describe('timeout, grant, and abort races', () => {
  it('timeout immediately before grant prevents callback execution', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const callback = vi.fn()
    const resultPromise = adapter.runExclusive('initialize', callback)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    await expect(resultPromise).resolves.toMatchObject({ code: 'WEB_LOCK_TIMEOUT' })
    expect(callback).not.toHaveBeenCalled()
  })

  it('grant immediately before timeout disables the timer', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const callback = vi.fn(() => 'granted')
    const resultPromise = adapter.runExclusive('initialize', callback)
    await vi.advanceTimersByTimeAsync(14_999)
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 'granted' })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles once when timeout and grant are scheduled for the same tick with timeout first', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const callback = vi.fn(() => 'late')
    const settlements: string[] = []
    const resultPromise = adapter.runExclusive('initialize', callback)
    void resultPromise.then(result => settlements.push(result.ok ? 'success' : result.code))
    setTimeout(() => lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME), 15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    await resultPromise
    expect(settlements).toEqual(['WEB_LOCK_TIMEOUT'])
    expect(callback).not.toHaveBeenCalled()
  })

  it('settles once when grant and timeout are scheduled for the same tick with grant first', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const settlements: string[] = []
    setTimeout(() => lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME), 15_000)
    const resultPromise = adapter.runExclusive('initialize', () => 'winner')
    void resultPromise.then(result => settlements.push(result.ok ? result.value : result.code))
    await vi.advanceTimersByTimeAsync(15_000)
    await resultPromise
    expect(settlements).toEqual(['winner'])
  })

  it('ignores timer advancement after grant while the callback remains pending', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const completion = deferred<string>()
    const resultPromise = adapter.runExclusive('initialize', () => completion.promise)
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await flushMicrotasks()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lockManager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    completion.resolve('done')
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 'done' })
  })

  it('does not forward external abort after grant or interrupt the callback', async () => {
    vi.useFakeTimers()
    const { adapter, lockManager } = harness()
    const controller = new AbortController()
    const completion = deferred<string>()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const resultPromise = adapter.runExclusive(
      'initialize',
      () => completion.promise,
      { signal: controller.signal },
    )
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await flushMicrotasks()
    expect(remove).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(lockManager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    completion.resolve('not-interrupted')
    await expect(resultPromise).resolves.toEqual({ ok: true, value: 'not-interrupted' })
  })
})

describe('callback exception contract', () => {
  it('rejects a synchronous callback throw with the same error identity', async () => {
    const { adapter, lockManager } = harness()
    const error = new Error('sync callback failure')
    const resultPromise = adapter.runExclusive('initialize', () => { throw error })
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(resultPromise).rejects.toBe(error)
    expect(lockManager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
  })

  it('rejects an asynchronous callback rejection with the same error identity', async () => {
    const { adapter, lockManager } = harness()
    const error = new Error('async callback failure')
    const resultPromise = adapter.runExclusive('initialize', async () => { throw error })
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(resultPromise).rejects.toBe(error)
  })

  it('does not convert callback errors to WEB_LOCK_REQUEST_FAILED', async () => {
    const { adapter, lockManager } = harness()
    const error = { identity: 'callback-error' }
    const resultPromise = adapter.runExclusive('initialize', () => Promise.reject(error))
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    let rejection: unknown
    try {
      await resultPromise
    } catch (caught: unknown) {
      rejection = caught
    }
    expect(rejection).toBe(error)
    expect(rejection).not.toMatchObject({ code: 'WEB_LOCK_REQUEST_FAILED' })
  })

  it('releases after callback error and allows the next waiter to succeed', async () => {
    const { adapter, lockManager } = harness()
    const error = new Error('first failed')
    const first = adapter.runExclusive('initialize', () => { throw error })
    const second = adapter.runExclusive('refreshAllData', () => 'second succeeded')
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(first).rejects.toBe(error)
    expect(lockManager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    lockManager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await expect(second).resolves.toEqual({ ok: true, value: 'second succeeded' })
  })
})

describe('request failure classification and cleanup', () => {
  it('maps an unexpected pre-callback request rejection to a sanitized failure', async () => {
    vi.useFakeTimers()
    const rawError = new Error('unexpected request rejection')
    const lockManager: LockManagerLike = {
      request() { return Promise.reject(rawError) },
    }
    const callback = vi.fn()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = await createPortfolioGenerationLockAdapter({ lockManager })
      .runExclusive('importCsv', callback, { signal: controller.signal })
    expect(result).toEqual({
      ok: false,
      operation: 'importCsv',
      code: 'WEB_LOCK_REQUEST_FAILED',
      retryable: true,
    })
    expect(Object.keys(result).sort()).toEqual(['code', 'ok', 'operation', 'retryable'])
    expect(result).not.toHaveProperty('error')
    expect(result).not.toHaveProperty('message')
    expect(result).not.toHaveProperty('stack')
    expect(result).not.toHaveProperty('cause')
    expect(callback).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('timeout configuration', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid timeout %s at adapter creation',
    timeoutMs => {
      expect(() => createPortfolioGenerationLockAdapter({
        lockManager: new FakeLockManager(),
        timeoutMs,
      })).toThrow(RangeError)
    },
  )

  it('exports and applies the 15,000ms default timeout', async () => {
    vi.useFakeTimers()
    expect(DEFAULT_PORTFOLIO_GENERATION_LOCK_TIMEOUT_MS).toBe(15_000)
    const lockManager = new FakeLockManager()
    const adapter = createPortfolioGenerationLockAdapter({ lockManager })
    let settled = false
    const resultPromise = adapter.runExclusive('initialize', vi.fn())
    void resultPromise.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toMatchObject({ code: 'WEB_LOCK_TIMEOUT' })
  })

  it('uses a custom timeout deterministically', async () => {
    vi.useFakeTimers()
    const { adapter } = harness(37)
    const resultPromise = adapter.runExclusive('initialize', vi.fn())
    await vi.advanceTimersByTimeAsync(36)
    let settled = false
    void resultPromise.then(() => { settled = true })
    await flushMicrotasks()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toMatchObject({ code: 'WEB_LOCK_TIMEOUT' })
  })
})
