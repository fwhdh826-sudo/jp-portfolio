// UI-9I Phase 2B-1R (P2-01): 選択中の銘柄のライフサイクルを、source 文字列ではなく実際に mount して検証する。
//   銘柄を選択 → 個別株を離れる（unmount）→ 戻る（再 mount）→ 古い詳細が残らない。
// 旧 T1 の useState と同じ寿命（画面を離れたら一覧へ戻す）を、実 useStockSelection ストアで確認する。
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { useStockSelection } from '../../store/stockSelection'
import { fixtureStockHoldings } from '../../presentation/ui9i/ui9i.fixtures'
import { withFakeDom } from '../../test/reactFakeDom'

const mocked = vi.hoisted(() => ({ state: null as AppState | null }))

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
// funnel は自前で store を読む別パネル。ここは選択のライフサイクルのみを見る
// （funnel を含む合成は T1_Decision.funnelComposition.test.tsx が実コンポーネントで検証する）。
vi.mock('../candidates/CandidateFunnelPanel', () => ({ CandidateFunnelPanel: () => null }))

const { T1_Decision } = await import('./T1_Decision')

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

function useFixtureHoldings() {
  const { holdings, analysis } = fixtureStockHoldings()
  mocked.state = { ...BASE, holdings, analysis }
}

describe('T1 選択のライフサイクル（mount / unmount）', () => {
  it('選択 → 個別株を離れる → 戻る: 古い詳細が残らず一覧に戻る', async () => {
    useFixtureHoldings()
    useStockSelection.setState({ selectedCode: '8306' })
    await withFakeDom(async mount => {
      const first = await mount(<T1_Decision />)
      expect(first.container.findByAttribute('data-testid', 'stock-detail')).toHaveLength(1)
      expect(first.container.findByAttribute('data-testid', 'stocks-surface')).toHaveLength(0)
      expect(useStockSelection.getState().selectedCode).toBe('8306')

      // 別の面へ移動 = T1 が unmount される
      await first.unmount()
      expect(useStockSelection.getState().selectedCode).toBeNull()

      // 個別株へ戻る
      const second = await mount(<T1_Decision />)
      expect(second.container.findByAttribute('data-testid', 'stocks-surface')).toHaveLength(1)
      expect(second.container.findByAttribute('data-testid', 'stock-detail')).toHaveLength(0)
      expect(second.container.textContent).toContain('保有銘柄')
      await second.unmount()
    })
  })

  it('選択なしで mount / unmount しても選択は null のまま（副作用なし）', async () => {
    useFixtureHoldings()
    useStockSelection.setState({ selectedCode: null })
    await withFakeDom(async mount => {
      const view = await mount(<T1_Decision />)
      expect(view.container.findByAttribute('data-testid', 'stocks-surface')).toHaveLength(1)
      await view.unmount()
      expect(useStockSelection.getState().selectedCode).toBeNull()
    })
  })
})
