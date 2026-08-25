// UI-9H H-P1-7: T2_JpFund の「執行ガイドライン」（SectionHeader title・コメント）を
// 「実行ガイドライン」表記へ統一する。SAFE_MODE/DQ抑制判定ロジック・
// mode.canEnter自体には一切触れない。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t2Source from './T2_JpFund.tsx?raw'

describe('UI-9H H-P1-7: T2_JpFund の執行/実行表記は「実行」に統一されている', () => {
  it('canonical表記（実行ガイドライン）が存在する', () => {
    expect(t2Source).toContain('title="実行ガイドライン"')
    expect(t2Source).toContain('実行ガイドライン（金額）を非表示')
  })

  // mutation guard: 「執行」へ戻す（＝旧表記への回帰）と RED になる
  it('旧表記「執行ガイドライン」が残存しない', () => {
    expect(t2Source).not.toContain('執行ガイドライン')
  })
})
