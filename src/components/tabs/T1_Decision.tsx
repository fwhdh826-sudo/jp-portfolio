import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectSellList, selectHoldList } from '../../store/selectors'

function DecisionCard({ code, totalScore, ev, decision, confidence, debate }: ReturnType<typeof selectBuyList>[0]) {
  const holding = useAppStore(s => s.holdings.find(h => h.code === code))
  if (!holding) return null

  const color = decision === 'BUY' ? '#2dd4a0' : decision === 'SELL' ? '#e8405a' : '#6896c8'
  const bg    = decision === 'BUY' ? 'rgba(45,212,160,.07)' : decision === 'SELL' ? 'rgba(232,64,90,.07)' : 'rgba(104,150,200,.07)'

  const topBull = debate.agents.flatMap(a => a.bullPoints).slice(0, 2)
  const topBear = debate.agents.flatMap(a => a.bearPoints).slice(0, 1)

  return (
    <div style={{
      background: bg, border:`1px solid ${color}33`, borderLeft:`3px solid ${color}`,
      borderRadius:8, padding:'12px 14px', marginBottom:8,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:8}}>
        <div style={{fontFamily:'monospace', fontSize:11, color:'#4a6070'}}>{code}</div>
        <div style={{color:'#dce6f0', fontWeight:700, fontSize:13}}>{holding.name}</div>
        <div style={{
          marginLeft:'auto', fontFamily:'monospace', fontWeight:700, fontSize:15, color,
          letterSpacing:'.1em',
        }}>{decision}</div>
        <div style={{
          background:`${color}22`, border:`1px solid ${color}55`, borderRadius:12,
          padding:'2px 10px', fontFamily:'monospace', fontSize:11, color,
        }}>
          {totalScore}/100
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
        <div style={{background:'rgba(255,255,255,.04)', borderRadius:5, padding:'6px 10px'}}>
          <div style={{fontSize:9, color:'#4a6070', textTransform:'uppercase', letterSpacing:'.06em'}}>EV</div>
          <div style={{fontFamily:'monospace', fontSize:13, color: ev >= 0 ? '#2dd4a0' : '#e8405a', fontWeight:700}}>
            {ev >= 0 ? '+' : ''}{(ev * 100).toFixed(1)}%
          </div>
        </div>
        <div style={{background:'rgba(255,255,255,.04)', borderRadius:5, padding:'6px 10px'}}>
          <div style={{fontSize:9, color:'#4a6070', textTransform:'uppercase', letterSpacing:'.06em'}}>Confidence</div>
          <div style={{fontFamily:'monospace', fontSize:13, color:'#dce6f0', fontWeight:700}}>
            {(confidence * 100).toFixed(0)}%
          </div>
        </div>
        <div style={{background:'rgba(255,255,255,.04)', borderRadius:5, padding:'6px 10px'}}>
          <div style={{fontSize:9, color:'#4a6070', textTransform:'uppercase', letterSpacing:'.06em'}}>σ</div>
          <div style={{fontFamily:'monospace', fontSize:13, color:'#dce6f0', fontWeight:700}}>
            {(holding.sigma * 100).toFixed(1)}%
            <span style={{fontSize:9, color:'#4a6070', marginLeft:4}}>{holding.sigmaSource === 'yfinance' ? '実測' : '推定'}</span>
          </div>
        </div>
      </div>

      {/* 理由3行 */}
      <div style={{fontSize:12, color:'#9ab0c8', lineHeight:1.6}}>
        {topBull.map((p, i) => <div key={i} style={{color:'#2dd4a0'}}>▲ {p}</div>)}
        {topBear.map((p, i) => <div key={i} style={{color:'#e8405a'}}>▼ {p}</div>)}
        {topBull.length === 0 && topBear.length === 0 &&
          <div style={{color:'#4a6070'}}>AIスコア: {debate.debateScore}/100 — データ蓄積中</div>}
      </div>

      {/* 7軸レーダー簡易バー */}
      <div style={{display:'flex', gap:4, marginTop:10, flexWrap:'wrap'}}>
        {Object.entries(debate.sevenAxis).map(([k, v]) => (
          <div key={k} style={{flex:'1 1 60px'}}>
            <div style={{fontSize:8, color:'#4a6070', marginBottom:2}}>{k}</div>
            <div style={{background:'#161e2e', borderRadius:3, height:4}}>
              <div style={{width:`${v}%`, height:4, borderRadius:3, background: v >= 65 ? '#2dd4a0' : v >= 40 ? '#d4a017' : '#e8405a'}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function T1_Decision() {
  const buyList  = useAppStore(selectBuyList)
  const sellList = useAppStore(selectSellList)
  const holdList = useAppStore(selectHoldList)
  const importCsv = useAppStore(s => s.importCsv)
  const system   = useAppStore(s => s.system)

  const handleCsvDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) importCsv(file)
  }

  return (
    <div style={{padding:16}}>
      {/* CSV D&Dゾーン */}
      <div
        onDrop={handleCsvDrop}
        onDragOver={e => e.preventDefault()}
        style={{
          border:'2px dashed #22304a', borderRadius:8, padding:'12px 16px',
          marginBottom:16, textAlign:'center', color:'#4a6070', fontSize:12,
          cursor:'pointer', transition:'border-color 0.2s',
        }}
      >
        SBI証券CSVをここにドロップ（自動パース → 即時再分析）
        {system.csvLastImportedAt &&
          <span style={{marginLeft:12, color:'#2dd4a0'}}>
            最終取込: {system.csvLastImportedAt.slice(0,10)}
          </span>}
      </div>

      {system.error && (
        <div style={{background:'rgba(232,64,90,.1)', border:'1px solid #b52040', borderRadius:7, padding:'10px 14px', marginBottom:12, color:'#e8405a', fontSize:12}}>
          ✗ {system.error}
        </div>
      )}

      {/* BUY */}
      {buyList.length > 0 && (
        <section style={{marginBottom:20}}>
          <h3 style={{color:'#2dd4a0', fontFamily:'monospace', fontSize:12, letterSpacing:'.1em', textTransform:'uppercase', marginBottom:10}}>
            ▲ BUY — {buyList.length}銘柄
          </h3>
          {buyList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* HOLD */}
      {holdList.length > 0 && (
        <section style={{marginBottom:20}}>
          <h3 style={{color:'#6896c8', fontFamily:'monospace', fontSize:12, letterSpacing:'.1em', textTransform:'uppercase', marginBottom:10}}>
            ● HOLD — {holdList.length}銘柄
          </h3>
          {holdList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* SELL */}
      {sellList.length > 0 && (
        <section>
          <h3 style={{color:'#e8405a', fontFamily:'monospace', fontSize:12, letterSpacing:'.1em', textTransform:'uppercase', marginBottom:10}}>
            ▼ SELL — {sellList.length}銘柄
          </h3>
          {sellList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {buyList.length === 0 && sellList.length === 0 && holdList.length === 0 && (
        <div style={{color:'#4a6070', textAlign:'center', padding:40}}>分析データを読み込み中...</div>
      )}
    </div>
  )
}
