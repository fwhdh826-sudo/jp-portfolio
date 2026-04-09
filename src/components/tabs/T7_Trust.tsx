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

interface DowSignal {
  name: string
  rule: 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'WAIT'
  tactic: string
  icon: string
}

const DOW_SIGNALS: Record<number, DowSignal> = {
  1: { name: '月曜', rule: 'WATCH', tactic: '週初め様子見、寄付き後の方向感確認してから判断',          icon: '👀' },
  2: { name: '火曜', rule: 'BUY',   tactic: '月曜下落後の反発買い。日経先物+0.3%以上で打診',         icon: '📈' },
  3: { name: '水曜', rule: 'HOLD',  tactic: '週中最安定。保有維持、新規なし',                       icon: '⚖️' },
  4: { name: '木曜', rule: 'SELL',  tactic: '週末前の利確売り。含み益銘柄を一部利確',                icon: '💰' },
  5: { name: '金曜', rule: 'WAIT',  tactic: '週末リスク回避。新規買い不可、既存ポジ維持',             icon: '⏸️' },
}

function ruleColor(rule: string): string {
  switch (rule) {
    case 'BUY':   return 'var(--g)'
    case 'SELL':  return 'var(--r)'
    case 'HOLD':  return 'var(--c)'
    case 'WATCH': return 'var(--a)'
    case 'WAIT':  return 'var(--d)'
    default:      return 'var(--d)'
  }
}

function ruleBg(rule: string): string {
  switch (rule) {
    case 'BUY':   return 'rgba(45,212,160,.08)'
    case 'SELL':  return 'rgba(232,64,90,.08)'
    case 'HOLD':  return 'rgba(104,150,200,.08)'
    case 'WATCH': return 'rgba(212,160,23,.08)'
    case 'WAIT':  return 'rgba(74,96,112,.12)'
    default:      return 'rgba(74,96,112,.12)'
  }
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

  // ── 曜日別シグナル ────────────────────────────────────────────
  const today = new Date().getDay()
  const sig = DOW_SIGNALS[today] ?? DOW_SIGNALS[3]
  const sigColor = ruleColor(sig.rule)
  const sigBg    = ruleBg(sig.rule)

  return (
    <div className="tab-panel">

      {/* ── 曜日別DOWシグナル ── */}
      <div style={{
        background: sigBg,
        border: `1px solid ${sigColor}44`,
        borderLeft: `4px solid ${sigColor}`,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--head)', fontSize: 9, color: 'var(--d)', letterSpacing: '.15em', marginBottom: 4 }}>
              DOW 曜日シグナル
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 28 }}>{sig.icon}</span>
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, color: sigColor }}>
                  {sig.name} — {sig.rule}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginTop: 4, lineHeight: 1.5 }}>
                  {sig.tactic}
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {Object.entries(DOW_SIGNALS).map(([d, s]) => (
                <div key={d} style={{
                  fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 7px',
                  borderRadius: 8,
                  background: Number(d) === today ? `${ruleColor(s.rule)}22` : 'transparent',
                  border: `1px solid ${Number(d) === today ? ruleColor(s.rule) : 'var(--b1)'}`,
                  color: Number(d) === today ? ruleColor(s.rule) : 'var(--d)',
                }}>
                  {s.name}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── ヘッダー統計 ── */}
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

      {/* ── CSV D&D ── */}
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

      {/* ── ポリシー別表示 ── */}
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
