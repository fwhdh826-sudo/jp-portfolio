// UI-9F-A-RUNTIME-STATE-INTEGRITY — F-P0-3 required tests.
// 起動未完了(system.status==='initializing')中に、T0が
// 「データ更新失敗」「SAFE_MODE発動中」「重大なリスク要因は検出されていません」
// 「✓ 判断可能」を誤って同時表示しないことをrender結果で検証する（vacuous回避のため
// 実コンポーネントのrenderToStaticMarkup出力に対してassertする）。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T0 boot-state fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

// mock後にimportすることでvi.mockされたuseAppStoreを使わせる
const { T0_Home } = await import('./T0_Home')

const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolatedStore.store.getState()
isolatedStore.controls.dispose()

function renderWith(state: AppState): string {
  mockedStore.state = state
  return renderToStaticMarkup(<T0_Home />)
}

describe('F-P0-3: フレッシュなstoreはそのままboot(initializing) fixtureである', () => {
  it('status=initializing / lastUpdated=null / safeMode=DEFAULT(fail-closed active) / dataSourceStatus.safeMode=undefined', () => {
    expect(BASE_APP_STATE.system.status).toBe('initializing')
    expect(BASE_APP_STATE.system.lastUpdated).toBeNull()
    expect(BASE_APP_STATE.safeMode.safe_mode.active).toBe(true)
    expect(BASE_APP_STATE.system.dataSourceStatus.safeMode).toBeUndefined()
  })
})

describe('F-P0-3: T0は起動中(initializing)にfalseなerror/SAFE_MODE/安全宣言を表示しない', () => {
  it('「SAFE_MODE発動中」が0件', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).not.toContain('SAFE_MODE発動中')
  })

  it('「データ更新失敗」が0件', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).not.toContain('データ更新失敗')
  })

  it('「重大なリスク要因は検出されていません」が0件', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).not.toContain('重大なリスク要因は検出されていません')
  })

  it('「✓ 判断可能」が0件（loadingとsuccessを同時表示しない）', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).not.toContain('✓ 判断可能')
  })

  it('起動中である旨の単一メッセージが表示される', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).toContain('起動中 — データ取得中です')
  })

  // F-A-P1-1: SafeModeStatusCardはinitializing中、safe_mode.jsonの取得試行がまだ完了していないにも
  // 関わらず「safe_mode.json 未取得」「取得できないため」と断定していた（独立監査で指摘）。
  // 起動中は中立的な「起動中/取得中」文言に置き換わっていることを確認する。
  it('F-A-P1-1: SafeModeStatusCardが起動中に「未取得」「取得できない」と断定しない', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).not.toContain('safe_mode.json 未取得')
    expect(html).not.toContain('safe_mode.json が取得できないため')
  })

  it('F-A-P1-1: SafeModeStatusCardは起動中「起動中」を含む中立文言を表示する', () => {
    const html = renderWith(BASE_APP_STATE)
    expect(html).toContain('安全側停止（起動中）')
  })
})

describe('F-P0-3: 起動完了後(success)は通常表示に戻る（回帰防止）', () => {
  const recentIso = new Date(Date.now() - 60_000).toISOString()

  function successState(): AppState {
    return {
      ...BASE_APP_STATE,
      system: {
        ...BASE_APP_STATE.system,
        status: 'success',
        lastUpdated: recentIso,
        dataSourceStatus: { ...BASE_APP_STATE.system.dataSourceStatus, market: 'loaded', safeMode: 'loaded' },
        dataTimestamps: { ...BASE_APP_STATE.system.dataTimestamps!, market: recentIso, safeMode: recentIso },
      },
      safeMode: {
        ...BASE_APP_STATE.safeMode,
        safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: false, last_checked: recentIso },
      },
    }
  }

  it('「起動中」メッセージは表示されない', () => {
    const html = renderWith(successState())
    expect(html).not.toContain('起動中 — データ取得中です')
  })

  it('警告要因が無ければ「✓ 判断可能」が表示される', () => {
    const html = renderWith(successState())
    expect(html).toContain('✓ 判断可能')
  })
})

