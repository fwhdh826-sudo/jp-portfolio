// UI-9I Phase 2B-2R: 「今日のToDo」adapter の契約。
//
//   CANONICAL ACTION PARITY       : 旧 TodoCard(b54bd24) の OfficialDecision.actions 経路と同じ表示規則
//   LEGACY FALLBACK NON-MIGRATION : 旧 TodoCard の fallback 合成は移行しない（意図的な非パリティ）
import { describe, expect, it } from 'vitest'
import type { OfficialDecision, OfficialDecisionItem } from '../../types'
import { computeBuyDisplaySuppressed } from '../../domain/analysis/buyDisplaySuppression'
import {
  TODAY_ACTION_PREVIEW_LIMIT,
  projectTodayActions,
  type TodayActionsProjection,
} from './todayActions'
import { assembleTodayHomeViewModel } from './todayHome'
import { STOCK_DECISION_LABEL } from './stocksPresentation'
import { TODAY_ACTION_LABEL } from './labels'
import { baseInputs, fixtureDecision } from './ui9i.fixtures'

function item(id: string, action: OfficialDecisionItem['action'], overrides: Partial<OfficialDecisionItem> = {}): OfficialDecisionItem {
  return {
    id, assetType: 'stock', code: id, name: `銘柄${id}`, action,
    reason: `${id} の理由`, source: 'committee', ...overrides,
  }
}

const all = (p: TodayActionsProjection) => [...p.preview, ...p.more]

/**
 * 旧 TodoCard（b54bd24 の T0_Home.tsx）の canonical 経路の述語をそのまま写した oracle。
 * 旧実装は先頭 3 件で切り捨てていたが、そこは移行しない（黙って捨てない）ため、切り詰め前の集合を返す。
 */
function legacyCanonicalActions(decision: OfficialDecision, dqIsSuppressed: boolean, safeModeActive: boolean) {
  const shouldSuppressBuy = computeBuyDisplaySuppressed(decision.dataQualitySuppressed, dqIsSuppressed, safeModeActive)
  return shouldSuppressBuy
    ? decision.actions.filter(a => a.action !== 'BUY' && !a.isCandidate)
    : decision.actions.filter(a => !a.isCandidate)
}

const MIXED: OfficialDecisionItem[] = [
  item('A1', 'HOLD'),
  item('S1', 'SELL', { reason: '損切ラインに到達' }),
  item('C1', 'BUY_NEW', { isCandidate: true, source: 'candidate' }),
  item('B1', 'BUY', { reason: '追加買い' }),
  item('K1', 'BLOCKED', { blockedReason: 'リスクゲート非通過。解除後に再判定' }),
  item('C2', 'BLOCKED', { isCandidate: true, source: 'candidate' }),
  item('D1', 'DATA_WAIT', { blockedReason: '最新データ取得後に判断' }),
  item('W1', 'WAIT'),
]

