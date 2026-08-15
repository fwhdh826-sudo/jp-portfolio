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
import { MetricCard } from '../cards/MetricCard'
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
const NON_ALLOCATION_FOREIGN_FLOW = 432.4

interface LegacyMonetaryFixture {
  readonly legacyTotalValue: number
  readonly legacyFundTotal: number
  readonly categoryCurrentValue: number
  readonly categoryTargetValue: number
  readonly categoryDiffValue: number
  readonly categoryDiffRatio: number
  readonly cashDeposits: number
  readonly standbyFunds: number
}

const DEFAULT_LEGACY_MONETARY_FIXTURE: LegacyMonetaryFixture = {
  legacyTotalValue: LEGACY_TOTAL_VALUE,
  legacyFundTotal: LEGACY_FUND_EVAL,
  categoryCurrentValue: LEGACY_CURRENT_VALUE,
  categoryTargetValue: LEGACY_TARGET_VALUE,
  categoryDiffValue: -LEGACY_DIFF_VALUE,
  categoryDiffRatio: -0.1,
  cashDeposits: CASH_OVERRIDE,
  standbyFunds: CASH_RESERVE_OVERRIDE,
}

const UNAVAILABLE_LEGACY_VARIANTS: readonly LegacyMonetaryFixture[] = [
  {
    legacyTotalValue: 1_234_567,
    legacyFundTotal: LEGACY_FUND_EVAL,
    categoryCurrentValue: 101_010,
    categoryTargetValue: 202_020,
    categoryDiffValue: 101_010,
    categoryDiffRatio: 0.081,
    cashDeposits: 222_222,
    standbyFunds: 33_333,
  },
  {
    legacyTotalValue: 98_765_432,
    legacyFundTotal: LEGACY_FUND_EVAL,
    categoryCurrentValue: 44_444_444,
    categoryTargetValue: 55_555_555,
    categoryDiffValue: 11_111_111,
    categoryDiffRatio: 0.1125,
    cashDeposits: 12_345_678,
    standbyFunds: 8_765_432,
  },
  {
    legacyTotalValue: 20_000_000,
    legacyFundTotal: LEGACY_FUND_EVAL,
    categoryCurrentValue: 19_999_999,
    categoryTargetValue: 1,
    categoryDiffValue: -19_999_998,
    categoryDiffRatio: -0.9999999,
    cashDeposits: 1,
    standbyFunds: 19_999_999,
  },
]

const ALLOCATION_MONETARY_LABELS = [
  'クラス評価額',
  '目標額',
  '目標差分（不足）',
  '目標超過',
  '配分済額',
  '割当後の残余',
  'クラスheadroom',
  '利用可能予算',
] as const

const LEGACY_ALLOCATION_MONETARY_LABELS = [
  '目標差分（参考）',
  '総資産（参考）',
] as const

const UNAVAILABLE_ALLOCATION_MONETARY_LABELS = [
  ...ALLOCATION_MONETARY_LABELS,
  ...LEGACY_ALLOCATION_MONETARY_LABELS,
] as const

const RENDERED_YEN_AMOUNT = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:万|億)?円/

interface RenderedMetricCard {
  readonly label: string
  readonly value: string
}

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
      independentlyExecutable: true,
      marketRank: null,
      artifactIndex: 0,
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
  legacy = DEFAULT_LEGACY_MONETARY_FIXTURE,
}: {
  plan?: AllocationPlanSnapshot | null
  status?: AppState['allocationPlanStatus']
  legacy?: LegacyMonetaryFixture
} = {}): AppState {
  return {
    ...BASE_APP_STATE,
    trust: [{ ...JP_FUND_FIXTURE, eval: legacy.legacyFundTotal }],
    allocationPlan: plan,
    allocationPlanStatus: status,
    allocationPlanCandidateGenerationId: 'candidates-t2-production-wiring',
    cash: legacy.cashDeposits,
    cashReserve: legacy.standbyFunds,
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: (legacy.cashDeposits) + (legacy.standbyFunds),
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-08-03T00:00:00.000Z',
    },
    flows: {
      last_updated: '2026-08-03T00:00:00.000Z',
      weekOf: '2026-08-03',
      foreignNet: NON_ALLOCATION_FOREIGN_FLOW,
      individualNet: 0,
      institutionalNet: 0,
      trust5w: 0,
    },
    universe: {
      totalValue: legacy.legacyTotalValue,
      categories: [{
        class: 'JP_TRUST',
        label: 'legacy JP trust category',
        role: 'legacy authority discriminator',
        horizon: 'ultra_short',
        currentValue: legacy.categoryCurrentValue,
        currentRatio: 0.5,
        targetRatio: 0.4,
        targetValue: legacy.categoryTargetValue,
        diffValue: legacy.categoryDiffValue,
        diffRatio: legacy.categoryDiffRatio,
        score: 50,
        lastUpdatedAt: '2026-08-03T00:00:00.000Z',
      }],
      cash: legacy.cashDeposits,
      cashReserve: legacy.standbyFunds,
      lastUpdatedAt: '2026-08-03T00:00:00.000Z',
    },
  }
}

