import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { colors, generateCssVars } from './tokens'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// UI-9B-R2: application-wide contrast hardening 専用回帰テスト。
// UI-9B/R1（tokens.contrastSemantics.test.ts）はtokens.ts/v10.cssのtoken定義を対象にしたが、
// R2はTSXコンポーネント側の実inline usage（opacity減光・raw token誤流用・class衝突）を対象にする。
// 「sourceにその文字列がある」だけでなく、実際に参照しているtoken/hexを解決してcontrastを
// 計算する（tokens.contrastSemantics.test.tsのextractColorVarNameパターンを踏襲）。

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
function contrast(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToRgb(fg))
  const l2 = relativeLuminance(hexToRgb(bg))
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}
function blendHex(fg: string, bg: string, alpha: number): string {
  const [fr, fgc, fb] = hexToRgb(fg)
  const [br, bg2, bb] = hexToRgb(bg)
  const blend = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha))
  return '#' + [blend(fr, br), blend(fgc, bg2), blend(fb, bb)].map(v => v.toString(16).padStart(2, '0')).join('')
}

const AA_NORMAL = 4.5

function readSrc(relPath: string): string {
  return readFileSync(resolve(SRC_ROOT, relPath), 'utf8')
}

describe('UI-9B-R2: TSX inline opacity減光の回帰防止（disabled以外の通常textにopacity<1を再導入しない）', () => {
  // opacityでtextを薄くしてAAを割る手法を再導入していないことを、
  // 「該当箇所を含むファイルに数値opacity宣言が存在しない」という形で構造的にpinする。
  // （disabled状態のopacityはGroup Bとして許容領域が別にあるため、これらのファイルはそもそも
  //   disabled分岐を持たない・または当該spanがdisabled分岐の外にあるものだけを対象にする）

  it('SourceStatusRow.tsx: STATUS_LABEL span はopacityで減光されていない', () => {
    const src = readSrc('components/v13/SourceStatusRow.tsx')
    expect(src).not.toMatch(/opacity:\s*0\.\d/)
    // 実際に依存する土台（.source-status-item の color: var(--color-text-secondary)）が
    // 白背景でAAを満たすことも合わせてpinする（土台自体が退行したら意味がないため）
    const c = contrast(colors.textSecond, colors.bgSurface)
    expect(c, `textSecond on bgSurface = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('MacroSignalBadge.tsx: STRENGTH_LABEL span はopacityで減光されていない', () => {
    const src = readSrc('components/v13/MacroSignalBadge.tsx')
    expect(src).not.toMatch(/opacity:\s*0\.\d/)
  })

  it('Phase8SummaryCard.tsx: 「※ 実行判断ではありません」注記はopacityで減光されていない', () => {
    const src = readSrc('components/phase8/Phase8SummaryCard.tsx')
    const idx = src.indexOf('実行判断ではありません')
    expect(idx, 'annotation text not found').toBeGreaterThan(-1)
    const surrounding = src.slice(Math.max(0, idx - 200), idx)
    expect(surrounding).not.toMatch(/opacity:\s*0\.\d/)
  })
})

describe('UI-9B-R2: raw accent tokenのtext流用回帰防止（ダークパネル・チップ・ボタン）', () => {
  it('T5_News.tsx: Market Command Center の RSI/MACD/BOJ 行は on-navy 系tokenを参照する（light-theme literalへの回帰防止）', () => {
    const src = readSrc('components/tabs/T5_News.tsx')
    const idx = src.indexOf('RSI {market.rsi14')
    expect(idx, 'RSI line not found').toBeGreaterThan(-1)
    const block = src.slice(Math.max(0, idx - 200), idx)
    const m = block.match(/color:\s*'([^']+)'/)
    expect(m, `no color found near RSI line: ${block}`).not.toBeNull()
    expect(m![1]).toBe('var(--color-text-on-navy-sub)')
    const c = contrast(colors.textOnNavySub, colors.bgDarkPanel)
    expect(c, `textOnNavySub on bgDarkPanel = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('v10.css: .news-chip--lang は var(--color-text-muted) を参照し、#f1f5f9 背景上でAAを満たす', () => {
    const css = readSrc('styles/v10.css')
    const idx = css.indexOf('.news-chip--lang')
    expect(idx).toBeGreaterThan(-1)
    const block = css.slice(idx, css.indexOf('}', idx) + 1)
    expect(block).toMatch(/color:\s*var\(--color-text-muted\)/)
    expect(block).not.toMatch(/color:\s*#64748b/)
    const vars = generateCssVars()
    const c = contrast(vars['--color-text-muted'], '#f1f5f9')
    expect(c, `text-muted on #f1f5f9 = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('v10.css: .news-cat-tabs__item.active .news-cat-tabs__count の白オーバーレイはAAを満たすalphaを維持する（0.25への回帰防止）', () => {
    const css = readSrc('styles/v10.css')
    const idx = css.indexOf('.news-cat-tabs__item.active .news-cat-tabs__count')
    expect(idx).toBeGreaterThan(-1)
    const block = css.slice(idx, css.indexOf('}', idx) + 1)
    const m = block.match(/rgba\(255,\s*255,\s*255,\s*([0-9.]+)\)/)
    expect(m, `no rgba overlay found: ${block}`).not.toBeNull()
    const alpha = parseFloat(m![1])
    expect(alpha, 'overlay alpha regressed to old 0.25 value').toBeLessThanOrEqual(0.2)
    const vars = generateCssVars()
    const bg = blendHex('#ffffff', vars['--color-primary'], alpha)
    const c = contrast('#ffffff', bg)
    expect(c, `white on ${bg} (alpha=${alpha}) = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('MobileBottomActionBar.tsx: primaryStyle の有効時テキスト色は白（textPrimaryのdark-on-dark回帰防止）', () => {
    const src = readSrc('components/mobile/MobileBottomActionBar.tsx')
    const idx = src.indexOf('color:')
    const block = src.slice(0, src.length)
    const m = block.match(/color:\s*primaryAction\.disabled \? colors\.textMuted : ('#ffffff'|colors\.\w+)/)
    expect(m, 'primaryStyle color ternary not found in expected shape').not.toBeNull()
    expect(m![1]).toBe("'#ffffff'")
    // BUY/HOLD/WAIT/SELLいずれの背景でも白文字がAAを満たすことを実測する
    for (const [name, bg] of [['buy', colors.buy], ['hold', colors.hold], ['wait', colors.wait], ['sell', colors.sell]] as const) {
      const c = contrast('#ffffff', bg)
      expect(c, `white on ${name}(${bg}) = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
    void idx
  })

  it('T7_Trust.tsx: 「本日エントリー済みにする」ボタンは raw fundAccent でなく fundAccentText を背景に使う', () => {
    const src = readSrc('components/tabs/T7_Trust.tsx')
    const idx = src.indexOf('本日エントリー済みにする')
    expect(idx, 'button label not found').toBeGreaterThan(-1)
    const block = src.slice(Math.max(0, idx - 400), idx)
    const m = block.match(/background:\s*colors\.(\w+)/)
    expect(m, `no background found near button: ${block}`).not.toBeNull()
    expect(m![1]).toBe('fundAccentText')
    const c = contrast('#ffffff', colors.fundAccentText)
    expect(c, `white on fundAccentText = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('T4_IdealPf.tsx: CLASS_ACCENT は accentText フィールドを持ち、AllocRowのisUnder分岐は barAccent でなく accent.accentText を参照する', () => {
    const src = readSrc('components/tabs/T4_IdealPf.tsx')
    const accentBlockIdx = src.indexOf('const CLASS_ACCENT')
    expect(accentBlockIdx).toBeGreaterThan(-1)
    const accentBlock = src.slice(accentBlockIdx, src.indexOf('\n}', accentBlockIdx))
    expect(accentBlock).toMatch(/JP_TRUST:\s*{ accent: colors\.jpFundAccent,\s*accentBg: colors\.jpFundAccentBg,\s*accentText: colors\.jpFundAccentText }/)

    const ptDiffIdx = src.indexOf('isOver ? colors.waitText : isUnder ?')
    expect(ptDiffIdx, 'ptDiff color ternary not found').toBeGreaterThan(-1)
    const line = src.slice(ptDiffIdx, ptDiffIdx + 120)
    expect(line).toMatch(/isUnder \? accent\.accentText : colors\.textMuted/)
    expect(line).not.toMatch(/isUnder \? barAccent/)

    // JP_TRUSTのaccentText（jpFundAccentText）は白背景でAAを満たす（raw jpFundAccentは3.68で未達）
    const cRaw  = contrast(colors.jpFundAccent, colors.bgSurface)
    const cText = contrast(colors.jpFundAccentText, colors.bgSurface)
    expect(cRaw, `raw jpFundAccent on white = ${cRaw.toFixed(2)} (未達のまま保持していることの確認)`).toBeLessThan(AA_NORMAL)
    expect(cText, `jpFundAccentText on white = ${cText.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})

describe('UI-9B-R2: T5_News SentimentBar / importance label 構造回帰防止（大量同型issueの代表pin）', () => {
  it('SentimentBar: ラベル文字色(labelColor)と装飾バー色(barColor)が分離されている（barColor直接流用への回帰防止）', () => {
    const src = readSrc('components/tabs/T5_News.tsx')
    const fnIdx = src.indexOf('function SentimentBar')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnBody = src.slice(fnIdx, src.indexOf('\n}', fnIdx))
    expect(fnBody).toMatch(/const labelColor = /)
    // ラベルspanはlabelColorを参照し、barColorを直接参照していないこと
    const labelSpanMatch = fnBody.match(/<span style=\{\{ fontSize: '10px', color: (\w+),[^}]*\}\}>\{label\}<\/span>/)
    expect(labelSpanMatch, `label span not found in expected shape: ${fnBody.slice(-300)}`).not.toBeNull()
    expect(labelSpanMatch![1]).toBe('labelColor')

    // labelColorに使われる3値（positive/negative/neutral）は実際にAAを満たす
    const positive = contrast('#0369a1', colors.bgSurface)
    const negative = contrast('#92400e', colors.bgSurface)
    const neutral  = contrast(colors.textSubtle, colors.bgSurface)
    expect(positive, `positive labelColor = ${positive.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(negative, `negative labelColor = ${negative.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(neutral, `neutral labelColor(textSubtle) = ${neutral.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)

    // 装飾バー色(barColor)自体はraw値のまま変更していない（意味/色相を変えない原則の確認）
    expect(fnBody).toMatch(/const barColor = clampedScore > 0\.25 \? '#38bdf8' : clampedScore < -0\.25 \? '#f59e0b'/)
  })

  it('importance label span は importance-bar__fill--{cls} className を持たない（背景色とtext色が衝突するバグの回帰防止）', () => {
    const src = readSrc('components/tabs/T5_News.tsx')
    const idx = src.indexOf('{impText}')
    expect(idx, '{impText} not found').toBeGreaterThan(-1)
    const before = src.slice(Math.max(0, idx - 300), idx)
    expect(before).not.toMatch(/className=\{`importance-bar__fill--/)

    // 低重要度時のinline text colorを実sourceから抽出し、実際のnews-card背景に対する
    // AA contrastを検証する（同一literalの二重代入によるtautologyを避け、実装/token両方を読む）。
    const lowColorMatch = before.match(/'var\(--color-text-muted\)'\s*\}\}/)
    expect(lowColorMatch, `low-importance inline color literal not found in: ${before}`).not.toBeNull()
    const vars = generateCssVars()
    const lowFg  = vars['--color-text-muted']
    const cardBg = vars['--color-background']
    expect(cardBg, '--color-background is unresolved').toMatch(/^#[0-9a-fA-F]{6}$/)
    const c = contrast(lowFg, cardBg)
    expect(c, `低重要度inline color(${lowFg}) on news-card background(${cardBg}) = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)

    // 回帰時に何が起きるかを実CSSから直接検証する: className再導入時の実背景tokenが
    // text色と同一tokenを参照している限り、collision(fg===bg, contrast=1.0)が再現する
    // ことをv10.cssの実ルールから確認する（tokens.ts値のハードコード二重比較ではない）。
    const v10Css = readSrc('styles/v10.css')
    const bgRuleMatch = v10Css.match(/\.importance-bar__fill--low\s*\{\s*background:\s*var\((--[\w-]+)\)/)
    expect(bgRuleMatch, 'importance-bar__fill--low background rule not found in v10.css').not.toBeNull()
    expect(bgRuleMatch![1]).toBe('--color-text-muted')
  })
})

describe('UI-9B-R2: StatusBar実描画のtoken参照pin（M3b旧1.06:1 regression検知）', () => {
  it('StatusBar.tsx: 先物SQ表示はinline color:inherit/固定literalを使わず、.status-bar__value（--color-text-on-navy）に委譲している', () => {
    const src = readSrc('components/StatusBar.tsx')
    const idx = src.indexOf('先物')
    expect(idx, 'SQ item not found').toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 400)
    // M3b旧バグ: color:'inherit' でbody既定色を継承し bgNavyLight 上で1.06:1になっていた
    expect(block).not.toMatch(/color:\s*['"]inherit['"]/)
    const m = block.match(/className="status-bar__value"/)
    expect(m, `status-bar__value class not applied to SQ span: ${block}`).not.toBeNull()

    const css = readSrc('styles/v10.css')
    const ruleIdx = css.indexOf('.status-bar__value {')
    expect(ruleIdx).toBeGreaterThan(-1)
    const rule = css.slice(ruleIdx, css.indexOf('}', ruleIdx) + 1)
    expect(rule).toMatch(/color:\s*var\(--color-text-on-navy\)/)

    const vars = generateCssVars()
    const c = contrast(vars['--color-text-on-navy'], colors.bgNavyLight)
    expect(c, `text-on-navy on bgNavyLight = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(12.5)
    // 旧1.06:1バグの値域には戻っていないことの明示的な下限
    expect(c).toBeGreaterThan(10)
  })
})
