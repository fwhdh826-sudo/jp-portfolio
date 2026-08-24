// UI-9H H-P0-3: SQ 残日数の単位「営業日」不整合。
// src/types/macro.ts:40 は SQEvent.dayUntil を「SQまでの営業日」と定義しており、
// T0/T7/domain はすべて「営業日」と表記しているのに対し StatusBar のみ末尾が
// 「日」に脱落していた（暦日と誤読すると SQ 週の到来を最大 6 日遅く見積もる）。
// 値・SQ計算ロジックには一切触れず、表示テキストの単位のみを固定する。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import statusBarSource from './StatusBar.tsx?raw'

describe('UI-9H H-P0-3: StatusBar の SQ 残日数表記は「営業日」を明示する', () => {
  it('sqLabel のテンプレート文字列が dayUntil の直後に「営業日」を付与する', () => {
    const idx = statusBarSource.indexOf('const sqLabel')
    expect(idx).toBeGreaterThan(-1)
    const block = statusBarSource.slice(idx, idx + 200)
    expect(block).toContain('`SQ残${sqCalendar.nextSQ.dayUntil}営業日`')
  })

  // mutation guard: 単位を「日」に戻す（＝旧バグへの回帰）と RED になる
  it('「営業日」を伴わない裸の `${dayUntil}日` パターンが存在しない', () => {
    const idx = statusBarSource.indexOf('const sqLabel')
    const block = statusBarSource.slice(idx, idx + 200)
    expect(block).not.toMatch(/dayUntil\}日`/)
  })
})
