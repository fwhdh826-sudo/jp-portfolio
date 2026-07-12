import type { Holding } from '../../types'

export const STOCK_SELL_LOCK_DAYS = 90

function parseDate(value?: string): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function diffDays(from: Date, to: Date) {
  const ms = to.getTime() - from.getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

export function getSellLockRemainingDays(holding: Holding, now = new Date()) {
  const acquired = parseDate(holding.acquiredAt)
  if (!acquired) return holding.lock ? STOCK_SELL_LOCK_DAYS : 0
  const elapsed = Math.max(0, diffDays(acquired, now))
  return Math.max(0, STOCK_SELL_LOCK_DAYS - elapsed)
}

export function isSellLocked(holding: Holding, now = new Date()) {
  if (holding.acquiredAt) return getSellLockRemainingDays(holding, now) > 0
  if (holding.lock) return true
  return false
}

export function getSellableDate(holding: Holding): string | null {
  const acquired = parseDate(holding.acquiredAt)
  if (!acquired) return null
  const sellable = new Date(acquired)
  sellable.setDate(sellable.getDate() + STOCK_SELL_LOCK_DAYS)
  const y = sellable.getFullYear()
  const m = String(sellable.getMonth() + 1).padStart(2, '0')
  const d = String(sellable.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
