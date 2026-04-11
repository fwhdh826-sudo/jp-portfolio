import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatJPYAuto } from '../../utils/format'
import type { Trust } from '../../types'

const POLICY_LABEL: Record<string, string> = {
  JAPAN_SHORTTERM: '国内株投信',
  OVERSEAS_LONGTERM: '海外株投信',
  GOLD: 'ゴールド',
}

const POLICY_TONE: Record<string, 'positive' | 'neutral' | 'caution'> = {
  JAPAN_SHORTTERM: 'neutral',
  OVERSEAS_LONGTERM: 'positive',
  GOLD: 'caution',
}

const DOW_SIGNALS = {
  1: { name: '月曜', rule: 'WATCH', tactic: '方向感が出るまで新規エントリーを急がない。' },
  2: { name: '火曜', rule: 'BUY', tactic: '押し目が維持されるなら打診買いを検討する。' },
  3: { name: '水曜', rule: 'HOLD', tactic: '週中の安定日。ポジションの維持を優先。' },
  4: { name: '木曜', rule: 'SELL', tactic: '利益確定とリスク圧縮を進める日。' },
  5: { name: '金曜', rule: 'WAIT', tactic: '週末リスクを避けて無理な新規は控える。' },
} as const

function signalTone(rule: string) {
  if (rule === 'BUY') return 'positive'
  if (rule === 'SELL') return 'negative'
  if (rule === 'WAIT' || rule === 'WATCH') return 'caution'
  return 'neutral'
}

function TrustOverview({ trusts }: { trusts: Trust[] }) {
  const macro = useAppStore(s => s.macro)
  const universe = useAppStore(s => s.universe)

  const totalEval = trusts.reduce((sum, item) => sum + item.eval, 0)
  const jpEval = trusts.filter(item => item.policy === 'JAPAN_SHORTTERM').reduce((sum, item) => sum + item.eval, 0)
  const overseasEval = trusts.filter(item => item.policy === 'OVERSEAS_LONGTERM').reduce((sum, item) => sum + item.eval, 0)
  const goldEval = trusts.filter(item => item.policy === 'GOLD').reduce((sum, item) => sum + item.eval, 0)
  const weightedCost = trusts.reduce((sum, item) => sum + item.cost * item.eval, 0) / Math.max(totalEval, 1)
  const annualCost = totalEval * weightedCost / 100
  const fxRatio = totalEval > 0 ? overseasEval / totalEval : 0
  const fxImpact = overseasEval * 0.01

  const allocationTargets = [
    universe?.categories.find(item => item.class === 'JP_TRUST'),
    universe?.categories.find(item => item.class === 'OVERSEAS_TRUST'),
    universe?.categories.find(item => item.class === 'GOLD'),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item))

  return (
    <div className="stack-layout">
      <article className="card">
        <div className="section-kicker">Trust diagnostics</div>
        <h3 className="section-heading">投信ポートフォリオ診断</h3>
        <div className="summary-grid" style={{ marginTop: 18 }}>
          <div className={`summary-tile summary-tile--${fxRatio > 0.7 ? 'caution' : 'positive'}`}>
            <div className="summary-tile__label">為替エクスポージャー</div>
            <div className="summary-tile__value">{(fxRatio * 100).toFixed(0)}%</div>
          </div>
          <div className={`summary-tile summary-tile--${weightedCost > 0.8 ? 'negative' : weightedCost > 0.5 ? 'caution' : 'positive'}`}>
            <div className="summary-tile__label">加重報酬率</div>
            <div className="summary-tile__value">{weightedCost.toFixed(2)}%</div>
          </div>
          <div className="summary-tile summary-tile--neutral">
            <div className="summary-tile__label">年間コスト</div>
            <div className="summary-tile__value">{formatJPYAuto(annualCost)}</div>
          </div>
          <div className="summary-tile summary-tile--neutral">
            <div className="summary-tile__label">円安1%影響</div>
            <div className="summary-tile__value">{formatJPYAuto(fxImpact)}</div>
          </div>
        </div>

        <div className="detail-grid" style={{ marginTop: 18 }}>
          <div className="detail-panel">
            <div className="section-subtitle">現在配分</div>
            <div className="detail-list">
              <span>国内株投信 {(jpEval / Math.max(totalEval, 1) * 100).toFixed(1)}%</span>
              <span>海外株投信 {(overseasEval / Math.max(totalEval, 1) * 100).toFixed(1)}%</span>
              <span>ゴールド {(goldEval / Math.max(totalEval, 1) * 100).toFixed(1)}%</span>
              <span>ドル円 {macro ? macro.usdjpy.toFixed(2) : '—'}</span>
            </div>
          </div>

          <div className="detail-panel">
            <div className="section-subtitle">理想配分との差分</div>
            <div className="detail-list">
              {allocationTargets.length > 0 ? allocationTargets.map(item => (
                <span key={item.class}>
                  {item.label} 現在 {(item.currentRatio * 100).toFixed(1)}% / 目標 {(item.targetRatio * 100).toFixed(1)}%
                </span>
              )) : <span>理想配分データなし</span>}
            </div>
          </div>
        </div>
      </article>
    </div>
  )
}

