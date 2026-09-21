// UI-9I Phase 2B-2: 旧ホーム唯一機能だった Phase 8 観察の行き先は T8（学習・検証）。
//   その他 → 学習・検証 → Phase 8 観察 が実際の onClick 経路で到達でき、
//   学習データ（learning.outcomes）が空でも Phase 8 は到達可能であること、
//   T8 の KPI と混在しないこと、旧ホームが Phase 8 を所有しないことを検証する。
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, LearningState, TabId } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import type { NavTarget } from '../../presentation/ui9i/navigation'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t0Source from '../tabs/T0_Home.tsx?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t8Source from '../tabs/T8_Learning.tsx?raw'

const mocked = vi.hoisted(() => ({
  state: null as AppState | null,
  surface: null as string | null,
  goTo: null as null | ((t: unknown) => void),
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mocked.state === null) throw new Error('store fixture is not initialized')
      return selector(mocked.state)
    },
  }
})
vi.mock('../../store/uiSurface', () => ({
  useUiSurface: <Selected,>(selector: (s: { surface: string | null; openSurface: () => void; clearSurface: () => void }) => Selected): Selected =>
    selector({ surface: mocked.surface, openSurface: () => {}, clearSurface: () => {} }),
}))
vi.mock('./useGoTo', async importOriginal => {
  const actual = await importOriginal<typeof import('./useGoTo')>()
  return { ...actual, useGoTo: () => (t: unknown) => mocked.goTo?.(t) }
})

const { UserDockNav } = await import('./UserNav')
const { OtherHub } = await import('./SurfaceRouter')
const { App } = await import('../../App')
const { applyNavTarget } = await import('./useGoTo')
const { useStockSelection } = await import('../../store/stockSelection')

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

function collect(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { node.forEach(n => collect(n, pred, out)); return out }
  if (!isValidElement(node)) return out
  const el = node as ReactElement<Record<string, unknown>>
  if (pred(el)) out.push(el)
  if (typeof el.type === 'function') collect((el.type as (p: unknown) => ReactNode)(el.props), pred, out)
  else collect(el.props.children as ReactNode, pred, out)
  return out
}

const textOf = (el: ReactElement<Record<string, unknown>>): string => {
  const parts: string[] = []
  const walk = (n: ReactNode) => {
    if (typeof n === 'string') parts.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (isValidElement(n)) { if ((n.props as Record<string, unknown>)['aria-hidden'] !== 'true') walk((n.props as { children?: ReactNode }).children) }
  }
  walk(el.props.children as ReactNode)
  return parts.join('')
}

type Current = { tab: TabId; surface: string | null }

/** 実際の button の onClick を呼び、goTo に渡った NavTarget を本物の applyNavTarget で activeTab / 面へ反映する。 */
function click(root: ReactElement, pred: (el: ReactElement<Record<string, unknown>>) => boolean, current: Current): NavTarget[] {
  const calls: NavTarget[] = []
  mocked.goTo = t => {
    calls.push(t as NavTarget)
    applyNavTarget(t as NavTarget, {
      setTab: tab => { current.tab = tab },
      openSurface: s => { current.surface = s },
      clearSurface: () => { current.surface = null },
      clearStockSelection: () => useStockSelection.getState().clear(),
    })
  }
  const buttons = collect(root, el => el.type === 'button' && pred(el))
  expect(buttons).toHaveLength(1)
  ;(buttons[0].props.onClick as () => void)()
  return calls
}

function renderApp(current: Current, overrides: Partial<AppState> = {}): string {
  mocked.state = { ...BASE, ...overrides, activeTab: current.tab }
  mocked.surface = current.surface
  return renderToStaticMarkup(<App />)
}

function phase8Section(html: string): string {
  const m = html.match(/<section[^>]*data-testid="t8-phase8-section"[^>]*>([\s\S]*?)<\/section>/)
  expect(m, 'T8 に Phase 8 観察セクションがある').not.toBeNull()
  return m![1]
}

const EMPTY_OUTCOMES_LEARNING: LearningState = {
  lastUpdated: '2026-09-20T00:00:00.000Z',
  baselineCount: 0,
  baseline: [],
  outcomes: [],
  summary: {
    total: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0,
    byDecision: {
      BUY: { count: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0 },
      HOLD: { count: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0 },
      SELL: { count: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0 },
    },
    driftSignals: [],
  },
  suggestedWeights: BASE.learning?.suggestedWeights ?? ({ fundamental: 0.3, market: 0.2, technical: 0.2, news: 0.15, quality: 0.1, risk: 0.15 } as unknown as LearningState['suggestedWeights']),
}

const POPULATED_LEARNING: LearningState = {
  ...EMPTY_OUTCOMES_LEARNING,
  outcomes: [
    { code: '8306', predictedAt: '2026-09-01T00:00:00.000Z', evaluatedAt: '2026-09-08T00:00:00.000Z', decision: 'BUY', score: 70, confidence: 0.6, prevPnlPct: 0, currPnlPct: 2, deltaPnlPct: 2, reward: 0.4, result: 'win', regime: 'bull' },
  ],
  summary: {
    ...EMPTY_OUTCOMES_LEARNING.summary,
    total: 1, wins: 1, accuracy: 100, avgReward: 0.4,
    byDecision: { ...EMPTY_OUTCOMES_LEARNING.summary.byDecision, BUY: { count: 1, wins: 1, losses: 0, flats: 0, accuracy: 100, avgReward: 0.4 } },
  },
}

