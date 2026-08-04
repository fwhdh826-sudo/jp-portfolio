import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatJPYAuto } from '../../utils/format'
import { buildTrustPortfolioPlan } from '../../domain/optimization/trustPortfolio'
import { checkNoTrade } from '../../domain/optimization/idealAllocation'
import { buildTrustPlanGateInputs } from '../../domain/optimization/trustPlanInputs'
import {
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
} from '../../domain/learning/trustShortTracker'
import type {
  AppState,
  AllocationPlanSnapshotState,
  OfficialDecision,
  Trust,
} from '../../types'
import type {
  AllocationPlanSnapshot,
  AssetClassPlan,
  InstrumentPlan,
} from '../../types/allocationPlan'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { selectT7TrustAllocationProjections } from '../../store/allocationConsumerSelectors'
import { T2_JpFund } from './T2_JpFund'
import { T7_Trust } from './T7_Trust'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t7Source from './T7_Trust.tsx?raw'

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { readonly eager: boolean; readonly query: string; readonly import: string },
    ): Record<string, string>
  }
}

const mockedStore = vi.hoisted(() => ({
  state: null as AppState | null,
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T7 store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const productionSources = import.meta.glob('/src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

const CORE_TRUST: Trust = {
  id: 'trust:core-a',
  name: '国内株コア投信',
  abbr: 'CORE-A',
  account: 'test-only',
  policy: 'JAPAN_SHORTTERM',
  eval: 123_457,
  pnlPct: 1.25,
  dayPct: 0.5,
  cost: 0.1,
  mu: 0.1,
  sigma: 0.1,
  score: 63,
  signal: 'HOLD',
  ev: 0,
  decision: 'HOLD',
}

const OVERSEAS_TRUST: Trust = {
  ...CORE_TRUST,
  id: 'trust:overseas-a',
  name: '海外コア投信',
  abbr: 'OVER-A',
  policy: 'OVERSEAS_LONGTERM',
  eval: 5_000_003,
}

const SHARED_CURRENT = 1_350_000
const SHARED_TARGET = 1_650_000
const SHARED_TARGET_GAP = 300_000
const SHARED_ALLOCATED = 200_000
const SHARED_REMAINING = 150_000
const SHARED_HEADROOM = 350_000
const SHARED_BUDGET = 250_000

const LEGACY_CATEGORY_CURRENT = 7_654_321
const LEGACY_CATEGORY_TARGET = 8_765_432
const LEGACY_CATEGORY_DIFF = 1_111_111
const LEGACY_ADD_ROOM = 9_876_543
const LEGACY_CASH = 6_543_219
const OFFICIAL_SUGGESTED = 7_777_731

function classPlan(
  assetClass: AssetClassPlan['assetClass'],
  overrides: Partial<AssetClassPlan> = {},
): AssetClassPlan {
  return {
    assetClass,
    currentAmount: assetClass === 'JP_TRUST' ? SHARED_CURRENT : 900_000,
    targetAmount: assetClass === 'JP_TRUST' ? SHARED_TARGET : 1_000_000,
    targetRatio: assetClass === 'JP_TRUST' ? 0.3 : 0.2,
    minimumAmount: null,
    maximumAmount: null,
    targetGap: assetClass === 'JP_TRUST' ? SHARED_TARGET_GAP : 100_000,
    hardHeadroom: assetClass === 'JP_TRUST' ? 500_000 : 100_000,
    softHeadroom: assetClass === 'JP_TRUST' ? 400_000 : 100_000,
    effectiveHeadroom: assetClass === 'JP_TRUST' ? SHARED_HEADROOM : 100_000,
    overweightAmount: 0,
    availableBudget: assetClass === 'JP_TRUST' ? SHARED_BUDGET : 50_000,
    allocatedAmount: assetClass === 'JP_TRUST' ? SHARED_ALLOCATED : 50_000,
    remainingHeadroom: assetClass === 'JP_TRUST' ? SHARED_REMAINING : 50_000,
    limitingFactors: [],
    blockedReasons: [],
    warningReasons: [],
    ...overrides,
  }
}

function instrumentPlan(
  instrumentId: string,
  assetClass: InstrumentPlan['assetClass'],
  allocatedAmount: number,
  overrides: Partial<InstrumentPlan> = {},
): InstrumentPlan {
  return {
    instrumentId,
    assetClass,
    kind: assetClass === 'JP_TRUST' ? 'jp_trust' : 'jp_stock',
    relationship: 'already_held',
    currentAmount: assetClass === 'JP_TRUST' ? 450_000 : 900_000,
    role: assetClass === 'JP_TRUST' ? 'CORE' : null,
    reason: 'R3-c2 fixture',
    priceJpy: assetClass === 'JP_STOCK' ? 1_000 : null,
    lotSizeShares: assetClass === 'JP_STOCK' ? 100 : null,
    rawSuggestedAmount: allocatedAmount,
    cappedSuggestedAmount: allocatedAmount,
    roundedSuggestedAmount: allocatedAmount,
    finalSuggestedAmount: allocatedAmount,
    estimatedMaximumAmount: assetClass === 'JP_TRUST' ? 240_000 : 100_000,
    roundingLoss: 0,
    executable: allocatedAmount > 0,
    calculationSnapshotId: 'snapshot-r3-c2',
    authorityVersion: 'hr-allocation-plan-v1',
    buyKind: 'BUY_MORE',
    targetAmount: assetClass === 'JP_TRUST' ? SHARED_TARGET : 1_000_000,
    classHeadroom: assetClass === 'JP_TRUST' ? SHARED_HEADROOM : 100_000,
    instrumentTargetGap: assetClass === 'JP_TRUST' ? SHARED_TARGET_GAP : 100_000,
    instrumentMaxPositionHeadroom: 300_000,
    sectorHeadroom: 300_000,
    concentrationHeadroom: 300_000,
    liquidityHeadroom: 300_000,
    lotSizeHeadroom: null,
    effectiveInstrumentHeadroom: assetClass === 'JP_TRUST' ? 230_000 : 100_000,
    independentMaximum: assetClass === 'JP_TRUST' ? 230_000 : 100_000,
    simultaneouslyExecutableAmount: allocatedAmount,
    allocatedAmount,
    limitingFactors: [],
    blockedReasons: [],
    warningReasons: [],
    ...overrides,
  }
}

function allocationPlan(): AllocationPlanSnapshot {
  return {
    authorityVersion: 'hr-allocation-plan-v1',
    schemaVersion: 'allocation-plan-1',
    snapshotId: 'snapshot-r3-c2',
    generatedAt: '2026-08-04T00:00:00.000Z',
    sourceHoldingsSnapshotId: 'holdings-r3-c2',
    sourceSettingsVersion: 'settings-r3-c2',
    totalAssets: 10_000_000,
    grossCash: 3_000_000,
    deployableCash: 2_000_000,
    shortTermBudget: SHARED_BUDGET,
    longTermBudget: 1_000_000,
    marketMode: 'normal',
    regime: 'neutral',
    assetClassPlans: [
      classPlan('JP_STOCK'),
      classPlan('JP_TRUST'),
    ],
    instrumentPlans: [
      instrumentPlan('stock:outside-t7', 'JP_STOCK', 50_000),
      instrumentPlan('trust:core-a', 'JP_TRUST', 120_000, {
        currentAmount: 600_000,
        role: 'CORE',
      }),
      instrumentPlan('trust:satellite-a', 'JP_TRUST', 80_000, {
        currentAmount: 400_000,
        role: 'SATELLITE',
        buyKind: 'BUY_NEW',
        relationship: 'new_to_portfolio',
      }),
      instrumentPlan('trust:zero-a', 'JP_TRUST', 0, {
        currentAmount: 350_000,
        role: 'CORE',
        finalSuggestedAmount: 0,
        executable: false,
      }),
    ],
    remainingUnallocatedCash: 1_750_000,
    blockedReasons: [],
    warnings: [],
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
  }
}

function officialDecision(): OfficialDecision {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    source: 'candidate',
    headline: 'R3-c2 fixture',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions: [{
      id: 'official-trust-candidate',
      assetType: 'jp_trust',
      name: '未保有テスト投信',
      action: 'BUY_NEW',
      reason: '候補理由は維持',
      source: 'candidate',
      isCandidate: true,
      suggestedAmount: OFFICIAL_SUGGESTED,
      candidateSizingTier: 'full',
    }],
    risks: [],
  } as unknown as OfficialDecision
}

function appState(
  plan: AllocationPlanSnapshot | null = allocationPlan(),
  status: AllocationPlanSnapshotState = 'current',
  overrides: Partial<AppState> = {},
): AppState {
  const freshTimestamp = '2099-08-04T00:00:00.000Z'
  return {
    ...BASE_APP_STATE,
    safeMode: {
      ...BASE_APP_STATE.safeMode,
      safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: false },
    },
    market: {
      ...BASE_APP_STATE.market,
      last_updated: freshTimestamp,
    },
    system: {
      ...BASE_APP_STATE.system,
      dataSourceStatus: {
        ...BASE_APP_STATE.system.dataSourceStatus,
        market: 'loaded',
        safeMode: 'loaded',
      },
      dataTimestamps: {
        ...BASE_APP_STATE.system.dataTimestamps!,
        market: freshTimestamp,
        safeMode: freshTimestamp,
      },
    },
    trust: [CORE_TRUST, OVERSEAS_TRUST],
    allocationPlan: plan,
    allocationPlanStatus: status,
    allocationPlanCandidateGenerationId: 'candidate-generation-r3-c2',
    cash: LEGACY_CASH,
    cashReserve: 2_345_679,
    addRoom: LEGACY_ADD_ROOM,
    cashAssumptions: {
      cashDeposits: LEGACY_CASH,
      standbyFunds: 2_345_679,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-08-04T00:00:00.000Z',
    },
    officialDecision: officialDecision(),
    flows: {
      last_updated: '2026-08-04T00:00:00.000Z',
      weekOf: '2026-08-04',
      foreignNet: 432.4,
      individualNet: 0,
      institutionalNet: 0,
      trust5w: 0,
    },
    universe: {
      totalValue: 20_000_007,
      categories: [{
        class: 'JP_TRUST',
        label: 'legacy JP trust category',
        role: 'legacy discriminator',
        horizon: 'ultra_short',
        currentValue: LEGACY_CATEGORY_CURRENT,
        currentRatio: 0.25,
        targetRatio: 0.4,
        targetValue: LEGACY_CATEGORY_TARGET,
        diffValue: LEGACY_CATEGORY_DIFF,
        diffRatio: 0.15,
        score: 50,
        lastUpdatedAt: '2026-08-04T00:00:00.000Z',
      }],
      cash: LEGACY_CASH,
      cashReserve: 2_345_679,
      addRoom: LEGACY_ADD_ROOM,
      lastUpdatedAt: '2026-08-04T00:00:00.000Z',
    },
    ...overrides,
  }
}

function renderT7(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T7_Trust />)
}

function renderT2(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T2_JpFund />)
}

