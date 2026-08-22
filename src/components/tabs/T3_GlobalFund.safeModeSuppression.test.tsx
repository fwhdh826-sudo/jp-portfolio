// UI-9F-B — F-P0-1 required tests.
// T3 が既存の BUY suppression authority（selectEffectiveSafeModeActive /
// selectMarketDataQuality.isSuppressed）を迂回して BUY badge・追加投資推奨文言を
// 出していた経路が塞がれたことを、実コンポーネントの render 出力で固定する。
//
// 併せて「抑制は表示層のみ」であること（store の fund.decision が 'BUY' のまま）と、
// 抑制解除時に既存の正常表示が維持されることを回帰として固定する。
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
      if (mockedStore.state === null) throw new Error('T3 suppression fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { T3_GlobalFund } = await import('./T3_GlobalFund')

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

// BUY 5件 + HOLD 1件（BUY > SELL なので overallSignal は 'BUY' になる）
const GLOBAL_FUNDS: Trust[] = [
  fund('GF1', 'BUY'), fund('GF2', 'BUY'), fund('GF3', 'BUY'),
  fund('GF4', 'BUY'), fund('GF5', 'BUY'), fund('GF6', 'HOLD'),
]

/** market/DQ は健全、SAFE_MODE も解除済み = 抑制なしの通常状態。 */
function normalState(): AppState {
  return {
    ...BASE_APP_STATE,
    trust: GLOBAL_FUNDS,
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
function realSafeModeState(): AppState {
  const base = normalState()
  return {
    ...base,
    safeMode: {
      ...base.safeMode,
      safe_mode: { ...base.safeMode.safe_mode, active: true, last_checked: NOW_ISO },
    },
  }
}

/** SAFE_MODE は解除だが market が static = DQ による suppression のみ。 */
function dqSuppressedState(): AppState {
  const base = normalState()
  return {
    ...base,
    system: {
      ...base.system,
      dataSourceStatus: { ...base.system.dataSourceStatus, market: 'static' },
    },
  }
}

/** SAFE_MODE は解除だが market timestamp が古い = stale による suppression のみ。 */
function staleSuppressedState(): AppState {
  const staleIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const base = normalState()
  return {
    ...base,
    market: { ...base.market, last_updated: staleIso },
    system: {
      ...base.system,
      dataTimestamps: { ...base.system.dataTimestamps!, market: staleIso },
    },
  }
}

/** safe_mode.json 自体が stale = fail-closed で実効 SAFE_MODE。 */
function staleSafeModeState(): AppState {
  const staleIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const base = normalState()
  return {
    ...base,
    system: {
      ...base.system,
      dataTimestamps: { ...base.system.dataTimestamps!, safeMode: staleIso },
    },
    safeMode: {
      ...base.safeMode,
      safe_mode: { ...base.safeMode.safe_mode, active: false, last_checked: staleIso },
    },
  }
}

function renderWith(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T3_GlobalFund />)
}

/** SignalBadge が実際に描画した verdict token だけを数える（本文中の "BUY" 文字列は数えない）。 */
function verdictBadges(html: string): string[] {
  return [...html.matchAll(/aria-label="シグナル: [^"]*">([A-Z]+)</g)].map(m => m[1])
}

// ── vacuous 回避: fix 前の挙動（= 抑制なし）が実際に BUY を出すことを先に固定する ──
describe('F-P0-1 非抑制時: T3 は既存の正常表示を維持する', () => {
  it('BUY verdict badge が描画される（抑制テストが vacuous でないことの証明）', () => {
    const badges = verdictBadges(renderWith(normalState()))
    expect(badges.filter(b => b === 'BUY').length).toBeGreaterThan(0)
  })

  it('「積立継続 + 追加検討」と買付示唆文言が表示される', () => {
    const html = renderWith(normalState())
    expect(html).toContain('積立継続 + 追加検討')
    expect(html).toContain('余裕資金での追加投資を検討可')
  })

  it('VIX 安定圏の説明文「余裕資金で追加検討も可」が表示される', () => {
    expect(renderWith(normalState())).toContain('余裕資金で追加検討も可')
  })

  it('抑制中バナー「追加投資判断 停止中」は表示されない', () => {
    expect(renderWith(normalState())).not.toContain('追加投資判断 停止中')
  })
})

describe('F-P0-1 real SAFE_MODE: T3 は BUY badge を1件も出さない', () => {
  it('verdict badge の BUY が 0 件', () => {
    const badges = verdictBadges(renderWith(realSafeModeState()))
    expect(badges.filter(b => b === 'BUY')).toHaveLength(0)
  })

  it('hero DecisionCard の判定が BUY ではない', () => {
    const html = renderWith(realSafeModeState())
    expect(html).not.toContain('aria-label="判定: BUY"')
  })

  it('BUY 判定ファンドのバッジは WATCH（抑制 token）に変換される', () => {
    const badges = verdictBadges(renderWith(realSafeModeState()))
    expect(badges.filter(b => b === 'WATCH').length).toBeGreaterThanOrEqual(5)
  })
})

describe('F-P0-1 real SAFE_MODE: BUY 誘導文言が 0 件', () => {
  const html = () => renderWith(realSafeModeState())

  it('「余裕資金」を含む文言が 0 件', () => {
    expect(html()).not.toContain('余裕資金')
  })

  it('「積立継続 + 追加検討」が表示されない', () => {
    expect(html()).not.toContain('積立継続 + 追加検討')
  })

  it('「追加投資を検討可」が表示されない', () => {
    expect(html()).not.toContain('追加投資を検討可')
  })

  it('「追加検討も可」が表示されない（VIXカードの買付示唆）', () => {
    expect(html()).not.toContain('追加検討も可')
  })

  it('抑制の告知（追加投資判断 停止中）が表示される', () => {
    expect(html()).toContain('追加投資判断 停止中')
  })
})

describe('F-P0-1 抑制は表示層のみ — domain state は書き換えない', () => {
  it('render 後も store の fund.decision は BUY のまま', () => {
    const state = realSafeModeState()
    renderWith(state)
    expect(state.trust.filter(f => f.decision === 'BUY')).toHaveLength(5)
    expect(GLOBAL_FUNDS.filter(f => f.decision === 'BUY')).toHaveLength(5)
  })

  it('抑制 on/off で fund.score / 件数は完全一致（再計算していない）', () => {
    renderWith(normalState())
    const afterNormal = GLOBAL_FUNDS.map(f => `${f.id}:${f.decision}:${f.score}`)
    renderWith(realSafeModeState())
    const afterSuppressed = GLOBAL_FUNDS.map(f => `${f.id}:${f.decision}:${f.score}`)
    expect(afterSuppressed).toEqual(afterNormal)
  })
})

describe('F-P0-1 SAFE_MODE 以外の既存 suppression authority も同じ経路を通る', () => {
  it('DQ suppression（market=static）でも BUY badge 0 件', () => {
    const badges = verdictBadges(renderWith(dqSuppressedState()))
    expect(badges.filter(b => b === 'BUY')).toHaveLength(0)
  })

  it('DQ suppression でも「余裕資金」0 件', () => {
    expect(renderWith(dqSuppressedState())).not.toContain('余裕資金')
  })

  it('stale market data でも BUY badge 0 件', () => {
    const badges = verdictBadges(renderWith(staleSuppressedState()))
    expect(badges.filter(b => b === 'BUY')).toHaveLength(0)
  })

  it('safe_mode.json が stale（fail-closed）でも BUY badge 0 件', () => {
    const badges = verdictBadges(renderWith(staleSafeModeState()))
    expect(badges.filter(b => b === 'BUY')).toHaveLength(0)
  })
})

// mutation guard: suppression bypass を復元（displayOverallSignal / FundRow の
// suppressBuySignal / continuationJudgment の抑制分岐 / vi.desc のガードのいずれかを外す）と
// この describe が RED になる。
describe('[mutation guard] F-P0-1 suppression bypass の復活検出', () => {
  const suppressed: [string, () => AppState][] = [
    ['real SAFE_MODE',   realSafeModeState],
    ['DQ (static)',      dqSuppressedState],
    ['stale market',     staleSuppressedState],
    ['stale safe_mode',  staleSafeModeState],
  ]

  for (const [name, factory] of suppressed) {
    it(`${name}: BUY badge 0 件 かつ BUY 誘導文言 0 件`, () => {
      const html = renderWith(factory())
      expect(verdictBadges(html).filter(b => b === 'BUY')).toHaveLength(0)
      expect(html).not.toContain('aria-label="判定: BUY"')
      expect(html).not.toContain('余裕資金')
      expect(html).not.toContain('積立継続 + 追加検討')
    })
  }
})
