import { useEffect } from 'react'
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

const STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; background: #080c14; color: #dce6f0;
    font-family: 'Helvetica Neue', sans-serif; font-size: 14px; line-height: 1.6; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: #0c1220; }
  ::-webkit-scrollbar-thumb { background: #22304a; border-radius: 3px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
`

export function App() {
  const initialize = useAppStore(s => s.initialize)
  const activeTab  = useAppStore(s => s.activeTab)

  useEffect(() => { initialize() }, [initialize])

  return (
    <>
      <style>{STYLE}</style>
      <div style={{display:'flex', flexDirection:'column', height:'100vh', minHeight:0}}>
        <StatusBar />
        <TabNav />
        <div style={{flex:1, overflowY:'auto', minHeight:0}}>
          {activeTab === 'T1' && <T1_Decision />}
          {activeTab === 'T2' && <T2_Holdings />}
          {activeTab === 'T3' && <T3_Regime />}
          {activeTab === 'T4' && <T4_Correlation />}
          {activeTab === 'T5' && <T5_Backtest />}
          {activeTab === 'T6' && <T6_History />}
          {activeTab === 'T7' && <T7_Trust />}
        </div>
      </div>
    </>
  )
}
