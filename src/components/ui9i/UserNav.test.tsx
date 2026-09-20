// UI-9I Phase 1: ユーザー向けナビ / UI 面ルーティング / 既存 T1 との分離。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, TabId } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))
// zustand v4.5 は SSR 描画（renderToStaticMarkup）で getInitialState を返すため、UI 面ストアも
// useAppStore と同じ方式でモックして現在値を注入する。
const mockedSurface = vi.hoisted(() => ({ surface: null as string | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

vi.mock('../../store/uiSurface', () => ({
  useUiSurface: <Selected,>(selector: (s: { surface: string | null; openSurface: () => void; clearSurface: () => void }) => Selected): Selected =>
    selector({ surface: mockedSurface.surface, openSurface: () => {}, clearSurface: () => {} }),
}))

const { UserDockNav, UserSidebarNav } = await import('./UserNav')
const { App, isUi9iSurface } = await import('../../App')
const { applyNavTarget } = await import('./useGoTo')

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

/** aria-current="page" を持つ <button> だけを取り出し、そのラベルを返す（ボタン境界を越えない）。 */
function activeButtonLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-current="page"[^>]*>(.*?)<\/button>/g)]
    .map(m => m[1].replace(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, '').replace(/<[^>]+>/g, ''))
}

function withTab(tab: TabId) {
  mockedStore.state = { ...BASE, activeTab: tab }
}

const setSurface = (surface: string | null) => { mockedSurface.surface = surface }

beforeEach(() => {
  setSurface(null)
})

describe('UserDockNav / UserSidebarNav', () => {
  it('モバイル: 今日 / 個別株 / 投信 / PF / その他 の 5 項目。T 番号を出さない', () => {
    withTab('T0')
    const html = renderToStaticMarkup(<UserDockNav />)
    const labels = [...html.matchAll(/<span>([^<]+)<\/span><\/button>/g)].map(m => m[1])
    expect(labels).toEqual(['今日', '個別株', '投信', 'PF', 'その他'])
    expect(html).not.toMatch(/\bT[0-9]\b/)
    expect(html).toContain('aria-label="メインナビゲーション"')
  })

  it('デスクトップ: 今日 / 個別株 / 投信 / ポートフォリオ / ニュース / その他（Phase 2A で ニュース を追加）', () => {
    withTab('T0')
    const html = renderToStaticMarkup(<UserSidebarNav />)
    const labels = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(m => m[1])
    expect(labels).toEqual(['今日', '個別株', '投信', 'ポートフォリオ', 'ニュース', 'その他'])
    expect(html).not.toMatch(/\bT[0-9]\b/)
  })

  it('ニュース（T5）: デスクトップでは「ニュース」が活性、モバイルでは従来どおり「その他」が活性', () => {
    withTab('T5')
    expect(activeButtonLabels(renderToStaticMarkup(<UserSidebarNav />))).toEqual(['ニュース'])
    expect(activeButtonLabels(renderToStaticMarkup(<UserDockNav />))).toEqual(['その他'])
    withTab('T6')
    expect(activeButtonLabels(renderToStaticMarkup(<UserSidebarNav />))).toEqual(['その他'])
  })

  it('デスクトップ: 活性項目は常にちょうど 1 件（UI 面を含む）', () => {
    for (const [tab, surface] of [['T0', null], ['T5', null], ['T1', 'funds_hub'], ['T0', 'pf'], ['T0', 'other_hub'], ['T0', 'audit']] as const) {
      withTab(tab)
      setSurface(surface)
      expect((renderToStaticMarkup(<UserSidebarNav />).match(/aria-current="page"/g) ?? []).length, `${tab}/${surface}`).toBe(1)
    }
  })

  it('活性項目は aria-current="page" がちょうど 1 件', () => {
    for (const tab of ['T0', 'T1', 'T2', 'T4', 'T9'] as TabId[]) {
      withTab(tab)
      expect((renderToStaticMarkup(<UserDockNav />).match(/aria-current="page"/g) ?? []).length).toBe(1)
    }
  })

  it('葉画面 → 主ナビ: T2 / T3 / T7 は「投信」、T5 / T6 / T8 / T9 は「その他」、T4 は「PF」', () => {
    const activeLabel = (tab: TabId) => {
      withTab(tab)
      return activeButtonLabels(renderToStaticMarkup(<UserDockNav />))[0]
    }
    expect(activeLabel('T1')).toBe('個別株')
    expect(activeLabel('T2')).toBe('投信')
    expect(activeLabel('T3')).toBe('投信')
    expect(activeLabel('T7')).toBe('投信')
    expect(activeLabel('T4')).toBe('PF')
    expect(activeLabel('T5')).toBe('その他')
    expect(activeLabel('T9')).toBe('その他')
  })

  it('判断の詳細（audit 面）は「今日」を活性にし、個別株を活性にしない', () => {
    withTab('T0')
    setSurface('audit')
    expect(activeButtonLabels(renderToStaticMarkup(<UserDockNav />))).toEqual(['今日'])
    withTab('T1')
    expect(activeButtonLabels(renderToStaticMarkup(<UserDockNav />))).toEqual(['今日'])
  })
})

describe('applyNavTarget: 葉画面と UI 面', () => {
  const spy = () => ({ setTab: vi.fn(), openSurface: vi.fn(), clearSurface: vi.fn() })

  it('UI 面へは openSurface のみ（activeTab は変えない = T1 を置き換えない）', () => {
    const a = spy()
    applyNavTarget({ tab: null, surface: 'audit' }, a)
    expect(a.openSurface).toHaveBeenCalledWith('audit')
    expect(a.setTab).not.toHaveBeenCalled()
    expect(a.clearSurface).not.toHaveBeenCalled()
  })

  it('葉画面へは UI 面を解除してから setTab', () => {
    const a = spy()
    applyNavTarget({ tab: 'T1', surface: null }, a)
    expect(a.clearSurface).toHaveBeenCalledTimes(1)
    expect(a.setTab).toHaveBeenCalledWith('T1')
    expect(a.openSurface).not.toHaveBeenCalled()
  })
})