export function T7_Trust() {
  const trust = useAppStore(s => s.trust)
  const importCsv = useAppStore(s => s.importCsv)

  const totalEval = trust.reduce((sum, item) => sum + item.eval, 0)
  const totalPnl = trust.reduce((sum, item) => sum + (item.eval - item.eval / (1 + item.pnlPct / 100)), 0)
  const today = new Date().getDay()
  const dowSignal = DOW_SIGNALS[today as keyof typeof DOW_SIGNALS] ?? DOW_SIGNALS[3]

  const handleCsvDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importCsv(file)
  }

  const policyGroups = useMemo(
    () => (['JAPAN_SHORTTERM', 'OVERSEAS_LONGTERM', 'GOLD'] as const).map(policy => ({
      policy,
      items: trust.filter(item => item.policy === policy),
      total: trust.filter(item => item.policy === policy).reduce((sum, item) => sum + item.eval, 0),
    })),
    [trust],
  )

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className={`card focus-card focus-card--${signalTone(dowSignal.rule)}`}>
          <div className="section-kicker">Weekly playbook</div>
          <h2 className="section-heading">曜日シグナル</h2>
          <p className="focus-card__summary">
            {dowSignal.name} / {dowSignal.rule} / {dowSignal.tactic}
          </p>
          <div className="focus-card__badges">
            {Object.entries(DOW_SIGNALS).map(([key, signal]) => (
              <span
                key={key}
                className={`tone-chip tone-chip--${Number(key) === today ? signalTone(signal.rule) : 'neutral'}`}
              >
                {signal.name}
              </span>
            ))}
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Trust summary</div>
          <h2 className="section-heading">投信の全体像</h2>
          <div className="summary-grid" style={{ marginTop: 18 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">総評価額</div>
              <div className="summary-tile__value">{formatJPYAuto(totalEval)}</div>
            </div>
            <div className={`summary-tile ${totalPnl >= 0 ? 'summary-tile--positive' : 'summary-tile--negative'}`}>
              <div className="summary-tile__label">含み損益</div>
              <div className="summary-tile__value">{totalPnl >= 0 ? '+' : ''}{formatJPYAuto(Math.abs(totalPnl))}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">本数</div>
              <div className="summary-tile__value">{trust.length}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">今日の基本姿勢</div>
              <div className="summary-tile__value" style={{ fontSize: 18 }}>{dowSignal.rule}</div>
            </div>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <TrustOverview trusts={trust} />

        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Import</div>
            <h3 className="section-heading">投信CSVを更新</h3>
            <div
              className="csv-drop"
              style={{ marginTop: 18 }}
              onDrop={handleCsvDrop}
              onDragOver={event => event.preventDefault()}
            >
              <input type="file" accept=".csv" onChange={handleFileChange} />
              <div>投信CSVをドロップまたは選択</div>
              <small>評価額と損益率を最新化します。</small>
            </div>
          </article>
        </div>
      </section>

      <section className="stack-layout" style={{ marginTop: 18 }}>
        {policyGroups.map(group => {
          if (group.items.length === 0) return null

          return (
            <article key={group.policy} className="card">
              <div className="section-heading-row">
                <div>
                  <div className="section-kicker">Policy bucket</div>
                  <h3 className="section-heading">{POLICY_LABEL[group.policy]}</h3>
                </div>
                <div className="section-caption">
                  {formatJPYAuto(group.total)} / {(group.total / Math.max(totalEval, 1) * 100).toFixed(1)}%
                </div>
              </div>

              <div className="fund-grid" style={{ marginTop: 18 }}>
                {group.items.map(item => (
                  <div key={item.id} className={`fund-card fund-card--${POLICY_TONE[group.policy]}`}>
                    <div className="fund-card__top">
                      <div>
                        <div className="position-card__code">{item.abbr}</div>
                        <strong>{item.name}</strong>
                      </div>
                      <span className={`vd ${item.decision === 'BUY' ? 'buy' : item.decision === 'SELL' ? 'sell' : item.decision === 'WAIT' ? 'wait' : 'hold'}`}>
                        {item.decision}
                      </span>
                    </div>

                    <div className="fund-card__metrics">
                      <span>評価額 {formatJPYAuto(item.eval)}</span>
                      <span>損益率 {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%</span>
                      <span>当日 {item.dayPct >= 0 ? '+' : ''}{item.dayPct.toFixed(2)}%</span>
                      <span>費用 {item.cost.toFixed(2)}%</span>
                      <span>期待収益 {(item.mu * 100).toFixed(1)}%</span>
                      <span>スコア {item.score}</span>
                    </div>

                    {item.signal && <p className="fund-card__signal">{item.signal}</p>}
                  </div>
                ))}
              </div>
            </article>
          )
        })}
      </section>
    </div>
  )
}
