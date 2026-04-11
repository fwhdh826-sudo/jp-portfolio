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
  1: { name: '月曜', rule: 'WATCH', tactic: '寄り直後の新規を避け、方向確認を優先する。' },
  2: { name: '火曜', rule: 'BUY', tactic: '押し目を小口で拾い、当日中の利確余地を残す。' },
  3: { name: '水曜', rule: 'HOLD', tactic: '前日までのポジションを維持し、回転は抑える。' },
  4: { name: '木曜', rule: 'SELL', tactic: '利益確定を先行し、翌日リスクを圧縮する。' },
  5: { name: '金曜', rule: 'WAIT', tactic: '週末持ち越しを減らし、回転余力を確保する。' },
} as const

interface TrustTargetRow {
  policy: Trust['policy']
  currentValue: number
  currentRatio: number
  targetRatio: number
  targetValue: number
  diffValue: number
}

function signalTone(rule: string) {
  if (rule === 'BUY') return 'positive'
  if (rule === 'SELL') return 'negative'
  if (rule === 'WAIT' || rule === 'WATCH') return 'caution'
  return 'neutral'
}

function normalizeTarget(input: Record<Trust['policy'], number>) {
  const sum = Object.values(input).reduce((acc, v) => acc + v, 0)
  if (sum <= 0) return input
  return {
    JAPAN_SHORTTERM: input.JAPAN_SHORTTERM / sum,
    OVERSEAS_LONGTERM: input.OVERSEAS_LONGTERM / sum,
    GOLD: input.GOLD / sum,
  } as Record<Trust['policy'], number>
}

function buildTrustTargets(
  trusts: Trust[],
  regime: 'bull' | 'neutral' | 'bear',
  vix: number,
  usdjpy: number | null,
  dowRule: string,
) {
  const currentByPolicy = {
    JAPAN_SHORTTERM: trusts.filter(item => item.policy === 'JAPAN_SHORTTERM').reduce((sum, item) => sum + item.eval, 0),
    OVERSEAS_LONGTERM: trusts.filter(item => item.policy === 'OVERSEAS_LONGTERM').reduce((sum, item) => sum + item.eval, 0),
    GOLD: trusts.filter(item => item.policy === 'GOLD').reduce((sum, item) => sum + item.eval, 0),
  } as Record<Trust['policy'], number>

  const totalEval = Object.values(currentByPolicy).reduce((sum, value) => sum + value, 0)

  let target = {
    JAPAN_SHORTTERM: 0.22,
    OVERSEAS_LONGTERM: 0.60,
    GOLD: 0.18,
  } as Record<Trust['policy'], number>

  if (regime === 'bull') {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM + 0.08,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM - 0.05,
      GOLD: target.GOLD - 0.03,
    }
  }

  if (regime === 'bear' || vix >= 24 || dowRule === 'SELL' || dowRule === 'WAIT') {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM - 0.10,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM + 0.06,
      GOLD: target.GOLD + 0.04,
    }
  }

  if (usdjpy !== null && usdjpy >= 160) {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM + 0.02,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM - 0.05,
      GOLD: target.GOLD + 0.03,
    }
  }

  if (usdjpy !== null && usdjpy <= 145) {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM - 0.02,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM + 0.04,
      GOLD: target.GOLD - 0.02,
    }
  }

  target = {
    JAPAN_SHORTTERM: Math.min(0.40, Math.max(0.10, target.JAPAN_SHORTTERM)),
    OVERSEAS_LONGTERM: Math.min(0.75, Math.max(0.35, target.OVERSEAS_LONGTERM)),
    GOLD: Math.min(0.30, Math.max(0.05, target.GOLD)),
  }

  const normalized = normalizeTarget(target)

  const rows = (['JAPAN_SHORTTERM', 'OVERSEAS_LONGTERM', 'GOLD'] as const).map(policy => {
    const currentValue = currentByPolicy[policy]
    const currentRatio = totalEval > 0 ? currentValue / totalEval : 0
    const targetRatio = normalized[policy]
    const targetValue = totalEval * targetRatio
    return {
      policy,
      currentValue,
      currentRatio,
      targetRatio,
      targetValue,
      diffValue: targetValue - currentValue,
    } satisfies TrustTargetRow
  })

  return {
    totalEval,
    rows,
  }
}

