/**
 * T2_JpFund — 国内株投信（超短期回転）V10 Phase 7
 * 資産クラス: jp_fund / JAPAN_SHORTTERM のみ
 * 役割: 短期回転用 — 今日の判断・候補別表示・地合い診断・VI/SQ警戒
 * 表示順: 今日のスタンス → 地合い診断 → 候補リスト → 詳細ファンド
 */
import { useMemo, useState, useEffect } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useAppStore } from '../../store/useAppStore'
import { selectJpFunds, selectMarketDataQuality, selectEffectiveSafeModeActive } from '../../store/selectors'
import {
  selectAllocationConsumerSnapshot,
  selectT2AllocationProjection,
  type T2AllocationProjection,
} from '../../store/allocationConsumerSelectors'
import { formatJPYAuto, formatRelativeTime, formatSignedPct, formatPt } from '../../utils/format'
import {
  buildTrustPortfolioPlan,
  type ConditionStatus,
} from '../../domain/optimization/trustPortfolio'
import { checkNoTrade } from '../../domain/optimization/idealAllocation'
import { buildTrustPlanGateInputs } from '../../domain/optimization/trustPlanInputs'
import {
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
} from '../../domain/learning/trustShortTracker'

import { DecisionCard }  from '../cards/DecisionCard'
import { MetricCard }    from '../cards/MetricCard'
import { SectionHeader } from '../layout/SectionHeader'
import { PageHeader }    from '../layout/PageHeader'
import { CircularGauge } from '../charts/CircularGauge'
import { SignalBadge }   from '../badges/SignalBadge'
import { EmptyState }    from '../shared/EmptyState'
import { suppressBuySignal, SUPPRESSED_VERDICT } from '../shared/verdict'
import type { Signal }   from '../badges/SignalBadge'
import type { RiskLevel } from '../badges/RiskBadge'

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'
import type { Trust, AppState } from '../../types'
import type { AllocationConsumerSnapshot } from '../../types/allocationConsumer'

// ── ヘルパー ────────────────────────────────────────────────────

export function signalFromShortTerm(s: 'BULL' | 'BEAR' | 'WAIT'): Signal {
  if (s === 'BULL') return 'BUY'
  if (s === 'BEAR') return 'SELL'
  // UI-9H H-P0-2 R1: 条件未達WAITは真の監視（WATCH）と別トークン
  return 'WAIT'
}

function riskFromShortTerm(s: 'BULL' | 'BEAR' | 'WAIT'): RiskLevel {
  if (s === 'BEAR') return 'HIGH'
  if (s === 'WAIT') return 'MEDIUM'
  return 'LOW'
}

export function decisionToSignal(d: Trust['decision']): Signal {
  if (d === 'BUY')  return 'BUY'
  if (d === 'SELL') return 'SELL'
  // UI-9H H-P0-2 R1: 条件未達WAITは真の監視（WATCH）と別トークン
  if (d === 'WAIT') return 'WAIT'
  return 'HOLD'
}

function conditionStatusColor(status: ConditionStatus) {
  if (status === 'pass') return colors.buy
  if (status === 'warn') return colors.wait
  return colors.sell
}

function conditionStatusLabel(status: ConditionStatus) {
  if (status === 'pass') return '達成'
  if (status === 'warn') return '境界'
  return '未達'
}

function pnlColor(pct: number) {
  if (pct > 0)  return colors.buy
  if (pct < -5) return colors.sell
  return colors.wait
}

// VI レベル評価
function viLabel(vi: number): { label: string; color: string; bg: string } {
  if (vi >= 30) return { label: '極度警戒', color: colors.sellText, bg: colors.sellBg }
  if (vi >= 22) return { label: '高ボラ',   color: colors.waitText, bg: colors.waitBg }
  if (vi >= 16) return { label: '注意圏',   color: colors.waitText, bg: colors.waitBg }
  return             { label: '安定',       color: colors.buyText,  bg: colors.buyBg  }
}

// SQ 警戒評価
function sqLabel(days: number): { label: string; color: string } {
  if (days <= 3)  return { label: `SQ ${days}営業日前 — 極度警戒`, color: colors.sellText }
  if (days <= 7)  return { label: `SQ ${days}営業日前 — 警戒`,     color: colors.waitText }
  if (days <= 14) return { label: `SQ ${days}営業日前 — 注意`,     color: colors.waitText }
  return               { label: `SQ ${days}営業日後`,              color: colors.textSubtle }
}

// フロー方向
function flowLabel(flow: number): string {
  const sign   = flow > 0 ? '+' : flow < 0 ? '-' : ''
  const amount = `${sign}${Math.abs(flow).toFixed(0)}億円`
  if (flow > 500)  return `外国人買い越し ${amount}`
  if (flow > 0)    return `外国人小幅買い ${amount}`
  if (flow > -500) return `外国人小幅売り ${amount}`
  return                 `外国人売り越し ${amount}`
}