describe('CANONICAL ACTION PARITY（旧 TodoCard の OfficialDecision.actions 経路）', () => {
  const scenarios = [
    { name: '通常', dq: false, safe: false },
    { name: 'SAFE_MODE', dq: false, safe: true },
    { name: 'DQ 実時間抑制', dq: true, safe: false },
    { name: '両方', dq: true, safe: true },
  ]
  for (const sc of scenarios) {
    it(`${sc.name}: 表示集合・順序が旧述語と一致（candidate 除外 / BUY 抑制）`, () => {
      const decision = fixtureDecision({ actions: MIXED })
      const projected = projectTodayActions(decision, {
        buySuppressed: computeBuyDisplaySuppressed(decision.dataQualitySuppressed, sc.dq, sc.safe),
      })
      expect(all(projected).map(r => r.id)).toEqual(legacyCanonicalActions(decision, sc.dq, sc.safe).map(a => a.id))
    })
  }

  it('candidate-only action は ToDo に出ない（候補節の担当）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: MIXED }), { buySuppressed: false })
    expect(all(p).map(r => r.id)).not.toContain('C1')
    expect(all(p).map(r => r.id)).not.toContain('C2')
  })

  it('提示順を保つ: sort / rank / priority 並べ替えをしない（SELL が先頭に来ない）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: MIXED }), { buySuppressed: false })
    expect(all(p).map(r => r.id)).toEqual(['A1', 'S1', 'B1', 'K1', 'D1', 'W1'])
  })

  it('SAFE_MODE / DQ: BUY 行だけを表示しない。基底の action は不変で、抑制件数は黙って消さない', () => {
    const decision = fixtureDecision({ actions: MIXED })
    const before = JSON.stringify(decision)
    const p = projectTodayActions(decision, { buySuppressed: true })
    expect(all(p).map(r => r.action)).not.toContain('BUY')
    expect(all(p).map(r => r.id)).toEqual(['A1', 'S1', 'K1', 'D1', 'W1'])
    expect(p.suppressedBuyCount).toBe(1)
    expect(JSON.stringify(decision)).toBe(before)
    // SELL / BLOCKED / DATA_WAIT は SAFE_MODE でも実行提示を止めない
    expect(all(p).map(r => r.action)).toEqual(expect.arrayContaining(['SELL', 'BLOCKED', 'DATA_WAIT']))
  })

  it('reason / blockedReason / identity をそのまま出す（補完しない）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: MIXED }), { buySuppressed: false })
    const blocked = all(p).find(r => r.id === 'K1')!
    expect(blocked).toMatchObject({
      action: 'BLOCKED', actionLabel: '実行不可', title: 'K1 銘柄K1',
      reason: 'K1 の理由', blockedReason: 'リスクゲート非通過。解除後に再判定',
    })
    const hold = all(p).find(r => r.id === 'A1')!
    expect(hold.blockedReason).toBeNull()
    const noReason = projectTodayActions(fixtureDecision({ actions: [item('X', 'WAIT', { reason: '  ', blockedReason: '' })] }), { buySuppressed: false })
    expect(noReason.preview[0]).toMatchObject({ reason: null, blockedReason: null })
  })

  it('コードが無い行は名称のみ（合成しない）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: [item('P', 'HOLD', { code: undefined, name: 'ポートフォリオ全体' })] }), { buySuppressed: false })
    expect(p.preview[0].title).toBe('ポートフォリオ全体')
  })

  it(`初期表示は最大 ${TODAY_ACTION_PREVIEW_LIMIT} 件、残りは提示順のまま到達できる（黙って捨てない）`, () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => item(id, 'HOLD'))
    const p = projectTodayActions(fixtureDecision({ actions: many }), { buySuppressed: false })
    expect(p.preview.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(p.more.map(r => r.id)).toEqual(['d', 'e', 'f', 'g'])
    expect(p.totalCount).toBe(7) // 旧 TodoCard は先頭 3 件で切り捨てていた（そこは移行しない）
  })

  it('3 件以下なら「他 N 件」領域は空', () => {
    const p = projectTodayActions(fixtureDecision({ actions: [item('a', 'SELL'), item('b', 'WAIT')] }), { buySuppressed: false })
    expect(p.more).toEqual([])
    expect(p.status).toBe('available')
  })

  it('状態語: 承認済み語彙を再利用し、BLOCKED / DATA_WAIT / WAIT は互いに区別できる', () => {
    expect(TODAY_ACTION_LABEL.BUY).toBe(STOCK_DECISION_LABEL.BUY)
    expect(TODAY_ACTION_LABEL.SELL).toBe(STOCK_DECISION_LABEL.SELL)
    expect(TODAY_ACTION_LABEL.HOLD).toBe(STOCK_DECISION_LABEL.HOLD)
    expect(TODAY_ACTION_LABEL.WAIT).toBe(STOCK_DECISION_LABEL.WAIT)
    expect(TODAY_ACTION_LABEL.DATA_WAIT).toBe(STOCK_DECISION_LABEL.DATA_WAIT)
    const distinct = new Set([TODAY_ACTION_LABEL.BLOCKED, TODAY_ACTION_LABEL.DATA_WAIT, TODAY_ACTION_LABEL.WAIT, TODAY_ACTION_LABEL.HOLD])
    expect(distinct.size).toBe(4)
    for (const label of Object.values(TODAY_ACTION_LABEL)) {
      expect(label).not.toMatch(/おすすめ|強く|AI|確信|優先度/)
      expect(label).not.toMatch(/^[A-Z_]+$/) // 生の enum を出さない
    }
  })
})

