// UI-9H H-P1-8: T1_Decision の mom3m 表示（3件）が手書き符号
// `${h.mom3m >= 0 ? '+' : ''}${h.mom3m.toFixed(1)}%` から
// formatSignedPct(h.mom3m, 1) へ統一されたことを固定する。
// formatSignedPct自体の0→符号なし契約は utils/format.test.ts で網羅済み。
// 詳細の値は assembleStockDetail の出力でも検証している（stocksPresentation.test.ts）。
// ここでは手書き符号への回帰を raw source 照合でも固定する（P0のsqUnitRegression.test.ts方式）。
import { describe, expect, it } from 'vitest'
// Phase 2B-1: mom3m の整形は presentation（stocksPresentation）へ移設された。
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t1Source from '../../presentation/ui9i/stocksPresentation.ts?raw'

describe('UI-9H H-P1-8: T1_Decision の mom3m 表示は formatSignedPct を使う', () => {
  it('すべての箇所が formatSignedPct(h.mom3m, 1) を呼び出す', () => {
    // 旧 T1 は 3 箇所（KPI 行 / モメンタム行 / テクニカル行）。R4.1 では保有状況とテクニカルの 2 箇所。
    const count = t1Source.split('formatSignedPct(h.mom3m, 1)').length - 1
    expect(count).toBe(2)
  })

  // mutation guard: 手書き三項演算子へ戻す（＝+0.0%を生成しうる旧バグへの回帰）と RED になる
  it('旧手書き符号パターン `mom3m >= 0 ? \'+\' : \'\'` が残存しない', () => {
    expect(t1Source).not.toMatch(/mom3m\s*>=\s*0\s*\?\s*['"]\+['"]\s*:\s*['"]['"]/)
  })
})
