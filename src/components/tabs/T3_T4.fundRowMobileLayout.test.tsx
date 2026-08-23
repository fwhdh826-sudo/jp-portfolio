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
      if (mockedStore.state === null) throw new Error('fund row layout fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

import { T3_GlobalFund } from './T3_GlobalFund'
import { T4_IdealPf } from './T4_IdealPf'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t3Source from './T3_GlobalFund.tsx?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t4Source from './T4_IdealPf.tsx?raw'

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE = isolated.store.getState()
isolated.controls.dispose()

const NOW_ISO = new Date().toISOString()

function fund(id: string, abbr: string, policy: Trust['policy']): Trust {
  return {
    id,
    name: `UI9G回帰確認用の長いファンド名称 ${id}`,
    abbr,
    account: 'NISA',
    policy,
    eval: 1_000_000,
    pnlPct: 8.2,
    dayPct: 0.4,
    cost: 0.09,
    mu: 0.06,
    sigma: 0.15,
    score: 72,
    signal: 'BULL',
    ev: 0.05,
    decision: 'BUY',
  }
}

const FUNDS: Trust[] = [
  fund('UI9G-GLOBAL-1', 'UI9G海外株式A', 'OVERSEAS_LONGTERM'),
  fund('UI9G-GLOBAL-2', 'UI9G海外株式B', 'OVERSEAS_LONGTERM'),
  fund('UI9G-GOLD-1', 'UI9Gゴールド', 'GOLD'),
]

function state(): AppState {
  return {
    ...BASE_APP_STATE,
    activeTab: 'T3',
    trust: FUNDS,
    market: { ...BASE_APP_STATE.market, regime: 'bull', vix: 15, last_updated: NOW_ISO },
    system: {
      ...BASE_APP_STATE.system,
      status: 'success',
      lastUpdated: NOW_ISO,
      dataSourceStatus: { ...BASE_APP_STATE.system.dataSourceStatus, market: 'loaded', safeMode: 'loaded' },
      dataTimestamps: { ...BASE_APP_STATE.system.dataTimestamps!, market: NOW_ISO, safeMode: NOW_ISO },
    },
    safeMode: {
      ...BASE_APP_STATE.safeMode,
      safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: false, last_checked: NOW_ISO },
    },
  }
}

function sourceSection(source: string, start: string, end?: string): string {
  const startAt = source.indexOf(start)
  expect(startAt, `source marker: ${start}`).toBeGreaterThanOrEqual(0)
  const endAt = end ? source.indexOf(end, startAt + start.length) : source.length
  expect(endAt, `source marker: ${end ?? 'EOF'}`).toBeGreaterThan(startAt)
  return source.slice(startAt, endAt)
}

function flexBasis(section: string): number {
  const match = section.match(/flex:\s*'1 1 (\d+)px',\s*minWidth:\s*0/)
  expect(match, 'fund-name region must have an explicit flex basis').toBeTruthy()
  return Number(match![1])
}

function resolveNameWidth(rowWidth: number, basis: number, valueWidth: number, gap: number) {
  return basis + gap + valueWidth > rowWidth ? rowWidth : rowWidth - gap - valueWidth
}

describe('UI-9G G-3 FundRow mobile layout', () => {
  const t3FundRow = sourceSection(t3Source, 'function FundRow', '// ── レンダリング')
  const t3CandidateRow = sourceSection(t3Source, '/* ── 追加投資候補 ── */')
  const t4FundRow = sourceSection(t4Source, 'function FundRow', 'function StockRow')

  it('T3/T4の名称領域は390/430pxで1文字幅へ縮退せずvalue領域を維持する', () => {
    const layouts = [
      { name: 'T3 FundRow', basis: flexBasis(t3FundRow), rowPadding: 40, valueWidth: 220, gap: 12 },
      { name: 'T3 candidate', basis: flexBasis(t3CandidateRow), rowPadding: 32, valueWidth: 112, gap: 8 },
      { name: 'T4 FundRow', basis: flexBasis(t4FundRow), rowPadding: 40, valueWidth: 196, gap: 12 },
    ]

    for (const viewport of [390, 430]) {
      for (const layout of layouts) {
        // viewport - mobile panel padding(24) - card borders(2) - row padding
        const rowWidth = viewport - 26 - layout.rowPadding
        const nameWidth = resolveNameWidth(rowWidth, layout.basis, layout.valueWidth, layout.gap)
        expect(nameWidth, `${layout.name} at ${viewport}px`).toBeGreaterThanOrEqual(160)
        expect(layout.valueWidth, `${layout.name} value region`).toBeGreaterThan(0)
      }
    }
  })

  it('T3同種rowは同じ左カラム契約で揃い、旧flex:1へのmutationを検知する', () => {
    const fundBasis = flexBasis(t3FundRow)
    const candidateBasis = flexBasis(t3CandidateRow)
    expect(fundBasis).toBe(160)
    expect(candidateBasis).toBe(fundBasis)
    expect(t3FundRow).not.toMatch(/style={{\s*minWidth:\s*0,\s*flex:\s*1\s*}}/)
    expect(t3CandidateRow).not.toMatch(/<div>\s*<div style={{ display: 'flex', alignItems: 'center'/)
  })

  it('実renderでもfund名・badge・valueが残り、3契約がHTMLへ反映される', () => {
    mockedStore.state = state()
    const t3Html = renderToStaticMarkup(<T3_GlobalFund />)
    mockedStore.state = { ...state(), activeTab: 'T4' }
    const t4Html = renderToStaticMarkup(<T4_IdealPf />)

    expect(t3Html).toContain('UI9G海外株式A')
    expect(t4Html).toContain('UI9G海外株式A')
    expect(t3Html).toContain('aria-label="シグナル: 買い"')
    expect(t4Html).toContain('aria-label="シグナル:')
    expect(t3Html).toContain('>評価額</div>')
    expect(t4Html).toContain('>現在</div>')
    expect(t4Html).toContain('>目標</div>')
    expect(t4Html).toContain('>差分</div>')
    expect((t3Html.match(/flex:1 1 160px/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect((t4Html.match(/flex:1 1 160px/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
