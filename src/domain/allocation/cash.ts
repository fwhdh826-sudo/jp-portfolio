import type { BudgetInput, CashInput, CashModel, SafetyState } from '../../types/allocationPlan'
import { isNonNegativeInteger, toIntegerJpy, unique } from './numeric'

export function deriveCashModel(
  input: CashInput,
  budgets: BudgetInput,
  safety: SafetyState,
): CashModel {
  const blockedReasons: CashModel['blockedReasons'] = []
  const warnings: CashModel['warnings'] = []

  if (input.grossCash === null) blockedReasons.push('CASH_AUTHORITY_UNAVAILABLE')
  if (safety.cash === 'unknown') blockedReasons.push('CASH_AUTHORITY_UNAVAILABLE')
  if (safety.cash === 'stale') blockedReasons.push('CASH_AUTHORITY_STALE')
  if (input.grossCash !== null && input.grossCash < 0) blockedReasons.push('CASH_NEGATIVE')
  if (input.pendingOrderCash === null || safety.pendingOrders === 'unknown') {
    warnings.push('PENDING_ORDER_AUTHORITY_UNAVAILABLE')
  }

  const numericValues = [
    input.grossCash ?? 0,
    input.safetyReserve,
    input.pendingOrderCash ?? 0,
    input.dataUncertaintyReserve,
    budgets.shortTermBudget,
    budgets.longTermBudget,
  ]
  if (!numericValues.every(isNonNegativeInteger)) blockedReasons.push('INVALID_NUMERIC_INPUT')

  const grossCash = toIntegerJpy(input.grossCash ?? 0)
  const safetyReserve = toIntegerJpy(input.safetyReserve)
  const pendingOrderCash = toIntegerJpy(input.pendingOrderCash ?? 0)
  let dataUncertaintyReserve = toIntegerJpy(input.dataUncertaintyReserve)

  if (safety.cash === 'stale' || safety.holdings === 'stale' || safety.crossTab === 'stale') {
    dataUncertaintyReserve = grossCash
  }

  const deployableCash = blockedReasons.length > 0
    ? 0
    : Math.max(0, grossCash - safetyReserve - pendingOrderCash - dataUncertaintyReserve)
  const requestedShort = toIntegerJpy(budgets.shortTermBudget)
  const shortTermBudget = Math.min(deployableCash, requestedShort)
  const longTermBudget = deployableCash - shortTermBudget

  return {
    grossCash,
    safetyReserve,
    pendingOrderCash,
    dataUncertaintyReserve,
    shortTermBudget,
    longTermBudget,
    deployableCash,
    blockedReasons: unique(blockedReasons),
    warnings: unique(warnings),
  }
}
