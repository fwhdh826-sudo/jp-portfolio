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

export const CANDIDATE_PORTFOLIO_RECOMMENDATION_REASONS = {
  BUY_NEW: '市場候補ファネルの重点候補で、未保有照合と日本株枠の余力を確認しました。売買執行・金額算定は未実施です。',
  DEEP_REVIEW: '市場候補ファネルの要精査候補です。未保有照合済みですが、追加確認が必要なため監視します。売買執行・金額算定は未実施です。',
  PARTIAL: 'ポートフォリオ適合を一部のみ確認できたため監視します。売買執行・金額算定は未実施です。',
  CAPACITY: '日本株枠の余力を確定できないため監視します。売買執行・金額算定は未実施です。',
  DATA_QUALITY: 'データ品質抑制中のため監視します。売買執行・金額算定は未実施です。',
  NO_TRADE: 'ノートレード条件中のため監視します。売買執行・金額算定は未実施です。',
  SAFE_MODE: 'SAFE_MODE発動中のため監視します。売買執行・金額算定は未実施です。',
} as const

function isValidDataset(input: CandidatePortfolioRecommendationInput): boolean {
  const { artifact, fitResult } = input
  return (
    artifact.schemaVersion === CANDIDATE_FUNNEL_SCHEMA_VERSION &&
    artifact.funnelVersion === CANDIDATE_FUNNEL_VERSION &&
    artifact.scoreVersion === CANDIDATE_FUNNEL_SCORE_VERSION &&
    artifact.not_for_trading === true &&
    artifact.status === 'generated' &&
    artifact._meta.kind === 'candidate_funnel' &&
    artifact._meta.not_for_trading === true &&
    artifact._meta.qualityGate.overallPass === true &&
    artifact._meta.qualityGate.hardFailIds.length === 0 &&
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
    })
  }

  return recommendations
    .sort((left, right) => {
      if (left.marketRank === null && right.marketRank !== null) return 1
      if (left.marketRank !== null && right.marketRank === null) return -1
      if (left.marketRank !== null && right.marketRank !== null && left.marketRank !== right.marketRank) {
        return left.marketRank - right.marketRank
      }
      return left.artifactIndex - right.artifactIndex
    })
    .slice(0, 3)
}
