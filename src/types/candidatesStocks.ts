// ═══════════════════════════════════════════════════════════
// P5-B002a: candidates_stocks.json 型定義（observability-only）
// 市場公開情報のみを扱う。保有実額・現金実額・口座種別・CSV取込値・
// score・action・提案金額は一切含めない（P4.5-A010/A010-1a方針）。
// ═══════════════════════════════════════════════════════════

export type StockCandidateDataStatus = 'ok' | 'partial'

export interface StockCandidateItem {
  code: string
  name: string
  sector: string
  price: number | null
  per: number | null
  pbr: number | null
  roe: number | null
  dividendYield: number | null
  sigma252d: number | null
  mom3m: number | null
  screenReasons: string[]
  dataStatus: StockCandidateDataStatus
}

export interface CandidatesStocksData {
  schemaVersion: 'candidates-stocks-1'
  updatedAt: string
  sourceUpdatedAt: string | null
  staleThresholdHours: number
  _meta: {
    kind: 'candidates_stocks'
    source: string
    not_for_trading: true
    universe: string
    note: string
    // P5-B004b: publish cap外の失敗・truncationをstatusに混ぜないための
    // 内訳。既存consumerには未使用のoptional追加フィールド。
    counts?: {
      universeCount: number
      publishedCount: number
      truncatedCount: number
      failedTotalCount: number
    }
  }
  candidates: StockCandidateItem[]
  missing: string[]
  status: 'ok' | 'partial' | 'empty'
}
