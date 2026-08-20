import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, TabId } from '../types'
import { createAppStoreInstanceForTest } from '../store/useAppStore'
import { BottomDockNav, computeDockTabTrapTarget } from './BottomDockNav'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import dockSource from './BottomDockNav.tsx?raw'

// UI-9C: T7案D — BottomDockNavはT7でも常に表示される単一nav系統。
// aria-current="page"のみを現在地に付与し、aria-selectedは残さない。
// More sheetのTabトラップ境界判定は純関数として抽出し、DOM非依存で検証する。

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('BottomDockNav store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

function renderDock(activeTab: TabId): string {
  mockedStore.state = { ...BASE_APP_STATE, activeTab }
  return renderToStaticMarkup(<BottomDockNav />)
}

describe('BottomDockNav — UI-9C T7案D: 常時表示（A）', () => {
  it('A: T7でもBottomDockがrenderされ、T7項目がactiveになる', () => {
    const html = renderDock('T7')
    expect(html).toContain('class="bottom-dock"')
    const activeButton = html.match(/<button class="bottom-dock__item active"[\s\S]*?<\/button>/)
    expect(activeButton).toBeTruthy()
    expect(activeButton![0]).toContain('実行プラン')
  })

  it('T7でも他タブ同様にprimary dock item 4件 + Moreボタンがrenderされる', () => {
    const html = renderDock('T7')
    const itemCount = (html.match(/class="bottom-dock__item/g) ?? []).length
    expect(itemCount).toBe(5) // T0, T5, T1, T7 + More
  })
})

describe('BottomDockNav — navigation semantics（F/G/H）', () => {
  it('F: activeなitemのみaria-current="page"を持つ（ちょうど1件）', () => {
    const html = renderDock('T1')
    const matches = html.match(/aria-current="page"/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('G: inactiveなitemにaria-currentが付与されない', () => {
    const html = renderDock('T1')
    const homeButton = html.match(/<button[^>]*>[\s\S]*?ホーム[\s\S]*?<\/button>/)
    expect(homeButton).toBeTruthy()
    expect(homeButton![0]).not.toContain('aria-current')
  })

  it('H: 不正なaria-selectedが残っていない', () => {
    const html = renderDock('T7')
    expect(html).not.toContain('aria-selected')
  })

  it('Moreボタン自体はページ遷移先ではないためaria-currentを持たない（aria-expanded/aria-labelのみ）', () => {
    const html = renderDock('T0')
    const moreMatch = html.match(/<button[^>]*aria-label="その他の画面"[^>]*>/)
    expect(moreMatch).toBeTruthy()
    expect(moreMatch![0]).not.toContain('aria-current')
    expect(moreMatch![0]).toContain('aria-expanded="false"')
  })
})

describe('computeDockTabTrapTarget — More sheet Tab trap 境界判定（I）', () => {
  it('Tab（非Shift）で末尾indexにいるときは先頭(0)へ折り返す', () => {
    expect(computeDockTabTrapTarget(3, 2, false)).toBe(0)
  })

  it('Shift+Tabで先頭index(0)にいるときは末尾へ折り返す', () => {
    expect(computeDockTabTrapTarget(3, 0, true)).toBe(2)
  })

  it('境界でない中間indexでは折り返さない（null = ブラウザ既定のTab移動）', () => {
    expect(computeDockTabTrapTarget(3, 1, false)).toBeNull()
    expect(computeDockTabTrapTarget(3, 1, true)).toBeNull()
  })

  it('focus対象がフォーカス可能要素の外にある場合（activeIndex=-1）は折り返さない', () => {
    expect(computeDockTabTrapTarget(3, -1, false)).toBeNull()
    expect(computeDockTabTrapTarget(3, -1, true)).toBeNull()
  })

  it('focusable要素が0件なら常にnull', () => {
    expect(computeDockTabTrapTarget(0, -1, false)).toBeNull()
    expect(computeDockTabTrapTarget(0, -1, true)).toBeNull()
  })
})

describe('BottomDockNav More sheet — dialog契約の構造回帰（I 補助）', () => {
  it('role=dialog / aria-modal=true / Escape close / focus restoreの配線が維持されている', () => {
    expect(dockSource).toContain('role="dialog"')
    expect(dockSource).toContain('aria-modal="true"')
    expect(dockSource).toContain("e.key === 'Escape'")
    expect(dockSource).toContain('moreButtonRef.current?.focus()')
    expect(dockSource).toContain('computeDockTabTrapTarget(focusables.length, activeIndex, e.shiftKey)')
  })

  it('T7早期returnは完全に除去されている', () => {
    expect(dockSource).not.toMatch(/activeTab === 'T7'\)\s*return null/)
  })
})
