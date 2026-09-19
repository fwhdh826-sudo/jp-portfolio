// UI-9I Phase 1: PF 面（Full Portfolio）の view-model。
// 権限: AllocationConsumerSnapshot.classes（canonical 順）と executable cash 権限。
import type { AppState } from '../../types'
import { selectAllocationConsumerSnapshot, selectExecutableDeployableCash } from '../../store/allocationConsumerSelectors'
import { formatJstMonthDayTime } from './formatters'
import { projectPortfolio, type PortfolioProjection } from './portfolioPresentation'
import { projectGrossCash, type DeployableCashViewModel, type GrossCashViewModel } from './todayHome'

export interface PortfolioSurfaceViewModel {
  /** null = 配分スナップショット利用不可（判定不能）。 */
  readonly portfolio: PortfolioProjection | null
  readonly snapshotLabel: string | null
  readonly grossCash: GrossCashViewModel
  readonly deployableCash: DeployableCashViewModel
}

export function selectPortfolioSurfaceViewModel(state: AppState): PortfolioSurfaceViewModel {
  const snapshot = selectAllocationConsumerSnapshot(state)
  const cash = selectExecutableDeployableCash(state)
  return {
    portfolio: projectPortfolio(snapshot),
    snapshotLabel: snapshot.availability === 'available' ? formatJstMonthDayTime(snapshot.generation.generatedAt) : null,
    grossCash: projectGrossCash(state),
    deployableCash: cash.available ? { kind: 'available', amountJpy: cash.amount } : { kind: 'unavailable' },
  }
}
