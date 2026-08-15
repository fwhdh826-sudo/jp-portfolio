// ═══════════════════════════════════════════════════════════
// CAND-SYN-1C: frozen acceptance group S (DDR-R1 §11) plus engine invariant
// I-19. Every assertion here targets buildAllocationPlanSnapshot — the money
// and selection authority — not UI composition.
//
// The regression this group exists for: before 1C, rankCandidates ordered
// candidates by `marketRank ?? MAX_SAFE_INTEGER` across asset classes. Once
// DDR-1 makes JP_STOCK executable, a stock with marketRank=1 would take the
// single execution slot from a far more underweight JP_TRUST whose marketRank
// is structurally null. DDR-R1 §3 measured that exact inversion.
// ═══════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type AllocationPlanSnapshot,
  type CandidateInput,
  type InstrumentInput,
  type InstrumentPolicy,
} from '../../types/allocationPlan'
import { buildAllocationPlanSnapshot } from './allocationEngine'
import { assertAllocationPlanInvariants } from './invariants'
import { compareExecutionPriority } from './executionPriority'

// ── DDR-R1 §3 exact measured counterexample inputs ────────────────────────
const GROSS_CASH = 6_000_000
const SHORT_TERM_BUDGET = 3_000_000
const TARGET_RATIO = 0.3
const STOCK_PRICE_JPY = 1_000
const LOT_SIZE_SHARES = 100
/** ceil(1000 * 1.03 * 100) — the engine's own execution unit for the fixture. */
const STOCK_LOT_UNIT = 103_000

function policyFor(instrumentId: string, overrides: Partial<InstrumentPolicy> = {}): InstrumentPolicy {
  return {
    instrumentId,
    // null target -> no instrument TARGET_GAP term, so class need (not an
    // instrument-level cap) is what the fixture actually varies.
    targetAmountJpy: null,
    maxPositionAmountJpy: 9_000_000,
    sectorHeadroomJpy: 9_000_000,
    concentrationHeadroomJpy: 9_000_000,
    liquidityHeadroomJpy: 9_000_000,
    defaultMaxPositionShare: 0.25,
    defaultMaxSectorShare: 0.35,
    minimumPurchaseUnitJpy: 10_000,
    ...overrides,
  }
}

function stockInstrument(instrumentId: string, executable = true): InstrumentInput {
  return {
    instrumentId,
    assetClass: 'JP_STOCK',
    kind: 'jp_stock',
    relationship: 'new_to_portfolio',
    currentAmount: 0,
    role: null,
    reason: 'S-group fixture',
    priceJpy: executable ? STOCK_PRICE_JPY : null,
    lotSizeShares: executable ? LOT_SIZE_SHARES : null,
  }
}

function trustInstrument(instrumentId: string): InstrumentInput {
  return {
    instrumentId,
    assetClass: 'JP_TRUST',
    kind: 'jp_trust',
    relationship: 'new_to_portfolio',
    currentAmount: 0,
    role: 'JAPAN_SHORTTERM',
    reason: 'S-group fixture',
    priceJpy: null,
    lotSizeShares: null,
  }
}

function candidateFor(
  instrumentId: string,
  marketRank: number | null,
  artifactIndex: number,
): CandidateInput {
  return { instrumentId, buyKind: 'BUY_NEW', marketRank, artifactIndex, confidence: 1 }
}

interface ScenarioOptions {
  readonly stockCurrent: number
  readonly trustCurrent: number
  readonly instruments?: readonly InstrumentInput[]
  readonly candidates?: readonly CandidateInput[]
  readonly grossCash?: number
  readonly targetRatio?: number
}

