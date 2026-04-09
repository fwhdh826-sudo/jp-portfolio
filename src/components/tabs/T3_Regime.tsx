import { useAppStore } from '../../store/useAppStore'

export function T3_Regime() {
  const market  = useAppStore(s => s.market)
  const metrics = useAppStore(s => s.metrics)
  const analysis = useAppStore(s => s.analysis)

  const regimeColor = market.regime === 'bull' ? '#2dd4a0' : market.regime === 'bear' ? '#e8405a' : '#6896c8'

  const rsiColor = market.rsi14 > 70 ? '#e8405a' : market.rsi14 < 30 ? '#2dd4a0' : '#d4a017'

  // スコア分布
  const dist = { buy:0, hold:0, sell:0 }
  analysis.forEach(a => {
    if (a.decision === 'BUY') dist.buy++
    else if (a.decision === 'SELL') dist.sell++
    else dist.hold++
  })
  const total = analysis.length || 1

  return (
    <div style={{padding:16}}>
      {/* レジームカード */}
      <div style={{
        background:`${regimeColor}11`, border:`1px solid ${regimeColor}44`, borderRadius:10,
        padding:'16px 20px', marginBottom:16, display:'flex', alignItems:'center', gap:20,
      }}>
        <div>
          <div style={{fontSize:10, color:'#4a6070', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:4}}>現在レジーム</div>
          <div style={{fontFamily:'monospace', fontSize:28, fontWeight:700, color: regimeColor}}>
            {market.regime.toUpperCase()}
          </div>
        </div>
        <div style={{flex:1, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
          <div style={{background:'rgba(255,255,255,.04)', borderRadius:6, padding:'8px 12px'}}>
            <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>日経225</div>
            <div style={{fontFamily:'monospace', color:'#dce6f0'}}>{market.nikkei.toLocaleString()}</div>
          </div>
          <div style={{background:'rgba(255,255,255,.04)', borderRadius:6, padding:'8px 12px'}}>
            <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>VIX</div>
            <div style={{fontFamily:'monospace', color: market.vix > 25 ? '#e8405a' : '#dce6f0'}}>{market.vix}</div>
          </div>
          <div style={{background:'rgba(255,255,255,.04)', borderRadius:6, padding:'8px 12px'}}>
            <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>RSI(14)</div>
            <div style={{fontFamily:'monospace', color: rsiColor}}>{market.rsi14}</div>
          </div>
          <div style={{background:'rgba(255,255,255,.04)', borderRadius:6, padding:'8px 12px'}}>
            <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>MACD</div>
            <div style={{fontFamily:'monospace', color: market.macd === 'golden' ? '#2dd4a0' : '#e8405a'}}>
              {market.macd === 'golden' ? 'ゴールデン' : 'デッド'}クロス
            </div>
          </div>
        </div>
      </div>

      {/* MA水準 */}
      <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:8, padding:'12px 16px', marginBottom:16}}>
        <div style={{fontSize:11, color:'#4a6070', marginBottom:10, textTransform:'uppercase', letterSpacing:'.06em'}}>移動平均</div>
        {[
          { label:'MA5',  val:market.ma5,  isAbove: market.nikkei > market.ma5 },
          { label:'MA25', val:market.ma25, isAbove: market.nikkei > market.ma25 },
          { label:'MA75', val:market.ma75, isAbove: market.nikkei > market.ma75 },
        ].map(m => (
          <div key={m.label} style={{display:'flex', alignItems:'center', gap:10, marginBottom:6}}>
            <span style={{fontFamily:'monospace', fontSize:11, color:'#4a6070', width:40}}>{m.label}</span>
            <span style={{fontFamily:'monospace', fontSize:12, color:'#dce6f0'}}>{m.val.toLocaleString()}</span>
            <span style={{fontSize:10, color: m.isAbove ? '#2dd4a0' : '#e8405a'}}>
              {m.isAbove ? '▲ 上位' : '▼ 下位'}
            </span>
          </div>
        ))}
      </div>

      {/* BOJ */}
      <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:8, padding:'12px 16px', marginBottom:16}}>
        <div style={{fontSize:11, color:'#4a6070', marginBottom:8, textTransform:'uppercase', letterSpacing:'.06em'}}>BOJ金利</div>
        <div style={{display:'flex', gap:20}}>
          <div><span style={{color:'#4a6070', fontSize:11}}>現在: </span><span style={{fontFamily:'monospace', color:'#dce6f0'}}>{market.boj}</span></div>
          <div><span style={{color:'#4a6070', fontSize:11}}>次回観測: </span><span style={{fontFamily:'monospace', color:'#d4a017'}}>{market.bojNext}</span></div>
        </div>
      </div>

      {/* スコア分布 */}
      {metrics && (
        <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:8, padding:'12px 16px'}}>
          <div style={{fontSize:11, color:'#4a6070', marginBottom:10, textTransform:'uppercase', letterSpacing:'.06em'}}>ポートフォリオ分析精度</div>
          <div style={{display:'flex', gap:12, marginBottom:8}}>
            {[
              { label:'BUY', n:dist.buy, color:'#2dd4a0' },
              { label:'HOLD', n:dist.hold, color:'#6896c8' },
              { label:'SELL', n:dist.sell, color:'#e8405a' },
            ].map(d => (
              <div key={d.label} style={{flex:1, background:`${d.color}11`, border:`1px solid ${d.color}33`, borderRadius:7, padding:'10px 12px', textAlign:'center'}}>
                <div style={{fontFamily:'monospace', fontSize:18, fontWeight:700, color:d.color}}>{d.n}</div>
                <div style={{fontSize:9, color:'#4a6070', marginTop:2}}>{d.label} / {total}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11, color:'#4a6070', display:'flex', gap:20, flexWrap:'wrap'}}>
            <span>Sharpe: <span style={{fontFamily:'monospace', color:'#dce6f0'}}>{metrics.sharpe.toFixed(2)}</span></span>
            <span>Sortino: <span style={{fontFamily:'monospace', color:'#dce6f0'}}>{metrics.sortino.toFixed(2)}</span></span>
            <span>CVaR95%: <span style={{fontFamily:'monospace', color:'#e8405a'}}>{(metrics.cvar*100).toFixed(1)}%</span></span>
          </div>
        </div>
      )}
    </div>
  )
}
