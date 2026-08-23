import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Holding } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const mockedStore = vi.hoisted(() => ({
  state: null as AppState | null,
  isMobile: false,
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

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockedStore.isMobile,
}))

const { T1_Decision } = await import('./T1_Decision')

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

function renderMatrix(isMobile: boolean): string {
  mockedStore.state = {
    ...BASE_APP_STATE,
    holdings: MATRIX_HOLDINGS,
    analysis: [],
  }
  mockedStore.isMobile = isMobile
  try {
    const html = renderToStaticMarkup(<T1_Decision />)
    const start = html.indexOf('銘柄スコア比較')
    const end = html.indexOf('候補判断', start)
    expect(start).toBeGreaterThanOrEqual(0)
    return html.slice(start, end < 0 ? html.length : end)
  } finally {
    mockedStore.isMobile = false
  }
}

function gridContracts(matrixHtml: string): string[] {
  return [...matrixHtml.matchAll(/grid-template-columns:([^;"]+)/g)].map(match => match[1])
}

describe('T1 score matrix responsive first-column contract', () => {
  it('mobile uses a flexible first column and keeps header/data on one six-column contract', () => {
    const html = renderMatrix(true)
    const contracts = gridContracts(html)

    expect(contracts).toHaveLength(MATRIX_HOLDINGS.length + 1)
    expect(new Set(contracts)).toEqual(new Set(['minmax(64px, 1.2fr) repeat(5, 1fr)']))
    expect(contracts[0]).not.toBe('64px repeat(5, 1fr)')
  })

  it('desktop gives the identity column available space while preserving all metric columns', () => {
    const html = renderMatrix(false)
    const contracts = gridContracts(html)

    expect(contracts).toHaveLength(MATRIX_HOLDINGS.length + 1)
    expect(new Set(contracts)).toEqual(new Set(['minmax(120px, 2fr) repeat(5, 1fr)']))
    for (const label of ['判断', 'スコア', '損益', 'RSI', 'ランク']) {
      expect(html).toContain(`>${label}<`)
    }
  })

  it('keeps code/name identity readable and the existing horizontal scroll escape hatch', () => {
    const html = renderMatrix(true)

    for (const row of MATRIX_HOLDINGS) {
      expect(html).toContain(`>${row.code}<`)
      expect(html).toContain(`>${row.name}<`)
    }
    expect(html).toContain('white-space:nowrap;overflow:hidden;text-overflow:ellipsis')
    expect(html).toContain('overflow-x:auto')
  })
})
