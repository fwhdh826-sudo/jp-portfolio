import type { Holding } from '../types'

// P0-PRIVACY-HOTFIX: 個人の実保有銘柄・評価額・取得日を含む静的fallbackは
// 公開bundleに含めない。CSV full-sync / localStorage / snapshotが保有状態の
// source of truthであり、未取込端末では保有を仮定しない（空配列が安全）。
export const INITIAL_HOLDINGS: Holding[] = []
