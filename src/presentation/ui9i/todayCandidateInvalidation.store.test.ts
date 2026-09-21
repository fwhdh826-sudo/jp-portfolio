// UI-9I Phase 2B-2R2 (P2): 候補の重複排除 cross-layer 不変条件（テストのみ・本番コード変更なし）。
//
// 凍結済み store 不変条件（useAppStore.candSynOfficialDecisionInvalidation.test.ts）:
//   candidate synthesis が fail-closed で無効化されたら、OfficialDecision.actions 内の候補コンポーネントは
//   同じ状態遷移で消える。ここでは、その実 store 状態を Today の投影（今日のToDo / 候補 / 注目ポイント）に通し、
//   - 無効化の前後を通じて候補 action が「今日のToDo」に出ない（候補節が唯一の所有者）
//   - 無効化後は候補節が unavailable で、候補が二重に（または残像として）出ない
//   - 保有 action と canonical risks は無効化の影響を受けない
// ことを確認する。
import { describe, expect, it } from 'vitest'
import { CASH_AUTHORITY_TTL_MS } from '../../domain/cash/cashAuthority'
import type { AppState, OfficialDecision } from '../../types'
import { useAppStore } from '../../store/useAppStore'
import { selectTodayHomeViewModel } from './todayHome'
import { FIXTURE_NOW_MS } from './ui9i.fixtures'

const GENERATED_AT = '2026-08-14T01:00:00.000Z'

function decision(): OfficialDecision {
  return {
    generatedAt: GENERATED_AT,
    source: 'committee',
    headline: 'test',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions: [
      { id: 'holding-1', assetType: 'stock', code: '7203', name: '保有銘柄', action: 'HOLD', reason: '既存判断', source: 'committee' },
      { id: 'holding-2', assetType: 'jp_trust', name: 'ブロック銘柄', action: 'BLOCKED', reason: 'リスクゲート', source: 'risk_gate' },
      {
        id: 'candidate-synthesis-1003', assetType: 'stock', code: '1003', name: 'テスト候補',
        action: 'BUY_NEW', reason: 'candidate reason', source: 'candidate', isCandidate: true, candidateSource: 'candidate_funnel',
      },
    ],
    risks: ['canonical risk は候補の無効化と無関係'],
    rationale: [],
  }
}

/** 実 store 状態のまま、boot だけ外して Today の投影に通す。 */
function today(state: AppState) {
  return selectTodayHomeViewModel({ ...state, system: { ...state.system, status: 'success' } }, FIXTURE_NOW_MS)
}
const rowsOf = (vm: ReturnType<typeof today>) => [...vm.todayActions.preview, ...vm.todayActions.more]

describe('候補 synthesis 無効化 × Today 投影（cross-layer）', () => {
  it('無効化の前後で、候補 action は今日のToDoに出ず、保有 action と risks は保たれる', () => {
    const stale = new Date(Date.parse(GENERATED_AT) - CASH_AUTHORITY_TTL_MS - 60_000).toISOString()
    useAppStore.setState({
      officialDecision: decision(),
      cashAssumptions: { source: 'MANUAL', grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0, updatedAt: stale },
    })

    // 無効化の前: canonical actions には候補が含まれるが、ToDo には出ない（候補節が所有）。
    const before = today(useAppStore.getState())
    expect(useAppStore.getState().officialDecision?.actions.some(a => a.isCandidate)).toBe(true)
    expect(rowsOf(before).map(r => r.id)).toEqual(['holding-1', 'holding-2'])
    expect(rowsOf(before).some(r => r.title.includes('1003'))).toBe(false)

    // fail-closed 無効化（production の cash TTL 経路）。
    expect(useAppStore.getState().revalidateCashAuthorityExpiry(Date.parse(GENERATED_AT))).toBe(true)
    const state = useAppStore.getState()
    expect(state.candidateDecisionSynthesis).toBeNull()
    expect(state.officialDecision?.actions.some(a => a.isCandidate)).toBe(false) // store 不変条件: 同時に消える

    const after = today(state)
    // 候補: 節は unavailable。「候補なし」とも、無効化前の候補の残像とも別状態。
    expect(after.candidates.status).toBe('unavailable')
    // ToDo: 候補は無く、保有 action は順序ごと不変。
    expect(rowsOf(after).map(r => r.id)).toEqual(['holding-1', 'holding-2'])
    expect(JSON.stringify(after.todayActions)).not.toContain('1003')
    // 候補由来の行は、どの投影にも残らない（二重表示・残像なし）。
    expect(JSON.stringify(after.candidates)).not.toContain('1003')
    // canonical risks は候補の無効化に影響されない。
    expect(after.risks.status).toBe('available')
    expect([...after.risks.preview, ...after.risks.more].map(r => r.text)).toEqual(['canonical risk は候補の無効化と無関係'])
  })
})
