// ═══════════════════════════════════════════════════════════
// UI-9I Phase 2B-1: 個別株面の「選択中の銘柄」。
//
// 旧 T1 は選択銘柄をコンポーネントの useState に持っていた（画面を離れると一覧へ戻る）。
// R4.1 では、ナビの「個別株」再タップで一覧へ戻す・他面から特定銘柄の詳細へ直接入る
// （deep link）ために、投資ロジックを持たない表示専用ストアへ持ち上げる。
// AppState には触れない（永続化・スナップショット対象外）。
// ═══════════════════════════════════════════════════════════
import { create } from 'zustand'

interface StockSelectionState {
  selectedCode: string | null
  select: (code: string) => void
  clear: () => void
}

export const useStockSelection = create<StockSelectionState>(set => ({
  selectedCode: null,
  select: code => set({ selectedCode: code }),
  clear: () => set({ selectedCode: null }),
}))
