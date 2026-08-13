// ═══════════════════════════════════════════════════════════
// CASH-AUTH-1: 現金権限 TTL のローカル lifecycle ガード。
//
// 開いたままのタブが 168h の境界を越えても実行可能な AllocationPlanSnapshot を
// 持ち続けてしまう穴を塞ぐ。updatedAt + 168h + 1ms にローカルタイマーを張り、
// さらに visibility / focus 復帰時にも再検査する（スリープ復帰でタイマーが
// 遅延・欠落しても取りこぼさないため）。
//
// - ネットワークは一切使わない（ポーリングもビーコンも無し）
// - cross-tab の一般化は行わない（既存の invalidation transport には触れない）
// - 権限の値や updatedAt は決して書き換えない — TTL は延長されない
// ═══════════════════════════════════════════════════════════
import type { CashAssumptions } from '../types'
import { evaluateCashAuthorityFreshness } from '../domain/cash/cashAuthority'

/** setTimeout の上限（約24.8日）を超える遅延を防ぐための刻み */
const MAX_TIMEOUT_MS = 2_147_483_647

export interface CashAuthorityLifecycleStore {
  getState: () => {
    cashAssumptions: CashAssumptions
    revalidateCashAuthorityExpiry: (nowMs?: number) => boolean
  }
  subscribe: (
    listener: (
      state: { cashAssumptions: CashAssumptions },
      previous: { cashAssumptions: CashAssumptions },
    ) => void,
  ) => () => void
}

export interface CashAuthorityLifecycleOptions {
  now?: () => number
  setTimer?: (handler: () => void, delayMs: number) => number
  clearTimer?: (handle: number) => void
  /** テスト用の注入ポイント。省略時は globalThis の window/document を使う */
  target?: {
    addEventListener: (type: string, listener: () => void) => void
    removeEventListener: (type: string, listener: () => void) => void
  } | null
  documentRef?: {
    visibilityState?: string
    addEventListener: (type: string, listener: () => void) => void
    removeEventListener: (type: string, listener: () => void) => void
  } | null
}

/**
 * TTL ガードを開始する。返り値を呼ぶと全てのタイマー/リスナーを解除する。
 * 冪等ではない（同じ store に対して二重に張らないこと）。
 */
export function startCashAuthorityExpiryGuard(
  store: CashAuthorityLifecycleStore,
  options: CashAuthorityLifecycleOptions = {},
): () => void {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer
    ?? ((handler: () => void, delayMs: number) =>
      setTimeout(handler, delayMs) as unknown as number)
  const clearTimer = options.clearTimer
    ?? ((handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>))

  const globalTarget = options.target === undefined
    ? (typeof window === 'undefined' ? null : window)
    : options.target
  const documentTarget = options.documentRef === undefined
    ? (typeof document === 'undefined' ? null : document)
    : options.documentRef

  let timerHandle: number | null = null
  let disposed = false

  const clearPendingTimer = () => {
    if (timerHandle !== null) {
      clearTimer(timerHandle)
      timerHandle = null
    }
  }

  const scheduleNext = () => {
    if (disposed) return
    clearPendingTimer()
    const { cashAssumptions } = store.getState()
    const nowMs = now()
    const freshness = evaluateCashAuthorityFreshness(cashAssumptions, nowMs)
    // 権限が無い/既に失効している場合は待つべき境界が無い
    if (freshness.state !== 'known_fresh' || freshness.expiresAtMs === null) return
    // 168h ちょうどはまだ fresh。失効するのは +1ms 後。
    const delay = Math.max(0, freshness.expiresAtMs + 1 - nowMs)
    timerHandle = setTimer(() => {
      timerHandle = null
      revalidate()
    }, Math.min(delay, MAX_TIMEOUT_MS))
  }

  const revalidate = () => {
    if (disposed) return
    const nowMs = now()
    store.getState().revalidateCashAuthorityExpiry(nowMs)
    // まだ失効していない（タイマーが上限で刻まれた等）場合は次の境界を張り直す
    scheduleNext()
  }

  const onVisibility = () => {
    if (documentTarget?.visibilityState === 'hidden') return
    revalidate()
  }
  const onFocus = () => revalidate()

  documentTarget?.addEventListener('visibilitychange', onVisibility)
  globalTarget?.addEventListener('focus', onFocus)

  // 権限が変わったら（保存・再確認・削除・import・他タブ復帰）境界を張り直す
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.cashAssumptions === previous.cashAssumptions) return
    scheduleNext()
  })

  // 起動時点で既に失効しているケースを取りこぼさない
  revalidate()

  return () => {
    disposed = true
    clearPendingTimer()
    documentTarget?.removeEventListener('visibilitychange', onVisibility)
    globalTarget?.removeEventListener('focus', onFocus)
    unsubscribe()
  }
}
