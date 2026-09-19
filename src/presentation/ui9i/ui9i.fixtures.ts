// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: テスト / dev ハーネス共用の fixture（canonical 入力のみ）。
// R4.1 デザインのモックデータ（総資産 3,800万円、国内個別株 35% など）と一致させる。
// 金額・比率・スコアはすべて「権限提示値の想定」であり、投資助言ではない。
// ═══════════════════════════════════════════════════════════
import type { OfficialDecision } from '../../types'
import type { AllocationClassProjection, AllocationConsumerSnapshot } from '../../types/allocationConsumer'
import type { AssetClass } from '../../types/allocationPlan'
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
} from '../../types/candidateDecisionSynthesis'
import type { TodayHomeInputs } from './todayHome'

/** 2026-10-06 08:40 JST */
export const FIXTURE_NOW_MS = Date.parse('2026-10-06T08:40:00+09:00')
export const FIXTURE_GENERATED_AT = '2026-10-06T08:30:00+09:00'

export function fixtureDecision(overrides: Partial<OfficialDecision> = {}): OfficialDecision {
  return {
    generatedAt: FIXTURE_GENERATED_AT,
    source: 'committee',
    headline: '慎重運用',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions: [],
    risks: [],
    rationale: [
      '市場レジームは中立で、運用モードは通常です。',
      '現在の配分と目標配分を確認しています。',
      '実行条件を満たす候補は現時点でありません。',
    ],
    ...overrides,
  }
}

const zeroClass = (assetClass: AssetClass): AllocationClassProjection => ({
  assetClass,
  currentAmount: 0, targetAmount: 0, targetRatio: 0, targetGap: 0, overweightAmount: 0,
  maximumAmount: null, hardHeadroom: 0, softHeadroom: 0, effectiveHeadroom: 0,
  availableBudget: 0, allocatedAmount: 0, remainingHeadroom: 0, instrumentPlanCount: 0,
  classFullCause: null, blockedReasons: [], warningReasons: [], limitingFactors: [],
})

/** canonical 順: JP_STOCK, JP_TRUST, OVERSEAS_TRUST, GOLD, CASH, CASH_RESERVE */
export const CANONICAL_CLASS_ORDER: readonly AssetClass[] =
  ['JP_STOCK', 'JP_TRUST', 'OVERSEAS_TRUST', 'GOLD', 'CASH', 'CASH_RESERVE']

export function fixtureClasses(): AllocationClassProjection[] {
  const c = (assetClass: AssetClass, cur: number, target: number, ratio: number): AllocationClassProjection => ({
    ...zeroClass(assetClass),
    currentAmount: cur,
    targetAmount: target,
    targetRatio: ratio,
    targetGap: Math.max(0, target - cur),
    overweightAmount: Math.max(0, cur - target),
  })
  return [
    c('JP_STOCK', 13_300_000, 11_400_000, 0.30),
    c('JP_TRUST', 7_600_000, 7_600_000, 0.20),
    c('OVERSEAS_TRUST', 9_500_000, 9_500_000, 0.25),
    c('GOLD', 3_800_000, 3_800_000, 0.10),
    c('CASH', 2_660_000, 3_800_000, 0.10),
    c('CASH_RESERVE', 1_140_000, 1_900_000, 0.05),
  ]
}

export function fixtureAllocation(overrides: Partial<Extract<AllocationConsumerSnapshot, { availability: 'available' }>> = {}): AllocationConsumerSnapshot {
  return {
    availability: 'available',
    status: 'current',
    generation: {
      snapshotId: 'snapshot-fixture',
      generatedAt: FIXTURE_GENERATED_AT,
      sourceHoldingsSnapshotId: 'holdings-fixture',
      sourceSettingsVersion: 'settings-fixture',
      sourceCandidateGenerationId: 'candidate-generation-fixture',
    },
    snapshotExecutability: 'EXECUTABLE',
    totalAssets: 38_000_000,
    grossCash: 2_660_000,
    deployableCash: 1_200_000,
    shortTermBudget: 0,
    longTermBudget: 0,
    remainingUnallocatedCash: 0,
    marketMode: 'normal',
    regime: 'neutral',
    classes: fixtureClasses(),
    instruments: [],
    blockedReasons: [],
    warnings: [],
    ...overrides,
  }
}

export const UNAVAILABLE_ALLOCATION: AllocationConsumerSnapshot = {
  availability: 'unavailable', status: 'absent', reasonKind: 'NOT_CALCULATED',
}

export function fixtureEntry(
  id: string,
  overrides: Partial<Omit<CandidateDecisionSynthesisEntry, 'candidateQuality' | 'money'>> & {
    candidateQuality?: Partial<CandidateDecisionSynthesisEntry['candidateQuality']>
    money?: CandidateDecisionSynthesisEntry['money']
  } = {},
): CandidateDecisionSynthesisEntry {
  const { candidateQuality, money, ...rest } = overrides
  return {
    entryId: `entry-${id}`,
    instrumentId: `stock:${id}`,
    assetClass: 'JP_STOCK',
    displayName: `銘柄${id}`,
    code: id,
    action: 'WATCH',
    rank: 1,
    relationship: 'new_to_portfolio',
    candidateQuality: {
      source: 'candidate_funnel', marketRank: 1, marketScore: 70, tier: 'deep_review',
      dataConfidence: 0.8, selectedReasons: [], riskReasons: [], ...candidateQuality,
    },
    portfolioFit: { status: 'evaluated', relationship: null, reasons: [], risks: [], hardGatePassed: true },
    allocationRole: { assetClassTargetGap: 0, assetClassTargetRatio: 0.3, classHeadroom: 0, instrumentHeadroom: 0 },
    money: money ?? { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 },
    blockingReasons: [], warnings: [], limitingFactors: [], whyThis: [], whyNotExecutable: [],
    ...rest,
  }
}

