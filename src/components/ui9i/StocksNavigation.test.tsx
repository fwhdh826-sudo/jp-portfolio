// UI-9I Phase 2B-1: 個別株への到達 / 選択 / 戻る / 他画面の到達性を、実際のコンポーネントの onClick 経路で検証する。
//   nav ボタン(onClick) → NavTarget → applyNavTarget → activeTab / 選択解除 → App が描画する面
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, TabId } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import type { NavTarget } from '../../presentation/ui9i/navigation'
import { assembleOtherHub, projectFundsHub } from '../../presentation/ui9i/hubPresentation'
import { projectPortfolio } from '../../presentation/ui9i/portfolioPresentation'
import { UNAVAILABLE_ALLOCATION, fixtureAllocation } from '../../presentation/ui9i/ui9i.fixtures'

const mocked = vi.hoisted(() => ({
  state: null as AppState | null,
  surface: null as string | null,
  goTo: null as null | ((t: unknown) => void),
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mocked.state === null) throw new Error('store fixture is not initialized')
      return selector(mocked.state)
    },
  }
})
vi.mock('../../store/uiSurface', () => ({
  useUiSurface: <Selected,>(selector: (s: { surface: string | null; openSurface: () => void; clearSurface: () => void }) => Selected): Selected =>
    selector({ surface: mocked.surface, openSurface: () => {}, clearSurface: () => {} }),
}))
// nav の onClick は goTo を呼ぶだけ。goTo の実体（applyNavTarget）は本物を通し、hook を持たない形で nav を展開できるようにする。
vi.mock('./useGoTo', async importOriginal => {
  const actual = await importOriginal<typeof import('./useGoTo')>()
  return { ...actual, useGoTo: () => (t: unknown) => mocked.goTo?.(t) }
})

const { UserDockNav, UserSidebarNav } = await import('./UserNav')
const { App } = await import('../../App')
const { applyNavTarget } = await import('./useGoTo')
const { useStockSelection } = await import('../../store/stockSelection')
const { FundsHubView, OtherHubView, PortfolioSurfaceView } = await import('./HubSurfaces')

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

function collect(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { node.forEach(n => collect(n, pred, out)); return out }
  if (!isValidElement(node)) return out
  const el = node as ReactElement<Record<string, unknown>>
  if (pred(el)) out.push(el)
  if (typeof el.type === 'function') collect((el.type as (p: unknown) => ReactNode)(el.props), pred, out)
  else collect(el.props.children as ReactNode, pred, out)
  return out
}

const textOf = (el: ReactElement<Record<string, unknown>>): string => {
  const parts: string[] = []
  const walk = (n: ReactNode) => {
    if (typeof n === 'string') parts.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (isValidElement(n)) { if ((n.props as Record<string, unknown>)['aria-hidden'] !== 'true') walk((n.props as { children?: ReactNode }).children) }
  }
  walk(el.props.children as ReactNode)
  return parts.join('')
}

/** nav の実際の button をクリックし、goTo に渡った NavTarget を実際の applyNavTarget で activeTab / 面へ反映する。 */
function clickNav(nav: ReactElement, label: string, current: { tab: TabId; surface: string | null }) {
  const calls: NavTarget[] = []
  mocked.goTo = t => {
    calls.push(t as NavTarget)
    applyNavTarget(t as NavTarget, {
      setTab: tab => { current.tab = tab },
      openSurface: s => { current.surface = s },
      clearSurface: () => { current.surface = null },
      clearStockSelection: () => useStockSelection.getState().clear(),
    })
  }
  const buttons = collect(nav, el => el.type === 'button' && textOf(el) === label)
  expect(buttons, `${label} ボタン`).toHaveLength(1)
  ;(buttons[0].props.onClick as () => void)()
  return calls
}

beforeEach(() => {
  mocked.state = { ...BASE, activeTab: 'T0' }
  mocked.surface = null
  useStockSelection.getState().clear()
})

function renderApp(current: { tab: TabId; surface: string | null }): string {
  mocked.state = { ...BASE, activeTab: current.tab }
  mocked.surface = current.surface
  return renderToStaticMarkup(<App />)
}

