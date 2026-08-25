// UI-9H P1 H-P1-11/H-P1-12: LIMITING_FACTOR_LABEL の表示語彙契約。
// H-P1-11: DEPLOYABLE_CASH は「投資可能資金」ではなく「投資可能現金」
//          （domain/cash/cashAuthority.ts のコメント正典・T0/T9の直書き表記と統一）。
// H-P1-12: CLASS_HEADROOM/INSTRUMENT_HEADROOM は「資産クラス余力」「銘柄別余力」
//          （T2/T7のMetricCard表記と統一。domain enum key自体は不変）。
import { describe, expect, it } from 'vitest'
import { LIMITING_FACTOR_LABEL, labelLimitingFactors } from './candidateDecisionSynthesisPresentation'

describe('UI-9H P1 H-P1-11/12: LIMITING_FACTOR_LABEL 用語統一', () => {
  it('DEPLOYABLE_CASH は「投資可能現金」（「投資可能資金」ではない）', () => {
    expect(LIMITING_FACTOR_LABEL.DEPLOYABLE_CASH).toBe('投資可能現金')
    expect(LIMITING_FACTOR_LABEL.DEPLOYABLE_CASH).not.toBe('投資可能資金')
  })

  it('CLASS_HEADROOM は「資産クラス余力」', () => {
    expect(LIMITING_FACTOR_LABEL.CLASS_HEADROOM).toBe('資産クラス余力')
  })

  it('INSTRUMENT_HEADROOM は「銘柄別余力」', () => {
    expect(LIMITING_FACTOR_LABEL.INSTRUMENT_HEADROOM).toBe('銘柄別余力')
  })

  it('labelLimitingFactors はcanonical labelを順序通り返す', () => {
    expect(labelLimitingFactors(['DEPLOYABLE_CASH', 'CLASS_HEADROOM', 'INSTRUMENT_HEADROOM'])).toEqual([
      '投資可能現金', '資産クラス余力', '銘柄別余力',
    ])
  })

  // mutation guard: DEPLOYABLE_CASH を旧表記「投資可能資金」へ戻すとRED化する。
  it('[mutation guard] DEPLOYABLE_CASH label は旧表記「投資可能資金」ではない', () => {
    expect(LIMITING_FACTOR_LABEL.DEPLOYABLE_CASH).not.toBe('投資可能資金')
  })
})
