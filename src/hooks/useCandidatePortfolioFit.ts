import { useEffect, useRef, useState } from 'react'
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

type CandidatePortfolioFitLogicalCycleInput = readonly [
  now: CandidatePortfolioFitRuntimeDependencies['now'],
  restoreCanonicalGeneration:
    CandidatePortfolioFitRuntimeDependencies['restoreCanonicalGeneration'],
  candidateFunnel: AppState['candidateFunnel'],
  candidateFunnelStatus: AppState['system']['dataSourceStatus']['candidateFunnel'],
  holdings: AppState['holdings'],
  trust: AppState['trust'],
  portfolioPolicy: AppState['portfolioPolicy'],
  cashAssumptions: AppState['cashAssumptions'],
  csvLastImportedAt: AppState['system']['csvLastImportedAt'],
  csvImportProvenance: AppState['system']['csvImportProvenance'],
  csvSyncSummary: AppState['system']['csvSyncSummary'],
  crossTabInvalidation: AppState['system']['crossTabInvalidation'],
]

const DEFAULT_RUNTIME_DEPENDENCIES: CandidatePortfolioFitRuntimeDependencies = {
  now: () => Date.now(),
  restoreCanonicalGeneration: () => restoreCsvImportGeneration(),
}

function isSameLogicalCycleInput(
  previous: CandidatePortfolioFitLogicalCycleInput | null,
  current: CandidatePortfolioFitLogicalCycleInput,
): boolean {
  return previous !== null &&
    previous.every((value, index) => Object.is(value, current[index]))
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
  const now = dependencies.now
  const restoreCanonicalGeneration = dependencies.restoreCanonicalGeneration
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
  // Component-local and instance-lifetime only: remembers the immediately preceding
  // logical input revision so StrictMode's repeated effect setup is not a new cycle.
  const previousLogicalCycleInputRef =
    useRef<CandidatePortfolioFitLogicalCycleInput | null>(null)

  useEffect(() => {
    const logicalCycleInput: CandidatePortfolioFitLogicalCycleInput = [
      now,
      restoreCanonicalGeneration,
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
    ]
    if (isSameLogicalCycleInput(
      previousLogicalCycleInputRef.current,
      logicalCycleInput,
    )) {
      return
    }

    const result = evaluateCandidatePortfolioFitRuntime(
      useAppStore.getState(),
      { now, restoreCanonicalGeneration },
    )
    previousLogicalCycleInputRef.current = logicalCycleInput
    setSnapshot({ phase: 'ready', result })
  }, [
    now,
    restoreCanonicalGeneration,
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
