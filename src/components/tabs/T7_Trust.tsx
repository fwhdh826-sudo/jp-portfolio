import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectIsLoading } from '../../store/selectors'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
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

type ActionTone = 'positive' | 'caution' | 'negative' | 'neutral'

function signalTone(rule: string): ActionTone {
  if (rule === 'BUY') return 'positive'
  if (rule === 'SELL') return 'negative'
  if (rule === 'WAIT' || rule === 'WATCH') return 'caution'
  return 'neutral'
}

function normalizeTarget(input: Record<Trust['policy'], number>) {
  const sum = Object.values(input).reduce((acc, value) => acc + value, 0)
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

function getTrustAction(diffValue: number) {
  if (diffValue > 180_000) return { label: '買い増し', tone: 'positive' as ActionTone, detail: '3分割で段階的に積み上げ' }
  if (diffValue < -180_000) return { label: '縮小', tone: 'negative' as ActionTone, detail: '利益確定を先行して比率調整' }
  if (Math.abs(diffValue) > 80_000) return { label: '微調整', tone: 'caution' as ActionTone, detail: '次の押し目/戻りで微修正' }
  return { label: '維持', tone: 'neutral' as ActionTone, detail: '現状比率で運用を継続' }
}

export function T7_Trust() {
  const trust = useAppStore(state => state.trust)
  const market = useAppStore(state => state.market)
  const macro = useAppStore(state => state.macro)
  const system = useAppStore(state => state.system)
  const importCsv = useAppStore(state => state.importCsv)
  const refreshAllData = useAppStore(state => state.refreshAllData)
  const isLoading = useAppStore(selectIsLoading)

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
      items: trust
        .filter(item => item.policy === policy)
        .sort((left, right) => right.score - left.score),
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

  const weightedCost = trust.reduce((sum, item) => sum + item.cost * item.eval, 0) / Math.max(totalEval, 1)
  const weightedDayPct = totalEval > 0 ? trust.reduce((sum, item) => sum + item.dayPct * (item.eval / totalEval), 0) : 0
  const weightedSigma = totalEval > 0 ? trust.reduce((sum, item) => sum + item.sigma * (item.eval / totalEval), 0) : 0
  const maxSingleRatio = totalEval > 0 ? Math.max(...trust.map(item => item.eval / totalEval), 0) * 100 : 0
  const annualCost = totalEval * weightedCost / 100
  const shortTermRow = trustTargets.rows.find(item => item.policy === 'JAPAN_SHORTTERM')
  const shortTermRatio = shortTermRow?.currentRatio ?? 0
  const shortTermTargetRatio = shortTermRow?.targetRatio ?? 0

  const freshnessRows = [
    { label: '投信マスター', raw: system.dataTimestamps?.trust ?? null, status: system.dataSourceStatus.trust },
    { label: 'ニュース', raw: system.dataTimestamps?.news ?? null, status: system.dataSourceStatus.news },
    { label: 'マクロ', raw: system.dataTimestamps?.macro ?? null, status: system.dataSourceStatus.macro ?? 'none' },
    { label: '市場', raw: system.dataTimestamps?.market ?? null, status: system.dataSourceStatus.market },
  ]

  const tacticalQueue = trustTargets.rows.map(row => {
    const action = getTrustAction(row.diffValue)
    return {
      row,
      action,
    }
  })

  const shortTermRules = [
    'エントリー: 火曜 BUY シグナル時に最大3分割で新規。',
    '利確: +3.0%で半分、+5.0%で残りを利確。',
    '損切: -2.0%で縮小、-3.0%で全撤退。',
    `地合い調整: VIX ${market.vix.toFixed(1)} / ドル円 ${macro ? macro.usdjpy.toFixed(2) : '—'} でサイズ変更。`,
  ]

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className={`card focus-card focus-card--${signalTone(dowSignal.rule)}`}>
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">Weekly playbook</div>
              <h2 className="section-heading">投信戦術シグナル</h2>
            </div>
            <button
              className={`status-shell__refresh${isLoading ? ' is-loading' : ''}`}
              onClick={() => { void refreshAllData() }}
              disabled={isLoading}
              type="button"
            >
              {isLoading ? '更新中...' : 'データ更新'}
            </button>
          </div>

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
            <span className="tone-chip tone-chip--neutral">
              最終更新 {system.lastUpdated ? formatDateTime(system.lastUpdated) : '未更新'}
            </span>
          </div>

          <div className="trust-kpi-grid">
            <div className={`summary-tile summary-tile--${shortTermRatio > shortTermTargetRatio + 0.06 ? 'caution' : 'positive'}`}>
              <div className="summary-tile__label">国内株投信比率</div>
              <div className="summary-tile__value">{(shortTermRatio * 100).toFixed(1)}%</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">国内株目標比率</div>
              <div className="summary-tile__value">{(shortTermTargetRatio * 100).toFixed(1)}%</div>
            </div>
            <div className={`summary-tile summary-tile--${weightedDayPct >= 0 ? 'positive' : 'negative'}`}>
              <div className="summary-tile__label">本日寄与</div>
              <div className="summary-tile__value">{weightedDayPct >= 0 ? '+' : ''}{weightedDayPct.toFixed(2)}%</div>
            </div>
            <div className={`summary-tile summary-tile--${weightedCost > 0.8 ? 'negative' : weightedCost > 0.5 ? 'caution' : 'positive'}`}>
              <div className="summary-tile__label">加重コスト</div>
              <div className="summary-tile__value">{weightedCost.toFixed(2)}%</div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Trust dashboard</div>
          <h2 className="section-heading">投信の全体像</h2>
          <div className="summary-grid" style={{ marginTop: 16 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">総評価額</div>
              <div className="summary-tile__value">{formatJPYAuto(totalEval)}</div>
            </div>
            <div className={`summary-tile ${totalPnl >= 0 ? 'summary-tile--positive' : 'summary-tile--negative'}`}>
              <div className="summary-tile__label">含み損益</div>
              <div className="summary-tile__value">{totalPnl >= 0 ? '+' : ''}{formatJPYAuto(totalPnl)}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">想定年間コスト</div>
              <div className="summary-tile__value">{formatJPYAuto(annualCost)}</div>
            </div>
            <div className={`summary-tile summary-tile--${maxSingleRatio >= 45 ? 'negative' : maxSingleRatio >= 35 ? 'caution' : 'positive'}`}>
              <div className="summary-tile__label">最大集中比率</div>
              <div className="summary-tile__value">{maxSingleRatio.toFixed(1)}%</div>
            </div>
          </div>

          <div className="metrics-inline">
            <span>レジーム {market.regime}</span>
            <span>VIX {market.vix.toFixed(1)}</span>
            <span>ドル円 {macro ? macro.usdjpy.toFixed(2) : '—'}</span>
            <span>投信加重σ {(weightedSigma * 100).toFixed(1)}%</span>
          </div>

          <div className="freshness-board" style={{ marginTop: 14 }}>
            {freshnessRows.map(item => (
              <div key={item.label} className="freshness-board__item freshness-board__item--neutral">
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.raw ? formatDateTime(item.raw) : '更新日時なし'}</span>
                </div>
                <div className="freshness-board__chips">
                  <span className="tone-chip tone-chip--neutral">{item.status}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Trust-only optimizer</div>
            <h3 className="section-heading">投信 最適ポートフォリオ</h3>
            <p className="section-copy">
              この最適化は投信のみを対象に計算しています。個別株は含めません。
            </p>

            <div className="trust-target-board">
              {trustTargets.rows.map(row => {
                const action = getTrustAction(row.diffValue)
                return (
                  <div key={row.policy} className={`trust-target-card trust-target-card--${action.tone}`}>
                    <div className="trust-target-card__top">
                      <strong>{POLICY_LABEL[row.policy]}</strong>
                      <span className={`tone-chip tone-chip--${action.tone}`}>{action.label}</span>
                    </div>
                    <div className="trust-target-card__grid">
                      <span>現在 {(row.currentRatio * 100).toFixed(1)}%</span>
                      <span>目標 {(row.targetRatio * 100).toFixed(1)}%</span>
                      <span>現評価額 {formatJPYAuto(row.currentValue)}</span>
                      <span>目標評価額 {formatJPYAuto(row.targetValue)}</span>
                    </div>
                    <div className={`trust-target-card__diff ${row.diffValue >= 0 ? 'p' : 'n'}`}>
                      {row.diffValue >= 0 ? '+' : ''}{formatJPYAuto(row.diffValue)}
                    </div>
                    <div className="trust-target-card__hint">{action.detail}</div>
                  </div>
                )
              })}
            </div>
          </article>

          <article className="card">
            <div className="section-kicker">Ultra-short playbook</div>
            <h3 className="section-heading">国内株投信（超短期）運用ルール</h3>
            <div className="trust-rule-list">
              {shortTermRules.map(rule => (
                <div key={rule} className="trust-rule-list__item">
                  {rule}
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-kicker">Execution queue</div>
            <h3 className="section-heading">本日の投信アクション</h3>
            <div className="trust-lane">
              {tacticalQueue.map(item => (
                <div key={item.row.policy} className={`trust-lane__item trust-lane__item--${item.action.tone}`}>
                  <div className="trust-lane__head">
                    <strong>{POLICY_LABEL[item.row.policy]}</strong>
                    <span className={`vd ${item.action.tone === 'positive' ? 'buy' : item.action.tone === 'negative' ? 'sell' : item.action.tone === 'caution' ? 'wait' : 'hold'}`}>
                      {item.action.label}
                    </span>
                  </div>
                  <p>{item.action.detail}</p>
                  <div className="trust-lane__meta">
                    <span>差額 {item.row.diffValue >= 0 ? '+' : ''}{formatJPYAuto(item.row.diffValue)}</span>
                    <span>現在比率 {(item.row.currentRatio * 100).toFixed(1)}%</span>
                    <span>目標比率 {(item.row.targetRatio * 100).toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </article>

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
              <small>評価額・損益率・日次騰落を最新化します。</small>
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
