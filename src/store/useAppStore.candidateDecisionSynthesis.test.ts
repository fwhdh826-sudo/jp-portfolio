// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CASH_AUTHORITY_TTL_MS } from '../domain/cash/cashAuthority'
import { runFullAnalysis, useAppStore } from './useAppStore'
import { selectCandidateDecisionSynthesis } from './selectors'

const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('./candidateDecisionSynthesisComposer.ts', import.meta.url), 'utf8')
const selectorsSource = readFileSync(new URL('./selectors.ts', import.meta.url), 'utf8')
const persistSource = readFileSync(new URL('./persist.ts', import.meta.url), 'utf8')
const portfolioSnapshotTransferSource = readFileSync(new URL('../utils/portfolioSnapshotTransfer.ts', import.meta.url), 'utf8')
const cashAssumptionsTransferSource = readFileSync(new URL('../utils/cashAssumptionsTransfer.ts', import.meta.url), 'utf8')

describe('CAND-SYN-1B store lifecycle mechanical proofs', () => {
  it('B26/§39 initial store state has candidateDecisionSynthesis = null (no persistence-restored value)', () => {
    expect(useAppStore.getState().candidateDecisionSynthesis).toBeNull()
  })

  it('B23/§39 SYNTHESIS_PRODUCTION_WRITER_COUNT = 1: buildCandidateDecisionSynthesisFromState has exactly one call site in the store', () => {
    const matches = source.match(/buildCandidateDecisionSynthesisFromState\(/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('runFullAnalysis alone is never a second synthesis writer: it always returns candidateDecisionSynthesis: null', () => {
    for (let i = 0; i < 5; i += 1) {
      const state = useAppStore.getState()
      const computed = runFullAnalysis(state, { nowMs: Date.parse('2026-08-14T01:00:00.000Z') + i })
      expect(computed.candidateDecisionSynthesis).toBeNull()
    }
  })

  it('B27/§39 the read-only selector is a plain passthrough (no recompute/fallback logic)', () => {
    const declIndex = selectorsSource.indexOf('export const selectCandidateDecisionSynthesis')
    expect(declIndex).toBeGreaterThan(0)
    const declLine = selectorsSource.slice(declIndex, selectorsSource.indexOf('\n', declIndex))
    expect(declLine).toBe('export const selectCandidateDecisionSynthesis = (s: AppState) => s.candidateDecisionSynthesis')
  })

  it('B28/§39 zero officialDecision consumers: candidateDecisionSynthesis never feeds candidateToOfficialDecisionItem or appendCandidatePortfolioRecommendations', () => {
    const officialDecisionWriterSegment = source.slice(
      source.indexOf('function candidateToOfficialDecisionItem'),
      source.indexOf('function candidateToOfficialDecisionItem') + 2000,
    )
    expect(officialDecisionWriterSegment).not.toContain('candidateDecisionSynthesis')
  })

  it('§31/§39 persistence sinks = 0: candidateDecisionSynthesis is absent from persist.ts / portfolioSnapshotTransfer.ts / cashAssumptionsTransfer.ts', () => {
    expect(persistSource).not.toContain('candidateDecisionSynthesis')
    expect(portfolioSnapshotTransferSource).not.toContain('candidateDecisionSynthesis')
    expect(cashAssumptionsTransferSource).not.toContain('candidateDecisionSynthesis')
  })

  it('composer performs no network/storage/telemetry and never imports the store (purity boundary)', () => {
    expect(composerSource).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|console\.|Date\.now|Math\.random/)
    expect(composerSource).not.toMatch(/from ['"]\.\/useAppStore['"]|from ['"]\.\.\/components/)
  })

  it('B22 cash TTL expiry (revalidateCashAuthorityExpiry) clears a stale-authority synthesis to null in the same fail-closed phase as allocationPlan', () => {
    const staleUpdatedAt = new Date(Date.parse('2026-08-14T01:00:00.000Z') - CASH_AUTHORITY_TTL_MS - 60_000).toISOString()
    useAppStore.setState(state => ({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: 0,
        updatedAt: staleUpdatedAt,
      },
      // Simulate a prior synthesis snapshot surviving from before expiry — this is what must
      // be cleared; the fixture value itself need not be a fully valid snapshot for this test.
      candidateDecisionSynthesis: {
        schemaVersion: 'candidate-decision-synthesis-1',
        authorityVersion: 'cand-syn-v1',
        synthesisId: 'candidate-decision-synthesis:stale-fixture',
        generatedAt: '2026-08-01T00:00:00.000Z',
        status: 'available',
        provenance: state.candidateDecisionSynthesis?.provenance ?? {
          candidateGenerationId: 'stale',
          candidatePublicationState: 'published_pass',
          candidateFreshness: 'fresh',
          allocationSnapshotId: 'stale',
          allocationSnapshotGeneratedAt: '2026-08-01T00:00:00.000Z',
          allocationSnapshotStatus: 'current',
          sourceHoldingsSnapshotId: 'stale',
          sourceSettingsVersion: 'stale',
          cashAuthorityUpdatedAt: null,
          marketDataAsOf: null,
          portfolioFitEvaluatedAt: '2026-08-01T00:00:00.000Z',
          candidatesStocksUpdatedAt: null,
          candidatesStocksSourceUpdatedAt: null,
          candidatesStocksRunToken: null,
        },
        decisions: [],
        watchList: [],
        datasetReasons: [],
        privacyMode: 'local_only',
        persistence: 'none',
        not_for_trading: true,
      },
    }))
    expect(useAppStore.getState().candidateDecisionSynthesis).not.toBeNull()

    const changed = useAppStore.getState().revalidateCashAuthorityExpiry(Date.parse('2026-08-14T01:00:00.000Z'))

    expect(changed).toBe(true)
    // The rebuilt AllocationPlanSnapshot may be a non-null blocked/stale-cash snapshot (existing
    // CASH-AUTH-1 behavior, unchanged) — what 1B guarantees is that no executable synthesis
    // survives this window, since runFullAnalysis alone never populates candidateDecisionSynthesis.
    expect(selectCandidateDecisionSynthesis(useAppStore.getState())).toBeNull()
  })

  it('§23/§39 fail-closed stale window: the crossTab invalidation flush clears candidateDecisionSynthesis in the same object literal as allocationPlan', () => {
    const flushIndex = source.indexOf('flushPendingToStore = () => {')
    expect(flushIndex).toBeGreaterThan(0)
    const setCallStart = source.indexOf('set(state => ({', flushIndex)
    const setCallEnd = source.indexOf('}))', setCallStart)
    const block = source.slice(setCallStart, setCallEnd)
    expect(block).toContain('allocationPlan: null')
    expect(block).toContain('candidateDecisionSynthesis: null')
  })

  it('INITIAL_STATE sets candidateDecisionSynthesis: null alongside the other HR-I2/I3 ephemeral fields', () => {
    const initialStateIndex = source.indexOf("allocationPlanStatus: 'absent'")
    expect(initialStateIndex).toBeGreaterThan(0)
    const nearby = source.slice(initialStateIndex, initialStateIndex + 300)
    expect(nearby).toContain('candidateDecisionSynthesis: null')
  })
})
