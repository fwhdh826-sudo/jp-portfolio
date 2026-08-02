import {
  CANDIDATE_FUNNEL_SCHEMA_VERSION,
  CANDIDATE_FUNNEL_SCORE_VERSION,
  CANDIDATE_FUNNEL_VERSION,
} from '../../types/candidateFunnel'
import {
  CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
  CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
  CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
  CANDIDATE_PORTFOLIO_FIT_VERSION,
} from '../../types/candidatePortfolioFit'
import type {
  CandidatePortfolioRecommendation,
  CandidatePortfolioRecommendationInput,
} from '../../types/candidatePortfolioRecommendation'
import type { CandidateFunnelArtifact } from '../../types/candidateFunnelArtifact'
import type { CandidateInput, InstrumentInput } from '../../types/allocationPlan'
import type { Holding } from '../../types'
import { normalizePortfolioFitCode } from './portfolioFit'

export const CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS = {
  BUY_NEW: '市場候補ファネルの重点候補で、未保有照合と日本株枠の余力を確認しました。売買執行・金額算定は未実施です。',
  DEEP_REVIEW: '市場候補ファネルの要精査候補です。未保有照合済みですが、追加確認が必要なため監視します。売買執行・金額算定は未実施です。',
  PARTIAL: 'ポートフォリオ適合を一部のみ確認できたため監視します。売買執行・金額算定は未実施です。',
  CAPACITY: '日本株枠の余力を確定できないため監視します。売買執行・金額算定は未実施です。',
  DATA_QUALITY: 'データ品質抑制中のため監視します。売買執行・金額算定は未実施です。',
  NO_TRADE: 'ノートレード条件中のため監視します。売買執行・金額算定は未実施です。',
  SAFE_MODE: 'SAFE_MODE発動中のため監視します。売買執行・金額算定は未実施です。',
} as const

function isValidCandidateArtifact(artifact: CandidateFunnelArtifact): boolean {
  return (
    artifact.schemaVersion === CANDIDATE_FUNNEL_SCHEMA_VERSION &&
    artifact.funnelVersion === CANDIDATE_FUNNEL_VERSION &&
    artifact.scoreVersion === CANDIDATE_FUNNEL_SCORE_VERSION &&
    artifact.not_for_trading === true &&
    artifact.status === 'generated' &&
    artifact._meta.kind === 'candidate_funnel' &&
    artifact._meta.not_for_trading === true &&
    artifact._meta.qualityGate.overallPass === true &&
    artifact._meta.qualityGate.hardFailIds.length === 0
  )
}

function isValidDataset(input: CandidatePortfolioRecommendationInput): boolean {
  const { artifact, fitResult } = input
  return (
    isValidCandidateArtifact(artifact) &&
    fitResult.schemaVersion === CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION &&
    fitResult.fitVersion === CANDIDATE_PORTFOLIO_FIT_VERSION &&
    fitResult.scoreModel === CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL &&
    fitResult.targetPopulation === CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION &&
    fitResult.not_for_trading === true &&
    fitResult.privacyMode === 'local_only' &&
    fitResult.persistence === 'none' &&
    (fitResult.status === 'evaluated' || fitResult.status === 'partial') &&
    fitResult.qualityGate.hardFailIds.length === 0
  )
}

function recommendationRank(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null
}

function compareCandidateOrder(
  left: { marketRank: number | null; artifactIndex: number },
  right: { marketRank: number | null; artifactIndex: number },
): number {
  if (left.marketRank === null && right.marketRank !== null) return 1
  if (left.marketRank !== null && right.marketRank === null) return -1
  if (left.marketRank !== null && right.marketRank !== null && left.marketRank !== right.marketRank) {
    return left.marketRank - right.marketRank
  }
  return left.artifactIndex - right.artifactIndex
}

export interface CandidateAllocationInputAdapterResult {
  readonly status: 'available' | 'unavailable' | 'invalid'
  readonly sourceCandidateGenerationId: string | null
  readonly instruments: readonly InstrumentInput[]
  readonly candidates: readonly CandidateInput[]
}

export function candidateAllocationInstrumentId(rawCode: unknown): string | null {
  const normalized = normalizePortfolioFitCode(rawCode)
  return normalized.status === 'valid' && normalized.normalizedCode !== null
    ? `stock:${normalized.normalizedCode}`
    : null
}

/**
 * Pure public-candidate -> allocation input adapter. It deliberately emits no
 * price/lot authority and selects the same rank/artifact order as the existing
 * recommendation composer. Any missing/duplicate/ambiguous identity closes the
 * whole candidate set rather than inventing or overwriting an instrument.
 */