describe('F-P0-3: SAFE_MODE real(取得済みactive) と fallback(未取得のfail-closed) を区別する', () => {
  function baseSuccessState(): AppState {
    return {
      ...BASE_APP_STATE,
      system: {
        ...BASE_APP_STATE.system,
        status: 'success',
        lastUpdated: '2026-08-22T05:00:00.000Z',
        dataSourceStatus: { ...BASE_APP_STATE.system.dataSourceStatus, market: 'loaded' },
      },
    }
  }

  it('safe_mode.jsonが実際にloadedかつactiveなら「SAFE_MODE発動中」を表示する', () => {
    const state: AppState = {
      ...baseSuccessState(),
      system: {
        ...baseSuccessState().system,
        dataSourceStatus: { ...baseSuccessState().system.dataSourceStatus, safeMode: 'loaded' },
        dataTimestamps: { ...baseSuccessState().system.dataTimestamps!, safeMode: '2026-08-22T05:00:00.000Z' },
      },
      safeMode: {
        ...BASE_APP_STATE.safeMode,
        safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: true, last_checked: '2026-08-22T05:00:00.000Z' },
      },
    }
    const html = renderWith(state)
    expect(html).toContain('SAFE_MODE発動中')
    expect(html).not.toContain('安全側停止（データ未取得）')
  })

  it('safe_mode.jsonが未取得（fail-closedのdefault active:true）なら「安全側停止（データ未取得）」を表示し「SAFE_MODE発動中」は出さない', () => {
    // safeMode/dataSourceStatus.safeModeはBASE_APP_STATEのまま
    // （DEFAULT_SAFE_MODE_SNAPSHOT: active:true / dataSourceStatus.safeMode: undefined）。
    const html = renderWith(baseSuccessState())
    expect(html).not.toContain('SAFE_MODE発動中')
    expect(html).toContain('安全側停止（データ未取得）')
  })
})

// F-A-P1-2: RiskWarningCardはsystem.status==='error'しか見ておらず、partial/failedでは
// リスクが0件の場合に「重大なリスク要因は検出されていません」という誤った安全宣言を出していた
// （独立監査で全17ソース取得失敗時に実測）。partial/failedでは常にこの文言が出ないことを固定する。
describe('F-A-P1-2: RiskWarningCardはpartial/failed中に誤った安全宣言を出さない', () => {
  function partialState(): AppState {
    return {
      ...BASE_APP_STATE,
      system: {
        ...BASE_APP_STATE.system,
        status: 'partial',
        lastUpdated: '2026-08-20T00:00:00.000Z',
        dataSourceOutcome: { loaded: 13, total: 14 },
      },
    }
  }

  function failedState(): AppState {
    return {
      ...BASE_APP_STATE,
      system: {
        ...BASE_APP_STATE.system,
        status: 'failed',
        lastUpdated: '2026-08-20T00:00:00.000Z',
        dataSourceOutcome: { loaded: 0, total: 14 },
      },
    }
  }

  it('partialでは「重大なリスク要因は検出されていません」を表示しない', () => {
    const html = renderWith(partialState())
    expect(html).not.toContain('重大なリスク要因は検出されていません')
  })

  it('partialでは一部データ未取得を示すリスク項目を表示する', () => {
    const html = renderWith(partialState())
    expect(html).toContain('一部データソースを取得できませんでした')
  })

  it('failedでは「重大なリスク要因は検出されていません」を表示しない', () => {
    const html = renderWith(failedState())
    expect(html).not.toContain('重大なリスク要因は検出されていません')
  })

  it('failedではデータ取得失敗を示すリスク項目を表示する', () => {
    const html = renderWith(failedState())
    expect(html).toContain('データを取得できませんでした')
  })

  // F-A-P1-2 mutation probe: この抑制を戻す（=partial/failedでもrisks配列が空なら
  // 「重大なリスク要因は検出されていません」を出す）とREDになることの固定用。
  it('[mutation guard] partial/failedのいずれでも安全宣言が出ない', () => {
    expect(renderWith(partialState())).not.toContain('重大なリスク要因は検出されていません')
    expect(renderWith(failedState())).not.toContain('重大なリスク要因は検出されていません')
  })
})
