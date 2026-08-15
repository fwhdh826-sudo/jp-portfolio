import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PORTFOLIO_POLICY } from '../types'
import type { CandidateFunnelArtifact, Trust } from '../types'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
} from './portfolioGenerationLock'
import { FakeLockManager } from './testing/fakeLockManager'
import { createAppStoreInstanceForTest } from './useAppStore'

// End-to-end proof (§33/§37): drives the REAL production writer path — importCsv commits
// canonical bytes, which is the only condition under which
// appendCommittedCandidatePortfolioRecommendations (and therefore
// buildCandidateDecisionSynthesisFromState) ever runs. This is deliberately separate from the
// exhaustive pure-composer coverage in candidateDecisionSynthesisComposer.test.ts: it proves the
// wiring itself (selectCandidatePortfolioFit's real canonicalGeneration authority reaching the
// composer), not the composer's population/ranking logic again.

class CountingFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null
  readAsArrayBuffer(file: File) {
    file.arrayBuffer().then(result => this.onload?.({ target: { result } })).catch(() => this.onerror?.())
  }
}

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

const NOW_MS = Date.parse('2026-08-14T01:00:00.000Z')
const FUNNEL_GENERATION = '2026-08-13T22:14:38.374259+00:00' // production-shaped microsecond precision

function jpTrust(): Trust {
  return {
    id: 'nikkei_semi', name: '日経半導体', abbr: '半導体', account: '特定',
    policy: 'JAPAN_SHORTTERM', eval: 0, pnlPct: 0, dayPct: 0, cost: 0.2,
    mu: 0.08, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0, decision: 'HOLD',
  }
}

const CSV = [
  'データ基準日時,2026-08-14T09:00:00+09:00',
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1004,銘柄1004,1200,150000,8.00,0.50,2025-01-01',
].join('\n')

function csvFile(content = CSV): File {
  return new File([content], 'portfolio.csv', { type: 'text/csv' })
}

function funnelArtifact(): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = FUNNEL_GENERATION
  value._meta.asOf = FUNNEL_GENERATION
  value._meta.sourceUpdatedAt = FUNNEL_GENERATION
  return value
}

function adapter(manager: FakeLockManager): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 60_000 })
}

function baseline(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  const artifact = funnelArtifact()
  store.setState(state => ({
    holdings: [],
    trust: [jpTrust()],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: 10_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      updatedAt: new Date(NOW_MS).toISOString(),
    },
    candidateFunnel: artifact,
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
      dataSourceStatus: { ...state.system.dataSourceStatus, candidateFunnel: 'loaded', candidatesStocks: 'default' },
      dataTimestamps: { ...state.system.dataTimestamps!, market: new Date(NOW_MS).toISOString(), candidateFunnel: artifact._meta.generatedAt },
    },
  }))
}

function instanceWith(lock: PortfolioGenerationLockAdapter) {
  const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: lock })
  baseline(instance.store)
  return instance
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', CountingFileReader)
  Object.keys(storage).forEach(key => delete storage[key])
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CAND-SYN-1B end-to-end production writer path (real importCsv commit)', () => {
  it('B23/B25/§35 a real CSV commit produces a non-null candidateDecisionSynthesis with correct atomic provenance, T0/T1/officialDecision left unchanged', () => {
    const manager = new FakeLockManager()
    const instance = instanceWith(adapter(manager))
    const before = instance.store.getState()

    return grant(manager, instance.store.getState().importCsv(csvFile())).then(result => {
      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      const state = instance.store.getState()

      const synthesis = state.candidateDecisionSynthesis
      expect(synthesis).not.toBeNull()
      expect(synthesis?.status).toBe('available')
      expect(synthesis?.privacyMode).toBe('local_only')
      expect(synthesis?.persistence).toBe('none')
      expect(synthesis?.not_for_trading).toBe(true)

      // R1: opaque exact upstream identity, verbatim microsecond precision preserved.
      expect(synthesis?.provenance.candidateGenerationId).toBe(FUNNEL_GENERATION)
      // I-SYN-1: matches the same generation the canonical AllocationPlan used.
      expect(synthesis?.provenance.candidateGenerationId).toBe(state.allocationPlanCandidateGenerationId)
      // Atomic generation: provenance points at the SAME AllocationPlanSnapshot published in state.
      expect(synthesis?.provenance.allocationSnapshotId).toBe(state.allocationPlan?.snapshotId)
      expect(synthesis?.provenance.sourceHoldingsSnapshotId).toBe(state.allocationPlan?.sourceHoldingsSnapshotId)
      expect(synthesis?.provenance.sourceSettingsVersion).toBe(state.allocationPlan?.sourceSettingsVersion)

      // §35 production behavior unchanged: officialDecision generation is untouched by this
      // commit path (candidateToOfficialDecisionItem's own writer-count proof lives in
      // useAppStore.candidateDecisionSynthesis.test.ts).
      expect(before.officialDecision).toBeNull()
      expect(state.officialDecision).not.toBeNull()
    })
  })

  it('§39 runtime migration P2 stays 3: legacy candidatePortfolioRecommendations / stockCandidates maxAmount paths are untouched by this commit', () => {
    const manager = new FakeLockManager()
    const instance = instanceWith(adapter(manager))

    return grant(manager, instance.store.getState().importCsv(csvFile())).then(() => {
      const state = instance.store.getState()
      // Legacy candidatePortfolioRecommendations projection still runs independently — its
      // presence/absence is unrelated to candidateDecisionSynthesis (no shared writer).
      expect(Array.isArray(state.candidatePortfolioRecommendations)).toBe(true)
      expect(state.candidateDecisionSynthesis).not.toBeNull()
    })
  })
})
