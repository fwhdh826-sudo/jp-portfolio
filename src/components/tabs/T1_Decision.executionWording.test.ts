// UI-9H H-P1-7: T1_Decision の「執行条件を充足」「通過 — 執行可」「非通過 — 執行抑制」
// 「執行条件」（SectionHeader title・コメント）は「実行」表記へ統一する
// （既存の「実行可能額」「実行判断」等の正典語と整合させる）。
// リスクゲート判定ロジック・debate.riskGatePass自体には一切触れない。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t1Source from './T1_Decision.tsx?raw'

describe('UI-9H H-P1-7: T1_Decision の執行/実行表記は「実行」に統一されている', () => {
  it('canonical表記（実行条件を充足・通過—実行可・非通過—実行抑制・実行条件）が存在する', () => {
    expect(t1Source).toContain('実行条件を充足')
    expect(t1Source).toContain('通過 — 実行可')
    expect(t1Source).toContain('非通過 — 実行抑制')
    expect(t1Source).toContain('title="実行条件"')
  })

  // mutation guard: 「執行」へ戻す（＝旧表記への回帰）と RED になる
  it('旧表記「執行条件」「執行可」「執行抑制」が残存しない', () => {
    expect(t1Source).not.toContain('執行条件')
    expect(t1Source).not.toContain('執行可')
    expect(t1Source).not.toContain('執行抑制')
  })
})
