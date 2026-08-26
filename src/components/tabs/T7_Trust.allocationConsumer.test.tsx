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
import { T7_Trust, computeTrustSynthesisCandidatesForDisplay } from './T7_Trust'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t7Source from './T7_Trust.tsx?raw'
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
} from '../../types/candidateDecisionSynthesis'

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
const NON_ALLOCATION_FOREIGN_FLOW = 432.4

const BASE_UNAVAILABLE_YEN_INVENTORY = [
  {
    owner: 'portfolio total evaluation',
    fixtureSource: 'CORE_TRUST.eval + OVERSEAS_TRUST.eval = 5_123_460',
    token: formatJPYAuto(5_123_460),
    count: 1,
  },
  {
    owner: 'portfolio unrealized profit/loss',
    fixtureSource: 'the two 1.25% pnlPct fixtures format to +6.3万円',
    token: `+${formatJPYAuto(63_253)}`,
    count: 1,
  },
  {
    owner: 'JAPAN_SHORTTERM group total and CORE-A holding card',
    fixtureSource: 'CORE_TRUST.eval',
    token: formatJPYAuto(CORE_TRUST.eval),
    count: 2,
  },
  {
    owner: 'OVERSEAS_LONGTERM group total and OVER-A holding card',
    fixtureSource: 'OVERSEAS_TRUST.eval',
    token: formatJPYAuto(OVERSEAS_TRUST.eval),
    count: 2,
  },
  {
    owner: 'direct, embedded, and effective GOLD reference metrics',
    fixtureSource: 'no GOLD trust and no embedded-gold fixture ids',
    token: formatJPYAuto(0),
    count: 3,
  },
  {
    owner: 'market-context foreign flow',
    fixtureSource: 'flows.foreignNet',
    token: `+${NON_ALLOCATION_FOREIGN_FLOW.toFixed(0)}億円`,
    count: 1,
  },
] as const

const TRUST_EVAL_ARM_TRUSTS: Trust[] = [
  {
    ...CORE_TRUST,
    id: 'trust:eval-arm-a',
    abbr: 'EVAL-A',
    eval: 2_345_679,
    pnlPct: 0,
  },
  {
    ...CORE_TRUST,
    id: 'trust:eval-arm-b',
    abbr: 'EVAL-B',
    eval: 3_210_987,
    pnlPct: 0,
  },
  {
    ...OVERSEAS_TRUST,
    id: 'trust:eval-arm-c',
    abbr: 'EVAL-C',
    eval: 4_567_891,
    pnlPct: 0,
  },
]

