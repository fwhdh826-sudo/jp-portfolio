import { create } from 'zustand'
import type { AppState, Holding, Trust, TabId, StockScoreRecord, FundPhase7Map, OfficialDecision, OfficialDecisionItem, OfficialDecisionAction, PortfolioPolicy, CashAssumptions, CsvImportProvenance, CsvSyncSummary, SystemState } from '../types'
import { DEFAULT_PORTFOLIO_POLICY, DEFAULT_CASH_ASSUMPTIONS } from '../types'
import { INITIAL_HOLDINGS } from '../constants/holdings'
import { INITIAL_TRUST } from '../constants/trust'
import {
  STATIC_MARKET,
  INITIAL_CASH,
  INITIAL_CASH_RESERVE,
  INITIAL_ADD_ROOM,
} from '../constants/market'
import { refreshAllData as loadPublishedData, DEFAULT_CANDIDATES_NEWS_DATA, DEFAULT_CANDIDATES_STOCKS_DATA, DEFAULT_REGIME_STATE, DEFAULT_SAFE_MODE_SNAPSHOT, DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, DEFAULT_TIER_A_ALERTS_SNAPSHOT } from '../services/loadStaticData'
import { computeAnalysis, calcPortfolioMetrics } from '../domain/analysis/computeAnalysis'
import {
  importPortfolioCsv,
  buildNewHoldingFromCsvRow,
  STOCK_REMOVAL_RATIO_THRESHOLD,
  STOCK_REMOVAL_ABSOLUTE_CAP,
  type TrustSyncReport,
} from '../domain/csv/importPortfolioCsv'
import {
  persistPortfolio,
  restorePortfolio,
  persistTrust,
  restoreTrust,
  persistLearning,
  restoreLearning,
  persistCsvImportedAt,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  restoreCsvImportGeneration,
  restoreCsvImportGenerationFromRaw,
  persistCsvImportTransaction,
  readCsvImportCanonicalRaw,
  ownsCsvImportCanonicalBytes,
  rollbackCsvImportTransaction,
  CsvImportCanonicalConflictError,
  CsvImportPersistenceError,
  persistPortfolioPolicy,
  restorePortfolioPolicy,
  persistCashAssumptions,
  restoreCashAssumptions,
  getPortfolioStorageFreshness,
  getTrustStorageFreshness,
} from './persist'
import { evaluateCsvImportMonotonicity } from '../domain/csv/csvProvenance'
import { buildAssetUniverse, checkNoTrade } from '../domain/optimization/idealAllocation'
import { updatePerformanceTracker } from '../domain/learning/performanceTracker'
import { buildTrustPortfolioPlan } from '../domain/optimization/trustPortfolio'
import { buildZeroBasePlan } from '../domain/optimization/zeroBase'
import { buildStockPortfolioPlan } from '../domain/optimization/stockPortfolio'
import { buildCommitteeDecision } from '../domain/analysis/committeeDecision'
import { selectMarketDataQuality, selectEffectiveCashAssumptions, selectEffectiveSafeModeActive, selectCashAssumptionsFreshness } from './selectors'
import { buildCandidateUniverse, scoreCandidates, buildStockCandidatePlan, computeJpStockHeadroom } from '../domain/candidates'
import type { CandidateItem, StockCandidateItem } from '../domain/candidates'
import { computeRoleExposureByRole } from '../domain/candidates/roleExposure'
import {
  stageTrustExecutionFromCsvSync,
  captureTrustShortAnalysisInput,
  captureTrustShortPortfolioBaseline,
  getTrustShortReadDependencyFingerprint,
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
  recordTrustShortDecision,
  restoreTrustShortAnalysisInput,
  type TrustShortAnalysisInput,
  type TrustShortPortfolioBaseline,
} from '../domain/learning/trustShortTracker'
import { buildExportableCashAssumptions } from '../utils/cashAssumptionsTransfer'
import {
  serializePortfolioSnapshotExport,
  parsePortfolioSnapshotImport,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2,
  type PortfolioSnapshotHolding,
} from '../utils/portfolioSnapshotTransfer'

// ── アクション型 ─────────────────────────────────────────────
interface AppActions {
  // 起動時初期化
  initialize: () => Promise<void>
  // 全データ再取得 → 全再計算 → Store一括更新
  refreshAllData: () => Promise<void>
  // CSV取込 → 即時再分析
  importCsv: (file: File, options?: CsvImportOptions) => Promise<CsvImportResult>
  // タブ切替
  setTab: (tab: TabId) => void
  // holding手動更新（score等）
  updateHolding: (code: string, patch: Partial<Holding>) => void
  // trust手動更新
  updateTrust: (id: string, patch: Partial<Trust>) => void
  // P4-A47: PortfolioPolicy更新（localStorage永続化込み）
  setPortfolioPolicy: (policy: PortfolioPolicy) => void
  // P4.5-A002: 資金前提の手動入力を保存（総額として置き換え、CSV/既定値とは加算しない）
  setCashAssumptions: (input: { cashDeposits: number; standbyFunds: number }) => void
  // P4.5-A002: 手動overrideを解除し、既定値（CSV/JSON由来があればそれ、無ければconstants）へ戻す
  clearCashAssumptionsOverride: () => void
  // P4.5-A009: export/importで検証済みの値をimportする（manualUpdatedAtはimport元をそのまま引き継ぐ）
  importCashAssumptions: (input: { cashDeposits: number; standbyFunds: number; manualUpdatedAt: string | null }) => void
  // P4.5-A012b: 保有株・投信・現金前提・portfolioPolicyのportfolio snapshotをexport（表示専用の文字列を返すだけ。保存・public出力はしない）
  exportPortfolioSnapshot: () => string
  // P4.5-A012b: 他端末でexportしたportfolio snapshotをimportする（未知のholding code/trust idが含まれる場合は全体rejectしstore/localStorageを変更しない）
  // P4.5-A013-T7: v2はunknown trust idをsilent ignoreせずskip+warningとして
  // 呼び出し側へ返す（skippedTrustIds）。全体rejectはしない（他の有効な変更が
  // 巻き添えでrejectされてしまうことを避けるため。詳細はimplementationコメント参照）。
  importPortfolioSnapshot: (raw: string) =>
    { ok: true; skippedTrustIds?: string[] } | { ok: false; error: string }
}

export interface CsvImportOptions {
  /** Weak/unknown source provenance may proceed only after an explicit user confirmation. */
  confirmUnknownProvenance?: boolean
}

export type CsvImportErrorCode =
  | 'FILE_READ_ERROR'
  | 'PARSE_ERROR'
  | 'NO_VALID_ROWS'
  | 'FULL_SYNC_GUARD_REJECTED'
  | 'ANALYSIS_ERROR'
  | 'OFFICIAL_DECISION_ERROR'
  | 'PERSISTENCE_ERROR'
  | 'IMPORT_CONFLICT'
  | 'IMPORT_IN_PROGRESS'
  | 'STALE_CSV'
  | 'CSV_PROVENANCE_CONFLICT'
  | 'CSV_PROVENANCE_UNKNOWN'
  | 'UNKNOWN_ERROR'

export type CsvImportResult =
  | {
      ok: true
      code: 'SUCCESS' | 'DUPLICATE_CSV'
      message: string
      imported: {
        stock: { updated: number; added: number; removed: number }
        trust: { updated: number; reheld: number; zeroed: number; unknown: number; ambiguous: number }
      }
      warnings: string[]
      analysisCommitted: boolean
      officialDecisionCommitted: boolean
      persistence: { status: 'committed' | 'not_attempted' }
      importedAt: string
      provenance: CsvImportProvenance
    }
  | {
      ok: false
      code: CsvImportErrorCode
      message: string
      warnings: string[]
      analysisCommitted: false
      officialDecisionCommitted: false
      persistence: { status: 'not_attempted' | 'rolled_back' | 'rollback_failed' | 'ownership_lost' }
    }

class OfficialDecisionGenerationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'OfficialDecisionGenerationError'
  }
}

function csvImportFailure(
  code: CsvImportErrorCode,
  message: string,
  persistence: 'not_attempted' | 'rolled_back' | 'rollback_failed' | 'ownership_lost' = 'not_attempted',
): CsvImportResult {
  return {
    ok: false,
    code,
    message,
    warnings: [],
    analysisCommitted: false,
    officialDecisionCommitted: false,
    persistence: { status: persistence },
  }
}

function classifyCsvParseFailure(error: unknown): CsvImportResult {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('ファイル読み込みエラー')) {
    return csvImportFailure('FILE_READ_ERROR', 'CSVファイルを読み込めませんでした。ファイルを確認して再試行してください。')
  }
  if (message.includes('有効な行が見つかりませんでした')) {
    return csvImportFailure('NO_VALID_ROWS', message)
  }
  if (
    message.includes('取込を中断しました') ||
    message.includes('個別株の保有行が見つかりませんでした')
  ) {
    return csvImportFailure('FULL_SYNC_GUARD_REJECTED', message)
  }
  return csvImportFailure('PARSE_ERROR', message || 'CSVを解析できませんでした。')
}

type CsvImportTransactionPhase =
  | 'READING'
  | 'STAGING'
  | 'ANALYZING'
  | 'PREPARED'
  | 'PERSISTING'
  | 'COMMITTED'
  | 'PUBLISHED'

interface CsvImportTransaction {
  token: symbol
  phase: CsvImportTransactionPhase
  analysisNow: number
  initialFingerprint: string
  trackerSnapshot: TrustShortAnalysisInput | null
  trackerPortfolioBaseline: TrustShortPortfolioBaseline | null
  canonicalPreviousRaw: string | null
}

let activeCsvImportTransaction: CsvImportTransaction | null = null

function setCsvImportTransactionPhase(
  transaction: CsvImportTransaction,
  phase: CsvImportTransactionPhase,
): void {
  if (activeCsvImportTransaction?.token !== transaction.token) {
    throw new Error('CSV import transaction owner was lost')
  }
  transaction.phase = phase
}

function isCsvImportCommitCriticalSection(): boolean {
  const phase = activeCsvImportTransaction?.phase
  return phase === 'PERSISTING' || phase === 'COMMITTED' || phase === 'PUBLISHED'
}

function reportRejectedReentrantMutation(source: string): void {
  try { console.warn(`[useAppStore] rejected synchronous mutation during CSV commit: ${source}`) } catch { /* diagnostic sink */ }
}

/**
 * runFullAnalysis / strict officialDecision が読むmutable inputだけを安定化して比較する。
 * status/errorや既存derived outputは除外し、関連timestamp/source metadataは含める。
 */
