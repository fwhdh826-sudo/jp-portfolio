// UI-9I Phase 1: アクセシビリティ / 凍結レイアウトの CSS 契約（vitest は CSS を transform しないため生ファイルを読む）。
import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { generateCssVars, ui9iTokens } from '../theme/tokens'

const dir = dirname(fileURLToPath(import.meta.url))
const css: string = readFileSync(resolve(dir, 'ui9i.css'), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  if (!m) throw new Error(`rule not found: ${selector}`)
  return m[1]
}

describe('タッチターゲット 44px', () => {
  for (const selector of ['.u9-dock__item', '.u9-hero__cta', '.u9-link', '.u9-hub-item', '.u9-surface__back']) {
    it(`${selector} は min-height: 44px 以上`, () => {
      const body = rule(selector)
      const h = /min-height:\s*(\d+)px/.exec(body)
      expect(h, `${selector} に min-height が無い`).not.toBeNull()
      expect(Number(h![1])).toBeGreaterThanOrEqual(44)
    })
  }
  it('デスクトップのサイドバー項目も 44px 以上（media 内）', () => {
    const m = /\.u9-sidebar__item\s*\{[^}]*min-height:\s*(\d+)px/.exec(css)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(44)
  })
})

describe('フォーカス / モーション / 縦折り返し', () => {
  it('キーボードフォーカスが視認できる（:focus-visible の outline）', () => {
    expect(css).toMatch(/\.u9 a:focus-visible[\s\S]*?outline:\s*2px solid var\(--u9-accent\)/)
    expect(css).toMatch(/\.u9 button:focus-visible/)
  })

  it('prefers-reduced-motion で transition / animation を無効化', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none !important[\s\S]*?animation:\s*none !important/)
  })

  it('チップ・ピル・ナビ・凡例ラベルは日本語を縦に折り返さない（nowrap + keep-all）', () => {
    for (const selector of ['.u9-pill', '.u9-chip__value', '.u9-chip__label', '.u9-dock__item', '.u9-legend__label', '.u9-gap__label', '.u9-cand-row__state']) {
      const body = rule(selector)
      expect(body, selector).toMatch(/white-space:\s*nowrap/)
      expect(body, selector).toMatch(/word-break:\s*keep-all/)
    }
  })

  it('横スクロールを作らない: 主要コンテナは min-width: 0 を持つ', () => {
    for (const selector of ['.u9-card', '.u9-chip', '.u9-hero__body', '.u9-cand-row__main']) {
      expect(rule(selector), selector).toMatch(/min-width:\s*0/)
    }
  })
})

