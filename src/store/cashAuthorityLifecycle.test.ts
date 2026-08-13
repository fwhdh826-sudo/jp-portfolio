// CASH-AUTH-1 §14/§17: 現金権限 TTL のローカル lifecycle ガード。
// 実時計・sleep は使わず、注入したクロックとタイマーだけで境界を検証する。
import { describe, expect, it, vi } from 'vitest'
import { startCashAuthorityExpiryGuard } from './cashAuthorityLifecycle'
import { DEFAULT_CASH_ASSUMPTIONS } from '../types'
import type { CashAssumptions } from '../types'

const NOW = Date.parse('2026-08-01T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const TTL = 168 * HOUR

function manual(updatedAt: string | null): CashAssumptions {
  return {
    source: 'MANUAL',
    grossCash: 1_000_000,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt,
  }
}

/** テスト用の最小 store — subscribe/getState だけを提供する */
function makeStore(initial: CashAssumptions) {
  let state = { cashAssumptions: initial }
  const listeners = new Set<(s: typeof state, p: typeof state) => void>()
  const revalidate = vi.fn(() => false)
  return {
    revalidate,
    setCash(next: CashAssumptions) {
      const previous = state
      state = { cashAssumptions: next }
      for (const l of listeners) l(state, previous)
    },
    store: {
      getState: () => ({
        cashAssumptions: state.cashAssumptions,
        revalidateCashAuthorityExpiry: revalidate,
      }),
      subscribe: (listener: (s: typeof state, p: typeof state) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}

function makeTarget() {
  const handlers = new Map<string, Array<() => void>>()
  return {
    visibilityState: 'visible',
    addEventListener: (type: string, listener: () => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), listener])
    },
    removeEventListener: (type: string, listener: () => void) => {
      handlers.set(type, (handlers.get(type) ?? []).filter(l => l !== listener))
    },
    fire(type: string) {
      for (const l of handlers.get(type) ?? []) l()
    },
    count(type: string) {
      return (handlers.get(type) ?? []).length
    },
  }
}

interface Timer { id: number; handler: () => void; delay: number }

function makeTimers() {
  const timers: Timer[] = []
  let nextId = 1
  return {
    timers,
    setTimer: (handler: () => void, delay: number) => {
      const id = nextId++
      timers.push({ id, handler, delay })
      return id
    },
    clearTimer: (id: number) => {
      const index = timers.findIndex(t => t.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    fireLast() {
      const timer = timers[timers.length - 1]
      if (!timer) throw new Error('no timer scheduled')
      timers.splice(timers.length - 1, 1)
      timer.handler()
    },
  }
}

describe('startCashAuthorityExpiryGuard', () => {
  it('失効の 1ms 後にローカルタイマーを予約する（168hちょうどではまだ発火しない）', () => {
    const updatedAt = new Date(NOW - HOUR).toISOString()
    const { store } = makeStore(manual(updatedAt))
    const timers = makeTimers()
    const target = makeTarget()

    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      target,
      documentRef: target,
    })

    const scheduled = timers.timers[timers.timers.length - 1]
    expect(scheduled).toBeDefined()
    expect(scheduled!.delay).toBe(Date.parse(updatedAt) + TTL + 1 - NOW)
    stop()
  })

  it('権限が無いときはタイマーを張らない（監視すべき境界が無い）', () => {
    const { store } = makeStore({ ...DEFAULT_CASH_ASSUMPTIONS })
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    expect(timers.timers).toHaveLength(0)
    stop()
  })

  it('既に失効している状態で起動すると即座に再検証する', () => {
    const { store, revalidate } = makeStore(manual(new Date(NOW - (TTL + 1)).toISOString()))
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    expect(revalidate).toHaveBeenCalledWith(NOW)
    stop()
  })

  it('タイマー発火で再検証が走る', () => {
    let clock = NOW
    const updatedAt = new Date(NOW - HOUR).toISOString()
    const { store, revalidate } = makeStore(manual(updatedAt))
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => clock, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    revalidate.mockClear()

    clock = Date.parse(updatedAt) + TTL + 1
    timers.fireLast()
    expect(revalidate).toHaveBeenCalledWith(clock)
    stop()
  })

  it('visibility 復帰と focus でも再検証する（スリープ復帰の取りこぼし防止）', () => {
    const { store, revalidate } = makeStore(manual(new Date(NOW - HOUR).toISOString()))
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    revalidate.mockClear()

    target.fire('visibilitychange')
    expect(revalidate).toHaveBeenCalledTimes(1)
    target.fire('focus')
    expect(revalidate).toHaveBeenCalledTimes(2)
    stop()
  })

  it('タブが hidden のときの visibilitychange では再検証しない', () => {
    const { store, revalidate } = makeStore(manual(new Date(NOW - HOUR).toISOString()))
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    revalidate.mockClear()

    target.visibilityState = 'hidden'
    target.fire('visibilitychange')
    expect(revalidate).not.toHaveBeenCalled()
    stop()
  })

  it('権限が変わると境界を張り直す', () => {
    const { store, setCash } = makeStore(manual(new Date(NOW - HOUR).toISOString()))
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    const firstDelay = timers.timers[timers.timers.length - 1]!.delay

    const newerUpdatedAt = new Date(NOW).toISOString()
    setCash(manual(newerUpdatedAt))
    const secondDelay = timers.timers[timers.timers.length - 1]!.delay
    expect(secondDelay).toBeGreaterThan(firstDelay)
    expect(secondDelay).toBe(Date.parse(newerUpdatedAt) + TTL + 1 - NOW)
    stop()
  })

  it('停止するとタイマーもリスナーも残らない', () => {
    const { store } = makeStore(manual(new Date(NOW - HOUR).toISOString()))
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    expect(timers.timers.length).toBeGreaterThan(0)
    expect(target.count('visibilitychange')).toBe(1)
    expect(target.count('focus')).toBe(1)

    stop()
    expect(timers.timers).toHaveLength(0)
    expect(target.count('visibilitychange')).toBe(0)
    expect(target.count('focus')).toBe(0)
  })

  it('権限の値や updatedAt を書き換えない（TTLは決して延長されない）', () => {
    const updatedAt = new Date(NOW - HOUR).toISOString()
    const record = manual(updatedAt)
    const { store } = makeStore(record)
    const timers = makeTimers()
    const target = makeTarget()
    const stop = startCashAuthorityExpiryGuard(store, {
      now: () => NOW, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      target, documentRef: target,
    })
    target.fire('visibilitychange')
    target.fire('focus')
    expect(store.getState().cashAssumptions).toBe(record)
    expect(store.getState().cashAssumptions.updatedAt).toBe(updatedAt)
    stop()
  })
})
