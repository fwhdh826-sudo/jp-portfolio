import type { LimitingFactor } from '../../types/allocationPlan'

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
}

export function toIntegerJpy(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

export function isRatio01(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function clampRatio01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function roundDownToUnit(amountJpy: number, unitJpy: number): number {
  if (!isNonNegativeInteger(amountJpy) || !isNonNegativeInteger(unitJpy) || unitJpy <= 0) {
    return 0
  }
  return Math.floor(amountJpy / unitJpy) * unitJpy
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

export function limitingFactorsForMinimum(
  terms: readonly { factor: LimitingFactor; amount: number }[],
): LimitingFactor[] {
  if (terms.length === 0) return []
  const minimum = Math.min(...terms.map(({ amount }) => amount))
  return unique(terms.filter(({ amount }) => amount === minimum).map(({ factor }) => factor))
}

export function allValidMoney(values: readonly (number | null)[]): boolean {
  return values.every((value) => value === null || isNonNegativeInteger(value))
}
