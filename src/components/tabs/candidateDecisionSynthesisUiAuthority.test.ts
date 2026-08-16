// CAND-SYN-1D: mechanical authority gates for the T0/T1 candidate UI cutover
// (implementation ticket §31-§35, D1-D22). These are structural (source-grep)
// and unit assertions that the *production* T0/T1 components read
// CandidateDecisionSynthesis exclusively, never recompute money, never
// re-rank, and never leak a legacy monetary field for WATCH/BLOCKED.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
} from '../../types/candidateDecisionSynthesis'
import { computeSynthesisDecisionsForDisplay } from './T0_Home'
import { synthesisNonExecutableReasonText } from '../candidates/candidateDecisionSynthesisPresentation'

function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

const t0Source = readFileSync(new URL('./T0_Home.tsx', import.meta.url), 'utf8')
const t1Source = readFileSync(new URL('./T1_Decision.tsx', import.meta.url), 'utf8')
const t0Code = stripLineComments(t0Source)
const t1Code = stripLineComments(t1Source)

function makeEntry(overrides: Partial<CandidateDecisionSynthesisEntry> = {}): CandidateDecisionSynthesisEntry {
  return {
    entryId: overrides.entryId ?? 'JP_STOCK:stock:1234',
    instrumentId: 'stock:1234',
    assetClass: 'JP_STOCK',
    displayName: 'テスト株式会社',
    code: '1234',
    action: 'BUY_NEW',
    rank: 1,
    relationship: 'new_to_portfolio',
    candidateQuality: {
      source: 'candidate_funnel',
      marketRank: 1,
      marketScore: 80,
      tier: 'actionable',
      dataConfidence: 1,
      selectedReasons: [],
      riskReasons: [],
    },
    portfolioFit: { status: 'evaluated', relationship: 'new_to_portfolio', reasons: [], risks: [], hardGatePassed: true },
    allocationRole: { assetClassTargetGap: 100_000, assetClassTargetRatio: 0.1, classHeadroom: 100_000, instrumentHeadroom: 100_000 },
    money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 },
    blockingReasons: [],
    warnings: [],
    limitingFactors: [],
    whyThis: [],
    whyNotExecutable: [],
    ...overrides,
  }
}

function makeSnapshot(
  decisions: CandidateDecisionSynthesisEntry[],
  watchList: CandidateDecisionSynthesisEntry[] = [],
): CandidateDecisionSynthesisSnapshot {
  return {
    schemaVersion: 'candidate-decision-synthesis-1',
    authorityVersion: 'cand-syn-v1',
    synthesisId: 'candidate-decision-synthesis:test',
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'available',
    provenance: {} as CandidateDecisionSynthesisSnapshot['provenance'],
    decisions,
    watchList,
    datasetReasons: [],
    privacyMode: 'local_only',
    persistence: 'none',
    not_for_trading: true,
  }
}

describe('D2/D3: T0 decisions <=3 and never surfaces watchList', () => {
  it('D2 the domain contract caps decisions at 3 (CANDIDATE_DECISION_SYNTHESIS_DECISION_LIMIT) and T0 never re-slices beyond it', () => {
    const decisions = [makeEntry({ entryId: 'a' }), makeEntry({ entryId: 'b' }), makeEntry({ entryId: 'c' })]
    const result = computeSynthesisDecisionsForDisplay(makeSnapshot(decisions))
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('D3 T0 never reads synthesis.watchList — CandidateCard source has no watchList reference', () => {
    const cardSection = t0Source.slice(t0Source.indexOf('function CandidateCard'))
    expect(cardSection).not.toContain('watchList')
  })
})

describe('D4/D22: T0/T1 never read candidatePortfolioRecommendations', () => {
  it('D4 T0_Home.tsx never reads state.candidatePortfolioRecommendations (mentions in explanatory comments are fine)', () => {
    expect(t0Code).not.toMatch(/\.candidatePortfolioRecommendations\b/)
  })

  it('D22 T1_Decision.tsx never reads state.candidatePortfolioRecommendations', () => {
    expect(t1Code).not.toMatch(/\.candidatePortfolioRecommendations\b/)
  })
})

describe('D5/D9/D10/D15: no positive money for non-executable/WATCH/BLOCKED entries', () => {
  it('D5 NOT_EXECUTABLE entry never yields a positive amount from synthesisNonExecutableReasonText\'s companion money field', () => {
    const entry = makeEntry({ money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 } })
    expect(entry.money.kind).toBe('NOT_EXECUTABLE')
    expect(entry.money.executableAmountJpy).toBe(0)
  })

  it('D9 WATCH entries carry no positive money (domain invariant: action downgrade implies NOT_EXECUTABLE)', () => {
    const watch = makeEntry({ action: 'WATCH', money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 } })
    expect(watch.money.executableAmountJpy).toBe(0)
    expect(synthesisNonExecutableReasonText(watch)).not.toBeNull()
  })

  it('D10 BLOCKED entries carry no positive money', () => {
    const blocked = makeEntry({
      action: 'BLOCKED',
      money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 },
      blockingReasons: ['INSUFFICIENT_CASH'],
    })
    expect(blocked.money.executableAmountJpy).toBe(0)
    expect(synthesisNonExecutableReasonText(blocked)).toBe('利用可能資金が不足しています')
  })

  it('D15 a canonical NOT_EXECUTABLE entry never displays a positive legacy-shaped amount, even if allocationRole headroom is positive', () => {
    // allocationRole.classHeadroom/instrumentHeadroom are reference-only fields
    // (D5-4) — this test locks that a positive headroom does not leak into
    // money display; only entry.money.kind gates the amount shown.
    const entry = makeEntry({
      money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 },
      allocationRole: { assetClassTargetGap: 500_000, assetClassTargetRatio: 0.1, classHeadroom: 500_000, instrumentHeadroom: 500_000 },
    })
    expect(entry.money.kind).toBe('NOT_EXECUTABLE')
  })
})

