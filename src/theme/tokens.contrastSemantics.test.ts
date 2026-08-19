import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { colors, v13Colors, generateCssVars } from './tokens'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// UI-9B: contrast / color semantics 専用回帰テスト。
// UI-9Aの token-missing 修正（tokens.themeRuntime.test.ts）とは対象が異なる：
// ここでは「resolveはするが読みにくい」contrastの実値と、
// BUY/HOLD/WATCH/SELL等の投資semantic mappingが崩れていないことをpinする。

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function srgbToLinear(c: number): number {
  const cs = c / 255
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

// WCAG 2.x contrast ratio。fg/bgはどちらも6桁hex（#付き）。
function contrast(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToRgb(fg))
  const l2 = relativeLuminance(hexToRgb(bg))
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

const AA_NORMAL = 4.5

describe('UI-9B: contrast / color semantics regression', () => {
  it('token resolved: generateCssVars() は全キーが空文字列でない', () => {
    const vars = generateCssVars()
    const empty = Object.entries(vars).filter(([, v]) => !v || v.trim() === '')
    expect(empty, `empty CSS variables: ${empty.map(([k]) => k).join(', ')}`).toEqual([])
  })

  it('undefined CSS var 0 を維持する（UI-9Aと同じキー数113を維持）', () => {
    expect(Object.keys(generateCssVars())).toHaveLength(113)
  })

  it('textSubtle / textMuted は白背景・bgBase・bgElevatedともAA 4.5:1以上（UI-9B/UI-9B-R1修正）', () => {
    const bgSurface  = colors.bgSurface   // #ffffff
    const bgBase     = colors.bgBase      // #eef1f6
    const bgElevated = colors.bgElevated  // #e8edf4（UI-9B時点でAA未達だった実運用背景。R1で解消）
    for (const [name, hex] of [['textSubtle', colors.textSubtle], ['textMuted', colors.textMuted]] as const) {
      const cSurface = contrast(hex, bgSurface)
      expect(cSurface, `${name} on bgSurface = ${cSurface.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
      const cBase = contrast(hex, bgBase)
      expect(cBase, `${name} on bgBase = ${cBase.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
      const cElevated = contrast(hex, bgElevated)
      expect(cElevated, `${name} on bgElevated = ${cElevated.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('BUY/HOLD/WAIT/SELL raw accentは白背景でAA 4.5:1に近似（テキスト用途での可読性）', () => {
    // sellのみ元々AA達成済みのため無変更。buy/hold/waitはUI-9Bで最小限darkenした。
    const cases: Array<[string, string]> = [
      ['buy',  colors.buy],
      ['hold', colors.hold],
      ['wait', colors.wait],
      ['sell', colors.sell],
    ]
    for (const [name, hex] of cases) {
      const c = contrast(hex, colors.bgSurface)
      expect(c, `${name} (${hex}) on white = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('status *Text variant（buyText/holdText/waitText/sellText）はUI-9Bで変更していない', () => {
    expect(colors.buyText).toBe('#0a6e56')
    expect(colors.holdText).toBe('#4a5a70')
    expect(colors.waitText).toBe('#b45309')
    expect(colors.sellText).toBe('#b91c1c')
    // *Text variantは元からAA達成済み（回帰防止のためcontrastも pin）
    expect(contrast(colors.buyText,  colors.buyBg)).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(colors.holdText, colors.holdBg)).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(colors.waitText, colors.waitBg)).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrast(colors.sellText, colors.sellBg)).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('BUY/HOLD/WATCH/SELLのmappingは不変：wait===watch、bull===buy、bear===sell、neutral===neutral2===hold', () => {
    // 表示専用のtoken同期チェック。investment判定ロジックそのものはこのファイルの対象外。
    expect(colors.watch).toBe(colors.wait)
    expect(colors.watchText).toBe(colors.waitText)
    expect(colors.watchBg).toBe(colors.waitBg)
    expect(colors.bull).toBe(colors.buy)
    expect(colors.bear).toBe(colors.sell)
    expect(colors.neutral).toBe(colors.hold)
    expect(colors.neutral2).toBe(colors.hold)
    expect(v13Colors.success).toBe(colors.buy)
    expect(v13Colors.warning).toBe(colors.wait)
    expect(v13Colors.danger).toBe(colors.sell)
    expect(v13Colors.neutral).toBe(colors.hold)
  })

  it('BUY/HOLD/WAIT/SELLは互いに異なる色相を維持する（色だけの意味崩壊がないことの最低限保証）', () => {
    // 4色が pairwise で完全一致していないことだけを保証する下限チェック。
    const set = new Set([colors.buy, colors.hold, colors.wait, colors.sell])
    expect(set.size).toBe(4)
  })

  it('verdict-box__label相当（不透明白）は buy/hold/sell 背景上でAA 4.5:1以上', () => {
    for (const bg of [colors.buy, colors.hold, colors.sell]) {
      const c = contrast('#ffffff', bg)
      expect(c, `#ffffff on ${bg} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('risk-level-badge--high相当のliteral(#bd3f0c)はpale-orange合成背景上でAA 4.5:1以上', () => {
    // rgba(234,88,12,0.15) を #ffffff に合成した背景（v10.css .risk-level-badge--high と同じ式）
    const alpha = 0.15
    const src: [number, number, number] = [234, 88, 12]
    const blended: [number, number, number] = [
      src[0] * alpha + 255 * (1 - alpha),
      src[1] * alpha + 255 * (1 - alpha),
      src[2] * alpha + 255 * (1 - alpha),
    ]
    const blendedHex = '#' + blended.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
    const c = contrast('#bd3f0c', blendedHex)
    expect(c, `#bd3f0c on ${blendedHex} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})

// UI-9B-R1: production smoke（135 occurrence / 12 group、bgElevated #e8edf4）で残存が確認された
// residual contrast/hierarchy debtの限定修正に対する回帰テスト。
describe('UI-9B-R1: residual contrast / hierarchy hardening', () => {
  const V10_CSS_PATH = resolve(SRC_ROOT, 'styles/v10.css')
  const v10Css = readFileSync(V10_CSS_PATH, 'utf8')

  // selectorLiteral の直後の最初の `{...}` ブロックから `var(--xxx` を1つ抽出する。
  // 「hexを再掲するだけ」ではなく実際に出荷されるCSSファイルを読み、そこで参照されている
  // CSS変数名を抽出したうえで generateCssVars() の実解決値と突き合わせて contrast を計算する
  // ＝ ソース文字列の単純比較ではなく、実際の変数解決結果に対するbehaviorレベルのpinとなる。
  function extractColorVarName(css: string, selectorLiteral: string): string {
    const idx = css.indexOf(selectorLiteral)
    expect(idx, `selector not found in v10.css: ${selectorLiteral}`).toBeGreaterThan(-1)
    const block = css.slice(idx, css.indexOf('}', idx) + 1)
    const m = block.match(/color:\s*var\((--[a-zA-Z0-9-]+)/)
    expect(m, `no var(--...) color found for ${selectorLiteral}: ${block}`).not.toBeNull()
    return m![1]
  }

  it('.metric-item__value.up/.down は raw --color-buy/--color-sell でなく -text variantを参照する（bgElevated AA回帰pin）', () => {
    const vars = generateCssVars()
    const upVar   = extractColorVarName(v10Css, '.metric-item__value.up')
    const downVar = extractColorVarName(v10Css, '.metric-item__value.down')
    expect(upVar).toBe('--color-buy-text')
    expect(downVar).toBe('--color-sell-text')

    const bgElevated = colors.bgElevated
    const cUp   = contrast(vars[upVar],   bgElevated)
    const cDown = contrast(vars[downVar], bgElevated)
    expect(cUp,   `${upVar}=${vars[upVar]} on bgElevated = ${cUp.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(cDown, `${downVar}=${vars[downVar]} on bgElevated = ${cDown.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('.asset-snapshot-bar__pnl.up/.down と .t4-diff-cell--buy/--sell も同様に -text variantを参照する', () => {
    const pairs: Array<[string, string]> = [
      ['.asset-snapshot-bar__pnl.up', '--color-buy-text'],
      ['.asset-snapshot-bar__pnl.down', '--color-sell-text'],
      ['.t4-diff-cell--buy .t4-diff-cell__value', '--color-buy-text'],
      ['.t4-diff-cell--sell .t4-diff-cell__value', '--color-sell-text'],
    ]
    for (const [selector, expected] of pairs) {
      const varName = extractColorVarName(v10Css, selector)
      expect(varName, selector).toBe(expected)
    }
  })

  it('v10.css内に raw status token（buy/hold/wait/sell）を直接 color: に使う箇所が残っていない（既知の意図的border-color使用は除外）', () => {
    // border-left-color等の装飾用途はWCAGテキストcontrast対象外のため意図的に対象から除外する。
    const matches = [...v10Css.matchAll(/(?<![a-zA-Z-])color:\s*var\(--color-(buy|hold|wait|sell)\s*[,)]/g)]
    const offenders = matches.map(m => m[0])
    expect(offenders, `raw token used as text color: ${offenders.join(', ')}`).toEqual([])
  })

  it('subtle/mutedはbgElevated上でも明確に区別できる（hierarchy崩壊の回帰検知）', () => {
    const bgElevated = colors.bgElevated
    const cSubtle = contrast(colors.textSubtle, bgElevated)
    const cMuted  = contrast(colors.textMuted, bgElevated)
    // UI-9Bでは両者ともに4.3台まで縮退し視覚差がほぼ消失していた（F-2）。
    // subtle（補助＝muted一段階上）はmutedより明確に高いcontrastを維持することをpinする。
    expect(cSubtle, `subtle=${cSubtle.toFixed(2)} muted=${cMuted.toFixed(2)}`).toBeGreaterThan(cMuted + 0.5)
    // 両者ともAA未達へ戻っていないこと
    expect(cMuted).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(cSubtle).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('text hierarchy順序（primary > second > subtle > muted）はbgBase上で維持される', () => {
    const bg = colors.bgBase
    const cPrimary = contrast(colors.textPrimary, bg)
    const cSecond  = contrast(colors.textSecond, bg)
    const cSubtle  = contrast(colors.textSubtle, bg)
    const cMuted   = contrast(colors.textMuted, bg)
    expect(cPrimary).toBeGreaterThan(cSecond)
    expect(cSecond).toBeGreaterThan(cSubtle)
    expect(cSubtle).toBeGreaterThan(cMuted)
  })

  it('opacityによるAA回避ではなく不透明色のみでtextSubtle/textMutedを構成している', () => {
    // rgba/hsla等のalpha付き記法を使っていないことを確認（opacityでAAを再悪化させない要件）
    expect(colors.textSubtle).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(colors.textMuted).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it('StatusBar通常SQ表示（textOnNavy on bgNavyLight）は約12.95:1を維持する', () => {
    const c = contrast(colors.textOnNavy, colors.bgNavyLight)
    expect(c, `textOnNavy on bgNavyLight = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(12.5)
    expect(c).toBeLessThanOrEqual(13.5)
    // 旧バグ（1.06:1）へ戻っていないことの明示的下限
    expect(c).toBeGreaterThan(10)
  })

  it('T5_News.tsx の importance threshold 0.75/0.45 は不変（presentationのみのUI-9B/R1で崩さない）', () => {
    const t5Src = readFileSync(resolve(SRC_ROOT, 'components/tabs/T5_News.tsx'), 'utf8')
    const startIdx = t5Src.indexOf('function getImportanceLabel(imp: number)')
    expect(startIdx, 'getImportanceLabel not found').toBeGreaterThan(-1)
    const fnBody = t5Src.slice(startIdx, startIdx + 220)
    expect(fnBody).toMatch(/imp >= 0\.75/)
    expect(fnBody).toMatch(/imp >= 0\.45/)
  })

  it('.metric-item__label / .metric-item__sub は textMuted/textSubtleをそれぞれ参照する（token割当の回帰pin）', () => {
    const labelVar = extractColorVarName(v10Css, '.metric-item__label')
    const subVar   = extractColorVarName(v10Css, '.metric-item__sub')
    expect(labelVar).toBe('--color-text-muted')
    expect(subVar).toBe('--color-text-subtle')
  })
})
