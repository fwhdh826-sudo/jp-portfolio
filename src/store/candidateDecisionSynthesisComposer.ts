// ═══════════════════════════════════════════════════════════
// CAND-SYN-1B: store-layer input assembly for the frozen 1A pure composer
// (buildCandidateDecisionSynthesis). This module supplies normalized
// authoritative inputs only — it does not recompute money, ranking,
// action, or invariants (D16/1A owns all of that).
//
// Canonical money source: AllocationPlanSnapshot.instrumentPlans[]
// (verbatim). Instruments without a matching instrumentPlan are dropped
// individually with MISSING_INSTRUMENT_MAPPING recorded — the frozen
// fail-closed answer (design-audit §29) for candidates the canonical
// engine was never asked to price, which in 1B is every population-A
// (held JP_STOCK) instrument: 1B does not feed holding candidates into
// the engine (that activation is out of 1B scope — DDR-1 §7.3), so
// population A is represented but always dropped here until a later
// tranche wires it into AllocationPlanInput.candidates.
// ═══════════════════════════════════════════════════════════
import type { AppState } from '../types'
import type { AllocationPlanSnapshotState } from '../types'
import type {
  AllocationPlanSnapshot,
  AssetClassPlan,
  InstrumentPlan,
} from '../types/allocationPlan'
import type { CandidatePortfolioFitResult } from '../types/candidatePortfolioFit'
import type { CandidateFunnelFreshness } from '../services/candidateFunnelFreshness'
import type {
  CandidateDecisionSynthesisCandidateInput,
  CandidateDecisionSynthesisProvenance,
  CandidateDecisionSynthesisSnapshot,
  CandidateSynthesisCanonicalAllocation,
  SynthesisDatasetReason,
  SynthesisReasonCode,
} from '../types/candidateDecisionSynthesis'
import {
  buildCandidateDecisionSynthesis,
  buildHoldingAllocationCandidates,
} from '../domain/candidates/candidateDecisionSynthesis'
import {
  buildCandidateAllocationInputs,
  candidateAllocationInstrumentId,
} from '../domain/candidates/candidatePortfolioRecommendation'
import {
  buildTrustAllocationCandidates,
  trustAllocationInstrumentId,
} from '../domain/candidates/trustAllocationCandidates'
import { captureCandidateExecutionPriceDatasetProvenance } from '../domain/candidates/candidateExecutionPriceReference'

export interface BuildCandidateDecisionSynthesisParams {
  readonly state: AppState
  readonly allocationPlan: AllocationPlanSnapshot
  readonly allocationPlanStatus: AllocationPlanSnapshotState
  readonly allocationPlanCandidateGenerationId: string | null
  readonly fitResult: CandidatePortfolioFitResult
  readonly candidateFreshness: CandidateFunnelFreshness
  readonly evaluatedAt: string
  readonly nowMs: number
}

function canonicalAllocationFor(
  instrumentPlanById: ReadonlyMap<string, InstrumentPlan>,
  classPlanByAssetClass: ReadonlyMap<string, AssetClassPlan>,
  instrumentId: string,
): CandidateSynthesisCanonicalAllocation | null {
  const plan = instrumentPlanById.get(instrumentId)
  if (plan === undefined) return null
  const classPlan = classPlanByAssetClass.get(plan.assetClass)
  if (classPlan === undefined) return null
  return {
    relationship: plan.relationship,
    executable: plan.executable,
    finalSuggestedAmount: plan.finalSuggestedAmount,
    calculationSnapshotId: plan.calculationSnapshotId,
    classNeed: {
      targetGap: classPlan.targetGap,
      targetAmount: classPlan.targetAmount,
      blockedReasons: classPlan.blockedReasons,
    },
    allocationRole: {
      assetClassTargetGap: classPlan.targetGap,
      assetClassTargetRatio: classPlan.targetRatio,
      classHeadroom: plan.classHeadroom,
      instrumentHeadroom: plan.effectiveInstrumentHeadroom,
    },
    blockedReasons: plan.blockedReasons,
    warnings: plan.warningReasons,
    limitingFactors: plan.limitingFactors,
  }
}

const NOT_APPLICABLE_WHY_NOT_EXECUTABLE: readonly SynthesisReasonCode[] = ['PORTFOLIO_FIT_NOT_APPLICABLE']

/**
 * Assembles authoritative store-layer inputs and delegates to the frozen 1A
 * pure composer. Returns null (fail closed) whenever candidate generation
 * identity cannot be trusted verbatim, or holdings/trust identity is
 * malformed/duplicate — never a partially-authorized snapshot.
 */
