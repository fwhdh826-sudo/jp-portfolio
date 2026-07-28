import { useEffect, useState } from 'react'
import type { AppState } from '../types'
import type { CandidatePortfolioFitResult } from '../types/candidatePortfolioFit'
import {
  restoreCsvImportGeneration,
  type CsvImportGenerationRestoreResult,
} from '../store/persist'
import { selectCandidatePortfolioFit } from '../store/portfolioFitSelectors'
import { useAppStore } from '../store/useAppStore'

export interface CandidatePortfolioFitRuntimeDependencies {
  readonly now: () => number
  readonly restoreCanonicalGeneration: () => CsvImportGenerationRestoreResult
}

export type CandidatePortfolioFitRuntimeSnapshot =
  | { readonly phase: 'pending'; readonly result: null }
  | { readonly phase: 'ready'; readonly result: CandidatePortfolioFitResult }

const DEFAULT_RUNTIME_DEPENDENCIES: CandidatePortfolioFitRuntimeDependencies = {
  now: () => Date.now(),
  restoreCanonicalGeneration: () => restoreCsvImportGeneration(),
}

export function evaluateCandidatePortfolioFitRuntime(
  state: AppState,
  dependencies: CandidatePortfolioFitRuntimeDependencies,
): CandidatePortfolioFitResult {
  let nowMs = Number.NaN
  try {
    nowMs = dependencies.now()
  } catch {
    nowMs = Number.NaN
  }

  let evaluatedAt = 'invalid'
  if (Number.isFinite(nowMs)) {
    try {
      evaluatedAt = new Date(nowMs).toISOString()
    } catch {
      evaluatedAt = 'invalid'
    }
  }

  let canonicalGeneration: CsvImportGenerationRestoreResult
  try {
    canonicalGeneration = dependencies.restoreCanonicalGeneration()
  } catch {
    canonicalGeneration = { status: 'invalid' }
  }

  return selectCandidatePortfolioFit(state, canonicalGeneration, evaluatedAt)
}

export function useCandidatePortfolioFit(
  dependencies: CandidatePortfolioFitRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES,
): CandidatePortfolioFitRuntimeSnapshot {
  const candidateFunnel = useAppStore(state => state.candidateFunnel)
  const candidateFunnelStatus = useAppStore(
    state => state.system.dataSourceStatus.candidateFunnel,
  )
  const holdings = useAppStore(state => state.holdings)
  const trust = useAppStore(state => state.trust)
  const portfolioPolicy = useAppStore(state => state.portfolioPolicy)
  const cashAssumptions = useAppStore(state => state.cashAssumptions)
  const csvLastImportedAt = useAppStore(state => state.system.csvLastImportedAt)
  const csvImportProvenance = useAppStore(state => state.system.csvImportProvenance)
  const csvSyncSummary = useAppStore(state => state.system.csvSyncSummary)
  const crossTabInvalidation = useAppStore(state => state.system.crossTabInvalidation)
  const [snapshot, setSnapshot] = useState<CandidatePortfolioFitRuntimeSnapshot>({
    phase: 'pending',
    result: null,
  })

  useEffect(() => {
    const result = evaluateCandidatePortfolioFitRuntime(
      useAppStore.getState(),
      dependencies,
    )
    setSnapshot({ phase: 'ready', result })
  }, [
    dependencies,
    candidateFunnel,
    candidateFunnelStatus,
    holdings,
    trust,
    portfolioPolicy,
    cashAssumptions,
    csvLastImportedAt,
    csvImportProvenance,
    csvSyncSummary,
    crossTabInvalidation,
  ])

  return snapshot
}