function scenario(options: ScenarioOptions): AllocationPlanInput {
  const instruments = options.instruments ?? [stockInstrument('stock:A'), trustInstrument('trust:A')]
  const candidates = options.candidates ?? [
    candidateFor('stock:A', 1, 0),
    candidateFor('trust:A', null, 0),
  ]
  const grossCash = options.grossCash ?? GROSS_CASH
  const targetRatio = options.targetRatio ?? TARGET_RATIO
  return {
    generatedAt: '2026-08-15T00:00:00.000Z',
    snapshotId: 'allocation-plan:s-group',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-s-group',
    sourceSettingsVersion: 'settings-s-group',
    cash: {
      grossCash,
      safetyReserve: 0,
      pendingOrderCash: 0,
      dataUncertaintyReserve: 0,
    },
    budgets: { shortTermBudget: SHORT_TERM_BUDGET, longTermBudget: grossCash - SHORT_TERM_BUDGET },
    policy: {
      jpStockMaxRatio: targetRatio,
      jpStockMaxAmountJpy: null,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio, maximumRatio: null, maximumAmountJpy: null },
        { assetClass: 'JP_TRUST', targetRatio, maximumRatio: null, maximumAmountJpy: null },
      ],
      instrumentPolicies: instruments.map(item => policyFor(item.instrumentId)),
      roundingPolicies: [
        { kind: 'jp_stock', purchaseUnitJpy: 10_000 },
        { kind: 'jp_trust', purchaseUnitJpy: 10_000 },
        { kind: 'global_trust', purchaseUnitJpy: 10_000 },
        { kind: 'gold', purchaseUnitJpy: 10_000 },
      ],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 0.25,
      buyMoreBaseShare: 0.5,
      confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0.03,
    },
    assetClasses: [
      { assetClass: 'JP_STOCK', currentAmount: options.stockCurrent },
      { assetClass: 'JP_TRUST', currentAmount: options.trustCurrent },
    ],
    instruments,
    candidates,
    safetyState: {
      safeMode: 'inactive',
      marketData: 'fresh',
      holdings: 'fresh',
      cash: 'known_fresh',
      target: 'known',
      pendingOrders: 'known',
      candidateArtifact: 'fresh',
      dqViolation: false,
      tierA: 'normal',
      crossTab: 'current',
      noTrade: 'normal',
    },
    regime: 'neutral',
    marketMode: 'normal',
  }
}

function winnerOf(snapshot: AllocationPlanSnapshot): string | null {
  const executable = snapshot.instrumentPlans.filter(plan => plan.executable)
  expect(executable.length).toBeLessThanOrEqual(1)
  return executable[0]?.instrumentId ?? null
}

function planFor(snapshot: AllocationPlanSnapshot, instrumentId: string) {
  const plan = snapshot.instrumentPlans.find(item => item.instrumentId === instrumentId)
  expect(plan).toBeDefined()
  return plan!
}

/** Every scenario in this file must also satisfy the full frozen invariant set. */
function build(input: AllocationPlanInput): AllocationPlanSnapshot {
  const snapshot = buildAllocationPlanSnapshot(input)
  expect(assertAllocationPlanInvariants(snapshot)).toEqual({ ok: true, violated: [] })
  return snapshot
}

