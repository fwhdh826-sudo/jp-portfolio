import { describe, expect, it } from 'vitest'
import type { TabId } from '../../types'
import {
  FUNDS_HUB_LINKS,
  OTHER_HUB_LINKS,
  PF_SURFACE_LINKS,
  PRIMARY_NAV,
  PRIMARY_NAV_TARGET,
  resolvePrimaryNav,
  type NavTarget,
} from './navigation'

const ALL_TABS: TabId[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']

describe('ユーザー向けナビ: 今日 / 個別株 / 投信 / PF / その他', () => {
  it('モバイルの項目名と順序', () => {
    expect(PRIMARY_NAV.map(n => n.label)).toEqual(['今日', '個別株', '投信', 'PF', 'その他'])
  })

  it('内部の T 番号をユーザーに露出しない', () => {
    const visible = JSON.stringify([
      PRIMARY_NAV, FUNDS_HUB_LINKS.map(l => [l.title, l.description]),
      OTHER_HUB_LINKS.map(l => [l.title, l.description]), PF_SURFACE_LINKS.map(l => [l.title, l.description]),
    ])
    expect(visible).not.toMatch(/\bT[0-9]\b/)
  })
})

describe('既存 T0–T9 の全機能へ到達できる（機能を削除しない）', () => {
  // ナビ → ハブ/PF面 → 葉画面 を辿って到達できる TabId を列挙する。
  function reachableTabs(): Set<TabId> {
    const reached = new Set<TabId>()
    const visit = (t: NavTarget) => {
      if (t.tab !== null) reached.add(t.tab)
    }
    const surfaceLinks: Record<string, readonly { target: NavTarget }[]> = {
      funds_hub: FUNDS_HUB_LINKS, other_hub: OTHER_HUB_LINKS, pf: PF_SURFACE_LINKS,
    }
    const seen = new Set<string>()
    const walk = (t: NavTarget) => {
      visit(t)
      if (t.surface !== null && !seen.has(t.surface)) {
        seen.add(t.surface)
        for (const l of surfaceLinks[t.surface] ?? []) walk(l.target)
      }
    }
    for (const nav of PRIMARY_NAV) walk(PRIMARY_NAV_TARGET[nav.id])
    // 従来のホーム（legacy_home 面）は T0 の旧内容。面としては到達可能であることを別テストで確認する。
    return reached
  }

  it('T0–T9 すべてがナビから到達できる', () => {
    const reached = reachableTabs()
    for (const tab of ALL_TABS) expect(reached.has(tab), `${tab} に到達できない`).toBe(true)
  })

  it('投信ハブ = T2 国内投信 / T3 海外投信 / T7 投信管理', () => {
    expect(FUNDS_HUB_LINKS.map(l => l.target.tab)).toEqual(['T2', 'T3', 'T7'])
  })

  it('その他ハブ = ニュース / AI委員会 / 学習・検証 / 設定 + 従来のホーム', () => {
    expect(OTHER_HUB_LINKS.map(l => l.title)).toEqual(['ニュース', 'AI委員会', '学習・検証', '設定', '従来のホーム'])
    expect(OTHER_HUB_LINKS.slice(0, 4).map(l => l.target.tab)).toEqual(['T5', 'T6', 'T8', 'T9'])
    expect(OTHER_HUB_LINKS[4].target).toEqual({ tab: null, surface: 'legacy_home' })
  })

  it('個別株は既存 T1 のまま（Decision Audit に置き換えない）', () => {
    expect(PRIMARY_NAV_TARGET.stocks).toEqual({ tab: 'T1', surface: null })
    expect(PRIMARY_NAV_TARGET.today).toEqual({ tab: 'T0', surface: null })
  })
})

describe('現在画面 → 主ナビ項目', () => {
  it('葉画面の対応', () => {
    expect(resolvePrimaryNav('T0', null)).toBe('today')
    expect(resolvePrimaryNav('T1', null)).toBe('stocks')
    for (const t of ['T2', 'T3', 'T7'] as const) expect(resolvePrimaryNav(t, null)).toBe('funds')
    expect(resolvePrimaryNav('T4', null)).toBe('pf')
    for (const t of ['T5', 'T6', 'T8', 'T9'] as const) expect(resolvePrimaryNav(t, null)).toBe('other')
  })

  it('UI 面は活性タブより優先される。判断の詳細は「今日」に属し、個別株を活性化しない', () => {
    expect(resolvePrimaryNav('T1', 'audit')).toBe('today')
    expect(resolvePrimaryNav('T0', 'funds_hub')).toBe('funds')
    expect(resolvePrimaryNav('T0', 'pf')).toBe('pf')
    expect(resolvePrimaryNav('T0', 'other_hub')).toBe('other')
    expect(resolvePrimaryNav('T0', 'legacy_home')).toBe('other')
  })
})
