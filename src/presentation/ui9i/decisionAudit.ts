// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: Decision Audit（判断の詳細）の view-model projector。
//
// 既存 T1（個別株）とは別の detail surface。Home の Hero から push される。
// 構成（固定順）:
//   Decision Recap / Rationale / Binding Constraints / Candidate Execution State /
//   Portfolio Impact / Evidence・Freshness・Provenance / Deep Links
// SAFE_MODE のときだけ、Recap の直後に SAFE_MODE 詳細を追加する
// （実効判定・元データ・鮮度・Tier A・発動条件・制限・再開見込を潰さず分ける）。
//
// 第二のダッシュボードにしない: 値はすべて canonical authority の再掲であり、
// 新しい判断・重み・重要度は付与しない。rationale は提示順のまま。
// ═══════════════════════════════════════════════════════════
import type { AppState } from '../../types'
import { selectAllocationConsumerSnapshot, selectExecutableDeployableCash } from '../../store/allocationConsumerSelectors'
import {
  selectCandidateDecisionSynthesis,
  selectEffectiveSafeModeActive,
  selectSafeModeDataQuality,
} from '../../store/selectors'
import { getSellableDate, isSellLocked } from '../../domain/constraints/stockLock'
import { BLOCKED_REASON_LABEL, WARNING_REASON_LABEL } from '../../components/candidates/candidateDecisionSynthesisPresentation'
import { formatJstMonthDayTime, formatMonthDay } from './formatters'
import { MARKET_REGIME_LABEL, OPERATION_MODE_LABEL, UNAVAILABLE_LABEL } from './labels'
import { projectPortfolio, type PortfolioClassRow } from './portfolioPresentation'
import { projectCandidateSection } from './candidatePresentation'
import {
  candidateProjectionContextFor,
  resolveHeroState,
  heroCopy,
  type DeployableCashViewModel,
  type HeroState,
} from './todayHome'

export interface AuditRecap {
  readonly state: HeroState
  readonly eyebrow: string
  readonly headline: string
  readonly generatedAtLabel: string | null
  /** 「中立 / 通常」。canonical が利用できない場合は null。 */
  readonly regimeModeLabel: string | null
}

export interface AuditLockRow { readonly code: string; readonly sellableLabel: string | null }

export interface AuditSafeModeDetail {
  readonly effective: '有効' | '無効'
  readonly raw: string
  readonly freshness: string
  readonly tierAViolations: string
  readonly tierAAlerts: string
  readonly conditions: readonly { id: string; label: string; value: string }[]
  readonly restrictions: readonly { id: string; label: string; value: string }[]
  readonly estimatedResume: string
}

export interface AuditEvidenceRow { readonly id: string; readonly label: string; readonly value: string }

export interface DecisionAuditViewModel {
  readonly recap: AuditRecap
  readonly safeMode: AuditSafeModeDetail | null
  /** OfficialDecision.rationale を提示順のまま。判断が利用不可のときは空。 */
  readonly rationale: readonly string[]
  readonly constraints: {
    readonly locks: readonly AuditLockRow[]
    readonly blockedReasons: readonly string[]
    readonly warnings: readonly string[]
  }
  readonly candidateState: {
    readonly available: boolean
    readonly executableCount: number
    readonly reviewCount: number
    readonly deployableCash: DeployableCashViewModel
    readonly amountPresented: boolean
  }
  /** 目標水準ではないクラスのみ（canonical 順）。 */
  readonly portfolioGaps: readonly PortfolioClassRow[]
  readonly evidence: readonly AuditEvidenceRow[]
}

const or = (v: string | null, fallback: string = UNAVAILABLE_LABEL): string => v ?? fallback

