// UI-9H H-P1-8 / [F-1]是正: MacroIntelPanel の nikkei_5d_return 表示が手書き符号
// `${nk5d >= 0 ? '+' : ''}${(nk5d * 100).toFixed(1)}%` から
// formatNikkei5dReturn（内部で formatSignedPct(nk5d * 100, 1) を呼ぶ）へ統一されたことを固定する。
//
// MacroIntelPanel は自己フェッチコンポーネント（useEffect + fetch）であり、
// renderToStaticMarkup は effect を実行しないため、既存の displayConvention.uiE.test.tsx の
// renderWith(state, Component) 方式（store経由のprops描画）でfixtureを注入できない。
// jsdom/testing-library もこのrepoには存在しない（package.json変更は本slice scope外）。
// そのため formatNikkei5dReturn を module-level export し、production render body が
// 実際に呼び出すのと同一の関数へ直接 value-level assertion を行うことで、
// [F-6]（H-P1-8 testがrender層assertionを欠く）を this file の範囲で是正する。
import { describe, expect, it } from 'vitest'
import { formatNikkei5dReturn } from './MacroIntelPanel'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import macroIntelPanelSource from './MacroIntelPanel.tsx?raw'

describe('UI-9H H-P1-8: MacroIntelPanel の nikkei_5d_return 表示は formatSignedPct を使う（source照合）', () => {
  it('formatSignedPct(nk5d * 100, 1) を呼び出す', () => {
    expect(macroIntelPanelSource).toContain('formatSignedPct(nk5d * 100, 1)')
  })

  // mutation guard: 手書き三項演算子へ戻す（＝+0.0%/-0.0%を生成しうる旧バグへの回帰）と RED になる
  it('旧手書き符号パターン `nk5d >= 0 ? \'+\' : \'\'` が残存しない', () => {
    expect(macroIntelPanelSource).not.toMatch(/nk5d\s*>=\s*0\s*\?\s*['"]\+['"]\s*:\s*['"]['"]/)
  })
})

describe('UI-9H H-P1-8: formatNikkei5dReturn の value-level assertion（[F-1]/[F-6]是正, render層相当）', () => {
  it('nikkei_5d_return = 0 → "0.0%"（+0.0%/-0.0%を生成しない）', () => {
    const s = formatNikkei5dReturn(0)
    expect(s).toBe('0.0%')
    expect(s).not.toContain('+0.0%')
    expect(s).not.toContain('-0.0%')
  })

  it('負のzero相当値（-0）→ "0.0%"（-0.0%を生成しない）', () => {
    const s = formatNikkei5dReturn(-0)
    expect(s).toBe('0.0%')
    expect(s).not.toContain('-0.0%')
  })

  it('丸めて0.0になる微小負値 → "0.0%"（-0.0%を生成しない）', () => {
    const s = formatNikkei5dReturn(-0.00001)
    expect(s).toBe('0.0%')
    expect(s).not.toContain('-0.0%')
  })

  it('正の値 → "+N.N%"', () => {
    expect(formatNikkei5dReturn(0.0532)).toBe('+5.3%')
  })

  it('負の値 → "-N.N%"', () => {
    expect(formatNikkei5dReturn(-0.0532)).toBe('-5.3%')
  })

  it('non-number / non-finite → "—"', () => {
    expect(formatNikkei5dReturn(null)).toBe('—')
    expect(formatNikkei5dReturn(undefined)).toBe('—')
    expect(formatNikkei5dReturn(NaN)).toBe('—')
    expect(formatNikkei5dReturn(Infinity)).toBe('—')
  })
})
