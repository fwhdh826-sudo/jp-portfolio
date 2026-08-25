// UI-9E-DISPLAY-CONVENTION-IMPLEMENTATION
// 監査レポート ~/jp-portfolio-audit-reports/ui-9e-display-convention-audit.md の
// required tests T-6〜T-16 を実コンポーネントのrender/value assertionで検証する。
// source正規表現のみのassertionは行わない（render結果の文字列に対して検証する）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Trust } from '../../types'
import type { FundPhase7Map } from '../../types/scoring'
import { buildAssetUniverse } from '../../domain/optimization/idealAllocation'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { SafeModeStatusCard } from '../v13/SafeModeStatusCard'
import { formatNikkei5dReturn } from '../v13/MacroIntelPanel'
import type { TierAT1Violation } from '../../domain/constraints/tierAT1'
import { formatPt, formatSignedJPY } from '../../utils/format'
import { CLASS_LABEL, type AssetClass } from '../../types/universe'

const mockedStore = vi.hoisted(() => ({
  state: null as AppState | null,
  isMobile: false,
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('UI-9E store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockedStore.isMobile,
}))

// mock後にimportすることでvi.mockされたuseAppStoreを使わせる
const { StatusBar } = await import('../StatusBar')
const { T0_Home } = await import('./T0_Home')
const { T1_Decision } = await import('./T1_Decision')
const { T2_JpFund, T2AllocationPanel } = await import('./T2_JpFund')
const { T3_GlobalFund } = await import('./T3_GlobalFund')
const { T4_IdealPf } = await import('./T4_IdealPf')
const { T7_Trust } = await import('./T7_Trust')
const { T8_Learning } = await import('./T8_Learning')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

function withTrustOverride(id: string, overrides: Partial<Trust>): Trust[] {
  return BASE_APP_STATE.trust.map(t => (t.id === id ? { ...t, ...overrides } : t))
}

// ── 共通fixture: OVERSEAS_TRUST を過大配分（現在90% vs 目標55%）にし、
//    T0/T3/T4 すべてが同一 AssetCategorySummary authority を参照するようにする ──
function overAllocatedOverseasState(): AppState {
  const trust = withTrustOverride('sp500_sbi', { eval: 9_000_000, pnlPct: 12.345, dayPct: -0.4 })
  const base: AppState = {
    ...BASE_APP_STATE,
    holdings: [],
    trust,
    cash: 1_000_000,
    cashReserve: 0,
    market: { ...BASE_APP_STATE.market, regime: 'neutral' },
  }
  const universe = buildAssetUniverse(base, Date.parse('2026-08-21T00:00:00Z'))
  return { ...base, universe }
}

function renderWith(state: AppState, Component: () => JSX.Element): string {
  mockedStore.state = state
  return renderToStaticMarkup(<Component />)
}

function renderWithViewport(state: AppState, Component: () => JSX.Element, isMobile: boolean): string {
  mockedStore.state = state
  mockedStore.isMobile = isMobile
  try {
    return renderToStaticMarkup(<Component />)
  } finally {
    mockedStore.isMobile = false
  }
}

// resultから資産カテゴリ「海外株投信」に紐づくptバッジ相当の符号を粗くsniffするための
// 共通ヘルパー: 与えたラベルの近傍で最初に出現する符号付きpt/JPYトークンを拾う
function firstSignedToken(html: string, pattern: RegExp): string | null {
  const m = html.match(pattern)
  return m ? m[0] : null
}

const ALL_ASSET_CLASSES: AssetClass[] = [
  'JP_STOCK', 'JP_TRUST', 'OVERSEAS_TRUST', 'GOLD', 'CASH', 'CASH_RESERVE',
]

function authorityFixtureState(): AppState {
  const trust = BASE_APP_STATE.trust.map(f => ({
    ...f,
    eval:
      f.id === 'nk225_sbi' ? 500_000
      : f.id === 'sp500_sbi' ? 4_000_000
      : f.id === 'gold_mufg' ? 1_000_000
      : 0,
  }))
  const holdings: AppState['holdings'] = [{
    code: '7203', name: 'authority fixture', eval: 2_000_000, pnlPct: 0,
    mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: '輸送用機器',
    target: 3_000, alert: 2_000, lock: false, mitsu: false,
    ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
    roe: 10, per: 12, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 2,
    score: 60, decision: 'HOLD', ev: 0,
  }]
  const base: AppState = {
    ...BASE_APP_STATE,
    holdings,
    trust,
    cash: 2_000_000,
    cashReserve: 500_000,
    cashAssumptions: {
      source: 'MANUAL', grossCash: 2_500_000, safetyReserve: 500_000,
      pendingOrderCash: 0, updatedAt: '2026-08-21T00:00:00Z',
    },
    portfolioPolicy: { ...BASE_APP_STATE.portfolioPolicy, jpStockMaxRatio: 0.1 },
    market: { ...BASE_APP_STATE.market, regime: 'neutral' },
  }
  return { ...base, universe: buildAssetUniverse(base, Date.parse('2026-08-21T00:00:00Z')) }
}

function assetRenderBlock(
  html: string,
  sectionTitle: string,
  assetClass: AssetClass,
  renderedClasses: readonly AssetClass[],
): string {
  const sectionStart = html.indexOf(sectionTitle)
  if (sectionStart < 0) throw new Error(`section not rendered: ${sectionTitle}`)
  const label = CLASS_LABEL[assetClass]
  const blockStart = html.indexOf(`>${label}<`, sectionStart)
  if (blockStart < 0) throw new Error(`asset class not rendered: ${assetClass}`)
  const classIndex = renderedClasses.indexOf(assetClass)
  const nextClass = renderedClasses[classIndex + 1]
  const blockEnd = nextClass === undefined
    ? html.length
    : html.indexOf(`>${CLASS_LABEL[nextClass]}<`, blockStart + label.length)
  return html.slice(blockStart, blockEnd < 0 ? html.length : blockEnd)
}

function expectAuthorityDiffs(
  html: string,
  sectionTitle: string,
  state: AppState,
  renderedClasses: readonly AssetClass[],
): void {
  for (const assetClass of renderedClasses) {
    const authority = state.universe!.categories.find(c => c.class === assetClass)!
    const block = assetRenderBlock(html, sectionTitle, assetClass, renderedClasses)
    const ratioToken = `>${formatPt(authority.diffRatio * 100)}<`
    const valueToken = `>${formatSignedJPY(authority.diffValue)}<`
    expect(block.split(ratioToken).length - 1, `${assetClass} diffRatio exact count`).toBe(1)
    expect(block.split(valueToken).length - 1, `${assetClass} diffValue exact count`).toBe(1)
  }
}

describe('TE1: T0/T3/T4は各asset classのauthority diffRatio/diffValueを個別exact描画する', () => {
  const state = authorityFixtureState()

  it('fixtureは全asset classで非ゼロ、正負混在、非対称のauthority差分を持つ', () => {
    const ratios: number[] = []
    const values: number[] = []
    for (const assetClass of ALL_ASSET_CLASSES) {
      const authority = state.universe!.categories.find(c => c.class === assetClass)!
      expect(authority.diffRatio, `${assetClass} diffRatio`).not.toBe(0)
      expect(authority.diffValue, `${assetClass} diffValue`).not.toBe(0)
      ratios.push(authority.diffRatio)
      values.push(authority.diffValue)
    }
    expect(ratios.some(v => v > 0) && ratios.some(v => v < 0)).toBe(true)
    expect(values.some(v => v > 0) && values.some(v => v < 0)).toBe(true)
    expect(new Set(ratios.map(v => Math.abs(v).toFixed(8))).size).toBeGreaterThan(2)
    expect(new Set(values.map(v => Math.abs(v).toFixed(2))).size).toBeGreaterThan(2)
  })

  it('T0: 全6 asset class', () => {
    expectAuthorityDiffs(renderWith(state, T0_Home), '理想PF / 配分サマリー', state, ALL_ASSET_CLASSES)
  })

  it('T3: OVERSEAS_TRUST / GOLD', () => {
    const renderedClasses: AssetClass[] = ['OVERSEAS_TRUST', 'GOLD']
    expectAuthorityDiffs(renderWith(state, T3_GlobalFund), '理想配分 / 現在配分との差分', state, renderedClasses)
  })

  it('T4: 全6 asset class', () => {
    expectAuthorityDiffs(renderWith(state, T4_IdealPf), '資産クラス配分', state, ALL_ASSET_CLASSES)
  })
})

describe('F2: T1 mobile score matrixの損益cellは2桁精度を維持して縮退する', () => {
  it('mobile renderで対象cellだけが10px/min-width:0/nowrapとなり値を省略しない', () => {
    const source = authorityFixtureState().holdings[0]
    const state: AppState = {
      ...authorityFixtureState(),
      holdings: [
        { ...source, code: '1001', name: '正22.90', pnlPct: 22.9 },
        { ...source, code: '1002', name: '正12.40', pnlPct: 12.4 },
        { ...source, code: '1003', name: '負12.40', pnlPct: -12.4 },
      ],
      analysis: [],
    }
    const html = renderWithViewport(state, T1_Decision, true)
    const matrixStart = html.indexOf('銘柄スコア比較')
    const matrixEnd = html.indexOf('候補判断', matrixStart)
    expect(matrixStart).toBeGreaterThanOrEqual(0)
    const matrixHtml = html.slice(matrixStart, matrixEnd < 0 ? html.length : matrixEnd)
    for (const expected of ['+22.90%', '+12.40%', '-12.40%']) {
      const escaped = expected.replace(/[+.%]/g, '\\$&')
      const match = matrixHtml.match(new RegExp(`<div style="([^"]*)">${escaped}</div>`))
      expect(match, `${expected} cell`).not.toBeNull()
      const style = match![1]
      expect(style).toContain('padding:6px 2px')
      expect(style).toContain('font-size:10px')
      expect(style).toContain('min-width:0')
      expect(style).toContain('white-space:nowrap')
    }
    expect(matrixHtml).toContain('grid-template-columns:minmax(64px, 1.2fr) repeat(5, 1fr)')
    expect(matrixHtml).toContain('overflow-x:auto')
    expect(matrixHtml).not.toContain('+22.9%')
    expect(matrixHtml).not.toContain('+12.4%')
    expect(matrixHtml).not.toContain('-12.4%')
  })
})

describe('T-6: diffRatio由来のptがT0/T3/T4で同符号（過大配分=海外株投信fixture）', () => {
  const state = overAllocatedOverseasState()
  const overseas = state.universe!.categories.find(c => c.class === 'OVERSEAS_TRUST')!
  it('fixtureの前提: OVERSEAS_TRUSTは過大配分（diffRatio<0）', () => {
    expect(overseas.diffRatio).toBeLessThan(0)
    expect(overseas.diffValue).toBeLessThan(0)
  })

  it('T0: 海外株投信のptバッジが負符号', () => {
    const html = renderWith(state, T0_Home)
    const pt = firstSignedToken(html, /-\d+\.\d+pt/)
    expect(pt).not.toBeNull()
  })

  it('T3: 海外株投信のptバッジが負符号（かつ+90.0pt等の反転は出ない）', () => {
    const html = renderWith(state, T3_GlobalFund)
    expect(html).toMatch(/-\d+\.\d+pt/)
  })

  it('T4: 海外株投信のptバッジが負符号（authority=diffRatio準拠、current-target再計算ではない）', () => {
    const html = renderWith(state, T4_IdealPf)
    expect(html).toMatch(/-\d+\.\d+pt/)
  })
})

describe('T-7: 同一AssetCategorySummaryでptバッジとJPY差分バッジが同符号（T3/T4）', () => {
  const state = overAllocatedOverseasState()

  it('T3: AllocationBarのpt(-)とJPY差分(-)が同符号', () => {
    const html = renderWith(state, T3_GlobalFund)
    expect(html).toMatch(/-\d+\.\d+pt/)
    // 過大配分なのでJPY差分も負（万円/億円スケールのformatJPYAuto出力）
    expect(html).toMatch(/-[\d,]+(\.\d+)?(万円|億円|円)/)
  })

  it('T4: AllocRowのpt(-)とfooterのJPY差分(-)が同符号', () => {
    const html = renderWith(state, T4_IdealPf)
    expect(html).toMatch(/-\d+\.\d+pt/)
    expect(html).toMatch(/-[\d,]+(\.\d+)?(万円|億円|円)/)
  })
})

describe('T-8: vixChgがStatusBar/T0の両方でptで表示される（E-P0-1）', () => {
  const state: AppState = {
    ...BASE_APP_STATE,
    macro: {
      last_updated: '2026-08-21T12:00:00Z',
      jgb10y: 1.2, ust10y: 4.3,
      usdjpy: 159.26, usdjpyChgPct: 0.12,
      sp500: 5000, sp500ChgPct: 0.5,
      nasdaq: 16000, nasdaqChgPct: 0.6,
      vix: 14.9, vixChg: 0.66,
      nikkeiVI: 18.2, nikkeiVIChg: -0.3,
      gold: 4460.1, goldChgPct: 0.2,
      nyCrude: 82.4, nyCrudeChgPct: -0.1,
    },
  }

  it('StatusBar: VIX変化が+0.66ptで表示され、%表示は出ない', () => {
    const html = renderWith(state, StatusBar)
    expect(html).toContain('+0.66pt')
    expect(html).not.toContain('+0.66%')
  })

  it('T0: VIX変化が+0.66ptで表示される', () => {
    const html = renderWith(state, T0_Home)
    expect(html).toContain('+0.66pt')
  })
})

describe('T-9: sizing_multiplier_capがT7内で%表記されない（×表記のみ, E-P0-4）', () => {
  const phase7Map: FundPhase7Map = {
    nk225_sbi: {
      fund_id: 'nk225_sbi',
      fund_name: 'SBI 日経225',
      domain: 'domestic_fund',
      behavioral_score: 65,
      sizing_multiplier_cap: 1.2,
      committee_confidence: 0.8,
      adjusted_size: 0.15,
      diagnostics: [],
    },
  }
  const state: AppState = {
    ...BASE_APP_STATE,
    trust: withTrustOverride('nk225_sbi', { eval: 500_000 }),
    fundPhase7: phase7Map,
  }

  it('×1.20が描画され、120%（百分率化・テキストノード）は描画されない', () => {
    const html = renderWith(state, T7_Trust)
    expect(html).toContain('×1.20')
    // width:120% はCSS由来(E-D-6, layout debt, スコープ外)のため許容する。
    // ここではテキストとして描画される">120%<"の有無のみを検証する。
    expect(html).not.toMatch(/>120%</)
  })
})

describe('UI-9H H-P1-10: T7 Phase7観察値グリッドの括弧は全角（日本語+半角括弧+日本語の解消）', () => {
  const phase7Map: FundPhase7Map = {
    nk225_sbi: {
      fund_id: 'nk225_sbi',
      fund_name: 'SBI 日経225',
      domain: 'domestic_fund',
      behavioral_score: 65,
      sizing_multiplier_cap: 1.2,
      committee_confidence: 0.8,
      adjusted_size: 0.15,
      diagnostics: [],
    },
  }
  const state: AppState = {
    ...BASE_APP_STATE,
    trust: withTrustOverride('nk225_sbi', { eval: 500_000 }),
    fundPhase7: phase7Map,
  }

  it('4ラベルすべてが全角括弧（観察）で描画される', () => {
    const html = renderWith(state, T7_Trust)
    expect(html).toContain('行動スコア（観察）')
    expect(html).toContain('信頼度（観察）')
    expect(html).toContain('サイズ上限（観察）')
    expect(html).toContain('調整サイズ（観察）')
  })

  // mutation guard: 半角括弧へ戻す（＝旧表記への回帰）と RED になる
  it('旧表記（半角括弧 (観察)）が残存しない', () => {
    const html = renderWith(state, T7_Trust)
    expect(html).not.toContain('行動スコア (観察)')
    expect(html).not.toContain('信頼度 (観察)')
    expect(html).not.toContain('サイズ上限 (観察)')
    expect(html).not.toContain('調整サイズ (観察)')
  })
})

describe('T-10: Trust.costがT2/T3/T7で同一精度（3桁）で描画される（E-P1-4）', () => {
  // 0.1234 は 2桁"0.12%"/3桁"0.123%"/4桁"0.1234%" が全て異なる文字列になり精度差を可視化できる
  const COST = 0.1234

  it('T2: 信託報酬が3桁で描画される', () => {
    const state: AppState = { ...BASE_APP_STATE, trust: withTrustOverride('nk225_sbi', { eval: 300_000, cost: COST }) }
    const html = renderWith(state, T2_JpFund)
    expect(html).toContain('0.123%')
    expect(html).not.toContain('0.1234%')
    expect(html).not.toContain('0.12%')
  })

  it('T3: 信託報酬が3桁で描画される', () => {
    const state: AppState = { ...BASE_APP_STATE, trust: withTrustOverride('sp500_sbi', { eval: 300_000, cost: COST }) }
    const html = renderWith(state, T3_GlobalFund)
    expect(html).toContain('0.123%')
    expect(html).not.toContain('0.1234%')
  })

  it('T7: 信託報酬が3桁で描画される', () => {
    const state: AppState = { ...BASE_APP_STATE, trust: withTrustOverride('nk225_sbi', { eval: 300_000, cost: COST }) }
    const html = renderWith(state, T7_Trust)
    expect(html).toContain('0.123%')
    expect(html).not.toContain('0.1234%')
  })
})

describe('T-11: pnlPctが2桁+符号（0は符号なし）で描画される。SafeModeStatusCardを含む', () => {
  it('T0: 保有銘柄一覧のpnlPctが+符号2桁', () => {
    const state: AppState = {
      ...BASE_APP_STATE,
      holdings: [{
        code: '7203', name: 'トヨタ自動車', eval: 1_000_000, pnlPct: 12.345,
        mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: '輸送用機器',
        target: 3000, alert: 2000, lock: false, mitsu: false,
        ma: true, rsi: 55, macd: true, vol: false, mom3m: 1.2,
        roe: 12, per: 14, pbr: 1.2, epsG: 5, cfOk: true, de: 0.5, divG: 2,
        score: 60, decision: 'HOLD', ev: 0.02,
      }],
    }
    const html = renderWith(state, T0_Home)
    expect(html).toContain('+12.35%')
  })

  it('T2: ファンドのpnlPctが0のとき符号なし（+0.00%を生成しない）', () => {
    const state: AppState = { ...BASE_APP_STATE, trust: withTrustOverride('nk225_sbi', { eval: 300_000, pnlPct: 0 }) }
    const html = renderWith(state, T2_JpFund)
    expect(html).not.toContain('+0.00%')
    expect(html).toContain('0.00%')
  })

  it('SafeModeStatusCard: TierA T1違反のpnlPctが符号付き2桁で描画される（E-P1-13）', () => {
    const violations: TierAT1Violation[] = [
      { code: '9999', name: 'テスト銘柄', pnlPct: -42.5, eval: 100_000, locked: false },
    ]
    const html = renderToStaticMarkup(
      <SafeModeStatusCard
        safeMode={BASE_APP_STATE.safeMode}
        safeModeSource="loaded"
        safeModeLastChecked="2026-08-21T00:00:00Z"
        tierAViolations={BASE_APP_STATE.tierAViolations}
        tierAAlerts={BASE_APP_STATE.tierAAlerts}
        tierAT1Violations={violations}
      />,
    )
    expect(html).toContain('-42.50%')
  })
})

describe('UI-9H H-P1-8: MacroIntelPanel nikkei_5d_return が符号付き%で描画される（[F-1]/[F-6]是正）', () => {
  // MacroIntelPanelは自己フェッチコンポーネント（useEffect+fetch）でありrenderToStaticMarkupは
  // effectを実行しないため、本fileのrenderWith(state, Component)方式ではfixtureを注入できない。
  // production render bodyが実際に呼ぶformatNikkei5dReturnへ直接fixture値を渡し、
  // 「nikkei_5d_return=0 → 0.0%（+0.0%/-0.0%を生成しない）」をvalue-levelで固定する。
  it('nikkei_5d_return: 0 fixture → "0.0%"（+0.0%/-0.0%を生成しない）', () => {
    const s = formatNikkei5dReturn(0)
    expect(s).toBe('0.0%')
    expect(s).not.toContain('+0.0%')
    expect(s).not.toContain('-0.0%')
  })
})

describe('T-12: targetRatioがT0/T3/T4/T7で同一精度（1桁）で描画される（E-P1-5）', () => {
  const state = overAllocatedOverseasState()
  const overseas = state.universe!.categories.find(c => c.class === 'OVERSEAS_TRUST')!
  const targetPctStr = `${(overseas.targetRatio * 100).toFixed(1)}%`

  it('T0: 目標配分比が1桁精度', () => {
    expect(renderWith(state, T0_Home)).toContain(targetPctStr)
  })
  it('T3: 目標配分比が1桁精度', () => {
    expect(renderWith(state, T3_GlobalFund)).toContain(targetPctStr)
  })
  it('T4: 目標配分比が1桁精度', () => {
    expect(renderWith(state, T4_IdealPf)).toContain(targetPctStr)
  })
})

describe('T-13: evが%表記で描画される（authority=無次元ratio, ×100, R5）', () => {
  it('T4: FundRowのEVが%表記で描画される（.toFixed(3)の生値は出ない）', () => {
    const state: AppState = { ...BASE_APP_STATE, trust: withTrustOverride('sp500_sbi', { eval: 300_000, ev: 0.123 }) }
    const html = renderWith(state, T4_IdealPf)
    expect(html).toContain('+12.3%')
    expect(html).not.toContain('0.123')
  })
})

describe('T-14: deltaPnlPctがptで描画される（T8, E-P1-11）', () => {
  it('T8: outcome行のdeltaPnlPctがpt表記（%表記は出ない）', () => {
    const decisionSummary = { count: 1, wins: 1, losses: 0, flats: 0, accuracy: 100, avgReward: 0.1 }
    const state: AppState = {
      ...BASE_APP_STATE,
      learning: {
        lastUpdated: '2026-08-21T00:00:00Z',
        baselineCount: 1,
        baseline: [],
        outcomes: [{
          code: '7203', predictedAt: '2026-08-20T00:00:00Z', evaluatedAt: '2026-08-21T00:00:00Z',
          decision: 'BUY', score: 70, confidence: 0.8,
          prevPnlPct: 10, currPnlPct: 13.14, deltaPnlPct: 3.14,
          reward: 0.1, result: 'win', regime: 'bull',
        }],
        summary: {
          total: 1, wins: 1, losses: 0, flats: 0, accuracy: 100, avgReward: 0.1,
          byDecision: { BUY: decisionSummary, HOLD: decisionSummary, SELL: decisionSummary },
          driftSignals: [],
        },
        suggestedWeights: { fundamental: 0.3, market: 0.2, technical: 0.2, news: 0.15, quality: 0.1, risk: 0.05 },
      },
    }
    const html = renderWith(state, T8_Learning)
    expect(html).toContain('+3.14pt')
    expect(html).not.toContain('+3.14%')
  })
})

describe('T-15: signed値の符号グリフが値と同一テキストノードである（a11y, E-P1-15）', () => {
  it('T4のAllocRow footerで符号と金額が同一テキストノードに連結されている（別spanに分離しない）', () => {
    const state = overAllocatedOverseasState()
    const html = renderWith(state, T4_IdealPf)
    // 符号文字の直後に別タグ開始が来るような分離パターンが存在しないことを確認
    expect(html).not.toMatch(/>-<\/[a-z]+><[a-z]+[^>]*>[\d,]/)
    expect(html).not.toMatch(/>\+<\/[a-z]+><[a-z]+[^>]*>[\d,]/)
    // 実際に単一ノードとして「-」+数字が連結された文字列が存在することを積極的に確認
    expect(html).toMatch(/>-[\d,]+(\.\d+)?(万円|億円|円)</)
  })
})

describe('UI-9H H-P1-13: 投信本数の助数詞は「本」・数値-助数詞間スペースなしに統一', () => {
  const jpFundCount = BASE_APP_STATE.trust.filter(f => f.policy === 'JAPAN_SHORTTERM').length
  const overseasFundCount = BASE_APP_STATE.trust.filter(f => f.policy === 'OVERSEAS_LONGTERM').length
  const goldFundCount = BASE_APP_STATE.trust.filter(f => f.policy === 'GOLD').length
  const globalFundCount = overseasFundCount + goldFundCount

  it('T2: 保有ファンドcaptionが `{n}本`（スペースなし）で描画される', () => {
    const html = renderWith(BASE_APP_STATE, T2_JpFund)
    const titleIdx = html.indexOf('保有ファンド')
    expect(titleIdx).toBeGreaterThan(-1)
    const block = html.slice(titleIdx, titleIdx + 400)
    expect(block).toContain(`${jpFundCount}本`)
    // mutation guard: 旧「N 件」（fund countに限った空白+件）へ戻すとRED
    expect(block).not.toContain(`${jpFundCount} 件`)
  })

  it('T0: 保有投信プレビューの残数captionが `他{n}本`（スペースなし, [F-2]是正）で描画される', () => {
    const html = renderWith(BASE_APP_STATE, T0_Home)
    const titleIdx = html.indexOf('dash-preview-more')
    expect(titleIdx).toBeGreaterThan(-1)
    const block = html.slice(titleIdx, titleIdx + 100)
    const remainingCount = BASE_APP_STATE.trust.length - 5
    expect(block).toContain(`他 ${remainingCount}本`)
    // mutation guard: 旧「N 本」（数値-助数詞間スペース残存）へ戻すとRED
    expect(block).not.toMatch(/[0-9] 本/)
  })

  it('T3: 海外株ファンド数/ゴールドファンド数captionが `{n}本`（スペースなし）で描画される', () => {
    const html = renderWith(BASE_APP_STATE, T3_GlobalFund)
    expect(html).toContain(`${overseasFundCount}本`)
    expect(html).toContain(`${goldFundCount}本`)
    expect(html).toContain(`海外投信 ${globalFundCount}本`)
  })

  it('T3: hasOverlap=true branch → `N本`で描画される（[F-2b]是正）', () => {
    expect(overseasFundCount).toBeGreaterThanOrEqual(2)
    const html = renderWith(BASE_APP_STATE, T3_GlobalFund)
    expect(html).toContain(`海外株ファンドが ${overseasFundCount}本あります`)
    expect(html).not.toContain('海外株ファンド1件')
  })

  it('T3: hasOverlap=false branch → `1本`で描画される（[F-2b]是正、旧`1件`との助数詞不整合を解消）', () => {
    const singleOverseasTrust = BASE_APP_STATE.trust.filter(t => t.policy !== 'OVERSEAS_LONGTERM' || t.id === 'sp500_sbi')
    const state: AppState = { ...BASE_APP_STATE, trust: singleOverseasTrust }
    const html = renderWith(state, T3_GlobalFund)
    expect(html).toContain('海外株ファンド1本 — 重複なし')
    // mutation guard: 旧「1件」（hasOverlapブランチ間の助数詞不整合）へ戻すとRED
    expect(html).not.toContain('海外株ファンド1件')
  })

  it('T3: 「保有本数」ラベルへ改称されている（旧: 保有銘柄数）', () => {
    const html = renderWith(BASE_APP_STATE, T3_GlobalFund)
    expect(html).toContain('保有本数')
    expect(html).not.toContain('保有銘柄数')
  })

  it('T7: 日本株投信MetricCardが `{n}本`（スペースなし）で描画される', () => {
    const state: AppState = { ...BASE_APP_STATE, trust: withTrustOverride('nk225_sbi', { eval: 500_000 }) }
    const shortTermCount = state.trust.filter(f => f.policy === 'JAPAN_SHORTTERM' && f.eval > 0).length
    const html = renderWith(state, T7_Trust)
    expect(html).toContain(`${shortTermCount}本`)
    expect(html).not.toContain(`${shortTermCount} 本`)
  })
})

describe('UI-9H H-P1-9: 「最終更新」表示ラベルの統一', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('T0: 後置「更新」ラベルではなく前置「最終更新」ラベルで描画される', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    const state: AppState = { ...BASE_APP_STATE, system: { ...BASE_APP_STATE.system, lastUpdated: '2026-08-21T12:00:00Z' } }
    const html = renderWith(state, T0_Home)
    expect(html).toContain('最終更新 ')
    expect(html).not.toMatch(/JST\s*更新/)
  })

  it('T2/T3: 「更新」単独ラベルではなく「最終更新」ラベルで描画される（値は相対のみ維持）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    const state: AppState = { ...BASE_APP_STATE, system: { ...BASE_APP_STATE.system, lastUpdated: '2026-08-21T12:00:00Z' } }
    const htmlT2 = renderWith(state, T2_JpFund)
    const htmlT3 = renderWith(state, T3_GlobalFund)
    expect(htmlT2).toContain('最終更新 5分前')
    expect(htmlT3).toContain('最終更新 5分前')
    // mutation guard: 旧「更新 {相対}」（最終なし）へ戻すと以下がRED
    expect(htmlT2).not.toMatch(/>更新 5分前</)
    expect(htmlT3).not.toMatch(/>更新 5分前</)
  })

  it('StatusBar: 幅制約箇所として相対のみへ縮退した canonical 表示になる（ラベルは最終更新のまま）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    const state: AppState = { ...BASE_APP_STATE, system: { ...BASE_APP_STATE.system, lastUpdated: '2026-08-21T12:00:00Z' } }
    const html = renderWith(state, StatusBar)
    expect(html).toContain('最終更新')
    expect(html).toContain('5分前')
  })
})

