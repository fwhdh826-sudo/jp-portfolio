// UI-9F-B — F-P0-4 required tests.
//
// 注記（テスト手法の限界と、その回避）:
// 本リポジトリの vitest は node 環境で react-dom/server の renderToStaticMarkup を
// 使う（jsdom / testing-library は依存に無い）。React の SSR は error boundary を
// 一切呼ばない（例外はそのまま throw される）ため、「throw する子を JSX で包んで
// fallback を得る」書き方は SSR では成立しない。
// そこで本テストは React の error boundary 契約そのもの
// （static getDerivedStateFromError → state → render）を実コンポーネントに対して
// 実行し、fallback UI の到達を固定する。実ブラウザでの render throw → fallback は
// UI-9F-B の browser probe 側で別途確認している。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function require(id: string): any
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ErrorInfo, ReactNode } from 'react'
import {
  APP_ERROR_BOUNDARY_MESSAGE,
  APP_ERROR_BOUNDARY_TITLE,
  AppErrorBoundary,
} from './AppErrorBoundary'

// @types/node 非依存で repo 内のソースを読む（cwd = repo root）
const fs = require('fs') as { readFileSync: (p: string, enc: string) => string }

const SECRET_STACK = 'Error: nikkeiVI is undefined\n    at T0_Home (/src/components/tabs/T0_Home.tsx:785:31)'

function boom(): Error {
  const err = new Error('nikkeiVI is undefined')
  err.stack = SECRET_STACK
  return err
}

/**
 * SSR では error boundary が呼ばれないため、React が実際に行う手順
 * （getDerivedStateFromError の戻り値を state に反映 → render）を
 * 実コンポーネントに対して再現し、その render 結果を検証する。
 */
function renderFallback(onReload?: () => void): string {
  const instance = new AppErrorBoundary({ children: null as ReactNode, onReload })
  instance.state = AppErrorBoundary.getDerivedStateFromError()
  return renderToStaticMarkup(<>{instance.render()}</>)
}

describe('F-P0-4: AppErrorBoundary は React の error boundary 契約を実装している', () => {
  it('static getDerivedStateFromError を持ち、hasError:true を返す', () => {
    expect(typeof AppErrorBoundary.getDerivedStateFromError).toBe('function')
    expect(AppErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true })
  })

  it('componentDidCatch を持つ', () => {
    expect(typeof AppErrorBoundary.prototype.componentDidCatch).toBe('function')
  })

  it('例外前は children をそのまま通す（通常時は透過）', () => {
    const instance = new AppErrorBoundary({ children: <p>NORMAL_CHILD</p> })
    const html = renderToStaticMarkup(<>{instance.render()}</>)
    expect(html).toContain('NORMAL_CHILD')
    expect(html).not.toContain(APP_ERROR_BOUNDARY_TITLE)
  })
})

describe('F-P0-4: render 例外時に fallback UI へ到達する（白紙にしない）', () => {
  it('fallback が空文字列ではない', () => {
    expect(renderFallback().length).toBeGreaterThan(0)
  })

  it('明確なエラー表示「画面を表示できませんでした」が出る', () => {
    expect(renderFallback()).toContain(APP_ERROR_BOUNDARY_TITLE)
  })

  it('role="alert" で通知される', () => {
    expect(renderFallback()).toContain('role="alert"')
  })

  it('children はもう描画されない', () => {
    const instance = new AppErrorBoundary({ children: <p>NORMAL_CHILD</p> })
    instance.state = AppErrorBoundary.getDerivedStateFromError()
    expect(renderToStaticMarkup(<>{instance.render()}</>)).not.toContain('NORMAL_CHILD')
  })

  it('状況説明の本文が表示される', () => {
    expect(renderFallback()).toContain(APP_ERROR_BOUNDARY_MESSAGE)
  })
})

