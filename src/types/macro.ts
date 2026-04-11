// ═══════════════════════════════════════════════════════════
// Macro Data — v9.0
// 金利/為替/VIX/VI/指数/コモディティ
// ═══════════════════════════════════════════════════════════

export interface MacroSnapshot {
  last_updated: string

  // 金利
  jgb10y: number          // 日本国債10年利回り（%）
  ust10y: number          // 米国債10年利回り（%）

  // 為替
  usdjpy: number          // ドル円
  usdjpyChgPct: number

  // 米国株
  sp500: number
  sp500ChgPct: number
  nasdaq: number
  nasdaqChgPct: number

  // ボラティリティ
  vix: number             // 米VIX
  vixChg: number          // 絶対値変化
  nikkeiVI: number        // 日経225 VI
  nikkeiVIChg: number

  // コモディティ
  gold: number            // 金価格（USD/oz）
  goldChgPct: number
  nyCrude: number         // NY原油（USD/バレル）
  nyCrudeChgPct: number
}

/** SQ（特別清算指数）カレンダー */
export interface SQEvent {
  date: string            // YYYY-MM-DD
  type: 'monthly' | 'quarterly'   // 月次SQ / 先物SQ（3,6,9,12月）
  dayUntil: number        // SQまでの営業日
}

export interface SQCalendar {
  last_updated: string
  events: SQEvent[]       // 今後のSQ（未来のみ）
  nextSQ: SQEvent | null
}

/** 信用残データ（JPX週次） */
export interface MarginData {
  last_updated: string
  weekOf: string          // 週末日
  buyingMargin: number    // 信用買残（億円）
  sellingMargin: number   // 信用売残（億円）
  ratio: number           // 貸借倍率
  buyingChg: number       // 前週比
  sellingChg: number
}

/** 資金フロー（外国人・個人・機関） */
export interface FlowData {
  last_updated: string
  weekOf: string
  foreignNet: number      // 外国人投資家 差引売買代金（億円）
  individualNet: number
  institutionalNet: number
  trust5w: number         // 信託銀行5週合計
}