function TrustOverview({ trusts, targets, dowRule }: { trusts: Trust[]; targets: TrustTargetRow[]; dowRule: string }) {
  const macro = useAppStore(s => s.macro)
  const market = useAppStore(s => s.market)

  const totalEval = trusts.reduce((sum, item) => sum + item.eval, 0)
  const weightedCost = trusts.reduce((sum, item) => sum + item.cost * item.eval, 0) / Math.max(totalEval, 1)
  const annualCost = totalEval * weightedCost / 100
  const shortTermRatio = targets.find(item => item.policy === 'JAPAN_SHORTTERM')?.currentRatio ?? 0

  return (
    <div className="stack-layout">
      <article className="card">
        <div className="section-kicker">Trust-only optimizer</div>
        <h3 className="section-heading">投信 最適ポートフォリオ</h3>
        <p className="section-copy">
          この最適化は投信のみを対象に計算しています。個別株は含めません。
        </p>

        <div className="summary-grid" style={{ marginTop: 16 }}>
          <div className={`summary-tile summary-tile--${shortTermRatio >= 0.28 ? 'positive' : 'neutral'}`}>
            <div className="summary-tile__label">国内株投信比率</div>
            <div className="summary-tile__value">{(shortTermRatio * 100).toFixed(1)}%</div>
          </div>
          <div className={`summary-tile summary-tile--${weightedCost > 0.8 ? 'negative' : weightedCost > 0.5 ? 'caution' : 'positive'}`}>
            <div className="summary-tile__label">加重コスト</div>
            <div className="summary-tile__value">{weightedCost.toFixed(2)}%</div>
          </div>
          <div className="summary-tile summary-tile--neutral">
            <div className="summary-tile__label">年間コスト</div>
            <div className="summary-tile__value">{formatJPYAuto(annualCost)}</div>
          </div>
          <div className={`summary-tile summary-tile--${signalTone(dowRule)}`}>
            <div className="summary-tile__label">短期戦術シグナル</div>
            <div className="summary-tile__value">{dowRule}</div>
          </div>
        </div>

        <div className="tw" style={{ marginTop: 12 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>区分</th>
                <th>現在比率</th>
                <th>目標比率</th>
                <th>差額</th>
                <th>方針</th>
              </tr>
            </thead>
            <tbody>
              {targets.map(row => {
                const action = row.diffValue > 80_000 ? '買い増し' : row.diffValue < -80_000 ? '縮小' : '維持'
                return (
                  <tr key={row.policy}>
                    <td>{POLICY_LABEL[row.policy]}</td>
                    <td>{(row.currentRatio * 100).toFixed(1)}%</td>
                    <td>{(row.targetRatio * 100).toFixed(1)}%</td>
                    <td className={row.diffValue >= 0 ? 'p' : 'n'}>
                      {row.diffValue >= 0 ? '+' : ''}{formatJPYAuto(row.diffValue)}
                    </td>
                    <td>{action}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </article>

      <article className="card">
        <div className="section-kicker">Ultra-short playbook</div>
        <h3 className="section-heading">国内株投信（超短期）運用ルール</h3>
        <div className="detail-list">
          <span>エントリー: 火曜 `BUY` シグナル時に分割で新規（最大でも投信全体の40%まで）。</span>
          <span>利確: +3.0% で半分、+5.0% で残りを利確。</span>
          <span>損切: -2.0% で機械的に縮小、-3.0% で全撤退。</span>
          <span>地合い調整: VIX {market.vix.toFixed(1)} / ドル円 {macro ? macro.usdjpy.toFixed(2) : '—'} を基準にサイズを上下。</span>
        </div>
      </article>
    </div>
  )
}

export function T7_Trust() {
  const trust = useAppStore(s => s.trust)
  const market = useAppStore(s => s.market)
  const macro = useAppStore(s => s.macro)
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

  const trustTargets = useMemo(
    () =>
      buildTrustTargets(
        trust,
        market.regime,
        market.vix,
        macro?.usdjpy ?? null,
        dowSignal.rule,
      ),
    [dowSignal.rule, macro?.usdjpy, market.regime, market.vix, trust],
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
          <div className="summary-grid" style={{ marginTop: 16 }}>
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
            <div className={`summary-tile summary-tile--${signalTone(dowSignal.rule)}`}>
              <div className="summary-tile__label">本日の姿勢</div>
              <div className="summary-tile__value">{dowSignal.rule}</div>
            </div>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <TrustOverview trusts={trust} targets={trustTargets.rows} dowRule={dowSignal.rule} />

        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Import</div>
            <h3 className="section-heading">投信CSVを更新</h3>
            <div
              className="csv-drop"
              style={{ marginTop: 16 }}
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

      <section className="stack-layout" style={{ marginTop: 16 }}>
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

              <div className="fund-grid" style={{ marginTop: 16 }}>
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
