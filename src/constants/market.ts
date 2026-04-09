import type { Market } from '../types'

// 静的fallback（market.jsonが取得できない場合）
export const STATIC_MARKET: Market = {
  last_updated: '2026-04-10 00:00',
  nikkei: 56308,
  nikkeiChg: 2878,
  nikkeiChgPct: 5.39,
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
