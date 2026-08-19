import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { signalButtonColor } from './MobileBottomActionBar'
import type { Signal } from '../badges/SignalBadge'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

const AA_NORMAL = 4.5
const SIGNALS: Signal[] = ['BUY', 'SELL', 'HOLD', 'WATCH']

describe('Mobile CTA BUY/HOLD/WATCH/SELL — 4 signal contrast pin（production未出現のSELLも含め全件固定）', () => {
  it.each(SIGNALS)('%s: signalButtonColor（背景）× 白文字 は AA >= 4.5:1 を満たす', (signal) => {
    const bg = signalButtonColor[signal]
    expect(bg, `signalButtonColor[${signal}] is not defined`).toBeDefined()
    const c = contrast('#ffffff', bg as string)
    expect(c, `${signal} background(${bg}) × white = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('primaryStyleの有効時文字色は白文字リテラル一箇所のみ（判定ロジックは無変更、配線のみ確認）', () => {
    const src = readFileSync(resolve(SRC_ROOT, 'mobile/MobileBottomActionBar.tsx'), 'utf8')
    expect(src).toContain("color:           primaryAction.disabled ? colors.textMuted : '#ffffff',")
  })

  it('4 signal全てが実装のsignalButtonColorマッピングに存在する（BUY/SELL/HOLD/WATCH網羅、判定ロジック不変の確認）', () => {
    expect(Object.keys(signalButtonColor).sort()).toEqual(['BUY', 'HOLD', 'SELL', 'WATCH'])
  })
})
