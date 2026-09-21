// UI-9I Phase 1: Decision Audit（判断の詳細）— 別 detail surface としての契約。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { FIXTURE_NOW_MS, fixtureDecision } from '../../presentation/ui9i/ui9i.fixtures'

// allocation の権限は本テストの対象外（別 suite で検証済み）。unavailable を既定にして境界を固定する。
vi.mock('../../store/allocationConsumerSelectors', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/allocationConsumerSelectors')>()
  return {
    ...actual,
    selectAllocationConsumerSnapshot: () => ({ availability: 'unavailable', status: 'absent', reasonKind: 'NOT_CALCULATED' }),
    selectExecutableDeployableCash: () => ({ available: false, amount: 0, unavailableStatus: 'absent' }),
  }
})

const { selectDecisionAuditViewModel } = await import('../../presentation/ui9i/decisionAudit')
const { DecisionAuditView } = await import('./DecisionAudit')

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

const FRESH_AT = '2026-10-06T08:30:00+09:00'

function readyState(overrides: Partial<AppState> = {}, safeModeActive = false, safeModeCheckedAt: string = FRESH_AT): AppState {
  return {
    ...BASE,
    system: {
      ...BASE.system,
      status: 'success',
      dataSourceStatus: { ...BASE.system.dataSourceStatus, market: 'loaded', safeMode: 'loaded', tierAViolations: 'loaded', tierAAlerts: 'loaded' },
      dataTimestamps: { ...(BASE.system.dataTimestamps as NonNullable<AppState['system']['dataTimestamps']>), market: '2026-10-06 08:30', safeMode: safeModeCheckedAt },
    },
    safeMode: {
      ...BASE.safeMode,
      safe_mode: {
        ...BASE.safeMode.safe_mode,
        active: safeModeActive,
        last_checked: safeModeCheckedAt,
        estimated_resume_at: null,
        trigger_conditions: { tier1_data_stale: true, tier_a_t3_violated: false, crisis_regime: false, system_error: false },
        restrictions: { new_buys_frozen: true, rebalance_frozen: true, force_sell_active: false },
      },
    },
    tierAViolations: { ...BASE.tierAViolations, status: 'ok', summary: { total_violations: 0, t3_count: 0, safe_mode_related_count: 0 } },
    tierAAlerts: { ...BASE.tierAAlerts, status: 'ok', summary: { total_triggered: 1, highest_level: 'L1' } },
    officialDecision: fixtureDecision(),
    ...overrides,
  }
}

const actions = { onBack: () => {}, onOpenCommittee: () => {}, onOpenStocks: () => {}, onOpenPortfolio: () => {} }
const html = (state: AppState) =>
  renderToStaticMarkup(<DecisionAuditView vm={selectDecisionAuditViewModel(state, FIXTURE_NOW_MS)} actions={actions} />)

