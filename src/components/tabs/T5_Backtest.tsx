import { useAppStore } from '../../store/useAppStore'

// バックテスト結果はlocalStorageに蓄積（将来拡張用）
// 現時点は analysis の判定分布を表示
export function T5_Backtest() {
  const analysis = useAppStore(s => s.analysis)
  const metrics  = useAppStore(s => s.metrics)
  const system   = useAppStore(s => s.system)

  const buy  = analysis.filter(a => a.decision === 'BUY')
  const hold = analysis.filter(a => a.decision === 'HOLD')
  const sell = analysis.filter(a => a.decision === 'SELL')

  const avgEV  = analysis.length > 0
    ? (analysis.reduce((s, a) => s + a.ev, 0) / analysis.length * 100).toFixed(2)
    : '─'
  const avgConf = analysis.length > 0
    ? (analysis.reduce((s, a) => s + a.confidence, 0) / analysis.length * 100).toFixed(0)
    : '─'

  return (
    <div style={{padding:16}}>
      <div style={{fontSize:11, color:'#4a6070', marginBottom:12}}>
        最終分析: {system.analysisLastRunAt?.slice(0,19).replace('T',' ') ?? '─'}
      </div>

      {/* サマリーカード */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:16}}>
        {[
          { label:'BUY件数',  val: buy.length,  color:'#2dd4a0', sub:'totalScore≥75 & EV>0' },
          { label:'HOLD件数', val: hold.length, color:'#6896c8', sub:'totalScore≥50' },
          { label:'SELL件数', val: sell.length, color:'#e8405a', sub:'totalScore<50' },
          { label:'平均EV',   val: `${avgEV}%`, color:'#dce6f0', sub:'銘柄全体の期待値' },
          { label:'平均Confidence', val:`${avgConf}%`, color:'#dce6f0', sub:'AI討論分散ベース' },
          { label:'サンプル数', val: analysis.length, color:'#dce6f0', sub:'評価銘柄数' },
        ].map(c => (
          <div key={c.label} style={{background:'#111828', border:'1px solid #22304a', borderRadius:7, padding:'10px 12px'}}>
            <div style={{fontSize:9, color:'#4a6070', letterSpacing:'.05em', textTransform:'uppercase', marginBottom:4}}>{c.label}</div>
            <div style={{fontFamily:'monospace', fontSize:18, fontWeight:700, color:c.color}}>{c.val}</div>
            <div style={{fontSize:9, color:'#4a6070', marginTop:3}}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* ポートフォリオリスク */}
      {metrics && (
        <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:8, padding:'12px 16px', marginBottom:16}}>
          <div style={{fontSize:11, color:'#4a6070', marginBottom:10, textTransform:'uppercase', letterSpacing:'.06em'}}>
            ポートフォリオリスク指標
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8}}>
            {[
              { label:'Sharpe', val:metrics.sharpe.toFixed(2), threshold:1.0 },
              { label:'Sortino', val:metrics.sortino.toFixed(2), threshold:1.5 },
              { label:'Calmar', val:metrics.calmar.toFixed(2), threshold:1.0 },
            ].map(m => {
              const ok = parseFloat(m.val) >= m.threshold
              return (
                <div key={m.label} style={{textAlign:'center'}}>
                  <div style={{fontSize:9, color:'#4a6070', marginBottom:4}}>{m.label}</div>
                  <div style={{fontFamily:'monospace', fontSize:16, fontWeight:700, color: ok ? '#2dd4a0' : '#d4a017'}}>
                    {m.val}
                  </div>
                  <div style={{fontSize:8, color:'#4a6070'}}>閾値{m.threshold.toFixed(1)}</div>
                </div>
              )
            })}
          </div>
          <div style={{marginTop:10, paddingTop:10, borderTop:'1px solid #22304a', display:'flex', gap:20, fontSize:11}}>
            <span style={{color:'#4a6070'}}>最大DD(推定): <span style={{fontFamily:'monospace', color:'#e8405a'}}>{(metrics.mdd*100).toFixed(1)}%</span></span>
            <span style={{color:'#4a6070'}}>CVaR95%: <span style={{fontFamily:'monospace', color:'#e8405a'}}>{(metrics.cvar*100).toFixed(1)}%</span></span>
          </div>
        </div>
      )}

      <div style={{background:'rgba(104,150,200,.07)', border:'1px solid #3a5a8a', borderRadius:7, padding:'10px 14px', fontSize:11, color:'#6896c8'}}>
        ℹ️ バックテスト履歴はCSV取込時に自動記録されます（将来実装）。
        現時点は現在スナップショットの分析結果を表示しています。
      </div>
    </div>
  )
}