function projectSafeModeDetail(state: AppState, now: number): AuditSafeModeDetail {
  const data = state.safeMode.safe_mode
  const loaded = state.system.dataSourceStatus.safeMode === 'loaded'
  const dq = selectSafeModeDataQuality(state, now)
  const cond = data.trigger_conditions
  const restr = data.restrictions
  const flag = (on: boolean, yes: string, no: string) => (loaded ? (on ? yes : no) : '確認できません')
  const violations = state.tierAViolations
  const alerts = state.tierAAlerts
  const tierALoaded = state.system.dataSourceStatus.tierAViolations === 'loaded' && violations.status !== 'unavailable'
  const alertsLoaded = state.system.dataSourceStatus.tierAAlerts === 'loaded' && alerts.status !== 'unavailable'
  return {
    effective: selectEffectiveSafeModeActive(state, now) ? '有効' : '無効',
    raw: loaded ? (data.active ? 'active' : 'inactive') : '取得できません',
    freshness: dq.level === 'ok' ? or(formatJstMonthDayTime(data.last_checked)) : `${dq.level === 'stale' ? '鮮度低下' : UNAVAILABLE_LABEL}`,
    tierAViolations: tierALoaded ? (violations.summary.total_violations > 0 ? `${violations.summary.total_violations}件` : 'なし') : UNAVAILABLE_LABEL,
    tierAAlerts: alertsLoaded ? (alerts.summary.total_triggered > 0 ? `${alerts.summary.total_triggered}件` : 'なし') : UNAVAILABLE_LABEL,
    conditions: [
      { id: 'tier1', label: 'Tier1 データの鮮度低下', value: flag(cond.tier1_data_stale, '成立', 'なし') },
      { id: 't3', label: 'Tier A T3 違反', value: flag(cond.tier_a_t3_violated, '成立', 'なし') },
      { id: 'crisis', label: '危機レジーム', value: flag(cond.crisis_regime, '成立', 'なし') },
      { id: 'system', label: 'システムエラー', value: flag(cond.system_error, '成立', 'なし') },
    ],
    restrictions: [
      { id: 'buys', label: '新規買付', value: flag(restr.new_buys_frozen, '停止中', '制限なし') },
      { id: 'rebalance', label: 'リバランス', value: flag(restr.rebalance_frozen, '停止中', '制限なし') },
      { id: 'force-sell', label: '強制売却', value: flag(restr.force_sell_active, '発動中', '未発動') },
    ],
    estimatedResume: loaded ? or(formatJstMonthDayTime(data.estimated_resume_at), '未定') : '確認できません',
  }
}

export function selectDecisionAuditViewModel(state: AppState, now: number = Date.now()): DecisionAuditViewModel {
  const heroState = resolveHeroState(state, now)
  const decision = state.officialDecision
  const copy = heroCopy(heroState)
  const snapshot = selectAllocationConsumerSnapshot(state)
  const cash = selectExecutableDeployableCash(state)
  const synthesis = selectCandidateDecisionSynthesis(state)
  const candidates = projectCandidateSection(synthesis, candidateProjectionContextFor(heroState))
  const portfolio = projectPortfolio(snapshot)

  const recap: AuditRecap = {
    state: heroState,
    eyebrow: copy?.eyebrow ?? '今日の判断',
    headline: copy?.headline ?? (heroState === 'boot' ? '起動中' : (decision?.headline ?? '')),
    generatedAtLabel: decision === null ? null : formatJstMonthDayTime(decision.generatedAt),
    regimeModeLabel: snapshot.availability === 'available'
      ? `${MARKET_REGIME_LABEL[snapshot.regime]} / ${OPERATION_MODE_LABEL[snapshot.marketMode]}`
      : null,
  }

  // 注入された監査基準時刻をロック判定にも渡す（Home と同じ now で同じ結論になる）。
  const nowDate = new Date(now)
  const locks: AuditLockRow[] = state.holdings
    .filter(h => isSellLocked(h, nowDate))
    .map(h => ({ code: h.code, sellableLabel: formatMonthDay(getSellableDate(h)) }))

  const showCanonicalBlocks = snapshot.availability === 'available'
  const evidenceTs = state.system.dataTimestamps
  const evidence: AuditEvidenceRow[] = [
    { id: 'market', label: '市場データ', value: or(formatJstMonthDayTime(evidenceTs?.market ?? state.market.last_updated)) },
    {
      id: 'allocation',
      label: '配分スナップショット',
      value: snapshot.availability === 'available' ? or(formatJstMonthDayTime(snapshot.generation.generatedAt)) : UNAVAILABLE_LABEL,
    },
    { id: 'candidates', label: '候補データ', value: or(formatJstMonthDayTime(evidenceTs?.candidateFunnel ?? evidenceTs?.candidatesStocks)) },
    { id: 'holding-evidence', label: '保有エビデンス', value: or(formatJstMonthDayTime(evidenceTs?.holdingEvidence ?? null)) },
    { id: 'safe-mode', label: 'SAFE_MODE 権限', value: or(formatJstMonthDayTime(state.safeMode.safe_mode.last_checked)) },
  ]

  return {
    recap,
    safeMode: heroState === 'safe_mode' ? projectSafeModeDetail(state, now) : null,
    rationale: heroState !== 'decision_unavailable' && heroState !== 'boot' && decision !== null ? [...decision.rationale] : [],
    constraints: {
      locks,
      blockedReasons: showCanonicalBlocks ? snapshot.blockedReasons.map(r => BLOCKED_REASON_LABEL[r] ?? r) : [],
      warnings: showCanonicalBlocks ? snapshot.warnings.map(w => WARNING_REASON_LABEL[w] ?? w) : [],
    },
    candidateState: {
      available: candidates.status === 'available',
      executableCount: candidates.executableCount,
      reviewCount: candidates.reviewCount,
      deployableCash: cash.available ? { kind: 'available', amountJpy: cash.amount } : { kind: 'unavailable' },
      amountPresented: candidates.rows.some(r => r.executableAmountJpy !== null),
    },
    portfolioGaps: portfolio === null ? [] : portfolio.rows.filter(r => r.direction !== 'on_target'),
    evidence,
  }
}