describe('CAND-SYN-1C group S: canonical cross-class execution priority', () => {
  it('S1 greater JP_TRUST class need beats JP_STOCK despite the stock marketRank', () => {
    // JP_STOCK need 10% (gap 243,000 / target 2,430,000),
    // JP_TRUST need 60% (gap 1,458,000 / target 2,430,000).
    const snapshot = build(scenario({ stockCurrent: 2_187_000, trustCurrent: 972_000 }))
    expect(winnerOf(snapshot)).toBe('trust:A')
    expect(planFor(snapshot, 'trust:A').finalSuggestedAmount).toBeGreaterThan(0)
    expect(planFor(snapshot, 'stock:A').finalSuggestedAmount).toBe(0)
    // both were genuinely eligible: the stock lost on class need, not on gating
    expect(planFor(snapshot, 'stock:A').independentlyExecutable).toBe(true)
  })

  it('S2 greater JP_STOCK class need beats JP_TRUST (K2 follows real need, not a fixed namespace order)', () => {
    const snapshot = build(scenario({ stockCurrent: 972_000, trustCurrent: 2_187_000 }))
    expect(winnerOf(snapshot)).toBe('stock:A')
    expect(planFor(snapshot, 'stock:A').finalSuggestedAmount).toBeGreaterThan(0)
    expect(planFor(snapshot, 'trust:A').finalSuggestedAmount).toBe(0)
  })

  it('S3 strictly equal class need falls through to K3 namespace order', () => {
    const snapshot = build(scenario({ stockCurrent: 1_500_000, trustCurrent: 1_500_000 }))
    const stockClass = snapshot.assetClassPlans.find(plan => plan.assetClass === 'JP_STOCK')!
    const trustClass = snapshot.assetClassPlans.find(plan => plan.assetClass === 'JP_TRUST')!
    expect(stockClass.targetGap).toBe(trustClass.targetGap)
    expect(stockClass.targetAmount).toBe(trustClass.targetAmount)
    expect(winnerOf(snapshot)).toBe('stock:A') // jp_stock_funnel(0) < jp_trust_registry(1)
  })

  it('S4 an ineligible top-priority candidate does not consume the execution slot', () => {
    // The stock has the greater class need but no execution price authority,
    // so it is ineligible; the next candidate in priority order is selected.
    const snapshot = build(scenario({
      stockCurrent: 972_000,
      trustCurrent: 2_187_000,
      instruments: [stockInstrument('stock:A', false), trustInstrument('trust:A')],
    }))
    const stock = planFor(snapshot, 'stock:A')
    expect(stock.independentlyExecutable).toBe(false)
    expect(stock.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(winnerOf(snapshot)).toBe('trust:A')
    expect(snapshot.instrumentPlans.filter(plan => plan.executable)).toHaveLength(1)
  })

  it('S5 marketRank alone cannot decide a cross-class winner, and null is not "last"', () => {
    const snapshot = build(scenario({ stockCurrent: 2_187_000, trustCurrent: 972_000 }))
    const stockCandidate = snapshot.instrumentPlans.find(plan => plan.instrumentId === 'stock:A')!
    const trustCandidate = snapshot.instrumentPlans.find(plan => plan.instrumentId === 'trust:A')!
    expect(stockCandidate.marketRank).toBe(1)
    expect(trustCandidate.marketRank).toBeNull() // structurally null, never MAX_SAFE_INTEGER
    expect(winnerOf(snapshot)).toBe('trust:A')
  })

  it('S6 marketRank still orders stock against stock inside the JP_STOCK namespace', () => {
    const snapshot = build(scenario({
      stockCurrent: 972_000,
      trustCurrent: 2_187_000,
      instruments: [
        stockInstrument('stock:B'),
        stockInstrument('stock:A'),
        trustInstrument('trust:A'),
      ],
      candidates: [
        candidateFor('stock:B', 2, 0),
        candidateFor('stock:A', 1, 1),
        candidateFor('trust:A', null, 0),
      ],
    }))
    expect(winnerOf(snapshot)).toBe('stock:A') // marketRank 1 beats 2 within the namespace
    expect(snapshot.instrumentPlans.map(plan => plan.instrumentId))
      .toEqual(['stock:A', 'stock:B', 'trust:A'])
  })

  it('S7 several JP_TRUST candidates resolve deterministically on K5 then K6', () => {
    const snapshot = build(scenario({
      stockCurrent: 2_430_000,
      trustCurrent: 972_000,
      instruments: [trustInstrument('trust:Z'), trustInstrument('trust:A')],
      candidates: [candidateFor('trust:Z', null, 0), candidateFor('trust:A', null, 0)],
    }))
    // identical artifactIndex -> K6 instrumentId lexical order decides
    expect(snapshot.instrumentPlans.map(plan => plan.instrumentId)).toEqual(['trust:A', 'trust:Z'])
    expect(winnerOf(snapshot)).toBe('trust:A')

    const byArtifactIndex = build(scenario({
      stockCurrent: 2_430_000,
      trustCurrent: 972_000,
      instruments: [trustInstrument('trust:Z'), trustInstrument('trust:A')],
      candidates: [candidateFor('trust:Z', null, 0), candidateFor('trust:A', null, 1)],
    }))
    expect(byArtifactIndex.instrumentPlans.map(plan => plan.instrumentId)).toEqual(['trust:Z', 'trust:A'])
    expect(winnerOf(byArtifactIndex)).toBe('trust:Z')
  })

  it('S8 selection and amounts are bit-identical across repeats and input permutations', () => {
    const instruments = [stockInstrument('stock:A'), trustInstrument('trust:A')]
    const candidates = [candidateFor('stock:A', 1, 0), candidateFor('trust:A', null, 0)]
    const reference = JSON.stringify(build(scenario({
      stockCurrent: 2_187_000, trustCurrent: 972_000, instruments, candidates,
    })))
    for (const permutation of [
      { instruments, candidates: [...candidates].reverse() },
      { instruments: [...instruments].reverse(), candidates },
      { instruments: [...instruments].reverse(), candidates: [...candidates].reverse() },
    ]) {
      const snapshot = build(scenario({
        stockCurrent: 2_187_000,
        trustCurrent: 972_000,
        instruments: permutation.instruments,
        candidates: permutation.candidates,
      }))
      expect(winnerOf(snapshot)).toBe('trust:A')
      const normalized = {
        ...snapshot,
        instrumentPlans: [...snapshot.instrumentPlans]
          .sort((left, right) => left.instrumentId < right.instrumentId ? -1 : 1),
      }
      const referenceSnapshot = JSON.parse(reference) as AllocationPlanSnapshot
      expect(normalized.instrumentPlans).toEqual(
        [...referenceSnapshot.instrumentPlans]
          .sort((left, right) => left.instrumentId < right.instrumentId ? -1 : 1),
      )
    }
  })

  it('S8b class-need comparison stays integer-exact where Number arithmetic cannot', () => {
    // Both classes hold safe-integer JPY, but their cross products land near
    // 3.2e17 where a double's spacing is 64 — the two products differ by
    // exactly 1 and collapse onto the same double. Float division is equally
    // blind. Only the BigInt cross product preserves the strict ordering.
    const gapA = 400_000_001
    const amountA = 800_000_003
    const gapB = 400_000_000
    const amountB = 800_000_001
    expect(gapA * amountB === gapB * amountA).toBe(true)      // Number: indistinguishable
    expect(gapA / amountA === gapB / amountB).toBe(true)      // float ratio: indistinguishable
    expect(BigInt(gapA) * BigInt(amountB)).toBeGreaterThan(BigInt(gapB) * BigInt(amountA))

    const need = (targetGap: number, targetAmount: number) => ({ targetGap, targetAmount, blockedReasons: [] })
    // The greater-need class is JP_TRUST, whose marketRank is null and whose
    // namespace sorts last: only K2 can put it first.
    expect(compareExecutionPriority(
      { instrumentId: 'trust:A', buyKind: 'BUY_NEW', assetClass: 'JP_TRUST', marketRank: null, artifactIndex: 0, classNeed: need(gapA, amountA) },
      { instrumentId: 'stock:A', buyKind: 'BUY_NEW', assetClass: 'JP_STOCK', marketRank: 1, artifactIndex: 0, classNeed: need(gapB, amountB) },
    )).toBeLessThan(0)
  })

  it('S9 targetGap = 0 stays a valid tier 0, after positive need but before invalid authority', () => {
    const funded = { targetGap: 0, targetAmount: 2_430_000, blockedReasons: [] as const }
    const positive = { targetGap: 1, targetAmount: 2_430_000, blockedReasons: [] as const }
    const missing = { targetGap: 0, targetAmount: 0, blockedReasons: ['CLASS_TARGET_MISSING'] as const }
    const at = (id: string, classNeed: typeof funded | typeof missing) => ({
      instrumentId: id, buyKind: 'BUY_NEW' as const, assetClass: 'JP_TRUST' as const,
      marketRank: null, artifactIndex: 0, classNeed,
    })
    expect(compareExecutionPriority(at('a', positive), at('b', funded))).toBeLessThan(0)
    expect(compareExecutionPriority(at('a', funded), at('b', missing))).toBeLessThan(0)
  })

  it('S10 a DDR-1-priced JP_STOCK never overrides a more underweight JP_TRUST class', () => {
    // DDR-R1 §3 exact measured counterexample:
    //   JP_STOCK gap 430,000 / target 2,430,000 = 17.70% need
    //   JP_TRUST gap 2,330,000 / target 2,430,000 = 95.88% need
    // Case A (old marketRank ordering) awarded stock:A ¥103,000.
    // Case B (class-need ordering) awards trust:A ¥580,000. 1C must be case B.
    const snapshot = build(scenario({ stockCurrent: 2_000_000, trustCurrent: 100_000 }))
    const stockClass = snapshot.assetClassPlans.find(plan => plan.assetClass === 'JP_STOCK')!
    const trustClass = snapshot.assetClassPlans.find(plan => plan.assetClass === 'JP_TRUST')!
    expect(snapshot.totalAssets).toBe(8_100_000)
    expect(snapshot.deployableCash).toBe(6_000_000)
    expect(stockClass.targetAmount).toBe(2_430_000)
    expect(stockClass.targetGap).toBe(430_000)
    expect(trustClass.targetGap).toBe(2_330_000)

    expect(winnerOf(snapshot)).toBe('trust:A')
    expect(planFor(snapshot, 'trust:A').finalSuggestedAmount).toBe(580_000)
    const stock = planFor(snapshot, 'stock:A')
    expect(stock.finalSuggestedAmount).toBe(0)
    expect(stock.executable).toBe(false)
    expect(stock.warningReasons).toContain('NOT_SELECTED_FOR_EXECUTION')
    // The stock was independently able to buy exactly one lot — it lost the slot
    // on allocation need, which is the whole point of the correction.
    expect(stock.independentlyExecutable).toBe(true)
    expect(stock.simultaneouslyExecutableAmount).toBe(STOCK_LOT_UNIT)
  })

  it('M9 the inverse need case gives the slot back to the stock', () => {
    const snapshot = build(scenario({ stockCurrent: 100_000, trustCurrent: 2_000_000 }))
    expect(winnerOf(snapshot)).toBe('stock:A')
    expect(planFor(snapshot, 'stock:A').finalSuggestedAmount).toBeGreaterThan(0)
    expect(planFor(snapshot, 'trust:A').finalSuggestedAmount).toBe(0)
  })

  it('reordering changes only who holds the slot, never allocatedAmount (DDR-R1 §8)', () => {
    const snapshot = build(scenario({ stockCurrent: 2_000_000, trustCurrent: 100_000 }))
    expect(planFor(snapshot, 'trust:A').allocatedAmount).toBe(580_000)
    expect(planFor(snapshot, 'stock:A').allocatedAmount).toBe(STOCK_LOT_UNIT)
    expect(snapshot.remainingUnallocatedCash).toBe(6_000_000 - 580_000 - STOCK_LOT_UNIT)
  })
})

describe('CAND-SYN-1C I-19: canonical winner identity', () => {
  it('holds for every group-S scenario (asserted inside build())', () => {
    expect(assertAllocationPlanInvariants(
      buildAllocationPlanSnapshot(scenario({ stockCurrent: 2_000_000, trustCurrent: 100_000 })),
    ).violated).not.toContain('I-19')
  })

  it('reports no executable plan when nothing is eligible', () => {
    // c = 0.3 * (2c + 6,000,000) -> c = 4,500,000: both classes sit exactly on
    // target, so targetGap is 0 and no candidate can be independently executable.
    const snapshot = build(scenario({ stockCurrent: 4_500_000, trustCurrent: 4_500_000 }))
    expect(snapshot.instrumentPlans.every(plan => !plan.independentlyExecutable)).toBe(true)
    expect(winnerOf(snapshot)).toBeNull()
  })

  it('detects a winner that is not the minimum of the eligible set', () => {
    // Hand-mutate a valid snapshot so the lower-priority candidate holds the
    // slot. I-12 (<=1 executable) still passes; only I-19 catches this.
    const snapshot = build(scenario({ stockCurrent: 2_000_000, trustCurrent: 100_000 }))
    const mutated: AllocationPlanSnapshot = {
      ...snapshot,
      instrumentPlans: snapshot.instrumentPlans.map(plan => ({
        ...plan,
        executable: plan.instrumentId === 'stock:A',
        finalSuggestedAmount: plan.instrumentId === 'stock:A' ? STOCK_LOT_UNIT : 0,
      })),
    }
    const result = assertAllocationPlanInvariants(mutated)
    expect(result.violated).toContain('I-19')
    expect(result.violated).not.toContain('I-12')
  })
})
