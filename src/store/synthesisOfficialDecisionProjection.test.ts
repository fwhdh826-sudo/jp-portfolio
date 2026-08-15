// ═══════════════════════════════════════════════════════════
// CAND-SYN-1C group N (parallel BUY writer absence) + Q9/Q12 + the synthesis
// side of the execution authority (S9 / I-SYN-EXEC-1 / M10).
//
// The frozen completion condition for 1C is: exactly one writer puts candidate
// items into officialDecision.actions, that writer carries no yen at all, and
// the one instrument that may carry an executable amount is the same one the
// canonical AllocationPlan selected.
// ═══════════════════════════════════════════════════════════
// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CandidateItem } from '../domain/candidates'
import { buildCandidateDecisionSynthesis } from '../domain/candidates/candidateDecisionSynthesis'
import type {
  CandidateDecisionSynthesisCandidateInput,
  CandidateDecisionSynthesisInput,
  CandidateDecisionSynthesisSnapshot,
} from '../types/candidateDecisionSynthesis'
import type { OfficialDecision } from '../types'
import { candidateToOfficialDecisionItem } from './useAppStore'
import { projectSynthesisToOfficialDecision } from './synthesisOfficialDecisionProjection'

const storeSource = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')
const projectionSource = readFileSync(
  new URL('./synthesisOfficialDecisionProjection.ts', import.meta.url),
  'utf8',
)

const GENERATED_AT = '2026-08-15T01:00:00.000Z'
const ALLOCATION_ID = 'allocation-plan:1c'
const CANDIDATE_GENERATION = '2026-08-14T22:14:38.374259+00:00'

function provenance(): CandidateDecisionSynthesisInput['provenance'] {
  return {
    candidateGenerationId: CANDIDATE_GENERATION,
    candidatePublicationState: 'published_pass',
    candidateFreshness: 'fresh',
    allocationSnapshotId: ALLOCATION_ID,
    allocationSnapshotGeneratedAt: GENERATED_AT,
    allocationSnapshotStatus: 'current',
    sourceHoldingsSnapshotId: 'holdings-1c',
    sourceSettingsVersion: 'settings-1c',
    cashAuthorityUpdatedAt: GENERATED_AT,
    marketDataAsOf: GENERATED_AT,
    portfolioFitEvaluatedAt: GENERATED_AT,
    candidatesStocksUpdatedAt: GENERATED_AT,
    candidatesStocksSourceUpdatedAt: GENERATED_AT,
    candidatesStocksRunToken: 'run-token-1c',
  }
}

function stockCandidate(options: {
  code: string
  executable: boolean
  amount: number
  targetGap?: number
}): CandidateDecisionSynthesisCandidateInput {
  const targetGap = options.targetGap ?? 1_000_000
  return {
    instrumentId: `stock:${options.code}`,
    assetClass: 'JP_STOCK',
    namespace: 'jp_stock_funnel',
    displayName: `テスト銘柄${options.code}`,
    code: options.code,
    artifactIndex: 0,
    candidateQuality: {
      source: 'candidate_funnel',
      marketRank: 1,
      marketScore: 75,
      tier: 'actionable',
      dataConfidence: 1,
      selectedReasons: [],
      riskReasons: [],
    },
    portfolioFit: {
      status: 'evaluated',
      relationship: 'new_to_portfolio',
      reasons: [],
      risks: [],
      hardGatePassed: true,
    },
    canonicalAllocation: {
      relationship: 'new_to_portfolio',
      executable: options.executable,
      finalSuggestedAmount: options.amount,
      calculationSnapshotId: ALLOCATION_ID,
      classNeed: { targetGap, targetAmount: 2_430_000, blockedReasons: [] },
      allocationRole: {
        assetClassTargetGap: targetGap,
        assetClassTargetRatio: 0.3,
        classHeadroom: 2_000_000,
        instrumentHeadroom: 2_000_000,
      },
      blockedReasons: [],
      warnings: [],
      limitingFactors: [],
    },
    whyThis: [],
    whyNotExecutable: [],
    usesCandidatesStocksExecutionPrice: true,
  }
}

