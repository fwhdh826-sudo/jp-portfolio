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
const t9Settings = readFileSync(resolve(HERE, '../components/tabs/T9_Settings.tsx'), 'utf8')

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

function declaredMinWidth(selector: string): number | null {
  const match = rule(selector).match(/min-width:\s*(\d+)px/)
  return match ? Number(match[1]) : null
}

// T9_Settings.tsx の inline style button群は className を持たないため、
// marker（一意なJSXテキスト）直前の最寄り `style={{...}}` ブロックを厳密に抽出して検証する。
function precedingStyleBlock(source: string, marker: string): string {
  const idx = source.indexOf(marker)
  expect(idx, `${marker} must exist in T9_Settings.tsx`).toBeGreaterThan(-1)
  const before = source.slice(0, idx)
  const styleStart = before.lastIndexOf('style={{')
  expect(styleStart, `style block preceding ${marker} must exist`).toBeGreaterThan(-1)
  const closeIdx = source.indexOf('}}', styleStart)
  return source.slice(styleStart, closeIdx + 2)
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

  it('UI-9G P1-4 closure: status-shell refresh / sidebar toggle / T9 buttons meet 44px without changing semantics', () => {
    // .status-shell__refresh（T5_News.tsx の Market Command Center 更新ボタン、実測26x21だった）
    expect(declaredMinWidth('.status-shell__refresh')).toBe(44)
    expect(declaredMinHeight('.status-shell__refresh')).toBe(44)

    const t5News = readFileSync(resolve(HERE, '../components/tabs/T5_News.tsx'), 'utf8')
    const t5Refresh = t5News.slice(
      t5News.indexOf('className={`status-shell__refresh'),
      t5News.indexOf('{refreshButton.label}'),
    )
    expect(t5Refresh).toContain('onClick={handleRefresh}')
    expect(t5Refresh).toContain('disabled={refreshButton.disabled}')
    expect(t5Refresh).toContain('aria-busy={refreshButton.ariaBusy}')
    expect(t5Refresh).toContain("fontSize: '11px'")

    // .app-sidebar__toggle（desktop実測203x23だった、@media (min-width:1024px)内）
    expect(declaredMinHeight('.app-sidebar__toggle')).toBe(44)

    // T9の34.1px高button 8件（比率ボタン×4は単一style blockの反復適用、export/import×4は個別）
    expect(precedingStyleBlock(t9Settings, '{opt.label}')).toMatch(/minHeight:\s*'44px'/)
    expect(precedingStyleBlock(t9Settings, 'この端末の現金権限をエクスポート')).toContain("minHeight: '44px'")
    expect(precedingStyleBlock(t9Settings, "pendingOperation === 'importCashAssumptions'")).toContain("minHeight: '44px'")
    expect(precedingStyleBlock(t9Settings, 'この端末の保有株・投信・現金前提をエクスポート')).toContain("minHeight: '44px'")
    expect(precedingStyleBlock(t9Settings, "pendingOperation === 'importPortfolioSnapshot'")).toContain("minHeight: '44px'")
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
    // UI-9G P1-4 closure（ui-9g-p1-closure-audit.md §3-5）: .status-shell__refresh は
    // T5_News.tsx の実DOMに存在し可視・interactive・hit-test済みの真の44x44未達要素と判明したため、
    // 「非対象として拡大しない」契約から除外し、44px contract 側（上記テスト）へ移した。
  })

  it('旧sizeへのmutationはRED: min-height削除時は監査実寸が44px未満へ戻る', () => {
    const auditedIntrinsicHeights = new Map([
      ['.home-nav-cta__btn', 36],
      ['.stock-selector__item', 32],
      ['.news-cat-tabs__item', 32],
      ['.refresh-btn', 40],
      ['.status-shell__refresh', 21],
      ['.app-sidebar__toggle', 23],
    ])
    for (const [selector, intrinsicHeight] of auditedIntrinsicHeights) {
      const minimum = declaredMinHeight(selector)
      expect(Math.max(intrinsicHeight, minimum ?? 0), selector).toBeGreaterThanOrEqual(44)
      expect(Math.max(intrinsicHeight, 0), `${selector} old-size mutation`).toBeLessThan(44)
    }

    const auditedT9IntrinsicHeight = 34.1
    const t9Markers = [
      '{opt.label}',
      'この端末の現金権限をエクスポート',
      "pendingOperation === 'importCashAssumptions'",
      'この端末の保有株・投信・現金前提をエクスポート',
      "pendingOperation === 'importPortfolioSnapshot'",
    ]
    for (const marker of t9Markers) {
      const block = precedingStyleBlock(t9Settings, marker)
      const hasMinHeight44 = /minHeight:\s*'44px'/.test(block)
      expect(Math.max(auditedT9IntrinsicHeight, hasMinHeight44 ? 44 : 0), marker).toBeGreaterThanOrEqual(44)
      expect(auditedT9IntrinsicHeight, `${marker} old-size mutation`).toBeLessThan(44)
    }
  })
})
