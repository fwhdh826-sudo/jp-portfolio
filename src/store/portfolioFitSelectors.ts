import type { AppState } from '../types'
import type {
  CandidatePortfolioFitCandidateSource,
  CandidatePortfolioFitInput,
  CandidatePortfolioFitResult,
} from '../types/candidatePortfolioFit'
import type { CsvImportGenerationRestoreResult } from './persist'
import { computePortfolioFit } from '../domain/candidates/portfolioFit'
import { buildPortfolioFitSnapshotInput } from '../services/portfolioFitSnapshotAuthority'
import { selectCandidateFunnelFreshness } from './selectors'

export interface BuildCandidatePortfolioFitInputParams {
  state: AppState
  canonicalGeneration: CsvImportGenerationRestoreResult
  evaluatedAt: string
}

export function selectCandidatePortfolioFitCandidateSource(
  state: AppState,
  evaluatedAt: string,
): CandidatePortfolioFitCandidateSource {
  const freshness = selectCandidateFunnelFreshness(state, Date.parse(evaluatedAt))

  if (freshness === 'fresh' || freshness === 'stale' || freshness === 'degraded') {
    const artifact = state.candidateFunnel
    if (artifact === null) {
      return { status: 'invalid', artifact: null, freshness: 'invalid' }
    }
    return { status: 'available', artifact, freshness }
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
