import type { PortfolioFitSnapshotInput } from '../types/candidatePortfolioFit'
import type { CsvImportGenerationRestoreResult } from '../store/persist'

export type PortfolioFitCrossTabState = 'current' | 'stale'

/**
 * Projects the validated canonical generation restore result into the pure
 * portfolio-fit snapshot contract. The restore result is the sole authority:
 * ambient store holdings and legacy persistence are intentionally not inputs.
 */
export function buildPortfolioFitSnapshotInput(
  canonicalGeneration: CsvImportGenerationRestoreResult,
  crossTabState: PortfolioFitCrossTabState,
): PortfolioFitSnapshotInput | null {
  if (canonicalGeneration.status !== 'committed') {
    if (canonicalGeneration.status === 'none') return null
    return {
      existence: 'invalid',
      error: 'CANONICAL_ENVELOPE_INVALID',
    }
  }

  const { payload } = canonicalGeneration
  return {
    existence: payload.holdings.length === 0 ? 'present_empty' : 'present_nonempty',
    schemaVersion: canonicalGeneration.schemaVersion,
    generationId: canonicalGeneration.generationId,
    savedAt: canonicalGeneration.savedAt,
    holdings: payload.holdings,
    trusts: payload.trust,
    portfolioPolicy: payload.portfolioPolicy ?? null,
    cashAssumptions: payload.cashAssumptions ?? null,
    provenance: payload.provenance ?? null,
    csvImportedAt: payload.csvImportedAt ?? null,
    crossTabState,
  }
}
