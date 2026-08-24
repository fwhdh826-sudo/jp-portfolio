// UI-9H H-P0-3: T2 の sqLabel() 4 分岐すべてで SQ 残日数の単位「営業日」が
// 脱落していた（`SQ ${days}日前` / `SQ ${days}日後`）。types/macro.ts:40 の
// dayUntil 定義（営業日）・domain の SQ 判定ロジックには一切触れず、
// 表示テキストの単位のみを固定する。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t2Source from './T2_JpFund.tsx?raw'

describe('UI-9H H-P0-3: T2 sqLabel() の SQ 残日数表記は「営業日」を明示する', () => {
  const idx = t2Source.indexOf('function sqLabel')
  const block = t2Source.slice(idx, idx + 400)

  it('sqLabel 関数が存在する', () => {
    expect(idx).toBeGreaterThan(-1)
  })

  it('極度警戒・警戒・注意・通常の4分岐すべてに「営業日」が付与される', () => {
    expect(block).toContain('`SQ ${days}営業日前 — 極度警戒`')
    expect(block).toContain('`SQ ${days}営業日前 — 警戒`')
    expect(block).toContain('`SQ ${days}営業日前 — 注意`')
    expect(block).toContain('`SQ ${days}営業日後`')
  })

  // mutation guard: 単位を「日」に戻す（＝旧バグへの回帰）と RED になる
  it('「営業日」を伴わない裸の `${days}日` パターンが存在しない', () => {
    expect(block).not.toMatch(/\$\{days\}日[前後]/)
  })
})
