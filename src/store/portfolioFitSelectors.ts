import type { AppState } from '../types'
import type {
  CandidatePortfolioFitCandidateSource,
  CandidatePortfolioFitInput,
  CandidatePortfolioFitResult,
} from '../types/candidatePortfolioFit'
import type { CsvImportGenerationRestoreResult } from './persist'
import { computePortfolioFit } from '../domain/candidates/portfolioFit'
import { buildPortfolioFitSnapshotInput } from '../services/portfolioFitSnapshotAuthority'
import { parseCandidateFunnelTimestamp } from '../utils/candidateFunnelTimestamp'
import { parseStrictTimestamp } from '../utils/strictTimestamp'
import { selectCandidateFunnelFreshness } from './selectors'

export interface BuildCandidatePortfolioFitInputParams {
  state: AppState
  canonicalGeneration: CsvImportGenerationRestoreResult
  evaluatedAt: string
}

// FCA-1-P1-03: the private microsecond-aware parser that used to live here is
// now the shared candidate_funnel timestamp authority
// (src/utils/candidateFunnelTimestamp.ts), so parser / freshness /
// presentation / allocation / portfolio-fit all evaluate the same contract.
function parseCandidateGeneratedTimestamp(value: string) {
  return parseCandidateFunnelTimestamp(value)
}

export function selectCandidatePortfolioFitCandidateSource(
  state: AppState,
  evaluatedAt: string,
): CandidatePortfolioFitCandidateSource {
  const evaluatedTimestamp = parseStrictTimestamp(evaluatedAt, { allowDateOnly: false })
  if (evaluatedTimestamp === null) {
    return { status: 'invalid', artifact: null, freshness: 'invalid' }
  }

  const currentArtifact = state.candidateFunnel
  if (currentArtifact !== null) {
    const generatedTimestamp = parseCandidateGeneratedTimestamp(currentArtifact._meta.generatedAt)
    if (
      generatedTimestamp === null ||
      generatedTimestamp.epochMs > evaluatedTimestamp.epochMs
    ) {
      return { status: 'invalid', artifact: null, freshness: 'invalid' }
    }
  }

  const freshness = selectCandidateFunnelFreshness(state, evaluatedTimestamp.epochMs)
  if (freshness === 'fresh' || freshness === 'stale' || freshness === 'degraded') {
    if (currentArtifact === null) {
      return { status: 'invalid', artifact: null, freshness: 'invalid' }
    }
    return { status: 'available', artifact: currentArtifact, freshness }
  }
  if (freshness === 'unavailable') {
    return { status: 'unavailable', artifact: null, freshness: 'unavailable' }
  }
  return { status: 'invalid', artifact: null, freshness: 'invalid' }
}

export function buildCandidatePortfolioFitInput({
  state,
  canonicalGeneration,
  evaluatedAt,
}: BuildCandidatePortfolioFitInputParams): CandidatePortfolioFitInput {
  const crossTabState =
    state.system.crossTabInvalidation?.status === 'stale' ? 'stale' : 'current'

  return {
    candidateSource: selectCandidatePortfolioFitCandidateSource(state, evaluatedAt),
    portfolioSnapshot: buildPortfolioFitSnapshotInput(canonicalGeneration, crossTabState),
    evaluatedAt,
  }
}

export function selectCandidatePortfolioFit(
  state: AppState,
  canonicalGeneration: CsvImportGenerationRestoreResult,
  evaluatedAt: string,
): CandidatePortfolioFitResult {
  return computePortfolioFit(buildCandidatePortfolioFitInput({
    state,
    canonicalGeneration,
    evaluatedAt,
  }))
}
