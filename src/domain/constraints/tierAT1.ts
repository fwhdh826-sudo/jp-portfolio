import type { Holding } from '../../types'
import { isSellLocked } from './stockLock'

// P4-A150: Tier A T1 — ストップロス -40%（PRINCIPLES.md §3 T1）。
// 「含み損 ≤ -40% は強制売却ルール対象」を検出するfrontend表示専用チェック。
// 自動売却・自動売買は行わない。3ヶ月ロック中でも検出は消さない（最終判断は人間）。
export const TIER_A_T1_STOP_LOSS_PCT = -40

export interface TierAT1Violation {
  code: string
  name: string
  pnlPct: number
  eval: number
  acquiredAt?: string
  locked: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * checkTierAT1Violations — 保有銘柄のうちpnlPct <= TIER_A_T1_STOP_LOSS_PCT(-40%)を
 * Tier A T1違反として抽出する。pnlPctが数値でない場合は対象外（fail-safeに検出しない）。
 * ロック中銘柄も対象から除外しない — Tier A T1はロックより優先して人間に警告する。
 */
export function checkTierAT1Violations(holdings: Holding[]): TierAT1Violation[] {
  return holdings
    .filter(h => isFiniteNumber(h.pnlPct) && h.pnlPct <= TIER_A_T1_STOP_LOSS_PCT)
    .map(h => ({
      code: h.code,
      name: h.name,
      pnlPct: h.pnlPct,
      eval: h.eval,
      acquiredAt: h.acquiredAt,
      locked: isSellLocked(h),
    }))
}
