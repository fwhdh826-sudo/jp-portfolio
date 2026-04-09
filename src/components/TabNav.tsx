import { useAppStore } from '../store/useAppStore'
import type { TabId } from '../types'

const TABS: { id: TabId; label: string }[] = [
  { id:'T1', label:'判断' },
  { id:'T2', label:'保有' },
  { id:'T3', label:'レジーム' },
  { id:'T4', label:'相関' },
  { id:'T5', label:'BT' },
  { id:'T6', label:'履歴' },
  { id:'T7', label:'投信' },
]

export function TabNav() {
  const active  = useAppStore(s => s.activeTab)
  const setTab  = useAppStore(s => s.setTab)

  return (
    <div style={{
      display:'flex', background:'#0c1220', borderBottom:'2px solid #22304a',
      overflowX:'auto', flexShrink:0,
    }}>
      {TABS.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          padding:'10px 18px', fontFamily:'inherit', fontSize:12, fontWeight:600,
          cursor:'pointer', whiteSpace:'nowrap', border:'none', borderBottom: active === t.id ? '2px solid #2dd4a0' : '2px solid transparent',
          background: active === t.id ? 'rgba(45,212,160,.07)' : 'transparent',
          color: active === t.id ? '#2dd4a0' : '#4a6070',
          transition:'all 0.15s',
        }}>{t.id} {t.label}</button>
      ))}
    </div>
  )
}
