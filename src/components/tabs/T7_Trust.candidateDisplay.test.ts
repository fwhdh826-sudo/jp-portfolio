// CAND-SYN-1E: T7は投信専用表示。CandidateDecisionSynthesisSnapshotが唯一の
// 候補UI authorityであり、JP_STOCK候補や既保有(already_held)候補、
// BUY_NEW/WATCH以外のactionはT7の「未保有投信候補」に一切混入しないことを
// 保証する回帰guard（P5-B003の後継）。
import { describe, it, expect } from 'vitest'
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
} from '../../types/candidateDecisionSynthesis'
import { computeTrustSynthesisCandidatesForDisplay } from './T7_Trust'

function makeEntry(overrides: Partial<CandidateDecisionSynthesisEntry> = {}): CandidateDecisionSynthesisEntry {
  return {
    entryId: overrides.entryId ?? 'JP_TRUST:trust:default',
    instrumentId: 'trust:default',
    assetClass: 'JP_TRUST',
    displayName: 'テストファンド',
    code: null,
    action: 'BUY_NEW',
    rank: 1,
    relationship: 'new_to_portfolio',
    candidateQuality: {
      source: 'trust_registry',
      marketRank: null,
      marketScore: null,
      tier: null,
      dataConfidence: null,
      selectedReasons: [],
      riskReasons: [],
    },
    portfolioFit: { status: 'not_evaluated', relationship: null, reasons: [], risks: [], hardGatePassed: true },
    allocationRole: { assetClassTargetGap: 0, assetClassTargetRatio: 0, classHeadroom: 0, instrumentHeadroom: 0 },
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
  overrides: Partial<CandidateDecisionSynthesisSnapshot> = {},
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
    ...overrides,
  }
}

describe('computeTrustSynthesisCandidatesForDisplay', () => {
  it('synthesisがnullのとき空配列を返す', () => {
    expect(computeTrustSynthesisCandidatesForDisplay(null)).toEqual([])
  })

  it('synthesis.status !== available のとき空配列を返す', () => {
    const snapshot = makeSnapshot([makeEntry()], [], { status: 'invalid' })
    expect(computeTrustSynthesisCandidatesForDisplay(snapshot)).toEqual([])
  })

  it('assetClass===JP_STOCK の候補は一切含めない', () => {
    const snapshot = makeSnapshot([
      makeEntry({ entryId: 'stock-1', instrumentId: 'stock:7203', assetClass: 'JP_STOCK' }),
      makeEntry({ entryId: 'trust-1', instrumentId: 'trust:t1' }),
    ])
    const result = computeTrustSynthesisCandidatesForDisplay(snapshot)
    expect(result.map(e => e.entryId)).toEqual(['trust-1'])
  })

  it('株候補のみの場合は空配列になる（T7非混入の直接検証）', () => {
    const snapshot = makeSnapshot([
      makeEntry({ entryId: 'stock-1', instrumentId: 'stock:7203', assetClass: 'JP_STOCK' }),
      makeEntry({ entryId: 'stock-2', instrumentId: 'stock:9984', assetClass: 'JP_STOCK', action: 'WATCH' }),
    ])
    expect(computeTrustSynthesisCandidatesForDisplay(snapshot)).toEqual([])
  })

  it('relationship===already_held の候補は含めない（既保有は未保有候補セクション対象外）', () => {
    const snapshot = makeSnapshot([
      makeEntry({ entryId: 'held', relationship: 'already_held', action: 'ADD' }),
      makeEntry({ entryId: 'new', relationship: 'new_to_portfolio', action: 'BUY_NEW' }),
    ])
    expect(computeTrustSynthesisCandidatesForDisplay(snapshot).map(e => e.entryId)).toEqual(['new'])
  })

  it('BUY_NEW/WATCH以外のactionは含めない（ADD/BLOCKEDの非退行）', () => {
    const snapshot = makeSnapshot([
      makeEntry({ entryId: 'blocked', action: 'BLOCKED' }),
      makeEntry({ entryId: 'watch', action: 'WATCH' }),
    ])
    expect(computeTrustSynthesisCandidatesForDisplay(snapshot).map(e => e.entryId)).toEqual(['watch'])
  })

  it('4件以上あっても先頭3件までに絞る（株/既保有混在時も対象条件のみで3件）', () => {
    const snapshot = makeSnapshot([
      makeEntry({ entryId: 'stock-1', instrumentId: 'stock:1', assetClass: 'JP_STOCK', action: 'WATCH' }),
      makeEntry({ entryId: 'w1', instrumentId: 'trust:w1', action: 'WATCH' }),
      makeEntry({ entryId: 'w2', instrumentId: 'trust:w2', action: 'WATCH' }),
      makeEntry({ entryId: 'w3', instrumentId: 'trust:w3', action: 'WATCH' }),
      makeEntry({ entryId: 'w4', instrumentId: 'trust:w4', action: 'WATCH' }),
    ])
    const result = computeTrustSynthesisCandidatesForDisplay(snapshot)
    expect(result).toHaveLength(3)
    expect(result.every(e => e.assetClass !== 'JP_STOCK')).toBe(true)
  })

  it('decisions→watchListの順に連結し、各配列内の順序を保持する', () => {
    const d1 = makeEntry({ entryId: 'd1', instrumentId: 'trust:d1' })
    const d2 = makeEntry({ entryId: 'd2', instrumentId: 'trust:d2' })
    const w1 = makeEntry({ entryId: 'w1', instrumentId: 'trust:w1', action: 'WATCH' })
    const snapshot = makeSnapshot([d1, d2], [w1])
    expect(computeTrustSynthesisCandidatesForDisplay(snapshot).map(e => e.entryId)).toEqual(['d1', 'd2', 'w1'])
  })
})
