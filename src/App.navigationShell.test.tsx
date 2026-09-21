import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'

// vitest disables CSS transforms by default (test.css=false), so `?raw` imports of
// .css resolve to an empty string — read the stylesheet directly from disk instead.
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const v10Css: string = readFileSync(resolve(SRC_ROOT, 'styles/v10.css'), 'utf8')
const ui9iCss: string = readFileSync(resolve(SRC_ROOT, 'styles/ui9i.css'), 'utf8')
const appSource: string = readFileSync(resolve(SRC_ROOT, 'App.tsx'), 'utf8')

// UI-9I Phase 2B-2: 旧 DesktopSidebarNav / TabNav / BottomDockNav は撤去済み。
// ここには App シェルの P0-1 スクロール契約（window が scroll owner）と、主ナビが 1 系統であることを残す。
describe('App shell — P0-1 スクロール契約（E）', () => {
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

  it('E: 左ナビ(.u9-sidebar, desktop)はsticky + align-self:flex-startで、独自のoverflow-yを持たない', () => {
    const block = ui9iCss.match(/\.u9-sidebar\s*\{[^}]*position:\s*sticky[^}]*\}/)
    expect(block).toBeTruthy()
    expect(block![0]).not.toContain('overflow-y')
  })
})

describe('主ナビは 1 系統（UI-9I Phase 2B-2: F-06）', () => {
  it('App は UserSidebarNav / UserDockNav だけを主ナビとして描画し、旧 3 ナビを持たない', () => {
    expect(appSource).toContain('<UserSidebarNav />')
    expect(appSource).toContain('<UserDockNav />')
    for (const legacy of ['DesktopSidebarNav', 'BottomDockNav', 'TabNav', 'SIDEBAR_SECTIONS']) {
      expect(appSource, legacy).not.toContain(legacy)
    }
  })

  it('旧ナビ専用の CSS クラス(.tab-nav / .bottom-dock / .app-sidebar)は残っていない', () => {
    for (const cls of ['.tab-nav', '.bottom-dock', '.app-sidebar']) {
      expect(v10Css, cls).not.toContain(cls)
      expect(ui9iCss, cls).not.toContain(cls)
    }
  })
})