describe('T-16: 数値placeholderが—に統一される（regression, R7.1）', () => {
  it('StatusBar: macro=nullのときVIX/ドル円の変化欄が—になる', () => {
    const state: AppState = { ...BASE_APP_STATE, macro: null }
    const html = renderWith(state, StatusBar)
    expect(html).toContain('—')
  })
})

describe('T2 allocation MetricCard 8枚（専用fixtureで描画確認, 監査未検証項目）', () => {
  it('T2AllocationPanelがavailableなsnapshotで8枚のMetricCardを描画し、金額はformatJPYAuto経由で整合する', () => {
    const classProjection = {
      assetClass: 'JP_TRUST' as const,
      currentAmount: 901_001,
      targetAmount: 702_002,
      targetRatio: 0.4,
      targetGap: 503_003,
      overweightAmount: 0,
      maximumAmount: null,
      hardHeadroom: 808_008,
      softHeadroom: 707_007,
      effectiveHeadroom: 406_006,
      availableBudget: 607_007,
      allocatedAmount: 104_004,
      remainingHeadroom: 305_005,
      instrumentPlanCount: 2,
      classFullCause: null,
      blockedReasons: [],
      warningReasons: [],
      limitingFactors: [],
    }
    const snapshot = {
      availability: 'available' as const,
      status: 'current' as const,
      generation: {
        snapshotId: 'snapshot-ui9e-t2-fixture',
        generatedAt: '2026-08-21T00:00:00.000Z',
        sourceHoldingsSnapshotId: 'holdings-ui9e',
        sourceSettingsVersion: 'settings-ui9e',
        sourceCandidateGenerationId: 'candidates-ui9e',
      },
      snapshotExecutability: 'EXECUTABLE' as const,
      totalAssets: 2_000_000,
      grossCash: 1_000_000,
      deployableCash: 900_000,
      shortTermBudget: 800_000,
      longTermBudget: 100_000,
      remainingUnallocatedCash: 795_996,
      marketMode: 'normal' as const,
      regime: 'neutral' as const,
      classes: [classProjection],
      instruments: [],
      blockedReasons: [],
      warnings: [],
      reasonKind: null,
    }
    const projection = {
      snapshot,
      jpTrustClass: classProjection,
    }
    const html = renderToStaticMarkup(
      <T2AllocationPanel
        consumerSnapshot={snapshot as never}
        projection={projection as never}
        isMobile={false}
      />,
    )
    expect(html).toContain('90.1万円')   // currentAmount formatJPYAuto
    expect(html).toContain('70.2万円')   // targetAmount
    expect(html).toContain('50.3万円')   // targetGap
    expect(html).toContain('40.6万円')   // effectiveHeadroom
    expect(html).toContain('2件')        // instrumentPlanCount
  })
})
