import { useEffect, useMemo, useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useAppStore } from '../../store/useAppStore'
import {
  selectAllocationConsumerSnapshot,
  selectT7TrustAllocationProjections,
  type T7TrustAllocationProjection,
} from '../../store/allocationConsumerSelectors'
import { selectMarketDataQuality, selectEffectiveSafeModeActive, selectCandidateDecisionSynthesis } from '../../store/selectors'
import {
  SYNTHESIS_ACTION_LABEL,
  labelSynthesisReasons,
  synthesisNonExecutableReasonText,
} from '../candidates/candidateDecisionSynthesisPresentation'
import type { CandidateDecisionSynthesisEntry, CandidateDecisionSynthesisSnapshot } from '../../types/candidateDecisionSynthesis'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
import {
  buildTrustPortfolioPlan,
  type ConditionStatus,
  type TrustSignalAction,
} from '../../domain/optimization/trustPortfolio'
import { checkNoTrade } from '../../domain/optimization/idealAllocation'
import { buildTrustPlanGateInputs } from '../../domain/optimization/trustPlanInputs'
import {
  getTrustShortFilterTuning,
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
  recordTrustShortDecision,
} from '../../domain/learning/trustShortTracker'
import type { Trust, FundPhase7Map, AppState } from '../../types'

// New component system
import { DecisionCard }   from '../cards/DecisionCard'
import { InsightCard }    from '../cards/InsightCard'
import { MetricCard }     from '../cards/MetricCard'
import { ActionPanel }    from '../cards/ActionPanel'
import { SectionHeader }  from '../layout/SectionHeader'
import { PageHeader }     from '../layout/PageHeader'
import { AssetTypeBadge } from '../badges/AssetTypeBadge'
import { SignalBadge }    from '../badges/SignalBadge'
import { EmptyState }     from '../shared/EmptyState'
import { SafeModeStatusCard } from '../v13/SafeModeStatusCard'
import type { Signal }    from '../badges/SignalBadge'
import type { ActionItem } from '../cards/ActionPanel'

import { SparklineChart } from '../charts/SparklineChart'
import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import { EMBEDDED_GOLD_EXPOSURE } from '../../constants/trust'
import type { CSSProperties } from 'react'
import type { AllocationConsumerSnapshot } from '../../types/allocationConsumer'

// ── 定数・ヘルパー ──────────────────────────────────────────────

// CAND-SYN-1E: T7「未保有投信候補」の唯一の候補UI authority。
// candidateDecisionSynthesis.decisions/watchList（canonical order のまま、
// 各配列内の並びを保持し decisions→watchList の順で連結）のみを読み、
// JP_TRUST × new_to_portfolio × (BUY_NEW|WATCH) のみを抽出する。
// null/unavailable/invalid synthesis は空配列にfail-closedし、
// officialDecision/candidatePortfolioRecommendationsへのフォールバックはしない。
// sort/rank/score/marketRank/money計算は一切行わない。
export function computeTrustSynthesisCandidatesForDisplay(
  synthesis: CandidateDecisionSynthesisSnapshot | null,
): readonly CandidateDecisionSynthesisEntry[] {
  if (synthesis === null || synthesis.status !== 'available') return []
  const isUnheldTrustCandidate = (entry: CandidateDecisionSynthesisEntry) =>
    entry.assetClass === 'JP_TRUST' &&
    entry.relationship === 'new_to_portfolio' &&
    (entry.action === 'BUY_NEW' || entry.action === 'WATCH')
  return [...synthesis.decisions, ...synthesis.watchList].filter(isUnheldTrustCandidate).slice(0, 3)
}

// CAND-SYN-1E / D26: WATCHは既存の非実行理由プロジェクタをそのまま使う。
// BUY_NEWはcanonical whyThisエビデンスがあればその先頭を、なければ
// officialDecision.reasonに由来しない中立固定文言を表示する（金額は導入しない）。
export function trustSynthesisCandidateReasonText(entry: CandidateDecisionSynthesisEntry): string {
  if (entry.action === 'WATCH') {
    return synthesisNonExecutableReasonText(entry) ?? '実行条件を満たしていません'
  }
  const whyThis = labelSynthesisReasons(entry.whyThis)
  if (whyThis.length > 0) return whyThis[0]
  return '新規保有の検討候補です'
}

const POLICY_LABEL: Record<Trust['policy'], string> = {
  JAPAN_SHORTTERM:  '日本株系',
  OVERSEAS_LONGTERM:'海外資産系',
  GOLD:             'ゴールド（分散）',
}

const HORIZON_LABEL: Record<Trust['policy'], string> = {
  JAPAN_SHORTTERM:  '超短期',
  OVERSEAS_LONGTERM:'中長期',
  GOLD:             '中長期',
}

function signalToSignal(s: 'BULL' | 'BEAR' | 'WAIT'): Signal {
  if (s === 'BULL') return 'BUY'
  if (s === 'BEAR') return 'SELL'
  return 'WATCH'
}

function conditionLabel(status: ConditionStatus) {
  if (status === 'pass') return '達成'
  if (status === 'warn') return '境界'
  return '未達'
}

function actionToSignal(action: TrustSignalAction): Signal {
  if (action === 'BUY' || action === 'BULL') return 'BUY'
  if (action === 'EXIT' || action === 'TRIM' || action === 'BEAR') return 'SELL'
  if (action === 'WAIT') return 'WATCH'
  return 'HOLD'
}

// P4-A156: SAFE_MODE/DQ抑制中はBUY表示のみWATCHに変換する（表示専用）。
// SELL/TRIM/EXIT/HOLD等はそのまま維持し、防御・監視表示を弱めない。
// item.decision/row.recommendation自体やbuildTrustPortfolioPlanの結果は変更しない。
function suppressBuySignal(signal: Signal, isSuppressed: boolean): Signal {
  return isSuppressed && signal === 'BUY' ? 'WATCH' : signal
}

function isShortTermCandidate(item: Trust) {
  return item.policy === 'JAPAN_SHORTTERM'
}

// ── Phase7FundSection ─────────────────────────────────────────
// calculation-only, not an order, not a recommendation