export interface T2AllocationPanelProps {
  readonly consumerSnapshot: AllocationConsumerSnapshot
  readonly projection: T2AllocationProjection | null
  readonly isMobile: boolean
}

export function T2AllocationPanel({
  consumerSnapshot,
  projection,
  isMobile,
}: T2AllocationPanelProps) {
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

  const { snapshot, jpTrustClass } = projection
  const statusLabel = snapshot.status === 'current'
    ? '最新'
    : snapshot.status === 'estimate_only'
      ? '見積のみ（実行不可）'
      : '実行不可'

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
          実行可能性: {snapshot.snapshotExecutability} / 更新 {formatRelativeTime(snapshot.generation.generatedAt)}
        </div>
      </div>
      {(snapshot.blockedReasons.length > 0 || snapshot.warnings.length > 0 ||
        jpTrustClass.blockedReasons.length > 0 || jpTrustClass.warningReasons.length > 0 ||
        jpTrustClass.limitingFactors.length > 0) && (
        <div style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[3] }}>
          snapshot: ブロック {snapshot.blockedReasons.length}件 / 警告 {snapshot.warnings.length}件 ・
          JP_TRUST: ブロック {jpTrustClass.blockedReasons.length}件 / 警告 {jpTrustClass.warningReasons.length}件 /
          制約 {jpTrustClass.limitingFactors.length}件
        </div>
      )}
      {/* UI-9: 現在額/目標額の視覚的比較（表示専用。金額テキストは重複表示せず、下のクラス評価額/目標額カードのみに委ねる） */}
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
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: spacing[3],
      }}>
        <MetricCard title="クラス評価額" value={formatJPYAuto(jpTrustClass.currentAmount)} />
        <MetricCard title="目標額" value={formatJPYAuto(jpTrustClass.targetAmount)} />
        <MetricCard title="目標差分（不足）" value={formatJPYAuto(jpTrustClass.targetGap)} />
        <MetricCard title="目標超過" value={formatJPYAuto(jpTrustClass.overweightAmount)} />
        <MetricCard title="配分済額" value={formatJPYAuto(jpTrustClass.allocatedAmount)} />
        <MetricCard title="割当後の残余" value={formatJPYAuto(jpTrustClass.remainingHeadroom)} />
        <MetricCard title="クラスheadroom" value={formatJPYAuto(jpTrustClass.effectiveHeadroom)} />
        <MetricCard title="利用可能予算" value={formatJPYAuto(jpTrustClass.availableBudget)} />
        <MetricCard title="配分候補" value={`${jpTrustClass.instrumentPlanCount}件`} />
      </div>
    </div>
  )
}

// ── コンポーネント ──────────────────────────────────────────────

