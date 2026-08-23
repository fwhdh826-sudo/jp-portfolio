import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { dirname, resolve } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(HERE, 'v10.css'), 'utf8')
const statusBar = readFileSync(resolve(HERE, '../components/StatusBar.tsx'), 'utf8')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rule(selector: string): string {
  const match = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule must exist`).not.toBeNull()
  return match![1]
}

function declaredMinHeight(selector: string): number | null {
  const match = rule(selector).match(/min-height:\s*(\d+)px/)
  return match ? Number(match[1]) : null
}

describe('UI-9G G-6: scoped 44px touch targets', () => {
  it('A critical navigation/actions keep a 44px minimum without changing their visual padding', () => {
    for (const selector of ['.home-nav-cta__btn', '.stock-selector__item']) {
      expect(declaredMinHeight(selector)).toBe(44)
    }
    expect(rule('.home-nav-cta__btn')).toMatch(/padding:\s*7px 14px/)
    expect(rule('.stock-selector__item')).toMatch(/padding:\s*6px 12px/)

    const refresh = statusBar.slice(statusBar.indexOf('{/* 更新 */}'), statusBar.indexOf('{refreshFeedback &&'))
    expect(refresh).toContain("minWidth: '44px'")
    expect(refresh).toContain("minHeight: '44px'")
    expect(refresh).toContain("padding: '3px 10px'")
    expect(refresh).toContain('onClick={handleRefresh}')
    expect(refresh).toContain('disabled={refreshDisabled}')
    expect(refresh).toContain('aria-busy={refreshButton.ariaBusy}')
  })

  it('B secondary controls get only the scoped minimum hit height', () => {
    for (const selector of ['.news-cat-tabs__item', '.refresh-btn']) {
      expect(declaredMinHeight(selector)).toBe(44)
    }
    expect(rule('.news-cat-tabs__item')).toMatch(/padding:\s*6px 14px/)
    expect(rule('.refresh-btn')).toMatch(/padding:\s*10px 20px/)

    const cashInputs = css.match(
      /\[data-testid="cash-authority-gross-input"\],\s*\[data-testid="cash-authority-safety-reserve-input"\],\s*\[data-testid="cash-authority-pending-order-input"\]\s*\{([^}]*)\}/,
    )
    expect(cashInputs).not.toBeNull()
    expect(cashInputs![1]).toMatch(/min-height:\s*44px/)

    const warning = statusBar.slice(
      statusBar.indexOf('export function CrossTabInvalidationWarning'),
      statusBar.indexOf('export function StatusBar'),
    )
    expect(warning).toContain("minHeight: '44px'")
    expect(warning).toContain('onClick={onReload}')
    expect(warning).toContain('disabled={viewModel.reloadDisabled}')
  })

  it('C/非対象は拡大しない: hidden file inputとplan未列挙controlを維持する', () => {
    const hiddenInput = rule('.csv-drop-area__input')
    expect(hiddenInput).toMatch(/display:\s*none/)
    expect(hiddenInput).not.toMatch(/min-(?:width|height)/)
    expect(css).not.toContain('.status-shell__refresh')
  })

  it('旧sizeへのmutationはRED: min-height削除時は監査実寸が44px未満へ戻る', () => {
    const auditedIntrinsicHeights = new Map([
      ['.home-nav-cta__btn', 36],
      ['.stock-selector__item', 32],
      ['.news-cat-tabs__item', 32],
      ['.refresh-btn', 40],
    ])
    for (const [selector, intrinsicHeight] of auditedIntrinsicHeights) {
      const minimum = declaredMinHeight(selector)
      expect(Math.max(intrinsicHeight, minimum ?? 0), selector).toBeGreaterThanOrEqual(44)
      expect(Math.max(intrinsicHeight, 0), `${selector} old-size mutation`).toBeLessThan(44)
    }
  })
})
