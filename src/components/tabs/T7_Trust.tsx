import { useAppStore } from '../../store/useAppStore'

const POLICY_LABEL: Record<string, string> = {
  JAPAN_SHORTTERM:   '日本株（短期）',
  OVERSEAS_LONGTERM: '海外（長期）',
  GOLD:              'ゴールド',
}

export function T7_Trust() {
  const trust      = useAppStore(s => s.trust)
  const importCsv  = useAppStore(s => s.importCsv)

  const totalEval  = trust.reduce((s, f) => s + f.eval, 0)
  const totalPnl   = trust.reduce((s, f) => s + (f.eval - f.eval / (1 + f.pnlPct / 100)), 0)

  const decisionColor = (d: string) =>
    d === 'BUY' ? '#2dd4a0' : d === 'SELL' ? '#e8405a' : d === 'WAIT' ? '#d4a017' : '#6896c8'

  const groups = ['JAPAN_SHORTTERM', 'OVERSEAS_LONGTERM', 'GOLD'] as const

  const handleCsvDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) importCsv(file)
  }

  return (
    <div style={{padding:16}}>
      {/* ヘッダー統計 */}
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:16}}>
        <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:7, padding:'10px 12px'}}>
          <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>総評価額</div>
          <div style={{fontFamily:'monospace', fontSize:14, color:'#dce6f0', fontWeight:700}}>
            ¥{(totalEval/1e6).toFixed(2)}M
          </div>
        </div>
        <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:7, padding:'10px 12px'}}>
          <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>含み損益</div>
          <div style={{fontFamily:'monospace', fontSize:14, fontWeight:700, color: totalPnl >= 0 ? '#2dd4a0' : '#e8405a'}}>
            {totalPnl >= 0 ? '+' : ''}{(totalPnl/1e6).toFixed(2)}M
          </div>
        </div>
        <div style={{background:'#111828', border:'1px solid #22304a', borderRadius:7, padding:'10px 12px'}}>
          <div style={{fontSize:9, color:'#4a6070', marginBottom:3}}>銘柄数</div>
          <div style={{fontFamily:'monospace', fontSize:14, color:'#dce6f0', fontWeight:700}}>
            {trust.length}本
          </div>
        </div>
      </div>

      {/* CSV D&D */}
      <div
        onDrop={handleCsvDrop}
        onDragOver={e => e.preventDefault()}
        style={{
          border:'2px dashed #22304a', borderRadius:8, padding:'10px 14px',
          marginBottom:16, textAlign:'center', color:'#4a6070', fontSize:11,
        }}
      >
        投信CSVをドロップして eval/pnlPct を更新
      </div>

      {/* ポリシー別表示 */}
      {groups.map(policy => {
        const funds = trust.filter(f => f.policy === policy)
        if (funds.length === 0) return null
        const subTotal = funds.reduce((s, f) => s + f.eval, 0)
        return (
          <section key={policy} style={{marginBottom:20}}>
            <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:8}}>
              <h3 style={{fontSize:11, color:'#4a6070', textTransform:'uppercase', letterSpacing:'.08em', margin:0}}>
                {POLICY_LABEL[policy]}
              </h3>
              <span style={{fontFamily:'monospace', fontSize:11, color:'#9ab0c8'}}>
                ¥{(subTotal/1e6).toFixed(2)}M ({(subTotal/Math.max(totalEval,1)*100).toFixed(1)}%)
              </span>
            </div>
            {funds.map(f => {
              const wPct = (f.eval / Math.max(totalEval, 1) * 100).toFixed(1)
              return (
                <div key={f.id} style={{
                  background:'#111828', border:'1px solid #22304a', borderLeft:`3px solid ${decisionColor(f.decision)}`,
                  borderRadius:7, padding:'10px 14px', marginBottom:6,
                  display:'flex', alignItems:'center', gap:12, flexWrap:'wrap',
                }}>
                  <div style={{flex:'1 1 140px'}}>
                    <div style={{color:'#dce6f0', fontSize:12, fontWeight:600}}>{f.abbr}</div>
                    <div style={{fontSize:9, color:'#4a6070', marginTop:1}}>{f.account}</div>
                  </div>
                  <div style={{fontFamily:'monospace', fontSize:11, color:'#dce6f0'}}>
                    ¥{(f.eval/1000).toFixed(0)}K
                  </div>
                  <div style={{fontFamily:'monospace', fontSize:11, color: f.pnlPct >= 0 ? '#2dd4a0' : '#e8405a'}}>
                    {f.pnlPct >= 0 ? '+' : ''}{f.pnlPct.toFixed(2)}%
                  </div>
                  <div style={{fontFamily:'monospace', fontSize:10, color:'#4a6070'}}>
                    {wPct}% | 費用{f.cost}%
                  </div>
                  <div style={{fontFamily:'monospace', fontSize:11, color: f.dayPct >= 0 ? '#2dd4a0' : '#e8405a'}}>
                    本日{f.dayPct >= 0 ? '+' : ''}{f.dayPct.toFixed(2)}%
                  </div>
                  <span style={{
                    fontFamily:'monospace', fontSize:10, fontWeight:700,
                    color: decisionColor(f.decision),
                    background:`${decisionColor(f.decision)}18`,
                    border:`1px solid ${decisionColor(f.decision)}44`,
                    borderRadius:4, padding:'2px 7px', whiteSpace:'nowrap',
                  }}>{f.decision}</span>
                  {f.score > 0 && (
                    <span style={{fontFamily:'monospace', fontSize:10, color:'#4a6070'}}>{f.score}/100</span>
                  )}
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