const TRUST_EVAL_ARM_YEN_INVENTORY = [
  {
    owner: 'portfolio total evaluation',
    fixtureSource: 'three TRUST_EVAL_ARM_TRUSTS eval fields total 10_124_557',
    token: formatJPYAuto(10_124_557),
    count: 1,
  },
  {
    owner: 'portfolio unrealized profit/loss',
    fixtureSource: 'all three pnlPct fields are zero（UI-9E: 0は符号なし, R2.4）',
    token: formatJPYAuto(0),
    count: 1,
  },
  {
    owner: 'JAPAN_SHORTTERM group total',
    fixtureSource: 'EVAL-A.eval + EVAL-B.eval = 5_556_666',
    token: formatJPYAuto(5_556_666),
    count: 1,
  },
  {
    owner: 'OVERSEAS_LONGTERM group total and EVAL-C holding card',
    fixtureSource: 'EVAL-C.eval',
    token: formatJPYAuto(4_567_891),
    count: 2,
  },
  {
    owner: 'EVAL-A holding card',
    fixtureSource: 'EVAL-A.eval',
    token: formatJPYAuto(2_345_679),
    count: 1,
  },
  {
    owner: 'EVAL-B holding card',
    fixtureSource: 'EVAL-B.eval',
    token: formatJPYAuto(3_210_987),
    count: 1,
  },
  {
    owner: 'direct, embedded, and effective GOLD reference metrics',
    fixtureSource: 'no GOLD trust and no embedded-gold fixture ids',
    token: formatJPYAuto(0),
    count: 3,
  },
  {
    owner: 'market-context foreign flow',
    fixtureSource: 'flows.foreignNet',
    token: `+${NON_ALLOCATION_FOREIGN_FLOW.toFixed(0)}億円`,
    count: 1,
  },
] as const

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
    independentlyExecutable: allocatedAmount > 0,
    marketRank: null,
    artifactIndex: 0,
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
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: (LEGACY_CASH) + (2_345_679),
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    },
    officialDecision: officialDecision(),
    flows: {
      last_updated: '2026-08-04T00:00:00.000Z',
      weekOf: '2026-08-04',
      foreignNet: NON_ALLOCATION_FOREIGN_FLOW,
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

function instrumentAllocationCards(markup: string): string[] {
  return [...markup.matchAll(/<div data-allocation-instrument-id="[^"]+"[\s\S]*?(?=<div data-allocation-instrument-id=|<\/section>)/g)]
    .map(match => match[0])
}

const RENDERED_YEN_AMOUNT = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:万|億)?円/

function decodeRenderedNumericEntities(fullMarkup: string): string {
  return fullMarkup
    .replace(/&#(\d+);/g, (_entity, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([\da-f]+);/gi, (_entity, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&minus;/g, '-')
    .replace(/&nbsp;/g, ' ')
}

function extractRenderedYenMultiset(fullMarkup: string): string[] {
  const renderedYenAmountGlobal = new RegExp(RENDERED_YEN_AMOUNT.source, 'g')
  return [...decodeRenderedNumericEntities(fullMarkup).matchAll(renderedYenAmountGlobal)]
    .map(([amount]) => amount)
    .sort()
}

function explicitExpectedYenMultiset(
  inventory: readonly { readonly token: string; readonly count: number }[],
): string[] {
  return inventory.flatMap(({ token, count }) => Array<string>(count).fill(token)).sort()
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
    expect(markup).toContain('資産クラス余力')
    expect(markup).toContain(formatJPYAuto(SHARED_HEADROOM))
  })

  it.each([
    ['current', 'current'],
    ['estimate_only', 'estimate_only'],
    ['blocked', 'blocked'],
  ] as const)('G-1: %s branchの全instrument行に銘柄別余力を表示する', (_name, status) => {
    const plan = allocationPlan()
    if (status === 'estimate_only') {
      plan.warnings = ['ESTIMATE_ONLY']
      plan.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!.warningReasons = ['ESTIMATE_ONLY']
      plan.instrumentPlans.filter(item => item.assetClass === 'JP_TRUST').forEach(item => {
        item.allocatedAmount = 0
        item.finalSuggestedAmount = 0
        item.simultaneouslyExecutableAmount = 0
        item.executable = false
        item.warningReasons = ['ESTIMATE_ONLY']
      })
    } else if (status === 'blocked') {
      plan.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!.blockedReasons = ['SAFE_MODE_ACTIVE']
      plan.instrumentPlans.filter(item => item.assetClass === 'JP_TRUST').forEach(item => {
        item.allocatedAmount = 0
        item.finalSuggestedAmount = 0
        item.simultaneouslyExecutableAmount = 0
        item.executable = false
        item.blockedReasons = ['SAFE_MODE_ACTIVE']
      })
    }

    const cards = instrumentAllocationCards(renderT7(appState(plan, status)))
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      expect(card).toContain('銘柄別余力')
      expect(card).toContain(formatJPYAuto(230_000))
    }
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
      expect(extractRenderedYenMultiset(markup)).toEqual(
        explicitExpectedYenMultiset(BASE_UNAVAILABLE_YEN_INVENTORY),
      )
    }

    const baseUniverse = appState().universe!
    const unavailableArms: Array<{
      name: string
      state: AppState
      expected: readonly { readonly token: string; readonly count: number }[]
    }> = [
      {
        name: 'Arm A: universe.addRoom sentinel',
        state: appState(null, 'absent', {
          universe: { ...baseUniverse },
        }),
        expected: BASE_UNAVAILABLE_YEN_INVENTORY,
      },
      {
        name: 'Arm B: constant-sensitive legacy fixture',
        state: appState(null, 'absent', {
          cash: 87_654_319,
        }),
        expected: BASE_UNAVAILABLE_YEN_INVENTORY,
      },
      {
        name: 'Arm C: multi-fund trust eval sum sentinel',
        state: appState(null, 'absent', { trust: TRUST_EVAL_ARM_TRUSTS }),
        expected: TRUST_EVAL_ARM_YEN_INVENTORY,
      },
      {
        name: 'Arm D: nonzero legacy coreBudget fixture',
        state: appState(null, 'absent', {
          cashAssumptions: {
            source: 'MANUAL',
            grossCash: 119_753_294,
            safetyReserve: 0,
            pendingOrderCash: null,
            updatedAt: '2026-08-04T00:00:00.000Z',
          },
        }),
        expected: BASE_UNAVAILABLE_YEN_INVENTORY,
      },
    ]

    for (const { name, state, expected } of unavailableArms) {
      const markup = renderT7(state)
      expect(name).toMatch(/^Arm [A-D]:/)
      expect(dataAttribute(markup, 'data-allocation-availability')).toBe('unavailable')
      expect(extractRenderedYenMultiset(markup)).toEqual(explicitExpectedYenMultiset(expected))
    }
  })

  it('T7-T08 distinguishes a valid zero allocation from an unavailable projection', () => {
    const plan = allocationPlan()
    plan.instrumentPlans = plan.instrumentPlans.filter(item => item.assetClass !== 'JP_TRUST')
    const trust = plan.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!
    trust.allocatedAmount = 0
    trust.remainingHeadroom = trust.effectiveHeadroom
    const availableMarkup = renderT7(appState(plan))
    const validZeroYenMultiset = extractRenderedYenMultiset(availableMarkup)
    expect(dataAttribute(availableMarkup, 'data-allocation-availability')).toBe('available')
    expect(dataAttribute(availableMarkup, 'data-instrument-plan-count')).toBe('0')
    expect(availableMarkup).toContain('配分候補なし')
    expect(availableMarkup).toContain(formatJPYAuto(0))

    const absentMarkup = renderT7(appState(null, 'absent'))
    const unavailableYenMultiset = extractRenderedYenMultiset(absentMarkup)
    expect(dataAttribute(absentMarkup, 'data-allocation-availability')).toBe('unavailable')
    expect(absentMarkup).not.toContain('配分済額')
    expect(unavailableYenMultiset).toEqual(
      explicitExpectedYenMultiset(BASE_UNAVAILABLE_YEN_INVENTORY),
    )
    expect(validZeroYenMultiset).not.toEqual(unavailableYenMultiset)
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

  it('T7-T10 CAND-SYN-1E: no candidateDecisionSynthesis means OfficialDecision candidate prose/amount never renders', () => {
    const markup = renderT7(appState())
    expect(markup).not.toContain('未保有テスト投信')
    expect(markup).not.toContain('候補理由は維持')
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
    expect(extractRenderedYenMultiset(queueMarkup)).toEqual([])
    expect(queueMarkup).not.toContain('description')
  })
})