describe('App のルーティング: Decision Audit は既存 T1（個別株）を置き換えない', () => {
  it('isUi9iSurface: T0 と R4.1 面のみ。T1–T9 と従来のホームは従来ヘッダーを維持', () => {
    expect(isUi9iSurface('T0', null)).toBe(true)
    expect(isUi9iSurface('T1', null)).toBe(false)
    expect(isUi9iSurface('T9', null)).toBe(false)
    expect(isUi9iSurface('T0', 'audit')).toBe(true)
    expect(isUi9iSurface('T1', 'funds_hub')).toBe(true)
    expect(isUi9iSurface('T0', 'legacy_home')).toBe(false)
  })

  it('activeTab=T1・面なし → 既存 T1 を表示し、Decision Audit は出ない', () => {
    withTab('T1')
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('個別株ポートフォリオ') // T1 PageHeader
    expect(html).not.toContain('data-testid="decision-audit"')
    expect(html).toContain('class="app-header"') // 従来画面は従来ヘッダーを維持
  })

  it('audit 面 → Decision Audit を表示。activeTab は T1 のままで T1 は消えず、戻れば T1', () => {
    withTab('T1')
    setSurface('audit')
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('data-testid="decision-audit"')
    expect(html).not.toContain('個別株ポートフォリオ')
    expect(html).not.toContain('class="app-header"')
    expect(mockedStore.state?.activeTab).toBe('T1')
    setSurface(null)
    expect(renderToStaticMarkup(<App />)).toContain('個別株ポートフォリオ')
  })

  it('各 UI 面がルーティングされる（投信ハブ / その他ハブ / PF / 従来のホーム）', () => {
    withTab('T0')
    const cases: [string, string][] = [
      ['funds_hub', 'data-testid="funds-hub"'],
      ['other_hub', 'data-testid="other-hub"'],
      ['pf', 'data-testid="portfolio-surface'],
    ]
    for (const [surface, marker] of cases) {
      setSurface(surface)
      expect(renderToStaticMarkup(<App />), surface).toContain(marker)
    }
    setSurface('legacy_home')
    const legacy = renderToStaticMarkup(<App />)
    expect(legacy).toContain('class="app-header"')
    expect(legacy).not.toContain('data-testid="today-home"')
  })

  it('T0（面なし）は R4.1 Home。従来の header / StatusBar は出さない', () => {
    withTab('T0')
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('data-testid="today-home"')
    expect(html).not.toContain('class="app-header"')
    expect(html).toContain('u9-dock')
    expect(html).toContain('u9-sidebar')
  })
})

describe('Phase 2A: 実 store 経由の PF 面 / ハブ（配分・時刻が未算出の fresh store）', () => {
  it('PF 面: 配分未算出でも面は成立し、劣化は配分領域のみ。全体の判断不能にしない', () => {
    withTab('T0')
    setSurface('pf')
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('data-testid="portfolio-surface-unavailable"')
    expect(html).toContain('配分情報を利用できません')
    expect(html).not.toContain('判断結果を利用できません')
    expect(html).not.toContain('data-testid="decision-unavailable"')
    expect(html).toMatch(/data-testid="deployable-cash" data-unavailable="true">利用不可</)
    expect(html).not.toContain('¥0')
  })

  it('投信ハブ: 配分未算出でも 3 行が並び、値は「利用不可」（0 にしない）', () => {
    withTab('T0')
    setSurface('funds_hub')
    const html = renderToStaticMarkup(<App />)
    expect(html.match(/data-hub-link=/g)?.length).toBe(3)
    expect((html.match(/u9-hub-item__value" data-unavailable="true">利用不可</g) ?? []).length).toBe(2)
  })

  it('その他ハブ: システム欄は各データセットを個別に表示（fresh store は判断生成 / 候補データが利用不可、バージョンは 13.3）', () => {
    withTab('T0')
    setSurface('other_hub')
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('data-testid="other-hub-system"')
    expect(html).toMatch(/data-system-row="version">13\.3</)
    expect(html.match(/data-hub-link=/g)?.length).toBe(5)
  })
})

describe('ハブの到達性（レンダー結果）', () => {
  it('投信ハブ: 国内投信 / 海外投信 / 投信管理', () => {
    withTab('T0')
    setSurface('funds_hub')
    const html = renderToStaticMarkup(<App />)
    for (const t of ['国内投信', '海外投信', '投信管理']) expect(html).toContain(t)
    expect(html).toContain('ハブ自体は判断を持ちません')
  })

  it('その他ハブ: ニュース / AI委員会 / 学習・検証 / 設定 / 従来のホーム。AI委員会は最終判断ではない', () => {
    withTab('T0')
    setSurface('other_hub')
    const html = renderToStaticMarkup(<App />)
    for (const t of ['ニュース', 'AI委員会', '学習・検証', '設定', '従来のホーム']) expect(html).toContain(t)
    expect(html).toContain('AI委員会は最終判断ではありません')
  })

  it('PF 面から旧 T4（理想ポートフォリオ / 差分）へ到達できる', () => {
    withTab('T0')
    setSurface('pf')
    expect(renderToStaticMarkup(<App />)).toContain('理想ポートフォリオ / 差分')
  })
})
