// UI-9H H-P1-3: Phase8SummaryCard の loading表示が「読み込み中...」（ASCII三点リーダ）から
// 「読込中…」（U+2026、他タブの読込中表記と統一の語彙）へ統一されたことを固定する。
// view.kind==='loading'への到達は非同期state経由でSSR renderからは再現困難なため、
// raw source照合で固定する（P0のsqUnitRegression.test.ts方式）。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import phase8Source from './Phase8SummaryCard.tsx?raw'

describe('UI-9H H-P1-3: Phase8SummaryCard の loading表示は「読込中…」に統一されている', () => {
  it('canonical表記「読込中…」が存在する', () => {
    expect(phase8Source).toContain('読込中…')
  })

  // mutation guard: 旧表記へ戻す（＝ASCII三点リーダ・「読み込み中」への回帰）と RED になる
  it('旧表記「読み込み中...」が残存しない', () => {
    expect(phase8Source).not.toContain('読み込み中...')
    expect(phase8Source).not.toMatch(/読み込み中/)
  })
})
