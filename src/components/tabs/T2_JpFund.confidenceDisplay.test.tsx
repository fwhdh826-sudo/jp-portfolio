import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionCard } from '../cards/DecisionCard'
import { CircularGauge } from '../charts/CircularGauge'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t2Source from './T2_JpFund.tsx?raw'

// P0-3: T2国内投信のhero scoreが「7600」等と表示されるdisplay-only bugの回帰防止。
//
// root cause: trustPlan.shortTermMode.confidence は canonical に 0〜100（percent）scale
// （domain: src/domain/optimization/trustPortfolio.ts の candidateConfidence は
// Math.round(clamp(..., 30, 98)) で生成され、ENTRY_CONFIDENCE_THRESHOLD=90 と直接比較、
// T7_Trust.tsx でも同一フィールドを score={trustPlan.shortTermMode.confidence} と
// 生値のまま消費している）。T2_JpFund.tsx のみが score={Math.round(mode.confidence * 100)}
// と誤って100倍しており、confidence=76 のとき表示が「7600」になっていた。

describe('P0-3: T2 hero score display（表示層のみ）', () => {
  it('T2_JpFund.tsx のソースに mode.confidence への誤った *100 が存在しない', () => {
    expect(t2Source).not.toMatch(/mode\.confidence\s*\*\s*100/)
  })

  it('T2_JpFund.tsx が DecisionCard/CircularGauge へ mode.confidence を生値のまま渡している', () => {
    expect(t2Source).toContain('score={mode.confidence}')
    expect(t2Source).toContain('value={mode.confidence}')
  })

  it('decision/判定値の受け渡しは変更されていない（表示スコアのみの修正であることの確認）', () => {
    expect(t2Source).toContain('decision={displayDecision}')
    expect(t2Source).toContain('tone={signal === \'BULL\' ? \'buy\' : signal === \'BEAR\' ? \'sell\' : \'hold\'}')
  })

  describe.each([
    { confidence: 76, expected: '76' },
    { confidence: 0, expected: '0' },
    { confidence: 100, expected: '100' },
  ])('mode.confidence=$confidence（T2が実際に渡すのと同じ生値）', ({ confidence, expected }) => {
    it(`DecisionCard の score表示が「${expected}」になる（7600等にならない）`, () => {
      const html = renderToStaticMarkup(
        <DecisionCard
          decision="HOLD"
          title="今日の判断: 待機"
          score={confidence}
          reasons={['テスト理由']}
        />,
      )
      expect(html).toContain(`>${expected}<`)
      if (confidence !== 0) {
        expect(html).not.toContain(`>${confidence * 100}<`)
      }
    })

    it(`CircularGauge の value表示が「${expected}」になる（7600等にならない）`, () => {
      const html = renderToStaticMarkup(
        <CircularGauge
          value={confidence}
          size={88}
          strokeWidth={9}
          tone="hold"
          sublabel="/100"
          unit=""
        />,
      )
      expect(html).toContain(`>${expected}<`)
      if (confidence !== 0) {
        expect(html).not.toContain(`>${confidence * 100}<`)
      }
    })
  })
})