function synthesis(
  candidates: readonly CandidateDecisionSynthesisCandidateInput[],
  canonicalExecution?: CandidateDecisionSynthesisInput['canonicalExecution'],
): CandidateDecisionSynthesisSnapshot {
  const winner = candidates.find(item => item.canonicalAllocation.executable) ?? null
  return buildCandidateDecisionSynthesis({
    generatedAt: GENERATED_AT,
    provenance: provenance(),
    allocationPlanCandidateGenerationId: CANDIDATE_GENERATION,
    canonicalExecution: canonicalExecution ?? {
      instrumentId: winner?.instrumentId ?? null,
      executableAmountJpy: winner?.canonicalAllocation.finalSuggestedAmount ?? 0,
    },
    candidates,
    datasetReasons: [],
  })
}

function baseDecision(): OfficialDecision {
  return {
    generatedAt: GENERATED_AT,
    source: 'committee',
    headline: 'test',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions: [
      { id: 'holding-1', assetType: 'stock', name: '保有銘柄', action: 'HOLD', reason: '既存判断', source: 'committee' },
    ],
    risks: [],
    rationale: [],
  }
}

function legacyCandidateItem(overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: 'gold_candidate',
    name: '金インデックスファンド',
    assetType: 'gold',
    action: 'BUY_NEW',
    score: 80,
    sizingTier: 'full',
    suggestedAmount: 250_000,
    maxAmount: 500_000,
    blockedReasons: [],
    constraints: {} as CandidateItem['constraints'],
    signals: {} as CandidateItem['signals'],
    reason: 'legacy reason',
    source: 'trust_master',
    ...overrides,
  }
}

