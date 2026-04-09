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

const TABS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const

export function App() {
  const initialize  = useAppStore(s => s.initialize)
  const activeTab   = useAppStore(s => s.activeTab)
  const setTab      = useAppStore(s => s.setTab)
  const scrollRef   = useRef<HTMLDivElement>(null)

  useEffect(() => { initialize() }, [initialize])

  // ── スワイプでタブ切替 ──────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let startX = 0
    let startY = 0

    const onStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
    }
    const onEnd = (e: TouchEvent) => {
      const dX = e.changedTouches[0].clientX - startX
      const dY = e.changedTouches[0].clientY - startY
      if (Math.abs(dX) > 60 && Math.abs(dY) < 50) {
        const cur = TABS.indexOf(activeTab)
        if (dX < 0 && cur < TABS.length - 1) setTab(TABS[cur + 1])
        if (dX > 0 && cur > 0) setTab(TABS[cur - 1])
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend', onEnd)
    }
  }, [activeTab, setTab])

  return (
    <>
      <StatusBar />

      {/* スワイプ位置インジケーター */}
      <div className="swipe-indicator">
        {TABS.map(t => (
          <div
            key={t}
            className={`swipe-ind-dot${t === activeTab ? ' active' : ''}`}
          />
        ))}
      </div>

      {/* メインスクロールエリア */}
      <div className="app-scroll-area" ref={scrollRef}>
        {activeTab === 'T1' && <T1_Decision />}
        {activeTab === 'T2' && <T2_Holdings />}
        {activeTab === 'T3' && <T3_Regime />}
        {activeTab === 'T4' && <T4_Correlation />}
        {activeTab === 'T5' && <T5_Backtest />}
        {activeTab === 'T6' && <T6_History />}
        {activeTab === 'T7' && <T7_Trust />}
      </div>

      {/* ボトムナビ（fixed） */}
      <TabNav />
    </>
  )
}