describe('Hero 画像スロット仕様（凍結）', () => {
  it('aspect-ratio / object-fit: cover / focal point / 左テキスト右画像', () => {
    const slot = rule('.u9-hero-image')
    expect(slot).toMatch(/aspect-ratio:\s*118 \/ 132/)
    expect(slot).toMatch(/overflow:\s*hidden/)
    expect(rule('.u9-hero-image__img')).toMatch(/object-fit:\s*cover/)
    expect(rule('.u9-hero-image__img')).toMatch(/object-position:\s*60% 40%/)
    // テキスト側は画像より前面（z-index）でテキストセーフエリアを確保
    expect(rule('.u9-hero__body')).toMatch(/z-index:\s*2/)
  })
  it('デスクトップは 190:170 に切り替わる', () => {
    expect(css).toMatch(/\.u9-hero-image, \.u9-hero-image\[data-tone\]\s*\{\s*width:\s*190px;\s*aspect-ratio:\s*190 \/ 170/)
  })
})

describe('レイアウトの安定性: 状態で節を動的に並べ替えない', () => {
  it('CSS に order: プロパティを使わない（DOM 順 = 状態によらず固定）', () => {
    expect(css).not.toMatch(/(^|[;{\s])order\s*:/m)
  })
  it('SAFE_MODE / DATA_WAIT は地色のみ変える（赤いエラー地色は critical 限定）', () => {
    expect(css).toMatch(/\.u9-page\[data-tone="warm"\]/)
    expect(css).toMatch(/\.u9-page\[data-tone="neutral"\]/)
  })
})

describe('R4.1 トークンは theme に一本化（--u9-*）', () => {
  it('ui9i.css が使う var(--u9-*) は generateCssVars() に存在する', () => {
    const used = new Set([...css.matchAll(/var\((--u9-[a-z0-9-]+)/g)].map(m => m[1]))
    const defined = new Set(Object.keys(generateCssVars()))
    expect([...used].filter(n => !defined.has(n))).toEqual([])
    expect(used.size).toBeGreaterThan(5)
  })
  it('凍結パレット（淡いブルー / グリーン / ブルーのアクセント）の代表値', () => {
    expect(ui9iTokens.accent).toBe('#2F6FBF')
    expect(ui9iTokens.green).toBe('#2F6E4B')
    expect(ui9iTokens.ink).toBe('#17222E')
    expect(generateCssVars()['--u9-accent']).toBe('#2F6FBF')
  })
})

describe('Phase 2A: PF 面 / ハブの CSS 契約', () => {
  it('ハブ行の値・総資産の単位は日本語を縦に折り返さない', () => {
    for (const selector of ['.u9-hub-item__value', '.u9-pf-total__unit']) {
      const body = rule(selector)
      expect(body, selector).toMatch(/white-space:\s*nowrap/)
      expect(body, selector).toMatch(/word-break:\s*keep-all/)
    }
  })

  it('デスクトップ PF は 220px + 可変の 2 カラム（凍結 D4）で、grid-area による配置（order 不使用）', () => {
    expect(css).toMatch(/\.u9-pf-layout \{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)/)
    expect(css).toMatch(/grid-template-areas:\s*"total gaps" "comp gaps" "cash gaps"/)
    expect(css).toMatch(/\.u9-pf-gaps \{ grid-area: gaps/)
  })

  it('穴の表示はモバイル=総資産 / デスクトップ=構成 で切り替わる', () => {
    expect(css).toMatch(/\.u9-donut__hole-d \{ display: none; \}/)
    expect(css).toMatch(/\.u9-donut__hole-m \{ display: none; \}\s*\n\s*\.u9-donut__hole-d \{ display: flex; \}/)
  })

  it('デスクトップで「‹」を隠す（フォーカス順に残さない）/ モバイルでは 44px 以上', () => {
    expect(css).toMatch(/\.u9-surface--top \.u9-surface__back \{ display: none; \}/)
    expect(Number(/min-height:\s*(\d+)px/.exec(rule('.u9-surface__back'))![1])).toBeGreaterThanOrEqual(44)
  })

  it('視覚的に隠した見出しは sr-only 方式（display:none にしない）', () => {
    expect(css).toMatch(/\.u9-pf-comp > \.u9-card__head, \.u9-pf-cash > \.u9-card__head \{\s*position: absolute; width: 1px; height: 1px; overflow: hidden; clip:/)
  })

  it('Home の .u9-pf-top は変更しない（PF 面の上書きは .u9-pf-comp 配下に限定）', () => {
    const bare = [...css.matchAll(/(^|\n)\s*\.u9-pf-top\s*\{([^}]*)\}/g)]
    expect(bare).toHaveLength(1)
    expect(bare[0][2]).toMatch(/gap:\s*16px/)
  })

  it('ハブのアイコンチップ配色は 4 種（意味を持たない視覚識別）', () => {
    for (const tone of ['green', 'violet', 'slate']) expect(css).toContain(`.u9-hub-item__glyph[data-tone="${tone}"]`)
  })
})


describe('Phase 2B-1: 個別株面の CSS 契約', () => {
  it('操作対象は 44px 以上（行 / 戻る / 開閉 summary）', () => {
    for (const selector of ['.u9-stk-row', '.u9-stk-back', '.u9-disclose__summary']) {
      const body = rule(selector)
      const h = /min-height:\s*(\d+)px/.exec(body)
      expect(h, selector).not.toBeNull()
      expect(Number(h![1]), selector).toBeGreaterThanOrEqual(44)
    }
    expect(Number(/min-width:\s*(\d+)px/.exec(rule('.u9-stk-back'))![1])).toBeGreaterThanOrEqual(44)
  })

  it('summary にも視認可能な :focus-visible を与える（キーボード操作）', () => {
    expect(css).toMatch(/\.u9 summary:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--u9-accent\)/)
  })

  it('短い日本語ラベル（状態語 / タグ / 戻る）は縦に折り返さない（nowrap + keep-all）', () => {
    for (const selector of ['.u9-stk-state', '.u9-stk-tag', '.u9-stk-back']) {
      const body = rule(selector)
      expect(body, selector).toMatch(/white-space:\s*nowrap/)
      expect(body, selector).toMatch(/word-break:\s*keep-all/)
    }
  })

  it('比較表は名前付きスクロール領域（overflow-x:auto）で、セルは折り返さない', () => {
    expect(rule('.u9-table-scroll')).toMatch(/overflow-x:\s*auto/)
    expect(css).toMatch(/\.u9-table th, \.u9-table td\s*\{[^}]*white-space:\s*nowrap/)
  })

  it('デスクトップの本文幅は 880px までに抑える（横に伸びすぎない）。モバイルの余白は既存面と同じ 16px', () => {
    expect(css).toMatch(/\.u9-surface\.u9-surface--top\.u9-stk \.u9-surface__body\s*\{[^}]*max-width:\s*880px/)
    expect(rule('.u9-stk-notice')).toMatch(/margin:\s*14px 16px 0/)
  })

  it('reduced-motion は .u9 配下すべての transition / animation を無効化する（開閉 chevron を含む）', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce[^}]*\{[^}]*\.u9 \*/)
  })
})