// ── CAND-SYN-1E: T7「未保有投信候補」authority cutover (E1-E18) ─────────
// computeTrustSynthesisCandidatesForDisplay(candidateDecisionSynthesis) is
// now the sole read authority for this section. officialDecision.actions is
// no longer consulted here (see the updated T7-T10 above). These tests lock
// the null/invalid/unavailable fail-closed behavior, the JP_TRUST ×
// new_to_portfolio × (BUY_NEW|WATCH) eligibility gate, canonical ordering,
// the <=3 display cap, and the absence of any legacy money/ranking leak.

function makeSynthesisEntry(
  overrides: Partial<CandidateDecisionSynthesisEntry> = {},
): CandidateDecisionSynthesisEntry {
  return {
    entryId: 'JP_TRUST:trust:synthesis-a',
    instrumentId: 'trust:synthesis-a',
    assetClass: 'JP_TRUST',
    displayName: 'CAND_SYN_DEFAULT_TRUST_CANDIDATE',
    code: null,
    action: 'BUY_NEW',
    rank: 1,
    relationship: 'new_to_portfolio',
    candidateQuality: {
      source: 'trust_registry',
      marketRank: null,
      marketScore: null,
      tier: null,
      dataConfidence: null,
      selectedReasons: [],
      riskReasons: [],
    },
    portfolioFit: { status: 'not_evaluated', relationship: null, reasons: [], risks: [], hardGatePassed: true },
    allocationRole: { assetClassTargetGap: 0, assetClassTargetRatio: 0, classHeadroom: 0, instrumentHeadroom: 0 },
    money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 },
    blockingReasons: [],
    warnings: [],
    limitingFactors: [],
    whyThis: [],
    whyNotExecutable: [],
    ...overrides,
  }
}