function dataAttribute(markup: string, name: string): string {
  const match = markup.match(new RegExp(name + '="([^"]*)"'))
  if (match === null) throw new Error('missing data attribute: ' + name)
  return match[1]
}

function instrumentAllocatedAmounts(markup: string): number[] {
  return [...markup.matchAll(/data-instrument-allocated-amount="([0-9]+)"/g)]
    .map(match => Number(match[1]))
}

function yenMultiset(markup: string): string[] {
  return [...markup.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:万|億)?円/g)]
    .map(match => match[0])
    .sort()
}

function actionQueueMarkup(markup: string): string {
  const start = markup.indexOf('投信アクションキュー（当日実行）')
  const end = markup.indexOf('資金配分提案', start)
  if (start < 0 || end < 0) throw new Error('action queue section not found')
  return markup.slice(start, end)
}

function legacyTrustPlan(state: AppState) {
  const noTradeResult = checkNoTrade({
    market: state.market,
    macro: state.macro,
    sqCalendar: state.sqCalendar,
  } as AppState)
  const gateInputs = buildTrustPlanGateInputs({
    universe: state.universe,
    noTradeResult,
    safeModeActive: false,
    dqSuppressed: false,
  })
  return buildTrustPortfolioPlan({
    trust: state.trust,
    market: state.market,
    macro: state.macro,
    news: state.news,
    sqCalendar: state.sqCalendar,
    margin: state.margin,
    flows: state.flows,
    todayEntryCount: getTrustShortTodayExecutionCount(),
    performance30d: getTrustShortTrackingStats(),
    noTrade: gateInputs.noTrade,
    jpTrustHeadroom: gateInputs.jpTrustHeadroom,
  })
}

