/**
 * T8_Learning — 学習 / 検証 V10 Phase 9
 * 予測 vs 実績ログ・戦略劣化検知・代理別精度・重み提案・レジーム別有効性
 * 表示順: KPI サマリー → 劣化シグナル → 代理別精度 → 重み提案 → レジーム別 → ログ
 */
import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatDateTime, formatRelativeTime, findHoldingName, formatPt } from '../../utils/format'
import type { LearningOutcome } from '../../types'
import { SparklineChart } from '../charts/SparklineChart'
import { PageHeader } from '../layout/PageHeader'
import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'

// ── ベース重みとラベル ────────────────────────────────────────
const BASE_WEIGHTS: Record<string, number> = {
  fundamental: 0.30,
  market:      0.20,
  technical:   0.20,
  news:        0.15,
  quality:     0.10,
  risk:        0.15,
}
const WEIGHT_LABELS: Record<string, string> = {
  fundamental: 'ファンダ',
  market:      'マクロ',
  technical:   'テクニカル',
  news:        'ニュース',
  quality:     '品質',
  risk:        'リスク',
}

// ── レジーム別集計 ────────────────────────────────────────────
type Regime = 'bull' | 'neutral' | 'bear'

function calcRegimeStats(
  outcomes: LearningOutcome[],
  regime: Regime,
): { count: number; wins: number; accuracy: number; avgReward: number } {
  const filtered = outcomes.filter(o => o.regime === regime)
  if (filtered.length === 0) return { count: 0, wins: 0, accuracy: 0, avgReward: 0 }
  const wins = filtered.filter(o => o.result === 'win').length
  const judged = filtered.filter(o => o.result !== 'flat').length
  const rewards = filtered.reduce((s, o) => s + o.reward, 0)
  return {
    count: filtered.length,
    wins,
    accuracy: judged > 0 ? Math.round((wins / judged) * 100) : 0,
    avgReward: +(rewards / filtered.length).toFixed(3),
  }
}