function makeSynthesisSnapshot(
  decisions: CandidateDecisionSynthesisEntry[],
  watchList: CandidateDecisionSynthesisEntry[] = [],
  overrides: Partial<CandidateDecisionSynthesisSnapshot> = {},
): CandidateDecisionSynthesisSnapshot {
  return {
    schemaVersion: 'candidate-decision-synthesis-1',
    authorityVersion: 'cand-syn-v1',
    synthesisId: 'candidate-decision-synthesis:t7-test',
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'available',
    provenance: {} as CandidateDecisionSynthesisSnapshot['provenance'],
    decisions,
    watchList,
    datasetReasons: [],
    privacyMode: 'local_only',
    persistence: 'none',
    not_for_trading: true,
    ...overrides,
  }
}

function candidateSectionMarkup(markup: string): string {
  const start = markup.indexOf('未保有投信候補')
  if (start < 0) return ''
  const nextMarkers = ['超短期実行候補', '当日実行候補', '資金配分提案']
  const nextIdx = nextMarkers
    .map(marker => markup.indexOf(marker, start))
    .filter(idx => idx > start)
    .sort((a, b) => a - b)[0] ?? markup.length
  return markup.slice(start, nextIdx)
}

describe('CAND-SYN-1E: T7 candidate authority cutover (E1-E18)', () => {
  it('E1 synthesis=null + stale officialDecision candidate: stale name/reason absent', () => {
    const state = appState(allocationPlan(), 'current', {
      officialDecision: officialDecision(),
      candidateDecisionSynthesis: null,
    })
    const markup = renderT7(state)
    expect(markup).not.toContain('未保有テスト投信')
    expect(markup).not.toContain('候補理由は維持')
  })

  it('E2 synthesis invalid: candidate section absent', () => {
    const synthesis = makeSynthesisSnapshot([makeSynthesisEntry()], [], { status: 'invalid' })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: synthesis })
    const markup = renderT7(state)
    expect(markup).not.toContain('未保有投信候補')
    expect(markup).not.toContain('CAND_SYN_DEFAULT_TRUST_CANDIDATE')
  })

  it('E3 synthesis unavailable: candidate section absent', () => {
    const synthesis = makeSynthesisSnapshot([makeSynthesisEntry()], [], { status: 'unavailable' })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: synthesis })
    const markup = renderT7(state)
    expect(markup).not.toContain('未保有投信候補')
    expect(markup).not.toContain('CAND_SYN_DEFAULT_TRUST_CANDIDATE')
  })

  it('E4 available JP_TRUST BUY_NEW new_to_portfolio is rendered', () => {
    const entry = makeSynthesisEntry({ entryId: 'e4', displayName: 'CAND_SYN_BUY_NEW_TRUST', action: 'BUY_NEW' })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([entry]) })
    expect(renderT7(state)).toContain('CAND_SYN_BUY_NEW_TRUST')
  })

  it('E5 available JP_TRUST WATCH new_to_portfolio is rendered', () => {
    const entry = makeSynthesisEntry({ entryId: 'e5', displayName: 'CAND_SYN_WATCH_TRUST', action: 'WATCH' })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([], [entry]) })
    expect(renderT7(state)).toContain('CAND_SYN_WATCH_TRUST')
  })

  it('E6 JP_TRUST ADD already_held is NOT rendered in 未保有投信候補', () => {
    const entry = makeSynthesisEntry({
      entryId: 'e6', displayName: 'CAND_SYN_ADD_ALREADY_HELD', action: 'ADD', relationship: 'already_held',
    })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([entry]) })
    expect(renderT7(state)).not.toContain('CAND_SYN_ADD_ALREADY_HELD')
  })

  it('E7 JP_TRUST WATCH already_held is NOT rendered', () => {
    const entry = makeSynthesisEntry({
      entryId: 'e7', displayName: 'CAND_SYN_WATCH_ALREADY_HELD', action: 'WATCH', relationship: 'already_held',
    })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([], [entry]) })
    expect(renderT7(state)).not.toContain('CAND_SYN_WATCH_ALREADY_HELD')
  })

  it('E8 JP_STOCK BUY_NEW is NOT rendered in the T7 candidate section', () => {
    const entry = makeSynthesisEntry({
      entryId: 'e8', instrumentId: 'stock:e8', displayName: 'CAND_SYN_STOCK_CANDIDATE',
      assetClass: 'JP_STOCK', action: 'BUY_NEW',
    })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([entry]) })
    expect(renderT7(state)).not.toContain('CAND_SYN_STOCK_CANDIDATE')
  })

  it('E9 BLOCKED JP_TRUST new_to_portfolio is NOT rendered (frozen T7 contract: BUY_NEW/WATCH only)', () => {
    const entry = makeSynthesisEntry({ entryId: 'e9', displayName: 'CAND_SYN_BLOCKED_TRUST', action: 'BLOCKED' })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([entry]) })
    expect(renderT7(state)).not.toContain('CAND_SYN_BLOCKED_TRUST')
  })

  it('E10 stale officialDecision candidate + current synthesis candidate: only the synthesis candidate is shown', () => {
    const entry = makeSynthesisEntry({ entryId: 'e10', displayName: 'CAND_SYN_CURRENT_TRUST', action: 'BUY_NEW' })
    const state = appState(allocationPlan(), 'current', {
      officialDecision: officialDecision(),
      candidateDecisionSynthesis: makeSynthesisSnapshot([entry]),
    })
    const markup = renderT7(state)
    expect(markup).toContain('CAND_SYN_CURRENT_TRUST')
    expect(markup).not.toContain('未保有テスト投信')
    expect(markup).not.toContain('候補理由は維持')
  })

  it('E11 canonical order preserved: decisions before watchList, each array order intact', () => {
    const d1 = makeSynthesisEntry({ entryId: 'd1', instrumentId: 'trust:d1', displayName: 'ORDER_D1', action: 'BUY_NEW' })
    const d2 = makeSynthesisEntry({ entryId: 'd2', instrumentId: 'trust:d2', displayName: 'ORDER_D2', action: 'BUY_NEW' })
    const w1 = makeSynthesisEntry({ entryId: 'w1', instrumentId: 'trust:w1', displayName: 'ORDER_W1', action: 'WATCH' })
    const state = appState(allocationPlan(), 'current', {
      candidateDecisionSynthesis: makeSynthesisSnapshot([d1, d2], [w1]),
    })
    const markup = renderT7(state)
    const positions = ['ORDER_D1', 'ORDER_D2', 'ORDER_W1'].map(token => markup.indexOf(token))
    expect(positions.every(pos => pos >= 0)).toBe(true)
    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
  })

  it('E12 display cap: at most 3 candidate entries render even with more eligible entries', () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5']
    const entries = ids.map(id => makeSynthesisEntry({ entryId: id, instrumentId: `trust:${id}`, displayName: `CAP_${id}` }))
    const pure = computeTrustSynthesisCandidatesForDisplay(makeSynthesisSnapshot(entries))
    expect(pure.length).toBe(3)

    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot(entries) })
    const markup = renderT7(state)
    const renderedCount = ids.filter(id => markup.includes(`CAP_${id}`)).length
    expect(renderedCount).toBe(3)
  })

  it('E13 no sort/rank/score calculation in the T7 synthesis candidate helper', () => {
    const helperStart = t7Source.indexOf('export function computeTrustSynthesisCandidatesForDisplay')
    const helperEnd = t7Source.indexOf('export function trustSynthesisCandidateReasonText')
    const helperSection = t7Source.slice(helperStart, helperEnd)
    expect(helperStart).toBeGreaterThan(-1)
    expect(helperSection).not.toMatch(/\.sort\(/)
    expect(helperSection).not.toMatch(/marketRank/)
    expect(helperSection).not.toMatch(/\.score\b/)
  })

  it('E14 candidate section never reads OfficialDecisionItem.reason / officialDecision', () => {
    const sectionStart = t7Source.indexOf('未保有投信候補（BUY_NEW / WATCH）')
    const sectionEnd = t7Source.indexOf('{SUPPRESSION_BANNER_PREFIX} — 新規買い判断停止中。最新データ確認後に再判定。')
    expect(sectionStart).toBeGreaterThan(-1)
    expect(sectionEnd).toBeGreaterThan(sectionStart)
    const section = t7Source.slice(sectionStart, sectionEnd)
    expect(section).not.toContain('officialDecision')
    expect(section).not.toContain('item.reason')
  })

  it('E15 WATCH entry renders zero positive yen amounts in the candidate section', () => {
    const entry = makeSynthesisEntry({ entryId: 'e15', displayName: 'CAND_SYN_WATCH_MONEY_CHECK', action: 'WATCH' })
    const state = appState(allocationPlan(), 'current', { candidateDecisionSynthesis: makeSynthesisSnapshot([], [entry]) })
    const section = candidateSectionMarkup(renderT7(state))
    expect(section).toContain('CAND_SYN_WATCH_MONEY_CHECK')
    expect(extractRenderedYenMultiset(section)).toEqual([])
  })

  it('E16 T7_Trust.tsx never reads state.candidatePortfolioRecommendations', () => {
    expect(t7Source).not.toMatch(/\.candidatePortfolioRecommendations\b/)
  })

  it('E17 candidate list is keyed by entry.entryId, not array index', () => {
    expect(t7Source).toContain('key={entry.entryId}')
  })

  it('E18 adding candidateDecisionSynthesis data does not change trustPlan.shortTermRows rendering', () => {
    const marker = '当日実行候補'
    const withoutSynthesis = renderT7(appState(allocationPlan(), 'current', { candidateDecisionSynthesis: null }))
    const entry = makeSynthesisEntry({ entryId: 'e18', displayName: 'CAND_SYN_SHORTTERM_UNCHANGED_CHECK' })
    const withSynthesis = renderT7(appState(allocationPlan(), 'current', {
      candidateDecisionSynthesis: makeSynthesisSnapshot([entry]),
    }))
    const sliceFrom = (markup: string) =>
      markup.includes(marker) ? markup.slice(markup.indexOf(marker)) : ''
    expect(sliceFrom(withSynthesis)).toBe(sliceFrom(withoutSynthesis))
  })
})
