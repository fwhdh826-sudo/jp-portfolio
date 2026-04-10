// ═══════════════════════════════════════════════════════════
// AssetUniverse — 全資産統合モデル v9.0
// 国内個別株 + 投信(日本株系) + 投信(海外) + ゴールド + 現金
// ═══════════════════════════════════════════════════════════

/** 保有方針（運用期間） */
export type Horizon = 'ultra_short' | 'short' | 'mid' | 'long' | 'mid_long'

/** 資産クラス */
export type AssetClass =
  | 'JP_STOCK'         // 国内個別株（中長期）
  | 'JP_TRUST'         // 投信・日本株系（超短期〜短期）
  | 'OVERSEAS_TRUST'   // 投信・海外株（中長期）
  | 'GOLD'             // ゴールド
  | 'CASH'             // 現金（通常）
  | 'CASH_RESERVE'     // 暴落待機資金
  | 'ADD_ROOM'         // 日本株追加投資枠

/** 資産クラス別の運用方針マッピング */
export const HORIZON_BY_CLASS: Record<AssetClass, Horizon> = {
  JP_STOCK: 'mid_long',
  JP_TRUST: 'ultra_short',
  OVERSEAS_TRUST: 'mid_long',
  GOLD: 'long',
  CASH: 'ultra_short',
  CASH_RESERVE: 'long',
  ADD_ROOM: 'mid_long',
}

/** 資産クラス別の表示名 */
export const CLASS_LABEL: Record<AssetClass, string> = {
  JP_STOCK: '国内個別株',
  JP_TRUST: '国内株投信',
  OVERSEAS_TRUST: '海外株投信',
  GOLD: 'ゴールド',
  CASH: '現金',
  CASH_RESERVE: '暴落待機資金',
  ADD_ROOM: '追加投資枠',
}

/** 資産クラス別の役割説明（高校生向け） */
export const CLASS_ROLE: Record<AssetClass, string> = {
  JP_STOCK: '収益成長＋分散（中長期保有）',
  JP_TRUST: '市場連動・短期売買（曜日/VI/SQ）',
  OVERSEAS_TRUST: 'グローバル分散（中長期）',
  GOLD: 'インフレ・有事ヘッジ',
  CASH: '日常資金・緊急用',
  CASH_RESERVE: '暴落時の機会投資資金',
  ADD_ROOM: '日本株追加購入枠',
}

/** 資産カテゴリのサマリー（ダッシュボード表示用） */
export interface AssetCategorySummary {
  class: AssetClass
  label: string
  role: string
  horizon: Horizon
  currentValue: number       // 現在評価額（円）
  currentRatio: number       // 現在比率（0-1）
  targetRatio: number        // 目標比率（0-1）
  targetValue: number        // 目標額（円）
  diffValue: number          // 差額（+:買い増し / -:売却）
  diffRatio: number          // 差分比率
  score: number              // 総合スコア（0-100）
  lastUpdatedAt: string | null
}

/** 全資産ユニバース（現状スナップショット） */
export interface AssetUniverse {
  totalValue: number                        // 総資産（円）
  categories: AssetCategorySummary[]        // 資産クラス別集計
  cash: number                              // 全現金（通常 + 待機）
  cashReserve: number                       // 暴落待機資金
  addRoom: number                           // 日本株追加枠
  lastUpdatedAt: string                     // 最終更新日時
}

/** スコアリング重み（運用期間別） */
export interface ScoringWeights {
  fundamental: number    // ファンダ
  market: number         // マクロ/市場
  technical: number      // テクニカル
  news: number           // ニュース
  quality: number        // クオリティ
  risk: number           // リスクペナルティ
}

/** 運用期間別の重み設定 */
export const WEIGHTS_BY_HORIZON: Record<Horizon, ScoringWeights> = {
  // 超短期: テクニカル・シグナル最重視
  ultra_short: {
    fundamental: 0.10,
    market: 0.20,
    technical: 0.35,
    news: 0.15,
    quality: 0.05,
    risk: 0.15,
  },
  // 短期
  short: {
    fundamental: 0.15,
    market: 0.20,
    technical: 0.30,
    news: 0.15,
    quality: 0.05,
    risk: 0.15,
  },
  // 中期
  mid: {
    fundamental: 0.30,
    market: 0.20,
    technical: 0.20,
    news: 0.10,
    quality: 0.05,
    risk: 0.15,
  },
  // 中長期（日本個別株のデフォルト）
  mid_long: {
    fundamental: 0.40,
    market: 0.15,
    technical: 0.15,
    news: 0.10,
    quality: 0.10,
    risk: 0.10,
  },
  // 長期
  long: {
    fundamental: 0.45,
    market: 0.10,
    technical: 0.10,
    news: 0.05,
    quality: 0.15,
    risk: 0.15,
  },
}
