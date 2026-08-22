// UI-9F-A-RUNTIME-STATE-INTEGRITY — F-P0-2 required test (T-4相当).
// GlobalErrorBannerがinitialize/refreshAllDataのstatus='failed'|'partial'でも
// 到達可能なerror stateを描画すること、既存のCSV系status='error'経路を壊さないことを検証する。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from './types'
import { createAppStoreInstanceForTest } from './store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('./store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('./store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('GlobalErrorBanner fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

const { GlobalErrorBanner } = await import('./App')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

function renderWith(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<GlobalErrorBanner />)
}

describe('F-P0-2: GlobalErrorBanner — data status=failed/partialでも到達可能なerror stateを作る', () => {
  it('status=success では何も描画しない', () => {
    const state: AppState = { ...BASE_APP_STATE, system: { ...BASE_APP_STATE.system, status: 'success', error: null } }
    const html = renderWith(state)
    expect(html).toBe('')
  })

  it('status=initializing では何も描画しない（起動中はエラー扱いしない）', () => {
    const state: AppState = { ...BASE_APP_STATE, system: { ...BASE_APP_STATE.system, status: 'initializing', error: null } }
    const html = renderWith(state)
    expect(html).toBe('')
  })

  it('status=failed（全ソースfallback）でrole="alert"のバナーと再試行ボタンが出る', () => {
    const state: AppState = {
      ...BASE_APP_STATE,
      system: {
        ...BASE_APP_STATE.system,
        status: 'failed',
        error: null,
        dataSourceOutcome: { loaded: 0, total: 17 },
      },
    }
    const html = renderWith(state)
    expect(html).toContain('role="alert"')
    expect(html).toContain('最新データを取得できませんでした')
    expect(html).toContain('再試行')
    // status='success'を偽装するdotや「最終更新に当日時刻」のような虚偽表示と同居しないこと
    expect(html).not.toContain('データ取得エラー:')
  })

  it('status=partial（一部fallback）でN/M件数付きのバナーが出る', () => {
    const state: AppState = {
      ...BASE_APP_STATE,
      system: {
        ...BASE_APP_STATE.system,
        status: 'partial',
        error: null,
        dataSourceOutcome: { loaded: 14, total: 17 },
      },
    }
    const html = renderWith(state)
    expect(html).toContain('role="alert"')
    expect(html).toContain('一部データを取得できませんでした（3/17）')
  })

  it('status=error（既存のCSV系経路）は従来通りerrorメッセージ+閉じるボタンを描画する（回帰防止）', () => {
    const state: AppState = {
      ...BASE_APP_STATE,
      system: { ...BASE_APP_STATE.system, status: 'error', error: 'CSV import failed: bad row 3' },
    }
    const html = renderWith(state)
    expect(html).toContain('role="alert"')
    expect(html).toContain('データ取得エラー: CSV import failed: bad row 3')
    expect(html).toContain('閉じる')
    expect(html).not.toContain('再試行')
  })
})
