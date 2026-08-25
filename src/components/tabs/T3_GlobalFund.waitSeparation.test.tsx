// UI-9H-H1-R1: WATCH の3義（真の監視 / 条件未達WAIT / 抑制されたBUY）のうち、
// H-P0-2 の前回実装では③抑制のみを SUPPRESSED へ分離し、②条件未達WAIT
// （Trust['decision']==='WAIT' → decisionToSignal）は WATCH のまま残っていた。
// ここでは T3 の個別ファンドバッジが WAIT/「待機」を出し、WATCH/「監視」に
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
      if (mockedStore.state === null) throw new Error('T3 wait-separation fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { T3_GlobalFund, decisionToSignal } = await import('./T3_GlobalFund')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

const NOW_ISO = new Date().toISOString()

function fund(id: string, decision: Trust['decision']): Trust {
  return {
    id,
    name:    `テスト海外投信 ${id}`,
    abbr:    id,
    account: 'NISA',
    policy:  'OVERSEAS_LONGTERM',
    eval:    1_000_000,
    pnlPct:  8.2,
    dayPct:  0.4,
    cost:    0.09,
    mu:      0.06,
    sigma:   0.15,
    score:   72,
    signal:  'BULL',
    ev:      0.05,
    decision,
  }
}

/** market/DQ は健全、SAFE_MODE も解除済み = 抑制なしの通常状態。 */
function normalState(funds: Trust[]): AppState {
  return {
    ...BASE_APP_STATE,
    trust: funds,
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
function suppressedState(funds: Trust[]): AppState {
  const base = normalState(funds)
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
  return renderToStaticMarkup(<T3_GlobalFund />)
}

/** SignalBadge が実際に描画した verdict token とその aria-label を数える。 */
// UI-9H P1 H-P1-6: 可視グリフは日本語cfg.labelへ変更されたため、SignalBadgeが
// data-signal属性に保持する旧英語tokenとaria-labelから抽出する。
function verdictBadges(html: string): { token: string; ariaLabel: string }[] {
  return [...html.matchAll(/data-signal="([A-Z]+)" aria-label="(シグナル: [^"]*)"/g)].map(([, token, ariaLabel]) => ({ token, ariaLabel }))
}

describe('UI-9H-H1-R1: T3 個別ファンドバッジ — 条件未達WAITとWATCHの分離', () => {
  it('decision=WAIT のファンドは WAIT バッジ（aria-label「シグナル: 待機」）で描画される', () => {
    const badges = verdictBadges(renderWith(normalState([fund('GF-WAIT', 'WAIT'), fund('GF-BUY', 'BUY')])))
    expect(badges.some(b => b.token === 'WAIT' && b.ariaLabel === 'シグナル: 待機')).toBe(true)
  })

  // mutation guard: decisionToSignal の `if (d === 'WAIT') return 'WAIT'` を
  // 旧実装の `return 'WATCH'` に戻すとこのテストが RED になる。
  it('[mutation guard] decision=WAIT のファンドバッジは WATCH（監視）ではない', () => {
    const badges = verdictBadges(renderWith(normalState([fund('GF-WAIT', 'WAIT'), fund('GF-BUY', 'BUY')])))
    expect(badges.some(b => b.token === 'WATCH')).toBe(false)
  })

  it('decision=BUY のファンドは通常時 BUY バッジのまま描画される（vacuous回避）', () => {
    const badges = verdictBadges(renderWith(normalState([fund('GF-BUY', 'BUY')])))
    expect(badges.some(b => b.token === 'BUY')).toBe(true)
  })

  it('SAFE_MODE抑制中でも decision=WAIT のファンドは WAIT のまま（SUPPRESSEDへ誤変換されない。抑制対象はBUYのみ）', () => {
    const badges = verdictBadges(renderWith(suppressedState([fund('GF-WAIT', 'WAIT'), fund('GF-BUY', 'BUY')])))
    expect(badges.some(b => b.token === 'WAIT')).toBe(true)
    expect(badges.some(b => b.token === 'WATCH')).toBe(false)
  })

  it('SAFE_MODE抑制中の decision=BUY ファンドは SUPPRESSED になり、WAIT にもWATCHにもBUYにもならない', () => {
    const badges = verdictBadges(renderWith(suppressedState([fund('GF-BUY', 'BUY')])))
    expect(badges.some(b => b.token === 'SUPPRESSED')).toBe(true)
    expect(badges.some(b => b.token === 'BUY')).toBe(false)
    expect(badges.some(b => b.token === 'WAIT')).toBe(false)
    expect(badges.some(b => b.token === 'WATCH')).toBe(false)
  })
})

describe('UI-9H-H1-R1: T3 decisionToSignal — 直接ユニット', () => {
  it('decisionToSignal(WAIT) は WAIT を返す（WATCHではない）', () => {
    expect(decisionToSignal('WAIT')).toBe('WAIT')
    expect(decisionToSignal('WAIT')).not.toBe('WATCH')
  })

  it('BUY/SELL/HOLD系マッピングはWAIT分離の影響を受けない（回帰確認）', () => {
    expect(decisionToSignal('BUY')).toBe('BUY')
    expect(decisionToSignal('SELL')).toBe('SELL')
    expect(decisionToSignal('HOLD')).toBe('HOLD')
  })
})
