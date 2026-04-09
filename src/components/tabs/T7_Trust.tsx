import { useAppStore } from '../../store/useAppStore'

const POLICY_LABEL: Record<string, string> = {
  JAPAN_SHORTTERM:   '🇯🇵 日本株（短期）',
  OVERSEAS_LONGTERM: '🌍 海外（長期）',
  GOLD:              '🥇 ゴールド',
}

const POLICY_COLOR: Record<string, string> = {
  JAPAN_SHORTTERM:   'var(--c)',
  OVERSEAS_LONGTERM: 'var(--a)',
  GOLD:              'var(--gold)',
}

export function T7_Trust() {
  const trust     = useAppStore(s => s.trust)
  const importCsv = useAppStore(s => s.importCsv)

  const totalEval = trust.reduce((s, f) => s + f.eval, 0)
  const totalPnl  = trust.reduce((s, f) => s + (f.eval - f.eval / (1 + f.pnlPct / 100)), 0)

  const decisionClass = (d: string) =>
    d === 'BUY' ? 'buy' : d === 'SELL' ? 'sell' : d === 'WAIT' ? 'wait' : 'hold'

  const groups = ['JAPAN_SHORTTERM', 'OVERSEAS_LONGTERM', 'GOLD'] as const

  const handleCsvDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void importCsv(file)
  }

  return (
    <div className="tab-panel">
      {/* ヘッダー統計 */}
      <div className="kpi-row">
        <div className="kpi">
          <div className="l">総評価額</div>
          <div className="v wh">
            {totalEval >= 1e6 ? `¥${(totalEval / 1e6).toFixed(2)}M` : `¥${(totalEval / 1000).toFixed(0)}K`}
          </div>
        </div>
        <div className="kpi">
          <div className="l">含み損益</div>
          <div className="v" style={{ color: totalPnl >= 0 ? 'var(--g)' : 'var(--r)' }}>
            {totalPnl >= 0 ? '+' : ''}{(totalPnl / 1e6).toFixed(2)}M
          </div>
        </div>
        <div className="kpi">
          <div className="l">銘柄数</div>
          <div className="v wh">{trust.length}本</div>
        </div>
      </div>

      {/* CSV D&D */}
      <div
        className="csv-drop"
        onDrop={handleCsvDrop}
        onDragOver={e => e.preventDefault()}
        style={{ marginBottom: 14 }}
      >
        <input type="file" accept=".csv" onChange={handleFileChange} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
          📁 投信CSVをドロップ or タップ → eval/pnlPct 更新
        </div>
      </div>

      {/* ポリシー別表示 */}
      {groups.map(policy => {
        const funds    = trust.filter(f => f.policy === policy)
        if (funds.length === 0) return null
        const subTotal = funds.reduce((s, f) => s + f.eval, 0)
        const policyColor = POLICY_COLOR[policy] ?? 'var(--d)'

        return (
          <section key={policy} style={{ marginBottom: 20 }}>
            {/* セクションヘッダー */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
              fontFamily: 'var(--head)', fontSize: 10, color: policyColor,
              letterSpacing: '.1em',
            }}>
              <span>{POLICY_LABEL[policy]}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
                {subTotal >= 1e6 ? `¥${(subTotal / 1e6).toFixed(2)}M` : `¥${(subTotal / 1000).toFixed(0)}K`}
                &nbsp;({(subTotal / Math.max(totalEval, 1) * 100).toFixed(1)}%)
              </span>
              <div style={{ flex: 1, height: 1, background: 'var(--b1)' }} />
            </div>

            {/* ファンドカード */}
            {funds.map(f => {
              const wPct      = (f.eval / Math.max(totalEval, 1) * 100).toFixed(1)
              const dcClass   = decisionClass(f.decision)
              const borderCol = f.decision === 'BUY' ? 'var(--g)' : f.decision === 'SELL' ? 'var(--r)' : f.decision === 'WAIT' ? 'var(--a)' : 'var(--c)'

              return (
                <div key={f.id} style={{
                  background: 'var(--panel)',
                  border: `1px solid var(--b1)`,
                  borderLeft: `3px solid ${borderCol}`,
                  borderRadius: 8,
                  padding: '10px 14px',
                  marginBottom: 6,
                }}>
                  {/* ファンド名 + 判定バッジ */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 100 }}>
                      <div style={{ color: 'var(--w)', fontSize: 13, fontWeight: 600 }}>{f.abbr}</div>
                      <div style={{ fontSize: 9, color: 'var(--d)', marginTop: 1 }}>{f.account}</div>
                    </div>
                    <span className={`vd ${dcClass}`}>{f.decision}</span>
                    {f.score > 0 && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)' }}>
                        {f.score}/100
                      </span>
                    )}
                  </div>

                  {/* KPI行 */}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 11 }}>
                    <span className="wh">
                      {f.eval >= 1e6 ? `¥${(f.eval / 1e6).toFixed(2)}M` : `¥${(f.eval / 1000).toFixed(0)}K`}
                    </span>
                    <span className={f.pnlPct >= 0 ? 'p' : 'n'}>
                      {f.pnlPct >= 0 ? '+' : ''}{f.pnlPct.toFixed(2)}%
                    </span>
                    <span style={{ color: f.dayPct >= 0 ? 'var(--g)' : 'var(--r)' }}>
                      本日{f.dayPct >= 0 ? '+' : ''}{f.dayPct.toFixed(2)}%
                    </span>
                    <span className="d">{wPct}%</span>
                    <span className="d">費用{f.cost}%</span>
                    <span style={{ color: f.mu >= 0.1 ? 'var(--g)' : 'var(--a)' }}>
                      μ{(f.mu * 100).toFixed(1)}%
                    </span>
                  </div>

                  {/* シグナル */}
                  {f.signal && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginTop: 5 }}>
                      {f.signal}
                    </div>
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
