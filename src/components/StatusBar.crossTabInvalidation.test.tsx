import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { useAppStore } from '../store/useAppStore'
import { CROSS_TAB_STATE_STALE_MESSAGE, createPortfolioLoadSingleFlight, portfolioLoadFeedback } from './portfolioLoadUi'
import {
  CROSS_TAB_RELOAD_FAILURE_MESSAGE,
  CrossTabInvalidationWarning,
  StatusBar,
  crossTabInvalidationViewModel,
  executeStatusBarCrossTabReload,
  executeStatusBarCrossTabReloadFlow,
  executeStatusBarRefreshClickFlow,
  isCrossTabInvalidationStale,
  reloadBrowserPage,
  statusBarCrossTabExternalClearReset,
  statusBarRefreshButtonDisabled,
} from './StatusBar'
// Vite's `?raw` suffix returns a module's own source text as a plain string (no @types/node
// fs/url dependency needed). This project has no vite-env.d.ts referencing vite/client's
// built-in `declare module '*?raw'`, so it is declared locally here.
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import statusBarSource from './StatusBar.tsx?raw'

const initialAppState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppState, true)
  delete (globalThis as { window?: unknown }).window
})

function extractButtonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? []
}

describe('RA-008-D2 shared warning message', () => {
  it('exports the exact stale message constant', () => {
    expect(CROSS_TAB_STATE_STALE_MESSAGE).toBe('別タブで更新された状態を検出しました。画面を再読み込みしてください。')
  })

  it('portfolioLoadFeedback(CROSS_TAB_STATE_STALE) returns the same constant', () => {
    const feedback = portfolioLoadFeedback({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    expect(feedback?.message).toBe(CROSS_TAB_STATE_STALE_MESSAGE)
  })

  it('StatusBar warning view model uses the same constant', () => {
    const vm = crossTabInvalidationViewModel(true, false, null)
    expect(vm.message).toBe(CROSS_TAB_STATE_STALE_MESSAGE)
  })

  it('leaves other coordination messages unchanged', () => {
    const timeout = portfolioLoadFeedback({ ok: false, operation: 'refreshAllData', code: 'WEB_LOCK_TIMEOUT', retryable: true })
    const busy = portfolioLoadFeedback({ ok: false, operation: 'refreshAllData', code: 'LOCAL_OPERATION_BUSY', retryable: true })
    expect(timeout?.message).toContain('タイムアウト')
    expect(busy?.message).toContain('別のポートフォリオ処理')
  })

  it('never hard-codes the stale message literal inside StatusBar.tsx (single source only)', () => {
    expect(statusBarSource).not.toContain('別タブで更新された状態を検出しました')
  })
})

describe('RA-008-D2 initial render — banner presence', () => {
  // NOTE: zustand v4's useStore falls back to api.getInitialState() (not the live
  // getState()) as the React 18 server snapshot during renderToStaticMarkup, so a
  // live useAppStore.setState() mutation cannot be observed through a fresh SSR
  // render of the full StatusBar tree. The default (never-mutated) initial store
  // state genuinely has crossTabInvalidation===undefined, so this render is a
  // faithful, deterministic "no warning" integration check. Stale-state structural
  // assertions (aria-label, role, button wiring, forbidden fields, disabled state)
  // are covered DOM-free below via CrossTabInvalidationWarning element-tree
  // inspection and the pure view-model/predicate functions, which do not depend on
  // this SSR snapshot limitation.
  it('shows no banner and no reload button by default (crossTabInvalidation undefined)', () => {
    const html = renderToStaticMarkup(<StatusBar />)
    expect(html).not.toContain('別タブ更新通知')
    expect(html).not.toContain('role="alert"')
    expect(extractButtonTags(html)).toHaveLength(1) // refresh button only
    expect(extractButtonTags(html)[0]).not.toContain('disabled')
  })
})

describe('RA-008-D2 CrossTabInvalidationWarning element tree', () => {
  it('renders nothing when not visible', () => {
    const el = CrossTabInvalidationWarning({
      viewModel: crossTabInvalidationViewModel(false, false, null),
      onReload: () => {},
    })
    expect(el).toBeNull()
  })

  it('renders role=alert, aria-label, message, and a wired reload button', () => {
    const onReload = vi.fn()
    const vm = crossTabInvalidationViewModel(true, false, null)
    const el = CrossTabInvalidationWarning({ viewModel: vm, onReload })
    expect(el).not.toBeNull()
    expect(el!.type).toBe('div')
    expect(el!.props.role).toBe('alert')
    expect(el!.props['aria-label']).toBe('別タブ更新通知')
    expect(el!.props.style.display).toBe('flex')
    expect(el!.props.style.flexWrap).toBe('wrap')

    const children = el!.props.children as any[]
    expect(children).toHaveLength(3) // message, button, failureMessage-slot — no extra injected content
    const [messageSpan, button] = children
    expect(messageSpan.props.children).toBe(CROSS_TAB_STATE_STALE_MESSAGE)
    expect(button.type).toBe('button')
    expect(button.props.type).toBe('button')
    expect(button.props.onClick).toBe(onReload)
    expect(button.props.disabled).toBe(false)
    expect(button.props.children).toBe('再読み込み')
    expect(button.props.autoFocus).toBeUndefined()
  })

  it('shows the pending label and disables the button while reload is requested', () => {
    const vm = crossTabInvalidationViewModel(true, true, null)
    const el = CrossTabInvalidationWarning({ viewModel: vm, onReload: () => {} })
    const [, button] = el!.props.children as any[]
    expect(button.props.disabled).toBe(true)
    expect(button.props.children).toBe('再読み込み中…')
  })

  it('shows the sanitized failure message only when present, and hides it otherwise', () => {
    const withoutFailure = CrossTabInvalidationWarning({
      viewModel: crossTabInvalidationViewModel(true, false, null),
      onReload: () => {},
    })
    const childrenWithout = withoutFailure!.props.children as any[]
    expect(childrenWithout[2]).toBeFalsy()

    const withFailure = CrossTabInvalidationWarning({
      viewModel: crossTabInvalidationViewModel(true, false, CROSS_TAB_RELOAD_FAILURE_MESSAGE),
      onReload: () => {},
    })
    const childrenWith = withFailure!.props.children as any[]
    expect(childrenWith[2].props.children).toBe(CROSS_TAB_RELOAD_FAILURE_MESSAGE)
  })
})

describe('RA-008-D2 reload helper — executeStatusBarCrossTabReload', () => {
  it('returns true and calls reload exactly once on success', () => {
    const reload = vi.fn()
    expect(executeStatusBarCrossTabReload(reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('returns false and swallows the thrown error on failure', () => {
    const reload = () => { throw new Error('raw reload sentinel') }
    expect(() => executeStatusBarCrossTabReload(reload)).not.toThrow()
    expect(executeStatusBarCrossTabReload(reload)).toBe(false)
  })
})

describe('RA-008-D2 reload click flow — executeStatusBarCrossTabReloadFlow', () => {
  it('clears failure, marks requested, and calls reload exactly once on success', () => {
    const reload = vi.fn()
    const requestedCalls: boolean[] = []
    const failureCalls: Array<string | null> = []
    executeStatusBarCrossTabReloadFlow(reload, false, v => requestedCalls.push(v), v => failureCalls.push(v))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(requestedCalls).toEqual([true])
    expect(failureCalls).toEqual([null])
  })

  it('suppresses a duplicate click while already requested (no extra reload call)', () => {
    const reload = vi.fn()
    const requestedCalls: boolean[] = []
    const failureCalls: Array<string | null> = []
    executeStatusBarCrossTabReloadFlow(reload, true, v => requestedCalls.push(v), v => failureCalls.push(v))
    expect(reload).not.toHaveBeenCalled()
    expect(requestedCalls).toEqual([])
    expect(failureCalls).toEqual([])
  })

  it('sanitizes a thrown reload error, re-enables the button, and permits retry', () => {
    const reload = vi.fn(() => { throw new Error('raw reload sentinel details') })
    const requestedCalls: boolean[] = []
    const failureCalls: Array<string | null> = []
    executeStatusBarCrossTabReloadFlow(reload, false, v => requestedCalls.push(v), v => failureCalls.push(v))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(requestedCalls).toEqual([true, false])
    expect(failureCalls).toEqual([null, CROSS_TAB_RELOAD_FAILURE_MESSAGE])
    expect(JSON.stringify(failureCalls)).not.toContain('raw reload sentinel')

    // retry — reloadRequested has been reset to false, so a fresh attempt proceeds
    const retryReload = vi.fn()
    const retryRequested: boolean[] = []
    const retryFailure: Array<string | null> = []
    executeStatusBarCrossTabReloadFlow(retryReload, false, v => retryRequested.push(v), v => retryFailure.push(v))
    expect(retryReload).toHaveBeenCalledTimes(1)
    expect(retryRequested).toEqual([true])
    expect(retryFailure).toEqual([null])
  })

  it('never touches the store while reloading', () => {
    const before = useAppStore.getState()
    executeStatusBarCrossTabReloadFlow(() => {}, false, () => {}, () => {})
    expect(useAppStore.getState()).toBe(before)
  })
})

describe('RA-008-D2 isCrossTabInvalidationStale', () => {
  it('is false when undefined', () => {
    expect(isCrossTabInvalidationStale(undefined)).toBe(false)
  })

  it('is true when status is stale', () => {
    expect(isCrossTabInvalidationStale({ status: 'stale' })).toBe(true)
  })
})

describe('RA-008-D2 statusBarRefreshButtonDisabled', () => {
  it('is disabled when stale, even if otherwise idle', () => {
    expect(statusBarRefreshButtonDisabled(false, true)).toBe(true)
  })

  it('is enabled when neither pending/loading nor stale', () => {
    expect(statusBarRefreshButtonDisabled(false, false)).toBe(false)
  })

  it('preserves the existing pending/loading disabled reason once stale clears', () => {
    expect(statusBarRefreshButtonDisabled(true, false)).toBe(true)
  })
})

describe('RA-008-D2 crossTabInvalidationViewModel', () => {
  it('stays hidden when not stale regardless of local reload state', () => {
    expect(crossTabInvalidationViewModel(false, false, null).visible).toBe(false)
    expect(crossTabInvalidationViewModel(false, true, 'x').visible).toBe(false)
  })

  it('stays visible while stale even immediately after a successful reload call (no local-only hide)', () => {
    expect(crossTabInvalidationViewModel(true, true, null).visible).toBe(true)
  })

  it('suppresses the failure message when not stale', () => {
    expect(crossTabInvalidationViewModel(false, false, 'some failure').failureMessage).toBeNull()
  })

  it('passes through the failure message while stale', () => {
    expect(crossTabInvalidationViewModel(true, false, CROSS_TAB_RELOAD_FAILURE_MESSAGE).failureMessage).toBe(CROSS_TAB_RELOAD_FAILURE_MESSAGE)
  })
})

describe('RA-008-D2 external clear — statusBarCrossTabExternalClearReset', () => {
  it('resets local reload state once the warning clears externally', () => {
    const requested: boolean[] = []
    const failure: Array<string | null> = []
    statusBarCrossTabExternalClearReset(false, v => requested.push(v), v => failure.push(v))
    expect(requested).toEqual([false])
    expect(failure).toEqual([null])
  })

  it('does nothing while still stale', () => {
    const requested: boolean[] = []
    const failure: Array<string | null> = []
    statusBarCrossTabExternalClearReset(true, v => requested.push(v), v => failure.push(v))
    expect(requested).toEqual([])
    expect(failure).toEqual([])
  })
})

describe('RA-008-D2 normal refresh disabled while stale — executeStatusBarRefreshClickFlow', () => {
  it('calls the refresh action zero times while stale', async () => {
    const action = vi.fn(async () => ({ ok: true as const, operation: 'refreshAllData' as const, code: 'SUCCESS' as const }))
    const pending: boolean[] = []
    const feedback: unknown[] = []
    await executeStatusBarRefreshClickFlow(true, action, createPortfolioLoadSingleFlight(), v => pending.push(v), v => feedback.push(v))
    expect(action).not.toHaveBeenCalled()
    expect(pending).toEqual([])
    expect(feedback).toEqual([])
  })

  it('delegates normally once not stale', async () => {
    const action = vi.fn(async () => ({ ok: true as const, operation: 'refreshAllData' as const, code: 'SUCCESS' as const }))
    const pending: boolean[] = []
    const feedback: unknown[] = []
    await executeStatusBarRefreshClickFlow(false, action, createPortfolioLoadSingleFlight(), v => pending.push(v), v => feedback.push(v))
    expect(action).toHaveBeenCalledTimes(1)
    expect(pending).toEqual([true, false])
    expect(feedback).toEqual([null, null]) // pre-clear + SUCCESS-has-no-feedback, per existing contract
  })
})

describe('RA-008-D2 browser reload target — reloadBrowserPage', () => {
  it('module import performs zero window access', () => {
    expect(typeof window).toBe('undefined')
  })

  it('is fail-soft when window is unavailable', () => {
    expect(typeof window).toBe('undefined')
    expect(executeStatusBarCrossTabReload(reloadBrowserPage)).toBe(false)
  })

  it('is fail-soft when window.location.reload is missing', () => {
    ;(globalThis as any).window = { location: {} }
    expect(executeStatusBarCrossTabReload(reloadBrowserPage)).toBe(false)
  })

  it('is fail-soft when window.location.reload throws', () => {
    ;(globalThis as any).window = { location: { reload: () => { throw new Error('boom') } } }
    expect(executeStatusBarCrossTabReload(reloadBrowserPage)).toBe(false)
  })

  it('is fail-soft when accessing window.location itself throws', () => {
    ;(globalThis as any).window = {
      get location(): never { throw new Error('getter boom') },
    }
    expect(executeStatusBarCrossTabReload(reloadBrowserPage)).toBe(false)
  })

  it('calls window.location.reload exactly once when available', () => {
    const reload = vi.fn()
    ;(globalThis as any).window = { location: { reload } }
    expect(executeStatusBarCrossTabReload(reloadBrowserPage)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('RA-008-D2 source wiring guards (mutation-catching, DOM-free)', () => {
  it('handleCrossTabReload delegates to the pure flow with reloadBrowserPage only', () => {
    const match = statusBarSource.match(/const handleCrossTabReload = \(\) => \{\n(.*)\n {2}\}/)
    expect(match).not.toBeNull()
    expect(match![1].trim()).toBe(
      'executeStatusBarCrossTabReloadFlow(reloadBrowserPage, reloadRequested, setReloadRequested, setReloadFailure)',
    )
  })

  it('never calls refreshAllData/refresh from within the cross-tab reload handler', () => {
    const start = statusBarSource.indexOf('const handleCrossTabReload')
    const end = statusBarSource.indexOf('const refreshButton')
    const handlerBlock = statusBarSource.slice(start, end)
    expect(handlerBlock).not.toMatch(/refresh\(|refreshAllData/)
  })

  it('never calls store.setState anywhere in StatusBar.tsx', () => {
    expect(statusBarSource).not.toMatch(/\.setState\(/)
  })

  it('references reloadBrowserPage exactly twice (declaration + single call site)', () => {
    const occurrences = statusBarSource.split('reloadBrowserPage').length - 1
    expect(occurrences).toBe(2)
  })

  it('never accesses window outside the reloadBrowserPage function body', () => {
    const fnStart = statusBarSource.indexOf('export function reloadBrowserPage')
    const fnEnd = statusBarSource.indexOf('\n}', fnStart)
    const outside = statusBarSource.slice(0, fnStart) + statusBarSource.slice(fnEnd)
    // Only real code access (window.xxx / typeof window) matters here — the Japanese
    // comment above the function legitimately contains the substring "window".
    expect(outside).not.toMatch(/typeof window|window\.location|window\.[a-zA-Z]/)
  })

  it('derives stale via the single exported predicate (not an inline/hard-coded condition)', () => {
    expect(statusBarSource).toContain('const stale = isCrossTabInvalidationStale(system.crossTabInvalidation)')
  })

  it('derives the refresh-disabled attribute via the single exported helper', () => {
    expect(statusBarSource).toContain('statusBarRefreshButtonDisabled(refreshButton.disabled, stale)')
    expect(statusBarSource).toContain('disabled={refreshDisabled}')
  })

  it('never introduces a local-only visibility flag for the banner (visible stays tied to stale)', () => {
    expect(statusBarSource).toContain('visible: stale,')
  })
})
