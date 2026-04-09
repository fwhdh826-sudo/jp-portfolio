import { useAppStore } from '../../store/useAppStore'

export function T4_Correlation() {
  const corr     = useAppStore(s => s.correlation)
  const holdings = useAppStore(s => s.holdings)

  if (!corr) {
    return (
      <div style={{padding:16, color:'#4a6070', textAlign:'center', paddingTop:60}}>
        <div style={{fontSize:13, marginBottom:8}}>相関データ未ロード</div>
        <div style={{fontSize:11}}>GitHub Actions が毎平日 8:30 JST に自動生成します</div>
        <div style={{fontSize:10, marginTop:6, color:'#22304a'}}>（staticモード: 相関行列なし）</div>
      </div>
    )
  }

  const matrix  = corr.matrix

  const corrVal = (ci: string, cj: string): number => {
    const ki = ci + '.T', kj = cj + '.T'
    return matrix[ki]?.[kj] ?? 0
  }

  const corrColor = (v: number) => {
    if (v >= 0.7) return '#e8405a'
    if (v >= 0.4) return '#d4a017'
    if (v <= -0.1) return '#2dd4a0'
    return '#4a6070'
  }

  const codes = holdings.map(h => h.code)

  return (
    <div style={{padding:16}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
        <div style={{fontSize:12, color:'#4a6070'}}>
          更新: {corr.last_updated} / 期間: {corr.period}
        </div>
        <div style={{fontSize:11, color:'#2dd4a0'}}>yfinance 実測相関行列</div>
      </div>

      {/* ヒートマップ（スクロール可） */}
      <div style={{overflowX:'auto', overflowY:'auto', maxHeight:'65vh'}}>
        <table style={{borderCollapse:'collapse', fontSize:10, fontFamily:'monospace'}}>
          <thead>
            <tr>
              <th style={{padding:'4px 6px', color:'#4a6070'}}></th>
              {codes.map(c => (
                <th key={c} style={{padding:'4px 6px', color:'#9ab0c8', writingMode:'vertical-rl', textOrientation:'mixed', height:60}}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map(ci => {
              const hi = holdings.find(h => h.code === ci)
              return (
                <tr key={ci}>
                  <td style={{padding:'4px 8px', color:'#9ab0c8', whiteSpace:'nowrap', fontSize:9}}>
                    {ci} {hi?.name?.slice(0,5)}
                  </td>
                  {codes.map(cj => {
                    const v = corrVal(ci, cj)
                    return (
                      <td key={cj} style={{
                        padding:'3px 4px', textAlign:'center',
                        background: ci === cj ? '#2dd4a011' :
                          v >= 0.7 ? 'rgba(232,64,90,.25)' :
                          v >= 0.4 ? 'rgba(212,160,23,.18)' :
                          v <= -0.1 ? 'rgba(45,212,160,.15)' : 'transparent',
                        color: corrColor(v), fontWeight: ci === cj ? 700 : 400,
                      }}>
                        {ci === cj ? '1.0' : v.toFixed(2)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div style={{display:'flex', gap:16, marginTop:12, fontSize:10, flexWrap:'wrap'}}>
        {[
          { label:'高相関 ≥0.7', color:'#e8405a' },
          { label:'中相関 ≥0.4', color:'#d4a017' },
          { label:'低相関 <0.4', color:'#4a6070' },
          { label:'負相関 <0',   color:'#2dd4a0' },
        ].map(l => (
          <div key={l.label} style={{display:'flex', alignItems:'center', gap:4}}>
            <div style={{width:10, height:10, borderRadius:2, background:l.color + '44', border:`1px solid ${l.color}`}}/>
            <span style={{color:'#4a6070'}}>{l.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
