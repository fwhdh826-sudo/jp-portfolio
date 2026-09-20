import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t0Source from './T0_Home.tsx?raw'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t1Source from './T1_Decision.tsx?raw'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t6Source from './T6_Committee.tsx?raw'
import { displayDecisionLabel } from './T1_Decision'
import { STOCK_DECISION_LABEL } from '../../presentation/ui9i/stocksPresentation'

describe('INSUFFICIENT_EVIDENCE display contract', () => {
  it('Phase 2B-1: R4.1 の個別株面は銘柄単位の局所ラベル「判断材料不足」で示す（enum は不変）', () => {
    expect(STOCK_DECISION_LABEL.INSUFFICIENT_EVIDENCE).toBe('判断材料不足')
    expect(Object.keys(STOCK_DECISION_LABEL).sort()).toEqual(['BUY', 'DATA_WAIT', 'HOLD', 'INSUFFICIENT_EVIDENCE', 'SELL', 'WAIT'])
  })

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
