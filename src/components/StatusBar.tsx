import { useAppStore } from '../store/useAppStore'
import { selectTotalEval, selectTotalPnl, selectIsLoading, selectStatusColor } from '../store/selectors'

export function StatusBar() {
  const system    = useAppStore(s => s.system)
  const market    = useAppStore(s => s.market)
  const totalEval = useAppStore(selectTotalEval)
  const totalPnl  = useAppStore(selectTotalPnl)
  const isLoading = useAppStore(selectIsLoading)
  const statusColor = useAppStore(selectStatusColor)
  const refresh   = useAppStore(s => s.refreshAllData)

  const fmt = (n: number) => n >= 1e6
    ? `¥${(n/1e6).toFixed(2)}M`
    : `¥${(n/1000).toFixed(0)}K`

  return (
    <div style={{
      background:'#0c1220', borderBottom:'1px solid #22304a',
      padding:'8px 16px', display:'flex', alignItems:'center', gap:16, flexWrap:'wrap',
      fontFamily:'Courier New,monospace', fontSize:11,
    }}>
      <span style={{color:'#2dd4a0', fontWeight:700, fontSize:13}}>
        JP株 Decision OS <span style={{color:'#d4a017'}}>v8.1</span>
      </span>
      <span style={{color:'#4a6070'}}>|</span>
      <span style={{color:'#dce6f0'}}>株式 {fmt(totalEval)}</span>
      <span style={{color: totalPnl >= 0 ? '#2dd4a0' : '#e8405a'}}>
        {totalPnl >= 0 ? '+' : ''}{fmt(totalPnl)}
      </span>
      <span style={{color:'#4a6070'}}>|</span>
      <span style={{color:'#dce6f0'}}>日経 {market.nikkei.toLocaleString()}</span>
      <span style={{color: market.nikkeiChgPct >= 0 ? '#2dd4a0' : '#e8405a'}}>
        {market.nikkeiChgPct >= 0 ? '+' : ''}{market.nikkeiChgPct.toFixed(2)}%
      </span>
      <span style={{color:'#4a6070'}}>VIX {market.vix}</span>
      <span style={{color:'#4a6070'}}>|</span>
      <span style={{
        background: market.regime === 'bull' ? 'rgba(45,212,160,.15)' :
                    market.regime === 'bear' ? 'rgba(232,64,90,.15)' : 'rgba(104,150,200,.1)',
        color: market.regime === 'bull' ? '#2dd4a0' : market.regime === 'bear' ? '#e8405a' : '#6896c8',
        border: `1px solid currentColor`, borderRadius:4, padding:'2px 8px',
      }}>{market.regime.toUpperCase()}</span>
      <span style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:8}}>
        <span style={{
          width:8, height:8, borderRadius:'50%',
          background: statusColor,
          boxShadow: isLoading ? `0 0 6px ${statusColor}` : 'none',
          display:'inline-block',
          animation: isLoading ? 'pulse 1s infinite' : 'none',
        }}/>
        <span style={{color:'#4a6070'}}>
          {system.status === 'loading' ? '更新中...' :
           system.lastUpdated ? `更新: ${system.lastUpdated.slice(11,16)}` : 'staticモード'}
        </span>
        <button
          onClick={refresh}
          disabled={isLoading}
          style={{
            background:'rgba(104,150,200,.1)', border:'1px solid #3a5a8a',
            color:'#6896c8', borderRadius:4, padding:'3px 10px', cursor:'pointer',
            fontFamily:'inherit', fontSize:11, opacity: isLoading ? 0.5 : 1,
          }}
        >↺ 更新</button>
        {system.dataSourceStatus.correlation === 'loaded' &&
          <span style={{color:'#2dd4a0', fontSize:10}}>相関✓</span>}
        {system.dataSourceStatus.news === 'loaded' &&
          <span style={{color:'#2dd4a0', fontSize:10}}>ニュース✓</span>}
      </span>
    </div>
  )
}
