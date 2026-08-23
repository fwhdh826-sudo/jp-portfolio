import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { dirname, join, resolve } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)))
const SRC_ROOT = resolve(HERE, '..')
const v10Css: string = readFileSync(resolve(HERE, 'v10.css'), 'utf8')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readRule(selector: string): string {
  const match = v10Css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule must exist`).toBeTruthy()
  return match![1]
}

function readDeclaration(selector: string, property: string): string {
  const match = readRule(selector).match(new RegExp(`${escapeRegExp(property)}\\s*:\\s*([^;]+)`))
  expect(match, `${selector} must declare ${property}`).toBeTruthy()
  return match![1].trim().replace(/\s+/g, ' ')
}

function walkTsxFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkTsxFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(path)
  }
  return files
}

function intrinsicMinimum(template: string, maxContentWidth: number): number {
  return template === 'minmax(0, 1fr)' ? 0 : maxContentWidth
}

function resolvedSingleTrackWidth(template: string, availableWidth: number, maxContentWidth: number): number {
  return Math.max(availableWidth, intrinsicMinimum(template, maxContentWidth))
}

describe('UI-9G G-1: page-grid intrinsic sizing contract', () => {
  it('single-column track accepts the container width instead of the child max-content width', () => {
    const template = readDeclaration('.page-grid', 'grid-template-columns')
    const auditedHoldingCardMaxContentWidth = 489

    for (const availableWidth of [366, 406]) {
      expect(resolvedSingleTrackWidth(template, availableWidth, auditedHoldingCardMaxContentWidth))
        .toBe(availableWidth)
      expect(resolvedSingleTrackWidth('1fr', availableWidth, auditedHoldingCardMaxContentWidth))
        .toBeGreaterThan(availableWidth)
    }
  })

  it('tablet/desktop modifiers preserve their column counts while removing intrinsic minimums', () => {
    expect(readDeclaration('.page-grid--2col', 'grid-template-columns'))
      .toBe('minmax(0, 1fr) minmax(0, 1fr)')
    expect(readDeclaration('.page-grid--3col', 'grid-template-columns'))
      .toBe('repeat(3, minmax(0, 1fr))')
    expect(readDeclaration('.page-grid--sidebar', 'grid-template-columns')).toBe('320px 1fr')
  })

  it('the shared page-grid contract is currently consumed only by the three reviewed T0 sections', () => {
    const usages = walkTsxFiles(SRC_ROOT).flatMap(file => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/className=["'][^"']*\bpage-grid\b[^"']*["']/g)]
        .map(() => file.slice(SRC_ROOT.length + 1))
    })

    expect(usages).toEqual([
      'components/tabs/T0_Home.tsx',
      'components/tabs/T0_Home.tsx',
      'components/tabs/T0_Home.tsx',
    ])
  })
})