describe('CAND-SYN-1C group N: exactly one officialDecision candidate writer', () => {
  it('N1/N3 the funnel append and the L1 legacy append are both gone from the store', () => {
    expect(storeSource).not.toContain('appendCandidatePortfolioRecommendations(')
    expect(storeSource).not.toContain('.map(candidateToOfficialDecisionItem)')
    // exactly one call site writes the candidate component
    const writes = storeSource.match(/projectSynthesisToOfficialDecision\(/g) ?? []
    expect(writes).toHaveLength(1)
  })

  it('N2 candidateToOfficialDecisionItem sets no monetary field', () => {
    const item = candidateToOfficialDecisionItem(legacyCandidateItem())
    expect(item.amount).toBeUndefined()
    expect(item.suggestedAmount).toBeUndefined()
    expect(item.maxAmount).toBeUndefined()
    expect(item.candidateSizingTier).toBeUndefined()
  })

  it('N4 the projection itself contains no yen field and no arithmetic', () => {
    expect(projectionSource).not.toMatch(/\bamount:|suggestedAmount:|maxAmount:|candidateSizingTier:/)
    expect(projectionSource).not.toMatch(/[*/]\s*(cash|score|confidence|price)/i)
    const item = projectSynthesisToOfficialDecision(
      baseDecision(),
      synthesis([stockCandidate({ code: '1003', executable: true, amount: 580_000 })]),
    )!.actions.find(action => action.isCandidate)
    expect(item).toBeDefined()
    expect(Object.keys(item!)).not.toContain('amount')
    expect(Object.keys(item!)).not.toContain('suggestedAmount')
    expect(Object.keys(item!)).not.toContain('maxAmount')
  })

  it('maps the frozen action vocabulary and preserves instrument identity', () => {
    const projected = projectSynthesisToOfficialDecision(
      baseDecision(),
      synthesis([stockCandidate({ code: '1003', executable: true, amount: 580_000 })]),
    )!
    const item = projected.actions.find(action => action.isCandidate)!
    expect(item).toMatchObject({
      assetType: 'stock',
      code: '1003',
      action: 'BUY_NEW',
      source: 'candidate',
      isCandidate: true,
      candidateSource: 'candidate_funnel',
    })
    expect(item.reason.length).toBeGreaterThan(0)
    // existing holding decisions are untouched (D2)
    expect(projected.actions[0]).toMatchObject({ id: 'holding-1', action: 'HOLD' })
  })

  it('appends nothing when there is no authorized synthesis generation', () => {
    expect(projectSynthesisToOfficialDecision(baseDecision(), null)).toEqual(baseDecision())
    const invalid = synthesis(
      [stockCandidate({ code: '1003', executable: true, amount: 580_000 })],
      { instrumentId: 'trust:other', executableAmountJpy: 1 },
    )
    expect(invalid.status).toBe('invalid')
    expect(projectSynthesisToOfficialDecision(baseDecision(), invalid)).toEqual(baseDecision())
  })

  it('Q12 officialDecision carries no candidate money — the canonical amount stays in the plan', () => {
    const snapshot = synthesis([stockCandidate({ code: '1003', executable: true, amount: 580_000 })])
    expect(snapshot.decisions[0].money).toMatchObject({
      kind: 'EXECUTABLE',
      executableAmountJpy: 580_000,
      calculationSnapshotId: ALLOCATION_ID,
    })
    const projected = projectSynthesisToOfficialDecision(baseDecision(), snapshot)!
    for (const action of projected.actions.filter(item => item.isCandidate)) {
      expect(action.amount ?? 0).toBe(0)
      expect(action.suggestedAmount ?? 0).toBe(0)
      expect(action.maxAmount ?? 0).toBe(0)
    }
  })

  it('Q9 a positive legacy maxAmount never reaches the synthesis executable amount', () => {
    const legacy = legacyCandidateItem({ maxAmount: 999_999, suggestedAmount: 888_888 })
    expect(legacy.maxAmount).toBeGreaterThan(0)
    const snapshot = synthesis([stockCandidate({ code: '1003', executable: true, amount: 580_000 })])
    // bit-identical to the canonical engine value, not to any legacy figure
    expect(snapshot.decisions[0].money.executableAmountJpy).toBe(580_000)
    const item = candidateToOfficialDecisionItem(legacy)
    expect(item.maxAmount).toBeUndefined()
  })
})

describe('CAND-SYN-1C S9 / I-SYN-EXEC-1: synthesis agrees with the canonical winner', () => {
  it('M10 the canonical winner is reproduced identically through synthesis', () => {
    const snapshot = synthesis([
      stockCandidate({ code: '1003', executable: true, amount: 580_000 }),
      stockCandidate({ code: '1002', executable: false, amount: 0 }),
    ])
    expect(snapshot.status).toBe('available')
    const executable = snapshot.decisions.filter(entry => entry.money.kind === 'EXECUTABLE')
    expect(executable).toHaveLength(1)
    expect(executable[0].instrumentId).toBe('stock:1003')
    expect(executable[0].money.executableAmountJpy).toBe(580_000)
  })

  it('invalidates the whole snapshot when the executable entry is not the canonical winner', () => {
    const mismatched = synthesis(
      [stockCandidate({ code: '1003', executable: true, amount: 580_000 })],
      { instrumentId: 'trust:jp-short-a', executableAmountJpy: 580_000 },
    )
    expect(mismatched.status).toBe('invalid')
    expect(mismatched.datasetReasons).toContain('EXECUTION_AUTHORITY_MISMATCH')
    expect(mismatched.decisions).toEqual([])
    expect(mismatched.watchList).toEqual([])
  })

  it('invalidates when the amount disagrees with the canonical plan by even 1 yen', () => {
    const mismatched = synthesis(
      [stockCandidate({ code: '1003', executable: true, amount: 580_000 })],
      { instrumentId: 'stock:1003', executableAmountJpy: 579_999 },
    )
    expect(mismatched.status).toBe('invalid')
    expect(mismatched.datasetReasons).toContain('EXECUTION_AUTHORITY_MISMATCH')
  })

  it('invalidates when the canonical authority says no instrument is executable', () => {
    const mismatched = synthesis(
      [stockCandidate({ code: '1003', executable: true, amount: 580_000 })],
      { instrumentId: null, executableAmountJpy: 0 },
    )
    expect(mismatched.status).toBe('invalid')
    expect(mismatched.datasetReasons).toContain('EXECUTION_AUTHORITY_MISMATCH')
  })

  it('allows synthesis to demote the canonical winner, but never to promote another', () => {
    // portfolioFit hard gate fails -> WATCH, no executable entry at all. The
    // canonical winner still exists; demotion is legal (D7 layer 15).
    const demoted = stockCandidate({ code: '1003', executable: true, amount: 580_000 })
    const snapshot = synthesis([
      { ...demoted, portfolioFit: { ...demoted.portfolioFit, hardGatePassed: false } },
    ], { instrumentId: 'stock:1003', executableAmountJpy: 580_000 })
    expect(snapshot.status).toBe('available')
    expect(snapshot.decisions).toEqual([])
    expect(snapshot.watchList[0]).toMatchObject({ action: 'WATCH' })
    expect(snapshot.watchList[0].money).toMatchObject({ kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 })
  })
})
