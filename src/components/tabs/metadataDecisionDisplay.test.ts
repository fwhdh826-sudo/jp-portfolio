import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t0Source from './T0_Home.tsx?raw'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t1Source from './T1_Decision.tsx?raw'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t6Source from './T6_Committee.tsx?raw'
import { displayDecisionLabel } from './T1_Decision'

describe('INSUFFICIENT_EVIDENCE display contract', () => {
  it('T1 maps the abstention enum to 分析データ不足', () => {
    expect(displayDecisionLabel('INSUFFICIENT_EVIDENCE')).toBe('分析データ不足')
  })

  it.each([
    ['T0', t0Source],
    ['T1', t1Source],
    ['T6', t6Source],
  ])('%s has an explicit 分析データ不足 presentation path', (_tab, source) => {
    expect(source).toContain('INSUFFICIENT_EVIDENCE')
    expect(source).toContain('分析データ不足')
  })
})
