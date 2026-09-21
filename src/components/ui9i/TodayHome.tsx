// UI-9I Phase 1: T0（今日）container。store → view-model → 純表示 view。
import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTodayHomeViewModel } from '../../presentation/ui9i/todayHome'
import { formatJstHeaderDate, formatJstHeaderYear } from '../../presentation/ui9i/formatters'
import { TodayHomeView } from './TodayHomeView'
import { useGoTo } from './useGoTo'

export function TodayHome() {
  // 権限読み取りは selectTodayHomeViewModel に集約（React 側で意味を再導出しない）。
  const vm = useAppStore(state => selectTodayHomeViewModel(state))
  const goTo = useGoTo()
  const { dateLabel, yearLabel } = useMemo(() => {
    const now = new Date()
    return { dateLabel: formatJstHeaderDate(now), yearLabel: formatJstHeaderYear(now) }
  }, [])
  return (
    <div className="u9">
      <TodayHomeView
        vm={vm}
        dateLabel={dateLabel}
        yearLabel={yearLabel}
        actions={{
          onOpenAudit: () => goTo({ tab: null, surface: 'audit' }),
          onOpenPortfolio: () => goTo({ tab: null, surface: 'pf' }),
          onOpenCandidates: () => goTo({ tab: 'T1', surface: null }),
        }}
      />
    </div>
  )
}