function renderProductionT2(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T2_JpFund />)
}

function renderedMetricCards(fullMarkup: string): RenderedMetricCard[] {
  const metricCardStart =
    /<div style="display:flex;flex-direction:column;gap:[^"]+"><p style="[^"]+">([^<]*)<\/p><p style="[^"]+">([^<]*)<\/p><div style="display:flex;align-items:baseline;gap:[^"]+">/g
  return [...fullMarkup.matchAll(metricCardStart)].map(([, label, value]) => ({ label, value }))
}

function allocationMonetaryCards(fullMarkup: string): RenderedMetricCard[] {
  return renderedMetricCards(fullMarkup).filter(({ value }) => RENDERED_YEN_AMOUNT.test(value))
}

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

function expectedUnavailableYenMultiset(legacy: LegacyMonetaryFixture): string[] {
  return [
    // Holding-row owner: Trust.eval -> formatJPYAuto at T2_JpFund.tsx:891.
    formatJPYAuto(legacy.legacyFundTotal),
    // Market-context owner: FlowData.foreignNet -> toFixed(0) + 億円 at T2_JpFund.tsx:105-109.
    `${NON_ALLOCATION_FOREIGN_FLOW.toFixed(0)}億円`,
  ].sort()
}

function expectedAvailableYenMultiset(classPlan: AssetClassPlan): string[] {
  return [
    formatJPYAuto(classPlan.currentAmount),
    formatJPYAuto(classPlan.targetAmount),
    formatJPYAuto(classPlan.targetGap),
    formatJPYAuto(classPlan.overweightAmount),
    formatJPYAuto(classPlan.allocatedAmount),
    formatJPYAuto(classPlan.remainingHeadroom),
    formatJPYAuto(classPlan.effectiveHeadroom),
    formatJPYAuto(classPlan.availableBudget),
    formatJPYAuto(LEGACY_FUND_EVAL),
    `${NON_ALLOCATION_FOREIGN_FLOW.toFixed(0)}億円`,
  ].sort()
}

function sortedCardMultiset(cards: readonly RenderedMetricCard[]): string[] {
  return cards.map(({ label, value }) => `${label}\u0000${value}`).sort()
}

function allocationAvailabilityMarkup(fullMarkup: string): string {
  const availabilityIndex = fullMarkup.indexOf('data-allocation-availability=')
  const allocationStart = fullMarkup.lastIndexOf('<div', availabilityIndex)
  if (availabilityIndex < 0 || allocationStart < 0) {
    throw new Error('actual T2 allocation availability element was not found')
  }

  const divTags = /<\/?div\b[^>]*>/g
  divTags.lastIndex = allocationStart
  let depth = 0
  for (const match of fullMarkup.matchAll(divTags)) {
    depth += match[0].startsWith('</div') ? -1 : 1
    if (depth === 0) return fullMarkup.slice(allocationStart, match.index + match[0].length)
  }
  throw new Error('actual T2 allocation availability element was not balanced')
}

function unavailableAllocationLabelHits(fullMarkup: string): string[] {
  return UNAVAILABLE_ALLOCATION_MONETARY_LABELS.filter(label => fullMarkup.includes(label))
}

