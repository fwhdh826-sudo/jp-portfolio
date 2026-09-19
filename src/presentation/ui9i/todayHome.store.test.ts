// UI-9I Phase 1: 実 store（createAppStoreInstanceForTest）の状態を selectTodayHomeViewModel に通す統合契約。
// projector 単体テスト（todayHome.test.ts）と違い、canonical selector との配線を検証する。
import { describe, expect, it } from 'vitest'
import type { AppState, HoldingAnalysis } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { selectTodayHomeViewModel } from './todayHome'
import { FIXTURE_NOW_MS, fixtureDecision } from './ui9i.fixtures'

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

const FRESH = '2026-10-06T08:30:00+09:00'

function ready(overrides: Partial<AppState> = {}, safeModeActive = false): AppState {
  return {
    ...BASE,
    system: {
      ...BASE.system,
      status: 'success',
      dataSourceStatus: { ...BASE.system.dataSourceStatus, market: 'loaded', macro: 'loaded', nikkeiVI: 'loaded', safeMode: 'loaded' },
      dataTimestamps: { ...(BASE.system.dataTimestamps as NonNullable<AppState['system']['dataTimestamps']>), market: '2026-10-06 08:30', safeMode: FRESH },
    },
    safeMode: { ...BASE.safeMode, safe_mode: { ...BASE.safeMode.safe_mode, active: safeModeActive, last_checked: FRESH } },
    market: { ...BASE.market, last_updated: '2026-10-06 08:30', vix: 14.8 },
    macro: BASE.macro === null ? null : { ...BASE.macro, nikkeiVI: 22.4 },
    officialDecision: fixtureDecision(),
    ...overrides,
  }
}

describe('実 store → view-model', () => {
  it('fresh store は boot: SAFE_MODE（fail-closed 既定 active）も判断不能も出さない', () => {
    expect(BASE.system.status).toBe('initializing')
    expect(BASE.safeMode.safe_mode.active).toBe(true)
    const vm = selectTodayHomeViewModel(BASE, FIXTURE_NOW_MS)
    expect(vm.hero.state).toBe('boot')
    expect(vm.hero.safeModeBanner).toBe(false)
    expect(vm.hero.headline).not.toBe('判断結果を利用できません')
  })

  it('OfficialDecision.headline が Hero（配分・候補が未計算でも判断は有効）', () => {
    const vm = selectTodayHomeViewModel(ready(), FIXTURE_NOW_MS)
    expect(vm.hero.state).toBe('normal')
    expect(vm.hero.headline).toBe('慎重運用')
    // 配分スナップショット未計算 = 配分・実行可能現金のみ利用不可。判断は無効にならない。
    expect(vm.portfolio).toBeNull()
    expect(vm.deployableCash).toEqual({ kind: 'unavailable' })
    expect(vm.candidates.status).toBe('unavailable')
    expect(vm.chips?.regime.label).toBe('判定不能')
  })

  it('銘柄単位の材料不足（analysis[].decision = INSUFFICIENT_EVIDENCE）は Hero を置換せず、注意にも出さない（局所に留まる）', () => {
    // 銘柄単位の判断材料不足は HoldingAnalysis の権限。T1（個別株）の行内で表示される。
    const insufficient = { code: '8306', decision: 'INSUFFICIENT_EVIDENCE' } as unknown as HoldingAnalysis
    const vm = selectTodayHomeViewModel(ready({ analysis: [insufficient] }), FIXTURE_NOW_MS)
    expect(vm.hero.state).toBe('normal')
    expect(vm.hero.headline).toBe('慎重運用')
    expect(JSON.stringify(vm)).not.toContain('8306')
    expect(JSON.stringify(vm)).not.toContain('判断材料不足')
    expect(vm.attention.some(a => a.id.includes('8306'))).toBe(false)
  })

  it('OfficialDecision = null（boot 後）→ 判断結果を利用できません', () => {
    const vm = selectTodayHomeViewModel(ready({ officialDecision: null }), FIXTURE_NOW_MS)
    expect(vm.hero.state).toBe('decision_unavailable')
  })

  it('SAFE_MODE は selectEffectiveSafeModeActive（raw OR 鮮度 fail-closed）に従う', () => {
    expect(selectTodayHomeViewModel(ready({}, true), FIXTURE_NOW_MS).hero.state).toBe('safe_mode')
    // raw は inactive でも、SAFE_MODE データが古ければ effective は有効
    const staleAt = '2026-10-01T08:30:00+09:00'
    const stale = ready()
    const staleState: AppState = {
      ...stale,
      system: { ...stale.system, dataTimestamps: { ...(stale.system.dataTimestamps as NonNullable<AppState['system']['dataTimestamps']>), safeMode: staleAt } },
    }
    expect(selectTodayHomeViewModel(staleState, FIXTURE_NOW_MS).hero.state).toBe('safe_mode')
  })

  it('OfficialDecision.stance=data_wait → DATA_WAIT（HOLD / 弱気 / 売却の表現を使わない）', () => {
    const vm = selectTodayHomeViewModel(
      ready({ officialDecision: fixtureDecision({ stance: 'data_wait', dataQualitySuppressed: true, noTrade: true }) }),
      FIXTURE_NOW_MS,
    )
    expect(vm.hero.state).toBe('data_wait')
    expect(vm.hero.headline).toBe('データ更新待ち')
  })

  it('VIX は market.vix、日経VI は macro.nikkeiVI（別項目・実 store の配線）', () => {
    if (BASE.macro === null) return // macro 既定が null の環境では日経VI の配線検証を省略
    const vm = selectTodayHomeViewModel(ready(), FIXTURE_NOW_MS)
    const byId = Object.fromEntries(vm.market.indicators.map(i => [i.id, i.value]))
    expect(byId.vix).toBe(14.8)
    expect(byId.nikkeiVi).toBe(22.4)
  })
})
