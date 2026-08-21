import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname, join } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'

// UI-9D P0-1回帰防止: .section-kicker / .section-heading / .settings-section__title を
// 使用しているすべてのtsxが、実際にstylesheet側で定義済みであることを固定する。
// （監査で発見された「クラス名は使われているがCSSルールが存在しない」状態の再発防止）

const HERE = resolve(dirname(fileURLToPath(import.meta.url)))
const SRC_ROOT = resolve(HERE, '..')

const v10Css: string = readFileSync(resolve(HERE, 'v10.css'), 'utf8')
const candidateFunnelCss: string = readFileSync(
  resolve(SRC_ROOT, 'components/candidates/CandidateFunnelPanel.css'), 'utf8',
)
const allCss = v10Css + '\n' + candidateFunnelCss

function walkTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkTsxFiles(full))
    } else if (entry.isFile() && (entry.name.endsWith('.tsx'))) {
      files.push(full)
    }
  }
  return files
}

const TARGET_PATTERN = /section-(kicker|heading)|settings-section__title/

function collectMatchingClassNames(source: string): string[] {
  const found = new Set<string>()
  const classAttrMatches = source.matchAll(/className=["']([^"'{}]+)["']/g)
  for (const m of classAttrMatches) {
    for (const token of m[1].split(/\s+/)) {
      if (TARGET_PATTERN.test(token)) found.add(token)
    }
  }
  return [...found]
}

function hasCssRule(className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`\\.${escaped}\\s*[,{]`)
  return rule.test(allCss)
}

describe('UI-9D P0-1: section-kicker / section-heading / settings-section__title のCSS定義存在確認', () => {
  const tsxFiles = walkTsxFiles(SRC_ROOT)
  const usageByFile = new Map<string, string[]>()
  for (const file of tsxFiles) {
    const source = readFileSync(file, 'utf8')
    const matched = collectMatchingClassNames(source)
    if (matched.length > 0) usageByFile.set(file, matched)
  }

  it('少なくとも1件のtsxで対象クラスが実際に使用されている（テスト自体の前提確認）', () => {
    expect(usageByFile.size).toBeGreaterThan(0)
  })

  it('使用されている全classNameがv10.cssまたはCandidateFunnelPanel.cssにルールを持つ', () => {
    const missing: string[] = []
    for (const [file, classNames] of usageByFile) {
      for (const className of classNames) {
        if (!hasCssRule(className)) missing.push(`${className} (${file})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('.section-heading-row は廃止済みでどのtsxからも参照されない', () => {
    const offenders: string[] = []
    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8')
      if (/className=["'][^"']*\bsection-heading-row\b/.test(source)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('.section-kicker / .section-heading / .settings-section__title 自体がCSSに定義されている', () => {
    expect(hasCssRule('section-kicker')).toBe(true)
    expect(hasCssRule('section-heading')).toBe(true)
    expect(hasCssRule('settings-section__title')).toBe(true)
  })
})
