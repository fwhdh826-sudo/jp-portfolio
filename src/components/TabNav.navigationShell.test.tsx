import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, TabId } from '../types'
import { createAppStoreInstanceForTest } from '../store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('TabNav store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

import { TabNav } from './TabNav'

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

function renderTabNav(activeTab: TabId): string {
  mockedStore.state = { ...BASE_APP_STATE, activeTab }
  return renderToStaticMarkup(<TabNav />)
}

describe('TabNav — navigation semantics（F/G/H）', () => {
  it('F: activeなitemのみaria-current="page"を持つ（ちょうど1件）', () => {
    const html = renderTabNav('T3')
    const matches = html.match(/aria-current="page"/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('G: inactiveなitemにaria-currentが付与されない', () => {
    const html = renderTabNav('T3')
    const homeButton = html.match(/<button[^>]*>[\s\S]*?ホーム[\s\S]*?<\/button>/)
    expect(homeButton).toBeTruthy()
    expect(homeButton![0]).not.toContain('aria-current')
  })

  it('H: 不正なaria-selectedが残っていない', () => {
    const html = renderTabNav('T7')
    expect(html).not.toContain('aria-selected')
  })

  it('activeなitemはaria-current="page"かつ実行プランのラベルを含む（T7）', () => {
    const html = renderTabNav('T7')
    const activeButton = html.match(/<button class="tab-nav__item active"[\s\S]*?<\/button>/)
    expect(activeButton).toBeTruthy()
    expect(activeButton![0]).toContain('aria-current="page"')
    expect(activeButton![0]).toContain('実行プラン')
  })
})