function expectUnavailableAllocationFullRender(
  fullMarkup: string,
  expectedYenMultiset: readonly string[],
): void {
  expect(fullMarkup).toContain('data-allocation-availability="unavailable"')
  expect(extractRenderedYenMultiset(fullMarkup)).toEqual([...expectedYenMultiset].sort())
  for (const label of UNAVAILABLE_ALLOCATION_MONETARY_LABELS) {
    expect(fullMarkup).not.toContain(label)
  }
  expect(allocationMonetaryCards(fullMarkup)).toEqual([])
}

interface RelocationCase {
  readonly position: string
  readonly embed: (markup: string, forbiddenBlock: string) => string
}

const RELOCATION_CASES: readonly RelocationCase[] = [
  {
    position: 'A: allocation availability marker直後',
    embed: (markup, block) => markup.replace(
      '<div data-allocation-availability="unavailable">',
      `<div data-allocation-availability="unavailable">${block}`,
    ),
  },
  {
    position: 'B: KPI grid後',
    embed: (markup, block) => markup.replace(
      '<span data-kpi-grid-end="true"></span>',
      `<span data-kpi-grid-end="true"></span>${block}`,
    ),
  },
  {
    position: 'C: allocation panel前',
    embed: (markup, block) => markup.replace(
      '<section data-allocation-panel="true">',
      `${block}<section data-allocation-panel="true">`,
    ),
  },
  {
    position: 'D: root末尾',
    embed: (markup, block) => markup.replace('</main>', `${block}</main>`),
  },
]

describe('R3-b-R3 full-render allocation monetary helpers', () => {
  it.each(RELOCATION_CASES)('detects a forbidden card at $position', ({ embed }) => {
    const syntheticFullMarkup = [
      '<main>',
      '<div data-allocation-availability="unavailable"><p>配分プランは未計算です</p></div>',
      '<section data-kpi-grid="true"><p>平均スコア</p></section>',
      '<span data-kpi-grid-end="true"></span>',
      '<section data-allocation-panel="true"></section>',
      '</main>',
    ].join('')
    const forbiddenBlock = renderToStaticMarkup(
      <MetricCard title="目標差分（参考）" value="7.4万円" />,
    )
    const relocatedMarkup = embed(syntheticFullMarkup, forbiddenBlock)

    expect(sortedCardMultiset(allocationMonetaryCards(relocatedMarkup))).toEqual([
      '目標差分（参考）\u00007.4万円',
    ])
    expect(unavailableAllocationLabelHits(relocatedMarkup)).toEqual(['目標差分（参考）'])
  })
})

function syntheticFullMarkup(): string {
  return [
    '<main>',
    '<div data-allocation-availability="unavailable"><p>配分プランは未計算です</p></div>',
    '<section data-kpi-grid="true"><p>平均スコア</p></section>',
    '<span data-kpi-grid-end="true"></span>',
    '<section data-allocation-panel="true"></section>',
    '</main>',
  ].join('')
}

const YEN_MARKUP_FORMATS = [
  { format: 'A: div / p', markup: '<div><p>配分参考値</p><p>16.0万円</p></div>' },
  { format: 'B: span', markup: '<span>16.0万円</span>' },
  {
    format: 'C: unknown label / section / strong / em',
    markup: '<section><strong>未知ラベル</strong><em>16.0万円</em></section>',
  },
  {
    format: 'D: MetricCard',
    markup: renderToStaticMarkup(<MetricCard title="配分参考値" value="16.0万円" />),
  },
] as const

