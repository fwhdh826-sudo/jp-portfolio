// UI-9H H-P1-8: T1_Decision の mom3m 表示（3件）が手書き符号
// `${h.mom3m >= 0 ? '+' : ''}${h.mom3m.toFixed(1)}%` から
// formatSignedPct(h.mom3m, 1) へ統一されたことを固定する。
// formatSignedPct自体の0→符号なし契約は utils/format.test.ts で網羅済み。
// StockDetailは内部state（コード選択）経由でしか到達できずSSR renderでは
// 再現できないため、raw source照合で固定する（P0のsqUnitRegression.test.ts方式）。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t1Source from './T1_Decision.tsx?raw'

describe('UI-9H H-P1-8: T1_Decision の mom3m 表示は formatSignedPct を使う', () => {
  it('3箇所すべてが formatSignedPct(h.mom3m, 1) を呼び出す', () => {
    const count = t1Source.split('formatSignedPct(h.mom3m, 1)').length - 1
    expect(count).toBe(3)
  })

  // mutation guard: 手書き三項演算子へ戻す（＝+0.0%を生成しうる旧バグへの回帰）と RED になる
  it('旧手書き符号パターン `mom3m >= 0 ? \'+\' : \'\'` が残存しない', () => {
    expect(t1Source).not.toMatch(/mom3m\s*>=\s*0\s*\?\s*['"]\+['"]\s*:\s*['"]['"]/)
  })
})