export function buildPortfolioAnalysisFingerprint(
  state: AppState,
  trackerFingerprint = getTrustShortReadDependencyFingerprint(),
): string {
  const serialize = (name: string, value: unknown) => {
    try { return `${name}:${JSON.stringify(value)}` }
    catch { return `${name}:<unreadable>` }
  }
  return [
    serialize('holdings', state.holdings),
    serialize('trust', state.trust),
    serialize('market', state.market),
    serialize('correlation', state.correlation),
    serialize('news', state.news),
    serialize('learning', state.learning),
    serialize('macro', state.macro),
    serialize('sqCalendar', state.sqCalendar),
    serialize('margin', state.margin),
    serialize('flows', state.flows),
    serialize('cash', state.cash),
    serialize('cashReserve', state.cashReserve),
    serialize('addRoom', state.addRoom),
    serialize('cashAssumptions', state.cashAssumptions),
    serialize('portfolioPolicy', state.portfolioPolicy),
    serialize('candidatesNews', state.candidatesNews),
    serialize('candidatesStocks', state.candidatesStocks),
    serialize('regimeState', state.regimeState),
    serialize('safeMode', state.safeMode),
    serialize('csvLastImportedAt', state.system.csvLastImportedAt),
    serialize('csvImportProvenance', state.system.csvImportProvenance ?? null),
    serialize('dataSourceStatus', state.system.dataSourceStatus),
    serialize('dataTimestamps', state.system.dataTimestamps),
    serialize('trustShortTracker', trackerFingerprint),
  ].join('|')
}

interface HoldingsSnapshotLike {
  holdings: Array<{
    code: string
    eval?: number
    pnlPct?: number
    currentPrice?: number
    price?: number
    purchase_date?: string
  }>
}

export function applyHoldingsSnapshot(
  holdings: Holding[],
  snapshot: HoldingsSnapshotLike | null | undefined,
): Holding[] {
  if (!snapshot?.holdings || snapshot.holdings.length === 0) return holdings
  const byCode = new Map(snapshot.holdings.map(item => [item.code, item]))

  return holdings.map(holding => {
    const row = byCode.get(holding.code)
    if (!row) return holding

    const evalValue = typeof row.eval === 'number' && row.eval > 0 ? row.eval : holding.eval
    const pnlPctValue = typeof row.pnlPct === 'number' ? row.pnlPct : holding.pnlPct
    const priceValue = row.currentPrice ?? row.price

    return {
      ...holding,
      eval: evalValue,
      pnlPct: pnlPctValue,
      currentPrice: typeof priceValue === 'number' && priceValue > 0 ? priceValue : holding.currentPrice,
      acquiredAt: holding.acquiredAt ?? row.purchase_date,
    }
  })
}

// P4.5-A013-T6: importPortfolioCsv自体（full-sync意味論）は変更せず、その前後の
// holdings/trust配列を比較して「何が変わったか」を表示専用に集計するだけ。
// 投信のupdated/reheld判定はmatchedByFundIdを外部公開していないため、importPortfolioCsv.ts
// の実装保証（未マッチ・非ambiguousの登録済み投信は必ずeval=0化される。253-256行目）に基づき、
// old/newのeval遷移から間接的に導出する:
//   - ambiguousFundIdsに含まれるfundは今回未変更（推測合算を防ぐため）なので対象外
//   - old.eval<=0 → new.eval>0: 解約済み扱いだった投信がCSVで再度一致した（再保有反映）
//   - old.eval>0  → new.eval>0: 現在保有中の投信がCSVと一致し値を更新した
//   - old.eval>0  → new.eval===0: zeroedFundIdsで別途カウント済み（ここでは数えない）
export function buildCsvSyncSummary(
  oldHoldings: Holding[],
  newHoldings: Holding[],
  oldTrust: Trust[],
  newTrust: Trust[],
  trustSync: TrustSyncReport,
  importedAt: string,
): CsvSyncSummary {
  const oldStockCodes = new Set(oldHoldings.map(h => h.code))
  const newStockCodes = new Set(newHoldings.map(h => h.code))
  const stockAdded = newHoldings.filter(h => !oldStockCodes.has(h.code)).length
  const stockRemoved = oldHoldings.filter(h => !newStockCodes.has(h.code)).length
  const stockUpdated = newHoldings.length - stockAdded

  let trustUpdated = 0
  let trustReheld = 0
  if (trustSync.trustSectionSeen) {
    const oldTrustById = new Map(oldTrust.map(f => [f.id, f]))
    const ambiguous = new Set(trustSync.ambiguousFundIds)
    newTrust.forEach(f => {
      if (ambiguous.has(f.id)) return
      const old = oldTrustById.get(f.id)
      if (!old) return
      if (old.eval <= 0 && f.eval > 0) trustReheld += 1
      else if (old.eval > 0 && f.eval > 0) trustUpdated += 1
    })
  }

  return {
    importedAt,
    stock: {
      updated: stockUpdated,
      added: stockAdded,
      removed: stockRemoved,
    },
    trust: {
      updated: trustUpdated,
      reheld: trustReheld,
      zeroed: trustSync.zeroedFundIds.length,
      unknownFunds: trustSync.unknownFunds.map(f => ({ name: f.name, eval: f.eval })),
      ambiguousFundIds: [...trustSync.ambiguousFundIds],
    },
  }
}

// P4.5-A013-T6a: localStorage鮮度（表示専用）を読み直すための共通ヘルパー。
// persistPortfolio/persistTrust直後に呼ぶことで、CSV取込・portfolio snapshot import
// 成功時にsystem.localStorageFreshnessをその場で最新化できる（従来はinitialize時にしか
// 計算されず、stale状態からimportに成功してもリロードするまでT0/T1の警告が消えなかった）。
// 投資判断ロジックは一切参照しない（P4.5-A012dの方針は不変）。
function computeLocalStorageFreshness(nowMs = Date.now()): NonNullable<SystemState['localStorageFreshness']> {
  const portfolioFreshness = getPortfolioStorageFreshness(nowMs)
  const trustFreshness = getTrustStorageFreshness(nowMs)
  return {
    portfolio: { isStale: portfolioFreshness.isStale, ageDays: portfolioFreshness.ageDays },
    trust: { isStale: trustFreshness.isStale, ageDays: trustFreshness.ageDays },
  }
}

/**
 * Non-CSV actions may change portfolio inputs after a canonical CSV generation exists. They
 * must either replace the whole coordinated payload atomically or leave that canonical byte
 * sequence untouched; individual helpers are never allowed to splice one field into it.
 */
function persistCurrentPortfolioGeneration(state: AppState): void {
  const canonical = restoreCsvImportGeneration()
  if (canonical.status === 'committed') {
    try {
      persistCsvImportTransaction({
        holdings: state.holdings,
        trust: state.trust,
        learning: state.learning,
        importedAt: state.system.csvLastImportedAt ?? canonical.payload.importedAt,
        provenance: state.system.csvImportProvenance ?? canonical.payload.provenance ?? null,
        syncSummary: state.system.csvSyncSummary ?? canonical.payload.syncSummary,
        trustShortSnapshot: canonical.payload.trustShortSnapshot,
      })
    } catch {
      // These historical actions are best-effort persistence. A failed full replacement leaves
      // the previous canonical envelope valid; it must not fall through to partial legacy writes.
    }
    return
  }

  persistPortfolio(state.holdings)
  persistTrust(state.trust)
  if (state.learning) persistLearning(state.learning)
}

// P4.5-A013-T7: portfolio snapshot v2専用の新規銘柄構築。
// T2のCSV full-sync新規銘柄と全く同じsafe default契約（buildNewHoldingFromCsvRow）を
// 土台にする（target/alert/lock/技術指標/ファンダメンタル/score/decision/evは
// 常にsafe default。捏造しない）。sector/mu/sigma/sigmaSource/betaのみ、
// snapshot側で検証済みの値があればそれを使う（PC側で既に確定している値を
// 再現するため）。値が無ければT2と同じsafe defaultのまま。
function buildNewHoldingFromSnapshotRow(row: PortfolioSnapshotHolding): Holding {
  const base = buildNewHoldingFromCsvRow({
    assetType: 'stock',
    code: row.code,
    name: row.name ?? row.code,
    eval: row.eval,
    pnlPct: Number.isFinite(row.pnlPct) ? row.pnlPct : 0,
    dayPct: 0,
    price: row.currentPrice ?? 0,
    acquiredAt: row.acquiredAt ?? undefined,
    accountHint: '',
  })
  return {
    ...base,
    sector: row.sector ?? base.sector,
    mu: row.mu ?? base.mu,
    sigma: row.sigma ?? base.sigma,
    sigmaSource: row.sigmaSource ?? base.sigmaSource,
    beta: row.beta ?? base.beta,
  }
}

export type HoldingsFullSyncResult =
  | { ok: true; holdings: Holding[]; addedCount: number; removedCount: number }
  | { ok: false; error: string }

// P4.5-A013-T7: portfolio snapshot v2のholdings full-sync merge。
// CSV full-sync（T2/T2a）と同じ脅威モデル・同じ閾値を再利用する:
//   - snapshotにある既存code → 値を更新（v1のapplyHoldingsSnapshotと同じ
//     update-only精神。metadataは上書きしない）
//   - snapshotにしかないcode → 新規追加（buildNewHoldingFromSnapshotRow）
//   - 受信端末にしかないcode → 削除（構成一致が目的のため）。ただし消滅率>50%
//     または絶対件数>5件の場合はfail-closedで取込全体を中断する
//     （T2aと同一閾値・同一根拠。別端末/破損snapshotの誤爆から保護する）。
export function applyHoldingsFullSyncFromSnapshot(
  holdings: Holding[],
  snapshotHoldings: PortfolioSnapshotHolding[],
): HoldingsFullSyncResult {
  const snapshotCodes = new Set(snapshotHoldings.map(h => h.code))
  const removedCount = holdings.filter(h => !snapshotCodes.has(h.code)).length

  if (holdings.length > 0) {
    const removalRatio = removedCount / holdings.length
    const ratioExceeded = removalRatio > STOCK_REMOVAL_RATIO_THRESHOLD
    const absoluteExceeded = removedCount > STOCK_REMOVAL_ABSOLUTE_CAP
    if (ratioExceeded || absoluteExceeded) {
      return {
        ok: false,
        error: `既存保有銘柄${holdings.length}件中${removedCount}件がsnapshotに見つかりませんでした` +
          `（消滅率${Math.round(removalRatio * 100)}%）。異なる端末/破損したsnapshotの可能性があるため、` +
          '取込を中断しました（保有株・投信は変更されていません）。',
      }
    }
  }

  const bySnapshotCode = new Map(snapshotHoldings.map(h => [h.code, h]))
  const updatedExisting = holdings
    .filter(h => snapshotCodes.has(h.code))
    .map(h => {
      const row = bySnapshotCode.get(h.code)!
      const priceValue = row.currentPrice
      return {
        ...h,
        eval: row.eval > 0 ? row.eval : h.eval,
        pnlPct: Number.isFinite(row.pnlPct) ? row.pnlPct : h.pnlPct,
        currentPrice: typeof priceValue === 'number' && priceValue > 0 ? priceValue : h.currentPrice,
        acquiredAt: h.acquiredAt ?? row.acquiredAt ?? undefined,
      }
    })

  const existingCodes = new Set(holdings.map(h => h.code))
  const newHoldings = snapshotHoldings
    .filter(row => !existingCodes.has(row.code))
    .map(buildNewHoldingFromSnapshotRow)

  return {
    ok: true,
    holdings: [...updatedExisting, ...newHoldings],
    addedCount: newHoldings.length,
    removedCount,
  }
}

