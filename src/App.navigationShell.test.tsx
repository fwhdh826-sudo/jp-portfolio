import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import type { AppState, TabId } from './types'
import { createAppStoreInstanceForTest } from './store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('./store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('App store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

import { DesktopSidebarNav } from './App'

// vitest disables CSS transforms by default (test.css=false), so `?raw` imports of
// .css resolve to an empty string — read the stylesheet directly from disk instead.
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const v10Css: string = readFileSync(resolve(SRC_ROOT, 'styles/v10.css'), 'utf8')

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

function renderSidebar(activeTab: TabId): string {
  mockedStore.state = { ...BASE_APP_STATE, activeTab }
  return renderToStaticMarkup(<DesktopSidebarNav />)
}

describe('Desktop sidebar — P0-1 sticky契約（E）', () => {
  it('E: .app-sidebar(desktop)はposition:stickyとalign-self:flex-startを持つ', () => {
    const block = v10Css.match(/\.app-sidebar\s*\{[^}]*position:\s*sticky[^}]*align-self:\s*flex-start[^}]*\}/)
    expect(block).toBeTruthy()
  })

  it('E: sidebar自身は独自のoverflow-yを新設しない（nested scroll禁止）', () => {
    const block = v10Css.match(/\.app-sidebar\s*\{[^}]*position:\s*sticky[\s\S]*?\}/)
    expect(block).toBeTruthy()
    expect(block![0]).not.toContain('overflow-y')
  })

  it('E: .app-shell-body(desktop, flex-direction:row)はoverflow:hiddenを持たない（windowがscroll owner）', () => {
    const block = v10Css.match(/\.app-shell-body\s*\{[^}]*flex-direction:\s*row[^}]*\}/)
    expect(block).toBeTruthy()
    expect(block![0]).not.toContain('overflow: hidden')
    expect(block![0]).not.toContain('overflow:hidden')
  })

  it('E: .app-shell-body .main-content(desktop)はoverflow-yを新設しない（nested scroll禁止）', () => {
    const block = v10Css.match(/\.app-shell-body \.main-content\s*\{[^}]*\}/)
    expect(block).toBeTruthy()
    expect(block![0]).not.toContain('overflow-y')
  })
})

describe('DesktopSidebarNav — navigation semantics（F/G/H）', () => {
  it('F: activeなitemのみaria-current="page"を持つ（ちょうど1件）', () => {
    const html = renderSidebar('T2')
    const matches = html.match(/aria-current="page"/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('G: inactiveなitemにaria-currentが付与されない', () => {
    const html = renderSidebar('T2')
    const homeButton = html.match(/<button[^>]*>[\s\S]*?ホーム[\s\S]*?<\/button>/)
    expect(homeButton).toBeTruthy()
    expect(homeButton![0]).not.toContain('aria-current')
  })

  it('H: 不正なaria-selectedが残っていない', () => {
    const html = renderSidebar('T7')
    expect(html).not.toContain('aria-selected')
  })

  it('activeなitemはaria-current="page"かつ実行プランのラベルを含む（T7）', () => {
    const html = renderSidebar('T7')
    const activeButton = html.match(/<button class="app-sidebar__item active"[\s\S]*?<\/button>/)
    expect(activeButton).toBeTruthy()
    expect(activeButton![0]).toContain('aria-current="page"')
    expect(activeButton![0]).toContain('実行プラン')
  })
})