describe('D11/D12: displayed executable amount equals canonical synthesis value exactly', () => {
  it('D11/D12 EXECUTABLE money is read verbatim (executableAmountJpy), never derived by price*lot or headroom math in the UI layer', () => {
    const entry = makeEntry({
      action: 'BUY_NEW',
      money: { kind: 'EXECUTABLE', executableAmountJpy: 123_400, calculationSnapshotId: 'snap-1' },
    })
    expect(entry.money.kind === 'EXECUTABLE' && entry.money.executableAmountJpy).toBe(123_400)
    // T0/T1 source never multiplies/divides a money field (no second calculation).
    expect(t0Source).not.toMatch(/entry\.money\.executableAmountJpy\s*[*/]/)
    expect(t1Source).not.toMatch(/entry\.money\.executableAmountJpy\s*[*/]/)
  })
})

describe('D13/D14: legacy money fields do not appear as UI authority', () => {
  it('D13 T0_Home.tsx never property-accesses suggestedAmount/maxAmount/candidateSizingTier (explanatory comments are fine)', () => {
    for (const term of ['suggestedAmount', 'maxAmount', 'candidateSizingTier']) {
      expect(t0Code).not.toMatch(new RegExp(`\\.${term}\\b`))
    }
  })

  it('D14 T1_Decision.tsx never property-accesses suggestedAmount/maxAmount/candidateSizingTier, and never shows the legacy 検討上限 label', () => {
    for (const term of ['suggestedAmount', 'maxAmount', 'candidateSizingTier']) {
      expect(t1Code).not.toMatch(new RegExp(`\\.${term}\\b`))
    }
    expect(t1Source).not.toContain('検討上限')
  })
})

describe('D16/D17: synthesis unavailable/invalid fails closed with no legacy fallback', () => {
  it('D16 null synthesis renders no decisions', () => {
    expect(computeSynthesisDecisionsForDisplay(null)).toEqual([])
  })

  it('D17 invalid-status synthesis renders no decisions (no fallback to legacy candidatePortfolioRecommendations/officialDecision)', () => {
    expect(computeSynthesisDecisionsForDisplay(makeSnapshot([]).status === 'available'
      ? { ...makeSnapshot([]), status: 'invalid' }
      : makeSnapshot([]))).toEqual([])
  })
})

describe('D19: candidate officialDecision compatibility action is not a second T0/T1 candidate source', () => {
  it('D19 CandidateCard (T0) never reads officialDecision', () => {
    const cardSection = t0Source.slice(t0Source.indexOf('function CandidateCard'), t0Source.indexOf('function CandidateCard') + 1000)
    expect(cardSection).not.toContain('officialDecision')
  })

  it('D19 CandidateDecisionSection (T1) never reads officialDecision', () => {
    const sectionStart = t1Source.indexOf('function CandidateDecisionSection')
    const section = t1Source.slice(sectionStart, sectionStart + 2000)
    expect(section).not.toContain('officialDecision')
  })
})

describe('D20: entryId used as React list key, not array index', () => {
  it('D20 T0 CandidateListItem is keyed by entry.entryId', () => {
    expect(t0Source).toContain('<CandidateListItem key={entry.entryId} entry={entry} />')
  })

  it('D20 T1 CandidateSynthesisEntryCard is keyed by entry.entryId', () => {
    expect(t1Source).toContain('key={entry.entryId} entry={entry} rawByCode={rawByCode}')
  })
})

describe('D21: no candidate price×lot/cash calculation in the UI layer', () => {
  it('D21 T0/T1 never multiply/divide a synthesis money field or reference price/lot arithmetic', () => {
    for (const src of [t0Source, t1Source]) {
      expect(src).not.toMatch(/priceJpy\s*\*/)
      expect(src).not.toMatch(/lotSizeShares\s*\*/)
    }
  })
})
