import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Trust } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

// UI-9C: T7案D — MobileBottomActionBarはT7から撤去され、実行CTAはshortTermRows.length>0
// && !isSuppressedのときのみ本文内「本日エントリー済みにする」ボタンとして現れる。

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T7 store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

import { T7_Trust } from './T7_Trust'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t7Source from './T7_Trust.tsx?raw'

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

const CORE_TRUST: Trust = {
  id: 'trust:navshell-core-a',
  name: '国内株コア投信（回帰テスト用）',
  abbr: 'NAV-CORE-A',
  account: 'test-only',
  policy: 'JAPAN_SHORTTERM',
  eval: 500_000,
  pnlPct: 1,
  dayPct: 0.5,
  cost: 0.1,
  mu: 0.1,
  sigma: 0.1,
  score: 60,
  signal: 'HOLD',
  ev: 0,
  decision: 'HOLD',
}

const FRESH_TIMESTAMP = '2099-01-01T00:00:00.000Z'

// SAFE_MODE/DQ抑制を解除した状態（D: rows>0 && !isSuppressed を成立させるための前提）
function notSuppressedOverrides(): Partial<AppState> {
  return {
    safeMode: {
      ...BASE_APP_STATE.safeMode,
      safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: false },
    },
    market: {
      ...BASE_APP_STATE.market,
      last_updated: FRESH_TIMESTAMP,
    },
    system: {
      ...BASE_APP_STATE.system,
      dataSourceStatus: {
        ...BASE_APP_STATE.system.dataSourceStatus,
        market: 'loaded',
        safeMode: 'loaded',
      },
      dataTimestamps: {
        ...BASE_APP_STATE.system.dataTimestamps!,
        market: FRESH_TIMESTAMP,
        safeMode: FRESH_TIMESTAMP,
      },
    },
  }
}

function renderT7(overrides: Partial<AppState>): string {
  mockedStore.state = { ...BASE_APP_STATE, activeTab: 'T7', ...overrides }
  return renderToStaticMarkup(<T7_Trust />)
}

describe('T7_Trust — UI-9C T7案D: MobileBottomActionBar撤去（B）', () => {
  it('B: T7にMobileBottomActionBarの固定CTA（data-mobile-bar）が存在しない', () => {
    const html = renderT7({ ...notSuppressedOverrides(), trust: [CORE_TRUST] })
    expect(html).not.toContain('data-mobile-bar')
    expect(html).not.toMatch(/role="toolbar"\s+aria-label="アクションバー"/)
  })

  it('B: T7_Trust.tsxはMobileBottomActionBarをimport/renderしない', () => {
    expect(t7Source).not.toContain('MobileBottomActionBar')
  })
})

describe('T7_Trust — 実行CTA authority（C/D）', () => {
  it('C: shortTermRows.length === 0 のとき実行CTAを表示しない', () => {
    const html = renderT7({ ...notSuppressedOverrides(), trust: [] })
    expect(html).not.toContain('本日エントリー済みにする')
  })

  it('D: shortTermRows.length > 0 && !isSuppressed のときのみ本文内実行CTAを表示する', () => {
    const html = renderT7({ ...notSuppressedOverrides(), trust: [CORE_TRUST] })
    expect(html).toContain('本日エントリー済みにする')
  })

  it('I-7: 実行CTAはaccessible nameと既存interactionを維持し44px touch targetを持つ', () => {
    const html = renderT7({ ...notSuppressedOverrides(), trust: [CORE_TRUST] })
    const button = html.match(/<button[^>]*>(?:\s*)本日エントリー済みにする(?:\s*)<\/button>/)?.[0]
    expect(button).toBeTruthy()
    expect(button).toContain('min-height:44px')
    expect(button).toContain('display:inline-flex')
    expect(button).toContain('align-items:center')
    expect(button).toContain('justify-content:center')

    const buttonSource = t7Source.slice(
      t7Source.lastIndexOf('<button', t7Source.indexOf('本日エントリー済みにする')),
      t7Source.indexOf('</button>', t7Source.indexOf('本日エントリー済みにする')),
    )
    expect(buttonSource).toContain('onClick={handleMarkExecuted}')
    expect(buttonSource).toContain("disabled={todayEntryCount >= 1 || trustPlan.shortTermMode.candidateDirection === 'WAIT'}")
  })

  it('D否定側: SAFE_MODE active時はrows>0でも実行CTAを表示しない', () => {
    const html = renderT7({
      ...notSuppressedOverrides(),
      trust: [CORE_TRUST],
      safeMode: {
        ...BASE_APP_STATE.safeMode,
        safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: true },
      },
    })
    expect(html).not.toContain('本日エントリー済みにする')
  })
})
