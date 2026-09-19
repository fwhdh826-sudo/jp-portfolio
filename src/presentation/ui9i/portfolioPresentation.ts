// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: Portfolio 共有 presentation adapter。
//
// 権限: AllocationConsumerSnapshot.classes（canonical 順）。
// 提供するもの: 日本語クラス名 / 表示用の現在比率 / 方向ラベル。
//
// 方向は canonical フィールドのみで決める:
//   targetGap > 0        → 不足
//   overweightAmount > 0 → 超過
//   両方 0               → 目標水準
//   それ以外（非有限・負値・両方正）→ 判定不能
// 「大きな乖離」「小さな乖離」「ほぼ目標」等の閾値表現は作らない。
// このアダプタは投資判断には使わない（表示専用）。
// ═══════════════════════════════════════════════════════════
import type { AllocationConsumerSnapshot } from '../../types/allocationConsumer'
import type { AssetClass } from '../../types/allocationPlan'
import { ASSET_CLASS_LABEL, UNDETERMINABLE_LABEL } from './labels'

export type PortfolioDirection = 'shortfall' | 'excess' | 'on_target' | 'undeterminable'

export const PORTFOLIO_DIRECTION_LABEL: Record<PortfolioDirection, string> = {
  shortfall: '不足',
  excess: '超過',
  on_target: '目標水準',
  undeterminable: UNDETERMINABLE_LABEL,
}

export interface PortfolioClassRow {
  readonly assetClass: AssetClass
  readonly label: string
  readonly currentAmount: number
  readonly targetAmount: number
  /** 表示専用: currentAmount / totalAssets * 100。totalAssets 不正時は null。 */
  readonly currentRatioPct: number | null
  /** canonical targetRatio（0..1）を % 換算しただけの値。 */
  readonly targetRatioPct: number | null
  readonly direction: PortfolioDirection
  readonly directionLabel: string
  /** direction が shortfall なら targetGap、excess なら overweightAmount、他は null。 */
  readonly gapAmount: number | null
}

export interface PortfolioProjection {
  readonly totalAssets: number
  /** canonical 順（snapshot.classes の順）をそのまま保持する。並べ替えない。 */
  readonly rows: readonly PortfolioClassRow[]
}

const isFiniteNonNegative = (n: number): boolean => Number.isFinite(n) && n >= 0

export function resolvePortfolioDirection(targetGap: number, overweightAmount: number): PortfolioDirection {
  if (!isFiniteNonNegative(targetGap) || !isFiniteNonNegative(overweightAmount)) return 'undeterminable'
  if (targetGap > 0 && overweightAmount > 0) return 'undeterminable'
  if (targetGap > 0) return 'shortfall'
  if (overweightAmount > 0) return 'excess'
  return 'on_target'
}

export function projectPortfolio(snapshot: AllocationConsumerSnapshot): PortfolioProjection | null {
  if (snapshot.availability !== 'available') return null
  const totalAssets = snapshot.totalAssets
  const ratioBase = Number.isFinite(totalAssets) && totalAssets > 0 ? totalAssets : null
  const rows = snapshot.classes.map((c): PortfolioClassRow => {
    const direction = resolvePortfolioDirection(c.targetGap, c.overweightAmount)
    return {
      assetClass: c.assetClass,
      label: ASSET_CLASS_LABEL[c.assetClass] ?? c.assetClass,
      currentAmount: c.currentAmount,
      targetAmount: c.targetAmount,
      currentRatioPct: ratioBase === null || !Number.isFinite(c.currentAmount)
        ? null
        : (c.currentAmount / ratioBase) * 100,
      targetRatioPct: Number.isFinite(c.targetRatio) ? c.targetRatio * 100 : null,
      direction,
      directionLabel: PORTFOLIO_DIRECTION_LABEL[direction],
      gapAmount: direction === 'shortfall' ? c.targetGap : direction === 'excess' ? c.overweightAmount : null,
    }
  })
  return { totalAssets, rows }
}
