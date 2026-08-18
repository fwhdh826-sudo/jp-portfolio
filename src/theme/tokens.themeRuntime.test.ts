import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync, readdirSync, statSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname, join } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { colors, generateCssVars } from './tokens'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC_ROOT  = resolve(REPO_ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css)$/.test(entry) && !entry.includes('.test.')) out.push(full)
  }
  return out
}

// T6_Committee.tsx の HeroVerdictPanel / stock-selector は
// `var(--color-${cls}-bg)` のようにトークン名を動的に組み立てる。
// cls は同ファイル内で 'buy' | 'sell' | 'wait' | 'hold' に静的に限定されている
// （suppressBuyDisplayDecision の分岐で確認済み）ため、census はこの既知の
// 展開結果を明示的に含める。
const KNOWN_DYNAMIC_VAR_EXPANSIONS = [
  '--color-buy-bg', '--color-buy-border', '--color-buy-text',
  '--color-sell-bg', '--color-sell-border', '--color-sell-text',
  '--color-wait-bg', '--color-wait-border', '--color-wait-text',
  '--color-hold-bg', '--color-hold-border', '--color-hold-text',
]

function collectStaticVarNames(): Set<string> {
  const names = new Set<string>(KNOWN_DYNAMIC_VAR_EXPANSIONS)
  const re = /var\(--([a-zA-Z0-9-]+)/g
  for (const file of walk(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const name = m[1]
      // `var(--color-${cls}-bg)` のような動的テンプレートは KNOWN_DYNAMIC_VAR_EXPANSIONS
      // 側で扱うためスキップする（正規表現は `${cls}` の直前で止まり `--color-` のみを拾う）
      if (text.slice(m.index, m.index + 20).includes('${')) continue
      names.add(`--${name}`)
    }
  }
  return names
}

describe('UI-9A: runtime design token restoration', () => {
  it('main.tsx は React render (createRoot) より前に applyTheme() を1回呼ぶ', () => {
    const mainSrc = readFileSync(resolve(SRC_ROOT, 'main.tsx'), 'utf8')
    expect(mainSrc).toMatch(/import\s*\{[^}]*\bapplyTheme\b[^}]*\}\s*from\s*['"]\.\/theme\/tokens['"]/)

    const applyThemeIdx = mainSrc.indexOf('applyTheme()')
    const createRootIdx = mainSrc.indexOf('createRoot(')
    expect(applyThemeIdx, 'applyTheme() 呼び出しが見つからない').toBeGreaterThan(-1)
    expect(createRootIdx, 'createRoot( 呼び出しが見つからない').toBeGreaterThan(-1)
    expect(applyThemeIdx, 'applyTheme() は createRoot() より前に呼ぶ必要がある').toBeLessThan(createRootIdx)

    // applyTheme が2回以上呼ばれていないことをpin（重複注入防止）
    const occurrences = mainSrc.split('applyTheme()').length - 1
    expect(occurrences).toBe(1)
  })

  it('src/** が静的参照する var(--*) は generateCssVars() 出力の subset である（unresolved = 0）', () => {
    const used     = collectStaticVarNames()
    const defined  = new Set(Object.keys(generateCssVars()))
    const unresolved = [...used].filter(name => !defined.has(name)).sort()
    expect(unresolved, `unresolved CSS variables: ${unresolved.join(', ')}`).toEqual([])
  })

  it('UI-9Aで追加したaliasは既存canonical tokenの値をそのまま保持する（新規色を発明しない）', () => {
    const vars = generateCssVars()
    expect(vars['--color-background']).toBe(colors.bgSurface)
    expect(vars['--color-bg-card']).toBe(colors.bgSurface)
    expect(vars['--color-bg-subtle']).toBe(colors.neutralBg)
    expect(vars['--color-bg-wash']).toBe(colors.neutralBg)
    expect(vars['--color-border']).toBe(colors.borderDefault)
    expect(vars['--color-brand']).toBe(colors.primary)
    expect(vars['--color-brand-bg-faint']).toBe(colors.primaryLight)
    expect(vars['--color-stale-text']).toBe(colors.gold)
    expect(vars['--color-stock-accent']).toBe(colors.stockAccent)
    expect(vars['--color-stock-bg-faint']).toBe(colors.stockAccentBg)
    expect(vars['--color-surface']).toBe(colors.bgSurface)
    expect(vars['--color-text']).toBe(colors.textPrimary)
    expect(vars['--color-text-secondary']).toBe(colors.textSecond)
  })

  it('generateCssVars() は UI-9A追加分13個を含む113キーを出力する', () => {
    expect(Object.keys(generateCssVars())).toHaveLength(113)
  })
})
