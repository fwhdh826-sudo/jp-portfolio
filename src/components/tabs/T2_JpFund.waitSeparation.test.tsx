// UI-9H-H1-R1: WATCH の3義（真の監視 / 条件未達WAIT / 抑制されたBUY）のうち、
// H-P0-2 の前回実装では③抑制のみを SUPPRESSED へ分離し、②条件未達WAIT
// （Trust['decision']==='WAIT' → decisionToSignal）は WATCH のまま残っていた。
// ここでは T2 の個別ファンドバッジが WAIT/「待機」を出し、WATCH/「監視」に
// 潰れないことを実 render で固定する。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Trust } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T2 wait-separation fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { T2_JpFund, signalFromShortTerm, decisionToSignal } = await import('./T2_JpFund')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

const NOW_ISO = new Date().toISOString()

function fund(id: string, decision: Trust['decision']): Trust {
  return {
    id,
    name:    `テスト国内投信 ${id}`,
    abbr:    id,
    account: 'test-only',
    policy:  'JAPAN_SHORTTERM',
    eval:    500_000,
    pnlPct:  0,
    dayPct:  0,
    cost:    0.1,
    mu:      0.1,
    sigma:   0.1,
    score:   50,
    signal:  'HOLD',
    ev:      0,
    decision,
  }
}

/** market/DQ は健全、SAFE_MODE も解除済み = 抑制なしの通常状態（T3/T7の抑制テストと同一パターン）。 */
function normalState(decision: Trust['decision']): AppState {
  return {
    ...BASE_APP_STATE,
    trust: [fund('T2-FUND', decision)],
    market: { ...BASE_APP_STATE.market, regime: 'bull', vix: 15, last_updated: NOW_ISO },
    system: {
      ...BASE_APP_STATE.system,
      status: 'success',
      lastUpdated: NOW_ISO,
      dataSourceStatus: { ...BASE_APP_STATE.system.dataSourceStatus, market: 'loaded', safeMode: 'loaded' },
      dataTimestamps:   { ...BASE_APP_STATE.system.dataTimestamps!, market: NOW_ISO, safeMode: NOW_ISO },
    },
    safeMode: {
      ...BASE_APP_STATE.safeMode,
      safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: false, last_checked: NOW_ISO },
    },
  }
}

/** real SAFE_MODE: safe_mode.json を取得済み・鮮度OK・active=true。 */
function suppressedState(decision: Trust['decision']): AppState {
  const base = normalState(decision)
  return {
    ...base,
    safeMode: {
      ...base.safeMode,
      safe_mode: { ...base.safeMode.safe_mode, active: true, last_checked: NOW_ISO },
    },
  }
}

function renderWith(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T2_JpFund />)
}

// UI-9H P1 H-P1-6: 可視グリフは日本語cfg.labelへ変更されたため、SignalBadgeが
// data-signal属性に保持する旧英語tokenとaria-labelから抽出する。
/** SignalBadge が実際に描画した verdict token とその aria-label を数える。 */
function verdictBadges(html: string): { token: string; ariaLabel: string }[] {
  return [...html.matchAll(/data-signal="([A-Z]+)" aria-label="(シグナル: [^"]*)"/g)].map(([, token, ariaLabel]) => ({ token, ariaLabel }))
}

describe('UI-9H-H1-R1: T2 個別ファンドバッジ — 条件未達WAITとWATCHの分離', () => {
  it('decision=WAIT のファンドは WAIT バッジ（aria-label「シグナル: 待機」）で描画される', () => {
    const badges = verdictBadges(renderWith(normalState('WAIT')))
    expect(badges.some(b => b.token === 'WAIT' && b.ariaLabel === 'シグナル: 待機')).toBe(true)
  })

  // mutation guard: decisionToSignal の `if (d === 'WAIT') return 'WAIT'` を
  // 旧実装の `return 'WATCH'` に戻すとこのテストが RED になる。
  it('[mutation guard] decision=WAIT のファンドバッジは WATCH（監視）ではない', () => {
    const badges = verdictBadges(renderWith(normalState('WAIT')))
    expect(badges.some(b => b.token === 'WATCH')).toBe(false)
  })

  it('decision=BUY のファンドは通常時 BUY バッジのまま描画される（vacuous回避）', () => {
    const badges = verdictBadges(renderWith(normalState('BUY')))
    expect(badges.some(b => b.token === 'BUY')).toBe(true)
  })

  it('SAFE_MODE抑制中でも decision=WAIT のファンドは WAIT のまま（SUPPRESSEDへ誤変換されない。抑制対象はBUYのみ）', () => {
    const badges = verdictBadges(renderWith(suppressedState('WAIT')))
    expect(badges.some(b => b.token === 'WAIT')).toBe(true)
    expect(badges.some(b => b.token === 'WATCH')).toBe(false)
  })

  it('SAFE_MODE抑制中の decision=BUY ファンドは SUPPRESSED になり、WAIT にもWATCHにもBUYにもならない', () => {
    const badges = verdictBadges(renderWith(suppressedState('BUY')))
    expect(badges.some(b => b.token === 'SUPPRESSED')).toBe(true)
    expect(badges.some(b => b.token === 'BUY')).toBe(false)
    expect(badges.some(b => b.token === 'WAIT')).toBe(false)
    expect(badges.some(b => b.token === 'WATCH')).toBe(false)
  })
})

describe('UI-9H-H1-R1: T2 decisionToSignal / signalFromShortTerm — 直接ユニット', () => {
  it('decisionToSignal(WAIT) は WAIT を返す（WATCHではない）', () => {
    expect(decisionToSignal('WAIT')).toBe('WAIT')
    expect(decisionToSignal('WAIT')).not.toBe('WATCH')
  })

  it('signalFromShortTerm(WAIT) は WAIT を返す（WATCHではない）', () => {
    expect(signalFromShortTerm('WAIT')).toBe('WAIT')
    expect(signalFromShortTerm('WAIT')).not.toBe('WATCH')
  })

  it('BUY/SELL/HOLD系マッピングはWAIT分離の影響を受けない（回帰確認）', () => {
    expect(decisionToSignal('BUY')).toBe('BUY')
    expect(decisionToSignal('SELL')).toBe('SELL')
    expect(decisionToSignal('HOLD')).toBe('HOLD')
    expect(signalFromShortTerm('BULL')).toBe('BUY')
    expect(signalFromShortTerm('BEAR')).toBe('SELL')
  })
})