describe('R3-b-R4 full-render yen-token multiset helpers', () => {
  it('covers the complete formatJPYAuto and existing T2 yen output space', () => {
    const supportedAmounts = [
      '0円',
      '1,234円',
      '1.2万円',
      '16.0万円',
      '123万円',
      '1,234.5万円',
      '1億円',
      '1.2億円',
      '-16.0万円',
      '16.0万円',
    ]
    const markup = `<main><p>${supportedAmounts.join('</p><div></div><p>')}</p><span>&#49;,234円</span></main>`

    expect(extractRenderedYenMultiset(markup)).toEqual([
      ...supportedAmounts,
      '1,234円',
    ].sort())
    expect(extractRenderedYenMultiset(markup).filter(amount => amount === '16.0万円')).toHaveLength(2)
  })

  it.each(YEN_MARKUP_FORMATS)('detects the same yen token in format $format at every full-render position', ({ markup }) => {
    for (const { embed } of RELOCATION_CASES) {
      expect(extractRenderedYenMultiset(embed(syntheticFullMarkup(), markup))).toEqual(['16.0万円'])
    }
  })
})

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
    const classPlan = jpTrustPlan()
    const html = renderProductionT2(productionWiringState({ plan: allocationPlan(classPlan) }))

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
    ]) {
      expect(html).not.toContain(formatJPYAuto(legacyAmount))
    }

    expect(extractRenderedYenMultiset(html)).toEqual(expectedAvailableYenMultiset(classPlan))
    expect(sortedCardMultiset(allocationMonetaryCards(html))).toEqual(sortedCardMultiset([
      { label: 'クラス評価額', value: formatJPYAuto(classPlan.currentAmount) },
      { label: '目標額', value: formatJPYAuto(classPlan.targetAmount) },
      { label: '目標差分（不足）', value: formatJPYAuto(classPlan.targetGap) },
      { label: '目標超過', value: formatJPYAuto(classPlan.overweightAmount) },
      { label: '配分済額', value: formatJPYAuto(classPlan.allocatedAmount) },
      { label: '割当後の残余', value: formatJPYAuto(classPlan.remainingHeadroom) },
      { label: 'クラスheadroom', value: formatJPYAuto(classPlan.effectiveHeadroom) },
      { label: '利用可能予算', value: formatJPYAuto(classPlan.availableBudget) },
    ]))
  })


  it('keeps unavailable shared authority fail-closed across the actual full tab render', () => {
    const fullMarkup = renderProductionT2(productionWiringState({
      plan: null,
      status: 'absent',
      legacy: UNAVAILABLE_LEGACY_VARIANTS[0],
    }))
    const availabilityMarkup = allocationAvailabilityMarkup(fullMarkup)

    expectUnavailableAllocationFullRender(
      fullMarkup,
      expectedUnavailableYenMultiset(UNAVAILABLE_LEGACY_VARIANTS[0]),
    )
    expect(availabilityMarkup).toContain('data-allocation-status="absent"')
    expect(availabilityMarkup).toContain('配分プランは未計算です')
    expect(fullMarkup).not.toContain('data-snapshot-id=')
  })

  it('keeps the exact full-render yen multiset and availability subtree invariant across legacy inputs', () => {
    const fullRenders = UNAVAILABLE_LEGACY_VARIANTS.map(legacy =>
      renderProductionT2(productionWiringState({
        plan: null,
        status: 'absent',
        legacy,
      })),
    )
    const availabilityRenders = fullRenders.map(allocationAvailabilityMarkup)
    const monetaryCardMultisets = fullRenders.map(fullMarkup =>
      sortedCardMultiset(allocationMonetaryCards(fullMarkup)),
    )
    const yenMultisets = fullRenders.map(extractRenderedYenMultiset)

    expect(fullRenders).toHaveLength(3)
    for (const [index, fullMarkup] of fullRenders.entries()) {
      expectUnavailableAllocationFullRender(
        fullMarkup,
        expectedUnavailableYenMultiset(UNAVAILABLE_LEGACY_VARIANTS[index]),
      )
      expect(unavailableAllocationLabelHits(fullMarkup)).toEqual([])
      expect(fullMarkup).toContain(formatJPYAuto(UNAVAILABLE_LEGACY_VARIANTS[index].legacyFundTotal))
      expect(availabilityRenders[index]).toContain('data-allocation-status="absent"')
      expect(availabilityRenders[index]).toContain('配分プランは未計算です')
    }
    expect(new Set(UNAVAILABLE_LEGACY_VARIANTS.map(legacy => legacy.legacyTotalValue))).toHaveLength(3)
    expect(new Set(UNAVAILABLE_LEGACY_VARIANTS.map(legacy => legacy.categoryDiffValue))).toHaveLength(3)
    expect(monetaryCardMultisets[1]).toEqual(monetaryCardMultisets[0])
    expect(monetaryCardMultisets[2]).toEqual(monetaryCardMultisets[0])
    expect(availabilityRenders[1]).toBe(availabilityRenders[0])
    expect(availabilityRenders[2]).toBe(availabilityRenders[0])
    expect(yenMultisets[1]).toEqual(yenMultisets[0])
    expect(yenMultisets[2]).toEqual(yenMultisets[0])
  })

  it('removes current shared money after a stale transition without a legacy fallback', () => {
    const plan = allocationPlan()
    const currentHtml = renderProductionT2(productionWiringState({ plan }))
    const staleHtml = renderProductionT2(productionWiringState({
      plan,
      status: 'stale',
      legacy: UNAVAILABLE_LEGACY_VARIANTS[0],
    }))
    const staleAvailabilityMarkup = allocationAvailabilityMarkup(staleHtml)

    expect(currentHtml).toContain(formatJPYAuto(SHARED_TARGET_GAP))
    expectUnavailableAllocationFullRender(
      staleHtml,
      expectedUnavailableYenMultiset(UNAVAILABLE_LEGACY_VARIANTS[0]),
    )
    expect(staleAvailabilityMarkup).toContain('data-allocation-status="stale"')
    expect(staleAvailabilityMarkup).toContain('配分プランの再計算が必要です')
    expect(staleAvailabilityMarkup).not.toContain(formatJPYAuto(SHARED_TARGET_GAP))
  })

  it('keeps invalid shared authority unavailable when the legacy universe is populated', () => {
    const fullMarkup = renderProductionT2(productionWiringState({
      plan: allocationPlan(),
      status: 'invalid',
      legacy: UNAVAILABLE_LEGACY_VARIANTS[0],
    }))
    const availabilityMarkup = allocationAvailabilityMarkup(fullMarkup)

    expectUnavailableAllocationFullRender(
      fullMarkup,
      expectedUnavailableYenMultiset(UNAVAILABLE_LEGACY_VARIANTS[0]),
    )
    expect(availabilityMarkup).toContain('data-allocation-status="invalid"')
    expect(availabilityMarkup).toContain('配分プランを計算できません')
    expect(availabilityMarkup).not.toContain(formatJPYAuto(SHARED_TARGET_GAP))
  })

  it('distinguishes authoritative zero from unavailable in the actual full tab render', () => {
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
    const validZeroMarkup = renderProductionT2(productionWiringState({
      plan: allocationPlan(zeroClass, false),
    }))
    const unavailableMarkup = renderProductionT2(productionWiringState({
      plan: null,
      status: 'absent',
      legacy: UNAVAILABLE_LEGACY_VARIANTS[0],
    }))
    const zeroCards = allocationMonetaryCards(validZeroMarkup)
    const validZeroYenMultiset = extractRenderedYenMultiset(validZeroMarkup)
    const unavailableYenMultiset = extractRenderedYenMultiset(unavailableMarkup)

    expect(validZeroMarkup).toContain('data-allocation-availability="available"')
    expect(zeroCards).toHaveLength(ALLOCATION_MONETARY_LABELS.length)
    expect(zeroCards.map(({ label }) => label).sort()).toEqual([...ALLOCATION_MONETARY_LABELS].sort())
    expect(zeroCards.every(({ value }) => value === '0円')).toBe(true)
    expect(validZeroYenMultiset).toEqual(expectedAvailableYenMultiset(zeroClass))
    expect(validZeroYenMultiset.filter(amount => amount === '0円')).toHaveLength(8)
    expect(validZeroMarkup).toContain('0件')
    expectUnavailableAllocationFullRender(
      unavailableMarkup,
      expectedUnavailableYenMultiset(UNAVAILABLE_LEGACY_VARIANTS[0]),
    )
    expect(unavailableYenMultiset).toEqual(expectedUnavailableYenMultiset(UNAVAILABLE_LEGACY_VARIANTS[0]))
    expect(unavailableMarkup).not.toContain('0円')
    expect(validZeroYenMultiset).not.toEqual(unavailableYenMultiset)
    expect(validZeroMarkup).not.toBe(unavailableMarkup)
  })
})