function Phase7FundSection({
  funds,
  phase7Map,
}: {
  funds: Trust[]
  phase7Map: FundPhase7Map
}) {
  const entries = funds
    .filter(f => f.policy === 'JAPAN_SHORTTERM')
    .map(f => ({ fund: f, p7: phase7Map[f.id] ?? null }))
    .filter(x => x.p7 !== null)

  if (entries.length === 0) return null

  return (
    <section>
      <div style={{ marginBottom: spacing[2] }}>
        <p style={{ ...typography.sectionTitle, color: colors.jpFundAccentText }}>
          Phase 7 観察スコア (calculation-only)
        </p>
        <p style={{ ...typography.caption, color: colors.textMuted }}>
          バックエンド計算観察値 — 注文指示ではありません
        </p>
      </div>
      <div style={{
        background: colors.bgSurface, border: `1px solid ${colors.borderSubtle}`,
        borderRadius: radius.lg, boxShadow: shadow.sm, overflow: 'hidden',
      }}>
        {/* ヘッダー */}
        <div style={{
          padding: `${spacing[2]} ${spacing[4]}`,
          background: colors.jpFundAccentBg,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <p style={{ ...typography.label, color: colors.jpFundAccentText }}>
            国内株投信 Phase 7 観察値
          </p>
          <span style={{
            fontSize: '10px', color: colors.textMuted,
            background: colors.bgBase, border: `1px solid ${colors.borderSubtle}`,
            borderRadius: radius.sm, padding: `1px ${spacing[1.5]}`,
          }}>
            calculation-only
          </span>
        </div>

        {entries.map(({ fund, p7 }, idx) => (
          <div key={fund.id} style={{
            padding: `${spacing[3]} ${spacing[4]}`,
            borderBottom: idx < entries.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
            borderLeft: `3px solid ${colors.jpFundAccent}`,
          }}>
            {/* ファンド名行 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing[2], flexWrap: 'wrap', gap: spacing[1] }}>
              <span style={{ ...typography.label, color: colors.jpFundAccentText, background: colors.jpFundAccentBg, padding: `${spacing[0.5]} ${spacing[1.5]}`, borderRadius: radius.sm }}>
                {fund.abbr}
              </span>
              <span style={{ ...typography.caption, color: colors.textMuted }}>
                {p7!.fund_name}
              </span>
            </div>

            {/* 観察値グリッド */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: `${spacing[1]} ${spacing[3]}`, marginBottom: spacing[2] }}>
              {([
                { label: '行動スコア (観察)', value: `${p7!.behavioral_score.toFixed(1)}` },
                { label: '信頼度 (観察)', value: `${(p7!.committee_confidence * 100).toFixed(0)}%` },
                { label: 'サイズ上限 (観察)', value: `×${p7!.sizing_multiplier_cap.toFixed(2)}` },
                { label: '調整サイズ (観察)', value: `${(p7!.adjusted_size * 100).toFixed(1)}%` },
              ] as Array<{ label: string; value: string }>).map(m => (
                <div key={m.label} style={{ display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
                  <span style={{ ...typography.caption, color: colors.textMuted }}>{m.label}</span>
                  <span style={{ ...typography.metricSmall, color: colors.jpFundAccentText }}>{m.value}</span>
                </div>
              ))}
            </div>

            {/* サイズ上限バー */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: spacing[0.5] }}>
                <span style={{ ...typography.caption, color: colors.textMuted }}>サイズ上限観察値</span>
                <span style={{ fontSize: '10px', color: colors.jpFundAccentText, fontWeight: 700 }}>
                  {(p7!.sizing_multiplier_cap * 100).toFixed(0)}%
                </span>
              </div>
              <div style={{ height: '4px', background: colors.bgElevated, borderRadius: '99px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${p7!.sizing_multiplier_cap * 100}%`,
                  background: colors.jpFundAccent,
                  borderRadius: '99px',
                }} />
              </div>
            </div>
          </div>
        ))}

        {/* ディスクレーマー */}
        <div style={{ padding: `${spacing[2]} ${spacing[4]}`, background: colors.bgElevated }}>
          <p style={{ ...typography.caption, color: colors.textMuted }}>
            このスコアは計算観察値です。注文指示ではありません。
            （Phase 7 calculation-only, not an order, not a recommendation）
          </p>
        </div>
      </div>
    </section>
  )
}

export interface T7TrustAllocationPanelProps {
  readonly consumerSnapshot: AllocationConsumerSnapshot
  readonly projection: T7TrustAllocationProjection | null
  readonly isMobile: boolean
}

export function T7TrustAllocationPanel({
  consumerSnapshot,
  projection,
  isMobile,
}: T7TrustAllocationPanelProps) {
  const unavailableCopy = consumerSnapshot.availability === 'unavailable'
    ? consumerSnapshot.reasonKind === 'UNKNOWN_REASON_CODE'
      ? { title: '配分プランを利用できません', detail: '不明な状態を検出しました。再計算してください。' }
      : consumerSnapshot.status === 'stale'
        ? { title: '配分プランの再計算が必要です', detail: '旧い金額は表示していません。' }
        : consumerSnapshot.status === 'invalid'
          ? { title: '配分プランを計算できません', detail: '金額を確認できる状態になるまで表示を停止しています。' }
          : { title: '配分プランは未計算です', detail: '計算完了後に金額を表示します。' }
    : null

  if (consumerSnapshot.availability === 'unavailable' || projection === null) {
    const copy = unavailableCopy ?? {
      title: '国内株投信の配分プランを利用できません',
      detail: 'JP_TRUST クラスの計算完了後に金額を表示します。',
    }
    return (
      <div
        role="status"
        data-allocation-availability="unavailable"
        data-allocation-status={consumerSnapshot.status}
        style={{
          background: colors.bgSurface,
          border: `1px solid ${colors.borderSubtle}`,
          borderRadius: radius.lg,
          boxShadow: shadow.sm,
          padding: isMobile ? spacing[4] : `${spacing[4]} ${spacing[5]}`,
        }}
      >
        <div style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>
          {copy.title}
        </div>
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
          {copy.detail}
        </div>
      </div>
    )
  }

  const { snapshot, jpTrustClass, jpTrustInstruments } = projection
  const isEstimateOnly = snapshot.status === 'estimate_only'
  const isCurrent = snapshot.status === 'current'
  const statusLabel = isCurrent
    ? '最新'
    : isEstimateOnly
      ? '見積のみ（実行不可）'
      : '実行不可'
  const classMetrics = isEstimateOnly
    ? [
        { label: '目標差分（不足）', amount: jpTrustClass.targetGap },
        { label: 'クラスheadroom', amount: jpTrustClass.effectiveHeadroom },
        { label: '利用可能予算', amount: jpTrustClass.availableBudget },
      ]
    : [
        { label: 'クラス評価額', amount: jpTrustClass.currentAmount },
        { label: '目標額', amount: jpTrustClass.targetAmount },
        { label: '目標差分（不足）', amount: jpTrustClass.targetGap },
        { label: '短期予算上限', amount: snapshot.shortTermBudget },
        { label: 'クラスheadroom', amount: jpTrustClass.effectiveHeadroom },
        { label: '利用可能予算', amount: jpTrustClass.availableBudget },
        { label: '配分済額', amount: jpTrustClass.allocatedAmount },
        { label: '割当後の残余', amount: jpTrustClass.remainingHeadroom },
      ]

  return (
    <div
      data-allocation-availability="available"
      data-allocation-status={snapshot.status}
      data-snapshot-id={snapshot.generation.snapshotId}
      data-snapshot-executability={snapshot.snapshotExecutability}
      data-source-holdings-snapshot-id={snapshot.generation.sourceHoldingsSnapshotId}
      data-source-settings-version={snapshot.generation.sourceSettingsVersion}
      data-source-candidate-generation-id={snapshot.generation.sourceCandidateGenerationId ?? ''}
      data-class-full-cause={jpTrustClass.classFullCause ?? ''}
      data-instrument-plan-count={String(jpTrustClass.instrumentPlanCount)}
      data-class-allocated-amount={String(jpTrustClass.allocatedAmount)}
    >
      <div style={{
        display: 'flex',
        alignItems: isMobile ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        flexDirection: isMobile ? 'column' : 'row',
        gap: spacing[1],
        marginBottom: spacing[3],
      }}>
        <div style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>
          配分プラン: {statusLabel}
        </div>
        <div style={{ ...typography.caption, color: colors.textMuted }}>
          実行可能性: {snapshot.snapshotExecutability} / 更新 {formatDateTime(snapshot.generation.generatedAt)}
        </div>
      </div>
      <div style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[3] }}>
        snapshot: ブロック {snapshot.blockedReasons.length}件 / 警告 {snapshot.warnings.length}件 ・
        JP_TRUST: ブロック {jpTrustClass.blockedReasons.length}件 / 警告 {jpTrustClass.warningReasons.length}件 /
        制約 {jpTrustClass.limitingFactors.length}件
        {isEstimateOnly && (
          <span data-estimate-only-warning="present"> ・ 見積のみ警告あり</span>
        )}
      </div>
      {/* UI-9: 現在額/目標額の視覚的比較（表示専用。金額テキストは重複表示せず、下のクラス評価額/目標額カードのみに委ねる） */}
      {!isEstimateOnly && (
        <div style={{ marginBottom: spacing[3] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...typography.caption, color: colors.textMuted, marginBottom: spacing[1] }}>
            <span>現在 → 目標</span>
            <span>{jpTrustClass.targetAmount > 0 ? `${Math.round((jpTrustClass.currentAmount / jpTrustClass.targetAmount) * 100)}%` : '—'}</span>
          </div>
          <div style={{ height: 8, borderRadius: radius.full, background: colors.bgElevated, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.round(Math.min(1, Math.max(0, jpTrustClass.targetAmount > 0 ? jpTrustClass.currentAmount / jpTrustClass.targetAmount : 0)) * 100)}%`,
              background: jpTrustClass.currentAmount > jpTrustClass.targetAmount ? colors.waitText : colors.stockAccent,
              borderRadius: radius.full,
            }} />
          </div>
        </div>
      )}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: spacing[3],
        marginBottom: spacing[4],
      }}>
        {classMetrics.map(metric => (
          <MetricCard key={metric.label} title={metric.label} value={formatJPYAuto(metric.amount)} />
        ))}
        <MetricCard title="配分候補" value={`${jpTrustClass.instrumentPlanCount}件`} />
      </div>
      {jpTrustInstruments.length === 0 ? (
        <div style={{ ...typography.bodySmall, color: colors.textMuted }}>配分候補なし</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
          {jpTrustInstruments.map(instrument => {
            const instrumentMetrics = isEstimateOnly
              ? [
                  { label: '参考上限', amount: instrument.estimatedMaximumAmount },
                  { label: '個別headroom', amount: instrument.effectiveInstrumentHeadroom },
                ]
              : isCurrent
                ? [
                    { label: '保有額', amount: instrument.currentAmount },
                    { label: '参考上限', amount: instrument.estimatedMaximumAmount },
                    { label: '配分額', amount: instrument.allocatedAmount },
                    { label: '実行選択額', amount: instrument.finalSuggestedAmount },
                    { label: '個別headroom', amount: instrument.effectiveInstrumentHeadroom },
                  ]
                : [
                    { label: '保有額', amount: instrument.currentAmount },
                    { label: '参考上限', amount: instrument.estimatedMaximumAmount },
                    { label: '個別headroom', amount: instrument.effectiveInstrumentHeadroom },
                  ]
            return (
              <div
                key={instrument.instrumentId}
                data-allocation-instrument-id={instrument.instrumentId}
                data-allocation-asset-class={instrument.assetClass}
                data-instrument-allocated-amount={String(instrument.allocatedAmount)}
                data-instrument-executable={String(instrument.executable)}
                style={{
                  padding: `${spacing[3]} ${spacing[4]}`,
                  background: colors.bgSurface,
                  border: `1px solid ${colors.borderSubtle}`,
                  borderRadius: radius.md,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: spacing[2], flexWrap: 'wrap' }}>
                  <strong style={{ ...typography.bodySmall, color: colors.textPrimary }}>
                    {instrument.instrumentId}
                  </strong>
                  <span style={{ ...typography.caption, color: colors.textMuted }}>
                    {instrument.role ?? '役割未設定'} / {instrument.buyKind} / {instrument.relationship} /
                    {isCurrent && instrument.executable ? ' 実行可' : ' 実行不可'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing[3], marginTop: spacing[2] }}>
                  {instrumentMetrics.map(metric => (
                    <span key={metric.label} style={{ ...typography.caption, color: colors.textSubtle }}>
                      {metric.label} {formatJPYAuto(metric.amount)}
                    </span>
                  ))}
                </div>
                <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
                  ブロック {instrument.blockedReasons.length}件 / 警告 {instrument.warningReasons.length}件 /
                  制約 {instrument.limitingFactors.length}件
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── コンポーネント ──────────────────────────────────────────────

export function T7_Trust() {
  const isMobile       = useIsMobile()
  const allocationConsumerSnapshot = useAppStore(selectAllocationConsumerSnapshot)
  const allocationProjection = useAppStore(selectT7TrustAllocationProjections)
  const trust          = useAppStore(state => state.trust)
  const market         = useAppStore(state => state.market)
  const macro          = useAppStore(state => state.macro)
  const news           = useAppStore(state => state.news)
  const fundPhase7     = useAppStore(state => state.fundPhase7)
  const sqCalendar     = useAppStore(state => state.sqCalendar)
  const margin         = useAppStore(state => state.margin)
  const flows          = useAppStore(state => state.flows)
  const universe       = useAppStore(state => state.universe)
  const candidateDecisionSynthesis = useAppStore(selectCandidateDecisionSynthesis)
  const safeMode       = useAppStore(s => s.safeMode)
  const tierAViolations = useAppStore(s => s.tierAViolations)
  const tierAAlerts    = useAppStore(s => s.tierAAlerts)
  const system         = useAppStore(s => s.system)
  const dq             = useAppStore(selectMarketDataQuality)

  // P4-A106: 表示専用抑制変数 — T2_Holdings/T2_JpFundと同条件に統一
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive  = useAppStore(selectEffectiveSafeModeActive)
  const isSuppressed    = safeModeActive || dq.isSuppressed

  const [trackingStats, setTrackingStats]   = useState(() => getTrustShortTrackingStats())
  const [todayEntryCount, setTodayEntryCount] = useState(() => getTrustShortTodayExecutionCount())
  const shortTuning = useMemo(() => getTrustShortFilterTuning(90), [trackingStats])

  // P4-A144: VIX/日経VI/SQ由来のnoTrade判定（useAppStore.runFullAnalysisと同一入力）
  const noTradeResult = useMemo(
    () => checkNoTrade({ market, macro, sqCalendar } as AppState),
    [market, macro, sqCalendar],
  )

  // P4-A144: JP_TRUST headroom / noTrade(VIX-VI-SQ or SAFE_MODE or DQ)をT7のtrustPlan生成に配線する
  const gateInputs = useMemo(
    () =>
      buildTrustPlanGateInputs({
        universe,
        noTradeResult,
        safeModeActive,
        dqSuppressed: dq.isSuppressed,
      }),
    [universe, noTradeResult, safeModeActive, dq.isSuppressed],
  )

  const localTrustPlan = useMemo(
    () =>
      buildTrustPortfolioPlan({
        trust, market, macro, news, sqCalendar, margin, flows,
        todayEntryCount,
        performance30d: trackingStats,
        noTrade: gateInputs.noTrade,
        jpTrustHeadroom: gateInputs.jpTrustHeadroom,
      }),
    [flows, macro, margin, market, news, sqCalendar, todayEntryCount, trackingStats, trust, gateInputs],
  )
  const trustPlan = localTrustPlan

  useEffect(() => {
    const next = recordTrustShortDecision({
      date:              new Date().toISOString(),
      decision:          trustPlan.shortTermMode.decision,
      confidence:        trustPlan.shortTermMode.confidence,
      executed:          false,
      nikkeiChgPct:      market.nikkeiChgPct,
      futuresChgPct:     trustPlan.marketContext.nikkeiFuturesDirection,
      conditionsPassed:  trustPlan.shortTermMode.conditionsPassed,
      vix:               trustPlan.marketContext.vix,
      nikkeiVI:          trustPlan.marketContext.nikkeiVI,
      volatilitySpread:  trustPlan.marketContext.volatilitySpread,
    })
    setTrackingStats(prev =>
      prev.trackedDays === next.trackedDays &&
      prev.executions  === next.executions  &&
      prev.waitDays    === next.waitDays    &&
      prev.winRate     === next.winRate     &&
      prev.postWaitWinRate === next.postWaitWinRate
        ? prev : next,
    )
    setTodayEntryCount(getTrustShortTodayExecutionCount())
  }, [
    market.nikkeiChgPct,
    trustPlan.marketContext.nikkeiFuturesDirection,
    trustPlan.shortTermMode.confidence,
    trustPlan.shortTermMode.conditionsPassed,
    trustPlan.shortTermMode.decision,
  ])

  const handleMarkExecuted = () => {
    const next = recordTrustShortDecision({
      date:             new Date().toISOString(),
      decision:         trustPlan.shortTermMode.candidateDirection,
      confidence:       trustPlan.shortTermMode.confidence,
      executed:         true,
      nikkeiChgPct:     market.nikkeiChgPct,
      futuresChgPct:    trustPlan.marketContext.nikkeiFuturesDirection,
      conditionsPassed: trustPlan.shortTermMode.conditionsPassed,
      vix:              trustPlan.marketContext.vix,
      nikkeiVI:         trustPlan.marketContext.nikkeiVI,
      volatilitySpread: trustPlan.marketContext.volatilitySpread,
    })
    setTrackingStats(next)
    setTodayEntryCount(getTrustShortTodayExecutionCount())
  }

  // ── 集計値 ─────────────────────────────────────────────────

  const totalEval = trust.reduce((sum, item) => sum + item.eval, 0)
  const totalPnl  = trust.reduce((sum, item) => sum + (item.eval - item.eval / (1 + item.pnlPct / 100)), 0)
  const weightedCost = totalEval > 0
    ? trust.reduce((sum, item) => sum + item.cost * item.eval, 0) / totalEval
    : 0

  const japanShortTermTrust = useMemo(() => trust.filter(item => isShortTermCandidate(item) && item.eval > 0), [trust])
  const allFundGroups = useMemo(
    () =>
      (['JAPAN_SHORTTERM', 'OVERSEAS_LONGTERM', 'GOLD'] as const).map(policy => ({
        policy,
        items: trust.filter(item => item.policy === policy && item.eval > 0).sort((a, b) => b.eval - a.eval),
        total: trust.filter(item => item.policy === policy).reduce((sum, item) => sum + item.eval, 0),
      })),
    [trust],
  )

  // ── 実効GOLDエクスポージャー参考計算 ────────────────────────
  const directGoldEval = useMemo(
    () => trust.filter(t => t.policy === 'GOLD').reduce((s, t) => s + t.eval, 0),
    [trust],
  )
  const embeddedGoldEval = useMemo(
    () => trust.reduce((s, t) => {
      const ex = EMBEDDED_GOLD_EXPOSURE[t.id]
      return s + (ex ? t.eval * ex.navGoldExposure : 0)
    }, 0),
    [trust],
  )
  const effectiveGoldEval  = directGoldEval + embeddedGoldEval
  const portfolioTotalValue = universe?.totalValue ?? 0
  const effectiveGoldRatio  = portfolioTotalValue > 0 ? effectiveGoldEval / portfolioTotalValue : 0
  const directGoldRatio     = portfolioTotalValue > 0 ? directGoldEval / portfolioTotalValue : 0

  // ── 判定・InsightCard データ ───────────────────────────────

  // P4-A106: 表示専用 — signal算出ロジック変更なし
  const portfolioSignal: Signal = isSuppressed ? 'WATCH' : signalToSignal(trustPlan.shortTermSignal)

  const passedConditions = trustPlan.shortTermMode.checklist
    .filter(c => c.status === 'pass')
    .map(c => c.label + ': ' + c.detail)

  const allRisks: string[] = [
    ...(trustPlan.shortTermMode.waitReasons ?? []),
    trustPlan.shortTermMode.leveragedWarning,
  ].filter(Boolean).slice(0, 4)

  const actionText = isSuppressed
    ? 'SAFE_MODE / DQ抑制中 — 新規買い判断停止中。シグナルは参考値のみ。'
    : `${trustPlan.shortTermMode.decision === 'BULL' ? 'ブル推奨' : trustPlan.shortTermMode.decision === 'BEAR' ? 'ベア推奨' : '待機推奨'} — ${trustPlan.shortTermMode.takeProfitRule} / 損切: ${trustPlan.shortTermMode.stopLossRule}`

  // ActionPanel 用: 投信アクションキュー
  const actionItems: ActionItem[] = isSuppressed
    ? [{
        label:       'SAFE_MODE / DQ抑制中',
        description: 'SAFE_MODE または DQ低下のため短期投信シグナルを停止中。最新データ確認後に再判定。',
        signal:      'WATCH' as Signal,
        priority:    'HIGH',
      }]
    : trustPlan.executionQueue.map(item => ({
        label:       item.title,
        signal:      actionToSignal(item.action),
        priority:    item.priority === 'high' ? 'HIGH' : item.priority === 'medium' ? 'MEDIUM' : 'LOW',
      }))

  // ── スタイル定義 ────────────────────────────────────────────

  const panelStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[5],
    padding:       isMobile ? `${spacing[4]} ${spacing[3]}` : `${spacing[5]} ${spacing[5]}`,
    maxWidth:      '1100px',
    margin:        '0 auto',
  }

  const metricsGridStyle: CSSProperties = {
    display:             'grid',
    gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(150px, 1fr))',
    gap:                 spacing[3],
  }

  const twoColStyle: CSSProperties = {
    display:             'grid',
    gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(320px, 1fr))',
    gap:                 spacing[4],
  }

  const cardStyle: CSSProperties = {
    background:   colors.bgSurface,
    border:       `1px solid ${colors.borderSubtle}`,
    borderRadius: radius.lg,
    boxShadow:    shadow.sm,
    overflow:     'hidden',
  }

  const cardBodyStyle: CSSProperties = {
    padding: `${spacing[4]} ${spacing[5]}`,
  }

  // 条件チェックリスト行
  const condRowStyle = (status: ConditionStatus): CSSProperties => ({
    display:      'flex',
    alignItems:   'center',
    gap:          spacing[3],
    padding:      `${spacing[2.5]} ${spacing[4]}`,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    background:
      status === 'pass' ? colors.buyBg :
      status === 'warn' ? colors.watchBg :
      colors.sellBg,
  })

  const condMeterStyle: CSSProperties = {
    width:        '48px',
    height:       '4px',
    background:   colors.borderSubtle,
    borderRadius: radius.full,
    overflow:     'hidden',
    flexShrink:   0,
  }

  const condMeterFillStyle = (status: ConditionStatus): CSSProperties => ({
    width:        status === 'pass' ? '100%' : status === 'warn' ? '60%' : '30%',
    height:       '100%',
    background:   status === 'pass' ? colors.buy : status === 'warn' ? colors.watch : colors.sell,
    borderRadius: radius.full,
  })

  // 投信ランクバッジ (fund紫)
  const fundBadgeStyle = (signal: Signal): CSSProperties => ({
    ...typography.badge,
    padding:      `${spacing[0.5]} ${spacing[2]}`,
    background:   signal === 'BUY'  ? colors.buyBg  :
                  signal === 'SELL' ? colors.sellBg : colors.fundAccentBg,
    color:        signal === 'BUY'  ? colors.buyText  :
                  signal === 'SELL' ? colors.sellText : colors.fundAccentText,
    border:       `1px solid ${signal === 'BUY' ? colors.buy : signal === 'SELL' ? colors.sell : colors.fundAccent}`,
    borderRadius: radius.full,
    whiteSpace:   'nowrap',
    flexShrink:   0,
  })

  // ファンドカード
  const fundCardStyle = (signal: Signal): CSSProperties => ({
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[2],
    padding:       `${spacing[4]} ${spacing[4]}`,
    background:    colors.bgSurface,
    border:        `1px solid ${signal === 'BUY' ? colors.buy : signal === 'SELL' ? colors.sell : colors.fundAccent}`,
    borderTop:     `3px solid ${signal === 'BUY' ? colors.buy : signal === 'SELL' ? colors.sell : colors.fundAccent}`,
    borderRadius:  radius.md,
  })

  const fundGridStyle: CSSProperties = {
    display:             'grid',
    gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))',
    gap:                 spacing[3],
  }

  return (
    <div style={panelStyle}>
      <PageHeader tabId="T7" />

      {/* ━━━ 1. Today Decision Hero ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <DecisionCard
        decision={portfolioSignal}
        title="投信 当日実行判断（短期戦術）"
        score={trustPlan.shortTermMode.confidence}
        reasons={isSuppressed ? [
          '⚠ SAFE_MODE / DQ抑制中 — 新規買い判断停止中',
          '短期シグナルは参考値のみ',
          `1日上限 ${todayEntryCount}/1 ${todayEntryCount >= 1 ? '— 本日執行済み' : '— 未執行'}`,
        ] : [
          trustPlan.shortTermSummary,
          `条件一致 ${trustPlan.shortTermMode.conditionsPassed}/${trustPlan.shortTermMode.checklist.length}`,
          `1日上限 ${todayEntryCount}/1 ${todayEntryCount >= 1 ? '— 本日執行済み' : '— 未執行'}`,
        ]}
        riskLevel={
          trustPlan.shortTermSignal === 'BEAR' ? 'HIGH' :
          trustPlan.shortTermSignal === 'WAIT' ? 'MEDIUM' : 'LOW'
        }
        assetType="fund"
      />

      {/* ━━━ SAFE_MODE / TierA 運用状態（P4-A101: DecisionCard直後へ移動） ━━━ */}
      <SafeModeStatusCard
        safeMode={safeMode}
        safeModeSource={system.dataSourceStatus.safeMode}
        safeModeLastChecked={system.dataTimestamps?.safeMode}
        tierAViolations={tierAViolations}
        tierAAlerts={tierAAlerts}
      />

      {/* ━━━ 投信概要メトリクス ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader
          title="投信ポートフォリオ状態"
          action={<AssetTypeBadge type="fund" />}
        />
        <div style={metricsGridStyle}>
          <MetricCard
            title="総評価額"
            value={formatJPYAuto(totalEval)}
            accent
            assetType="fund"
          />
          <MetricCard
            title="含み損益"
            value={`${totalPnl >= 0 ? '+' : ''}${formatJPYAuto(totalPnl)}`}
            change={{ value: totalPnl >= 0 ? '含み益' : '含み損', positive: totalPnl >= 0 }}
          />
          <MetricCard
            title="加重コスト"
            value={`${weightedCost.toFixed(2)}%`}
            change={{ value: weightedCost > 0.8 ? '高コスト' : '適正', positive: weightedCost <= 0.5 }}
          />
          <MetricCard
            title="日本株投信"
            value={`${japanShortTermTrust.length} 本`}
            subtext="超短期対象"
            assetType="fund"
          />
        </div>
      </section>

      {/* ━━━ 0. 運用方針別分類 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader title="運用方針別ファンド" action={<AssetTypeBadge type="fund" />} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[5] }}>
          {allFundGroups.map(group => {
            if (group.items.length === 0) return null
            return (
              <div key={group.policy}>
                {/* グループヘッダー */}
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], marginBottom: spacing[3], padding: `${spacing[2]} ${spacing[3]}`, background: colors.fundAccentBg, border: `1px solid ${colors.fundAccent}`, borderRadius: radius.md }}>
                  <span style={{ ...typography.sectionTitle, color: colors.fundAccentText }}>{POLICY_LABEL[group.policy]}</span>
                  <span style={{ ...typography.badge, color: colors.textMuted, background: colors.bgBase, border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.full, padding: `${spacing[0.5]} ${spacing[2]}` }}>
                    {HORIZON_LABEL[group.policy]}
                  </span>
                  <span style={{ ...typography.caption, color: colors.textMuted, marginLeft: 'auto' }}>
                    {formatJPYAuto(group.total)} / {(group.total / Math.max(totalEval, 1) * 100).toFixed(1)}%
                  </span>
                </div>
                {/* 保有ファンドカードグリッド */}
                <div style={fundGridStyle}>
                  {group.items.map(item => {
                    // P4-A156: SAFE_MODE/DQ抑制中はBUYバッジのみWATCHへ変換（表示専用。item.decisionは変更しない）
                    const fSig = suppressBuySignal(
                      actionToSignal(
                        item.decision === 'SELL' ? 'TRIM' :
                        item.decision === 'BUY'  ? 'BUY'  : 'HOLD'
                      ),
                      isSuppressed,
                    )
                    const fundBadgeLabel = fSig === 'WATCH' ? 'WATCH' : item.decision
                    return (
                      <div key={item.id} style={fundCardStyle(fSig)}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing[2] }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[1.5], marginBottom: spacing[1] }}>
                              <span style={{ ...typography.label, color: colors.fundAccentText, background: colors.fundAccentBg, padding: `${spacing[0.5]} ${spacing[1.5]}`, borderRadius: radius.sm }}>
                                {item.abbr}
                              </span>
                              <span style={{ ...typography.badge, color: colors.textMuted, background: colors.bgBase, border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.full, padding: `${spacing[0.5]} ${spacing[1.5]}` }}>
                                {HORIZON_LABEL[item.policy]}
                              </span>
                            </div>
                            <p style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 600 }}>{item.name}</p>
                          </div>
                          <span style={fundBadgeStyle(fSig)}>{fundBadgeLabel}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: `${spacing[1]} ${spacing[3]}` }}>
                          {[
                            { label: '評価額',   value: formatJPYAuto(item.eval) },
                            { label: '損益率',   value: `${item.pnlPct >= 0 ? '+' : ''}${item.pnlPct.toFixed(2)}%`,  color: item.pnlPct >= 0 ? colors.buyText : colors.sellText },
                            { label: '当日',     value: `${item.dayPct >= 0 ? '+' : ''}${item.dayPct.toFixed(2)}%`,  color: item.dayPct >= 0 ? colors.buyText : colors.sellText },
                            { label: '費用',     value: `${item.cost.toFixed(2)}%` },
                            { label: '期待収益', value: `${(item.mu * 100).toFixed(1)}%` },
                            { label: 'スコア',   value: String(item.score) },
                          ].map(m => (
                            <div key={m.label} style={{ display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
                              <span style={{ ...typography.caption, color: colors.textMuted }}>{m.label}</span>
                              <span style={{ ...typography.metricSmall, color: m.color ?? colors.textPrimary }}>{m.value}</span>
                            </div>
                          ))}
                        </div>
                        {item.signal && (
                          <p style={{ ...typography.caption, color: colors.fundAccentText, borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: spacing[1.5] }}>
                            {item.signal}
                          </p>
                        )}
                        {EMBEDDED_GOLD_EXPOSURE[item.id] && (() => {
                          const ex = EMBEDDED_GOLD_EXPOSURE[item.id]
                          return (
                            <p style={{ ...typography.caption, color: colors.gold, background: colors.goldBg, border: `1px solid ${colors.goldBorder}`, borderRadius: radius.sm, padding: `${spacing[0.5]} ${spacing[1.5]}`, marginTop: spacing[1.5] }}>
                              内包GOLD {Math.round(ex.navGoldExposure * 100)}%相当 / 総EX内{Math.round(ex.grossGoldShare * 100)}%
                            </p>
                          )
                        })()}
                      </div>
                    )
                  })}
                </div>
                {/* 日本株系: 保有中 vs 短期実行候補 比較 (DQ抑制時は非表示) */}
                {group.policy === 'JAPAN_SHORTTERM' && trustPlan.shortTermRows.length > 0 && !isSuppressed && (
                  <div style={{ marginTop: spacing[3], background: colors.bgSurface, border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.lg, overflow: 'hidden' }}>
                    <div style={{ padding: `${spacing[2]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}`, background: colors.fundAccentBg }}>
                      <p style={{ ...typography.label, color: colors.fundAccentText }}>短期実行候補（優先度順）</p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[0] }}>
                      {trustPlan.shortTermRows.map((row, idx) => {
                        const sig = actionToSignal(row.action)
                        return (
                          <div key={row.id} style={{ display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', alignItems: isMobile ? 'flex-start' : 'center', gap: spacing[2], padding: `${spacing[3]} ${spacing[4]}`, borderBottom: idx < trustPlan.shortTermRows.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none', borderLeft: `3px solid ${sig === 'BUY' ? colors.buy : sig === 'SELL' ? colors.sell : colors.fundAccent}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
                              <span style={{ ...typography.caption, color: colors.textMuted, minWidth: '20px', textAlign: 'right' }}>
                                {idx + 1}
                              </span>
                              <span style={{ ...typography.label, color: colors.fundAccentText, background: colors.fundAccentBg, padding: `${spacing[0.5]} ${spacing[1.5]}`, borderRadius: radius.sm, flexShrink: 0 }}>
                                {row.abbr}
                              </span>
                              <SignalBadge signal={sig} size="sm" />
                              <span style={{ ...typography.caption, color: colors.textMuted, flexShrink: 0 }}>
                                {row.role === 'CORE' ? 'コア' : 'サテライト'} / {row.score}%
                              </span>
                            </div>
                            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: `${spacing[0.5]} ${spacing[2]}` }}>
                              {row.rationale.slice(0, 2).map(r => (
                                <span key={r} style={{ ...typography.caption, color: colors.textSubtle }}>{r}</span>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ━━━ GOLDエクスポージャー参考指標 ━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader title="GOLDエクスポージャー（参考）" />
        <div style={metricsGridStyle}>
          <MetricCard
            title="直接GOLD"
            value={formatJPYAuto(directGoldEval)}
            subtext={`${(directGoldRatio * 100).toFixed(2)}% — 純金ファンド合計`}
          />
          <MetricCard
            title="内包GOLD"
            value={formatJPYAuto(embeddedGoldEval)}
            subtext="S&P+Gold + NQ+Gold × NAV100%"
          />
          <MetricCard
            title="実効GOLD（参考）"
            value={formatJPYAuto(effectiveGoldEval)}
            subtext={`総資産比 ${(effectiveGoldRatio * 100).toFixed(2)}%`}
            accent
          />
        </div>
        <p style={{ ...typography.caption, color: colors.textMuted, padding: `${spacing[1]} ${spacing[1]}` }}>
          参考値: 直接GOLD + 内包GOLD（NAV比100%相当）の合算。最適化ロジックへは未反映。
        </p>
      </section>

      {/* ━━━ 2. 短期シグナル ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader title="短期シグナル" />
        <div style={metricsGridStyle}>
          <MetricCard
            title="確信度"
            value={`${trustPlan.shortTermMode.confidence}%`}
            change={{
              value: trustPlan.shortTermMode.confidence >= 70 ? '高確信' : trustPlan.shortTermMode.confidence >= 50 ? '中確信' : '低確信',
              positive: trustPlan.shortTermMode.confidence >= 70,
            }}
            assetType="fund"
          />
          <MetricCard
            title="条件達成"
            value={`${trustPlan.shortTermMode.conditionsPassed}/${trustPlan.shortTermMode.checklist.length}`}
            subtext="エントリー条件"
          />
          <MetricCard
            title="30日勝率"
            value={`${trustPlan.performance30d.winRate.toFixed(1)}%`}
            change={{ value: `${trustPlan.performance30d.executions}回実行`, positive: trustPlan.performance30d.winRate >= 55 }}
          />
          <MetricCard
            title="待機後続勝率"
            value={`${trustPlan.performance30d.postWaitWinRate.toFixed(1)}%`}
            subtext={`待機 ${trustPlan.performance30d.waitDays}日`}
          />
          <MetricCard
            title="外国人フロー"
            value={`${trustPlan.marketContext.foreignFlow >= 0 ? '+' : ''}${trustPlan.marketContext.foreignFlow.toFixed(0)}億円`}
            change={{ value: trustPlan.marketContext.foreignFlow >= 0 ? '流入' : '流出', positive: trustPlan.marketContext.foreignFlow >= 0 }}
          />
          <MetricCard
            title="日経先物"
            value={`${trustPlan.marketContext.nikkeiFuturesDirection >= 0 ? '+' : ''}${trustPlan.marketContext.nikkeiFuturesDirection.toFixed(2)}%`}
            change={{ value: trustPlan.marketContext.nikkeiFuturesDirection >= 0 ? '上昇' : '下落', positive: trustPlan.marketContext.nikkeiFuturesDirection >= 0 }}
          />
        </div>
      </section>

      {/* ━━━ 3. 地合い・指数環境評価 (InsightCard) ━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader title="地合い・指数環境 — AI分析" />
        <InsightCard
          conclusion={trustPlan.shortTermSummary}
          reasons={passedConditions.length > 0 ? passedConditions : ['条件達成項目なし']}
          risks={allRisks.length > 0 ? allRisks : ['現時点でリスク項目なし']}
          action={actionText}
          confidence={
            trustPlan.shortTermMode.confidence >= 70 ? 'HIGH' :
            trustPlan.shortTermMode.confidence >= 50 ? 'MEDIUM' : 'LOW'
          }
          horizon="超短期（1〜2営業日）"
        />
      </section>

      {/* ━━━ 4. Nikkei 225 VI × SQ 補助判断 ━━━━━━━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader title="Nikkei 225 VI × SQ 補助シグナル" />
        <div style={twoColStyle}>
          {/* VI/VIX指標 */}
          <div style={metricsGridStyle}>
            <MetricCard
              title="VIX"
              value={trustPlan.marketContext.vix.toFixed(1)}
              change={{
                value: trustPlan.marketContext.vix > 25 ? '高VIX' : '安定',
                positive: trustPlan.marketContext.vix <= 20,
              }}
            />
            <MetricCard
              title="日経VI"
              value={trustPlan.marketContext.nikkeiVI.toFixed(1)}
              change={{
                value: trustPlan.marketContext.nikkeiVI > 25 ? '高VI' : '安定',
                positive: trustPlan.marketContext.nikkeiVI <= 20,
              }}
            />
            <MetricCard
              title="VolSpread"
              value={trustPlan.marketContext.volatilitySpread.toFixed(2)}
              change={{
                value: `変化 ${trustPlan.marketContext.volatilitySpreadChg >= 0 ? '+' : ''}${trustPlan.marketContext.volatilitySpreadChg.toFixed(2)}`,
                positive: trustPlan.marketContext.volatilitySpreadChg <= 0,
              }}
            />
            <MetricCard
              title="SQ残日数"
              value={`${trustPlan.marketContext.sqDays}営業日`}
              subtext="次回SQまで"
            />
          </div>

          {/* 条件チェックリスト */}
          <div style={cardStyle}>
            <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
              <p style={{ ...typography.sectionTitle, color: colors.textSubtle }}>エントリー条件チェック</p>
            </div>
            {trustPlan.shortTermMode.checklist.map((item, i) => (
              <div key={item.id} style={{
                ...condRowStyle(item.status),
                borderBottom: i < trustPlan.shortTermMode.checklist.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], marginBottom: spacing[0.5] }}>
                    <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 600 }}>
                      {item.label}
                    </span>
                    <span style={{
                      ...typography.badge,
                      color:      item.status === 'pass' ? colors.buyText  : item.status === 'warn' ? colors.watchText : colors.sellText,
                      background: item.status === 'pass' ? colors.buyBg    : item.status === 'warn' ? colors.watchBg  : colors.sellBg,
                      border:     `1px solid ${item.status === 'pass' ? colors.buy : item.status === 'warn' ? colors.watch : colors.sell}`,
                      borderRadius: radius.full,
                      padding:    `${spacing[0.5]} ${spacing[1.5]}`,
                    }}>
                      {conditionLabel(item.status)}
                    </span>
                  </div>
                  <span style={{ ...typography.caption, color: colors.textMuted }}>{item.detail}</span>
                </div>
                <div style={condMeterStyle}>
                  <div style={condMeterFillStyle(item.status)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ 5. アクション ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {/* P4-A115: 当日実行判断画面として「何を実行するか」→「いくら配分するか」の順に変更 */}
      <section>
        {/* P4-A111: 当日実行窓口として明確化 — executionQueue生成変更なし */}
        <SectionHeader title="投信アクションキュー（当日実行）" caption={isSuppressed ? 'SAFE_MODE / DQ抑制中' : `${trustPlan.executionQueue.length}件`} />
        {!isSuppressed && (
          <p style={{ fontSize: '11px', color: colors.textMuted, marginBottom: spacing[2] }}>
            「国内投信」タブの参考候補を踏まえ、当日実行可否はこのキューで確認します。
          </p>
        )}
        {actionItems.length > 0
          ? <ActionPanel actions={actionItems} title="" />
          : <EmptyState message="現在執行キューは空です" />
        }
      </section>

      {/* ━━━ 6. 資金配分提案 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section>
        <SectionHeader title="資金配分提案" />

        <T7TrustAllocationPanel
          consumerSnapshot={allocationConsumerSnapshot}
          projection={allocationProjection}
          isMobile={isMobile}
        />
        <p style={{ ...typography.caption, color: colors.textMuted, margin: `${spacing[2]} 0 ${spacing[4]}`, lineHeight: 1.6 }}>
          表示金額は共有配分プランの読み取り専用投影です。実行可否は構造化されたプラン状態に従います。
        </p>

        {/* ポリシー別配分 */}
        <div style={cardStyle}>
          <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <p style={{ ...typography.sectionTitle, color: colors.textSubtle }}>運用方針別配分</p>
          </div>
          {trustPlan.policyRows.map((row, i) => {
            // P4-A156: SAFE_MODE/DQ抑制中はBUYバッジのみWATCHへ変換（表示専用。row.recommendationは変更しない）
            const isRowBuySuppressed = isSuppressed && row.recommendation === 'BUY'
            const rowSignal: Signal = suppressBuySignal(
              row.recommendation === 'BUY' ? 'BUY' : row.recommendation === 'TRIM' ? 'SELL' : 'HOLD',
              isSuppressed,
            )
            return (
              <div key={row.policy} style={{
                display:      'flex',
                alignItems:   'flex-start',
                gap:          spacing[3],
                padding:      `${spacing[3]} ${spacing[4]}`,
                borderBottom: i < trustPlan.policyRows.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], marginBottom: spacing[1] }}>
                    <strong style={{ ...typography.bodySmall, color: colors.textPrimary }}>{row.label}</strong>
                    <SignalBadge signal={rowSignal} size="sm" />
                  </div>
                  <div style={{ display: 'flex', gap: spacing[4], flexWrap: 'wrap' }}>
                    <span style={{ ...typography.metricSmall, color: colors.textSubtle }}>
                      現在 {(row.currentRatio * 100).toFixed(1)}%
                    </span>
                    <span style={{ ...typography.metricSmall, color: colors.textSubtle }}>
                      目標 {(row.targetRatio * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[0.5] }}>{row.reason}</p>
                  {isRowBuySuppressed && (
                    <p style={{ ...typography.caption, color: colors.waitText, fontWeight: 600, marginTop: spacing[0.5] }}>
                      SAFE_MODE/DQ抑制中 — 配分調整は参考停止。解除後に再判定されます。
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ━━━ 未保有投信候補（BUY_NEW / WATCH） — CAND-SYN authority ━━━━━ */}
      {(() => {
        const candidateEntries = computeTrustSynthesisCandidatesForDisplay(candidateDecisionSynthesis)
        // UI-9: synthesis自体がnull/unavailable/invalidの場合は従来通りセクション非表示
        // （CAND-SYN-1E frozen authority: E1-E3）。availableかつ0件のみ「該当なし」を明示する。
        const isSynthesisAvailable = candidateDecisionSynthesis !== null && candidateDecisionSynthesis.status === 'available'
        if (candidateEntries.length === 0 && !isSynthesisAvailable) return null
        if (candidateEntries.length === 0) {
          return (
            <section>
              <SectionHeader title="未保有投信候補" />
              <p style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[3] }}>
                未保有の投資アイデア — 採用前に枠・方針・集中度の確認が必要
              </p>
              <EmptyState message="本日は該当する未保有投信候補はありません" />
            </section>
          )
        }
        return (
          <section>
            <SectionHeader title="未保有投信候補" caption={`${candidateEntries.length}件`} />
            <p style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[3] }}>
              未保有の投資アイデア — 採用前に枠・方針・集中度の確認が必要
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
              {candidateEntries.map(entry => {
                const isNew = entry.action === 'BUY_NEW'
                return (
                  <div
                    key={entry.entryId}
                    style={{
                      padding:      `${spacing[3]} ${spacing[4]}`,
                      background:   colors.bgSurface,
                      border:       `1px solid ${colors.borderSubtle}`,
                      borderLeft:   `3px solid ${isNew ? colors.fundAccent : colors.borderSubtle}`,
                      borderRadius: radius.lg,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], marginBottom: spacing[1.5], flexWrap: 'wrap' }}>
                      <span style={{ ...typography.badge, color: colors.fundAccentText, background: colors.fundAccentBg, padding: `${spacing[0.5]} ${spacing[1.5]}`, borderRadius: radius.sm, flexShrink: 0 }}>
                        {SYNTHESIS_ACTION_LABEL[entry.action]}
                      </span>
                      <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>{entry.displayName}</span>
                    </div>
                    <p style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[1.5], lineHeight: '1.5' }}>
                      {trustSynthesisCandidateReasonText(entry)}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })()}

      {/* P4-A106: SAFE_MODE / DQ抑制時: 超短期実行候補 抑制中通知 */}
      {isSuppressed && (
        <section>
          <SectionHeader title="日本株投信 — 超短期実行候補" />
          <div style={{
            padding:      `${spacing[3]} ${spacing[4]}`,
            background:   colors.waitBg,
            border:       `1px solid ${colors.waitBorder}`,
            borderRadius: radius.md,
            fontSize:     '13px',
            color:        colors.waitText,
            display:      'flex',
            alignItems:   'center',
            gap:          spacing[2],
          }}>
            <span>⚠</span>
            <span>SAFE_MODE / DQ抑制中 — 新規買い判断停止中。最新データ確認後に再判定。</span>
          </div>
        </section>
      )}

      {/* 短期実行候補 (日本株投信) — SAFE_MODE / DQ抑制時は非表示 */}
      {trustPlan.shortTermRows.length > 0 && !isSuppressed && (
        <section>
          {/* P4-A111: 実行候補として明確化 — shortTermRows生成変更なし */}
          <SectionHeader title="日本株投信 — 当日実行候補" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
            {trustPlan.shortTermRows.map(row => {
              const sig = actionToSignal(row.action)
              return (
                <div key={row.id} style={{
                  padding:      `${spacing[4]} ${spacing[4]}`,
                  background:   colors.bgSurface,
                  border:       `1px solid ${colors.borderSubtle}`,
                  borderLeft:   `3px solid ${colors.fundAccent}`,
                  borderRadius: radius.lg,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing[2] }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
                      <span style={{ ...typography.label, color: colors.fundAccentText, background: colors.fundAccentBg, padding: `${spacing[0.5]} ${spacing[1.5]}`, borderRadius: radius.sm }}>
                        {row.abbr}
                      </span>
                      <SignalBadge signal={sig} size="sm" />
                    </div>
                  </div>
                  <p style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[1.5] }}>
                    {row.role} / スコア {row.score}%
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${spacing[1]} ${spacing[3]}` }}>
                    {row.rationale.map(item => (
                      <span key={item} style={{ ...typography.caption, color: colors.textSubtle }}>{item}</span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${spacing[1]} ${spacing[4]}`, marginTop: spacing[2], borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: spacing[2] }}>
                    <span style={{ ...typography.caption, color: colors.textMuted }}>エントリー: {row.entryRule}</span>
                    <span style={{ ...typography.caption, color: colors.textMuted }}>利確: {row.takeProfitRule}</span>
                    <span style={{ ...typography.caption, color: colors.textMuted }}>損切: {row.stopLossRule}</span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* エントリー済みボタン */}
          <div style={{ marginTop: spacing[3], display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={handleMarkExecuted}
              disabled={todayEntryCount >= 1 || trustPlan.shortTermMode.candidateDirection === 'WAIT'}
              style={{
                ...typography.label,
                padding:       `${spacing[2]} ${spacing[4]}`,
                // 白文字とのAA 4.5:1を満たすためraw fundAccentでなくfundAccentTextを使用
                background:    colors.fundAccentText,
                color:         '#fff',
                border:        'none',
                borderRadius:  radius.md,
                cursor:        'pointer',
                opacity:       todayEntryCount >= 1 || trustPlan.shortTermMode.candidateDirection === 'WAIT' ? 0.45 : 1,
              }}
            >
              本日エントリー済みにする
            </button>
          </div>

          {/* 執行ルール */}
          <div style={{
            marginTop:  spacing[3],
            padding:    `${spacing[3]} ${spacing[4]}`,
            background: colors.bgSurface,
            border:     `1px solid ${colors.borderSubtle}`,
            borderRadius: radius.md,
          }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${spacing[1]} ${spacing[5]}` }}>
              {[
                `利確: ${trustPlan.shortTermMode.takeProfitRule}`,
                `部分利確: ${trustPlan.shortTermMode.partialTakeProfitRule}`,
                `損切: ${trustPlan.shortTermMode.stopLossRule}`,
                `最大保有: ${trustPlan.shortTermMode.maxHoldingRule}`,
                `前提崩れ: ${trustPlan.shortTermMode.invalidationRule}`,
              ].map(rule => (
                <span key={rule} style={{ ...typography.caption, color: colors.textMuted }}>{rule}</span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 最新ニュース */}
      {trustPlan.newsContext.latestHeadline && (
        <section>
          <SectionHeader title="ニュース影響" />
          <div style={{
            padding:      `${spacing[3]} ${spacing[4]}`,
            background:   colors.bgSurface,
            border:       `1px solid ${colors.borderSubtle}`,
            borderRadius: radius.lg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] }}>
              <p style={{ ...typography.bodySmall, color: colors.textPrimary }}>
                {trustPlan.newsContext.latestHeadline}
              </p>
              <span style={{ ...typography.caption, color: colors.textMuted, flexShrink: 0 }}>
                {trustPlan.newsContext.latestPublishedAt
                  ? formatDateTime(trustPlan.newsContext.latestPublishedAt)
                  : '時刻なし'}
              </span>
            </div>
            <p style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              センチメント: {trustPlan.newsContext.sentimentBias >= 2 ? '追い風' : trustPlan.newsContext.sentimentBias <= -2 ? '逆風' : '中立'} / 関連ニュース {trustPlan.newsContext.trustHeadlineCount}件
            </p>
          </div>
        </section>
      )}

      {/* パフォーマンストラッキング */}
      <section>
        <SectionHeader
          title="パフォーマンストラッキング"
          caption={`${trustPlan.performance30d.trackedDays}日間`}
        />
        <div style={metricsGridStyle}>
          <MetricCard title="30日勝率"   value={`${trustPlan.performance30d.winRate.toFixed(1)}%`}       change={{ value: trustPlan.performance30d.winRate >= 55 ? '良好' : '要改善', positive: trustPlan.performance30d.winRate >= 55 }} />
          <MetricCard title="待機後続勝率" value={`${trustPlan.performance30d.postWaitWinRate.toFixed(1)}%`} subtext="待機翌日の勝率" />
          <MetricCard title="実行回数"   value={`${trustPlan.performance30d.executions}回`}               subtext="30日間" />
          <MetricCard title="待機日数"   value={`${trustPlan.performance30d.waitDays}日`}                  subtext="30日間" />
        </div>
        <div style={{ ...cardStyle, marginTop: spacing[3] }}>
          <div style={cardBodyStyle}>
            <p style={{ ...typography.caption, color: colors.textMuted }}>
              VIXフィルター提案: Bull ≤ {shortTuning.recommendedBullVixMax.toFixed(1)} / Bear ≥ {shortTuning.recommendedBearVixMin.toFixed(1)} / サンプル Bull {shortTuning.bullSample}件 / Bear {shortTuning.bearSample}件
            </p>
          </div>
        </div>

        {/* 累積リターン推移チャート — 時系列データは未蓄積のためEmptyState表示 */}
        <div style={{ marginTop: spacing[3], padding: `${spacing[3]} ${spacing[4]}`, background: colors.bgSurface, border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.lg }}>
          <p style={{ ...typography.label, color: colors.textSubtle, marginBottom: spacing[2] }}>
            累積リターン推移
          </p>
          <SparklineChart
            values={[]}
            width={isMobile ? 280 : 400}
            height={56}
            tone="buy"
            label="累積リターン（履歴）"
            showZeroLine
          />
          <p style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
            実行記録が蓄積されると時系列で表示されます
          </p>
        </div>
      </section>


      {/* ━━━ Phase 7 観察スコア (calculation-only) ━━━━━━━━━━━━━━━━ */}
      {fundPhase7 && (
        <Phase7FundSection
          funds={trust}
          phase7Map={fundPhase7}
        />
      )}

    </div>
  )
}
