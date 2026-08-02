import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatJPYAuto } from '../../utils/format'
import type { AppState, Trust } from '../../types'
import type {
  AllocationClassProjection,
  AllocationConsumerSnapshot,
} from '../../types/allocationConsumer'
import type {
  AllocationPlanSnapshot,
  AssetClassPlan,
} from '../../types/allocationPlan'
import type { T2AllocationProjection } from '../../store/allocationConsumerSelectors'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { T2AllocationPanel, T2_JpFund } from './T2_JpFund'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t2Source from './T2_JpFund.tsx?raw'

const mockedStore = vi.hoisted(() => ({
  state: null as AppState | null,
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T2 store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

type AvailableConsumer = Extract<
  AllocationConsumerSnapshot,
  { readonly availability: 'available' }
>

function jpTrustClass(
  overrides: Partial<AllocationClassProjection> = {},
): AllocationClassProjection {
  return {
    assetClass: 'JP_TRUST',
    currentAmount: 901_001,
    targetAmount: 702_002,
    targetRatio: 0.4,
    targetGap: 503_003,
    overweightAmount: 0,
    maximumAmount: null,
    hardHeadroom: 808_008,
    softHeadroom: 707_007,
    effectiveHeadroom: 406_006,
    availableBudget: 607_007,
    allocatedAmount: 104_004,
    remainingHeadroom: 305_005,
    instrumentPlanCount: 2,
    classFullCause: null,
    blockedReasons: [],
    warningReasons: [],
    limitingFactors: [],
    ...overrides,
  }
}

function availableSnapshot(
  classProjection = jpTrustClass(),
  overrides: Partial<AvailableConsumer> = {},
): AvailableConsumer {
  return {
    availability: 'available',
    status: 'current',
    generation: {
      snapshotId: 'snapshot-r3-b',
      generatedAt: '2026-08-02T00:00:00.000Z',
      sourceHoldingsSnapshotId: 'holdings-r3-b',
      sourceSettingsVersion: 'settings-r3-b',
      sourceCandidateGenerationId: 'candidates-r3-b',
    },
    snapshotExecutability: 'EXECUTABLE',
    totalAssets: 2_000_000,
    grossCash: 1_000_000,
    deployableCash: 900_000,
    shortTermBudget: 800_000,
    longTermBudget: 100_000,
    remainingUnallocatedCash: 795_996,
    marketMode: 'normal',
    regime: 'neutral',
    classes: [classProjection],
    instruments: [],
    blockedReasons: [],
    warnings: [],
    ...overrides,
  }
}

function projection(
  classProjection = jpTrustClass(),
  snapshotOverrides: Partial<AvailableConsumer> = {},
): T2AllocationProjection {
  const snapshot = availableSnapshot(classProjection, snapshotOverrides)
  return { snapshot, jpTrustClass: classProjection }
}

function renderAvailable(
  value = projection(),
  isMobile = false,
): string {
  return renderToStaticMarkup(
    <T2AllocationPanel
      consumerSnapshot={value.snapshot}
      projection={value}
      isMobile={isMobile}
    />,
  )
}

function unavailable(
  status: 'absent' | 'invalid' | 'stale' | 'current' = 'absent',
  reasonKind: 'NOT_CALCULATED' | 'INVALIDATED' | 'UNKNOWN_REASON_CODE' = 'NOT_CALCULATED',
): AllocationConsumerSnapshot {
  return { availability: 'unavailable', status, reasonKind }
}

function renderUnavailable(value: AllocationConsumerSnapshot): string {
  return renderToStaticMarkup(
    <T2AllocationPanel
      consumerSnapshot={value}
      projection={null}
      isMobile={false}
    />,
  )
}

const SHARED_CURRENT_AMOUNT = 1_111_111
const SHARED_TARGET_AMOUNT = 2_222_222
const SHARED_TARGET_GAP = 333_333
const SHARED_ALLOCATED_AMOUNT = 222_222
const SHARED_REMAINING_GAP = 111_111

const LEGACY_TOTAL_VALUE = 8_888_888
const LEGACY_TARGET_VALUE = 7_777_777
const LEGACY_DIFF_VALUE = 666_666
const LEGACY_CURRENT_VALUE = 4_444_444
const LEGACY_FUND_EVAL = 123_457
const CASH_OVERRIDE = 3_210_987
const CASH_RESERVE_OVERRIDE = 2_109_876
const LEGACY_ADD_ROOM = 987_654

const UNAVAILABLE_LEGACY_TOTAL_VALUE = 9_999_999
const UNAVAILABLE_LEGACY_FUND_EVAL = 1_234_567
// Exact positive sentinel rendered by M-AUD-W4 for the two legacy values above.
const UNAVAILABLE_LEGACY_FALLBACK = 265_433

const JP_FUND_FIXTURE: Trust = {
  id: 't2-wiring-fund',
  name: 'T2 wiring legacy fund fixture',
  abbr: 'T2-WIRE',
  account: 'test-only',
  policy: 'JAPAN_SHORTTERM',
  eval: LEGACY_FUND_EVAL,
  pnlPct: 0,
  dayPct: 0,
  cost: 0.1,
  mu: 0.1,
  sigma: 0.1,
  score: 50,
  signal: 'HOLD',
  ev: 0,
  decision: 'HOLD',
}

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

function jpTrustPlan(
  overrides: Partial<AssetClassPlan> = {},
): AssetClassPlan {
  return {
    assetClass: 'JP_TRUST',
    currentAmount: SHARED_CURRENT_AMOUNT,
    targetAmount: SHARED_TARGET_AMOUNT,
    targetRatio: 0.25,
    minimumAmount: null,
    maximumAmount: null,
    targetGap: SHARED_TARGET_GAP,
    hardHeadroom: 777_777,
    softHeadroom: 888_888,
    effectiveHeadroom: 444_444,
    overweightAmount: 0,
    availableBudget: 444_444,
    allocatedAmount: SHARED_ALLOCATED_AMOUNT,
    remainingHeadroom: SHARED_REMAINING_GAP,
    limitingFactors: [],
    blockedReasons: [],
    warningReasons: [],
    ...overrides,
  }
}

function allocationPlan(
  classPlan = jpTrustPlan(),
  includeInstrument = true,
): AllocationPlanSnapshot {
  const snapshotId = 'snapshot-t2-production-wiring'
  return {
    authorityVersion: 'hr-allocation-plan-v1',
    schemaVersion: 'allocation-plan-1',
    snapshotId,
    generatedAt: '2026-08-03T00:00:00.000Z',
    sourceHoldingsSnapshotId: 'holdings-t2-production-wiring',
    sourceSettingsVersion: 'settings-t2-production-wiring',
    totalAssets: 10_000_000,
    grossCash: 3_210_987,
    deployableCash: 2_100_987,
    shortTermBudget: 1_900_987,
    longTermBudget: 200_000,
    marketMode: 'normal',
    regime: 'neutral',
    assetClassPlans: [classPlan],
    instrumentPlans: includeInstrument ? [{
      instrumentId: 't2-wiring-fund',
      assetClass: 'JP_TRUST',
      kind: 'jp_trust',
      relationship: 'already_held',
      currentAmount: classPlan.currentAmount,
      role: 'CORE',
      reason: 'test-only production wiring fixture',
      priceJpy: null,
      lotSizeShares: null,
      rawSuggestedAmount: classPlan.allocatedAmount,
      cappedSuggestedAmount: classPlan.allocatedAmount,
      roundedSuggestedAmount: classPlan.allocatedAmount,
      finalSuggestedAmount: classPlan.allocatedAmount,
      estimatedMaximumAmount: classPlan.effectiveHeadroom,
      roundingLoss: 0,
      executable: true,
      calculationSnapshotId: snapshotId,
      authorityVersion: 'hr-allocation-plan-v1',
      buyKind: 'BUY_MORE',
      targetAmount: classPlan.targetAmount,
      classHeadroom: classPlan.effectiveHeadroom,
      instrumentTargetGap: classPlan.targetGap,
      instrumentMaxPositionHeadroom: classPlan.effectiveHeadroom,
      sectorHeadroom: classPlan.effectiveHeadroom,
      concentrationHeadroom: classPlan.effectiveHeadroom,
      liquidityHeadroom: classPlan.effectiveHeadroom,
      lotSizeHeadroom: null,
      effectiveInstrumentHeadroom: classPlan.effectiveHeadroom,
      independentMaximum: classPlan.effectiveHeadroom,
      simultaneouslyExecutableAmount: classPlan.allocatedAmount,
      allocatedAmount: classPlan.allocatedAmount,
      limitingFactors: [],
      blockedReasons: [],
      warningReasons: [],
    }] : [],
    remainingUnallocatedCash: 1_878_765,
    blockedReasons: [],
    warnings: [],
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
  }
}

function productionWiringState({
  plan = allocationPlan(),
  status = 'current',
  legacyTotalValue = LEGACY_TOTAL_VALUE,
  legacyFundEval = LEGACY_FUND_EVAL,
}: {
  plan?: AllocationPlanSnapshot | null
  status?: AppState['allocationPlanStatus']
  legacyTotalValue?: number
  legacyFundEval?: number
} = {}): AppState {
  return {
    ...BASE_APP_STATE,
    trust: [{ ...JP_FUND_FIXTURE, eval: legacyFundEval }],
    allocationPlan: plan,
    allocationPlanStatus: status,
    allocationPlanCandidateGenerationId: 'candidates-t2-production-wiring',
    cash: CASH_OVERRIDE,
    cashReserve: CASH_RESERVE_OVERRIDE,
    addRoom: LEGACY_ADD_ROOM,
    cashAssumptions: {
      cashDeposits: CASH_OVERRIDE,
      standbyFunds: CASH_RESERVE_OVERRIDE,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-08-03T00:00:00.000Z',
    },
    universe: {
      totalValue: legacyTotalValue,
      categories: [{
        class: 'JP_TRUST',
        label: 'legacy JP trust category',
        role: 'legacy authority discriminator',
        horizon: 'ultra_short',
        currentValue: LEGACY_CURRENT_VALUE,
        currentRatio: 0.5,
        targetRatio: 0.4,
        targetValue: LEGACY_TARGET_VALUE,
        diffValue: -LEGACY_DIFF_VALUE,
        diffRatio: -0.1,
        score: 50,
        lastUpdatedAt: '2026-08-03T00:00:00.000Z',
      }],
      cash: CASH_OVERRIDE,
      cashReserve: CASH_RESERVE_OVERRIDE,
      addRoom: LEGACY_ADD_ROOM,
      lastUpdatedAt: '2026-08-03T00:00:00.000Z',
    },
  }
}

function renderProductionT2(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T2_JpFund />)
}

describe('R3-b T2 shared allocation consumer component', () => {
  it('passes the raw shared projection model to the component without aliases', () => {
    const value = projection()
    const element = (
      <T2AllocationPanel
        consumerSnapshot={value.snapshot}
        projection={value}
        isMobile={false}
      />
    )
    expect(element.props.projection).toBe(value)
    expect(element.props.consumerSnapshot).toBe(value.snapshot)
    expect(element.props.projection.jpTrustClass).toBe(value.jpTrustClass)
  })

  it('T2-T01..T2-T05 displays every canonical JP_TRUST class amount verbatim', () => {
    const value = projection()
    const html = renderAvailable(value)
    for (const amount of [
      value.jpTrustClass.currentAmount,
      value.jpTrustClass.targetAmount,
      value.jpTrustClass.targetGap,
      value.jpTrustClass.overweightAmount,
      value.jpTrustClass.allocatedAmount,
      value.jpTrustClass.remainingHeadroom,
      value.jpTrustClass.effectiveHeadroom,
      value.jpTrustClass.availableBudget,
    ]) {
      expect(html).toContain(formatJPYAuto(amount))
    }
    expect(html).toContain('data-snapshot-id="snapshot-r3-b"')
    expect(html).toContain('data-source-holdings-snapshot-id="holdings-r3-b"')
    expect(html).toContain('data-source-settings-version="settings-r3-b"')
    expect(html).toContain('data-source-candidate-generation-id="candidates-r3-b"')
    expect(html).toContain('data-snapshot-executability="EXECUTABLE"')
    expect(html).toContain('data-class-full-cause=""')
  })

  it('kills target-current and remaining-gap recomputation with discriminator values', () => {
    const classProjection = jpTrustClass({
      currentAmount: 900_000,
      targetAmount: 700_000,
      targetGap: 321_123,
      allocatedAmount: 100_000,
      effectiveHeadroom: 456_789,
      remainingHeadroom: 123_456,
    })
    const html = renderAvailable(projection(classProjection))
    expect(html).toContain(formatJPYAuto(321_123))
    expect(html).toContain(formatJPYAuto(123_456))
    expect(html).not.toContain(formatJPYAuto(700_000 - 900_000))
    expect(html).not.toContain(formatJPYAuto(321_123 - 100_000))
  })

  it('cash override and addRoom discriminators stay on shared target and gap authority', () => {
    const classProjection = jpTrustClass({
      targetAmount: 1_234_567,
      targetGap: 234_567,
      availableBudget: 345_678,
    })
    const html = renderAvailable(projection(classProjection))
    const legacyDiffValueIgnoringOverrideAndAddingRoom = 9_876_543
    const legacyTargetValueIgnoringOverride = 8_765_432
    expect(html).toContain(formatJPYAuto(1_234_567))
    expect(html).toContain(formatJPYAuto(234_567))
    expect(html).toContain(formatJPYAuto(345_678))
    expect(html).not.toContain(formatJPYAuto(legacyDiffValueIgnoringOverrideAndAddingRoom))
    expect(html).not.toContain(formatJPYAuto(legacyTargetValueIgnoringOverride))
  })

  it('T2-T06 uses class allocatedAmount and preserves the JP_TRUST E-01 equality', () => {
    const instrumentAllocatedAmounts = [60_001, 40_002]
    const classAllocatedAmount = instrumentAllocatedAmounts
      .reduce((sum, amount) => sum + amount, 0)
    const classProjection = jpTrustClass({ allocatedAmount: classAllocatedAmount })
    expect(classProjection.allocatedAmount).toBe(100_003)
    const html = renderAvailable(projection(classProjection))
    expect(html).toContain(formatJPYAuto(classAllocatedAmount))
  })

  it.each([
    ['current', 'EXECUTABLE', '最新'],
    ['estimate_only', 'CALCULATED_NOT_EXECUTABLE', '見積のみ（実行不可）'],
    ['blocked', 'CALCULATED_NOT_EXECUTABLE', '配分プラン: 実行不可'],
  ] as const)('state matrix keeps %s available and uses snapshot executability', (
    status,
    snapshotExecutability,
    label,
  ) => {
    const value = projection(jpTrustClass(), { status, snapshotExecutability })
    const html = renderAvailable(value)
    expect(html).toContain(`data-allocation-status="${status}"`)
    expect(html).toContain(`data-snapshot-executability="${snapshotExecutability}"`)
    expect(html).toContain(label)
    expect(html).toContain(formatJPYAuto(value.jpTrustClass.targetGap))
  })

  it('does not infer blocked state from blockedReasons length', () => {
    const currentWithReason = projection(jpTrustClass(), {
      status: 'current',
      snapshotExecutability: 'EXECUTABLE',
      blockedReasons: ['SAFE_MODE_ACTIVE'],
    })
    const blockedWithoutReason = projection(jpTrustClass(), {
      status: 'blocked',
      snapshotExecutability: 'CALCULATED_NOT_EXECUTABLE',
      blockedReasons: [],
    })
    expect(renderAvailable(currentWithReason)).toContain('data-allocation-status="current"')
    expect(renderAvailable(blockedWithoutReason)).toContain('data-allocation-status="blocked"')
  })

  it.each([
    ['absent', 'NOT_CALCULATED', '配分プランは未計算です'],
    ['invalid', 'INVALIDATED', '配分プランを計算できません'],
    ['stale', 'INVALIDATED', '配分プランの再計算が必要です'],
    ['current', 'UNKNOWN_REASON_CODE', '不明な状態を検出しました'],
  ] as const)('T2-T07 fails closed for %s without monetary fallback', (
    status,
    reasonKind,
    copy,
  ) => {
    const html = renderUnavailable(unavailable(status, reasonKind))
    expect(html).toContain('data-allocation-availability="unavailable"')
    expect(html).toContain(copy)
    expect(html).not.toContain('万円')
    expect(html).not.toContain('億円')
    expect(html).not.toMatch(/[0-9,]+円/)
  })

  it('distinguishes an authoritative zero amount from unavailable', () => {
    const zero = jpTrustClass({
      currentAmount: 0,
      targetAmount: 0,
      targetGap: 0,
      allocatedAmount: 0,
      remainingHeadroom: 0,
      effectiveHeadroom: 0,
      availableBudget: 0,
      instrumentPlanCount: 0,
    })
    const availableHtml = renderAvailable(projection(zero))
    const unavailableHtml = renderUnavailable(unavailable())
    expect(availableHtml).toContain('0円')
    expect(availableHtml).toContain('0件')
    expect(unavailableHtml).not.toContain('0円')
  })

  it('keeps structured reason categories separate while rendering their canonical counts', () => {
    const classProjection = jpTrustClass({
      blockedReasons: ['CLASS_FULL'],
      warningReasons: ['MARKET_CAUTION'],
      limitingFactors: ['AVAILABLE_BUDGET'],
    })
    const value = projection(classProjection, {
      blockedReasons: ['SAFE_MODE_ACTIVE'],
      warnings: ['ESTIMATE_ONLY'],
    })
    const html = renderAvailable(value)
    expect(html).toContain('snapshot: ブロック 1件 / 警告 1件')
    expect(html).toContain('JP_TRUST: ブロック 1件 / 警告 1件 /')
    expect(html).toContain('制約 1件')
  })

  it('preserves the responsive row/column layout smoke contract', () => {
    expect(renderAvailable(projection(), false)).toContain('flex-direction:row')
    expect(renderAvailable(projection(), true)).toContain('flex-direction:column')
  })

  it('T2-T08..T2-T11 cuts legacy monetary sources but preserves signal plumbing', () => {
    expect(t2Source).not.toContain('selectJpFundTotalEval')
    expect(t2Source).not.toContain('classTarget')
    expect(t2Source).not.toContain('.targetValue')
    expect(t2Source).not.toContain('.diffValue')
    expect(t2Source).not.toContain('row.suggestedAmount')
    expect(t2Source).not.toContain('recommendedCoreBudget')
    expect(t2Source).not.toContain('recommendedSatelliteBudget')
    expect(t2Source).not.toContain('T7_Trust')
    expect(t2Source).toContain('buildTrustPortfolioPlan')
    expect(t2Source).toContain('buildTrustPlanGateInputs')
    expect(t2Source).toContain('shortTermSignal')
    expect(t2Source).toContain('marketContext')
    expect(t2Source).toContain('checklist')
  })
})

describe('R3-b-R1 T2_JpFund production store wiring', () => {
  it('renders current shared JP_TRUST sentinels through the actual tab without legacy authority', () => {
    const html = renderProductionT2(productionWiringState())

    expect(html).toContain('data-allocation-availability="available"')
    expect(html).toContain('data-allocation-status="current"')
    expect(html).toContain('data-snapshot-id="snapshot-t2-production-wiring"')
    for (const sharedAmount of [
      SHARED_CURRENT_AMOUNT,
      SHARED_TARGET_AMOUNT,
      SHARED_TARGET_GAP,
      SHARED_ALLOCATED_AMOUNT,
      SHARED_REMAINING_GAP,
    ]) {
      expect(html).toContain(formatJPYAuto(sharedAmount))
    }
    for (const legacyAmount of [
      LEGACY_TOTAL_VALUE,
      LEGACY_CURRENT_VALUE,
      LEGACY_TARGET_VALUE,
      LEGACY_DIFF_VALUE,
      CASH_OVERRIDE,
      CASH_RESERVE_OVERRIDE,
      LEGACY_ADD_ROOM,
    ]) {
      expect(html).not.toContain(formatJPYAuto(legacyAmount))
    }
  })

  it('keeps unavailable shared authority fail-closed despite positive legacy amounts', () => {
    const html = renderProductionT2(productionWiringState({
      plan: null,
      status: 'absent',
      legacyTotalValue: UNAVAILABLE_LEGACY_TOTAL_VALUE,
      legacyFundEval: UNAVAILABLE_LEGACY_FUND_EVAL,
    }))

    expect(html).toContain('data-allocation-availability="unavailable"')
    expect(html).toContain('data-allocation-status="absent"')
    expect(html).toContain('配分プランは未計算です')
    expect(html).not.toContain('data-snapshot-id=')
    expect(html).not.toContain(formatJPYAuto(UNAVAILABLE_LEGACY_FALLBACK))
  })

  it('removes current shared money after a stale transition without a legacy fallback', () => {
    const plan = allocationPlan()
    const currentHtml = renderProductionT2(productionWiringState({ plan }))
    const staleHtml = renderProductionT2(productionWiringState({
      plan,
      status: 'stale',
      legacyTotalValue: UNAVAILABLE_LEGACY_TOTAL_VALUE,
      legacyFundEval: UNAVAILABLE_LEGACY_FUND_EVAL,
    }))

    expect(currentHtml).toContain(formatJPYAuto(SHARED_TARGET_GAP))
    expect(staleHtml).toContain('data-allocation-availability="unavailable"')
    expect(staleHtml).toContain('data-allocation-status="stale"')
    expect(staleHtml).toContain('配分プランの再計算が必要です')
    expect(staleHtml).not.toContain(formatJPYAuto(SHARED_TARGET_GAP))
    expect(staleHtml).not.toContain(formatJPYAuto(UNAVAILABLE_LEGACY_FALLBACK))
  })

  it('keeps invalid shared authority unavailable when the legacy universe is populated', () => {
    const html = renderProductionT2(productionWiringState({
      plan: allocationPlan(),
      status: 'invalid',
      legacyTotalValue: UNAVAILABLE_LEGACY_TOTAL_VALUE,
      legacyFundEval: UNAVAILABLE_LEGACY_FUND_EVAL,
    }))

    expect(html).toContain('data-allocation-availability="unavailable"')
    expect(html).toContain('data-allocation-status="invalid"')
    expect(html).toContain('配分プランを計算できません')
    expect(html).not.toContain(formatJPYAuto(SHARED_TARGET_GAP))
    expect(html).not.toContain(formatJPYAuto(UNAVAILABLE_LEGACY_FALLBACK))
  })

  it('distinguishes authoritative zero from unavailable in the actual tab render', () => {
    const zeroClass = jpTrustPlan({
      currentAmount: 0,
      targetAmount: 0,
      targetGap: 0,
      overweightAmount: 0,
      hardHeadroom: 0,
      softHeadroom: 0,
      effectiveHeadroom: 0,
      availableBudget: 0,
      allocatedAmount: 0,
      remainingHeadroom: 0,
    })
    const zeroHtml = renderProductionT2(productionWiringState({
      plan: allocationPlan(zeroClass, false),
    }))
    const unavailableHtml = renderProductionT2(productionWiringState({
      plan: null,
      status: 'absent',
      legacyTotalValue: UNAVAILABLE_LEGACY_TOTAL_VALUE,
      legacyFundEval: UNAVAILABLE_LEGACY_FUND_EVAL,
    }))

    expect(zeroHtml).toContain('data-allocation-availability="available"')
    expect(zeroHtml).toContain('0円')
    expect(zeroHtml).toContain('0件')
    expect(unavailableHtml).toContain('data-allocation-availability="unavailable"')
    expect(unavailableHtml).not.toContain('0円')
    expect(unavailableHtml).not.toBe(zeroHtml)
  })
})
