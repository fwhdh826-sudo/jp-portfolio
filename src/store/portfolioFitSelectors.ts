import type { AppState } from '../types'
import type {
  CandidatePortfolioFitCandidateSource,
  CandidatePortfolioFitInput,
  CandidatePortfolioFitResult,
} from '../types/candidatePortfolioFit'
import type { CsvImportGenerationRestoreResult } from './persist'
import { computePortfolioFit } from '../domain/candidates/portfolioFit'
import { buildPortfolioFitSnapshotInput } from '../services/portfolioFitSnapshotAuthority'
import { parseStrictTimestamp } from '../utils/strictTimestamp'
import { selectCandidateFunnelFreshness } from './selectors'

export interface BuildCandidatePortfolioFitInputParams {
  state: AppState
  canonicalGeneration: CsvImportGenerationRestoreResult
  evaluatedAt: string
}

function parseCandidateGeneratedTimestamp(value: string) {
  const strictTimestamp = parseStrictTimestamp(value, { allowDateOnly: false })
  if (strictTimestamp !== null) return strictTimestamp

  // The Python producer emits strict ISO date-times with microseconds while the
  // shared parser represents epoch authority at millisecond precision.
  const extendedFraction = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{4,6})(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (extendedFraction === null) return null
  return parseStrictTimestamp(
    `${extendedFraction[1]}.${extendedFraction[2].slice(0, 3)}${extendedFraction[3]}`,
    { allowDateOnly: false },
  )
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