describe('Decision Audit の構成（固定順・第二のダッシュボードにしない）', () => {
  const out = html(readyState())
  const order = [
    'data-testid="audit-recap"', 'data-testid="audit-rationale"', 'data-testid="audit-constraints"',
    'data-testid="audit-candidates"', 'data-testid="audit-portfolio"', 'data-testid="audit-evidence"', 'data-testid="audit-links"',
  ]

  it('Recap → Rationale → Binding Constraints → Candidate Execution State → Portfolio Impact → Evidence → Deep Links', () => {
    const positions = order.map(o => out.indexOf(o))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('Recap は OfficialDecision.headline と判断生成時刻', () => {
    expect(out).toContain('慎重運用')
    expect(out).toContain('判断生成 10/6 8:30')
  })

  it('Rationale は rationale[] を提示順のまま（重み・重要度を付与しない）', () => {
    const p1 = out.indexOf('市場レジームは中立で、運用モードは通常です。')
    const p2 = out.indexOf('現在の配分と目標配分を確認しています。')
    const p3 = out.indexOf('実行条件を満たす候補は現時点でありません。')
    expect(p1).toBeGreaterThan(-1)
    expect(p1).toBeLessThan(p2)
    expect(p2).toBeLessThan(p3)
    expect(out).toContain('表示順のみ')
    expect(out).toContain('>01<')
  })

  it('実行可能現金は利用不可のとき「利用不可」（¥0 にしない）。金額は UI で計算しない', () => {
    expect(out).toMatch(/data-testid="audit-deployable-cash">利用不可</)
    expect(out).not.toContain('¥0')
    expect(out).toContain('金額は権限が提示した場合のみ表示します。UI では計算しません。')
  })

  it('Evidence はデータセット別の絶対時刻（全体の「正常」にまとめない）', () => {
    expect(out).toContain('市場データ')
    expect(out).toContain('10/6 8:30')
    expect(out).toContain('ひとつの遅延から全体の無効は推定しません')
  })

  it('Deep Links: AI委員会 / 個別株 / ポートフォリオ。戻る導線に aria-label', () => {
    expect(out).toContain('AI委員会の議論を見る')
    expect(out).toContain('個別株の判断を見る')
    expect(out).toContain('ポートフォリオを見る')
    expect(out).toContain('aria-label="今日に戻る"')
  })

  it('normal では SAFE_MODE 詳細を出さない', () => {
    expect(out).not.toContain('data-testid="audit-safe-mode"')
  })
})

describe('90日ロックは isSellLocked / getSellableDate を再掲（残日数を計算しない）', () => {
  it('効いている制約に売却可能予定日を表示', () => {
    const state = readyState({ holdings: [{ ...BASE.holdings[0], code: '9697', name: 'X', lock: true, acquiredAt: '2026-07-22' }] })
    const vm = selectDecisionAuditViewModel(state, FIXTURE_NOW_MS)
    expect(vm.constraints.locks).toEqual([{ code: '9697', sellableLabel: '10/20' }])
    const out = html(state)
    expect(out).toContain('90日ロック中 · 9697')
    expect(out).toContain('売却可能予定日 10/20')
  })
})

describe('SAFE_MODE 詳細: 実効判定・元データ・鮮度・Tier A・発動条件・制限・再開見込を分ける', () => {
  it('raw inactive でも SAFE_MODE データが古ければ effective 有効（fail-closed）。両者を混同しない', () => {
    const stale = '2026-10-01T08:30:00+09:00' // SAFE_MODE_STALE_HOURS(96h) 超過
    const state = readyState({}, false, stale)
    const vm = selectDecisionAuditViewModel(state, FIXTURE_NOW_MS)
    expect(vm.recap.state).toBe('safe_mode')
    expect(vm.safeMode?.effective).toBe('有効')
    expect(vm.safeMode?.raw).toBe('inactive')
    expect(vm.safeMode?.freshness).toBe('鮮度低下')
  })

  it('各項目が別 row として存在する', () => {
    const out = html(readyState({}, true))
    for (const label of ['実効判定', '元データの状態', '権限の鮮度', 'Tier A 重大違反', 'Tier A アラート', 'Tier1 データの鮮度低下', 'Tier A T3 違反', '危機レジーム', 'システムエラー', '新規買付', 'リバランス', '強制売却', '再開見込']) {
      expect(out, label).toContain(label)
    }
    expect(out).toContain('active')
    expect(out).toContain('停止中')
    expect(out).toContain('未発動')
    expect(out).toContain('未定')
    expect(out).toContain('1件') // Tier A アラート
    expect(out).toContain('SAFE_MODE の権限そのものを確認できない場合に安全側（有効）へ倒します。他のデータセットの利用不可には適用しません。')
  })

  it('SAFE_MODE 権限を取得できていないときは「取得できません」（active と偽らない）', () => {
    const state = readyState({}, true)
    const notLoaded: AppState = { ...state, system: { ...state.system, dataSourceStatus: { ...state.system.dataSourceStatus, safeMode: 'default' } } }
    const vm = selectDecisionAuditViewModel(notLoaded, FIXTURE_NOW_MS)
    expect(vm.safeMode?.raw).toBe('取得できません')
    expect(vm.safeMode?.conditions.every(c => c.value === '確認できません')).toBe(true)
  })
})

describe('判断結果を利用できません', () => {
  it('rationale を出さず、過去の判断を現在として扱わない', () => {
    const state = readyState({ officialDecision: null })
    const vm = selectDecisionAuditViewModel(state, FIXTURE_NOW_MS)
    expect(vm.recap.state).toBe('decision_unavailable')
    expect(vm.recap.headline).toBe('判断結果を利用できません')
    expect(vm.rationale).toEqual([])
    expect(html(state)).toContain('判断結果を取得できていないため、根拠を表示できません。')
  })
})