describe('OfficialDecision 状態: unavailable / zero-action', () => {
  it('null は unavailable（代替提案なし）。HOLD / WAIT / 0件とは別状態', () => {
    const p = projectTodayActions(null, { buySuppressed: false })
    expect(p.status).toBe('unavailable')
    expect(all(p)).toEqual([])
  })

  it('actions=[] は empty（unavailable ではない）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: [] }), { buySuppressed: false })
    expect(p.status).toBe('empty')
    expect(p.totalCount).toBe(0)
  })

  it('候補だけが actions にある場合も empty（候補は候補節が担う）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: [item('C', 'BUY_NEW', { isCandidate: true })] }), { buySuppressed: false })
    expect(p.status).toBe('empty')
  })

  it('BUY だけが SAFE_MODE で抑制された場合は empty + 抑制件数（黙って消さない）', () => {
    const p = projectTodayActions(fixtureDecision({ actions: [item('B', 'BUY')] }), { buySuppressed: true })
    expect(p.status).toBe('empty')
    expect(p.suppressedBuyCount).toBe(1)
  })
})

describe('view-model 配線（Hero と同じ権限 / 抑制式の再利用）', () => {
  const decision = fixtureDecision({ actions: MIXED })

  it('normal: 全 canonical 非候補 action が todayActions に入る', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: decision }))
    expect(all(vm.todayActions).map(r => r.id)).toEqual(['A1', 'S1', 'B1', 'K1', 'D1', 'W1'])
  })

  it('SAFE_MODE(effective): BUY のみ非表示（実効 SAFE_MODE の権限を再利用）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: decision, safeModeEffective: true }))
    expect(all(vm.todayActions).map(r => r.action)).not.toContain('BUY')
    expect(vm.todayActions.suppressedBuyCount).toBe(1)
  })

  it('DQ（OfficialDecision.dataQualitySuppressed / 実時間 marketDataOk=false）: BUY のみ非表示', () => {
    const a = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ actions: MIXED, dataQualitySuppressed: true }) }))
    const b = assembleTodayHomeViewModel(baseInputs({ officialDecision: decision, marketDataOk: false }))
    for (const vm of [a, b]) {
      expect(vm.hero.state).toBe('data_wait')
      expect(all(vm.todayActions).map(r => r.action)).not.toContain('BUY')
      expect(all(vm.todayActions).map(r => r.action)).toContain('SELL')
    }
  })

  it('OfficialDecision 不在: unavailable。SAFE_MODE が重なっても提案は出ない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: null, safeModeEffective: true }))
    expect(vm.todayActions.status).toBe('unavailable')
  })

  it('headline が空の OfficialDecision は Hero と同様に利用不可（過去の actions を残さない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ headline: '  ', actions: MIXED }) }))
    expect(vm.hero.state).toBe('decision_unavailable')
    expect(vm.todayActions.status).toBe('unavailable')
    expect(all(vm.todayActions)).toEqual([])
  })

  it('boot: 提案なし（起動中）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ systemStatus: 'initializing', officialDecision: null }))
    expect(vm.todayActions.status).toBe('boot')
  })
})

describe('LEGACY FALLBACK NON-MIGRATION（LEGACY_FALLBACK_SYNTHESIS = NOT_RESTORED）', () => {
  it('OfficialDecision が無いとき、保有ロック / VIX 高 / SAFE_MODE / DQ が ToDo 行を合成しない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({
      officialDecision: null,
      safeModeEffective: true,
      marketDataOk: false,
      holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }],
      marketFeed: { ...baseInputs().marketFeed, vix: 32.5 },
    }))
    expect(vm.todayActions.status).toBe('unavailable')
    expect(all(vm.todayActions)).toEqual([])
    // 旧 fallback の文言が新 Today の ToDo に現れない
    expect(JSON.stringify(vm.todayActions)).not.toMatch(/SQ接近|高ボラ|売却確認|買い候補確認|国内株投信|朝の相場確認|ロック解除後/)
  })

  it('OfficialDecision が有効でも actions に無いものは ToDo にしない（VIX 高 / ロック / DQ から作らない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({
      officialDecision: fixtureDecision({ actions: [] }),
      holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }],
      marketFeed: { ...baseInputs().marketFeed, vix: 32.5 },
    }))
    expect(vm.todayActions.status).toBe('empty')
    expect(all(vm.todayActions)).toEqual([])
  })

  it('旧 dataQualitySuppressed の「データ更新待ち」状態行は action ではないため復元しない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({
      officialDecision: fixtureDecision({ dataQualitySuppressed: true, actions: [item('S', 'SELL')] }),
    }))
    expect(all(vm.todayActions).map(r => r.id)).toEqual(['S'])
  })
})