export function T2_JpFund() {
  const isMobile       = useIsMobile()
  const jpFunds        = useAppStore(selectJpFunds)
  const allocationConsumerSnapshot = useAppStore(selectAllocationConsumerSnapshot)
  const allocationProjection = useAppStore(selectT2AllocationProjection)
  const market         = useAppStore(s => s.market)
  const macro          = useAppStore(s => s.macro)
  const news           = useAppStore(s => s.news)
  const sqCalendar     = useAppStore(s => s.sqCalendar)
  const margin         = useAppStore(s => s.margin)
  const flows          = useAppStore(s => s.flows)
  const universe       = useAppStore(s => s.universe)
  const system         = useAppStore(s => s.system)  // Phase 8: 更新時刻
  const dq              = useAppStore(selectMarketDataQuality)
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive  = useAppStore(selectEffectiveSafeModeActive)
  const isSuppressed    = safeModeActive || dq.isSuppressed

  const [trackingStats, setTrackingStats] = useState(() => getTrustShortTrackingStats())
  const [todayEntryCount]                 = useState(() => getTrustShortTodayExecutionCount())

  // P4-A145: VIX/日経VI/SQ由来のnoTrade判定（useAppStore.runFullAnalysisと同一入力）
  const noTradeResult = useMemo(
    () => checkNoTrade({ market, macro, sqCalendar } as AppState),
    [market, macro, sqCalendar],
  )

  // P4-A145: JP_TRUST headroom / noTrade(VIX-VI-SQ or SAFE_MODE or DQ)をT2のtrustPlan生成に配線する
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

  const trustPlan = useMemo(
    () =>
      buildTrustPortfolioPlan({
        trust: jpFunds,
        market,
        macro,
        news,
        sqCalendar,
        margin,
        flows,
        todayEntryCount,
        performance30d: trackingStats,
        noTrade: gateInputs.noTrade,
        jpTrustHeadroom: gateInputs.jpTrustHeadroom,
      }),
    [flows, jpFunds, macro, margin, market, news, sqCalendar, todayEntryCount, trackingStats, gateInputs],
  )

  useEffect(() => {
    setTrackingStats(getTrustShortTrackingStats())
  }, [])

  const signal      = trustPlan.shortTermSignal
  const mode        = trustPlan.shortTermMode
  const checklist   = mode.checklist
  const ctx         = trustPlan.marketContext
  const shortRows   = trustPlan.shortTermRows

  // 候補分類
  const buyCandidates  = shortRows.filter(r => r.action === 'BUY' || r.action === 'BULL')
  const trimCandidates = shortRows.filter(r => r.action === 'TRIM')
  const waitCandidates = shortRows.filter(r => r.action === 'WAIT' || r.action === 'HOLD')
  const leveragedFunds = shortRows.filter(r => r.leveraged)
  const highRiskFunds  = shortRows.filter(r => r.leveraged && r.score < 50)

  const avgScore = jpFunds.length > 0
    ? Math.round(jpFunds.reduce((s, f) => s + f.score, 0) / jpFunds.length)
    : 0

  const signalLabel =
    signal === 'BULL' ? 'ブル（買いシグナル）' :
    signal === 'BEAR' ? 'ベア（売りシグナル）' : '待機推奨'

  // P4-A104: 表示専用変数 — signal算出ロジックは変更しない
  // UI-9H H-P0-2: 抑制中は「真のWATCH（監視）」ではなく専用トークンで表示する
  const displayDecision = isSuppressed ? SUPPRESSED_VERDICT : signalFromShortTerm(signal)
  const displayTitle    = isSuppressed ? '今日のスタンス: 抑制中（参考）' : `今日のスタンス: ${signalLabel}`

  const decisionReasons = [
    mode.summary,
    ...mode.waitReasons.slice(0, 2),
  ].filter(Boolean)

  // VI・SQ
  const vi    = viLabel(ctx.nikkeiVI)
  const sq    = sqLabel(ctx.sqDays)

  // ── スタイル ───────────────────────────────────────────────

  const panelStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[5],
    padding:       isMobile ? `${spacing[4]} ${spacing[3]}` : `${spacing[5]} ${spacing[5]}`,
    maxWidth:      '900px',
    margin:        '0 auto',
  }

  const cardStyle: CSSProperties = {
    background:   colors.bgSurface,
    border:       `1px solid ${colors.borderSubtle}`,
    borderRadius: radius.lg,
    boxShadow:    shadow.sm,
    overflow:     'hidden',
  }

  const metricsGridStyle: CSSProperties = {
    display:             'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap:                 spacing[3],
  }

  const checklistRowStyle: CSSProperties = {
    display:    'flex',
    alignItems: 'center',
    gap:        spacing[3],
    padding:    `${spacing[2.5]} ${spacing[4]}`,
  }

  const fundRowStyle: CSSProperties = {
    display:        'flex',
    alignItems:     'flex-start',
    justifyContent: 'space-between',
    padding:        `${spacing[4]} ${spacing[5]}`,
    gap:            spacing[3],
    flexWrap:       'wrap',
  }

  // ── レンダリング ─────────────────────────────────────────────

  if (jpFunds.length === 0) {
    return (
      <div style={panelStyle}>
        <PageHeader tabId="T2" />
        <EmptyState
          message="国内株投信なし"
          detail="JAPAN_SHORTTERM ポリシーの投信が登録されていません。"
        />
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <PageHeader tabId="T2" />

      {/* ── 資産クラスヘッダー（P1-5: page titleはPageHeaderへ集約したためpillは削除、更新時刻のみ残す） ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
        <div style={{ ...typography.caption, color: colors.textSubtle }}>
          超短期回転 — VI・SQ・先物シグナル連動
        </div>
        {/* Phase 8: 更新時刻表示 */}
        <div style={{ ...typography.caption, color: colors.textMuted, marginLeft: 'auto' }}>
          {system.lastUpdated
            ? `最終更新 ${formatRelativeTime(system.lastUpdated)}`
            : 'データ未取得'
          }
        </div>
      </div>

      {/* ── 今日の短期スタンス（メインカード） ── */}
      {/* P4-A121: スタンスと確信度ゲージを横並びで表示 */}
      <div style={{ display: 'flex', gap: spacing[4], alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <DecisionCard
            decision={displayDecision}
            title={displayTitle}
            score={mode.confidence}
            reasons={[
              ...(isSuppressed ? ['⚠ SAFE_MODE / DQ抑制中 — 新規買い判断停止中'] : []),
              ...decisionReasons,
            ]}
            riskLevel={riskFromShortTerm(signal)}
          />
        </div>
        <div style={{
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          padding:        `${spacing[4]} ${spacing[3]}`,
          background:     colors.bgSurface,
          border:         `1px solid ${colors.borderSubtle}`,
          borderRadius:   '8px',
          boxShadow:      '0 1px 4px rgba(0,0,0,0.06)',
          gap:            spacing[2],
          flexShrink:     0,
        }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: colors.textMuted }}>本日の投信スタンス</div>
          <CircularGauge
            value={mode.confidence}
            size={88}
            strokeWidth={9}
            tone={signal === 'BULL' ? 'buy' : signal === 'BEAR' ? 'sell' : 'hold'}
            sublabel="/100"
            unit=""
          />
          <div style={{ fontSize: '12px', fontWeight: 700, color: signal === 'BULL' ? colors.buy : signal === 'BEAR' ? colors.sell : colors.hold }}>
            {signal === 'BULL' ? 'やや強気' : signal === 'BEAR' ? 'ベア' : '待機'}
          </div>
        </div>
      </div>

      {/* ── 地合い診断 ── */}
      <div>
        <SectionHeader title="地合い診断" caption="短期売買の前提チェック" />
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: spacing[3],
        }}>
          {/* 日経VI */}
          <div style={{
            ...cardStyle,
            padding: `${spacing[3]} ${spacing[4]}`,
            borderLeft: `3px solid ${vi.color}`,
          }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>日経225 VI</div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: vi.color, marginTop: spacing[1] }}>
              {ctx.nikkeiVI.toFixed(1)}
            </div>
            <div style={{
              fontSize: '11px', fontWeight: 700, color: vi.color,
              background: vi.bg, padding: `1px ${spacing[2]}`, borderRadius: radius.sm,
              display: 'inline-block', marginTop: spacing[1],
            }}>
              {vi.label}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              ≥30: 売買停止推奨
            </div>
          </div>

          {/* SQ警戒 */}
          <div style={{
            ...cardStyle,
            padding: `${spacing[3]} ${spacing[4]}`,
            borderLeft: `3px solid ${sq.color}`,
          }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>SQ接近警戒</div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: sq.color, marginTop: spacing[1], lineHeight: '1.4' }}>
              {sq.label}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              SQ前1週間は大口手仕舞いに注意
            </div>
          </div>

          {/* 外国人フロー */}
          <div style={{
            ...cardStyle,
            padding: `${spacing[3]} ${spacing[4]}`,
            borderLeft: `3px solid ${ctx.foreignFlow >= 0 ? colors.buy : colors.sell}`,
          }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>外国人フロー</div>
            <div style={{
              fontSize: '14px', fontWeight: 700,
              color: ctx.foreignFlow >= 0 ? colors.buy : colors.sell,
              marginTop: spacing[1], lineHeight: '1.4',
            }}>
              {flowLabel(ctx.foreignFlow)}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              VIX {ctx.vix.toFixed(1)}
            </div>
          </div>

          {/* 信用倍率 */}
          <div style={{
            ...cardStyle,
            padding: `${spacing[3]} ${spacing[4]}`,
            borderLeft: `3px solid ${ctx.marginRatio > 4 ? colors.sell : ctx.marginRatio > 2.5 ? colors.wait : colors.buy}`,
          }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>信用倍率</div>
            <div style={{
              fontSize: '20px', fontWeight: 800,
              color: ctx.marginRatio > 4 ? colors.sell : ctx.marginRatio > 2.5 ? colors.wait : colors.buy,
              marginTop: spacing[1],
            }}>
              {ctx.marginRatio.toFixed(1)}倍
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              {ctx.marginRatio > 4 ? '過熱 — 踏み上げリスク' : ctx.marginRatio > 2.5 ? '注意水準' : '良好'}
            </div>
          </div>
        </div>
      </div>

      {/* ── canonical AllocationPlanSnapshot class projection ── */}
      <T2AllocationPanel
        consumerSnapshot={allocationConsumerSnapshot}
        projection={allocationProjection}
        isMobile={isMobile}
      />

      {/* ── signal / tracking KPI グリッド ── */}
      <div style={metricsGridStyle}>
        <MetricCard
          title="平均スコア"
          value={`${avgScore}`}
          change={{
            value:    avgScore >= 60 ? '良好' : avgScore >= 40 ? '標準' : '低調',
            positive: avgScore >= 60,
          }}
        />
        <MetricCard
          title="今日の執行数"
          value={`${todayEntryCount} / ${mode.entryLimitPerDay}`}
        />
        <MetricCard
          title="勝率(30d)"
          value={
            trackingStats.trackedDays > 0
              ? `${(trackingStats.winRate * 100).toFixed(1)}%`
              : '—'
          }
          change={
            trackingStats.trackedDays > 0
              ? { value: `${trackingStats.executions}回執行`, positive: trackingStats.winRate >= 0.5 }
              : undefined
          }
        />
      </div>

      {/* ── 候補別判断 ── */}
      {shortRows.length > 0 && (
        <div>
          {/* P4-A110: 通常時も参考候補として明確化 — 生成ロジック変更なし */}
          <SectionHeader
            title="候補別判断（参考）"
            caption={`参考 ${buyCandidates.length} / 利確 ${trimCandidates.length} / 待機 ${waitCandidates.length}`}
          />
          <div style={{ fontSize: '11px', color: colors.textMuted, padding: `0 ${spacing[1]} ${spacing[2]}` }}>
            この候補は理想PF差分の参考表示です。当日実行判断は「投信」タブのアクションキューを確認してください。
          </div>

          {/* 参考候補（買い） */}
          {buyCandidates.length > 0 && (
            <div style={{ marginBottom: spacing[3] }}>
              <div style={{
                fontSize: '12px', fontWeight: 700, color: colors.buyText,
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.buyBg,
                borderRadius: `${radius.md} ${radius.md} 0 0`,
                border: `1px solid ${colors.buyBorder}`,
                borderBottom: 'none',
              }}>
                {/* P4-A110: 通常時も「参考候補」に統一（生成ロジック変更なし） */}
                {isSuppressed ? '候補（参考）' : '参考候補'} — {buyCandidates.length}件
              </div>
              <div style={{ ...cardStyle, borderTop: 'none', borderRadius: `0 0 ${radius.lg} ${radius.lg}`, border: `1px solid ${colors.buyBorder}` }}>
                {buyCandidates.map((row, i) => (
                  <div key={row.id} style={{
                    padding: `${spacing[3]} ${spacing[4]}`,
                    borderBottom: i < buyCandidates.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] }}>
                      <div>
                        <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{row.abbr}</span>
                        <span style={{ fontSize: '11px', color: colors.textMuted, marginLeft: spacing[2] }}>
                          {row.role} {row.leveraged ? '/ レバレッジ' : ''}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: spacing[3], alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', color: colors.textSubtle }}>
                          スコア {row.score} / {isSuppressed ? '（参考）' : row.action}
                        </span>
                      </div>
                    </div>
                    {row.rationale.length > 0 && (
                      <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: spacing[1] }}>
                        {row.rationale[0]}
                      </div>
                    )}
                    <div style={{ fontSize: '11px', color: colors.textSubtle, marginTop: spacing[0.5] }}>
                      利確: {row.takeProfitRule} / 損切: {row.stopLossRule}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 利確候補 */}
          {trimCandidates.length > 0 && (
            <div style={{ marginBottom: spacing[3] }}>
              <div style={{
                fontSize: '12px', fontWeight: 700, color: colors.waitText,
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.waitBg,
                borderRadius: `${radius.md} ${radius.md} 0 0`,
                border: `1px solid ${colors.waitBorder}`,
                borderBottom: 'none',
              }}>
                利確候補 — {trimCandidates.length}件
              </div>
              <div style={{ ...cardStyle, borderTop: 'none', borderRadius: `0 0 ${radius.lg} ${radius.lg}`, border: `1px solid ${colors.waitBorder}` }}>
                {trimCandidates.map((row, i) => (
                  <div key={row.id} style={{
                    padding: `${spacing[3]} ${spacing[4]}`,
                    borderBottom: i < trimCandidates.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{row.abbr}</span>
                      <span style={{ fontSize: '12px', color: colors.waitText, fontWeight: 600 }}>
                        {row.holdingStance}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: spacing[1] }}>
                      {row.takeProfitRule}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 待機候補 */}
          {waitCandidates.length > 0 && (
            <div style={{ marginBottom: spacing[3] }}>
              <div style={{
                fontSize: '12px', fontWeight: 700, color: colors.holdText,
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.holdBg,
                borderRadius: `${radius.md} ${radius.md} 0 0`,
                border: `1px solid ${colors.holdBorder}`,
                borderBottom: 'none',
              }}>
                待機候補 — {waitCandidates.length}件
              </div>
              <div style={{ ...cardStyle, borderTop: 'none', borderRadius: `0 0 ${radius.lg} ${radius.lg}`, border: `1px solid ${colors.holdBorder}` }}>
                {waitCandidates.map((row, i) => (
                  <div key={row.id} style={{
                    padding: `${spacing[3]} ${spacing[4]}`,
                    borderBottom: i < waitCandidates.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{row.abbr}</span>
                    <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: spacing[0.5] }}>
                      {row.holdingStance}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 追い買い禁止・高ボラ警戒 */}
          {highRiskFunds.length > 0 && (
            <div style={{
              background: colors.sellBg,
              border: `1px solid ${colors.sellBorder}`,
              borderRadius: radius.lg,
              padding: `${spacing[3]} ${spacing[4]}`,
            }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: colors.sellText, marginBottom: spacing[2] }}>
                追い買い禁止 / 高ボラ警戒 — {highRiskFunds.length}件
              </div>
              {highRiskFunds.map(row => (
                <div key={row.id} style={{ fontSize: '12px', color: colors.sellText, marginTop: spacing[1] }}>
                  • {row.abbr} — スコア {row.score} / レバレッジ商品のため追加買いは禁止
                </div>
              ))}
            </div>
          )}

          {/* 高ボラ保有 (高リスクではないレバ商品) */}
          {leveragedFunds.length > highRiskFunds.length && (
            <div style={{
              background: colors.waitBg,
              border: `1px solid ${colors.waitBorder}`,
              borderRadius: radius.lg,
              padding: `${spacing[3]} ${spacing[4]}`,
            }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: colors.waitText, marginBottom: spacing[2] }}>
                高ボラ警戒 — レバレッジ商品保有 {leveragedFunds.length}件
              </div>
              {leveragedFunds.filter(r => r.score >= 50).map(row => (
                <div key={row.id} style={{ fontSize: '12px', color: colors.waitText, marginTop: spacing[1] }}>
                  • {row.abbr} — スコア {row.score} / VI上昇時は即利確
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 短期ランキング（スコア降順） ── */}
      {shortRows.length > 0 && (
        <div>
          <SectionHeader title="短期ランキング" caption="スコア降順" />
          <div style={cardStyle}>
            {[...shortRows]
              .sort((a, b) => b.score - a.score)
              .map((row, i) => (
                <div key={row.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: `${spacing[2.5]} ${spacing[4]}`,
                  borderBottom: i < shortRows.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  gap: spacing[3],
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3] }}>
                    <span style={{
                      fontSize: '12px', fontWeight: 700, color: colors.textMuted,
                      minWidth: '20px', textAlign: 'right',
                    }}>
                      {i + 1}
                    </span>
                    <div>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{row.abbr}</span>
                      <span style={{ fontSize: '11px', color: colors.textMuted, marginLeft: spacing[2] }}>
                        {row.role}{row.leveraged ? ' レバ' : ''}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3] }}>
                    <span style={{ fontSize: '12px', color: colors.textSubtle }}>
                      {row.action}
                    </span>
                    <span style={{
                      fontSize: '13px', fontWeight: 700,
                      color: row.score >= 60 ? colors.buy : row.score >= 40 ? colors.wait : colors.sell,
                    }}>
                      {row.score}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── エントリー条件チェックリスト ── */}
      <div>
        <SectionHeader
          title="エントリー条件"
          caption={`${mode.conditionsPassed} / ${checklist.length} 達成`}
        />
        <div style={cardStyle}>
          {checklist.map((row, i) => (
            <div
              key={row.id}
              style={{
                ...checklistRowStyle,
                borderBottom: i < checklist.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
              }}
            >
              <div style={{
                width:        '10px',
                height:       '10px',
                borderRadius: '50%',
                flexShrink:   0,
                background:   conditionStatusColor(row.status),
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 600 }}>
                  {row.label}
                </div>
                <div style={{ ...typography.caption, color: colors.textSubtle, marginTop: spacing[0.5] }}>
                  {row.detail}
                </div>
              </div>
              <div style={{
                ...typography.caption,
                color:      conditionStatusColor(row.status),
                fontWeight: 700,
                flexShrink: 0,
              }}>
                {conditionStatusLabel(row.status)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── モメンタム / 需給要約 ── */}
      <div>
        <SectionHeader title="モメンタム / 需給要約" />
        <div style={{
          ...cardStyle,
          padding: `${spacing[4]} ${spacing[5]}`,
          display: 'flex', flexDirection: 'column', gap: spacing[3],
        }}>
          {[
            { label: '日経方向性',       value: ctx.nikkeiDirection > 0 ? '上昇傾向' : ctx.nikkeiDirection < 0 ? '下落傾向' : '横ばい',
              color: ctx.nikkeiDirection > 0 ? colors.buy : ctx.nikkeiDirection < 0 ? colors.sell : colors.textSubtle },
            { label: '先物方向性',       value: ctx.nikkeiFuturesDirection > 0 ? '先物買い優勢' : ctx.nikkeiFuturesDirection < 0 ? '先物売り優勢' : '中立',
              color: ctx.nikkeiFuturesDirection > 0 ? colors.buy : ctx.nikkeiFuturesDirection < 0 ? colors.sell : colors.textSubtle },
            { label: 'ボラ乖離(vs昨日)', value: ctx.volatilitySpreadChg > 0 ? `${formatPt(ctx.volatilitySpreadChg, 2)} 上昇`
                : ctx.volatilitySpreadChg < 0 ? `${formatPt(ctx.volatilitySpreadChg, 2)} 低下`
                : `${formatPt(ctx.volatilitySpreadChg, 2)} 変化なし`,
              color: ctx.volatilitySpreadChg > 0 ? colors.sell : ctx.volatilitySpreadChg < 0 ? colors.buy : colors.textSubtle },
            { label: '本日執行数',       value: `${ctx.todayEntryCount} 回 / 上限 ${mode.entryLimitPerDay} 回`,
              color: ctx.todayEntryCount >= mode.entryLimitPerDay ? colors.sell : colors.textPrimary },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ ...typography.caption, color: colors.textSubtle }}>{label}</span>
              <span style={{ ...typography.bodySmall, color, fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── 保有ファンド一覧 ── */}
      <div>
        <SectionHeader
          title="保有ファンド"
          caption={`${jpFunds.length}本`}
        />
        <div style={cardStyle}>
          {jpFunds.map((fund, i) => (
            <div
              key={fund.id}
              style={{
                ...fundRowStyle,
                borderBottom: i < jpFunds.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
              }}
            >
              {/* 左: 名前・アカウント */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
                  <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>
                    {fund.abbr}
                  </span>
                  <span style={{
                    ...typography.caption,
                    background:   colors.jpFundAccentBg,
                    color:        colors.jpFundAccentText,
                    border:       `1px solid ${colors.jpFundAccent}`,
                    borderRadius: radius.sm,
                    padding:      `0 ${spacing[1.5]}`,
                  }}>
                    超短期
                  </span>
                  {/* P4-A157: SAFE_MODE/DQ抑制中はBUYバッジのみWATCHへ変換（表示専用。fund.decisionは変更しない） */}
                  <SignalBadge signal={suppressBuySignal(decisionToSignal(fund.decision), isSuppressed)} size="sm" />
                </div>
                <div style={{ ...typography.caption, color: colors.textSubtle, marginTop: spacing[0.5] }}>
                  {fund.name}
                </div>
                <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[0.5] }}>
                  口座: {fund.account} / 信託報酬: {fund.cost.toFixed(3)}%
                </div>
              </div>

              {/* 右: 数値群 */}
              <div style={{
                display:        'flex',
                gap:            spacing[4],
                flexWrap:       'wrap',
                alignItems:     'flex-end',
                justifyContent: 'flex-end',
              }}>
                {[
                  { label: '評価額',   val: formatJPYAuto(fund.eval),                                         col: colors.textPrimary },
                  { label: '損益率',   val: formatSignedPct(fund.pnlPct),       col: pnlColor(fund.pnlPct) },
                  { label: '当日騰落', val: formatSignedPct(fund.dayPct),        col: pnlColor(fund.dayPct) },
                  { label: 'スコア',   val: `${fund.score}`,
                    col: fund.score >= 60 ? colors.buy : fund.score >= 40 ? colors.wait : colors.sell },
                ].map(({ label, val, col }) => (
                  <div key={label} style={{ textAlign: 'right' }}>
                    <div style={{ ...typography.caption, color: colors.textSubtle }}>{label}</div>
                    <div style={{ ...typography.bodySmall, color: col, fontWeight: 700 }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── ファンド比較マトリクス（ヒートマップ調） ── */}
      {jpFunds.length >= 2 && (() => {
        // 表示専用分類（ロジック変更なし）
        function scoreColor(s: number): { bg: string; text: string } {
          if (s >= 60) return { bg: colors.buyBg,  text: colors.buyText  }
          if (s >= 40) return { bg: colors.watchBg, text: colors.watchText }
          return             { bg: colors.sellBg, text: colors.sellText }
        }
        function pnlColorCell(pct: number): { bg: string; text: string } {
          if (pct >  3) return { bg: colors.buyBg,  text: colors.buyText  }
          if (pct < -3) return { bg: colors.sellBg, text: colors.sellText }
          return              { bg: 'transparent',  text: colors.textSubtle }
        }
        function costColorCell(cost: number): { bg: string; text: string } {
          if (cost <= 0.5) return { bg: colors.buyBg,  text: colors.buyText  }
          if (cost <= 1.0) return { bg: 'transparent',  text: colors.textSubtle }
          return                 { bg: colors.sellBg, text: colors.sellText }
        }

        const COLS = [
          { key: 'score',  label: 'スコア' },
          { key: 'pnlPct', label: '損益率' },
          { key: 'dayPct', label: '当日' },
          { key: 'cost',   label: '費用' },
        ]

        const cellBase: CSSProperties = {
          padding:       `${spacing[1.5]} ${spacing[2]}`,
          borderRadius:  radius.sm,
          textAlign:     'center' as const,
          fontSize:      '11px',
          fontWeight:    700,
          minWidth:      '52px',
        }

        return (
          <div>
            <SectionHeader title="ファンド比較マトリクス" caption="スコア/損益/費用（表示専用）" />
            <div style={{ ...cardStyle, overflowX: 'auto' }}>
              {/* ヘッダー行 */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: `120px repeat(${COLS.length}, 1fr)`,
                gap: spacing[1],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.bgElevated,
                borderBottom: `1px solid ${colors.borderSubtle}`,
              }}>
                <span style={{ ...typography.caption, color: colors.textMuted }}>ファンド</span>
                {COLS.map(c => (
                  <span key={c.key} style={{ ...typography.caption, color: colors.textMuted, textAlign: 'center' }}>{c.label}</span>
                ))}
              </div>
              {/* データ行 */}
              {jpFunds.map((fund, i) => {
                const sc  = scoreColor(fund.score)
                const pnl = pnlColorCell(fund.pnlPct)
                const day = pnlColorCell(fund.dayPct)
                const ct  = costColorCell(fund.cost)
                return (
                  <div key={fund.id} style={{
                    display: 'grid',
                    gridTemplateColumns: `120px repeat(${COLS.length}, 1fr)`,
                    gap: spacing[1],
                    padding: `${spacing[2]} ${spacing[3]}`,
                    borderBottom: i < jpFunds.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                    alignItems: 'center',
                  }}>
                    {/* ファンド名 */}
                    <div>
                      <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>{fund.abbr}</span>
                      <div style={{ ...typography.caption, color: colors.textMuted, marginTop: '1px' }}>{fund.decision}</div>
                    </div>
                    {/* スコア */}
                    <div style={{ ...cellBase, background: sc.bg, color: sc.text }}>{fund.score}</div>
                    {/* 損益率 */}
                    <div style={{ ...cellBase, background: pnl.bg, color: pnl.text }}>
                      {formatSignedPct(fund.pnlPct)}
                    </div>
                    {/* 当日 */}
                    <div style={{ ...cellBase, background: day.bg, color: day.text }}>
                      {formatSignedPct(fund.dayPct)}
                    </div>
                    {/* 費用 */}
                    <div style={{ ...cellBase, background: ct.bg, color: ct.text }}>
                      {fund.cost.toFixed(3)}%
                    </div>
                  </div>
                )
              })}
              {/* 凡例 */}
              <div style={{
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.bgElevated,
                borderTop: `1px solid ${colors.borderSubtle}`,
                display: 'flex', gap: spacing[3], flexWrap: 'wrap',
              }}>
                {[
                  { bg: colors.buyBg,  text: colors.buyText,  label: '良好' },
                  { bg: colors.sellBg, text: colors.sellText, label: '注意' },
                ].map(e => (
                  <span key={e.label} style={{ ...typography.caption, color: e.text, background: e.bg, padding: `1px ${spacing[1.5]}`, borderRadius: radius.sm }}>
                    {e.label}
                  </span>
                ))}
                <span style={{ ...typography.caption, color: colors.textMuted }}>
                  費用: ≤0.5%=良好 / &gt;1.0%=注意（表示専用）
                </span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── 実行ガイドライン ── */}
      {/* P4-A104: SAFE_MODE/DQ抑制中は実行ガイドライン（金額）を非表示 */}
      {mode.canEnter && !isSuppressed && (
        <div>
          <SectionHeader title="実行ガイドライン" />
          <div style={{ ...cardStyle, padding: `${spacing[4]} ${spacing[5]}` }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
              {[
                { label: '利確ルール',       value: mode.takeProfitRule },
                { label: '損切ルール',       value: mode.stopLossRule },
                { label: '最大保有期間',     value: mode.maxHoldingRule },
                { label: 'レバ商品注意',     value: mode.leveragedWarning },
              ].filter(r => r.value).map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', gap: spacing[3], alignItems: 'baseline' }}>
                  <span style={{ ...typography.caption, color: colors.textSubtle, minWidth: 120, flexShrink: 0 }}>
                    {label}
                  </span>
                  <span style={{ ...typography.bodySmall, color: colors.textPrimary }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* P4-A104: SAFE_MODE/DQ抑制中の注意バナー */}
      {isSuppressed && (
        <div style={{
          background:   colors.waitBg,
          border:       `1px solid ${colors.waitBorder}`,
          borderRadius: radius.lg,
          padding:      `${spacing[3]} ${spacing[4]}`,
        }}>
          <div style={{ ...typography.bodySmall, color: colors.waitText, fontWeight: 700, marginBottom: spacing[1] }}>
            ⚠ SAFE_MODE / DQ抑制中
          </div>
          <div style={{ ...typography.caption, color: colors.waitText }}>
            SAFE_MODE / DQ抑制中のため、国内投信候補と理想PF差分は参考表示です。新規買い判断は停止中です。
          </div>
        </div>
      )}

      {/* ── 非エントリー時: 待機理由 ── */}
      {!mode.canEnter && mode.waitReasons.length > 0 && (
        <div style={{
          background:   colors.waitBg,
          border:       `1px solid ${colors.waitBorder}`,
          borderRadius: radius.lg,
          padding:      `${spacing[4]} ${spacing[5]}`,
        }}>
          <div style={{ ...typography.bodySmall, color: colors.waitText, fontWeight: 700, marginBottom: spacing[2] }}>
            待機推奨 — エントリー条件未達
          </div>
          {mode.waitReasons.map((reason, i) => (
            <div key={i} style={{ ...typography.caption, color: colors.waitText, marginTop: spacing[1] }}>
              • {reason}
            </div>
          ))}
        </div>
      )}

    </div>
  )
}
