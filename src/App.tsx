import { useEffect, useRef } from 'react'
import { useAppStore } from './store/useAppStore'
import { StatusBar } from './components/StatusBar'
import { TabNav } from './components/TabNav'
import { T1_Decision } from './components/tabs/T1_Decision'
import { T2_Holdings } from './components/tabs/T2_Holdings'
import { T3_Regime } from './components/tabs/T3_Regime'
import { T4_Correlation } from './components/tabs/T4_Correlation'
import { T5_Backtest } from './components/tabs/T5_Backtest'
import { T6_History } from './components/tabs/T6_History'
import { T7_Trust } from './components/tabs/T7_Trust'
import './styles/v5.css'

function ActiveTabPanel() {
  const activeTab = useAppStore(s => s.activeTab)

  if (activeTab === 'T1') return <T1_Decision />
  if (activeTab === 'T2') return <T2_Holdings />
  if (activeTab === 'T3') return <T3_Regime />
  if (activeTab === 'T4') return <T4_Correlation />
  if (activeTab === 'T5') return <T5_Backtest />
  if (activeTab === 'T6') return <T6_History />
  return <T7_Trust />
}

export function App() {
  const initialize = useAppStore(s => s.initialize)
  const activeTab = useAppStore(s => s.activeTab)
  const scrollRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [activeTab])

  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand__eyebrow">JP Equity Decision OS</div>
          <div className="sidebar-brand__title">Portfolio Control Room</div>
          <div className="sidebar-brand__copy">
            見る順番、判断順、実行順をそろえた運用ワークスペースです。
          </div>
        </div>
        <TabNav variant="sidebar" />
      </aside>

      <div className="shell-main">
        <StatusBar />
        <main
          ref={node => {
            scrollRef.current = node
          }}
          className="app-scroll-area"
        >
          <div className="workspace-content">
            <ActiveTabPanel />
          </div>
        </main>
      </div>

      <TabNav variant="dock" />
    </div>
  )
}
