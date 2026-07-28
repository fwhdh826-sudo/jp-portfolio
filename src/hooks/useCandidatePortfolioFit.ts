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
  // Component-local and instance-lifetime only: remembers the last logical input
  // whose evaluation completed, so StrictMode setup replay is not a new cycle.
  const completedLogicalCycleInputRef =
    useRef<CandidatePortfolioFitLogicalCycleInput | null>(null)
  // Holds only the newest scheduled logical input; it is never shared or retained
  // as result history or a candidate/canonical cache.
  const latestScheduledLogicalCycleInputRef =
    useRef<CandidatePortfolioFitLogicalCycleInput | null>(null)
  // Holds the AppState snapshot paired with the newest scheduled logical input.
  const latestScheduledStateRef = useRef<AppState | null>(null)
  // Monotonic component-local token invalidates stale scheduled evaluations.
  const scheduleGenerationRef = useRef(0)
  // Remains cancelled after real unmount; a subsequent effect setup clears it
  // during StrictMode replay or a committed dependency revision.
  const lifecycleCancelledRef = useRef(false)

  useEffect(() => {
    lifecycleCancelledRef.current = false
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
    if (
      isSameLogicalCycleInput(
        completedLogicalCycleInputRef.current,
        logicalCycleInput,
      ) &&
      latestScheduledLogicalCycleInputRef.current === null
    ) {
      return
    }

    latestScheduledLogicalCycleInputRef.current = logicalCycleInput
    latestScheduledStateRef.current = useAppStore.getState()
    const scheduledGeneration = scheduleGenerationRef.current + 1
    scheduleGenerationRef.current = scheduledGeneration

    queueMicrotask(() => {
      if (
        lifecycleCancelledRef.current ||
        scheduleGenerationRef.current !== scheduledGeneration
      ) {
        return
      }

      const scheduledInput = latestScheduledLogicalCycleInputRef.current
      const scheduledState = latestScheduledStateRef.current
      if (scheduledInput === null || scheduledState === null) return

      latestScheduledLogicalCycleInputRef.current = null
      latestScheduledStateRef.current = null
      if (
        isSameLogicalCycleInput(
          completedLogicalCycleInputRef.current,
          scheduledInput,
        )
      ) {
        return
      }

      const result = evaluateCandidatePortfolioFitRuntime(
        scheduledState,
        {
          now: scheduledInput[0],
          restoreCanonicalGeneration: scheduledInput[1],
        },
      )
      completedLogicalCycleInputRef.current = scheduledInput
      setSnapshot({ phase: 'ready', result })
    })

    return () => {
      lifecycleCancelledRef.current = true
      if (scheduleGenerationRef.current === scheduledGeneration) {
        scheduleGenerationRef.current += 1
        latestScheduledLogicalCycleInputRef.current = null
        latestScheduledStateRef.current = null
      }
    }
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
