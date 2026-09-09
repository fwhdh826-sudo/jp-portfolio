// ═══════════════════════════════════════════════════════════
// P5-B002a: candidates_stocks.json 型定義（observability-only）
// 市場公開情報のみを扱う。保有実額・現金実額・口座種別・CSV取込値・
// score・action・提案金額は一切含めない（P4.5-A010/A010-1a方針）。
// ═══════════════════════════════════════════════════════════

export type StockCandidateDataStatus = 'ok' | 'partial'

// P5-B005-B4-A: Candidate Funnel fundamental-source plumbing（Phase A）。
// null 値を等価に見せず実際の authority state を露出する。
// fallback（stale/前回run再利用）は Phase A では有効な authority ではない。
export type StockCandidateFundamentalsStatus =
  | 'available'
  | 'partial'
  | 'missing'
  | 'stale'
  | 'invalid'

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
  // P5-B005-B4-A: backward-compatible OPTIONAL fundamental shadow field。
  // annual reported YoY（(FYn0 - FYn1) / FYn1 * 100、FYn1>0 のときのみ）。
  // growth scoring は無効（reserved zero-weight）—— observability 専用。
  profitGrowth?: number | null
  epsGrowth?: number | null
  // FY0 の財務諸表 period-end（ISO date）。dataset の sourceUpdatedAt とは
  // 別の時計（財務報告 as-of）。
  fiscalPeriodEnd?: string | null
  fundamentalsStatus?: StockCandidateFundamentalsStatus
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
    // P5-B004e-2: workflow current-run証明。production build時のみ付与。
    runToken?: string
    pipelineContract?: 'jpx_whole_market_candidates_v1'
    pipelinePath?: 'normal' | 'cache_fallback' | 'seed_fallback'
    // P5-B004b: publish cap外の失敗・truncationをstatusに混ぜないための
    // 内訳。既存consumerには未使用のoptional追加フィールド。
    counts?: {
      universeCount: number
      publishedCount: number
      truncatedCount: number
      failedTotalCount: number
    }
    // P5-B005-B4-A: dataset-level fundamentals authority/coverage meta。
    // fundamentals shadow channel を実行した production run のみ付与される。
    // raw financial statement は含まない。
    fundamentals?: {
      source: string
      fetchedAt: string
      statementMaxAgeDays: 456
      canonicalPeField?: 'per'
      growthScoringStatus?: 'reserved_zero_weight'
      coverage: {
        present: number
        stale: number
        missing: number
        negativeBase: number
        splitGuardBlocked: number
        irregularPeriod: number
        rowLabelMissing: number
      }
      aborted: boolean
      abortReason: string | null
    }
    // P5-B004d: whole-market universe接続時のみ付与されるprovenance。
    // seed_list_v1 default providerのままの場合は存在しない
    // （既存consumerには未使用のoptional追加フィールド）。
    universeProvenance?: {
      pipelinePath?: 'normal' | 'cache_fallback' | 'seed_fallback'
      jpxSource?: string
      jpxFallbackUsed?: boolean
      jpxEligibleCount?: number
      shortlistId?: string
      shortlistCount?: number
      shortlistSuccessRatio?: number
      shortlistFallbackUsed?: boolean
      shortlistFallbackReason?: string | null
      shortlistBypassSeedListV1?: boolean
      sectorCapRelaxed?: boolean
      sectorCapRelaxedCount?: number
    }
  }
  candidates: StockCandidateItem[]
  missing: string[]
  status: 'ok' | 'partial' | 'empty'
}
