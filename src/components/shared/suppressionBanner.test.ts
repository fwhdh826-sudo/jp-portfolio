// H-P1-1: SAFE_MODE / DQ 抑制 banner の shared authority 契約テスト。
// 区切り ` / `・接続 ` — `・状態語 `抑制中` の構造を固定し、scope 語は呼出側の指定を
// そのまま透過することを検証する（scope 語の統合はしない）。
import { describe, expect, it } from 'vitest'
import { SUPPRESSION_BANNER_PREFIX, suppressionBannerText } from './suppressionBanner'

describe('suppressionBannerText', () => {
  it('canonical構造 `⚠ SAFE_MODE / DQ抑制中 — {scope}停止中` を返す', () => {
    expect(suppressionBannerText('新規買い判断')).toBe('⚠ SAFE_MODE / DQ抑制中 — 新規買い判断停止中')
  })

  it('scope語が変わっても構造（prefix/接続/状態語）は不変で、scope語のみが透過する', () => {
    const scopes = ['新規買い判断', '追加投資判断', '買付・売却の実行判断', '買付', '実行判断', '配分調整']
    for (const scope of scopes) {
      expect(suppressionBannerText(scope)).toBe(`⚠ ${SUPPRESSION_BANNER_PREFIX} — ${scope}停止中`)
    }
  })

  it('SUPPRESSION_BANNER_PREFIXはbare labelとして` / `区切りを保つ（詰めない）', () => {
    expect(SUPPRESSION_BANNER_PREFIX).toBe('SAFE_MODE / DQ抑制中')
  })

  // mutation guard: 区切りを詰めた旧表記（`SAFE_MODE/DQ抑制中`）へ戻すとREDになることを固定する。
  it('[mutation guard] 区切り詰め `SAFE_MODE/DQ抑制中` を返さない', () => {
    expect(suppressionBannerText('買付')).not.toContain('SAFE_MODE/DQ抑制中')
    expect(SUPPRESSION_BANNER_PREFIX).not.toBe('SAFE_MODE/DQ抑制中')
  })

  // mutation guard: `SAFE_MODE有効` のような旧状態語が復活しないことを固定する。
  it('[mutation guard] 状態語は常に`抑制中`であり`有効`を含まない', () => {
    expect(SUPPRESSION_BANNER_PREFIX).not.toContain('有効')
    expect(suppressionBannerText('買付')).not.toContain('有効')
  })
})
