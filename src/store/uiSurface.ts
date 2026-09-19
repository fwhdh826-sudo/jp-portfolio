// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: UI 面（ハブ / 判断の詳細 / PF 面 / 従来ホーム）の選択状態。
//
// activeTab（AppState）は既存 10 画面の葉画面の唯一の権限として温存する。
// ここは「葉画面ではない UI 面」を重ねるだけの、投資ロジックを持たない
// 表示専用ストア。AppState には触れない（永続化・スナップショット対象外）。
// ═══════════════════════════════════════════════════════════
import { create } from 'zustand'
import type { UiSurface } from '../presentation/ui9i/navigation'

interface UiSurfaceState {
  surface: UiSurface | null
  openSurface: (surface: UiSurface) => void
  clearSurface: () => void
}

export const useUiSurface = create<UiSurfaceState>(set => ({
  surface: null,
  openSurface: surface => set({ surface }),
  clearSurface: () => set({ surface: null }),
}))
