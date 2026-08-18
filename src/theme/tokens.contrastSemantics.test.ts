import { describe, expect, it } from 'vitest'
import { colors, v13Colors, generateCssVars } from './tokens'

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

  it('textSubtle / textMuted は白背景・bgBaseともAA 4.5:1以上（UI-9B修正）', () => {
    const bgSurface  = colors.bgSurface   // #ffffff
    const bgBase     = colors.bgBase      // #eef1f6（実運用でtextMuted/textSubtleが乗る主要背景）
    for (const [name, hex] of [['textSubtle', colors.textSubtle], ['textMuted', colors.textMuted]] as const) {
      const cSurface = contrast(hex, bgSurface)
      expect(cSurface, `${name} on bgSurface = ${cSurface.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
      const cBase = contrast(hex, bgBase)
      expect(cBase, `${name} on bgBase = ${cBase.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
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
