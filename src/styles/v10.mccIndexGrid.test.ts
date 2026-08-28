import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { dirname, resolve } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const v10Css = readFileSync(resolve(HERE, 'v10.css'), 'utf8')

describe('UI-P2-1 I-6: T5 index grid narrow viewport containment', () => {
  it('2列・3列ともmin-contentで列幅を押し広げないminmax(0, 1fr)を使う', () => {
    const gridSection = v10Css.slice(
      v10Css.indexOf('.mcc-index-grid'),
      v10Css.indexOf('/* UI-12-2: Large Index Card */'),
    )

    expect(gridSection).toContain('repeat(2, minmax(0, 1fr))')
    expect(gridSection).toContain('repeat(3, minmax(0, 1fr))')
    expect(gridSection).not.toMatch(/repeat\([23],\s*1fr\)/)
  })

  it('320pxでも長い指数値をellipsisへ追い込まないresponsive font下限を持つ', () => {
    const valueRule = v10Css.match(/\.mcc-index-card__value\s*\{([^}]*)\}/)?.[1]
    expect(valueRule).toBeTruthy()
    expect(valueRule).toContain('font-size: clamp(18px, 5.6vw, 26px)')
  })
})
