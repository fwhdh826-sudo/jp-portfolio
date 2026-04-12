import type { Market } from '../types'

// 静的fallback（market.jsonが取得できない場合）
export const STATIC_MARKET: Market = {
  last_updated: '2026-04-10 00:00',
  nikkei: 56308,
  nikkeiChg: 2878,
  nikkeiChgPct: 5.39,
  nikkeiFutures: 56390,
  nikkeiFuturesChg: 2960,
  nikkeiFuturesChgPct: 5.54,
  ma5: 54500,
  ma25: 53000,
  ma75: 51000,
  rsi14: 60,
  macd: 'golden',
  volume: 'high',
  bollUpper: 58000,
  bollMid: 53000,
  bollLower: 48000,
  regime: 'bull',
  boj: '0.50%',
  bojNext: '0.75%観測',
  vix: 19.9,
}

// セクターグループ（相関推定用）
export const SECTOR_GROUPS: Record<string, string[]> = {
  '三菱G':    ['8306','8593','8058','7011','5711'],
  '防衛重工': ['7011','7012'],
  'ゲーム':   ['9697','7974'],
  '資源':     ['1605','5016'],
  'IT通信':   ['6098','9433','9418'],
}

export const RF = 0.005  // 無リスク金利

// スコアリング重み（機関投資家別）
export const INST_WEIGHTS = {
  JAPAN_STOCK: {
    gs_funda:    0.28,
    ms_tech:     0.18,
    twosigma:    0.18,
    bridgewater: 0.20,
    citadel:     0.08,
    renaissance: 0.08,
  },
} as const

// ═══════════════════════════════════════════════════════════
// v9.0 — 全資産統合の初期値（運用方針に基づく）
// ═══════════════════════════════════════════════════════════

/** 現金初期値（円）— コア待機500万円 + 可変待機200万円を運用で調整 */
export const INITIAL_CASH = 5_000_000          // 通常現金（可変待機を含む）
export const INITIAL_CASH_RESERVE = 5_000_000  // 暴落待機コア資金
export const INITIAL_ADD_ROOM = 4_000_000      // 日本株追加枠

/** 日本株個別の上限（運用方針） */
export const JP_STOCK_MAX_VALUE = 8_000_000

/** 売却可能銘柄コード（3ヶ月ルールを満たす） */
export const SELLABLE_CODES = new Set(['8306', '4661', '9697', '6098'])
// 三菱UFJ / オリエンタルランド / カプコン / リクルートHD

/** 理想ポートフォリオ比率（中立レジーム時） */
export const TARGET_ALLOCATION_NEUTRAL = {
  JP_STOCK: 0.15,         // 個別株 15%（中長期）
  JP_TRUST: 0.05,         // 日本株投信 5%（短期売買）
  OVERSEAS_TRUST: 0.55,   // 海外投信 55%（中長期）
  GOLD: 0.05,             // ゴールド 5%
  CASH: 0.08,             // 現金 8%
  CASH_RESERVE: 0.12,     // 暴落待機 12%
} as const

/** 強気レジーム時（株式比率を上げる） */
export const TARGET_ALLOCATION_BULL = {
  JP_STOCK: 0.20,
  JP_TRUST: 0.07,
  OVERSEAS_TRUST: 0.62,
  GOLD: 0.03,
  CASH: 0.04,
  CASH_RESERVE: 0.04,
} as const

/** 弱気レジーム時（現金比率を上げる） */
export const TARGET_ALLOCATION_BEAR = {
  JP_STOCK: 0.08,
  JP_TRUST: 0.02,
  OVERSEAS_TRUST: 0.38,
  GOLD: 0.10,
  CASH: 0.17,
  CASH_RESERVE: 0.25,
} as const

/** VIX閾値 */
export const VIX_CALM = 15      // 平穏
export const VIX_NORMAL = 20    // 通常
export const VIX_WARNING = 25   // 警戒
export const VIX_PANIC = 30     // 暴落

/** Nikkei 225 VI 閾値 */
export const NIKKEI_VI_CALM = 18
export const NIKKEI_VI_WARNING = 25
export const NIKKEI_VI_PANIC = 35

/** SQ前後の取引抑制日数（SQ前2営業日・後1営業日は短期売買抑制） */
export const SQ_BUFFER_DAYS_BEFORE = 2
export const SQ_BUFFER_DAYS_AFTER = 1
