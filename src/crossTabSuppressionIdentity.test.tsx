// H-P1-1: 同一の SAFE_MODE/DQ 抑制状態を T2/T4/T6/T7 でrenderし、
// canonical family（`SUPPRESSION_BANNER_PREFIX` = `SAFE_MODE / DQ抑制中`）へ
// 収束していることを固定する。T0 は「SAFE_MODE 単独（DQ結合なし）」の別文脈であり、
// 本 helper の対象外であることも同時に固定する（scope 語混入・状態語混入の回帰guard）。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import type { AppState, Holding, HoldingAnalysis, Trust } from './types'
import { createAppStoreInstanceForTest } from './store/useAppStore'
import { SUPPRESSION_BANNER_PREFIX } from './components/shared/suppressionBanner'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('./store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('cross-tab suppression fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { T0_Home } = await import('./components/tabs/T0_Home')
const { T2_JpFund } = await import('./components/tabs/T2_JpFund')
const { T4_IdealPf } = await import('./components/tabs/T4_IdealPf')
const { T6_Committee } = await import('./components/tabs/T6_Committee')
const { T7_Trust } = await import('./components/tabs/T7_Trust')

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

const NOW_ISO = new Date().toISOString()

function jpFund(id: string): Trust {
  return {
    id, name: `テスト国内投信 ${id}`, abbr: id, account: 'NISA', policy: 'JAPAN_SHORTTERM',
    eval: 500_000, pnlPct: 1.2, dayPct: 0.1, cost: 0.15, mu: 0.04, sigma: 0.2,
    score: 65, signal: 'BULL', ev: 0.03, decision: 'BUY',
  }
}

const HOLDING: Holding = {
  code: '7203', name: 'トヨタ自動車', eval: 500_000, pnlPct: 5,
  mu: 0.05, sigma: 0.2, sigmaSource: 'static', beta: 1.0, sector: '輸送用機器',
  target: 3200, alert: 2600, lock: false, mitsu: false,
  ma: true, rsi: 55, macd: true, vol: false, mom3m: 3,
  roe: 12, per: 15, pbr: 1.2, epsG: 5, cfOk: true, de: 0.5, divG: 2,
  score: 70, decision: 'BUY', ev: 0.02,
}

const ANALYSIS: HoldingAnalysis = {
  code: '7203', fundamentalScore: 20, marketScore: 15, technicalScore: 15,
  newsScore: 10, qualityScore: 7, riskPenalty: 3, totalScore: 70,
  ev: 0.02, decision: 'BUY', confidence: 0.6, strategyRank: 'B',
  debate: {
    agents: [],
    debateScore: 70, confidence: 0.6, finalView: 'BUY',
    bullReasons: [], bearReasons: [],
    buyReasons: ['a'], waitReasons: [], sellReasons: [],
    recommendedAction: '新規買い増しを検討',
    takeProfitConditions: [], stopLossConditions: [], premiseBreakConditions: [],
    riskGatePass: true,
    sevenAxis: { growth: 60, valuation: 55, momentum: 60, macro: 50, quality: 65, risk: 40, news: 55 },
  },
}

/** 全タブ共通のSAFE_MODE抑制状態（real SAFE_MODE: safe_mode.json取得済み・鮮度OK・active:true）。 */
function suppressedState(): AppState {
  return {
    ...BASE_APP_STATE,
    trust: [jpFund('JF1')],
    holdings: [HOLDING],
    analysis: [ANALYSIS],
    market: { ...BASE_APP_STATE.market, last_updated: NOW_ISO },
    system: {
      ...BASE_APP_STATE.system,
      status: 'success',
      lastUpdated: NOW_ISO,
      dataSourceStatus: { ...BASE_APP_STATE.system.dataSourceStatus, market: 'loaded', safeMode: 'loaded' },
      dataTimestamps: { ...BASE_APP_STATE.system.dataTimestamps!, market: NOW_ISO, safeMode: NOW_ISO },
    },
    safeMode: {
      ...BASE_APP_STATE.safeMode,
      safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: true, last_checked: NOW_ISO },
    },
  }
}

function render(node: ReactElement): string {
  mockedStore.state = suppressedState()
  return renderToStaticMarkup(node)
}

describe('H-P1-1: 同一SAFE_MODE状態がT2/T4/T6/T7でcanonical familyへ収束する', () => {
  it('T2はSUPPRESSION_BANNER_PREFIXを含む', () => {
    expect(render(<T2_JpFund />)).toContain(SUPPRESSION_BANNER_PREFIX)
  })

  it('T4はSUPPRESSION_BANNER_PREFIXを含む（SuppressedReferenceNotice）', () => {
    expect(render(<T4_IdealPf />)).toContain(SUPPRESSION_BANNER_PREFIX)
  })

  it('T6はSUPPRESSION_BANNER_PREFIXを含む（ConsensusMeterカウント行）', () => {
    expect(render(<T6_Committee />)).toContain(SUPPRESSION_BANNER_PREFIX)
  })

  it('T7はSUPPRESSION_BANNER_PREFIXを含む', () => {
    expect(render(<T7_Trust />)).toContain(SUPPRESSION_BANNER_PREFIX)
  })

  // mutation guard: 区切りを詰めた旧表記がどのタブにも残存していないこと。
  it('[mutation guard] T2/T4/T6/T7いずれも区切り詰め `SAFE_MODE/DQ抑制中` を含まない', () => {
    expect(render(<T2_JpFund />)).not.toContain('SAFE_MODE/DQ抑制中')
    expect(render(<T4_IdealPf />)).not.toContain('SAFE_MODE/DQ抑制中')
    expect(render(<T6_Committee />)).not.toContain('SAFE_MODE/DQ抑制中')
    expect(render(<T7_Trust />)).not.toContain('SAFE_MODE/DQ抑制中')
  })

  // scope語はタブごとに維持されている（統合されていない）ことの固定。
  it('scope語がタブごとに異なり、統合されていない', () => {
    expect(render(<T2_JpFund />)).toContain('新規買い判断停止中')
    expect(render(<T7_Trust />)).toContain('新規買い判断停止中')
  })
})

describe('H-P1-1: T0はSAFE_MODE単独文脈でありDQ結合banner familyの対象外', () => {
  function t0SuppressedState(): AppState {
    const base = suppressedState()
    return {
      ...base,
      system: { ...base.system, dataSourceStatus: { ...base.system.dataSourceStatus, safeMode: 'loaded' } },
    }
  }

  it('T0はSAFE_MODE発動中（単独文脈）を表示するが、SUPPRESSION_BANNER_PREFIX（DQ結合family）は含まない', () => {
    mockedStore.state = t0SuppressedState()
    const html = renderToStaticMarkup(<T0_Home />)
    expect(html).toContain('SAFE_MODE発動中')
    expect(html).not.toContain(SUPPRESSION_BANNER_PREFIX)
  })
})
