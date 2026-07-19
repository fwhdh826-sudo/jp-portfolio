import {
  createPortfolioCoordinationFailure,
  type PortfolioCoordinationFailure,
  type PortfolioGenerationOperation,
} from './portfolioOperationResult'

export const PORTFOLIO_GENERATION_LOCK_NAME =
  'jp-portfolio:portfolio-generation:v1'

export const DEFAULT_PORTFOLIO_GENERATION_LOCK_TIMEOUT_MS = 15_000

export interface LockManagerLike {
  request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T>
}

export interface PortfolioGenerationLockTimerApi {
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof globalThis.setTimeout>
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void
}

export interface PortfolioGenerationLockAdapter {
  runExclusive<T>(
    operation: PortfolioGenerationOperation,
    callback: () => T | Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<PortfolioGenerationLockResult<T>>
}

export type PortfolioGenerationLockResult<T> =
  | { ok: true; value: T }
  | PortfolioCoordinationFailure

export interface CreatePortfolioGenerationLockAdapterOptions {
  lockManager?: LockManagerLike
  lockManagerProvider?: () => LockManagerLike | null | undefined
  timeoutMs?: number
  timerApi?: PortfolioGenerationLockTimerApi
}

type CapabilityResult =
  | { status: 'available'; lockManager: LockManagerLike }
  | { status: 'unavailable' }
  | { status: 'failed' }

type RequestOutcome<T> =
  | { kind: 'success'; value: T }
  | { kind: 'callback_error'; error: unknown }
  | { kind: 'cancelled_before_grant' }

const DEFAULT_TIMER_API: PortfolioGenerationLockTimerApi = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle),
}

function isLockManagerLike(value: unknown): value is LockManagerLike {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'request') === 'function'
}

function resolveBrowserLockManager(): CapabilityResult {
  let navigatorValue: unknown
  try {
    if (!('navigator' in globalThis)) return { status: 'unavailable' }
    navigatorValue = Reflect.get(globalThis, 'navigator')
  } catch {
    return { status: 'failed' }
  }

  if (typeof navigatorValue !== 'object' || navigatorValue === null) {
    return { status: 'unavailable' }
  }

  try {
    if (Reflect.get(globalThis, 'isSecureContext') !== true) {
      return { status: 'unavailable' }
    }
    if (!('locks' in navigatorValue)) return { status: 'unavailable' }
    const locksValue: unknown = Reflect.get(navigatorValue, 'locks')
    if (!isLockManagerLike(locksValue)) return { status: 'unavailable' }
    return { status: 'available', lockManager: locksValue }
  } catch {
    return { status: 'failed' }
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Portfolio generation lock timeout must be finite and positive')
  }
}

export function createPortfolioGenerationLockAdapter(
  options: CreatePortfolioGenerationLockAdapterOptions = {},
): PortfolioGenerationLockAdapter {
  const timeoutMs = options.timeoutMs
    ?? DEFAULT_PORTFOLIO_GENERATION_LOCK_TIMEOUT_MS
  validateTimeout(timeoutMs)
  const timerApi = options.timerApi ?? DEFAULT_TIMER_API

  function resolveLockManager(): CapabilityResult {
    if (options.lockManager) {
      return { status: 'available', lockManager: options.lockManager }
    }
    if (options.lockManagerProvider) {
      try {
        const lockManager = options.lockManagerProvider()
        return lockManager
          ? { status: 'available', lockManager }
          : { status: 'unavailable' }
      } catch {
        return { status: 'failed' }
      }
    }
    return resolveBrowserLockManager()
  }

  return {
    async runExclusive<T>(
      operation: PortfolioGenerationOperation,
      callback: () => T | Promise<T>,
      runOptions: { signal?: AbortSignal } = {},
    ): Promise<PortfolioGenerationLockResult<T>> {
      const capability = resolveLockManager()
      if (capability.status === 'unavailable') {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_UNAVAILABLE')
      }
      if (capability.status === 'failed') {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_REQUEST_FAILED')
      }

      const externalSignal = runOptions.signal
      if (externalSignal?.aborted) {
        return createPortfolioCoordinationFailure(operation, 'WEB_LOCK_ABORTED')
      }

      return new Promise<PortfolioGenerationLockResult<T>>((resolve, reject) => {
        const internalController = new AbortController()
        let settled = false
        let granted = false
        let callbackOutcome: Promise<RequestOutcome<T>> | null = null
        let timerHandle: ReturnType<typeof globalThis.setTimeout> | null = null
        let externalListenerAttached = false

        const cleanupPendingResources = () => {
          if (timerHandle !== null) {
            timerApi.clearTimeout(timerHandle)
            timerHandle = null
          }
          if (externalSignal && externalListenerAttached) {
            externalSignal.removeEventListener('abort', onExternalAbort)
            externalListenerAttached = false
          }
        }

        const settlePendingFailure = (
          code: 'WEB_LOCK_TIMEOUT' | 'WEB_LOCK_ABORTED',
        ) => {
          if (settled || granted) return
          settled = true
          cleanupPendingResources()
          internalController.abort()
          resolve(createPortfolioCoordinationFailure(operation, code))
        }

        const onExternalAbort = () => {
          settlePendingFailure('WEB_LOCK_ABORTED')
        }

        if (externalSignal) {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true })
          externalListenerAttached = true
          if (externalSignal.aborted) {
            onExternalAbort()
            return
          }
        }

        timerHandle = timerApi.setTimeout(() => {
          settlePendingFailure('WEB_LOCK_TIMEOUT')
        }, timeoutMs)

        const onGrant = (): Promise<RequestOutcome<T>> => {
          if (callbackOutcome) return callbackOutcome
          if (settled) {
            return Promise.resolve({ kind: 'cancelled_before_grant' })
          }

          granted = true
          cleanupPendingResources()
          callbackOutcome = Promise.resolve().then(async (): Promise<RequestOutcome<T>> => {
            try {
              return { kind: 'success', value: await callback() }
            } catch (error: unknown) {
              return { kind: 'callback_error', error }
            }
          })
          return callbackOutcome
        }

        let requestPromise: Promise<RequestOutcome<T>>
        try {
          requestPromise = capability.lockManager.request<RequestOutcome<T>>(
            PORTFOLIO_GENERATION_LOCK_NAME,
            { mode: 'exclusive', signal: internalController.signal },
            onGrant,
          )
        } catch {
          if (!settled) {
            settled = true
            cleanupPendingResources()
            resolve(createPortfolioCoordinationFailure(
              operation,
              'WEB_LOCK_REQUEST_FAILED',
            ))
          }
          return
        }

        requestPromise.then(
          outcome => {
            if (settled) return
            settled = true
            cleanupPendingResources()
            if (outcome.kind === 'success') {
              resolve({ ok: true, value: outcome.value })
            } else if (outcome.kind === 'callback_error') {
              reject(outcome.error)
            } else {
              resolve(createPortfolioCoordinationFailure(
                operation,
                'WEB_LOCK_REQUEST_FAILED',
              ))
            }
          },
          () => {
            if (settled) return
            settled = true
            cleanupPendingResources()
            resolve(createPortfolioCoordinationFailure(
              operation,
              'WEB_LOCK_REQUEST_FAILED',
            ))
          },
        )
      })
    },
  }
}