// P4.5-A013-T7: 「古いsnapshotで新しいlocal portfolioを逆行させない」ガード。
// T4のshouldApplyPublishedSnapshot（published/auto-generated snapshotの適用判定）とは
// 目的も安全側のデフォルトも異なるため意図的に別関数にする:
//   - shouldApplyPublishedSnapshotは「timestamp不明なら適用しない」（自動処理なので
//     安全側は非適用）
//   - こちらは「timestampが片方でも不明なら拒否しない」（ユーザーが能動的に貼り付ける
//     手動snapshotなので、不明な場合まで拒否すると従来のnull-csvImportedAt運用
//     （CSV未取込端末からのexport等）を壊してしまう）
// 両方のtimestampが判明していて、かつsnapshotの方が厳密に古い場合のみ拒否する。
export function isSnapshotOlderThanCurrentBasis(
  snapshotCsvImportedAt: string | null,
  currentCsvLastImportedAt: string | null,
): boolean {
  if (!snapshotCsvImportedAt || !currentCsvLastImportedAt) return false
  const snapshotTime = parseDataTimestamp(snapshotCsvImportedAt)
  const currentTime = parseDataTimestamp(currentCsvLastImportedAt)
  if (!snapshotTime || !currentTime) return false
  return snapshotTime.getTime() < currentTime.getTime()
}

// ── P1-3B: CommitteeDecision → OfficialDecision 変換 ─────────
// P4-A148: safeModeActive引数を追加。SAFE_MODE発動中はBUYのみBLOCKED化する
// （DQ抑制のDATA_WAITとは異なり、SELL/WATCH/HOLD等の防御・監視判断は維持する）。
export function committeeToOfficialDecision(
  cd: ReturnType<typeof buildCommitteeDecision>,
  dqSuppressed: boolean,
  safeModeActive: boolean,
  holdings: Holding[],
): OfficialDecision {
  // P1-3D前準備: stock系アクションに証券コードを補完する
  // CommitteeAction.id は "stock-BUY_7203" / "stock-SELL_7203" / "stock-WAIT_7203" の形式
  function extractCode(id: string, name: string): string | undefined {
    const m = id.match(/^stock-(?:BUY|SELL|WAIT)_(.+)$/)
    if (m) return m[1]
    // フォールバック: holdings の name で曖昧一致
    return holdings.find(h => h.name === name || name.includes(h.name) || h.name.includes(name))?.code
  }

  const tone = cd.verdict.tone
  const stance: OfficialDecision['stance'] = dqSuppressed
    ? 'data_wait'
    : tone === 'positive' ? 'risk_on'
    : tone === 'negative' ? 'risk_off'
    : 'neutral'

  const actions: OfficialDecisionItem[] = cd.actions.map(a => {
    const isRiskNoTrade = a.id === 'risk-notrade'
    const isDqBlocked = dqSuppressed && a.domain !== 'risk'
    // P4-A148: risk-notrade/DQ抑制のいずれでもない場合のみ、SAFE_MODE中のBUYをBLOCKED化する。
    // SELL/WATCH/HOLD系のタイトルは対象外のため、防御・監視判断はSAFE_MODE中でも維持される。
    const isSafeModeBuyBlocked = !isRiskNoTrade && !isDqBlocked && safeModeActive && a.title.startsWith('BUY ')

    const action: OfficialDecisionAction =
      isRiskNoTrade          ? 'BLOCKED'
      : isDqBlocked          ? 'DATA_WAIT'
      : isSafeModeBuyBlocked ? 'BLOCKED'
      : a.title.startsWith('BUY ')  ? 'BUY'
      : a.title.startsWith('SELL ') ? 'SELL'
      : 'HOLD'
    const assetType: OfficialDecisionItem['assetType'] =
      a.domain === 'stock' ? 'stock'
      : a.domain === 'trust' ? 'jp_trust'
      : 'portfolio'
    const name = a.title.replace(/^(BUY|SELL|WAIT)\s+/, '')
    const code = a.domain === 'stock' ? extractCode(a.id, name) : undefined
    return {
      id:            a.id,
      assetType,
      code,
      name,
      action,
      reason:        a.reason,
      source:        'committee' as const,
      blockedReason: isSafeModeBuyBlocked
        ? 'SAFE_MODE発動中 — 新規買付停止'
        : action === 'BLOCKED' || action === 'DATA_WAIT' ? a.detail : undefined,
    }
  })

  return {
    generatedAt:           cd.generatedAt,
    source:                'committee',
    headline:              cd.verdict.label,
    stance,
    noTrade:               cd.verdict.noTrade || dqSuppressed,
    dataQualitySuppressed: dqSuppressed,
    actions,
    risks:                 cd.risks,
    rationale:             cd.rationale,
  }
}

// ── P4-A9a: データ鮮度算出（candidate reason のobservability用）──────────
// timestamp形式が混在するため両対応する:
//   ISO8601: 2026-06-11T07:19:35+09:00
//   market : 2026-06-11 15:00（JSTとして扱う）
function parseDataTimestamp(value?: string | null): Date | null {
  if (!value) return null

  // market形式: 2026-06-11 15:00 または 2026-06-11 15:00:00
  // JSTとして明示的に扱う。new Date(value) に先に渡すと実装依存になるため先に判定する。
  const marketMatch = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/)
  if (marketMatch) {
    const jst = new Date(`${marketMatch[1]}T${marketMatch[2]}+09:00`)
    if (!Number.isNaN(jst.getTime())) return jst
  }

  // ISO8601: 2026-06-11T07:19:35+09:00
  const iso = new Date(value)
  if (!Number.isNaN(iso.getTime())) return iso

  return null
}