export function fixtureSynthesis(
  decisions: CandidateDecisionSynthesisEntry[],
  watchList: CandidateDecisionSynthesisEntry[],
  status: CandidateDecisionSynthesisSnapshot['status'] = 'available',
): CandidateDecisionSynthesisSnapshot {
  return {
    schemaVersion: 'candidate-decision-synthesis-1',
    authorityVersion: 'cand-syn-v1',
    synthesisId: 'synthesis-fixture',
    generatedAt: FIXTURE_GENERATED_AT,
    status,
    provenance: {
      candidateGenerationId: 'candidate-generation-fixture',
      candidatePublicationState: 'published_pass',
      candidateFreshness: 'fresh',
      allocationSnapshotId: 'snapshot-fixture',
      allocationSnapshotGeneratedAt: FIXTURE_GENERATED_AT,
      allocationSnapshotStatus: 'current',
      sourceHoldingsSnapshotId: 'holdings-fixture',
      sourceSettingsVersion: 'settings-fixture',
      cashAuthorityUpdatedAt: FIXTURE_GENERATED_AT,
      marketDataAsOf: FIXTURE_GENERATED_AT,
      portfolioFitEvaluatedAt: FIXTURE_GENERATED_AT,
      candidatesStocksUpdatedAt: null,
      candidatesStocksSourceUpdatedAt: null,
      candidatesStocksRunToken: null,
    },
    decisions,
    watchList,
    datasetReasons: [],
    privacyMode: 'local_only',
    persistence: 'none',
    not_for_trading: true,
  }
}

/** 3 件の要レビュー候補（design M1 NORMAL）。canonical 順は marketScore 降順ではないことに注意。 */
export function fixtureReviewWatchList(): CandidateDecisionSynthesisEntry[] {
  return [
    fixtureEntry('8725', { displayName: 'MS&AD', action: 'WATCH', relationship: 'new_to_portfolio', candidateQuality: { marketScore: 81, tier: 'deep_review' } }),
    fixtureEntry('6098', { displayName: 'リクルートHD', action: 'WATCH', relationship: 'already_held', candidateQuality: { marketScore: 76, tier: 'deep_review' } }),
    fixtureEntry('5021', { displayName: 'コスモエネルギー', action: 'WATCH', relationship: 'new_to_portfolio', candidateQuality: { marketScore: 72, tier: 'deep_review' } }),
  ]
}

export function fixtureExecutableDecision(): CandidateDecisionSynthesisEntry {
  return fixtureEntry('8725', {
    displayName: 'MS&AD', action: 'BUY_NEW', relationship: 'new_to_portfolio',
    candidateQuality: { marketScore: 81, tier: 'actionable' },
    money: { kind: 'EXECUTABLE', executableAmountJpy: 400_000, calculationSnapshotId: 'snapshot-fixture' },
  })
}

export function baseInputs(overrides: Partial<TodayHomeInputs> = {}): TodayHomeInputs {
  return {
    nowMs: FIXTURE_NOW_MS,
    systemStatus: 'success',
    officialDecision: fixtureDecision(),
    safeModeEffective: false,
    safeModeSource: { loaded: true, newBuysFrozen: false, rebalanceFrozen: false },
    marketDataOk: true,
    allocation: fixtureAllocation(),
    deployableCash: { available: true, amount: 1_200_000, unavailableStatus: null },
    synthesis: fixtureSynthesis([], fixtureReviewWatchList()),
    holdings: [],
    effectiveCash: { source: 'manual', grossCash: 2_660_000 },
    timestamps: { market: '2026-10-06 08:30', candidates: '2026-10-06T07:55:00+09:00' },
    marketFeed: {
      marketLoaded: true, macroLoaded: true, nikkeiViLoaded: true,
      nikkei: 38_521, nikkeiChgPct: 0.6, sp500: 5_762, sp500ChgPct: 0.4, vix: 14.8, nikkeiVi: 22.4,
    },
    ...overrides,
  }
}

export type HomeScenario =
  | 'normal' | 'actionable' | 'candidate_unavailable' | 'safe_mode' | 'data_wait' | 'decision_unavailable' | 'boot'

export function scenarioInputs(scenario: HomeScenario): TodayHomeInputs {
  switch (scenario) {
    case 'normal':
      return baseInputs()
    case 'actionable':
      return baseInputs({
        synthesis: fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)),
        holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }],
      })
    case 'candidate_unavailable':
      return baseInputs({ synthesis: null })
    case 'safe_mode':
      return baseInputs({
        safeModeEffective: true,
        safeModeSource: { loaded: true, newBuysFrozen: true, rebalanceFrozen: true },
        allocation: fixtureAllocation({ marketMode: 'caution' }),
        holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }],
      })
    case 'data_wait':
      return baseInputs({
        officialDecision: fixtureDecision({ stance: 'data_wait', dataQualitySuppressed: true, noTrade: true }),
        deployableCash: { available: false, amount: 0, unavailableStatus: 'absent' },
      })
    case 'decision_unavailable':
      return baseInputs({ officialDecision: null })
    case 'boot':
      return baseInputs({ systemStatus: 'initializing', officialDecision: null, safeModeEffective: true })
  }
}