beforeEach(() => {
  mocked.state = { ...BASE, activeTab: 'T0' }
  mocked.surface = null
  useStockSelection.getState().clear()
})

describe('その他 → 学習・検証 → Phase 8 観察（実際の onClick 経路）', () => {
  it('下部ナビ「その他」→ その他ハブ →「学習・検証」→ T8 → Phase 8 観察が表示される', () => {
    const current: Current = { tab: 'T0', surface: null }

    const toOther = click(<UserDockNav />, el => textOf(el) === 'その他', current)
    expect(toOther).toEqual([{ tab: null, surface: 'other_hub' }])
    expect(renderApp(current)).toContain('data-testid="other-hub"')

    const toLearning = click(<OtherHub />, el => el.props['data-hub-link'] === 'learning', current)
    expect(toLearning).toEqual([{ tab: 'T8', surface: null }])
    expect(current).toEqual({ tab: 'T8', surface: null })

    const html = renderApp(current)
    expect(html).toContain('data-testid="t8-phase8-section"')
    const section = phase8Section(html)
    expect(section).toContain('Phase 8 観察')
    // 実際の Phase8SummaryCard が mount されている（loader 未解決の SSR では loading 表示）
    expect(section).toContain('Phase 8 観察値（partial-real / hybrid）')
    expect(section).toContain('戦略・探索系の観察値です。取引判断には使用しません。')
  })

  it('その他ハブの行に Phase 8 専用の新規エントリはない（T8 が行き先）', () => {
    const current: Current = { tab: 'T0', surface: 'other_hub' }
    const html = renderApp(current)
    expect(html).toContain('data-hub-link="learning"')
    expect(html).not.toMatch(/data-hub-link="[^"]*phase8[^"]*"/i)
  })
})

describe('学習データが空でも Phase 8 は T8 で到達できる', () => {
  it('learning === null（データなし状態）', () => {
    const html = renderApp({ tab: 'T8', surface: null }, { learning: null })
    expect(html).toContain('まだ学習データがありません')
    expect(html).not.toContain('総合精度')
    expect(phase8Section(html)).toContain('Phase 8 観察値（partial-real / hybrid）')
  })

  it('learning.outcomes が空配列', () => {
    const html = renderApp({ tab: 'T8', surface: null }, { learning: EMPTY_OUTCOMES_LEARNING })
    expect(html).toContain('まだ学習データがありません')
    expect(html).not.toContain('総合精度')
    expect(phase8Section(html)).toContain('Phase 8 観察値（partial-real / hybrid）')
  })

  it('T8 のソースでは Phase 8 が学習データ条件（!isEmpty && learning）の外にある', () => {
    const gate = (t8Source as string).indexOf('{!isEmpty && learning && (')
    const phase8 = (t8Source as string).indexOf('<Phase8SummaryCard />')
    expect(gate).toBeGreaterThan(-1)
    expect(phase8).toBeGreaterThan(gate)
    // 学習データ条件ブロックを閉じる `</>\n      )}` より後ろで Phase 8 を描画している
    const gateClose = (t8Source as string).indexOf('</>\n      )}', gate)
    expect(gateClose).toBeGreaterThan(gate)
    expect(phase8).toBeGreaterThan(gateClose)
  })
})

describe('Phase 8 は T8 の KPI と混在しない', () => {
  it('学習データあり: KPI は Phase 8 セクションより前、Phase 8 セクションに KPI 語を含まない', () => {
    const html = renderApp({ tab: 'T8', surface: null }, { learning: POPULATED_LEARNING })
    const kpiAt = html.indexOf('総合精度')
    const sectionAt = html.indexOf('data-testid="t8-phase8-section"')
    expect(kpiAt).toBeGreaterThan(-1)
    expect(sectionAt).toBeGreaterThan(kpiAt)
    const section = phase8Section(html)
    for (const kpi of ['総合精度', 'BUY精度', 'SELL精度', '重み提案', '予測 vs 実績']) {
      expect(section, kpi).not.toContain(kpi)
    }
  })

  it('見出しと補足文は中立語（おすすめ / 予測 / 売買判断 / AI判断 / 期待収益 を使わない）', () => {
    const html = renderApp({ tab: 'T8', surface: null }, { learning: null })
    const heading = html.match(/<h2 id="t8-phase8-heading"[^>]*>([^<]*)<\/h2>/)?.[1] ?? ''
    expect(heading).toBe('Phase 8 観察')
    for (const word of ['おすすめ', '予測', '売買判断', 'AI判断', '期待収益']) {
      expect(heading).not.toContain(word)
      expect('戦略・探索系の観察値です。取引判断には使用しません。').not.toContain(word)
    }
  })
})

describe('旧ホームは Phase 8 を所有しない（T8 が唯一の行き先）', () => {
  it('T0_Home は Phase8SummaryCard を import / 描画しない。T8 は 1 か所だけ描画する', () => {
    expect(t0Source as string).not.toContain('Phase8SummaryCard')
    expect(t0Source as string).not.toContain('home-phase8')
    expect((t8Source as string).match(/<Phase8SummaryCard \/>/g)).toHaveLength(1)
  })
})
