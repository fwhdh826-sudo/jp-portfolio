import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatJPYAuto } from '../../utils/format'
import type {
  AllocationClassProjection,
  AllocationConsumerSnapshot,
} from '../../types/allocationConsumer'
import type { T2AllocationProjection } from '../../store/allocationConsumerSelectors'
import { T2AllocationPanel } from './T2_JpFund'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t2Source from './T2_JpFund.tsx?raw'

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
