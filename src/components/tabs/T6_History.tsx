import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

interface HistoryEntry {
  ts: string
  event: string
  detail: string
}

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem('v81_history') || '[]') as HistoryEntry[]
  } catch { return [] }
}

export function T6_History() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const system = useAppStore(s => s.system)

  const history = loadHistory()

  // システムイベントを疑似履歴として表示
  const events: HistoryEntry[] = [
    ...(system.lastUpdated ? [{ ts: system.lastUpdated, event: 'データ更新', detail: `市場:${system.dataSourceStatus.market} 相関:${system.dataSourceStatus.correlation} ニュース:${system.dataSourceStatus.news}` }] : []),
    ...(system.csvLastImportedAt ? [{ ts: system.csvLastImportedAt, event: 'CSV取込', detail: 'SBI証券CSVを取込みました' }] : []),
    ...history,
  ].sort((a, b) => b.ts.localeCompare(a.ts))

  const toggle = (i: number) => {
    const next = new Set(expanded)
    next.has(i) ? next.delete(i) : next.add(i)
    setExpanded(next)
  }

  return (
    <div style={{padding:16}}>
      <div style={{fontSize:12, color:'#4a6070', marginBottom:12}}>
        操作履歴（折りたたみ）— ローカル保持
      </div>

      {events.length === 0 && (
        <div style={{color:'#4a6070', textAlign:'center', padding:40, fontSize:12}}>
          履歴がありません
        </div>
      )}

      {events.map((e, i) => (
        <div key={i} style={{background:'#111828', border:'1px solid #22304a', borderRadius:7, marginBottom:6, overflow:'hidden'}}>
          <button
            onClick={() => toggle(i)}
            style={{
              width:'100%', textAlign:'left', background:'none', border:'none',
              padding:'10px 14px', cursor:'pointer', display:'flex', alignItems:'center', gap:12,
            }}
          >
            <span style={{fontFamily:'monospace', fontSize:10, color:'#4a6070'}}>
              {e.ts.slice(0,19).replace('T',' ')}
            </span>
            <span style={{fontSize:12, color:'#dce6f0', fontWeight:600}}>{e.event}</span>
            <span style={{marginLeft:'auto', color:'#4a6070', fontSize:12}}>{expanded.has(i) ? '▲' : '▼'}</span>
          </button>
          {expanded.has(i) && (
            <div style={{padding:'0 14px 12px', fontSize:11, color:'#9ab0c8', borderTop:'1px solid #141e30'}}>
              {e.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
