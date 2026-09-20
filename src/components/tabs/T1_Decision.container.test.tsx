// UI-9I Phase 2B-1: T1 container の配線（store → view-model → view）と選択状態。
// 選択状態（表示専用ストア）を注入して、一覧 / 詳細 / 見つからない場合の切替を実 store の selector 経由で確認する。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { fixtureStockHoldings } from '../../presentation/ui9i/ui9i.fixtures'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t1Source from './T1_Decision.tsx?raw'

const mocked = vi.hoisted(() => ({ state: null as AppState | null, selected: null as string | null }))

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
vi.mock('../../store/stockSelection', () => ({
  useStockSelection: <Selected,>(selector: (s: { selectedCode: string | null; select: () => void; clear: () => void }) => Selected): Selected =>
    selector({ selectedCode: mocked.selected, select: () => {}, clear: () => {} }),
}))
// 市場全体 candidate funnel は自前で store を読む別パネル（本テストの関心外）。
vi.mock('../candidates/CandidateFunnelPanel', () => ({ CandidateFunnelPanel: () => <div data-testid="funnel-panel" /> }))

const { T1_Decision } = await import('./T1_Decision')

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

function render(selected: string | null): string {
  const { holdings, analysis } = fixtureStockHoldings()
  mocked.state = { ...BASE, holdings, analysis }
  mocked.selected = selected
  return renderToStaticMarkup(<T1_Decision />)
}

describe('T1 container', () => {
  it('選択なし → 個別株一覧（.u9 スコープ）+ funnel パネルの差し込み', () => {
    const html = render(null)
    expect(html.startsWith('<div class="u9">')).toBe(true)
    expect(html).toContain('data-testid="stocks-surface"')
    expect(html).not.toContain('data-testid="stock-detail"')
    expect(html).toContain('data-testid="funnel-panel"')
  })

  it('選択あり → 個別株詳細（同じ store の holdings / analysis から）', () => {
    const html = render('8306')
    expect(html).toContain('data-testid="stock-detail"')
    expect(html).toContain('三菱UFJフィナンシャル・グループ')
    expect(html).not.toContain('data-testid="stocks-surface"')
    expect(html).not.toContain('data-testid="funnel-panel"')
  })

  it('選択された銘柄が保有から消えている → 「銘柄データなし」+ 戻る導線（クラッシュしない）', () => {
    const html = render('0000')
    expect(html).toContain('data-testid="stock-detail-not-found"')
    expect(html).toContain('aria-label="個別株一覧に戻る"')
  })

  it('fresh store（boot・保有なし）でも一覧が成立する', () => {
    mocked.state = BASE
    mocked.selected = null
    const html = renderToStaticMarkup(<T1_Decision />)
    expect(html).toContain('保有銘柄なし')
  })

  it('この画面を離れたら選択を解除する（旧 T1 の useState と同じ寿命）', () => {
    expect(t1Source).toContain('useEffect(() => clear, [clear])')
  })
})