// ── KPI カード ────────────────────────────────────────────────
function KpiCard({
  label, value, sub, variant,
}: {
  label: string
  value: string
  sub?: string
  variant?: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  const cls = variant
    ? `learning-kpi-card learning-kpi-card--${variant}`
    : 'learning-kpi-card'
  return (
    <div className={cls}>
      <div className="learning-kpi-card__label">{label}</div>
      <div className="learning-kpi-card__value">{value}</div>
      {sub && <div className="learning-kpi-card__sub">{sub}</div>}
    </div>
  )
}

// ── 代理別（判定別）精度セクション ───────────────────────────
function DecisionAccuracySection({
  byDecision,
}: {
  byDecision: {
    BUY: { count: number; wins: number; losses: number; accuracy: number; avgReward: number }
    HOLD: { count: number; wins: number; losses: number; accuracy: number; avgReward: number }
    SELL: { count: number; wins: number; losses: number; accuracy: number; avgReward: number }
  }
}) {
  const entries = [
    { key: 'BUY',  label: 'BUY 判定', ds: byDecision.BUY,  color: 'var(--color-buy-text)',  bg: 'var(--color-buy-bg)',  border: 'var(--color-buy-border)' },
    { key: 'HOLD', label: 'HOLD 判定', ds: byDecision.HOLD, color: 'var(--color-hold-text)', bg: 'var(--color-hold-bg)', border: 'var(--color-hold-border)' },
    { key: 'SELL', label: 'SELL 判定', ds: byDecision.SELL, color: 'var(--color-sell-text)', bg: 'var(--color-sell-bg)', border: 'var(--color-sell-border)' },
  ] as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
      {entries.map(({ key, label, ds, color, bg, border }) => {
        const variant: 'good' | 'warn' | 'bad' =
          ds.accuracy >= 60 ? 'good' : ds.accuracy >= 45 ? 'warn' : 'bad'
        const variantColor =
          variant === 'good' ? 'var(--color-buy-text)' :
          variant === 'warn' ? 'var(--color-hold-text)' :
          'var(--color-sell-text)'

        return (
          <div key={key} style={{
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: radius.lg,
            padding: `${spacing[3]} ${spacing[4]}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
              <span style={{ ...typography.bodySmall, color, fontWeight: 700, minWidth: 80 }}>{label}</span>
              <span style={{ ...typography.bodySmall, fontWeight: 900, fontSize: '20px', color: variantColor, minWidth: 52 }}>
                {ds.count >= 3 ? `${ds.accuracy}%` : '—'}
              </span>
              <span style={{ ...typography.caption, color: 'var(--color-text-muted)' }}>
                {ds.count}件 / 勝{ds.wins}負{ds.losses}
              </span>
              <span style={{ ...typography.caption, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                平均reward {ds.count >= 3 ? ds.avgReward.toFixed(2) : '—'}
              </span>
            </div>
            {ds.count < 3 && (
              <div style={{ ...typography.caption, color: 'var(--color-text-muted)', marginTop: spacing[1] }}>
                データ不足（3件以上で計算）
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── 重み提案セクション ────────────────────────────────────────
function WeightSuggestionSection({
  suggested,
}: {
  suggested: Record<string, number>
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
      {Object.keys(BASE_WEIGHTS).map(key => {
        const base = BASE_WEIGHTS[key]
        const sugg = suggested[key] ?? base
        const delta = sugg - base
        const deltaStr = formatPt(delta * 100)
        const deltaClass = delta > 0.005 ? 'weight-row__delta--up'
          : delta < -0.005 ? 'weight-row__delta--down'
          : 'weight-row__delta--flat'

        return (
          <div key={key} className="weight-row">
            <span className="weight-row__label">{WEIGHT_LABELS[key] ?? key}</span>
            <div className="weight-row__bar">
              <div className="weight-row__fill" style={{ width: `${(base * 100).toFixed(0)}%` }} />
            </div>
            <div className="weight-row__bar" style={{ position: 'relative' }}>
              <div className="weight-row__fill weight-row__fill--suggest" style={{ width: `${(sugg * 100).toFixed(0)}%` }} />
            </div>
            <span className="weight-row__pct">{(sugg * 100).toFixed(0)}%</span>
            <span className={`weight-row__delta ${deltaClass}`}>{deltaStr}</span>
          </div>
        )
      })}
      <div style={{ ...typography.caption, color: 'var(--color-text-muted)', marginTop: spacing[1] }}>
        左バー = 現在重み（グレー）/ 右バー = 提案重み（緑）/ 精度20件以上で自動適用
      </div>
    </div>
  )
}

// ── レジーム別有効性 ──────────────────────────────────────────
function RegimeEffectivenessSection({ outcomes }: { outcomes: LearningOutcome[] }) {
  const bull    = calcRegimeStats(outcomes, 'bull')
  const neutral = calcRegimeStats(outcomes, 'neutral')
  const bear    = calcRegimeStats(outcomes, 'bear')

  const regimes = [
    { key: 'bull',    label: '強気相場', cls: 'bull',    stats: bull },
    { key: 'neutral', label: '中立相場', cls: 'neutral', stats: neutral },
    { key: 'bear',    label: '弱気相場', cls: 'bear',    stats: bear },
  ] as const

  return (
    <div className="regime-effectiveness-grid">
      {regimes.map(({ key, label, cls, stats }) => (
        <div key={key} className="regime-card">
          <div className={`regime-card__label regime-card__label--${cls}`}>{label}</div>
          {stats.count >= 3 ? (
            <>
              <div className="regime-card__accuracy" style={{
                color: stats.accuracy >= 60
                  ? 'var(--color-buy-text)'
                  : stats.accuracy >= 45
                  ? 'var(--color-hold-text)'
                  : 'var(--color-sell-text)',
              }}>
                {stats.accuracy}%
              </div>
              <div className="regime-card__sub">{stats.count}件</div>
            </>
          ) : (
            <>
              <div className="regime-card__accuracy" style={{ color: 'var(--color-text-muted)' }}>—</div>
              <div className="regime-card__sub">
                {stats.count === 0 ? 'データなし' : `${stats.count}件（不足）`}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ── 予測 vs 実績ログ ─────────────────────────────────────────
function OutcomeLogSection({ outcomes }: { outcomes: LearningOutcome[] }) {
  const holdings = useAppStore(s => s.holdings)
  const recent = outcomes.slice(0, 30)

  if (recent.length === 0) {
    return (
      <div style={{
        textAlign: 'center',
        padding: `${spacing[5]} ${spacing[4]}`,
        color: 'var(--color-text-muted)',
        ...typography.bodySmall,
      }}>
        まだ実績データがありません。<br />
        データ更新 → 分析 → 再更新を繰り返すことで自動蓄積されます。
      </div>
    )
  }

  return (
    <div style={{
      border: `1px solid var(--color-border-default)`,
      borderRadius: radius.lg,
      overflow: 'hidden',
    }}>
      {/* ヘッダー行 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '52px 44px 44px 1fr 52px',
        gap: 4,
        padding: '5px 10px',
        background: 'var(--color-bg-wash)',
        ...typography.caption,
        fontWeight: 700,
        color: 'var(--color-text-muted)',
      }}>
        <span>銘柄</span>
        <span>判定</span>
        <span>結果</span>
        <span>損益変化</span>
        <span>相場</span>
      </div>

      {recent.map((o, i) => {
        const bgClass = o.result === 'win' ? 'outcome-row--win' : o.result === 'loss' ? 'outcome-row--loss' : ''
        const resultCls = o.result === 'win' ? 'outcome-row__result--win' : o.result === 'loss' ? 'outcome-row__result--loss' : 'outcome-row__result--flat'
        const resultLabel = o.result === 'win' ? '◎' : o.result === 'loss' ? '✗' : '△'
        const regimeLabel = o.regime === 'bull' ? '強気' : o.regime === 'bear' ? '弱気' : o.regime === 'neutral' ? '中立' : '—'
        const deltaStr = formatPt(o.deltaPnlPct, 2)

        const holdingName = findHoldingName(o.code, holdings)

        return (
          <div key={i} className={`outcome-row ${bgClass}`}>
            <span className="outcome-row__code">
              {o.code}
              {holdingName && (
                <div style={{
                  fontSize: '9px', color: 'var(--color-text-subtle)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {holdingName}
                </div>
              )}
            </span>
            <span style={{
              ...typography.caption,
              fontWeight: 700,
              color: o.decision === 'BUY' ? 'var(--color-buy-text)' : o.decision === 'SELL' ? 'var(--color-sell-text)' : 'var(--color-hold-text)',
            }}>
              {o.decision}
            </span>
            <span className={`outcome-row__result ${resultCls}`}>{resultLabel}</span>
            <span style={{
              ...typography.caption,
              color: o.deltaPnlPct > 0 ? 'var(--color-buy-text)' : o.deltaPnlPct < 0 ? 'var(--color-sell-text)' : 'var(--color-text-muted)',
            }}>
              {deltaStr}
            </span>
            <span style={{ ...typography.caption, color: 'var(--color-text-muted)', fontSize: 9 }}>
              {regimeLabel}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── メインコンポーネント ──────────────────────────────────────
export function T8_Learning() {
  const learning = useAppStore(s => s.learning)
  const system   = useAppStore(s => s.system)

  // データなし状態
  const isEmpty = !learning || learning.outcomes.length === 0

  // レジーム別統計を memoize
  const regimeHasData = useMemo(() => {
    if (!learning) return false
    return learning.outcomes.some(o => o.regime !== undefined)
  }, [learning])

  const panelStyle = {
    padding: spacing[4],
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: spacing[4],
    maxWidth: '100%',
  }

  return (
    <div style={panelStyle}>
      <PageHeader tabId="T8" />

      {/* ── ヘッダー（P1-5: page titleはPageHeaderへ集約したためpillは削除） ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
        <div style={{ ...typography.caption, color: colors.textSubtle }}>
          予測 vs 実績 · 戦略劣化検知 · 代理別精度
        </div>
        {learning?.lastUpdated && (
          <div style={{ ...typography.caption, color: colors.textMuted, marginLeft: 'auto' }}>
            更新 {formatRelativeTime(learning.lastUpdated)}
          </div>
        )}
      </div>

      {/* ── データなし状態 ── */}
      {isEmpty && (
        <div style={{
          background: 'var(--color-bg-wash)',
          border: `1px solid var(--color-border-default)`,
          borderRadius: radius.lg,
          padding: `${spacing[5]} ${spacing[4]}`,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, marginBottom: spacing[3] }}>📊</div>
          <div style={{ ...typography.body, fontWeight: 700, marginBottom: spacing[2] }}>
            まだ学習データがありません
          </div>
          <div style={{ ...typography.bodySmall, color: colors.textSubtle }}>
            データ更新 → 分析実行 → 次回更新時に自動で予測ログが蓄積されます。<br />
            20件以上蓄積すると重み自動微調整が有効になります。
          </div>
          {system.lastUpdated && (
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[3] }}>
              最終分析: {formatDateTime(system.analysisLastRunAt)}
            </div>
          )}
        </div>
      )}

      {/* ── KPI サマリー ── */}
      {!isEmpty && learning && (
        <>
          <div className="learning-kpi-grid">
            <KpiCard
              label="総合精度"
              value={learning.summary.total >= 3 ? `${learning.summary.accuracy}%` : '—'}
              sub={`${learning.summary.total}件`}
              variant={
                learning.summary.accuracy >= 60 ? 'good' :
                learning.summary.accuracy >= 45 ? 'warn' : 'bad'
              }
            />
            <KpiCard
              label="BUY精度"
              value={learning.summary.byDecision.BUY.count >= 3
                ? `${learning.summary.byDecision.BUY.accuracy}%` : '—'}
              sub={`${learning.summary.byDecision.BUY.count}件`}
              variant={
                learning.summary.byDecision.BUY.accuracy >= 60 ? 'good' :
                learning.summary.byDecision.BUY.accuracy >= 45 ? 'warn' : 'bad'
              }
            />
            <KpiCard
              label="SELL精度"
              value={learning.summary.byDecision.SELL.count >= 3
                ? `${learning.summary.byDecision.SELL.accuracy}%` : '—'}
              sub={`${learning.summary.byDecision.SELL.count}件`}
              variant={
                learning.summary.byDecision.SELL.accuracy >= 60 ? 'good' :
                learning.summary.byDecision.SELL.accuracy >= 45 ? 'warn' : 'bad'
              }
            />
            <KpiCard
              label="平均reward"
              value={learning.summary.total >= 3
                ? learning.summary.avgReward.toFixed(2) : '—'}
              sub={`勝${learning.summary.wins}/負${learning.summary.losses}`}
              variant={
                learning.summary.avgReward > 0.1 ? 'good' :
                learning.summary.avgReward > -0.1 ? 'warn' : 'bad'
              }
            />
          </div>

          {/* ── エクイティカーブ（reward推移） ── */}
          {(() => {
            const rewardValues = learning.outcomes.map(o => o.reward)
            const pnlValues    = learning.outcomes.map(o => o.deltaPnlPct)
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[3], padding: `${spacing[3]} ${spacing[4]}`, background: colors.bgSurface, border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.lg }}>
                <h2 className="section-heading" style={{ color: colors.textSubtle }}>
                  エクイティカーブ（予測報酬推移）
                </h2>
                <SparklineChart
                  values={rewardValues}
                  width={300}
                  height={56}
                  tone={learning.summary.avgReward > 0 ? 'buy' : 'sell'}
                  label="Reward累積"
                  showZeroLine
                  showLastValue
                  formatValue={v => v.toFixed(3)}
                />
                <SparklineChart
                  values={pnlValues}
                  width={300}
                  height={56}
                  tone={learning.summary.avgReward > 0 ? 'buy' : 'sell'}
                  label="損益変化率（pt）"
                  showZeroLine
                  showLastValue
                  formatValue={v => formatPt(v, 2)}
                />
                <p style={{ ...typography.caption, color: colors.textMuted }}>
                  直近{learning.outcomes.length}件の予測vs実績ログから生成。時系列は予測順。
                </p>
              </div>
            )
          })()}

          {/* ── 戦略劣化シグナル ── */}
          <div>
            <h2 className="section-heading" style={{ marginBottom: spacing[2] }}>
              戦略劣化シグナル / 改善候補
            </h2>
            {learning.summary.driftSignals.length === 0 ? (
              <div style={{ ...typography.caption, color: colors.textMuted }}>
                現時点では劣化シグナルはありません
              </div>
            ) : (
              learning.summary.driftSignals.map((sig, i) => {
                const isOk = sig.includes('安定') || sig.includes('不要')
                return (
                  <div key={i} className={`drift-signal drift-signal--${isOk ? 'ok' : 'warn'}`}>
                    <span style={{ flexShrink: 0 }}>{isOk ? '✓' : '⚠'}</span>
                    <span>{sig}</span>
                  </div>
                )
              })
            )}
          </div>

          {/* ── 代理別（判定別）精度 ── */}
          <div>
            <h2 className="section-heading" style={{ marginBottom: spacing[2] }}>
              代理別精度 — 判定タイプ別ヒット率
            </h2>
            <DecisionAccuracySection byDecision={learning.summary.byDecision} />
          </div>

          {/* ── 重み自動微調整の提案 ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], marginBottom: spacing[2] }}>
              <h2 className="section-heading">
                スコア軸の重み提案
              </h2>
              {learning.summary.total >= 20 ? (
                <span style={{
                  ...typography.caption,
                  background: 'var(--color-buy-bg)',
                  color: 'var(--color-buy-text)',
                  border: '1px solid var(--color-buy-border)',
                  borderRadius: radius.sm,
                  padding: '1px 6px',
                }}>
                  自動適用中
                </span>
              ) : (
                <span style={{
                  ...typography.caption,
                  background: 'var(--color-bg-wash)',
                  color: colors.textMuted,
                  borderRadius: radius.sm,
                  padding: '1px 6px',
                }}>
                  {20 - learning.summary.total}件で自動適用
                </span>
              )}
            </div>
            <WeightSuggestionSection suggested={learning.suggestedWeights as unknown as Record<string, number>} />
          </div>

          {/* ── レジーム別有効性 ── */}
          <div>
            <h2 className="section-heading" style={{ marginBottom: spacing[2] }}>
              レジーム別有効性
            </h2>
            {regimeHasData ? (
              <RegimeEffectivenessSection outcomes={learning.outcomes} />
            ) : (
              <div style={{ ...typography.caption, color: colors.textMuted }}>
                レジーム付きデータが蓄積されると表示されます（次回更新から）
              </div>
            )}
          </div>

          {/* ── 予測 vs 実績ログ ── */}
          <div>
            <h2 className="section-heading" style={{ marginBottom: spacing[2] }}>
              予測 vs 実績ログ（直近30件）
            </h2>
            <OutcomeLogSection outcomes={learning.outcomes} />
          </div>

          {/* ── フッター情報 ── */}
          <div style={{
            ...typography.caption,
            color: colors.textMuted,
            paddingTop: spacing[2],
            borderTop: `1px solid var(--color-border-default)`,
          }}>
            最終更新: {formatDateTime(learning.lastUpdated)} /
            ベースライン: {learning.baselineCount}銘柄 /
            最大保持: 500件
          </div>
        </>
      )}

    </div>
  )
}
