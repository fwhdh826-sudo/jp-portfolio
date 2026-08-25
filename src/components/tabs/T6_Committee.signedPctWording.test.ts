// UI-9H H-P1-8: T6_Committee の EV 表示が手書き符号
// `${a.ev > 0 ? '+' : ''}${(a.ev * 100).toFixed(1)}%` から
// formatSignedPct(a.ev * 100, 1) へ統一されたことを固定する。
// formatSignedPct自体の0→符号なし契約は utils/format.test.ts で網羅済み。
// HeroVerdictPanelはT6内部state（銘柄選択、初期値はanalysis[0]）経由で
// しか到達できずSSR renderでのfixture構築コストが高いため、raw source照合で固定する
// （P0のsqUnitRegression.test.ts方式）。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t6Source from './T6_Committee.tsx?raw'

describe('UI-9H H-P1-8: T6_Committee の EV 表示は formatSignedPct を使う', () => {
  it('formatSignedPct(a.ev * 100, 1) を呼び出す', () => {
    expect(t6Source).toContain('formatSignedPct(a.ev * 100, 1)')
  })

  // mutation guard: 手書き三項演算子へ戻す（＝+0.0%を生成しうる旧バグへの回帰）と RED になる
  it('旧手書き符号パターン `a.ev > 0 ? \'+\' : \'\'` が残存しない', () => {
    expect(t6Source).not.toMatch(/a\.ev\s*>\s*0\s*\?\s*['"]\+['"]\s*:\s*['"]['"]/)
  })
})