describe('R3-c2 T7 AllocationPlanSnapshot shared consumer wiring', () => {
  it('T7-T01 renders T2 class allocation and T7 instrument allocations from one snapshot', () => {
    const state = appState()
    const t2 = renderT2(state)
    const t7 = renderT7(state)
    const instrumentTotal = instrumentAllocatedAmounts(t7)
      .reduce((sum, amount) => sum + amount, 0)

    expect(t2).toContain(formatJPYAuto(SHARED_ALLOCATED))
    expect(instrumentTotal).toBe(SHARED_ALLOCATED)
    expect(Number(dataAttribute(t7, 'data-class-allocated-amount'))).toBe(SHARED_ALLOCATED)
    expect(dataAttribute(t2, 'data-snapshot-id')).toBe(dataAttribute(t7, 'data-snapshot-id'))
  })

  it('T7-T02 respects remaining target and target-reached zero with nonzero current amount', () => {
    const normal = renderT7(appState())
    expect(instrumentAllocatedAmounts(normal).reduce((sum, amount) => sum + amount, 0))
      .toBeLessThanOrEqual(SHARED_TARGET_GAP)

    const reached = allocationPlan()
    const trust = reached.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!
    Object.assign(trust, {
      currentAmount: 1_350_000,
      targetAmount: 1_350_000,
      targetGap: 0,
      hardHeadroom: 500_000,
      softHeadroom: 400_000,
      effectiveHeadroom: 0,
      availableBudget: 300_000,
      allocatedAmount: 0,
      remainingHeadroom: 0,
      blockedReasons: ['CLASS_FULL'],
      warningReasons: [],
      limitingFactors: ['TARGET_GAP'],
    })
    reached.instrumentPlans.filter(item => item.assetClass === 'JP_TRUST').forEach(item => {
      item.allocatedAmount = 0
      item.finalSuggestedAmount = 0
      item.simultaneouslyExecutableAmount = 0
      item.executable = false
    })
    const markup = renderT7(appState(reached))
    expect(dataAttribute(markup, 'data-class-full-cause')).toBe('CLASS_TARGET_REACHED')
    expect(dataAttribute(markup, 'data-class-allocated-amount')).toBe('0')
    expect(markup).toContain(formatJPYAuto(1_350_000))
    expect(markup).toContain('配分済額')
    expect(markup).toContain(formatJPYAuto(0))
  })

  it('T7-T03 displays and respects the shared short-term budget cap', () => {
    const markup = renderT7(appState())
    const total = instrumentAllocatedAmounts(markup).reduce((sum, amount) => sum + amount, 0)
    expect(total).toBeLessThanOrEqual(SHARED_BUDGET)
    expect(markup).toContain('短期予算上限')
    expect(markup).toContain(formatJPYAuto(SHARED_BUDGET))
    expect(markup).not.toContain(formatJPYAuto(4_500_000))
  })

  it('T7-T04 displays and respects the shared JP_TRUST headroom cap', () => {
    const markup = renderT7(appState())
    const total = instrumentAllocatedAmounts(markup).reduce((sum, amount) => sum + amount, 0)
    expect(total).toBeLessThanOrEqual(SHARED_HEADROOM)
    expect(markup).toContain('クラスheadroom')
    expect(markup).toContain(formatJPYAuto(SHARED_HEADROOM))
  })

  it('T7-T05 preserves legacy signal rank, score, rationale, and execution rules', () => {
    const state = appState()
    const plan = legacyTrustPlan(state)
    const markup = renderT7(state)
    expect(plan.shortTermRows.length).toBeGreaterThan(0)
    for (const row of plan.shortTermRows) {
      expect(markup).toContain(row.abbr)
      expect(markup).toContain('スコア ' + row.score + '%')
      for (const rationale of row.rationale) expect(markup).toContain(rationale)
      expect(markup).toContain('エントリー: ' + row.entryRule)
      expect(markup).toContain('利確: ' + row.takeProfitRule)
      expect(markup).toContain('損切: ' + row.stopLossRule)
    }
  })

  it('T7-T06 ignores legacy proposal, target-current, budget, cash, and addRoom authority', () => {
    const markup = renderT7(appState())
    for (const legacyAmount of [
      LEGACY_CATEGORY_CURRENT,
      LEGACY_CATEGORY_TARGET,
      LEGACY_CATEGORY_DIFF,
      LEGACY_ADD_ROOM,
      LEGACY_CASH,
      4_500_000,
      1_000_000,
    ]) {
      expect(markup).not.toContain(formatJPYAuto(legacyAmount))
    }
    expect(markup).toContain(formatJPYAuto(SHARED_TARGET_GAP))
    expect(markup).toContain(formatJPYAuto(SHARED_ALLOCATED))
  })

  it('T7-T07 implements all eight states without a legacy monetary fallback', () => {
    const current = renderT7(appState())
    expect(dataAttribute(current, 'data-allocation-availability')).toBe('available')
    expect(current).toContain('配分プラン: 最新')

    const estimate = allocationPlan()
    estimate.warnings = ['ESTIMATE_ONLY']
    estimate.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!.warningReasons = ['ESTIMATE_ONLY']
    estimate.instrumentPlans.filter(item => item.assetClass === 'JP_TRUST').forEach(item => {
      item.allocatedAmount = 0
      item.finalSuggestedAmount = 0
      item.simultaneouslyExecutableAmount = 0
      item.executable = false
      item.warningReasons = ['ESTIMATE_ONLY']
    })
    const estimateMarkup = renderT7(appState(estimate, 'estimate_only'))
    expect(dataAttribute(estimateMarkup, 'data-allocation-availability')).toBe('available')
    expect(estimateMarkup).toContain('配分プラン: 見積のみ（実行不可）')

    const blocked = allocationPlan()
    const blockedClass = blocked.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!
    blockedClass.allocatedAmount = 0
    blockedClass.blockedReasons = ['SAFE_MODE_ACTIVE']
    blocked.instrumentPlans.filter(item => item.assetClass === 'JP_TRUST').forEach(item => {
      item.allocatedAmount = 0
      item.finalSuggestedAmount = 0
      item.simultaneouslyExecutableAmount = 0
      item.executable = false
      item.blockedReasons = ['SAFE_MODE_ACTIVE']
    })
    const blockedMarkup = renderT7(appState(blocked, 'blocked'))
    expect(blockedMarkup).toContain('配分プラン: 実行不可')
    expect(blockedMarkup).not.toContain(' data-instrument-executable="true"')

    const unavailableCases: Array<[string, AppState, string]> = [
      ['stale', appState(allocationPlan(), 'stale'), '配分プランの再計算が必要です'],
      ['invalid', appState(allocationPlan(), 'invalid'), '配分プランを計算できません'],
      ['absent', appState(null, 'absent'), '配分プランは未計算です'],
      ['cross-tab invalidated', appState(allocationPlan(), 'stale'), '配分プランの再計算が必要です'],
    ]
    const unknown = allocationPlan()
    unknown.instrumentPlans.find(item => item.assetClass === 'JP_TRUST')!
      .warningReasons = ['UNKNOWN_REASON' as never]
    unavailableCases.push([
      'unknown reason code',
      appState(unknown, 'current'),
      '配分プランを利用できません',
    ])

    for (const [_name, state, label] of unavailableCases) {
      const markup = renderT7(state)
      expect(dataAttribute(markup, 'data-allocation-availability')).toBe('unavailable')
      expect(markup).toContain(label)
      expect(markup).not.toContain(formatJPYAuto(SHARED_ALLOCATED))
      expect(markup).not.toContain(formatJPYAuto(LEGACY_CATEGORY_DIFF))
    }

    const variant = appState(allocationPlan(), 'stale', {
      cash: 99_999_991,
      addRoom: 88_888_881,
      universe: {
        ...appState().universe!,
        totalValue: 77_777_771,
        categories: appState().universe!.categories.map(category => ({
          ...category,
          currentValue: 66_666_661,
          targetValue: 55_555_551,
          diffValue: -11_111_110,
        })),
      },
    })
    expect(yenMultiset(renderT7(variant))).toEqual(yenMultiset(renderT7(appState(allocationPlan(), 'stale'))))
  })

  it('T7-T08 distinguishes a valid zero allocation from an unavailable projection', () => {
    const plan = allocationPlan()
    plan.instrumentPlans = plan.instrumentPlans.filter(item => item.assetClass !== 'JP_TRUST')
    const trust = plan.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!
    trust.allocatedAmount = 0
    trust.remainingHeadroom = trust.effectiveHeadroom
    const availableMarkup = renderT7(appState(plan))
    expect(dataAttribute(availableMarkup, 'data-allocation-availability')).toBe('available')
    expect(dataAttribute(availableMarkup, 'data-instrument-plan-count')).toBe('0')
    expect(availableMarkup).toContain('配分候補なし')
    expect(availableMarkup).toContain(formatJPYAuto(0))

    const absentMarkup = renderT7(appState(null, 'absent'))
    expect(dataAttribute(absentMarkup, 'data-allocation-availability')).toBe('unavailable')
    expect(absentMarkup).not.toContain('配分済額')
  })

  it('T7-T09 keeps estimate-only amounts out of allocated and execution fields', () => {
    const plan = allocationPlan()
    plan.warnings = ['ESTIMATE_ONLY']
    const trust = plan.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!
    trust.allocatedAmount = 0
    trust.remainingHeadroom = trust.effectiveHeadroom
    trust.warningReasons = ['ESTIMATE_ONLY']
    plan.instrumentPlans.filter(item => item.assetClass === 'JP_TRUST').forEach(item => {
      item.allocatedAmount = 0
      item.finalSuggestedAmount = 0
      item.simultaneouslyExecutableAmount = 0
      item.executable = false
      item.warningReasons = ['ESTIMATE_ONLY']
    })
    const state = appState(plan, 'estimate_only')
    const projection = selectT7TrustAllocationProjections(state)
    expect(projection?.jpTrustInstruments.every(item => item.finalSuggestedAmount === 0)).toBe(true)
    const markup = renderT7(state)
    expect(markup).toContain('data-estimate-only-warning="present"')
    expect(markup).toContain('参考上限')
    expect(markup).toContain(formatJPYAuto(240_000))
    expect(markup).not.toContain('配分額')
    expect(markup).not.toContain('実行選択額')
  })

  it('T7-T10 removes OfficialDecision suggestedAmount but preserves candidate prose', () => {
    const markup = renderT7(appState())
    expect(markup).toContain('未保有テスト投信')
    expect(markup).toContain('候補理由は維持')
    expect(markup).not.toContain(formatJPYAuto(OFFICIAL_SUGGESTED))
  })

  it('T7-T11 updates T2 and T7 together for a same-id new snapshot object', () => {
    const firstState = appState()
    const firstT2 = renderT2(firstState)
    const firstT7 = renderT7(firstState)
    expect(dataAttribute(firstT2, 'data-snapshot-id')).toBe('snapshot-r3-c2')
    expect(dataAttribute(firstT7, 'data-class-allocated-amount')).toBe('200000')

    const next = structuredClone(firstState.allocationPlan!)
    next.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!.allocatedAmount = 180_000
    next.instrumentPlans.find(item => item.instrumentId === 'trust:core-a')!.allocatedAmount = 100_000
    next.instrumentPlans.find(item => item.instrumentId === 'trust:core-a')!.finalSuggestedAmount = 100_000
    const nextState = appState(next)
    const nextT2 = renderT2(nextState)
    const nextT7 = renderT7(nextState)
    expect(dataAttribute(nextT2, 'data-snapshot-id')).toBe(dataAttribute(nextT7, 'data-snapshot-id'))
    expect(dataAttribute(nextT7, 'data-class-allocated-amount')).toBe('180000')
    expect(nextT2).toContain(formatJPYAuto(180_000))
  })

  it('T7-T12 keeps T7 production independent from the T2 component', () => {
    expect(t7Source).not.toMatch(/from ['"].*T2_JpFund/)
    expect(t7Source).not.toContain('<T2_JpFund')
  })

  it('T7-T13 leaves OfficialDecision free of allocation fields and mutations', () => {
    const state = appState()
    const before = JSON.stringify(state.officialDecision)
    renderT7(state)
    expect(JSON.stringify(state.officialDecision)).toBe(before)
    expect(before).not.toMatch(/allocationPlan|allocatedAmount|snapshotId/)
  })

  it('T7-T14 keeps exactly one AllocationPlanSnapshot writer across production src', () => {
    const callSites = Object.entries(productionSources)
      .filter(([path]) => !path.includes('.test.') && !path.includes('.spec.'))
      .filter(([path]) => !path.endsWith('/domain/allocation/allocationEngine.ts'))
      .flatMap(([path, source]) => {
        const count = source.match(/\bbuildAllocationPlanSnapshot\s*\(/g)?.length ?? 0
        return count === 0 ? [] : [{ path, count }]
      })
    expect(callSites).toEqual([{ path: '/src/store/useAppStore.ts', count: 1 }])
  })

  it('T7-T15 never renders non-JP_TRUST allocation projections', () => {
    const markup = renderT7(appState())
    expect(markup).not.toContain('stock:outside-t7')
    expect(markup).not.toContain('data-allocation-asset-class="JP_STOCK"')
    expect([...markup.matchAll(/data-allocation-asset-class="([^"]+)"/g)]
      .every(match => match[1] === 'JP_TRUST')).toBe(true)
  })

  it('T7-T16 suppresses every executionQueue monetary description at the T7 call site', () => {
    const state = appState()
    const legacyQueue = legacyTrustPlan(state).executionQueue
    expect(legacyQueue.some(item => /\d[\d,]*円/.test(item.detail))).toBe(true)

    const queueMarkup = actionQueueMarkup(renderT7(state))
    expect(yenMultiset(queueMarkup)).toEqual([])
    expect(queueMarkup).not.toContain('description')
  })
})
