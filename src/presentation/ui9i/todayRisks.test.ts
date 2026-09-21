// UI-9I Phase 2B-2R2 (P1-02): OfficialDecision.risks → Today「注目ポイント」の adapter 契約。
//
//   RISK AUTHORITY       : OfficialDecision.risks のみ（verbatim・提示順）
//   LEGACY HEURISTICS    : 旧 RiskWarningCard の UI ローカル閾値は移行しない
//   STATE DISTINCTION    : 判断利用不可 と risks=[] は別状態
import { describe, expect, it } from 'vitest'
import { TODAY_RISK_PREVIEW_LIMIT, projectTodayRisks } from './todayRisks'
import { assembleTodayHomeViewModel } from './todayHome'
import { baseInputs, fixtureDecision } from './ui9i.fixtures'

const RISKS = ['risk A', 'risk B', 'risk C', 'risk D', 'risk E']
const texts = (p: ReturnType<typeof projectTodayRisks>) => [...p.preview, ...p.more].map(r => r.text)

describe('projectTodayRisks: 権限と順序', () => {
  it('提示順・文言を保ち、並べ替え・書き換えをしない', () => {
    const p = projectTodayRisks(fixtureDecision({ risks: ['z 最後に書かれたが先頭', 'a', 'M 大文字', '高リスク: 強い表現もそのまま'] }))
    expect(p.status).toBe('available')
    expect(texts(p)).toEqual(['z 最後に書かれたが先頭', 'a', 'M 大文字', '高リスク: 強い表現もそのまま'])
  })

  it(`先頭 ${TODAY_RISK_PREVIEW_LIMIT} 件が preview、残りは提示順のまま more（黙って捨てない）`, () => {
    const p = projectTodayRisks(fixtureDecision({ risks: RISKS }))
    expect(p.preview.map(r => r.text)).toEqual(RISKS.slice(0, TODAY_RISK_PREVIEW_LIMIT))
    expect(p.more.map(r => r.text)).toEqual(RISKS.slice(TODAY_RISK_PREVIEW_LIMIT))
    expect(p.totalCount).toBe(RISKS.length)
  })

  it('同一文言を意味で重複排除しない（id は位置ベースで一意）', () => {
    const p = projectTodayRisks(fixtureDecision({ risks: ['same', 'same', 'same'] }))
    expect(texts(p)).toEqual(['same', 'same', 'same'])
    expect(new Set([...p.preview, ...p.more].map(r => r.id)).size).toBe(3)
  })

  it('表示できない値（空白のみ / 文字列以外）は行にしないが、他の行の順序は変えない', () => {
    const bad = ['r1', '', '   ', 42, null, 'r2'] as unknown as string[]
    expect(texts(projectTodayRisks(fixtureDecision({ risks: bad })))).toEqual(['r1', 'r2'])
    const notArray = { risks: 'oops' } as unknown as Parameters<typeof fixtureDecision>[0]
    expect(projectTodayRisks(fixtureDecision(notArray)).status).toBe('none')
  })

  it('入力の risks 配列を変更しない', () => {
    const risks = ['b', 'a']
    projectTodayRisks(fixtureDecision({ risks }))
    expect(risks).toEqual(['b', 'a'])
  })
})

describe('状態の区別: 判断利用不可 ≠ risks=[]', () => {
  it('valid + risks=[] は none（行なし・安全の推論なし）', () => {
    const p = projectTodayRisks(fixtureDecision({ risks: [] }))
    expect(p.status).toBe('none')
    expect(p.totalCount).toBe(0)
    expect([...p.preview, ...p.more]).toEqual([])
  })

  it('判断利用不可は unavailable（none と区別され、行は合成しない）', () => {
    const p = projectTodayRisks(null)
    expect(p.status).toBe('unavailable')
    expect(p.status).not.toBe('none')
    expect(p.totalCount).toBe(0)
  })

  it('VM: 判断 null / headline 空は unavailable、有効な判断の risks=[] は none', () => {
    expect(assembleTodayHomeViewModel(baseInputs({ officialDecision: null })).risks.status).toBe('unavailable')
    // headline が空 = Hero と同じ権限で「利用不可」。risks が非空でも行は作らない（fail closed）。
    const unusable = fixtureDecision({ headline: '   ', risks: ['見えてはいけない'] })
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: unusable }))
    expect(vm.risks.status).toBe('unavailable')
    expect(vm.risks.totalCount).toBe(0)
    expect(assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ risks: [] }) })).risks.status).toBe('none')
  })

  it('VM: boot では risks を作らない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ systemStatus: 'initializing', officialDecision: null }))
    expect(vm.hero.state).toBe('boot')
    expect(vm.risks.totalCount).toBe(0)
  })
})

describe('LEGACY_RISK_HEURISTICS = NOT_RESTORED（旧 RiskWarningCard の閾値は移行しない）', () => {
  const extreme = {
    marketFeed: {
      marketLoaded: true, macroLoaded: true, nikkeiViLoaded: true,
      nikkei: 38_521, nikkeiChgPct: 0.6, sp500: 5_762, sp500ChgPct: 0.4, vix: 35, nikkeiVi: 30,
    },
  }

  it('VIX 35 / 日経VI 30 でも risks=[] なら canonical リスク行は 0（閾値から合成しない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ ...extreme, officialDecision: fixtureDecision({ risks: [] }) }))
    expect(vm.risks.totalCount).toBe(0)
    expect(vm.attention.filter(a => /VIX|VI |SQ|三菱|ボラ/.test(`${a.title}${a.detail}`))).toEqual([])
  })

  it('canonical に無いリスクは、他の入力（VIX / 日経VI / 現金）が何であれ増えない', () => {
    const risks = ['canonical only']
    const a = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ risks }) }))
    const b = assembleTodayHomeViewModel(baseInputs({
      ...extreme,
      deployableCash: { available: false, amount: 0, unavailableStatus: 'absent' },
      officialDecision: fixtureDecision({ risks }),
    }))
    expect(texts(a.risks)).toEqual(['canonical only'])
    expect(texts(b.risks)).toEqual(['canonical only'])
  })
})

describe('attention チップ: 表示される注意の件数と一致する', () => {
  it('canonical リスクを件数に含める（リスクが見えているのに「なし」と出さない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ risks: RISKS }) }))
    expect(vm.chips?.attentionCount).toBe(vm.attention.length + RISKS.length)
  })

  it('risks=[] で他の注意も無ければ 0', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ risks: [] }) }))
    expect(vm.chips?.attentionCount).toBe(0)
  })
})