export function buildCandidateDecisionSynthesisFromState(
  params: BuildCandidateDecisionSynthesisParams,
): CandidateDecisionSynthesisSnapshot | null {
  const {
    state,
    allocationPlan,
    allocationPlanStatus,
    allocationPlanCandidateGenerationId,
    fitResult,
    candidateFreshness,
    evaluatedAt,
    nowMs,
  } = params
  const funnel = state.candidateFunnel
  if (funnel === null) return null
  // R1: candidateGenerationId is an opaque exact upstream identity — compared
  // verbatim, never truncated/normalized. I-SYN-1 is re-enforced by the 1A
  // composer itself; this early check just avoids assembling candidates for
  // a generation the engine was never told about (test-only explicit
  // overrides set allocationPlanCandidateGenerationId to null).
  if (allocationPlanCandidateGenerationId !== funnel._meta.generatedAt) return null
  if (candidateFreshness === 'invalid' || candidateFreshness === 'unavailable') return null

  const instrumentPlanById = new Map(allocationPlan.instrumentPlans.map(plan => [plan.instrumentId, plan] as const))
  const classPlanByAssetClass = new Map(allocationPlan.assetClassPlans.map(plan => [plan.assetClass, plan] as const))
  const datasetReasons = new Set<SynthesisDatasetReason>()
  const candidates: CandidateDecisionSynthesisCandidateInput[] = []

  // ── Population A: held JP_STOCK -> ADD ──────────────────────────────
  const holdingCandidates = buildHoldingAllocationCandidates({ holdings: state.holdings })
  if (holdingCandidates.status === 'invalid') return null
  for (const item of holdingCandidates.candidates) {
    const allocation = canonicalAllocationFor(instrumentPlanById, classPlanByAssetClass, item.instrumentId)
    if (allocation === null) {
      datasetReasons.add('MISSING_INSTRUMENT_MAPPING')
      continue
    }
    const holding = state.holdings.find(h => candidateAllocationInstrumentId(h.code) === item.instrumentId)
    if (holding === undefined) continue // unreachable: identity derived from the same holdings list
    candidates.push({
      instrumentId: item.instrumentId,
      assetClass: 'JP_STOCK',
      namespace: 'jp_stock_funnel',
      displayName: holding.name,
      code: holding.code,
      artifactIndex: item.artifactIndex,
      candidateQuality: {
        source: 'candidate_funnel',
        marketRank: null,
        marketScore: null,
        tier: null,
        dataConfidence: null,
        selectedReasons: [],
        riskReasons: [],
      },
      portfolioFit: { status: 'not_evaluated', relationship: null, reasons: [], risks: [], hardGatePassed: true },
      canonicalAllocation: allocation,
      whyThis: [],
      whyNotExecutable: NOT_APPLICABLE_WHY_NOT_EXECUTABLE,
      usesCandidatesStocksExecutionPrice: false,
    })
  }

  // ── Population B: new JP_STOCK from the authorized funnel -> BUY_NEW ──
  // D24: degraded candidate freshness drops the whole population; stale
  // keeps it (informative) and the real fitResult already demotes
  // hardGatePassed for stale/degraded candidates (computePortfolioFit's own
  // §7 gate), so no freshness-derived override is invented here.
  if (candidateFreshness !== 'degraded') {
    const candidateCapture = buildCandidateAllocationInputs({ artifact: funnel, holdings: state.holdings })
    if (candidateCapture.status === 'invalid') return null
    if (candidateCapture.status === 'available') {
      for (const c of candidateCapture.candidates) {
        const allocation = canonicalAllocationFor(instrumentPlanById, classPlanByAssetClass, c.instrumentId)
        if (allocation === null) {
          datasetReasons.add('MISSING_INSTRUMENT_MAPPING')
          continue
        }
        const raw = funnel.candidates[c.artifactIndex]
        if (raw === undefined || candidateAllocationInstrumentId(raw.code) !== c.instrumentId) continue // unreachable
        const record = fitResult.records.find(r =>
          r.artifactIndex === c.artifactIndex &&
          r.candidateRecordId === `artifact:${c.artifactIndex}` &&
          r.code === raw.code &&
          r.candidateTier === raw.tier &&
          r.candidateMarketRank === raw.marketRank,
        ) ?? null
        // D9 hard gate, exact 7-condition — portfolioFit authority only.
        // Safety/DQ/noTrade/SAFE_MODE gates are AllocationPlan-owned and
        // already reflected in `allocation.blockedReasons` above (D7 row 7).
        const hardGatePassed =
          record !== null &&
          fitResult.status === 'evaluated' &&
          record.portfolioFitStatus === 'evaluated' &&
          record.holdingRelationship !== 'holding_match_unknown' &&
          fitResult.capacity.status === 'available' &&
          fitResult.qualityGate.hardFailIds.length === 0 &&
          fitResult.privacyMode === 'local_only' &&
          fitResult.persistence === 'none'
        candidates.push({
          instrumentId: c.instrumentId,
          assetClass: 'JP_STOCK',
          namespace: 'jp_stock_funnel',
          displayName: raw.name,
          code: raw.code,
          artifactIndex: c.artifactIndex,
          candidateQuality: {
            source: 'candidate_funnel',
            marketRank: c.marketRank,
            marketScore: raw.marketScore,
            tier: raw.tier === 'actionable' || raw.tier === 'deep_review' ? raw.tier : null,
            dataConfidence: c.confidence,
            selectedReasons: raw.selectedReasons,
            riskReasons: raw.riskReasons,
          },
          portfolioFit: {
            status: record?.portfolioFitStatus ?? 'invalid',
            relationship: record?.holdingRelationship ?? null,
            reasons: record?.fitReasons ?? [],
            risks: record?.fitRisks ?? [],
            hardGatePassed,
          },
          canonicalAllocation: allocation,
          whyThis: [],
          whyNotExecutable: candidateFreshness === 'stale' ? ['CANDIDATE_INPUT_STALE'] : [],
          usesCandidatesStocksExecutionPrice: false,
        })
      }
    }
  }

  // ── Population C/D: JP_TRUST existing/new -> ADD/BUY_NEW ─────────────
  const trustCandidates = buildTrustAllocationCandidates({ trust: state.trust })
  if (trustCandidates.status === 'invalid') return null
  for (const c of trustCandidates.candidates) {
    const allocation = canonicalAllocationFor(instrumentPlanById, classPlanByAssetClass, c.instrumentId)
    if (allocation === null) {
      datasetReasons.add('MISSING_INSTRUMENT_MAPPING')
      continue
    }
    const trust = state.trust[c.artifactIndex]
    if (trust === undefined || trustAllocationInstrumentId(trust) !== c.instrumentId) continue // unreachable
    candidates.push({
      instrumentId: c.instrumentId,
      assetClass: 'JP_TRUST',
      namespace: 'jp_trust_registry',
      displayName: trust.name,
      code: null,
      artifactIndex: c.artifactIndex,
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
      canonicalAllocation: allocation,
      whyThis: [],
      whyNotExecutable: NOT_APPLICABLE_WHY_NOT_EXECUTABLE,
      usesCandidatesStocksExecutionPrice: false,
    })
  }

  const priceDatasetProvenance = captureCandidateExecutionPriceDatasetProvenance(
    state.candidatesStocks,
    state.system.dataSourceStatus.candidatesStocks ?? 'default',
    nowMs,
  )

  const provenance: CandidateDecisionSynthesisProvenance = {
    candidateGenerationId: funnel._meta.generatedAt,
    candidatePublicationState: 'published_pass',
    candidateFreshness,
    allocationSnapshotId: allocationPlan.snapshotId,
    allocationSnapshotGeneratedAt: allocationPlan.generatedAt,
    allocationSnapshotStatus: allocationPlanStatus,
    sourceHoldingsSnapshotId: allocationPlan.sourceHoldingsSnapshotId,
    sourceSettingsVersion: allocationPlan.sourceSettingsVersion,
    cashAuthorityUpdatedAt: state.cashAssumptions.updatedAt,
    marketDataAsOf: state.system.dataTimestamps?.market ?? null,
    portfolioFitEvaluatedAt: fitResult.evaluatedAt,
    candidatesStocksUpdatedAt: priceDatasetProvenance.updatedAt,
    candidatesStocksSourceUpdatedAt: priceDatasetProvenance.sourceUpdatedAt,
    candidatesStocksRunToken: priceDatasetProvenance.runToken,
  }

  return buildCandidateDecisionSynthesis({
    generatedAt: evaluatedAt,
    provenance,
    allocationPlanCandidateGenerationId: allocationPlanCandidateGenerationId ?? '',
    candidates,
    datasetReasons: [...datasetReasons],
  })
}
