import { describe, expect, it } from 'vitest'
import {
  HOME_CANDIDATE_PREVIEW_LIMIT,
  candidatePresentationSequence,
  projectCandidateSection,
} from './candidatePresentation'
import { fixtureEntry, fixtureExecutableDecision, fixtureSynthesis } from './ui9i.fixtures'

const open = { executionSuppressed: false, dataWait: false }

describe('候補の提示順: CandidateDecisionSynthesis の canonical 順を保つ', () => {
  const decisions = [
    fixtureEntry('D1', { action: 'BUY_NEW', candidateQuality: { marketScore: 10, marketRank: 9, tier: 'actionable' } }),
    fixtureEntry('D2', { action: 'ADD', relationship: 'already_held', candidateQuality: { marketScore: 90, marketRank: 1, tier: 'actionable' } }),
  ]
  const watch = [
    fixtureEntry('W1', { candidateQuality: { marketScore: 40, marketRank: 2, tier: 'deep_review' } }),
    fixtureEntry('W2', { candidateQuality: { marketScore: 1, marketRank: 3, tier: 'deep_review' } }),
  ]

  it('提示順 = decisions → watchList（配列内の順序も不変）', () => {
    const seq = candidatePresentationSequence(fixtureSynthesis(decisions, watch))
    expect(seq.map(e => e.code)).toEqual(['D1', 'D2', 'W1', 'W2'])
  })

  it('T0 プレビューは提示順の先頭3件のみ', () => {
    const section = projectCandidateSection(fixtureSynthesis(decisions, watch), open)
    expect(HOME_CANDIDATE_PREVIEW_LIMIT).toBe(3)
    expect(section.rows.map(r => r.code)).toEqual(['D1', 'D2', 'W1'])
    expect(section.totalCount).toBe(4)
  })

  it('UI 側で再ランクしない: marketScore / rank / tier / 金額の昇順・降順に並べ替えられていない', () => {
    const section = projectCandidateSection(fixtureSynthesis(decisions, watch), open)
    const scores = section.rows.map(r => r.marketScore)
    expect(scores).toEqual([10, 90, 40]) // 降順でも昇順でもない = 入力順のまま
    expect(scores).not.toEqual([...scores].sort((a, b) => b! - a!))
    expect(scores).not.toEqual([...scores].sort((a, b) => a! - b!))
  })

  it('入力配列を破壊しない', () => {
    const synthesis = fixtureSynthesis(decisions, watch)
    const before = JSON.stringify(synthesis)
    projectCandidateSection(synthesis, open)
    expect(JSON.stringify(synthesis)).toBe(before)
  })
})

describe('ユーザー向けラベル', () => {
  it('relationship: already_held → 保有 / new_to_portfolio → 新規。BUY_NEW / ADD を出さない', () => {
    const section = projectCandidateSection(fixtureSynthesis(
      [fixtureExecutableDecision(), fixtureEntry('H', { action: 'ADD', relationship: 'already_held', candidateQuality: { tier: 'actionable' } })],
      [],
    ), open)
    expect(section.rows.map(r => r.relationshipLabel)).toEqual(['新規', '保有'])
    const text = JSON.stringify(section)
    expect(text).not.toMatch(/"(relationshipLabel|stateLabel)":"(BUY_NEW|ADD|WATCH|BLOCKED)"/)
  })

  it('Home の状態語: actionable → 実行可能 / deep_review → 要レビュー（A/B/C/S 等級を作らない）', () => {
    const section = projectCandidateSection(fixtureSynthesis(
      [fixtureExecutableDecision()],
      [fixtureEntry('R', { candidateQuality: { tier: 'deep_review' } })],
    ), open)
    expect(section.rows.map(r => r.stateLabel)).toEqual(['実行可能', '要レビュー'])
    expect(JSON.stringify(section)).not.toMatch(/"grade"|"[ABCS]"/)
    expect(section.executableCount).toBe(1)
    expect(section.reviewCount).toBe(1)
  })

  it('tier が actionable でも提案外（WATCH / BLOCKED）の行は「実行可能」と呼ばない', () => {
    const section = projectCandidateSection(fixtureSynthesis(
      [],
      [fixtureEntry('B', { action: 'BLOCKED', candidateQuality: { tier: 'actionable' } })],
    ), open)
    expect(section.rows[0].kind).toBe('review')
    expect(section.rows[0].stateLabel).toBe('要レビュー')
  })
})

describe('金額: EXECUTABLE の canonical 金額のみ', () => {
  it('EXECUTABLE のときだけ executableAmountJpy を露出する', () => {
    const section = projectCandidateSection(fixtureSynthesis(
      [fixtureExecutableDecision()],
      [fixtureEntry('R')],
    ), open)
    expect(section.rows[0].executableAmountJpy).toBe(400_000)
    expect(section.rows[1].executableAmountJpy).toBeNull()
  })

  it('SAFE_MODE / DATA_WAIT では EXECUTABLE でも金額を出さない', () => {
    const synthesis = fixtureSynthesis([fixtureExecutableDecision()], [])
    expect(projectCandidateSection(synthesis, { executionSuppressed: true, dataWait: false }).rows[0].executableAmountJpy).toBeNull()
    expect(projectCandidateSection(synthesis, { executionSuppressed: false, dataWait: true }).rows[0].executableAmountJpy).toBeNull()
  })
})

describe('利用不可と候補なしは別状態', () => {
  it('null / unavailable / invalid → status=unavailable（候補なしではない）', () => {
    expect(projectCandidateSection(null, open).status).toBe('unavailable')
    expect(projectCandidateSection(fixtureSynthesis([], [], 'unavailable'), open).status).toBe('unavailable')
    expect(projectCandidateSection(fixtureSynthesis([], [], 'invalid'), open).status).toBe('unavailable')
  })

  it('available で 0 件は「候補なし」= status=available, totalCount=0', () => {
    const s = projectCandidateSection(fixtureSynthesis([], []), open)
    expect(s.status).toBe('available')
    expect(s.totalCount).toBe(0)
  })
})
