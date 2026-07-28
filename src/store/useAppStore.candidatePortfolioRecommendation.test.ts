// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runFullAnalysis, useAppStore } from './useAppStore'

const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')

function segment(start: string, end?: string): string {
  const from = source.indexOf(start)
  const to = end === undefined ? source.length : source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function expectOrder(value: string, ordered: string[]) {
  let cursor = -1
  for (const token of ordered) {
    const next = value.indexOf(token, cursor + 1)
    expect(next, token).toBeGreaterThan(cursor)
    cursor = next
  }
}

describe('P5-B005-C-D postcommit atomic integration', () => {
  it('C-C-T41 CSV composes once after durable commit and before publish', () => {
    const value = segment('importCsv: async', 'setTab: (tab)')
    expectOrder(value, ['persistCsvImportTransaction({', 'ownsCsvImportCanonicalBytes(persistenceReceipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'set({'])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T42 initialize composes committed generation once', () => {
    const value = segment('initialize: async', '// ── 全データ再取得')
    expectOrder(value, ['persistCurrentPortfolioGeneration(', "persistenceResult.target === 'canonical'", 'appendCommittedCandidatePortfolioRecommendations(', 'publishLoadFinalState('])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T43 refresh composes postpersist once', () => {
    const value = segment('refreshAllData: async', '// ── CSV取込')
    expectOrder(value, ['persistCurrentPortfolioGeneration(', "persistenceResult.target === 'canonical'", 'appendCommittedCandidatePortfolioRecommendations(', 'publishLoadFinalState('])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T44 manual mutation composes postpersist once', () => {
    const value = segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2')
    expectOrder(value, ['persistCurrentPortfolioGeneration(', "persistenceResult.status !== 'persisted'", 'appendCommittedCandidatePortfolioRecommendations(', 'set(finalState)'])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T45 snapshot incoming commit composes once', () => {
    const value = segment('importPortfolioSnapshot: async')
    expectOrder(value, ['persistCsvImportTransaction(payload', 'ownsCsvImportCanonicalBytes(receipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'set(s => ({'])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T46 persistence failure cannot append', () => {
    for (const value of [
      segment('initialize: async', '// ── 全データ再取得'),
      segment('refreshAllData: async', '// ── CSV取込'),
      segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2'),
    ]) {
      expectOrder(value, ["persistenceResult.status !== 'persisted'", 'appendCommittedCandidatePortfolioRecommendations('])
    }
  })
  it('C-C-T47 ownership loss or rollback cannot publish stale append', () => {
    const csv = segment('importCsv: async', 'setTab: (tab)')
    const snapshot = segment('importPortfolioSnapshot: async')
    expectOrder(csv, ['ownsCsvImportCanonicalBytes(persistenceReceipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'ownsCsvImportCanonicalBytes(persistenceReceipt)', 'set({'])
    expectOrder(snapshot, ['ownsCsvImportCanonicalBytes(receipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'ownsCsvImportCanonicalBytes(receipt)', 'set(s => ({'])
  })
  it('C-C-T48 cross-tab stale and canonical invalid have no fallback', () => {
    const helper = segment('function appendCommittedCandidatePortfolioRecommendations', 'function reportSubscriberException')
    expect(helper).toContain("canonicalGeneration.status !== 'committed'")
    expect(helper).not.toContain('stockCandidates')
    expect(helper).not.toContain('holdings:')
    expect(helper).not.toContain('readCsvImportCanonicalRaw')
  })
  it('C-C-T49 recommendation failure preserves base decision', () => {
    const helper = segment('function appendCommittedCandidatePortfolioRecommendations', 'function reportSubscriberException')
    expect(helper).toMatch(/catch \{\s+return computed\s+\}/)
    expect(helper).toContain('officialDecision === computed.officialDecision')
  })
  it('C-C-T50 adds no extra publish, emission, storage, or precommit candidate item', () => {
    const helper = segment('function appendCommittedCandidatePortfolioRecommendations', 'function reportSubscriberException')
    expect(helper).not.toMatch(/\bset\(|setState|localStorage|sessionStorage|indexedDB|emitPortfolio/)
    const computed = runFullAnalysis(useAppStore.getState(), { nowMs: Date.now() })
    expect(computed.officialDecision?.actions.some(item => item.candidateSource === 'candidate_funnel')).toBe(false)
  })
})
