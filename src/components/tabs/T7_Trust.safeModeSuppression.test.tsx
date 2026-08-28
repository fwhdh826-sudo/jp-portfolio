// UI-9H H-P0-2: T7 の運用方針別ファンドカードは suppressBuySignal を経由しない
// 独自の fSig/fundBadgeLabel 判定を持っていた（'WATCH' 固定比較）。
// SUPPRESSED_VERDICT を 'WATCH' から 'SUPPRESSED' へ分離した際、この比較を
// 追随させないと抑制中に生の item.decision（'BUY'）へフォールバックし、
// BUY 抑制が破れる回帰になる。ここではその経路を実 render で固定する。
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
      if (mockedStore.state === null) throw new Error('T7 suppression fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { T7_Trust, fundDecisionLabel } = await import('./T7_Trust')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

const NOW_ISO = new Date().toISOString()

function fund(id: string, decision: Trust['decision']): Trust {
  return {
    id,
    name:    `テスト国内投信 ${id}`,
    abbr:    id,
    account: 'NISA',
    policy:  'JAPAN_SHORTTERM',
    eval:    500_000,
    pnlPct:  1.2,
    dayPct:  0.1,
    cost:    0.15,
    mu:      0.04,
    sigma:   0.2,
    score:   65,
    signal:  'BULL',
    ev:      0.03,
    decision,
  }
}

const JP_FUNDS: Trust[] = [
  fund('JF1', 'BUY'), fund('JF2', 'BUY'), fund('JF3', 'HOLD'),
]

function normalState(): AppState {
  return {
    ...BASE_APP_STATE,
    trust: JP_FUNDS,
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

function renderWith(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T7_Trust />)
}

describe('UI-9H H-P0-2: T7 運用方針別ファンドカードの抑制表示（fundBadgeLabel回帰guard）', () => {
  it('非抑制時はBUYファンドがBUYバッジで表示される（vacuous回避）', () => {
    const html = renderWith(normalState())
    // UI-9H P1 H-P1-6: 可視グリフは日本語cfg.labelへ変更されたため、旧英語tokenは
    // data-signal属性で検証する（P0のtoken分離自体は不変）。
    expect(html).toContain('data-signal="BUY"')
    expect(html).toContain('aria-label="シグナル: 買い"')
    expect(html).not.toContain('>BULL<')
  })

  it('SAFE_MODE中はBUY判定ファンドのバッジがSUPPRESSEDへ変換され、生のBUYは1件も残らない', () => {
    const html = renderWith(realSafeModeState())
    // fundBadgeLabel が fSig==='WATCH' 比較のまま残っていると、SUPPRESSED_VERDICT
    // が 'SUPPRESSED' に変わった時点でこの分岐が false になり item.decision
    // （生の 'BUY'）が描画されてしまう。この assertion がその回帰を検知する。
    expect(html).not.toContain('data-signal="BUY"')
    expect(html).toContain('data-signal="SUPPRESSED"')
    expect(html).toContain('aria-label="シグナル: 新規買付停止"')
  })
})

describe('UI-P2-1 I-2: T7ファンド判定ラベルとdomain tokenの分離', () => {
  it('domain tokenを変えず、可視ラベルだけを正典の日本語へ変換する', () => {
    const signals = ['BUY', 'HOLD', 'WATCH', 'WAIT', 'SELL', 'SUPPRESSED'] as const
    expect(signals.map(fundDecisionLabel)).toEqual([
      '買い', '保有継続', '監視', '待機', '売却', '新規買付停止',
    ])
    expect(signals).toEqual(['BUY', 'HOLD', 'WATCH', 'WAIT', 'SELL', 'SUPPRESSED'])
  })

  it('同一カードで旧signalキャプションを重複表示しない', () => {
    const html = renderWith(normalState())
    expect(html).not.toContain('>BULL<')
    expect(html).toContain('data-signal="HOLD"')
    expect(html).toContain('aria-label="シグナル: 保有継続"')
  })
})
