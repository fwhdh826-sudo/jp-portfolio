// UI-9I Phase 1: ユーザー向けナビゲーションの実行（AppState.activeTab と UI 面の橋渡し）。
// activeTab は葉画面の唯一の権限。葉画面へ行くときは必ず UI 面を解除してから setTab する。
import { useCallback } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useUiSurface } from '../../store/uiSurface'
import type { NavTarget, UiSurface } from '../../presentation/ui9i/navigation'
import type { TabId } from '../../types'

export interface NavActions {
  setTab: (tab: TabId) => void
  openSurface: (surface: UiSurface) => void
  clearSurface: () => void
}

/** UI 面へ → openSurface（activeTab は不変）/ 葉画面へ → 面を解除して setTab。 */
export function applyNavTarget(target: NavTarget, actions: NavActions): void {
  if (target.surface !== null) {
    actions.openSurface(target.surface)
    return
  }
  actions.clearSurface()
  if (target.tab !== null) actions.setTab(target.tab)
}

export function useGoTo(): (target: NavTarget) => void {
  const setTab = useAppStore(s => s.setTab)
  const openSurface = useUiSurface(s => s.openSurface)
  const clearSurface = useUiSurface(s => s.clearSurface)
  return useCallback((target: NavTarget) => {
    applyNavTarget(target, { setTab, openSurface, clearSurface })
  }, [setTab, openSurface, clearSurface])
}
