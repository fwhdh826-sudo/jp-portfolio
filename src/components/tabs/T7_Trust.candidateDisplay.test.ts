// P5-B003: T7は投信専用表示。株候補（assetType==='stock'）がofficialDecision.actionsに
// appendされてもT7には一切表示されないことを保証する回帰guard。
import { describe, it, expect } from 'vitest'
import type { OfficialDecision, OfficialDecisionItem } from '../../types'
import { computeTrustCandidateActionsForDisplay } from './T7_Trust'

function makeAction(overrides: Partial<OfficialDecisionItem> = {}): OfficialDecisionItem {
  return {
    id: overrides.id ?? 'a1',
    assetType: 'jp_trust',
    name: 'テストファンド',
    action: 'BUY_NEW',
    reason: 'テスト理由',
    source: 'candidate',
    isCandidate: true,
    ...overrides,
  }
}

function makeOfficialDecision(actions: OfficialDecisionItem[]): OfficialDecision {
  return {
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'candidate',
    headline: 'test',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions,
    risks: [],
  } as unknown as OfficialDecision
}

describe('computeTrustCandidateActionsForDisplay', () => {
  it('officialDecisionがnullのとき空配列を返す', () => {
    expect(computeTrustCandidateActionsForDisplay(null)).toEqual([])
  })

  it('assetType===stock の候補は一切含めない', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-1', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
      makeAction({ id: 'trust-1', assetType: 'jp_trust', action: 'BUY_NEW' }),
    ])
    const result = computeTrustCandidateActionsForDisplay(decision)
    expect(result.map(a => a.id)).toEqual(['trust-1'])
  })

  it('株候補のみの場合は空配列になる（T7非混入の直接検証）', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-1', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
      makeAction({ id: 'stock-2', assetType: 'stock', code: '9984', action: 'WATCH' }),
    ])
    expect(computeTrustCandidateActionsForDisplay(decision)).toEqual([])
  })

  it('isCandidate=falseのactionは含めない（既存挙動の非退行）', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'buy-existing', isCandidate: false, action: 'BUY' }),
      makeAction({ id: 'new', isCandidate: true, action: 'BUY_NEW' }),
    ])
    expect(computeTrustCandidateActionsForDisplay(decision).map(a => a.id)).toEqual(['new'])
  })

  it('BUY_NEW/WATCH以外のisCandidateアクションは含めない（既存挙動の非退行）', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'sell-candidate', isCandidate: true, action: 'SELL' }),
      makeAction({ id: 'watch', isCandidate: true, action: 'WATCH' }),
    ])
    expect(computeTrustCandidateActionsForDisplay(decision).map(a => a.id)).toEqual(['watch'])
  })

  it('4件以上あっても先頭3件までに絞る（株候補混在時も投信候補のみで3件）', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-1', assetType: 'stock', code: '1', action: 'WATCH' }),
      makeAction({ id: 'w1', assetType: 'jp_trust', action: 'WATCH' }),
      makeAction({ id: 'w2', assetType: 'jp_trust', action: 'WATCH' }),
      makeAction({ id: 'w3', assetType: 'jp_trust', action: 'WATCH' }),
      makeAction({ id: 'w4', assetType: 'jp_trust', action: 'WATCH' }),
    ])
    const result = computeTrustCandidateActionsForDisplay(decision)
    expect(result).toHaveLength(3)
    expect(result.every(a => a.assetType !== 'stock')).toBe(true)
  })
})
