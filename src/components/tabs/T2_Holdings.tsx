import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'

export function T2_Holdings() {
  const holdings   = useAppStore(s => s.holdings)
  const analysis   = useAppStore(s => s.analysis)
  const metrics    = useAppStore(s => s.metrics)
  const totalEval  = useAppStore(selectTotalEval)

  const decisionColor = (d: string) =>
    d === 'BUY' ? '#2dd4a0' : d === 'SELL' ? '#e8405a' : '#6896c8'

  return (
    <div style={{padding:16}}>
      {/* ポートフォリオ指標 */}
      {metrics && (
        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:16}}>
          {[
            { label:'期待リターン', val:`${(metrics.mu*100).toFixed(1)}%`, color: metrics.mu>=0?'#2dd4a0':'#e8405a' },
            { label:'σ',          val:`${(metrics.sigma*100).toFixed(1)}%`, color:'#dce6f0' },
            { label:'Sharpe',     val:metrics.sharpe.toFixed(2), color: metrics.sharpe>=1?'#2dd4a0':metrics.sharpe>=0.5?'#d4a017':'#e8405a' },
            { label:'最大DD(推定)',val:`${(metrics.mdd*100).toFixed(1)}%`, color:'#e8405a' },
          ].map(m => (
            <div key={m.label} style={{background:'#111828', border:'1px solid #22304a', borderRadius:7, padding:'10px 12px'}}>
              <div style={{fontSize:9, color:'#4a6070', letterSpacing:'.06em', textTransform:'uppercase', marginBottom:4}}>{m.label}</div>
              <div style={{fontFamily:'monospace', fontSize:14, fontWeight:700, color:m.color}}>{m.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* 保有一覧テーブル */}
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%', borderCollapse:'collapse', fontSize:12}}>
          <thead>
            <tr style={{background:'#111828', color:'#4a6070', fontSize:10, textTransform:'uppercase', letterSpacing:'.04em'}}>
              {['銘柄','評価額','損益率','比率','スコア','σ','判定'].map(h => (
                <th key={h} style={{padding:'8px 10px', textAlign:'left', borderBottom:'2px solid #22304a'}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {holdings.map(h => {
              const a = analysis.find(x => x.code === h.code)
              const w = totalEval > 0 ? (h.eval / totalEval * 100).toFixed(1) : '0.0'
              const decision = a?.decision ?? 'HOLD'
              return (
                <tr key={h.code} style={{borderBottom:'1px solid #141e30'}}>
                  <td style={{padding:'9px 10px'}}>
                    <div style={{color:'#dce6f0', fontWeight:600}}>{h.code}</div>
                    <div style={{fontSize:9, color:'#4a6070'}}>{h.name}</div>
                  </td>
                  <td style={{padding:'9px 10px', fontFamily:'monospace', color:'#dce6f0'}}>
                    ¥{(h.eval/1000).toFixed(0)}K
                  </td>
                  <td style={{padding:'9px 10px', fontFamily:'monospace', color: h.pnlPct>=0?'#2dd4a0':'#e8405a'}}>
                    {h.pnlPct>=0?'+':''}{h.pnlPct.toFixed(2)}%
                  </td>
                  <td style={{padding:'9px 10px', fontFamily:'monospace', color: parseFloat(w)>15?'#e8405a':'#9ab0c8'}}>
                    {w}%
                  </td>
                  <td style={{padding:'9px 10px', fontFamily:'monospace', color:'#dce6f0'}}>
                    {a?.totalScore ?? '─'}
                  </td>
                  <td style={{padding:'9px 10px', fontFamily:'monospace', color:'#9ab0c8'}}>
                    {(h.sigma*100).toFixed(1)}%
                    <span style={{fontSize:8, color:'#4a6070', marginLeft:3}}>
                      {h.sigmaSource==='yfinance'?'実':'推'}
                    </span>
                  </td>
                  <td style={{padding:'9px 10px'}}>
                    <span style={{
                      fontFamily:'monospace', fontSize:10, fontWeight:700,
                      color: decisionColor(decision),
                      background:`${decisionColor(decision)}18`,
                      border:`1px solid ${decisionColor(decision)}44`,
                      borderRadius:4, padding:'2px 7px',
                    }}>{h.lock ? '🔒' : decision}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