describe('F-P0-4: fallback から復旧導線に到達できる', () => {
  it('「再読み込み」ボタンが存在する', () => {
    const html = renderFallback()
    expect(html).toContain('<button')
    expect(html).toContain('再読み込み')
  })

  it('再読み込みボタンは 44×44 以上のタップターゲットを持つ', () => {
    const html = renderFallback()
    expect(html).toContain('min-width:44px')
    expect(html).toContain('min-height:44px')
  })

  it('再読み込みハンドラが呼び出せる（導線が接続されている）', () => {
    const onReload = vi.fn()
    const instance = new AppErrorBoundary({ children: null, onReload })
    instance.state = AppErrorBoundary.getDerivedStateFromError()
    const element = instance.render() as { props: { children: { props: { action: { onClick(): void } } } } }
    element.props.children.props.action.onClick()
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('タブ切替による復旧のため、App は boundary を key={activeTab} で再マウントする', () => {
    const source = fs.readFileSync('src/App.tsx', 'utf-8')
    expect(source).toContain('<AppErrorBoundary key={activeTab}>')
  })
})

describe('F-P0-4: fallback は stack / debug 情報を通常UIへ露出しない', () => {
  it('error.stack を含まない', () => {
    expect(renderFallback()).not.toContain('T0_Home.tsx:785')
    expect(renderFallback()).not.toContain('    at ')
  })

  it('error.message を含まない', () => {
    expect(renderFallback()).not.toContain('nikkeiVI is undefined')
  })

  it('componentStack を含まない', () => {
    expect(renderFallback()).not.toContain('componentStack')
  })
})

describe('F-P0-4: componentDidCatch は console.error にのみ debug 情報を出す', () => {
  it('console.error が error と componentStack 付きで呼ばれる', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const instance = new AppErrorBoundary({ children: null })
      const info: ErrorInfo = { componentStack: '\n    in T0_Home' }
      instance.componentDidCatch(boom(), info)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[AppErrorBoundary]')
      expect(spy.mock.calls[0][2]).toBe('\n    in T0_Home')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('F-P0-4: boundary は portfolio / localStorage / domain state を書き換えない', () => {
  const calls: string[] = []
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

  beforeEach(() => {
    calls.length = 0
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem:    (k: string) => { calls.push(`getItem:${k}`); return null },
        setItem:    (k: string) => { calls.push(`setItem:${k}`) },
        removeItem: (k: string) => { calls.push(`removeItem:${k}`) },
        clear:      () => { calls.push('clear') },
        key:        () => null,
        length:     0,
      },
    })
  })

  afterEach(() => {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('catch → fallback render の全過程で localStorage への書き込み / clear が 0 件', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const instance = new AppErrorBoundary({ children: <p>X</p> })
      instance.componentDidCatch(boom(), { componentStack: '\n    in T0_Home' })
      instance.state = AppErrorBoundary.getDerivedStateFromError()
      renderToStaticMarkup(<>{instance.render()}</>)
    } finally {
      spy.mockRestore()
    }
    expect(calls.filter(c => c.startsWith('setItem') || c.startsWith('removeItem') || c === 'clear')).toEqual([])
  })

  it('localStorage には一切アクセスしない（read も含めて 0 件）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const instance = new AppErrorBoundary({ children: <p>X</p> })
      instance.componentDidCatch(boom(), { componentStack: '' })
      instance.state = AppErrorBoundary.getDerivedStateFromError()
      renderToStaticMarkup(<>{instance.render()}</>)
    } finally {
      spy.mockRestore()
    }
    expect(calls).toEqual([])
  })

  it('AppErrorBoundary は store を import しない（domain state を触れない構造）', () => {
    const source = fs.readFileSync('src/components/shared/AppErrorBoundary.tsx', 'utf-8')
    expect(source).not.toContain('useAppStore')
    // コメント中の言及ではなく、実際の API アクセスが無いことを見る
    expect(source).not.toMatch(/localStorage\s*[.[]/)
    expect(source).not.toMatch(/\bsessionStorage\b\s*[.[]/)
  })
})