describe('個別株への到達（実際の onClick）', () => {
  it('モバイル下部ナビ「個別株」→ T1 → 個別株面（R4.1）', () => {
    const current = { tab: 'T0' as TabId, surface: null as string | null }
    const calls = clickNav(<UserDockNav />, '個別株', current)
    expect(calls).toEqual([{ tab: 'T1', surface: null }])
    expect(current).toEqual({ tab: 'T1', surface: null })
    const html = renderApp(current)
    expect(html).toContain('data-testid="stocks-surface"')
    expect(html).toContain('u9-dock')
    expect(html).not.toContain('class="app-header"')
  })

  it('デスクトップ左サイドバー「個別株」→ T1 → 個別株面（R4.1）', () => {
    const current = { tab: 'T0' as TabId, surface: null as string | null }
    const calls = clickNav(<UserSidebarNav />, '個別株', current)
    expect(calls).toEqual([{ tab: 'T1', surface: null }])
    expect(renderApp(current)).toContain('data-testid="stocks-surface"')
  })

  it('他の面（PF / ハブ / 判断の詳細）から「個別株」へ: 面を解除して個別株面を表示する', () => {
    for (const surface of ['pf', 'funds_hub', 'other_hub', 'audit']) {
      const current = { tab: 'T0' as TabId, surface: surface as string | null }
      clickNav(<UserDockNav />, '個別株', current)
      expect(current, surface).toEqual({ tab: 'T1', surface: null })
    }
  })
})

describe('銘柄選択 → 詳細 → 戻る（選択状態は表示専用ストア）', () => {
  it('選択で詳細、戻る（clear）で一覧。deep link は select(code) だけで詳細へ入れる', () => {
    expect(useStockSelection.getState().selectedCode).toBeNull()
    useStockSelection.getState().select('8306')
    expect(useStockSelection.getState().selectedCode).toBe('8306')
    useStockSelection.getState().clear()
    expect(useStockSelection.getState().selectedCode).toBeNull()
  })

  it('詳細を開いたまま「個別株」を再タップすると一覧へ戻る（ナビ操作は選択を解除する）', () => {
    useStockSelection.getState().select('6098')
    const current = { tab: 'T1' as TabId, surface: null as string | null }
    clickNav(<UserDockNav />, '個別株', current)
    expect(useStockSelection.getState().selectedCode).toBeNull()
    expect(current.tab).toBe('T1')
  })

  it('詳細を開いたまま他の主ナビへ移動 → 戻っても詳細に留まらない', () => {
    useStockSelection.getState().select('6098')
    const current = { tab: 'T1' as TabId, surface: null as string | null }
    clickNav(<UserDockNav />, '今日', current)
    expect(current.tab).toBe('T0')
    expect(useStockSelection.getState().selectedCode).toBeNull()
  })
})

describe('T0–T9 の到達性（回帰: 個別株面化で他画面を失わない）', () => {
  it('主ナビ + ハブ + PF 面の実ボタンから、T0〜T9 のすべてに到達できる（従来のホームは不要）', () => {
    const reached = new Set<string>()
    const surfaces = new Set<string>()
    const record = (t: NavTarget) => { if (t.tab !== null) reached.add(t.tab); if (t.surface !== null) surfaces.add(t.surface) }

    for (const nav of [<UserDockNav key="d" />, <UserSidebarNav key="s" />]) {
      const targets: NavTarget[] = []
      mocked.goTo = t => targets.push(t as NavTarget)
      for (const b of collect(nav, el => el.type === 'button')) (b.props.onClick as () => void)()
      targets.forEach(record)
    }
    const hubTargets: NavTarget[] = []
    const hubs = [
      <FundsHubView key="f" vm={projectFundsHub(projectPortfolio(UNAVAILABLE_ALLOCATION))} onNavigate={t => hubTargets.push(t)} />,
      <OtherHubView key="o" vm={assembleOtherHub({ decisionGeneratedAt: null, marketAt: null, candidatesAt: null })} onNavigate={t => hubTargets.push(t)} />,
      <PortfolioSurfaceView key="p" vm={{ portfolio: projectPortfolio(fixtureAllocation()), snapshotLabel: '10/6 8:30', grossCash: { kind: 'known', amountJpy: 2_660_000 }, deployableCash: { kind: 'available', amountJpy: 1_200_000 } }} onNavigate={t => hubTargets.push(t)} />,
    ]
    for (const hub of hubs) {
      for (const b of collect(hub, el => el.type === 'button' && typeof el.props['data-hub-link'] === 'string')) (b.props.onClick as () => void)()
    }
    hubTargets.forEach(record)

    expect([...reached].sort()).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'])
    expect([...surfaces].sort()).toEqual(['funds_hub', 'other_hub', 'pf'])
  })
})