export function buildCandidateAllocationInputs(input: {
  readonly artifact: CandidateFunnelArtifact | null
  readonly holdings: readonly Holding[]
}): CandidateAllocationInputAdapterResult {
  if (input.artifact === null) {
    return { status: 'unavailable', sourceCandidateGenerationId: null, instruments: [], candidates: [] }
  }
  if (!isValidCandidateArtifact(input.artifact) || input.artifact._meta.generatedAt.length === 0) {
    return { status: 'invalid', sourceCandidateGenerationId: null, instruments: [], candidates: [] }
  }

  const heldIds = new Set<string>()
  for (const holding of input.holdings) {
    const instrumentId = candidateAllocationInstrumentId(holding.code)
    if (instrumentId === null) {
      return { status: 'invalid', sourceCandidateGenerationId: input.artifact._meta.generatedAt, instruments: [], candidates: [] }
    }
    heldIds.add(instrumentId)
  }

  const selected: Array<{
    artifactIndex: number
    instrumentId: string
    marketRank: number | null
    confidence: number | null
    sector: string
  }> = []
  const identities = new Set<string>()
  for (let artifactIndex = 0; artifactIndex < input.artifact.candidates.length; artifactIndex += 1) {
    const candidate = input.artifact.candidates[artifactIndex]
    if (candidate.tier !== 'actionable' && candidate.tier !== 'deep_review') continue
    const instrumentId = candidateAllocationInstrumentId(candidate.code)
    if (instrumentId === null || identities.has(instrumentId)) {
      return { status: 'invalid', sourceCandidateGenerationId: input.artifact._meta.generatedAt, instruments: [], candidates: [] }
    }
    identities.add(instrumentId)
    if (heldIds.has(instrumentId)) continue
    const confidence = typeof candidate.dataConfidence === 'number' &&
      Number.isFinite(candidate.dataConfidence) &&
      candidate.dataConfidence >= 0 &&
      candidate.dataConfidence <= 1
      ? candidate.dataConfidence
      : null
    selected.push({
      artifactIndex,
      instrumentId,
      marketRank: recommendationRank(candidate.marketRank),
      confidence,
      sector: candidate.sector,
    })
  }

  const ordered = selected.sort(compareCandidateOrder).slice(0, 3)
  return {
    status: 'available',
    sourceCandidateGenerationId: input.artifact._meta.generatedAt,
    instruments: ordered.map(candidate => ({
      instrumentId: candidate.instrumentId,
      assetClass: 'JP_STOCK',
      kind: 'jp_stock',
      relationship: 'new_to_portfolio',
      currentAmount: 0,
      role: candidate.sector,
      reason: 'candidate_funnel canonical input',
      priceJpy: null,
      lotSizeShares: null,
    })),
    candidates: ordered.map(candidate => ({
      instrumentId: candidate.instrumentId,
      buyKind: 'BUY_NEW',
      marketRank: candidate.marketRank,
      artifactIndex: candidate.artifactIndex,
      confidence: candidate.confidence,
    })),
  }
}

export function composeCandidatePortfolioRecommendations(
  input: CandidatePortfolioRecommendationInput,
): readonly CandidatePortfolioRecommendation[] {
  if (!isValidDataset(input)) return []

  const recommendations: CandidatePortfolioRecommendation[] = []
  for (let artifactIndex = 0; artifactIndex < input.artifact.candidates.length; artifactIndex += 1) {
    const candidate = input.artifact.candidates[artifactIndex]
    if (candidate.tier !== 'actionable' && candidate.tier !== 'deep_review') continue

    const candidateRecordId = `artifact:${artifactIndex}`
    const exactRecords = input.fitResult.records.filter(record =>
      record.artifactIndex === artifactIndex &&
      record.candidateRecordId === candidateRecordId &&
      record.code === candidate.code,
    )
    if (exactRecords.length !== 1) continue

    const record = exactRecords[0]
    if (
      record.candidateTier !== candidate.tier ||
      record.candidateMarketRank !== candidate.marketRank ||
      record.holdingRelationship !== 'new_to_portfolio' ||
      (record.portfolioFitStatus !== 'evaluated' && record.portfolioFitStatus !== 'partial')
    ) continue

    const isPartial =
      input.fitResult.status === 'partial' || record.portfolioFitStatus === 'partial'
    const canBuyNew =
      candidate.tier === 'actionable' &&
      input.fitResult.status === 'evaluated' &&
      record.portfolioFitStatus === 'evaluated' &&
      input.fitResult.capacity.status === 'available' &&
      !input.gates.dataQualitySuppressed &&
      !input.gates.noTrade &&
      !input.gates.safeModeActive

    let action: CandidatePortfolioRecommendation['action'] = 'WATCH'
    let reason: string
    if (canBuyNew) {
      action = 'BUY_NEW'
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.BUY_NEW
    } else if (input.gates.dataQualitySuppressed) {
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.DATA_QUALITY
    } else if (input.gates.noTrade) {
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.NO_TRADE
    } else if (input.gates.safeModeActive) {
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.SAFE_MODE
    } else if (isPartial) {
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.PARTIAL
    } else if (input.fitResult.capacity.status !== 'available') {
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.CAPACITY
    } else {
      reason = CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS.DEEP_REVIEW
    }

    recommendations.push({
      candidateRecordId,
      artifactIndex,
      code: candidate.code,
      name: candidate.name,
      marketRank: recommendationRank(candidate.marketRank),
      action,
      reason,
      allocation: null,
    })
  }

  return recommendations
    .sort(compareCandidateOrder)
    .slice(0, 3)
}