function dataAgeDays(value: string | null | undefined, nowMs: number): number | null {
  const parsed = parseDataTimestamp(value)
  if (!parsed) return null
  const diffMs = nowMs - parsed.getTime()
  if (diffMs < 0) return 0
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

// ── P4.5-A013-T4 / T9-A004: published holdings/trust snapshotが新しいユーザー保有状態を
// 上書きしないための優先順位判定。currentSourceAsOfはsource data自体の基準時刻であり、
// CSV取込操作時刻csvLastImportedAtとは明確に分離する。
// getPortfolioStorageFreshness等のlocalStorage鮮度（stale警告用・initialize/
// refreshAllDataの度に更新される表示専用の値）はここでは使わない。混同すると
// 「再読み込みしただけ」でsnapshotが常に適用可能になってしまうため。
export function shouldApplyPublishedSnapshot(
  snapshotLastUpdated: string | null | undefined,
  currentSourceAsOf: string | null,
  hasCurrentPortfolioGeneration = false,
): boolean {
  const snapshotTime = parseDataTimestamp(snapshotLastUpdated)
  if (!snapshotTime) return false // timestamp不明のsnapshotは常にfail-safeで適用しない

  if (!currentSourceAsOf) return !hasCurrentPortfolioGeneration

  const csvTime = parseDataTimestamp(currentSourceAsOf)
  if (!csvTime) return !hasCurrentPortfolioGeneration

  return snapshotTime.getTime() > csvTime.getTime() // 同値以下は適用しない（逆行防止）
}

// ── P1-G: CandidateItem → OfficialDecisionItem 変換 ──────────
function candidateToOfficialDecisionItem(candidate: CandidateItem): OfficialDecisionItem {
  return {
    id: `candidate-${candidate.id}`,
    assetType: candidate.assetType,
    name: candidate.name,
    action: candidate.action,
    reason: candidate.reason,
    amount: candidate.suggestedAmount > 0 ? candidate.suggestedAmount : undefined,
    candidateScore: candidate.score / 100,
    blockedReason: candidate.blockedReasons[0],
    source: 'candidate',
    isCandidate: true,
    suggestedAmount: candidate.suggestedAmount > 0 ? candidate.suggestedAmount : undefined,
    maxAmount: candidate.maxAmount > 0 ? candidate.maxAmount : undefined,
    candidateSizingTier: candidate.sizingTier,
    candidateSource: candidate.source,
    constraintsPassed: Object.entries(candidate.constraints)
      .filter(([, v]) => v === 'pass')
      .map(([k]) => k),
    constraintsBlocked: candidate.blockedReasons.length > 0 ? candidate.blockedReasons : undefined,
  }
}

// ── P5-B003: StockCandidateItem → OfficialDecisionItem 変換 ──────
// trust専用のcandidateToOfficialDecisionItemとは別関数（sizingTierを持たない等、構造が異なるため）。
// idはtrust候補（candidate-<id>）と衝突しない candidate-stock-<code> プレフィックスを使う。
export function stockCandidateToOfficialDecisionItem(candidate: StockCandidateItem): OfficialDecisionItem {
  const isBuyNew = candidate.action === 'BUY_NEW'
  return {
    id: `candidate-stock-${candidate.code}`,
    assetType: 'stock',
    code: candidate.code,
    name: candidate.name,
    action: candidate.action,
    reason: candidate.reason,
    amount: isBuyNew && candidate.maxAmount > 0 ? candidate.maxAmount : undefined,
    candidateScore: candidate.score / 100,
    blockedReason: candidate.blockedReasons[0],
    source: 'candidate',
    isCandidate: true,
    suggestedAmount: isBuyNew && candidate.maxAmount > 0 ? candidate.maxAmount : undefined,
    maxAmount: candidate.maxAmount > 0 ? candidate.maxAmount : undefined,
    candidateSource: candidate.source,
    constraintsPassed: Object.entries(candidate.constraints)
      .filter(([, v]) => v === 'pass')
      .map(([k]) => k),
    constraintsBlocked: candidate.blockedReasons.length > 0 ? candidate.blockedReasons : undefined,
  }
}

// ── P5-B003: officialDecision.actionsへ追加する株候補の選定 ──────
// BUY_NEW/WATCHのみ、score降順で最大3件。trust候補appendとは独立した枠（互いの3件枠を侵食しない）。
export function selectAppendableStockCandidates(candidates: StockCandidateItem[]): StockCandidateItem[] {
  return candidates
    .filter(c => c.action === 'BUY_NEW' || c.action === 'WATCH')
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
}

// ── runFullAnalysis（内部ヘルパー）───────────────────────────
export function runFullAnalysis(
  state: AppState,
  options: {
    requireOfficialDecision?: boolean
    nowMs?: number
    trustShortInput?: TrustShortAnalysisInput
  } = {},
): Pick<AppState, 'analysis' | 'metrics' | 'holdings' | 'trust' | 'universe' | 'learning' | 'zeroPlan' | 'stockPlan' | 'trustPlan' | 'officialDecision' | 'stockCandidates'> {
  const nowMs = options.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const trustShortInput = options.trustShortInput ?? captureTrustShortAnalysisInput(nowMs)
  const adaptiveWeights =
    state.learning && state.learning.summary.total >= 20
      ? state.learning.suggestedWeights
      : null
  const analysis = computeAnalysis(
    state.holdings,
    state.market,
    state.correlation,
    state.news,
    adaptiveWeights,
    nowMs,
  )
  const metrics = calcPortfolioMetrics(state.holdings, state.correlation)

  // holdingsにスコア・判定を書き戻す
  const holdings = state.holdings.map(h => {
    const a = analysis.find(x => x.code === h.code)
    if (!a) return h
    return { ...h, score: a.totalScore, decision: a.decision, ev: a.ev }
  })

  // trustスコア計算
  const totalTrust = state.trust.reduce((s, f) => s + f.eval, 0)
  const trust = state.trust.map(f => {
    const te = f.cost / 100
    const flowF = f.pnlPct > 20 ? 1.1 : f.pnlPct > 0 ? 1.0 : 0.9
    const sharpe = (f.mu - 0.005) / Math.max(f.sigma, 0.01)
    const sharpeF = sharpe > 1.2 ? 1.2 : sharpe > 0.8 ? 1.0 : 0.8
    const dd = Math.max(0, -f.pnlPct / 100) * 0.5
    const ev_fund = (f.mu - te) * flowF * sharpeF - dd
    const divF = f.policy === 'GOLD' ? 1.15 : f.id.includes('fang') ? 0.85 : f.policy === 'OVERSEAS_LONGTERM' ? 1.05 : 0.90
    const corrF = f.policy === 'GOLD' ? 1.1 : f.id.includes('fang') ? 0.9 : 1.0
    const ev = +(ev_fund * divF * corrF).toFixed(4)
    const w = f.eval / Math.max(totalTrust, 1)
    let score = 40 + sharpe * 25 + ev * 200 + (f.pnlPct > 50 ? 10 : f.pnlPct > 0 ? 5 : -5) +
      (f.cost > 1.0 ? -15 : f.cost > 0.5 ? -8 : 0) + (f.policy === 'JAPAN_SHORTTERM' ? -5 : 0)
    score += w > 0.35 ? -4 : w > 0.25 ? -2 : w < 0.05 ? 2 : 0
    score = Math.max(0, Math.min(100, score))
    const decision: Trust['decision'] = f.pnlPct < -15 && f.policy === 'JAPAN_SHORTTERM' ? 'SELL' :
      score >= 75 ? 'BUY' : score >= 60 ? 'HOLD' : score >= 40 ? 'WAIT' : 'SELL'
    return { ...f, ev, score: Math.round(score), decision }
  })

  // P4.5-A002: 資金前提の実効値（手動override > 既定値）。buildAssetUniverse/zeroBaseの
  // 買付余力計算はこの実効値を使う。手動値と既定値は加算しない（優先順位のみ）。
  const effectiveCash = selectEffectiveCashAssumptions(state)

  // ゼロベース理想PF構築（metrics計算後に呼ぶ）
  const stateWithComputed: AppState = {
    ...state, holdings, trust, metrics, analysis,
    cash: effectiveCash.cash,
    cashReserve: effectiveCash.cashReserve,
  }
  const universe = buildAssetUniverse(stateWithComputed, nowMs)
  const noTradeResult = checkNoTrade(stateWithComputed)
  const learning = updatePerformanceTracker(
    state.learning,
    holdings,
    analysis,
    nowIso,
    state.market.regime,  // Phase 8: レジーム別有効性蓄積
  )

  // P1-3B: Plan snapshots + OfficialDecision（UIはまだ未接続）
  let zeroPlan:         AppState['zeroPlan']         = null
  let stockPlan:        AppState['stockPlan']        = null
  let trustPlan:        AppState['trustPlan']        = null
  let officialDecision: AppState['officialDecision'] = null
  try {
    // P4-A45: noTrade合成条件 — VIX/VI/SQゲート(noTradeResult) OR SAFE_MODE active OR data stale(dqSuppressed)
    // P4-A148: zeroPlan(個別株BUY抑制)・officialDecision(BUY→BLOCKED変換)にも同じ2値を渡すため、
    // zeroPlan生成より前に算出する。
    const dqSuppressed = selectMarketDataQuality(state, nowMs).isSuppressed
    // P4-A159/P4.5-A011: safe_mode.jsonの取得成功・schema正当性だけでは鮮度は保証されない。
    // last_checkedが欠損/不正/SAFE_MODE_STALE_HOURS超過ならfail-closed（active相当）に倒す。
    // selectEffectiveSafeModeActiveへ集約し、タブ表示ゲートとも同一の式を共有する。
    const safeModeActive = selectEffectiveSafeModeActive(state, nowMs)
    zeroPlan = buildZeroBasePlan({
      holdings,
      trust,
      analysis,
      market:           state.market,
      macro:            state.macro,
      sqCalendar:       state.sqCalendar,
      metrics,
      universe,
      cash:             effectiveCash.cash,
      cashReserve:      effectiveCash.cashReserve,
      addRoom:          state.addRoom,
      jpStockMaxRatio:  state.portfolioPolicy.jpStockMaxRatio,
      safeModeActive,
      dqSuppressed,
      nowMs,
    })
    stockPlan = buildStockPortfolioPlan(holdings, analysis, {
      targetTotalValue: universe?.categories.find(c => c.class === 'JP_STOCK')?.targetValue,
      nowMs,
    })
    // P4-A48: JP_TRUST理想配分差分をheadroomとしてCORE_BUDGETを上限制御
    const jpTrustHeadroom = universe?.categories.find(c => c.class === 'JP_TRUST')?.diffValue
    trustPlan = buildTrustPortfolioPlan({
      trust,
      market:          state.market,
      macro:           state.macro,
      news:            state.news,
      sqCalendar:      state.sqCalendar,
      margin:          state.margin,
      flows:           state.flows,
      todayEntryCount: trustShortInput.todayEntryCount,
      performance30d:  trustShortInput.performance30d,
      noTrade:         noTradeResult.noTrade || safeModeActive || dqSuppressed,
      jpTrustHeadroom,
      nowMs,
    })
    const cd = buildCommitteeDecision({ zeroPlan, stockPlan, trustPlan, metrics, market: state.market, holdings, nowMs })
    officialDecision = committeeToOfficialDecision(cd, dqSuppressed, safeModeActive, holdings)

    // P4-A1' → P4.5-A013-T5で判定基準を変更:
    // 元々はtrust_master（public snapshot）未ロード時のINITIAL_TRUSTの静的eval:0
    // フォールバック（既保有投信 nq100_nisa / nikkei_semi 等を含む）をBUY_NEW候補と
    // 誤検出しないためのゲートだった。しかしP4.5-A010-1aでtrust_master.jsonの公開が
    // 恒久的に停止された（dataTimestamps.trustは今後常にnull）ため、この基準のままでは
    // 実際のCSV full-sync（P4.5-A013-T3）で得た信頼できるeval値があっても候補パイプ
    // ラインが恒久的に停止してしまう。
    // 保有データが手動import済みかを示すoperation marker（csvLastImportedAt）と
    // trust registryのmetadata鮮度（id/policy/cost/mu/sigma — INITIAL_TRUSTのハード
    // コードが常にsource of truthでtrust_masterの成否に依存しない）は別物であるため、
    // ゲートは「INITIAL_TRUSTの静的evalのままか」を分けるcsvLastImportedAtの有無で判定する。
    // T9-A004: これはsource freshness比較ではなく、sourceAsOfの代用にも使用しない。
    // csvLastImportedAtが無い（CSV未取込＝INITIAL_TRUSTの静的eval:0のまま）場合のみ
    // 候補パイプラインを停止する。市場鮮度・SAFE_MODE・DQ等のstale判定はここでは
    // 混同せず、scoreCandidates内の既存gate（baseCtxのdqSuppressed/safeModeActive等）
    // に委ねる。
    // Candidate pipeline: 未保有投信候補（国内個別株は対象外 — not_for_trading: true のため）
    const rawCandidates = state.system.csvLastImportedAt != null
      ? buildCandidateUniverse(trust)
      : []
    if (rawCandidates.length > 0) {
      const MIN_CASH_FLOOR = 1_000_000
      const availableCash = Math.max(0, effectiveCash.cash - MIN_CASH_FLOOR) + state.addRoom
      const roleExposureByRole = computeRoleExposureByRole(trust)
      const totalTrustValue = trust.reduce((sum, fund) => sum + Math.max(0, fund.eval), 0)
      const getClassCtx = (cls: string) => {
        const cat = universe?.categories.find(c => c.class === cls)
        return { classCurrentValue: cat?.currentValue ?? 0, classTargetValue: cat?.targetValue ?? 0 }
      }
      const baseCtx = { dqSuppressed, noTrade: noTradeResult.noTrade, marketCaution: noTradeResult.mode === 'caution', availableCash, roleExposureByRole, totalTrustValue, marketRegime: state.market.regime, marketDataAgeDays: dataAgeDays(state.system.dataTimestamps?.market, nowMs), trustDataAgeDays: dataAgeDays(state.system.dataTimestamps?.trust, nowMs), marketNikkeiChgPct: state.market.nikkeiChgPct ?? null, macroSp500ChgPct: state.macro?.sp500ChgPct ?? null, macroNasdaqChgPct: state.macro?.nasdaqChgPct ?? null, macroGoldChgPct: state.macro?.goldChgPct ?? null, candidatesNews: state.candidatesNews, candidatesNewsSource: state.system.dataSourceStatus.candidatesNews, regimeState: state.regimeState, regimeStateSource: state.system.dataSourceStatus.regime, safeModeActive }
      const scored = [
        ...scoreCandidates(rawCandidates.filter(c => c.assetType === 'jp_trust'),     { ...baseCtx, ...getClassCtx('JP_TRUST') }),
        ...scoreCandidates(rawCandidates.filter(c => c.assetType === 'global_trust'), { ...baseCtx, ...getClassCtx('OVERSEAS_TRUST') }),
        ...scoreCandidates(rawCandidates.filter(c => c.assetType === 'gold'),         { ...baseCtx, ...getClassCtx('GOLD') }),
      ]
      // BUY_NEW / WATCH のみ score 降順、最大3件を officialDecision.actions に追加
      const appendable = scored
        .filter(c => c.action === 'BUY_NEW' || c.action === 'WATCH')
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(candidateToOfficialDecisionItem)
      if (appendable.length > 0) {
        officialDecision = { ...officialDecision, actions: [...officialDecision.actions, ...appendable] }
      }
    }
  } catch (error) {
    if (options.requireOfficialDecision) throw new OfficialDecisionGenerationError(error)
    // plans remain null; analysis continues normally
  }

  // P5-B002b-1: 新規個別株候補（candidates_stocks.json由来）のscore/headroom/gate計算。
  // 意図的にtrust候補ブロック（上のtry/catch）の外・dataTimestamps.trust gateの外に置く。
  // trust_master未取得（dataTimestamps.trust === null）でも candidatesStocks.source/status/
  // updatedAt が有効であれば独立して評価できるようにするため。
  // P5-B003: officialDecision.actionsへの接続はこのブロック内（下記）で行う。
  // trust候補appendとは別のslice(0,3)を使い、trust候補の3件枠を侵食しない。
  let stockCandidates: AppState['stockCandidates'] = []
  try {
    const dqSuppressedForStock = selectMarketDataQuality(state, nowMs).isSuppressed
    const safeModeActiveForStock = selectEffectiveSafeModeActive(state, nowMs)
    const effectiveCashForStock = selectEffectiveCashAssumptions(state)
    const cashFreshness = selectCashAssumptionsFreshness(state, nowMs)
    // P5-B002b-1: 資金前提が既定値運用中（手動override無効）または鮮度切れの場合、
    // BUY_NEW候補は出さない（gate内でDATA_STALEとして扱う）。
    const cashAssumptionsUsable = effectiveCashForStock.source === 'manual' && !cashFreshness.isStale
    // universe（totalValue）はこの関数上部で既に同じeffectiveCashを使って計算済みのため再利用する。
    const jpStockHeadroom = computeJpStockHeadroom(
      holdings,
      state.portfolioPolicy.jpStockMaxRatio,
      universe?.totalValue ?? 0,
    )
    const STOCK_MIN_CASH_FLOOR = 1_000_000
    const availableCashForStock = Math.max(0, effectiveCashForStock.cash - STOCK_MIN_CASH_FLOOR) + state.addRoom

    stockCandidates = buildStockCandidatePlan({
      holdings,
      candidatesStocks: state.candidatesStocks,
      candidatesStocksSource: state.system.dataSourceStatus.candidatesStocks ?? 'default',
      dqSuppressed: dqSuppressedForStock,
      noTrade: noTradeResult.noTrade,
      marketCaution: noTradeResult.mode === 'caution',
      safeModeActive: safeModeActiveForStock,
      availableCash: availableCashForStock,
      jpStockHeadroom,
      cashAssumptionsUsable,
      now: nowMs,
    })

    // P5-B003: BUY_NEW / WATCH のみ score 降順、最大3件を officialDecision.actions に追加。
    // trust候補appendとは独立したslice(0,3)（trust候補・後述の全体最大3件枠とは別に加算される）。
    // officialDecisionがnull（trust候補ブロックが例外で落ちた等）の場合はappendしない。
    if (officialDecision) {
      const appendableStock = selectAppendableStockCandidates(stockCandidates).map(stockCandidateToOfficialDecisionItem)
      if (appendableStock.length > 0) {
        officialDecision = { ...officialDecision, actions: [...officialDecision.actions, ...appendableStock] }
      }
    }
  } catch (error) {
    if (options.requireOfficialDecision) throw new OfficialDecisionGenerationError(error)
    stockCandidates = []
  }

  if (options.requireOfficialDecision && officialDecision === null) {
    throw new OfficialDecisionGenerationError('officialDecisionが生成されませんでした')
  }

  return { analysis, metrics, holdings, trust, universe, learning, zeroPlan, stockPlan, trustPlan, officialDecision, stockCandidates }
}

function reportSubscriberException(error: unknown): void {
  // Observer failures are diagnostic events, not transaction failures. Reporting here keeps
  // later subscribers running and prevents a published durable generation from becoming a
  // false red result merely because one consumer threw while observing it.
  try { console.error('[useAppStore] subscriber callback failed', error) } catch { /* diagnostic sink */ }
}

// ── Store ─────────────────────────────────────────────────────
export const useAppStore = create<AppState & AppActions>((set, get, api) => {
  const rawSetState = api.setState
  api.setState = ((...args: Parameters<typeof api.setState>) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('setState')
      return
    }
    return rawSetState(...args)
  }) as typeof api.setState

  const rawSubscribe = api.subscribe
  api.subscribe = ((listener: (state: AppState & AppActions, previous: AppState & AppActions) => void) =>
    rawSubscribe((state, previous) => {
      try { listener(state, previous) } catch (error) { reportSubscriberException(error) }
    })) as typeof api.subscribe

  return ({
  // 初期値
  holdings: INITIAL_HOLDINGS,
  trust: INITIAL_TRUST,
  market: STATIC_MARKET,
  correlation: null,
  news: null,
  metrics: null,
  analysis: [],
  activeTab: 'T0',
  // v9.0 — 全資産統合
  macro: null,
  sqCalendar: null,
  margin: null,
  flows: null,
  universe: null,
  learning: null,
  cash: INITIAL_CASH,
  cashReserve: INITIAL_CASH_RESERVE,
  addRoom: INITIAL_ADD_ROOM,
  // Phase 7 — 計算観察値 (Card 7-10/7-11)
  stockScores6Axis: null as StockScoreRecord[] | null,
  fundPhase7: null as FundPhase7Map | null,
  // P1-3A/B: Official Decision + Plan snapshots
  officialDecision: null,
  zeroPlan: null,
  stockPlan: null,
  trustPlan: null,
  // P4-A9c-data-4c: role-unit candidates news（observability用・意思決定未接続）
  candidatesNews: DEFAULT_CANDIDATES_NEWS_DATA,
  // P5-B002a: 新規個別株候補（市場公開情報のみ。observability用・officialDecision未接続）
  candidatesStocks: DEFAULT_CANDIDATES_STOCKS_DATA,
  // P5-B002b-1: candidatesStocks由来のscore/headroom/gate計算済み内部候補リスト（未接続）
  stockCandidates: [],
  // P4-A9d: 5-regime live state（observability用・意思決定未接続）
  regimeState: DEFAULT_REGIME_STATE,
  // P4-A24: SAFE_MODE / TierA live snapshot（observability用・意思決定未接続）
  safeMode: DEFAULT_SAFE_MODE_SNAPSHOT,
  tierAViolations: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
  tierAAlerts: DEFAULT_TIER_A_ALERTS_SNAPSHOT,
  // P4-A47: PortfolioPolicy（jpStockMaxRatio初期値0.10）
  portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
  // P4.5-A002: 資金前提の手動override（初期値は既定値のまま、initialize時にlocalStorageから復元）
  cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
  system: {
    version: '10.0',
    status: 'idle',
    lastUpdated: null,
    csvLastImportedAt: null,
    csvImportProvenance: null,
    csvSyncSummary: null,
    analysisLastRunAt: null,
    error: null,
    dataSourceStatus: {
      market: 'static',
      correlation: 'static',
      news: 'none',
      trust: 'static',
      holdings: 'static',
      macro: 'none',
      nikkeiVI: 'none',
      sq: 'none',
      margin: 'none',
      flows: 'none',
      candidatesNews: 'default',
      candidatesStocks: 'default',
      regime: 'default',
    },
    dataTimestamps: {
      market: null,
      correlation: null,
      news: null,
      trust: null,
      holdings: null,
      macro: null,
      nikkeiVI: null,
      sq: null,
      margin: null,
      flows: null,
      candidatesNews: null,
      candidatesStocks: null,
      regime: null,
    },
  },

  // ── 起動時初期化 ──────────────────────────────────────────
  initialize: async () => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('initialize')
      return
    }
    if (get().system.status === 'loading') return
    set(s => ({ system: { ...s.system, status: 'loading' } }))
    try {
      // localStorage復元（P4.5-A012d: holdings/trustはTTL失効時も値を保持する。
      // 鮮度はlocalStorageFreshnessとして表示専用にsystemへ反映する）
      const csvGeneration = restoreCsvImportGeneration()
      // A committed envelope is hydrated as one logical generation. A present but invalid
      // envelope fails closed instead of mixing possibly partial legacy keys. Legacy keys are
      // read only when no generation envelope exists (backward compatibility).
      const useLegacy = csvGeneration.status === 'none'
      const savedPortfolio = csvGeneration.status === 'committed'
        ? csvGeneration.payload.holdings
        : useLegacy ? restorePortfolio() : null
      const savedTrust = csvGeneration.status === 'committed'
        ? csvGeneration.payload.trust
        : useLegacy ? restoreTrust() : null
      const savedLearning = csvGeneration.status === 'committed' || useLegacy
        ? restoreLearning()
        : null
      const savedCsvAt = csvGeneration.status === 'committed' || useLegacy
        ? restoreCsvImportedAt()
        : null
      const savedCsvSyncSummary = csvGeneration.status === 'committed' || useLegacy
        ? restoreCsvSyncSummary()
        : null
      const savedCsvProvenance = csvGeneration.status === 'committed'
        ? csvGeneration.payload.provenance ?? null
        : null
      const savedPolicy = restorePortfolioPolicy()
      const savedCashAssumptions = restoreCashAssumptions()
      set(s => ({
        ...(savedPortfolio ? { holdings: savedPortfolio } : {}),
        ...(savedTrust ? { trust: savedTrust } : {}),
        ...(savedLearning ? { learning: savedLearning } : {}),
        ...(savedPolicy ? { portfolioPolicy: savedPolicy } : {}),
        ...(savedCashAssumptions ? { cashAssumptions: savedCashAssumptions } : {}),
        system: {
          ...s.system,
          ...(savedCsvAt ? { csvLastImportedAt: savedCsvAt } : {}),
          ...(savedCsvSyncSummary ? { csvSyncSummary: savedCsvSyncSummary } : {}),
          csvImportProvenance: savedCsvProvenance,
        },
      }))
      // P4.5-A012d: holdings/trustのlocalStorage鮮度を表示専用でsystemへ反映する。
      // 投資判断ロジックには一切使わない（UIのstale警告のみに使用）。
      set(s => ({ system: { ...s.system, localStorageFreshness: computeLocalStorageFreshness() } }))

      // データ取得（macro / nikkei VI / SQ / Phase 7 含む）
      // stock_scores_6axis: 本番生成ファイル（data/scoring/）を参照。contracts/v13.3 フィクスチャは使用しない
      // fund_phase7: 本番生成物が存在しないためfetch廃止。フィクスチャ(phase7_fixture)は使用しない
      const [result, phase7StockRaw] = await Promise.all([
        loadPublishedData({ bustCache: true }),
        fetch('data/scoring/stock_scores_6axis.json')
          .then(r => r.ok ? (r.json() as Promise<{ _meta?: { kind?: string }; stock_scores_6axis?: StockScoreRecord[] }>) : null)
          .catch(() => null),
      ])
      const { market, correlation, news, trust, holdingsSnapshot, macro, nikkeiVI, sq, margin, flows, candidatesNews, candidatesStocks, regimeState, safeMode, tierAViolations, tierAAlerts } = result

      set(s => {
        const sourceAsOf = s.system.csvImportProvenance?.sourceAsOfConfidence === 'authoritative'
          ? s.system.csvImportProvenance.sourceAsOf
          : null
        const hasCurrentGeneration = s.system.csvLastImportedAt !== null
        const nextTrust = trust.data && shouldApplyPublishedSnapshot(trust.lastUpdated, sourceAsOf, hasCurrentGeneration)
          ? s.trust.map(f => { const d = trust.data!.find(x => x.id === f.id); return d ? { ...f, ...d } : f })
          : s.trust
        const snapshotMergedHoldings = shouldApplyPublishedSnapshot(holdingsSnapshot.lastUpdated, sourceAsOf, hasCurrentGeneration)
          ? applyHoldingsSnapshot(s.holdings, holdingsSnapshot.data)
          : s.holdings
        // volatilities反映
        const holdingsWithVol = correlation.data
          ? snapshotMergedHoldings.map(h => {
              const v = correlation.data!.volatilities[h.code + '.T']
              return v ? { ...h, sigma: +v.toFixed(3), sigmaSource: 'yfinance' as const } : h
            })
          : snapshotMergedHoldings
        return {
          market: market.data,
          correlation: correlation.data,
          news: news.data,
          trust: nextTrust,
          holdings: holdingsWithVol,
          macro: macro.data,
          sqCalendar: sq.data,
          margin: margin.data,
          flows: flows.data,
          candidatesNews: candidatesNews.data,
          candidatesStocks: candidatesStocks.data,
          regimeState: regimeState.data,
          safeMode: safeMode.data,
          tierAViolations: tierAViolations.data,
          tierAAlerts: tierAAlerts.data,
          system: {
            ...s.system,
            dataSourceStatus: {
              market: market.source,
              correlation: correlation.source,
              news: news.source,
              trust: trust.source,
              holdings: holdingsSnapshot.source,
              macro: macro.source,
              nikkeiVI: nikkeiVI.source,
              sq: sq.source,
              margin: margin.source,
              flows: flows.source,
              candidatesNews: candidatesNews.source,
              candidatesStocks: candidatesStocks.source,
              regime: regimeState.source,
              safeMode: safeMode.source,
              tierAViolations: tierAViolations.source,
              tierAAlerts: tierAAlerts.source,
            },
            dataTimestamps: {
              market: market.data?.last_updated ?? null,
              correlation: correlation.data?.last_updated ?? null,
              news: news.data?.updatedAt ?? null,
              trust: trust.lastUpdated ?? null,
              holdings: holdingsSnapshot.lastUpdated ?? null,
              macro: macro.data?.last_updated ?? null,
              nikkeiVI: nikkeiVI.data?.last_updated ?? null,
              sq: sq.data?.last_updated ?? null,
              margin: margin.data?.last_updated ?? null,
              flows: flows.data?.last_updated ?? null,
              candidatesNews: candidatesNews.data.updatedAt || null,
              candidatesStocks: candidatesStocks.data.updatedAt || null,
              regime: regimeState.generatedAt,
              safeMode: safeMode.lastChecked,
              tierAViolations: tierAViolations.generatedAt,
              tierAAlerts: tierAAlerts.generatedAt,
            },
          },
        }
      })

      // NikkeiVI を market に合流（v9.0 では market型にまだフィールドないので macro経由で表示）
      if (nikkeiVI.data && get().macro) {
        set(s => ({ macro: s.macro ? { ...s.macro, nikkeiVI: nikkeiVI.data!.vi, nikkeiVIChg: nikkeiVI.data!.viChg } : s.macro }))
      }

      // Phase 7 観察値セット
      // _meta.kind === 'sample_contract' のフィクスチャデータは拒否し空配列にする
      // 本番ファイルは ticker が '6098.T' 形式なので '.T' サフィックスを除去してコードに合わせる
      const isValidScoringData = phase7StockRaw !== null && phase7StockRaw?._meta?.kind !== 'sample_contract'
      const normalizedScores: StockScoreRecord[] = isValidScoringData && phase7StockRaw?.stock_scores_6axis
        ? phase7StockRaw.stock_scores_6axis.map(r => ({ ...r, ticker: r.ticker.replace(/\.T$/, '') }))
        : []
      set({
        stockScores6Axis: normalizedScores,
        fundPhase7: null,  // 本番生成物なし — フィクスチャ(phase7_fixture)は使用しない
      })

      // 全再計算
      const computed = runFullAnalysis(get())
      const now = new Date().toISOString()
      set(s => ({
        ...computed,
        system: { ...s.system, status: 'success', lastUpdated: now, analysisLastRunAt: now, error: null },
      }))

      // 永続化
      persistCurrentPortfolioGeneration(get())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({ system: { ...s.system, status: 'error', error: msg } }))
    }
  },

  // ── 全データ再取得 ────────────────────────────────────────
  refreshAllData: async () => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('refreshAllData')
      return
    }
    if (get().system.status === 'loading') return
    set(s => ({ system: { ...s.system, status: 'loading', error: null } }))
    try {
      const result = await loadPublishedData({ bustCache: true })
      const { market, correlation, news, trust, holdingsSnapshot, macro, nikkeiVI, sq, margin, flows, candidatesNews, candidatesStocks, regimeState, safeMode, tierAViolations, tierAAlerts } = result

      set(s => {
        const sourceAsOf = s.system.csvImportProvenance?.sourceAsOfConfidence === 'authoritative'
          ? s.system.csvImportProvenance.sourceAsOf
          : null
        const hasCurrentGeneration = s.system.csvLastImportedAt !== null
        const nextTrust = trust.data && shouldApplyPublishedSnapshot(trust.lastUpdated, sourceAsOf, hasCurrentGeneration)
          ? s.trust.map(f => { const d = trust.data!.find(x => x.id === f.id); return d ? { ...f, ...d } : f })
          : s.trust
        const snapshotMergedHoldings = shouldApplyPublishedSnapshot(holdingsSnapshot.lastUpdated, sourceAsOf, hasCurrentGeneration)
          ? applyHoldingsSnapshot(s.holdings, holdingsSnapshot.data)
          : s.holdings
        const holdingsWithVol = correlation.data
          ? snapshotMergedHoldings.map(h => {
              const v = correlation.data!.volatilities[h.code + '.T']
              return v ? { ...h, sigma: +v.toFixed(3), sigmaSource: 'yfinance' as const } : h
            })
          : snapshotMergedHoldings
        return {
          market: market.data, correlation: correlation.data, news: news.data,
          trust: nextTrust, holdings: holdingsWithVol,
          macro: macro.data, sqCalendar: sq.data, margin: margin.data, flows: flows.data,
          candidatesNews: candidatesNews.data,
          candidatesStocks: candidatesStocks.data,
          regimeState: regimeState.data,
          safeMode: safeMode.data,
          tierAViolations: tierAViolations.data,
          tierAAlerts: tierAAlerts.data,
          system: {
            ...s.system,
            dataSourceStatus: {
              market: market.source, correlation: correlation.source,
              news: news.source, trust: trust.source,
              holdings: holdingsSnapshot.source,
              macro: macro.source, nikkeiVI: nikkeiVI.source, sq: sq.source,
              margin: margin.source, flows: flows.source,
              candidatesNews: candidatesNews.source,
              candidatesStocks: candidatesStocks.source,
              regime: regimeState.source,
              safeMode: safeMode.source,
              tierAViolations: tierAViolations.source,
              tierAAlerts: tierAAlerts.source,
            },
            dataTimestamps: {
              market: market.data?.last_updated ?? null,
              correlation: correlation.data?.last_updated ?? null,
              news: news.data?.updatedAt ?? null,
              trust: trust.lastUpdated ?? null,
              holdings: holdingsSnapshot.lastUpdated ?? null,
              macro: macro.data?.last_updated ?? null,
              nikkeiVI: nikkeiVI.data?.last_updated ?? null,
              sq: sq.data?.last_updated ?? null,
              margin: margin.data?.last_updated ?? null,
              flows: flows.data?.last_updated ?? null,
              candidatesNews: candidatesNews.data.updatedAt || null,
              candidatesStocks: candidatesStocks.data.updatedAt || null,
              regime: regimeState.generatedAt,
              safeMode: safeMode.lastChecked,
              tierAViolations: tierAViolations.generatedAt,
              tierAAlerts: tierAAlerts.generatedAt,
            },
          },
        }
      })

      if (nikkeiVI.data && get().macro) {
        set(s => ({ macro: s.macro ? { ...s.macro, nikkeiVI: nikkeiVI.data!.vi, nikkeiVIChg: nikkeiVI.data!.viChg } : s.macro }))
      }

      const computed = runFullAnalysis(get())
      const now = new Date().toISOString()
      set(s => ({
        ...computed,
        system: { ...s.system, status: 'success', lastUpdated: now, analysisLastRunAt: now, error: null },
      }))

      persistCurrentPortfolioGeneration(get())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({ system: { ...s.system, status: 'error', error: msg } }))
    }
  },

  // ── CSV取込（個別株 + 投信 両対応）──────────────────────────
  importCsv: async (file: File, options = {}) => {
    if (activeCsvImportTransaction !== null || get().system.status === 'loading') {
      return csvImportFailure('IMPORT_IN_PROGRESS', '別の取込または更新が進行中です。完了後に再試行してください。')
    }
    const transaction: CsvImportTransaction = {
      token: Symbol('csv-import-owner'),
      phase: 'READING',
      analysisNow: Date.now(),
      initialFingerprint: '',
      trackerSnapshot: null,
      trackerPortfolioBaseline: null,
      canonicalPreviousRaw: null,
    }
    activeCsvImportTransaction = transaction
    let durableCommitted = false
    let committedSuccess: CsvImportResult | null = null
    const publishFailure = (failure: CsvImportResult): CsvImportResult => {
      if (failure.ok) return failure
      if (activeCsvImportTransaction?.token === transaction.token) {
        set(s => ({ system: { ...s.system, status: 'error', error: failure.message } }))
      }
      return failure
    }

    try {
      try {
        transaction.canonicalPreviousRaw = readCsvImportCanonicalRaw()
      } catch (error) {
        return publishFailure(csvImportFailure(
          'PERSISTENCE_ERROR',
          error instanceof Error ? error.message : String(error),
        ))
      }
      transaction.trackerSnapshot = captureTrustShortAnalysisInput(transaction.analysisNow)
      transaction.trackerPortfolioBaseline = captureTrustShortPortfolioBaseline()
      const baseState = get()
      const dependencyFingerprint = buildPortfolioAnalysisFingerprint(
        baseState,
        transaction.trackerSnapshot.fingerprint,
      )
      transaction.initialFingerprint = dependencyFingerprint
      const fileName = String(file.name || 'CSVファイル')
      set(s => ({ system: { ...s.system, status: 'loading', error: null } }))
      setCsvImportTransactionPhase(transaction, 'READING')
      const oldHoldings = baseState.holdings
      const oldTrust = baseState.trust

      let parsed: Awaited<ReturnType<typeof importPortfolioCsv>>
      try {
        parsed = await importPortfolioCsv(file, oldHoldings, oldTrust)
      } catch (error) {
        return publishFailure(classifyCsvParseFailure(error))
      }

      // The monotonicity decision must be based on the exact canonical bytes captured at the
      // transaction boundary. If ownership already changed while FileReader was pending, report
      // the concurrency conflict before interpreting provenance from a stale baseline.
      if (readCsvImportCanonicalRaw() !== transaction.canonicalPreviousRaw) {
        return publishFailure(csvImportFailure(
          'IMPORT_CONFLICT',
          '取込中にcanonical世代が変更されました。外部の世代を維持したまま再試行してください。',
        ))
      }

      const { holdings: updatedH, trust: updatedT, trustSync, sourceProvenance } = parsed
      setCsvImportTransactionPhase(transaction, 'STAGING')
      const now = new Date(transaction.analysisNow).toISOString()
      const incomingProvenance: CsvImportProvenance = { importedAt: now, ...sourceProvenance }
      const currentGeneration = restoreCsvImportGenerationFromRaw(transaction.canonicalPreviousRaw)
      const monotonicity = evaluateCsvImportMonotonicity({
        incoming: incomingProvenance,
        current: currentGeneration.status === 'committed'
          ? currentGeneration.payload.provenance ?? null
          : null,
        currentGenerationExists: currentGeneration.status === 'committed',
      })

      if (monotonicity.decision === 'DUPLICATE') {
        const currentProvenance = currentGeneration.status === 'committed'
          ? currentGeneration.payload.provenance
          : null
        if (!currentProvenance) {
          return publishFailure(csvImportFailure(
            'CSV_PROVENANCE_UNKNOWN',
            '現在のCSV世代のprovenanceを確認できないため、同一内容として確定できませんでした。状態は変更されていません。',
          ))
        }
        set(s => ({ system: { ...s.system, status: 'success', error: null } }))
        return {
          ok: true,
          code: 'DUPLICATE_CSV',
          message: '同じ内容のCSVは既に取り込み済みです。portfolio generationは変更していません。',
          imported: {
            stock: { updated: 0, added: 0, removed: 0 },
            trust: { updated: 0, reheld: 0, zeroed: 0, unknown: 0, ambiguous: 0 },
          },
          warnings: [],
          analysisCommitted: false,
          officialDecisionCommitted: false,
          persistence: { status: 'not_attempted' },
          importedAt: currentProvenance.importedAt,
          provenance: currentProvenance,
        }
      }
      if (monotonicity.decision === 'REJECT_STALE') {
        return publishFailure(csvImportFailure(
          'STALE_CSV',
          'CSVのデータ基準時刻が現在のportfolio generationより古いため、取込を中断しました。状態は変更されていません。',
        ))
      }
      if (monotonicity.decision === 'REJECT_CONFLICT') {
        return publishFailure(csvImportFailure(
          'CSV_PROVENANCE_CONFLICT',
          '同じデータ基準時刻で内容が異なるCSVを検出したため、取込を中断しました。状態は変更されていません。',
        ))
      }
      if (monotonicity.decision === 'REJECT_UNKNOWN_DOWNGRADE') {
        if (!options.confirmUnknownProvenance) {
          return publishFailure(csvImportFailure(
            'CSV_PROVENANCE_UNKNOWN',
            'CSVデータの基準時刻を信頼できず、現在のportfolio generationより新しいと確認できません。状態は変更されていません。内容を確認した上で明示的な再取込が必要です。',
          ))
        }
      }
      const stagedTrustExecution = stageTrustExecutionFromCsvSync(
        updatedT,
        now,
        transaction.trackerPortfolioBaseline,
      )
      const trustExecution = stagedTrustExecution.detection
      const syncSummary = buildCsvSyncSummary(oldHoldings, updatedH, oldTrust, updatedT, trustSync, now)
      const stagedState: AppState = {
        ...baseState,
        holdings: updatedH,
        trust: updatedT,
        system: {
          ...baseState.system,
          csvLastImportedAt: now,
          csvImportProvenance: incomingProvenance,
          csvSyncSummary: syncSummary,
        },
      }

      let computed: ReturnType<typeof runFullAnalysis>
      try {
        setCsvImportTransactionPhase(transaction, 'ANALYZING')
        computed = runFullAnalysis(stagedState, {
          requireOfficialDecision: true,
          nowMs: transaction.analysisNow,
          trustShortInput: transaction.trackerSnapshot,
        })
      } catch (error) {
        const isOfficialDecisionError = error instanceof OfficialDecisionGenerationError
        return publishFailure(csvImportFailure(
          isOfficialDecisionError ? 'OFFICIAL_DECISION_ERROR' : 'ANALYSIS_ERROR',
          isOfficialDecisionError
            ? `公式判断の生成に失敗しました: ${error.message}`
            : `分析に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        ))
      }

      const warnings = [
        ...(monotonicity.decision === 'REJECT_UNKNOWN_DOWNGRADE'
          ? ['CSVデータの基準時刻が不明または参考情報のため、明示確認により取り込みました。']
          : []),
        ...(syncSummary.trust.unknownFunds.length > 0
          ? [`未登録投信 ${syncSummary.trust.unknownFunds.length}件は反映されませんでした。`]
          : []),
        ...(syncSummary.trust.ambiguousFundIds.length > 0
          ? [`口座を一意に特定できない投信 ${syncSummary.trust.ambiguousFundIds.length}件は更新されませんでした。`]
          : []),
      ]
      setCsvImportTransactionPhase(transaction, 'PREPARED')

      if (buildPortfolioAnalysisFingerprint(get()) !== dependencyFingerprint) {
        return publishFailure(csvImportFailure(
          'IMPORT_CONFLICT',
          '取込中に分析条件が変更されました。現在の状態を維持したまま取込を中断しました。再試行してください。',
        ))
      }

      committedSuccess = {
        ok: true,
        code: 'SUCCESS',
        message: `${fileName} の取込み・分析・保存が完了しました。`,
        imported: {
          stock: { ...syncSummary.stock },
          trust: {
            updated: syncSummary.trust.updated,
            reheld: syncSummary.trust.reheld,
            zeroed: syncSummary.trust.zeroed,
            unknown: syncSummary.trust.unknownFunds.length,
            ambiguous: syncSummary.trust.ambiguousFundIds.length,
          },
        },
        warnings,
        analysisCommitted: true,
        officialDecisionCommitted: true,
        persistence: { status: 'committed' },
        importedAt: now,
        provenance: incomingProvenance,
      }

      let persistenceReceipt: ReturnType<typeof persistCsvImportTransaction> | null = null
      const generationCommittedAt = Date.now()
      try {
        setCsvImportTransactionPhase(transaction, 'PERSISTING')
        persistenceReceipt = persistCsvImportTransaction({
          holdings: computed.holdings,
          trust: computed.trust,
          learning: computed.learning,
          importedAt: now,
          provenance: incomingProvenance,
          syncSummary,
          trustShortSnapshot: stagedTrustExecution.snapshot,
        }, generationCommittedAt, transaction.canonicalPreviousRaw)
        durableCommitted = true
        setCsvImportTransactionPhase(transaction, 'COMMITTED')
      } catch (error) {
        setCsvImportTransactionPhase(transaction, 'PREPARED')
        const persistenceStatus = error instanceof CsvImportPersistenceError
          ? error.status
          : 'rollback_failed'
        return publishFailure(csvImportFailure(
          error instanceof CsvImportCanonicalConflictError ? 'IMPORT_CONFLICT' : 'PERSISTENCE_ERROR',
          error instanceof Error ? error.message : String(error),
          persistenceStatus,
        ))
      }

      const currentTrackerFingerprint = getTrustShortReadDependencyFingerprint()
      const postPersistenceFingerprint = buildPortfolioAnalysisFingerprint(get(), currentTrackerFingerprint)
      if (postPersistenceFingerprint !== dependencyFingerprint) {
        const trackerRolledBack = currentTrackerFingerprint === transaction.trackerSnapshot.fingerprint ||
          restoreTrustShortAnalysisInput(transaction.trackerSnapshot, currentTrackerFingerprint)
        const canonicalRolledBack = persistenceReceipt !== null && rollbackCsvImportTransaction(persistenceReceipt)
        if (canonicalRolledBack) durableCommitted = false
        const restoredFingerprint = buildPortfolioAnalysisFingerprint(get())
        if (!trackerRolledBack || !canonicalRolledBack || restoredFingerprint !== dependencyFingerprint) {
          return publishFailure(csvImportFailure(
            'PERSISTENCE_ERROR',
            '保存中に分析条件の競合を検出し、安全な世代へ復旧できませんでした。再読み込み後に再試行してください。',
            'rollback_failed',
          ))
        }
        return publishFailure(csvImportFailure(
          'IMPORT_CONFLICT',
          '保存中に分析条件が変更されたため、保存を取り消しました。現在の状態を維持したまま再試行してください。',
          'rolled_back',
        ))
      }

      const localStorageFreshness = computeLocalStorageFreshness(generationCommittedAt)

      // This is deliberately the final storage operation before global publication. Payload
      // equality is not ownership: only the exact serialized bytes in the receipt prove that
      // this transaction still owns the physical canonical key.
      if (persistenceReceipt === null || !ownsCsvImportCanonicalBytes(persistenceReceipt)) {
        durableCommitted = false
        return publishFailure(csvImportFailure(
          'IMPORT_CONFLICT',
          '保存後にcanonical世代の所有権を失ったため、準備した分析結果は公開しませんでした。外部の保存世代を維持したまま再試行してください。',
          'ownership_lost',
        ))
      }

      // Publish the complete prepared state, including the exact dependency snapshot used by
      // analysis. This is the synchronous commit-section closure: a storage shim or callback
      // cannot leave newer dependencies paired with stale derived output.
      set({
        ...baseState,
        ...computed,
        system: {
          ...baseState.system,
          status: 'success',
          csvLastImportedAt: now,
          csvImportProvenance: incomingProvenance,
          csvSyncSummary: syncSummary,
          analysisLastRunAt: now,
          error: null,
          localStorageFreshness,
        },
      })
      setCsvImportTransactionPhase(transaction, 'PUBLISHED')

      try {
        if (trustExecution.executed && getTrustShortTodayExecutionCount(now) < 1) {
          const state = get()
          const trustPlan = buildTrustPortfolioPlan({
            trust: state.trust,
            market: state.market,
            macro: state.macro,
            news: state.news,
            sqCalendar: state.sqCalendar,
            margin: state.margin,
            flows: state.flows,
            todayEntryCount: getTrustShortTodayExecutionCount(now),
            performance30d:  getTrustShortTrackingStats(transaction.analysisNow),
            noTrade:         checkNoTrade(state).noTrade,
            jpTrustHeadroom: state.universe?.categories.find(c => c.class === 'JP_TRUST')?.diffValue,
            nowMs: transaction.analysisNow,
          })

          recordTrustShortDecision({
            date: now,
            decision: trustPlan.shortTermMode.candidateDirection,
            confidence: trustPlan.shortTermMode.confidence,
            executed: true,
            nikkeiChgPct: state.market.nikkeiChgPct,
            futuresChgPct: trustPlan.marketContext.nikkeiFuturesDirection,
            conditionsPassed: trustPlan.shortTermMode.conditionsPassed,
            vix: trustPlan.marketContext.vix,
            nikkeiVI: trustPlan.marketContext.nikkeiVI,
            volatilitySpread: trustPlan.marketContext.volatilitySpread,
          })
        }
      } catch {
        // Decision history is auxiliary post-commit telemetry; the staged portfolio snapshot
        // itself is already part of the canonical durable generation.
      }

      return committedSuccess
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (durableCommitted && committedSuccess?.ok) {
        try { console.error('[useAppStore] post-commit CSV observer/publish diagnostic', error) } catch { /* diagnostic sink */ }
        return committedSuccess
      }
      const failure = csvImportFailure(
        'UNKNOWN_ERROR',
        'CSV取込中に予期しないエラーが発生しました。状態は変更されていません。再試行してください。',
      )
      void detail
      try { return publishFailure(failure) } catch { return failure }
    } finally {
      if (activeCsvImportTransaction?.token === transaction.token) {
        try {
          if (get().system.status === 'loading') {
            set(s => ({ system: {
              ...s.system,
              status: 'error',
              error: s.system.error ?? 'CSV取込は完了しませんでした。再試行してください。',
            } }))
          }
        } catch {
          // Zustand's in-memory set/get are synchronous; this final guard prevents a thrown
          // observer from turning the action promise into a rejection.
        }
        activeCsvImportTransaction = null
      }
    }
  },

  setTab: (tab) => set({ activeTab: tab }),

  updateHolding: (code, patch) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('updateHolding')
      return
    }
    set(s => ({ holdings: s.holdings.map(h => h.code === code ? { ...h, ...patch } : h) }))
    const computed = runFullAnalysis(get())
    set(computed)
    persistCurrentPortfolioGeneration(get())
  },

  updateTrust: (id, patch) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('updateTrust')
      return
    }
    set(s => ({ trust: s.trust.map(f => f.id === id ? { ...f, ...patch } : f) }))
    const computed = runFullAnalysis(get())
    set(computed)
    persistCurrentPortfolioGeneration(get())
  },

  // P4-A47: jpStockMaxRatio更新 → 再分析 → 永続化
  setPortfolioPolicy: (policy) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('setPortfolioPolicy')
      return
    }
    set({ portfolioPolicy: policy })
    const computed = runFullAnalysis(get())
    set(computed)
    persistPortfolioPolicy(policy)
  },

  // P4.5-A002: 資金前提の手動入力を保存する。入力値は総額として置き換わる
  // （CSV/既定値への加算は行わない）。0以上の整数円に丸めてから保存する。
  setCashAssumptions: ({ cashDeposits, standbyFunds }) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('setCashAssumptions')
      return
    }
    const sanitize = (v: number) => Math.max(0, Math.round(Number.isFinite(v) ? v : 0))
    const next: CashAssumptions = {
      cashDeposits: sanitize(cashDeposits),
      standbyFunds: sanitize(standbyFunds),
      manualOverrideEnabled: true,
      manualUpdatedAt: new Date().toISOString(),
    }
    set({ cashAssumptions: next })
    const computed = runFullAnalysis(get())
    set(computed)
    persistCashAssumptions(next)
  },

  // P4.5-A002: 手動overrideを解除し、既定値（constants/market.ts由来）へ戻す
  clearCashAssumptionsOverride: () => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('clearCashAssumptionsOverride')
      return
    }
    const next: CashAssumptions = { ...get().cashAssumptions, manualOverrideEnabled: false, manualUpdatedAt: null }
    set({ cashAssumptions: next })
    const computed = runFullAnalysis(get())
    set(computed)
    persistCashAssumptions(next)
  },

  // P4.5-A009: export/importで既に検証済みの値をimportする。setCashAssumptionsと異なり、
  // manualUpdatedAtは現在時刻で上書きせずimport元の値をそのまま引き継ぐ（呼び出し側の
  // parseCashAssumptionsImportが不正/欠損時にnullへfallback済み — nullはA008の
  // freshness判定でstale扱いになるため、無警告で「最新」扱いにはならない）。
  importCashAssumptions: ({ cashDeposits, standbyFunds, manualUpdatedAt }) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('importCashAssumptions')
      return
    }
    const sanitize = (v: number) => Math.max(0, Math.round(Number.isFinite(v) ? v : 0))
    const next: CashAssumptions = {
      cashDeposits: sanitize(cashDeposits),
      standbyFunds: sanitize(standbyFunds),
      manualOverrideEnabled: true,
      manualUpdatedAt,
    }
    set({ cashAssumptions: next })
    const computed = runFullAnalysis(get())
    set(computed)
    persistCashAssumptions(next)
  },

  // P4.5-A012b: 保有株・投信・現金前提・portfolioPolicyのportfolio snapshotをexportする。
  // どこにも保存しない — 呼び出し側（UIはA012cで追加）がユーザーに表示し、ユーザー自身がコピーする。
  // cashAssumptionsはrawのstate.cashAssumptionsではなく実効値（selectEffectiveCashAssumptions）を
  // buildExportableCashAssumptionsで変換してexportする（P4.5-A009の既存方針と同一。
  // manualOverrideEnabled=falseの場合、rawのcashDeposits/standbyFundsは実際に使われている値と
  // 一致しないため）。
  exportPortfolioSnapshot: () => {
    const state = get()
    const effective = selectEffectiveCashAssumptions(state)
    const exportableCash = buildExportableCashAssumptions(effective)
    return serializePortfolioSnapshotExport({
      holdings: state.holdings,
      trust: state.trust,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: exportableCash,
      csvImportedAt: state.system.csvLastImportedAt,
    })
  },

  // P4.5-A012b: 他端末でexportしたportfolio snapshotをimportする。
  // parsePortfolioSnapshotImportが既に個々のフィールドを検証済みだが、それに加えて
  // 「この端末のholdings/trustに存在しないcode/idが含まれていないか」を確認する。
  // 今回のsnapshotはname/sector/policy等の静的属性を持たないため、未知の銘柄・投信を
  // 新規作成することはできない（できてしまうと不完全なHolding/Trustが生成されてしまう）。
  // 1件でも未知のcode/idがあれば全体をrejectし、store/localStorageは一切変更しない。
  importPortfolioSnapshot: (raw) => {
    if (isCsvImportCommitCriticalSection()) {
      reportRejectedReentrantMutation('importPortfolioSnapshot')
      return { ok: false, error: 'CSV取込のcommit処理中です。完了後に再試行してください。' }
    }
    const parsed = parsePortfolioSnapshotImport(raw)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const snapshot = parsed.data
    const state = get()

    // P4.5-A013-T7: 古いsnapshotによる逆行防止（v1/v2共通）。両方のtimestampが
    // 判明していて、かつsnapshotの方が厳密に古い場合のみ拒否する
    // （詳細な安全側デフォルトの理由はisSnapshotOlderThanCurrentBasisのコメント参照）。
    if (isSnapshotOlderThanCurrentBasis(snapshot.csvImportedAt, state.system.csvLastImportedAt)) {
      return {
        ok: false,
        error: 'この端末の保有データの方がsnapshotより新しいため、取込を中断しました' +
          '（保有株・投信は変更されていません）。',
      }
    }

    const isV2 = snapshot.schemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2

    let nextHoldings: Holding[]
    if (isV2) {
      // P4.5-A013-T7: v2はholdingsをfull-sync（新規追加・受信端末だけの銘柄削除を含む）
      // する。ガード（消滅率>50%または絶対件数>5件）はapplyHoldingsFullSyncFromSnapshot内。
      const holdingsResult = applyHoldingsFullSyncFromSnapshot(state.holdings, snapshot.holdings)
      if (!holdingsResult.ok) return { ok: false, error: holdingsResult.error }
      nextHoldings = holdingsResult.holdings
    } else {
      // v1: 既存のupdate-only契約を維持する（受信端末に存在しないcodeは全体reject）。
      const currentHoldingCodes = new Set(state.holdings.map(h => h.code))
      const unknownHoldingCodes = snapshot.holdings
        .filter(h => !currentHoldingCodes.has(h.code))
        .map(h => h.code)
      if (unknownHoldingCodes.length > 0) {
        return {
          ok: false,
          error: `この端末に存在しない銘柄コードが含まれています: ${unknownHoldingCodes.join(', ')}`,
        }
      }
      const holdingsSnapshotLike: HoldingsSnapshotLike = {
        holdings: snapshot.holdings.map(row => ({
          code: row.code,
          eval: row.eval,
          pnlPct: row.pnlPct,
          currentPrice: row.currentPrice,
          purchase_date: row.acquiredAt ?? undefined,
        })),
      }
      nextHoldings = applyHoldingsSnapshot(state.holdings, holdingsSnapshotLike)
    }

    // P4.5-A013-T7: trust masterはregistryとして維持し、不完全metadataから
    // Trustを捏造しない（T3の原則）という一線はv1/v2共通で変えない。
    // 違いはunknown idに遭遇した時の扱いのみ:
    //   - v1: 全体reject（既存契約を維持）
    //   - v2: 該当idだけskipし、呼び出し側にskippedTrustIdsとして報告する
    //     （silent ignoreはしない。既知idの通常の値更新は巻き添えでrejectしない）。
    // 既知id側のmerge（eval/pnlPct/dayPct/accountのみ上書き。name/policy/cost/
    // sigma/mu/score/decision/ev等の静的属性・計算結果は保持）はv1/v2で共通。
    const currentTrustIds = new Set(state.trust.map(t => t.id))
    const unknownTrustIds = snapshot.trust.filter(t => !currentTrustIds.has(t.id)).map(t => t.id)
    if (unknownTrustIds.length > 0 && !isV2) {
      return {
        ok: false,
        error: `この端末に存在しない投信IDが含まれています: ${unknownTrustIds.join(', ')}`,
      }
    }
    const skippedTrustIds = isV2 ? unknownTrustIds : []

    const trustRowById = new Map(snapshot.trust.filter(t => currentTrustIds.has(t.id)).map(t => [t.id, t]))
    const nextTrust = state.trust.map(f => {
      const row = trustRowById.get(f.id)
      if (!row) return f
      const patch: Partial<Trust> = { eval: row.eval, pnlPct: row.pnlPct }
      if (row.dayPct !== undefined) patch.dayPct = row.dayPct
      if (row.account !== undefined && row.account !== null) patch.account = row.account
      return { ...f, ...patch }
    })

    const nextPortfolioPolicy: PortfolioPolicy = snapshot.portfolioPolicy
      ? { jpStockMaxRatio: snapshot.portfolioPolicy.jpStockMaxRatio }
      : state.portfolioPolicy

    // cashAssumptionsはimportCashAssumptionsと同じ思想: manualOverrideEnabledは常にtrue、
    // manualUpdatedAtは現在時刻へ差し替えずimport元をそのまま引き継ぐ。
    const nextCashAssumptions: CashAssumptions = snapshot.cashAssumptions
      ? {
          cashDeposits: snapshot.cashAssumptions.cashDeposits,
          standbyFunds: snapshot.cashAssumptions.standbyFunds,
          manualOverrideEnabled: true,
          manualUpdatedAt: snapshot.cashAssumptions.manualUpdatedAt,
        }
      : state.cashAssumptions

    set(s => ({
      holdings: nextHoldings,
      trust: nextTrust,
      portfolioPolicy: nextPortfolioPolicy,
      cashAssumptions: nextCashAssumptions,
      // snapshot.csvImportedAtがnull（exportした端末側でCSV未取込）の場合、この端末が
      // 既に持つcsvLastImportedAtを消してはいけない（逆行防止判定は上のisSnapshotOlderThan
      // CurrentBasisで別途行っており、ここでは「値がある方を優先して保持する」だけでよい）。
      system: {
        ...s.system,
        csvLastImportedAt: typeof snapshot.csvImportedAt === 'string'
          ? snapshot.csvImportedAt
          : s.system.csvLastImportedAt,
        // portfolio snapshotはCSV source provenanceを運ばない。別端末のoperation timeを
        // 引き継ぐ場合、現在端末のCSV sourceAsOf/fingerprintを誤って結び付けない。
        csvImportProvenance: typeof snapshot.csvImportedAt === 'string'
          ? null
          : s.system.csvImportProvenance ?? null,
      },
    }))

    const computed = runFullAnalysis(get())
    const now = new Date().toISOString()
    set(s => ({
      ...computed,
      system: { ...s.system, status: 'success', analysisLastRunAt: now, error: null },
    }))

    persistCurrentPortfolioGeneration(get())
    persistPortfolioPolicy(get().portfolioPolicy)
    persistCashAssumptions(get().cashAssumptions)
    // csvImportedAtがnullの場合、persistCsvImportedAtは文字列専用のため呼ばない
    // （既存localStorageの古い値の削除は次チケットで扱う。store上はnullに揃えている）。
    if (typeof snapshot.csvImportedAt === 'string') {
      persistCsvImportedAt(snapshot.csvImportedAt)
    }
    // P4.5-A013-T6a: persist直後にlocalStorageFreshnessをその場で最新化する。
    // csvSyncSummaryはここでは一切変更しない（snapshot importをCSV取込結果として
    // 偽装しないため。P4.5-A013-T6の方針を維持する）。
    set(s => ({ system: { ...s.system, localStorageFreshness: computeLocalStorageFreshness() } }))
    return { ok: true, skippedTrustIds: skippedTrustIds.length > 0 ? skippedTrustIds : undefined }
  },
  })
})
