import { useAppStore } from '../../store/useAppStore'
import { selectDecisionAuditViewModel } from '../../presentation/ui9i/decisionAudit'
import { DecisionAuditView } from './DecisionAudit'
import { useGoTo } from './useGoTo'

export function DecisionAudit() {
  const vm = useAppStore(state => selectDecisionAuditViewModel(state))
  const goTo = useGoTo()
  return (
    <div className="u9">
      <DecisionAuditView
        vm={vm}
        actions={{
          onBack: () => goTo({ tab: 'T0', surface: null }),
          onOpenCommittee: () => goTo({ tab: 'T6', surface: null }),
          onOpenStocks: () => goTo({ tab: 'T1', surface: null }),
          onOpenPortfolio: () => goTo({ tab: null, surface: 'pf' }),
        }}
      />
    </div>
  )
}
