// UI-9I Phase 2A: 投信ハブ / その他ハブ adapter の契約（判断権限を持たない・canonical 値の写像のみ）。
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { assembleOtherHub, projectFundsHub, selectFundsHubViewModel, selectOtherHubTimestamps } from './hubPresentation'
import { gatherTodayHomeInputs } from './todayHome'
import { FUNDS_HUB_LINKS, OTHER_HUB_LINKS } from './navigation'
import { projectPortfolio } from './portfolioPresentation'
import { FIXTURE_NOW_MS, UNAVAILABLE_ALLOCATION, fixtureAllocation, fixtureClasses } from './ui9i.fixtures'

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

describe('投信ハブ adapter', () => {
  const pf = projectPortfolio(fixtureAllocation())!

  it('行は T2 / T3 / T7 の 3 件（順序固定・追加/並べ替えなし）', () => {
    const vm = projectFundsHub(pf)
    expect(vm.rows.map(r => r.link.id)).toEqual(['jp-fund', 'global-fund', 'fund-management'])
    expect(vm.rows.map(r => r.link.target.tab)).toEqual(['T2', 'T3', 'T7'])
    expect(vm.rows.map(r => r.link)).toEqual([...FUNDS_HUB_LINKS])
  })

  it('国内投信 / 海外投信は canonical currentAmount（JP_TRUST / OVERSEAS_TRUST）を短い万表記（凍結デザイン: 760万）。投信管理は値なし', () => {
    const vm = projectFundsHub(pf)
    expect(vm.rows.map(r => r.valueLabel)).toEqual(['760万', '950万', null])
    expect(vm.rows.every(r => !r.valueUnavailable)).toBe(true)
  })

  it('値は他クラスの金額を混ぜない（合計・加算・推定をしない）', () => {
    const classes = fixtureClasses().map(c =>
      c.assetClass === 'JP_TRUST' ? { ...c, currentAmount: 1_230_000 }
        : c.assetClass === 'OVERSEAS_TRUST' ? { ...c, currentAmount: 4_560_000 } : c)
    const vm = projectFundsHub(projectPortfolio(fixtureAllocation({ classes }))!)
    expect(vm.rows.map(r => r.valueLabel)).toEqual(['123万', '456万', null])
    const text = JSON.stringify(vm)
    expect(text).not.toContain('579万') // 123 + 456 の合計は作らない
  })

  it('目標との差は Portfolio adapter の gapText と同一文字列（方向は targetGap / overweightAmount のみ）', () => {
    const vm = projectFundsHub(pf)
    expect(vm.gapRows).toEqual([
      { assetClass: 'JP_TRUST', label: '国内投信', text: '20 / 20 ・目標水準' },
      { assetClass: 'OVERSEAS_TRUST', label: '海外投信', text: '25 / 25 ・目標水準' },
    ])
  })

  it('国内投信が不足 / 海外投信が超過でも、方向語は canonical フィールドのみで決まる', () => {
    const classes = fixtureClasses().map(c =>
      c.assetClass === 'JP_TRUST' ? { ...c, currentAmount: 6_460_000, targetAmount: 7_600_000, targetGap: 1_140_000, overweightAmount: 0 }
        : c.assetClass === 'OVERSEAS_TRUST' ? { ...c, currentAmount: 10_000_000, targetAmount: 9_500_000, targetGap: 0, overweightAmount: 500_000 } : c)
    const vm = projectFundsHub(projectPortfolio(fixtureAllocation({ classes }))!)
    expect(vm.gapRows?.map(r => r.text)).toEqual(['17 / 20 ・不足 114万円', '26 / 25 ・超過 50万円'])
  })

  it('配分スナップショット利用不可: 値は「利用不可」、目標との差は null。行（到達性）は失わない', () => {
    const vm = projectFundsHub(projectPortfolio(UNAVAILABLE_ALLOCATION))
    expect(vm.rows.map(r => r.valueLabel)).toEqual(['利用不可', '利用不可', null])
    expect(vm.rows.slice(0, 2).every(r => r.valueUnavailable)).toBe(true)
    expect(vm.gapRows).toBeNull()
    expect(vm.rows).toHaveLength(3)
    expect(JSON.stringify(vm)).not.toMatch(/"valueLabel":"0/)
  })

  it('canonical 行が欠けているクラスは 0 ではなく「利用不可」/「判定不能」', () => {
    const classes = fixtureClasses().filter(c => c.assetClass !== 'OVERSEAS_TRUST')
    const vm = projectFundsHub(projectPortfolio(fixtureAllocation({ classes }))!)
    expect(vm.rows[1].valueLabel).toBe('利用不可')
    expect(vm.gapRows?.[1].text).toBe('判定不能')
  })

  it('スコア・順位・推奨・実行アクションに相当するフィールドを持たない（判断権限なし）', () => {
    const keys = JSON.stringify(Object.keys(projectFundsHub(pf))) + JSON.stringify(Object.keys(projectFundsHub(pf).rows[0]))
    expect(keys).not.toMatch(/score|rank|recommend|action|executable|amount(?!Label)/i)
  })

  it('実 store（未算出）: 配分が無くてもハブは成立し、値は「利用不可」', () => {
    const vm = selectFundsHubViewModel(BASE)
    expect(vm.rows).toHaveLength(3)
    expect(vm.rows[0].valueLabel).toBe('利用不可')
  })
})

describe('その他ハブ adapter', () => {
  it('リンクは ニュース / AI委員会 / 学習・検証 / 設定（T5 / T6 / T8 / T9）+ 従来のホーム', () => {
    const vm = assembleOtherHub({ decisionGeneratedAt: null, marketAt: null, candidatesAt: null })
    expect(vm.links).toEqual([...OTHER_HUB_LINKS])
    expect(vm.links.slice(0, 4).map(l => [l.title, l.target.tab])).toEqual([
      ['ニュース', 'T5'], ['AI委員会', 'T6'], ['学習・検証', 'T8'], ['設定', 'T9'],
    ])
  })

  it('システム欄: 判断生成 / 市場データ / 候補データを個別の絶対時刻（JST）で表示、バージョン 13.3', () => {
    const vm = assembleOtherHub({
      decisionGeneratedAt: '2026-10-06T08:30:00+09:00',
      marketAt: '2026-10-06 08:30',
      candidatesAt: '2026-10-06T07:55:00+09:00',
    })
    expect(vm.system.map(r => [r.label, r.value])).toEqual([
      ['判断生成', '10/6 8:30'], ['市場データ', '10/6 8:30'], ['候補データ', '10/6 7:55'], ['バージョン', '13.3'],
    ])
  })

  it('時刻が不明な行だけが「利用不可」。他の行・全体へ波及しない（「更新 · 正常」にまとめない）', () => {
    const vm = assembleOtherHub({ decisionGeneratedAt: null, marketAt: '2026-10-06 08:30', candidatesAt: null })
    expect(vm.system.map(r => r.value)).toEqual(['利用不可', '10/6 8:30', '利用不可', '13.3'])
    expect(vm.system.map(r => r.unavailable)).toEqual([true, false, true, false])
    expect(JSON.stringify(vm)).not.toMatch(/正常|OK|問題なし/)
  })

  it('市場 / 候補の時刻導出は Home の gatherTodayHomeInputs と同値（Home 側を変更せず parity で固定）', () => {
    const states: AppState[] = [
      BASE,
      {
        ...BASE,
        market: { ...BASE.market, last_updated: '2026-10-06 08:30' },
        system: { ...BASE.system, dataTimestamps: { ...(BASE.system.dataTimestamps as NonNullable<AppState['system']['dataTimestamps']>), market: '2026-10-06 08:31', candidateFunnel: '2026-10-06T07:55:00+09:00', candidatesStocks: '2026-10-05T07:00:00+09:00' } },
      },
      {
        ...BASE,
        system: { ...BASE.system, dataTimestamps: { ...(BASE.system.dataTimestamps as NonNullable<AppState['system']['dataTimestamps']>), market: null, candidateFunnel: null, candidatesStocks: '2026-10-05T07:00:00+09:00' } },
      },
    ]
    for (const state of states) {
      const home = gatherTodayHomeInputs(state, FIXTURE_NOW_MS).timestamps
      const hub = selectOtherHubTimestamps(state)
      expect({ market: hub.marketAt, candidates: hub.candidatesAt }).toEqual(home)
    }
  })

  it('OfficialDecision が無い場合は「判断生成」行だけが利用不可（Decision unavailable を全体に広げない）', () => {
    const vm = assembleOtherHub(selectOtherHubTimestamps({ ...BASE, officialDecision: null }))
    expect(vm.system[0]).toMatchObject({ id: 'decision', value: '利用不可', unavailable: true })
    expect(vm.links).toHaveLength(5)
  })
})
