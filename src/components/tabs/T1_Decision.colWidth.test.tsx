import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Holding } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const mockedStore = vi.hoisted(() => ({
  state: null as AppState | null,
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T1 column-width fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { T1_Decision, displayDecisionLabel, stockRegimeDisplayLabel } = await import('./T1_Decision')
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import presentationSource from '../../presentation/ui9i/stocksPresentation.ts?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import viewsSource from '../ui9i/StocksViews.tsx?raw'
// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'

// vitest は CSS を transform しないため生ファイルを読む。
const uiCss: string = readFileSync(new URL('../../styles/ui9i.css', import.meta.url), 'utf8')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

function holding(code: string, name: string, pnlPct: number): Holding {
  return {
    code, name, pnlPct, eval: 2_000_000,
    mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'fixture',
    target: 3_000, alert: 2_000, lock: false, mitsu: false,
    ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
    roe: 10, per: 12, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 2,
    score: 60, decision: 'HOLD', ev: 0,
  }
}

const MATRIX_HOLDINGS = [
  holding('8306', '三菱ＵＦＪフィナンシャル・グループ', 12.34),
  holding('6098', '株式会社リクルートホールディングス', -4.56),
]

function renderPage(holdings = MATRIX_HOLDINGS): string {
  mockedStore.state = { ...BASE_APP_STATE, holdings, analysis: [] }
  return renderToStaticMarkup(<T1_Decision />)
}

function compareTable(html: string): string {
  const start = html.indexOf('<table class="u9-table">')
  const end = html.indexOf('</table>', start)
  expect(start).toBeGreaterThanOrEqual(0)
  return html.slice(start, end)
}

describe('T1 比較表（Phase 2B-1: 旧「銘柄スコア比較」の grid → semantic table）', () => {
  it('列見出しは th[scope=col]、行見出しは th[scope=row]（銘柄コード + 名称）。全 5 指標列を保持する', () => {
    const table = compareTable(renderPage())
    for (const label of ['銘柄', '判断', '総合スコア', '損益', 'RSI', '総合ランク']) {
      expect(table).toContain(`<th scope="col">${label}</th>`)
    }
    for (const row of MATRIX_HOLDINGS) {
      expect(table).toMatch(new RegExp(`<th scope="row"><span class="u9-stk-code">${row.code}</span><span class="u9-table__sub">${row.name}</span>`))
    }
  })

  it('横スクロールの逃げ道は「キーボードで到達できる名前付き領域」として残す（overflow-x は CSS 側）', () => {
    const html = renderPage()
    expect(html).toContain('class="u9-table-scroll" role="region" aria-label="銘柄の比較表" tabindex="0"')
    expect(uiCss).toMatch(/\.u9-table-scroll\s*\{[^}]*overflow-x:\s*auto/)
    expect(uiCss).toMatch(/\.u9-table th, \.u9-table td\s*\{[^}]*white-space:\s*nowrap/)
  })

  it('銘柄が 1 件のときは比較表を出さない（旧 T1 の sorted.length >= 2 と同じ）', () => {
    expect(renderPage([MATRIX_HOLDINGS[0]])).not.toContain('u9-table')
  })

  it('コード / 名称 / 損益が欠落せず読める（省略は CSS の ellipsis のみ。値は DOM に全て残る）', () => {
    const html = renderPage()
    for (const row of MATRIX_HOLDINGS) {
      expect(html).toContain(`>${row.code}<`)
      expect(html).toContain(`>${row.name}<`)
    }
    expect(html).toContain('+12.34%')
    expect(html).toContain('-4.56%')
  })
})

describe('UI-P2-1 I-1/I-4: T1表示ラベルとdomain tokenの分離', () => {
  it('判定enumを変えず、可視ラベルだけを正典の日本語へ変換する', () => {
    const decisions = ['BUY', 'HOLD', 'SELL', 'WAIT', 'DATA_WAIT'] as const
    expect(decisions.map(displayDecisionLabel)).toEqual(['買い', '保有継続', '売却', '待機', '待機'])
    expect(decisions).toEqual(['BUY', 'HOLD', 'SELL', 'WAIT', 'DATA_WAIT'])
  })

  it('判定 render site（一覧の行 / 比較表 / 詳細の判定バッジ）は underlying enum を data-decision に保持する', () => {
    // 一覧の行 + 比較表の行（2 銘柄 × 2 site）。詳細の判定バッジは StocksViews の 1 箇所。
    expect(viewsSource.match(/data-decision=/g)).toHaveLength(3)
    const html = renderPage()
    expect(html.match(/data-decision="HOLD"/g)).toHaveLength(4)
    expect(html).toContain('>保有継続</span>')
    expect(html).not.toMatch(/>(BUY|HOLD|SELL|WAIT)</)
  })

  it('件数・DQ・詳細説明の可視文言に英語verdict tokenを残さない', () => {
    const html = renderPage()
    expect(html).toContain('2 銘柄 — 買い 0 / ロック 0')
    for (const oldText of ['BUYシグナル', 'SELLシグナル', 'WAIT判定', 'HOLDシグナル', 'BUY抑制']) {
      expect(viewsSource).not.toContain(oldText)
      expect(presentationSource).not.toContain(oldText)
    }
  })

  it('5レジームenumを変えず、既存authorityの日本語表示へ変換する', () => {
    const regimes = ['bull_calm', 'bull_volatile', 'bear', 'crisis', 'uncertain'] as const
    expect(regimes.map(stockRegimeDisplayLabel)).toEqual([
      '強気・低ボラ', '強気・高ボラ', '弱気', '危機', '不確実',
    ])
    expect(regimes).toEqual(['bull_calm', 'bull_volatile', 'bear', 'crisis', 'uncertain'])
  })
})
