import { create, type StateCreator } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AppState, Holding, Trust, TabId, StockScoreRecord, FundPhase7Map, OfficialDecision, OfficialDecisionItem, OfficialDecisionAction, PortfolioPolicy, CashAssumptions, CsvImportProvenance, CsvSyncSummary, SystemState, AllocationPlanSnapshotState } from '../types'
import { DEFAULT_PORTFOLIO_POLICY, DEFAULT_CASH_ASSUMPTIONS } from '../types'
import { INITIAL_HOLDINGS } from '../constants/holdings'
import { INITIAL_TRUST } from '../constants/trust'
import {
  STATIC_MARKET,
  INITIAL_CASH,
  INITIAL_CASH_RESERVE,
  TARGET_ALLOCATION_BEAR,
  TARGET_ALLOCATION_BULL,
  TARGET_ALLOCATION_NEUTRAL,
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
  restorePortfolio,
  restoreTrust,
  restoreLearning,
  restoreCsvImportedAt,
  restoreCsvImportProvenance,
  restoreCsvSyncSummary,
  isCsvMetadataReferenceWithinTtl,
  isCsvMetadataTimestampNotFuture,
  validateCsvImportProvenanceForRestore,
  getCsvImportPayloadCsvImportedAt,
  restoreCsvImportGeneration,
  restoreCsvImportGenerationFromRaw,
  persistCsvImportTransaction,
  readCsvImportCanonicalRaw,
  ownsCsvImportCanonicalBytes,
  rollbackCsvImportTransaction,
  CsvImportCanonicalConflictError,
  CsvImportPersistenceError,
  CsvImportPersistenceIndeterminateError,
  CSV_IMPORT_GENERATION_SCHEMA_V4,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  restorePortfolioPolicy,
  restoreCashAssumptions,
  persistLegacyPortfolioGenerationTransaction,
  getPortfolioStorageFreshness,
  getTrustStorageFreshness,
  type CsvImportPersistencePayload,
  type CsvImportPersistenceReceipt,
  type CsvImportCanonicalWriteContract,
  type CsvImportGenerationRestoreResult,
  type LegacyPersistenceResult,
  type LegacyPortfolioGenerationTransactionResult,
} from './persist'
import {
  evaluateCsvImportMonotonicity,
  InvalidCsvSourceTimestampError,
} from '../domain/csv/csvProvenance'
import { buildAssetUniverse, checkNoTrade } from '../domain/optimization/idealAllocation'
import { updatePerformanceTracker } from '../domain/learning/performanceTracker'
import { buildTrustPortfolioPlan } from '../domain/optimization/trustPortfolio'
import { buildZeroBasePlan } from '../domain/optimization/zeroBase'
import { buildStockPortfolioPlan } from '../domain/optimization/stockPortfolio'
import { buildCommitteeDecision } from '../domain/analysis/committeeDecision'
import { selectMarketDataQuality, selectEffectiveCashAssumptions, selectEffectiveSafeModeActive, selectCashAssumptionsFreshness, selectSafeModeDataQuality, selectCandidateFunnelFreshness } from './selectors'
import { buildCandidateUniverse, scoreCandidates, buildStockCandidatePlan, computeJpStockHeadroom, buildHoldingAllocationCandidates } from '../domain/candidates'
import type { CandidateItem } from '../domain/candidates'
import { buildCandidateDecisionSynthesisFromState } from './candidateDecisionSynthesisComposer'
import type { CandidateDecisionSynthesisSnapshot } from '../types/candidateDecisionSynthesis'
import { computeRoleExposureByRole } from '../domain/candidates/roleExposure'
import { selectCandidatePortfolioFit } from './portfolioFitSelectors'
import {
  buildCandidateAllocationInputs,
  candidateAllocationInstrumentId,
  composeCandidatePortfolioRecommendations,
  type CandidateAllocationInputAdapterResult,
} from '../domain/candidates/candidatePortfolioRecommendation'
import {
  buildTrustAllocationCandidates,
  trustAllocationInstrumentId,
} from '../domain/candidates/trustAllocationCandidates'
import {
  applyCandidateExecutionPriceReferences,
  captureCandidateExecutionPriceReferences,
  resolveHoldingExecutionMetadata,
} from '../domain/candidates/candidateExecutionPriceReference'
import { projectCandidatePortfolioRecommendations } from './candidatePortfolioRecommendation'
import {
  projectSynthesisToOfficialDecision,
  stripCandidateComponentFromOfficialDecision,
} from './synthesisOfficialDecisionProjection'
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
  type TrustShortPortfolioSnapshot,
} from '../domain/learning/trustShortTracker'
import { buildExportableCashAssumptions } from '../utils/cashAssumptionsTransfer'
import {
  NO_CASH_AUTHORITY,
  isValidCashAuthorityRecord,
  normalizeCashAuthorityRecord,
  validateCashAuthorityDraft,
} from '../domain/cash/cashAuthority'
import {
  serializePortfolioSnapshotExport,
  parsePortfolioSnapshotImport,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
  type PortfolioSnapshotHolding,
} from '../utils/portfolioSnapshotTransfer'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'
import { sha256Utf8Hex } from '../domain/csv/csvSemanticIdentity'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type AllocationPlanSnapshot,
  type CandidateInput as AllocationCandidateInput,
  type InstrumentInput as AllocationInstrumentInput,
} from '../types/allocationPlan'
import type { PortfolioFitInputFreshness } from '../types/candidatePortfolioFit'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import { projectAllocationPlanSnapshot, snapshotExecutability } from './allocationPlanSelectors'
import {
  createManualMutationFailure,
  createManualMutationSuccess,
  createPortfolioCoordinationFailure,
  createPortfolioLoadFailure,
  createPortfolioLoadSuccess,
  type ManualMutationResult,
  type ManualPortfolioMutationOperation,
  type PortfolioCoordinationFailure,
  type PortfolioGenerationOperation,
  type PortfolioLoadFailureCode,
  type PortfolioLoadOperation,
  type PortfolioLoadResult,
} from './portfolioOperationResult'
import {
  createPortfolioGenerationLockAdapter,
  type PortfolioGenerationLockAdapter,
} from './portfolioGenerationLock'
import {
  createBrowserPortfolioGenerationInvalidationTransport,
  createPortfolioGenerationInstanceId,
  createPortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationTransport,
} from './portfolioGenerationInvalidationTransport'

// ── アクション型 ─────────────────────────────────────────────
export type PortfolioSnapshotImportResult =
  | { ok: true; code: 'SUCCESS'; skippedTrustIds?: string[] }
  | { ok: true; code: 'DUPLICATE_SNAPSHOT'; skippedTrustIds?: undefined }
  | {
      ok: false
      code:
        | 'INVALID_SNAPSHOT'
        | 'INVALID_SNAPSHOT_PROVENANCE'
        | 'INVALID_SNAPSHOT_GENERATION'
        | 'SNAPSHOT_STALE'
        | 'SNAPSHOT_PROVENANCE_CONFLICT'
        | 'SNAPSHOT_PROVENANCE_UNKNOWN'
        | 'SNAPSHOT_OVERWRITE_BLOCKED'
        // T9-A004-R3d: canonical keyは存在するがJSON/manifest/checksum/schema検証を
        // 通らないpresent-invalid世代。absent（key自体が無い）とは区別され、
        // legacy fallbackにもmutation/analysisにも入らずfail-closedする。
        | 'SNAPSHOT_CANONICAL_INVALID'
        // T9-A004-R3c: analysis/persistence/CAS conflict/ownership lossの構造化失敗。
        // いずれもstore/subscriber副作用0で返し、raw exceptionをUIへ伝播させない。
        | 'SNAPSHOT_ANALYSIS_ERROR'
        | 'SNAPSHOT_PERSISTENCE_ERROR'
        | 'SNAPSHOT_PERSISTENCE_INDETERMINATE'
        | 'SNAPSHOT_OWNERSHIP_LOST'
        | 'IMPORT_CONFLICT'
      error: string
      persistence?: { status: 'indeterminate' }
    }
  | (PortfolioCoordinationFailure & { operation: 'importPortfolioSnapshot' })

interface AppActions {
  // 起動時初期化
  initialize: () => Promise<PortfolioLoadResult>
  // 全データ再取得 → 全再計算 → Store一括更新
  refreshAllData: () => Promise<PortfolioLoadResult>
  // CSV取込 → 即時再分析
  importCsv: (file: File, options?: CsvImportOptions) => Promise<CsvImportResult>
  // タブ切替
  setTab: (tab: TabId) => void
  // holding手動更新（score等）
  updateHolding: (code: string, patch: Partial<Holding>) => Promise<ManualMutationResult>
  // trust手動更新
  updateTrust: (id: string, patch: Partial<Trust>) => Promise<ManualMutationResult>
  // P4-A47: PortfolioPolicy更新（localStorage永続化込み）
  setPortfolioPolicy: (policy: PortfolioPolicy) => Promise<ManualMutationResult>
  // P4.5-A002: 資金前提の手動入力を保存（総額として置き換え、CSV/既定値とは加算しない）
  setCashAssumptions: (input: {
    grossCash: unknown
    safetyReserve: unknown
    pendingOrderCash: unknown
  }) => Promise<ManualMutationResult>
  /** CASH-AUTH-1: 同じ金額を現時点でも正しいと明示的に再確認する（意図的な操作のみ） */
  reconfirmCashAssumptions: () => Promise<ManualMutationResult>
  /**
   * CASH-AUTH-1: 現金権限のTTL失効を検査し、失効していれば実行可能な
   * AllocationPlanSnapshot を無効化して blocked な世代へ作り直す。
   * 権限が有効なら何もしない（TTLは決して延長されない）。
   * @returns 再検証によって状態を変更したか
   */
  revalidateCashAuthorityExpiry: (nowMs?: number) => boolean
  // P4.5-A002: 手動overrideを解除し、既定値（CSV/JSON由来があればそれ、無ければconstants）へ戻す
  clearCashAssumptionsOverride: () => Promise<ManualMutationResult>
  // P4.5-A009: export/importで検証済みの値をimportする（manualUpdatedAtはimport元をそのまま引き継ぐ）
  importCashAssumptions: (input: {
    grossCash: number
    safetyReserve: number
    pendingOrderCash: number | null
    updatedAt: string | null
  }) => Promise<ManualMutationResult>
  // P4.5-A012b: 保有株・投信・現金前提・portfolioPolicyのportfolio snapshotをexport（表示専用の文字列を返すだけ。保存・public出力はしない）
  exportPortfolioSnapshot: () => string
  // P4.5-A012b: 他端末でexportしたportfolio snapshotをimportする（未知のholding code/trust idが含まれる場合は全体rejectしstore/localStorageを変更しない）
  // P4.5-A013-T7: full-sync schema (v2/v3) はunknown trust idをsilent ignoreせずskip+warningとして
  // 呼び出し側へ返す（skippedTrustIds）。全体rejectはしない（他の有効な変更が
  // 巻き添えでrejectされてしまうことを避けるため。詳細はimplementationコメント参照）。
  importPortfolioSnapshot: (raw: string) => Promise<PortfolioSnapshotImportResult>
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
  | 'INVALID_CSV_SOURCE_TIMESTAMP'
  | 'ANALYSIS_ERROR'
  | 'OFFICIAL_DECISION_ERROR'
  | 'PERSISTENCE_ERROR'
  | 'PERSISTENCE_INDETERMINATE'
  | 'IMPORT_CONFLICT'
  | 'IMPORT_IN_PROGRESS'
  | 'STALE_CSV'
  | 'CSV_PROVENANCE_CONFLICT'
  | 'CSV_PROVENANCE_UNKNOWN'
  // T9-A004-R3-FIX-B (R3-F004): canonical keyは存在するが検証を通らないpresent-invalid
  // 世代。absent（key自体が無い）とは区別され、ALLOW_FIRST_IMPORT・自動修復・legacy
  // fallbackのいずれにも入らずfail-closedする（snapshot側のSNAPSHOT_CANONICAL_INVALID
  // と同一のstorage evidence policy）。
  | 'CSV_CANONICAL_INVALID'
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
      persistence: { status: 'not_attempted' | 'rolled_back' | 'rollback_failed' | 'ownership_lost' | 'indeterminate' }
    }
  | (PortfolioCoordinationFailure & { operation: 'importCsv' })

class OfficialDecisionGenerationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'OfficialDecisionGenerationError'
  }
}

function csvImportFailure(
  code: CsvImportErrorCode,
  message: string,
  persistence: 'not_attempted' | 'rolled_back' | 'rollback_failed' | 'ownership_lost' | 'indeterminate' = 'not_attempted',
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
  if (error instanceof InvalidCsvSourceTimestampError) {
    return csvImportFailure(
      'INVALID_CSV_SOURCE_TIMESTAMP',
      'CSVのデータ基準日時が不正です。日時を確認し、タイムゾーン付きISO形式または日付形式で再試行してください。状態は変更されていません。',
    )
  }
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

export type CsvImportTransactionPhase =
  | 'READING'
  | 'STAGING'
  | 'ANALYZING'
  | 'PREPARED'
  | 'PERSISTING'
  | 'COMMITTED'
  | 'PUBLISHED'

interface CsvImportTransaction {
  token: symbol
  origin: 'csv'
  phase: CsvImportTransactionPhase
  analysisNow: number
  initialFingerprint: string
  trackerSnapshot: TrustShortAnalysisInput | null
  trackerPortfolioBaseline: TrustShortPortfolioBaseline | null
  canonicalPreviousRaw: string | null
}

interface SnapshotImportTransaction {
  token: symbol
  origin: 'snapshot'
  phase: CsvImportTransactionPhase
  analysisNow: number
}

// T9-A004-R3a: importCsvとimportPortfolioSnapshotは同一のportfolio generationを
// 書き換えるため、originを問わず単一のtransactionだけが同時に進行できる
// （CSV同士・snapshot同士・CSVとsnapshotの全組み合わせで相互排他する）。
type PortfolioGenerationTransaction = CsvImportTransaction | SnapshotImportTransaction

export type PortfolioGenerationPhaseObserverForTest = (
  origin: PortfolioGenerationTransaction['origin'],
  phase: CsvImportTransactionPhase,
) => void

// Same-session retry evidence only. The incoming unkeyed digest never authorizes an overwrite:
// it can prove a no-op solely while the exact post-import state dependency digest is unchanged.
type SnapshotGenerationCache = {
  incomingIdentity: string
  currentStateIdentity: string
} | null

// RA-008-B2: one transport + one instanceId per runtime instance, bundled so they can
// never be mismatched (an instanceId from one runtime paired with another's transport).
export interface PortfolioGenerationInvalidationRuntimeDependency {
  instanceId: string
  transport: PortfolioGenerationInvalidationTransport
}

interface AppStoreRuntimeInvalidationState {
  instanceId: string
  transport: PortfolioGenerationInvalidationTransport
  unsubscribe: (() => void) | null
  disposed: boolean
  // Local monotonic count of remote events received by THIS runtime instance.
  // Never derived from sender committedAt/Date.now(): a remote tab's wall clock
  // can run behind ours, and treating its timestamp as authoritative could let a
  // genuinely newer commit be misjudged as stale (a false negative).
  receiveSequence: number
  clearWatermark: number
  pending: {
    event: PortfolioGenerationInvalidationEvent
    receivedSequence: number
  } | null
  // RA-008-D1: bound once per store instance in createAppStoreStateCreator, after the Zustand
  // set/get closures exist. Never a module-level singleton — each runtime (default or test)
  // owns its own callback, so instances never cross-publish into one another's store.
  flushPendingToStore: (() => void) | null
}

interface AppStoreRuntime {
  portfolioGenerationLock: PortfolioGenerationLockAdapter
  portfolioGenerationInvalidation: AppStoreRuntimeInvalidationState
  lastLocallyPersistedLegacyProjection: string | null
  lastLocallyPersistedLegacyLearningFingerprint: string | null
  activePortfolioOperation: PortfolioOperationTicket | null
  activePortfolioGenerationTransaction: PortfolioGenerationTransaction | null
  lastAppliedSnapshotGeneration: SnapshotGenerationCache
  testSeams: {
    portfolioGenerationPhaseObserver: PortfolioGenerationPhaseObserverForTest | null
    candidateCompositionBeforeHook: (() => void) | null
    manualPublishBeforeApplyHook: (() => void) | null
    loadPublishBeforeApplyHook: (() => void) | null
    loadRestoreBeforeReadHook: (() => void) | null
  }
}

/** @internal Test-only no-op transport: never touches BroadcastChannel/localStorage/window. */
function createNoopInvalidationTransportForTest(): PortfolioGenerationInvalidationTransport {
  return {
    publish: () => {},
    subscribe: () => () => {},
    dispose: () => {},
  }
}

function createDefaultBrowserInvalidationDependency(): PortfolioGenerationInvalidationRuntimeDependency {
  const instanceId = createPortfolioGenerationInstanceId()
  const transport = createBrowserPortfolioGenerationInvalidationTransport({ instanceId })
  return { instanceId, transport }
}

/** @internal Test factories must not create a real BroadcastChannel/localStorage listener. */
function createDefaultTestInvalidationDependency(): PortfolioGenerationInvalidationRuntimeDependency {
  return {
    instanceId: createPortfolioGenerationInstanceId(),
    transport: createNoopInvalidationTransportForTest(),
  }
}

/**
 * Runtime-local reception only: records the latest remote event and bumps the local
 * receive sequence, then asks the bound store (if any) to project the warning and invalidate
 * its ephemeral allocation snapshot. Must never itself touch localStorage, request the Web Lock, or call
 * transport.publish — production emission/consumption is RA-008-C/D.
 */
function recordPendingCrossTabInvalidation(
  runtime: AppStoreRuntime,
  event: PortfolioGenerationInvalidationEvent,
): void {
  const invalidation = runtime.portfolioGenerationInvalidation
  if (invalidation.disposed) return
  invalidation.receiveSequence += 1
  invalidation.pending = { event, receivedSequence: invalidation.receiveSequence }
  flushPendingCrossTabInvalidationToStore(runtime)
}

/**
 * RA-008-D1: bound callback trampoline. The real logic (Zustand get/set) is bound onto
 * runtime.portfolioGenerationInvalidation.flushPendingToStore by createAppStoreStateCreator;
 * before binding, or once disposed, this is always a no-op (0 publications).
 */
function flushPendingCrossTabInvalidationToStore(runtime: AppStoreRuntime): void {
  runtime.portfolioGenerationInvalidation.flushPendingToStore?.()
}

/**
 * Only production caller is initialize()'s single final publish, after a Web-Lock-verified
 * restore/analysis/persistence/apply has succeeded. A delayed remote event arriving after this
 * clear must still become a new pending (fail-closed over trusting stale sender committedAt).
 */
function clearPendingCrossTabInvalidationAfterVerifiedAlignment(runtime: AppStoreRuntime): void {
  runtime.portfolioGenerationInvalidation.clearWatermark =
    runtime.portfolioGenerationInvalidation.receiveSequence
  runtime.portfolioGenerationInvalidation.pending = null
}

/** @internal Test-instance cleanup only; not exposed for the default application runtime. */
function disposeAppStoreRuntimeInvalidation(runtime: AppStoreRuntime): void {
  const invalidation = runtime.portfolioGenerationInvalidation
  resetRuntimeTestSeams(runtime)
  if (invalidation.disposed) return
  invalidation.disposed = true
  invalidation.pending = null
  invalidation.flushPendingToStore = null
  const unsubscribe = invalidation.unsubscribe
  invalidation.unsubscribe = null
  try {
    unsubscribe?.()
  } catch {
    // unsubscribe must never throw into caller cleanup
  }
  try {
    invalidation.transport.dispose()
  } catch {
    // dispose must never throw into caller cleanup
  }
}

function createAppStoreRuntime(
  portfolioGenerationLock: PortfolioGenerationLockAdapter = createPortfolioGenerationLockAdapter(),
  portfolioGenerationInvalidation: PortfolioGenerationInvalidationRuntimeDependency = createDefaultBrowserInvalidationDependency(),
): AppStoreRuntime {
  const invalidationState: AppStoreRuntimeInvalidationState = {
    instanceId: portfolioGenerationInvalidation.instanceId,
    transport: portfolioGenerationInvalidation.transport,
    unsubscribe: null,
    disposed: false,
    receiveSequence: 0,
    clearWatermark: 0,
    pending: null,
    flushPendingToStore: null,
  }

  const runtime: AppStoreRuntime = {
    portfolioGenerationLock,
    portfolioGenerationInvalidation: invalidationState,
    lastLocallyPersistedLegacyProjection: null,
    lastLocallyPersistedLegacyLearningFingerprint: null,
    activePortfolioOperation: null,
    activePortfolioGenerationTransaction: null,
    lastAppliedSnapshotGeneration: null,
    testSeams: {
      portfolioGenerationPhaseObserver: null,
      candidateCompositionBeforeHook: null,
      manualPublishBeforeApplyHook: null,
      loadPublishBeforeApplyHook: null,
      loadRestoreBeforeReadHook: null,
    },
  }

  invalidationState.unsubscribe = invalidationState.transport.subscribe(event => {
    recordPendingCrossTabInvalidation(runtime, event)
  })

  return runtime
}

const defaultAppStoreRuntime = createAppStoreRuntime()

/** @internal Test-only adapter override for the default store runtime. */
export function setPortfolioGenerationLockAdapterForTest(
  adapter: PortfolioGenerationLockAdapter,
): void {
  defaultAppStoreRuntime.portfolioGenerationLock = adapter
}

/** @internal Restore the default runtime to a fresh production browser adapter. */
export function resetPortfolioGenerationLockAdapterForTest(): void {
  defaultAppStoreRuntime.portfolioGenerationLock = createPortfolioGenerationLockAdapter()
}

function resetRuntimeTestSeams(runtime: AppStoreRuntime): void {
  runtime.testSeams.portfolioGenerationPhaseObserver = null
  runtime.testSeams.candidateCompositionBeforeHook = null
  runtime.testSeams.manualPublishBeforeApplyHook = null
  runtime.testSeams.loadPublishBeforeApplyHook = null
  runtime.testSeams.loadRestoreBeforeReadHook = null
}

function resetAppStoreRuntime(runtime: AppStoreRuntime): void {
  runtime.activePortfolioOperation = null
  runtime.activePortfolioGenerationTransaction = null
  runtime.lastAppliedSnapshotGeneration = null
  runtime.lastLocallyPersistedLegacyProjection = null
  runtime.lastLocallyPersistedLegacyLearningFingerprint = null
  resetRuntimeTestSeams(runtime)
  // Transport subscription is intentionally left untouched: reset re-arms the runtime for
  // more test activity, it does not tear down the cross-tab dependency.
  runtime.portfolioGenerationInvalidation.pending = null
  runtime.portfolioGenerationInvalidation.receiveSequence = 0
  runtime.portfolioGenerationInvalidation.clearWatermark = 0
}

/** @internal Test-only read-only observer; application code must not use. */
export function setPortfolioGenerationPhaseObserverForTest(
  observer: PortfolioGenerationPhaseObserverForTest,
): void {
  defaultAppStoreRuntime.testSeams.portfolioGenerationPhaseObserver = observer
}

/** @internal Test-only one-shot failure injection; application code must not use. */
export function setManualPublishBeforeApplyHookForTest(hook: () => void): void {
  defaultAppStoreRuntime.testSeams.manualPublishBeforeApplyHook = hook
}

/** @internal Test-only one-shot load publication failure injection. */
export function setLoadPublishBeforeApplyHookForTest(hook: () => void): void {
  defaultAppStoreRuntime.testSeams.loadPublishBeforeApplyHook = hook
}

/** @internal Test-only one-shot initialize restore failure injection. */
export function setLoadRestoreBeforeReadHookForTest(hook: () => void): void {
  defaultAppStoreRuntime.testSeams.loadRestoreBeforeReadHook = hook
}

function runLoadPublishBeforeApplyHookForTest(runtime: AppStoreRuntime): void {
  const hook = runtime.testSeams.loadPublishBeforeApplyHook
  runtime.testSeams.loadPublishBeforeApplyHook = null
  hook?.()
}

function runLoadRestoreBeforeReadHookForTest(runtime: AppStoreRuntime): void {
  const hook = runtime.testSeams.loadRestoreBeforeReadHook
  runtime.testSeams.loadRestoreBeforeReadHook = null
  hook?.()
}

/** @internal Reset all module-local RA-006 test seams. */
export function resetPortfolioGenerationTestSeams(): void {
  resetRuntimeTestSeams(defaultAppStoreRuntime)
}

export type PortfolioOperationKind = 'initialize' | 'refresh' | 'csv' | 'snapshot' | 'manual'

export interface PortfolioOperationTicket {
  readonly token: symbol
  readonly kind: PortfolioOperationKind
}

function acquirePortfolioOperationFromRuntime(
  runtime: AppStoreRuntime,
  kind: PortfolioOperationKind,
): PortfolioOperationTicket | null {
  if (runtime.activePortfolioOperation !== null) return null
  const ticket: PortfolioOperationTicket = { token: Symbol(`portfolio-operation:${kind}`), kind }
  runtime.activePortfolioOperation = ticket
  return ticket
}

function releasePortfolioOperationFromRuntime(
  runtime: AppStoreRuntime,
  ticket: PortfolioOperationTicket,
): boolean {
  if (runtime.activePortfolioOperation !== ticket || runtime.activePortfolioOperation.token !== ticket.token) {
    return false
  }
  runtime.activePortfolioOperation = null
  // RA-008-D1: a remote event received while this ticket was held only got recorded, never
  // flushed to Zustand (see flushPendingCrossTabInvalidationToStore's active-operation guard).
  // Whatever the operation's own outcome, a valid release is the one place that backlog can
  // safely surface — this runs after the Web Lock itself has already released.
  flushPendingCrossTabInvalidationToStore(runtime)
  return true
}

export function acquirePortfolioOperation(
  kind: PortfolioOperationKind,
): PortfolioOperationTicket | null {
  return acquirePortfolioOperationFromRuntime(defaultAppStoreRuntime, kind)
}

export function releasePortfolioOperation(ticket: PortfolioOperationTicket): boolean {
  return releasePortfolioOperationFromRuntime(defaultAppStoreRuntime, ticket)
}

function setPortfolioGenerationTransactionPhase(
  runtime: AppStoreRuntime,
  transaction: PortfolioGenerationTransaction,
  phase: CsvImportTransactionPhase,
): void {
  if (runtime.activePortfolioGenerationTransaction?.token !== transaction.token) {
    throw new Error('portfolio generation transaction owner was lost')
  }
  transaction.phase = phase
  runtime.testSeams.portfolioGenerationPhaseObserver?.(transaction.origin, phase)
}

function isPortfolioGenerationCriticalSection(runtime: AppStoreRuntime): boolean {
  const phase = runtime.activePortfolioGenerationTransaction?.phase
  return phase === 'PERSISTING' || phase === 'COMMITTED' || phase === 'PUBLISHED'
}

function reportRejectedReentrantMutation(source: string): void {
  try { console.warn(`[useAppStore] rejected synchronous mutation during portfolio generation commit: ${source}`) } catch { /* diagnostic sink */ }
}

function reportRejectedPortfolioOperation(source: string): void {
  try { console.warn(`[useAppStore] rejected portfolio operation while another operation is active: ${source}`) } catch { /* diagnostic sink */ }
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
type CurrentPortfolioPersistenceResult =
  | { status: 'persisted'; target: 'canonical'; receipt: CsvImportPersistenceReceipt }
  | { status: 'persisted'; target: 'legacy' }
  | {
      status: 'blocked'
      reason: 'canonical_committed' | 'canonical_invalid' | 'canonical_changed' | 'metadata_misaligned'
    }
  | {
      status: 'failed'
      reason?: 'rolled_back' | 'rollback_failed' | 'ownership_lost' | 'indeterminate'
    }

type CsvImportCanonicalSchemaVersion = Extract<
  CsvImportGenerationRestoreResult,
  { status: 'committed' }
>['schemaVersion']

function canonicalReplacementWriteContract(
  schemaVersion: CsvImportCanonicalSchemaVersion,
): CsvImportCanonicalWriteContract {
  return schemaVersion === CSV_IMPORT_GENERATION_SCHEMA_V5
    ? { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 }
    : { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V4 }
}

/**
 * Maps a thrown persistCsvImportTransaction error to the caller-facing persistence result. Pure:
 * no localStorage/Zustand/Web Lock access, and no raw error message/stack ever crosses this
 * boundary — only the already-typed status this codebase already models.
 */
function classifyCurrentPortfolioPersistenceError(
  error: unknown,
): Exclude<CurrentPortfolioPersistenceResult, { status: 'persisted' }> {
  if (error instanceof CsvImportCanonicalConflictError) {
    return { status: 'blocked', reason: 'canonical_changed' }
  }
  if (error instanceof CsvImportPersistenceIndeterminateError) {
    return { status: 'failed', reason: 'indeterminate' }
  }
  if (error instanceof CsvImportPersistenceError) {
    switch (error.status) {
      case 'rolled_back':
        return { status: 'failed', reason: 'rolled_back' }
      case 'rollback_failed':
        return { status: 'failed', reason: 'rollback_failed' }
      case 'indeterminate':
        return { status: 'failed', reason: 'indeterminate' }
      case 'not_attempted':
        return { status: 'failed' }
    }
  }
  return { status: 'failed' }
}

function persistCurrentPortfolioGeneration(
  state: AppState,
  knownCanonical?: CsvImportGenerationRestoreResult,
  knownCanonicalRaw?: string | null,
  savedAt = Date.now(),
): CurrentPortfolioPersistenceResult {
  const canonical = knownCanonical ?? restoreCsvImportGeneration()
  if (canonical.status === 'committed') {
    try {
      const origin = Object.prototype.hasOwnProperty.call(canonical.payload, 'origin')
        ? canonical.payload.origin ?? null
        : null
      const csvImportedAt = knownCanonicalRaw !== undefined
        ? state.system.csvLastImportedAt
        : state.system.csvLastImportedAt ?? getCsvImportPayloadCsvImportedAt(canonical.payload)
      const syncSummary = origin === 'snapshot'
        ? null
        : state.system.csvSyncSummary ?? canonical.payload.syncSummary
      const provenance = state.system.csvImportProvenance ?? null
      const receipt = persistCsvImportTransaction({
        holdings: state.holdings,
        trust: state.trust,
        learning: state.learning,
        csvImportedAt,
        // Never attach a previous canonical generation's provenance to replacement content.
        provenance,
        syncSummary,
        trustShortSnapshot: canonical.payload.trustShortSnapshot,
        portfolioPolicy: state.portfolioPolicy,
        cashAssumptions: state.cashAssumptions,
        // Legacy v1/v2 origin is unknown. Forward migration records that explicitly instead of
        // guessing CSV merely because the old envelope lacked an origin field.
        origin,
        snapshotTransferIdentity: computeSnapshotGenerationIdentity({
          holdings: state.holdings,
          trust: state.trust,
          portfolioPolicy: state.portfolioPolicy,
          cashAssumptions: state.cashAssumptions,
          csvImportedAt,
          csvImportProvenance: provenance,
        }),
      }, savedAt, knownCanonicalRaw, canonicalReplacementWriteContract(canonical.schemaVersion))
      return { status: 'persisted', target: 'canonical', receipt }
    } catch (error) {
      // These historical actions are best-effort persistence. A failed full replacement leaves
      // the previous canonical envelope valid; it must not fall through to partial legacy writes.
      return classifyCurrentPortfolioPersistenceError(error)
    }
  }

  if (canonical.status === 'invalid') return { status: 'blocked', reason: 'canonical_invalid' }

  const result = persistLegacyPortfolioGenerationTransaction({
    holdings: state.holdings,
    trust: state.trust,
    ...(state.learning ? { learning: state.learning } : {}),
  }, savedAt)
  return result.status === 'persisted'
    ? { status: 'persisted', target: 'legacy' }
    : result
}

type PortfolioLoadPhase = 'restore' | 'data' | 'publish' | 'analysis' | 'persistence'

const PORTFOLIO_LOAD_FAILURE_BY_PHASE = {
  restore: 'LOAD_RESTORE_ERROR',
  data: 'LOAD_DATA_ERROR',
  publish: 'LOAD_PUBLISH_ERROR',
  analysis: 'LOAD_ANALYSIS_ERROR',
  persistence: 'LOAD_PERSISTENCE_ERROR',
} as const satisfies Record<PortfolioLoadPhase, PortfolioLoadFailureCode>

// ── RA-007-D2: initialize/refreshAllData Web Lock staging helpers ───────────
// A settled outcome never rejects: network prework starts right after the local ticket (before
// the Web Lock grant) so raw fetch/parse failures can never surface as an unhandled rejection or
// leak past the classified PortfolioLoadResult codes.
type SettledPrework<T> =
  | { ok: true; value: T }
  | { ok: false }

function settlePrework<T>(promise: Promise<T>): Promise<SettledPrework<T>> {
  return promise.then(
    value => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  )
}

type PublishedLoadData = Awaited<ReturnType<typeof loadPublishedData>>

interface Phase7StockRaw {
  _meta?: { kind?: string }
  stock_scores_6axis?: StockScoreRecord[]
}

/**
 * Pure merge of freshly fetched published data (market/correlation/news/trust snapshot/macro/
 * Nikkei VI/SQ/margin/flows/candidates/regime/SAFE_MODE/TierA/Phase 7 scores) onto a staged
 * base state. Never touches Zustand, localStorage, or the network — callers read/write those
 * before or after calling this helper so the whole load stays off-store until the single final
 * publish.
 */
function buildStateWithPublishedData(
  baseState: AppState,
  publishedData: PublishedLoadData,
  options: {
    nowMs: number
    hasCommittedCanonicalGeneration: boolean
    phase7StockRaw?: Phase7StockRaw | null
    localStorageFreshness?: SystemState['localStorageFreshness']
  },
): AppState {
  const {
    market,
    correlation,
    news,
    trust,
    holdingsSnapshot,
    macro,
    nikkeiVI,
    sq,
    margin,
    flows,
    candidatesNews,
    candidatesStocks,
    candidateFunnel = { status: 'unavailable' as const, data: null },
    regimeState,
    safeMode,
    tierAViolations,
    tierAAlerts,
  } = publishedData
  const sourceAsOf = getSafeAuthoritativeCsvSourceAsOf(baseState.system.csvImportProvenance, options.nowMs)
  const hasCurrentGeneration = options.hasCommittedCanonicalGeneration || hasCurrentPortfolioContentEvidence(baseState)
  const nextTrust = trust.data && shouldApplyPublishedSnapshot(trust.lastUpdated, sourceAsOf, hasCurrentGeneration)
    ? baseState.trust.map(f => { const d = trust.data!.find(x => x.id === f.id); return d ? { ...f, ...d } : f })
    : baseState.trust
  const snapshotMergedHoldings = shouldApplyPublishedSnapshot(holdingsSnapshot.lastUpdated, sourceAsOf, hasCurrentGeneration)
    ? applyHoldingsSnapshot(baseState.holdings, holdingsSnapshot.data)
    : baseState.holdings
  const holdingsWithVol = correlation.data
    ? snapshotMergedHoldings.map(h => {
        const v = correlation.data!.volatilities[h.code + '.T']
        return v ? { ...h, sigma: +v.toFixed(3), sigmaSource: 'yfinance' as const } : h
      })
    : snapshotMergedHoldings
  // NikkeiVI merges into macro (v9.0 has no dedicated market field for it yet); only when both
  // the newly fetched macro payload and the NikkeiVI payload exist, matching the pre-D2 behavior
  // that read the just-applied macro back via get() before deciding whether to merge.
  const mergedMacro = macro.data && nikkeiVI.data
    ? { ...macro.data, nikkeiVI: nikkeiVI.data.vi, nikkeiVIChg: nikkeiVI.data.viChg }
    : macro.data

  const isValidScoringData = options.phase7StockRaw != null &&
    options.phase7StockRaw._meta?.kind !== 'sample_contract'
  const normalizedScores: StockScoreRecord[] = isValidScoringData && options.phase7StockRaw?.stock_scores_6axis
    ? options.phase7StockRaw.stock_scores_6axis.map(r => ({ ...r, ticker: r.ticker.replace(/\.T$/, '') }))
    : []

  return {
    ...baseState,
    market: market.data,
    correlation: correlation.data,
    news: news.data,
    trust: nextTrust,
    holdings: holdingsWithVol,
    macro: mergedMacro,
    sqCalendar: sq.data,
    margin: margin.data,
    flows: flows.data,
    candidatesNews: candidatesNews.data,
    candidatesStocks: candidatesStocks.data,
    candidateFunnel: candidateFunnel.status === 'loaded' ? candidateFunnel.data : null,
    regimeState: regimeState.data,
    safeMode: safeMode.data,
    tierAViolations: tierAViolations.data,
    tierAAlerts: tierAAlerts.data,
    stockScores6Axis: normalizedScores,
    fundPhase7: null, // 本番生成物なし — フィクスチャ(phase7_fixture)は使用しない
    system: {
      ...baseState.system,
      ...(options.localStorageFreshness !== undefined
        ? { localStorageFreshness: options.localStorageFreshness }
        : {}),
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
        candidateFunnel: candidateFunnel.status,
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
        candidateFunnel: candidateFunnel.status === 'loaded'
          ? candidateFunnel.data?._meta.generatedAt ?? null
          : null,
        regime: regimeState.generatedAt,
        safeMode: safeMode.lastChecked,
        tierAViolations: tierAViolations.generatedAt,
        tierAAlerts: tierAAlerts.generatedAt,
      },
    },
  }
}

type InitializeRestoreOutcome =
  | { kind: 'invalid' }
  | { kind: 'restored'; state: AppState; hasCommittedCanonicalGeneration: boolean }

/**
 * Bootstrap restore for initialize: the latest durable canonical/legacy generation is always the
 * base, regardless of whatever the just-created local Zustand state currently holds. A present
 * but corrupt canonical envelope fails closed (no legacy fallback, no defaults) instead of mixing
 * possibly partial legacy keys.
 */
function buildInitializeRestoredState(baseState: AppState, nowMs: number): InitializeRestoreOutcome {
  const csvGeneration = restoreCsvImportGeneration()
  if (csvGeneration.status === 'invalid') return { kind: 'invalid' }
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
    ? restoreCsvImportedAt(nowMs)
    : null
  const savedCsvSyncSummary = csvGeneration.status === 'committed' || useLegacy
    ? restoreCsvSyncSummary(nowMs)
    : null
  const savedCsvProvenance = csvGeneration.status === 'committed'
    ? restoreCsvImportProvenance(csvGeneration.payload, nowMs)
    : null
  const hasCommittedCanonicalGeneration = csvGeneration.status === 'committed'
  const savedPolicy = csvGeneration.status === 'committed'
    ? csvGeneration.payload.portfolioPolicy ?? DEFAULT_PORTFOLIO_POLICY
    : useLegacy ? restorePortfolioPolicy() ?? DEFAULT_PORTFOLIO_POLICY : DEFAULT_PORTFOLIO_POLICY
  // CASH-AUTH-1: canonical payload には未移行の legacy スキーマが残りうる。
  // store へ載せる直前に決定的・冪等に移行し、壊れた値は権限なしへ fail closed する。
  const savedCashAssumptions = csvGeneration.status === 'committed'
    ? (csvGeneration.payload.cashAssumptions
        ? normalizeCashAuthorityRecord(csvGeneration.payload.cashAssumptions) ?? { ...NO_CASH_AUTHORITY }
        : DEFAULT_CASH_ASSUMPTIONS)
    : useLegacy ? restoreCashAssumptions() ?? DEFAULT_CASH_ASSUMPTIONS : DEFAULT_CASH_ASSUMPTIONS

  const state: AppState = {
    ...baseState,
    ...(savedPortfolio ? { holdings: savedPortfolio } : {}),
    ...(savedTrust ? { trust: savedTrust } : {}),
    ...(savedLearning ? { learning: savedLearning } : {}),
    portfolioPolicy: savedPolicy,
    cashAssumptions: savedCashAssumptions,
    system: {
      ...baseState.system,
      ...(csvGeneration.status === 'committed'
        ? { csvLastImportedAt: savedCsvAt, csvSyncSummary: savedCsvSyncSummary }
        : {
            ...(savedCsvAt ? { csvLastImportedAt: savedCsvAt } : {}),
            ...(savedCsvSyncSummary ? { csvSyncSummary: savedCsvSyncSummary } : {}),
          }),
      csvImportProvenance: savedCsvProvenance,
      localStorageFreshness: computeLocalStorageFreshness(nowMs),
    },
  }
  return { kind: 'restored', state, hasCommittedCanonicalGeneration }
}

/**
 * refreshAllData is not a bootstrap: a future/expired local CSV metadata reading must not persist
 * forward across refreshes just because a clock skewed once. This mirrors the pre-D2 refresh
 * safety net, applied to the state captured at Web Lock grant time instead of inside a set().
 */
function sanitizeRefreshCsvMetadata(baseState: AppState, nowMs: number): AppState {
  const safeCsvLastImportedAt = isCsvMetadataTimestampNotFuture(baseState.system.csvLastImportedAt, nowMs)
    ? baseState.system.csvLastImportedAt
    : null
  const safeCsvImportProvenance = validateCsvImportProvenanceForRestore(baseState.system.csvImportProvenance, nowMs)
  const safeCsvSyncSummary = baseState.system.csvSyncSummary &&
    isCsvMetadataTimestampNotFuture(baseState.system.csvSyncSummary.importedAt, nowMs)
    ? baseState.system.csvSyncSummary
    : null
  return {
    ...baseState,
    system: {
      ...baseState.system,
      csvLastImportedAt: safeCsvLastImportedAt,
      csvImportProvenance: safeCsvImportProvenance,
      csvSyncSummary: safeCsvSyncSummary,
    },
  }
}

/** Persist-before-publish classification shared by initialize/refreshAllData (RA-007-D2). */
function classifyLoadPersistenceFailure(
  operation: PortfolioLoadOperation,
  result: Exclude<CurrentPortfolioPersistenceResult, { status: 'persisted' }>,
): PortfolioLoadResult {
  const conflict =
    (result.status === 'blocked' &&
      (result.reason === 'canonical_changed' ||
        result.reason === 'canonical_committed' ||
        result.reason === 'metadata_misaligned')) ||
    (result.status === 'failed' && result.reason === 'ownership_lost')
  return conflict
    ? createPortfolioCoordinationFailure(operation, 'PORTFOLIO_GENERATION_CONFLICT')
    : createPortfolioLoadFailure(operation, 'LOAD_PERSISTENCE_ERROR')
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

function hasCurrentPortfolioContentEvidence(state: AppState): boolean {
  return state.holdings.length > 0 ||
    state.trust.some(fund => fund.eval > 0) ||
    state.portfolioPolicy.jpStockMaxRatio !== DEFAULT_PORTFOLIO_POLICY.jpStockMaxRatio ||
    // CASH-AUTH-1: 現金権限が設定済み（MANUAL）であること自体がユーザー入力の証跡
    state.cashAssumptions.source === 'MANUAL'
}

function computeCurrentSnapshotStateIdentity(state: AppState): string | null {
  try {
    return computeSnapshotGenerationIdentity({
      holdings: state.holdings,
      trust: state.trust,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      csvImportedAt: state.system.csvLastImportedAt,
      csvImportProvenance: state.system.csvImportProvenance ?? null,
    })
  } catch {
    return null
  }
}

// T9-A004-R3d: committed canonical envelopeをcurrent generation evidenceへ射影する。
// storeがempty/partial/staleでも、durableに成立した世代のholdings・trust・policy・
// cash・importedAt・provenanceが取込判定のauthorityになる（Zustandへのhydrateを
// 経由せず、判定前のstore mutationは0のまま）。
function computeCanonicalSnapshotStateIdentity(payload: CsvImportPersistencePayload): string | null {
  try {
    if (payload.snapshotTransferIdentity) return payload.snapshotTransferIdentity
    return computeSnapshotGenerationIdentity({
      holdings: payload.holdings,
      trust: payload.trust,
      portfolioPolicy: payload.portfolioPolicy ?? { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: payload.cashAssumptions ?? { ...DEFAULT_CASH_ASSUMPTIONS },
      csvImportedAt: getCsvImportPayloadCsvImportedAt(payload),
      csvImportProvenance: payload.provenance ?? null,
    })
  } catch {
    return null
  }
}

/** @internal Test-only read access for subscriber-order assertions; application code must not use. */
export function readLastAppliedSnapshotGenerationForTest(): Readonly<{
  incomingIdentity: string
  currentStateIdentity: string
}> | null {
  return defaultAppStoreRuntime.lastAppliedSnapshotGeneration
}

interface PortfolioGenerationProjection {
  holdings: Holding[]
  trust: Trust[]
  portfolioPolicy: PortfolioPolicy
  cashAssumptions: CashAssumptions
  csvLastImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
  csvSyncSummary: CsvSyncSummary | null
}

type DurableAlignmentResult =
  | { status: 'aligned'; canonical: CsvImportGenerationRestoreResult; canonicalRaw: string | null }
  | { status: 'stale' }
  | { status: 'invalid'; canonicalInvalid: boolean }

const LEGACY_PORTFOLIO_GENERATION_KEYS = [
  'v81_portfolio',
  'v81_trust',
  'v13_portfolio_policy',
  'v13_cash_assumptions',
  'v10_csv_imported_at',
  'v13_csv_sync_summary',
  'v91_learning',
] as const

function normalizeCsvMetadataProjection(
  csvLastImportedAt: string | null,
  csvImportProvenance: CsvImportProvenance | null,
  csvSyncSummary: CsvSyncSummary | null,
  nowMs: number,
): Pick<PortfolioGenerationProjection, 'csvLastImportedAt' | 'csvImportProvenance' | 'csvSyncSummary'> {
  const retentionValid = isCsvMetadataReferenceWithinTtl({
    provenance: csvImportProvenance,
    csvImportedAt: csvLastImportedAt,
    syncSummaryImportedAt: csvSyncSummary?.importedAt,
  }, nowMs)
  return {
    csvLastImportedAt: retentionValid && csvLastImportedAt !== null &&
        isCsvMetadataTimestampNotFuture(csvLastImportedAt, nowMs)
      ? csvLastImportedAt
      : null,
    csvImportProvenance: csvImportProvenance === null
      ? null
      : validateCsvImportProvenanceForRestore(csvImportProvenance, nowMs),
    csvSyncSummary: retentionValid && csvSyncSummary !== null &&
        isCsvMetadataTimestampNotFuture(csvSyncSummary.importedAt, nowMs)
      ? csvSyncSummary
      : null,
  }
}

function buildPublishedPortfolioGenerationProjection(
  state: AppState,
  nowMs: number,
): PortfolioGenerationProjection {
  return {
    holdings: state.holdings,
    trust: state.trust,
    portfolioPolicy: state.portfolioPolicy,
    cashAssumptions: state.cashAssumptions,
    ...normalizeCsvMetadataProjection(
      state.system.csvLastImportedAt,
      state.system.csvImportProvenance ?? null,
      state.system.csvSyncSummary ?? null,
      nowMs,
    ),
  }
}

function buildCanonicalPortfolioGenerationProjection(
  payload: CsvImportPersistencePayload,
  nowMs: number,
): PortfolioGenerationProjection {
  return {
    holdings: payload.holdings,
    trust: payload.trust,
    portfolioPolicy: payload.portfolioPolicy ?? { ...DEFAULT_PORTFOLIO_POLICY },
    // CASH-AUTH-1: 比較の両辺を同じ現行スキーマへ正規化する。未移行の canonical
    // 世代を「他タブが書き換えた」と誤検知して手動操作を止めないための同値化。
    cashAssumptions: payload.cashAssumptions
      ? normalizeCashAuthorityRecord(payload.cashAssumptions) ?? { ...NO_CASH_AUTHORITY }
      : { ...DEFAULT_CASH_ASSUMPTIONS },
    ...normalizeCsvMetadataProjection(
      getCsvImportPayloadCsvImportedAt(payload),
      payload.provenance ?? null,
      payload.syncSummary,
      nowMs,
    ),
  }
}

function stableStructuralValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableStructuralValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableStructuralValue(child)]))
}

function portfolioGenerationProjectionsEqual(
  left: PortfolioGenerationProjection,
  right: PortfolioGenerationProjection,
): boolean {
  return JSON.stringify(stableStructuralValue(left)) ===
    JSON.stringify(stableStructuralValue(right))
}

/**
 * Legacy-only self-persist cache key for holdings/trust/portfolioPolicy/cashAssumptions/CSV
 * metadata. Deliberately excludes `learning` — that field is verified separately and
 * unconditionally via `lastLocallyPersistedLegacyLearningFingerprint` in
 * inspectDurablePortfolioAlignment, since (unlike this projection) it can be mutated directly by
 * a non-cooperative writer without ever touching this runtime's own published state.
 */
function buildLegacyProjectionOnlyFingerprint(state: AppState, nowMs: number): string {
  return JSON.stringify(stableStructuralValue(buildPublishedPortfolioGenerationProjection(state, nowMs)))
}

/**
 * Re-reads v91_learning right after a successful legacy-mode persist and caches its fingerprint
 * as this runtime's own recognized write. Not every legacy writer's persistLegacy callback
 * includes `learning` (e.g. setPortfolioPolicy/setCashAssumptions touch only their own key), so
 * trusting `finalState.learning` directly here would wrongly cache a value that was never
 * actually durably written; reading disk back is the only way to know what is actually there.
 */
function syncLegacyLearningFingerprintFromDisk(runtime: AppStoreRuntime): void {
  runtime.lastLocallyPersistedLegacyLearningFingerprint =
    JSON.stringify(stableStructuralValue(restoreLearning()))
}

/**
 * RA-008-C1: reuses the existing alignment-projection equality rather than a second diff
 * formula. A comparison failure (e.g. an unstringifiable value) falls back to "unchanged" —
 * notification is best-effort only (RA-007's Web Lock + grant-time stale check own
 * correctness), so a missed emit is safe while a spurious one is not.
 */
function portfolioGenerationProjectionChanged(
  before: PortfolioGenerationProjection,
  after: PortfolioGenerationProjection,
): boolean {
  try {
    return !portfolioGenerationProjectionsEqual(before, after)
  } catch {
    return false
  }
}

/**
 * RA-008-C1: best-effort cross-tab notification only — never authoritative, never blocks or
 * rolls back the caller's durable commit or local publication. Exactly-once is the caller's
 * responsibility (call this at most once per durable commit); this never retries.
 */
function emitPortfolioGenerationInvalidationAfterCommit(
  runtime: AppStoreRuntime,
  input: { operation: PortfolioGenerationOperation; committedAtMs: number },
): void {
  try {
    const event = createPortfolioGenerationInvalidationEvent({
      senderInstanceId: runtime.portfolioGenerationInvalidation.instanceId,
      operation: input.operation,
      committedAt: new Date(input.committedAtMs).toISOString(),
    })
    runtime.portfolioGenerationInvalidation.transport.publish(event)
  } catch {
    // notification is best-effort only; correctness never depends on delivery
  }
}

function inspectDurablePortfolioAlignment(
  runtime: AppStoreRuntime,
  state: AppState,
  nowMs: number,
): DurableAlignmentResult {
  let canonicalRaw: string | null
  try {
    canonicalRaw = readCsvImportCanonicalRaw()
  } catch {
    return { status: 'invalid', canonicalInvalid: false }
  }
  const canonical = restoreCsvImportGenerationFromRaw(canonicalRaw)
  if (canonical.status === 'invalid') {
    return { status: 'invalid', canonicalInvalid: true }
  }
  const publishedProjection = buildPublishedPortfolioGenerationProjection(state, nowMs)
  if (canonical.status === 'committed') {
    return portfolioGenerationProjectionsEqual(
      publishedProjection,
      buildCanonicalPortfolioGenerationProjection(canonical.payload, nowMs),
    )
      ? { status: 'aligned', canonical, canonicalRaw }
      : { status: 'stale' }
  }

  let legacyRaw: Array<string | null>
  try {
    legacyRaw = LEGACY_PORTFOLIO_GENERATION_KEYS.map(key => localStorage.getItem(key))
  } catch {
    return { status: 'invalid', canonicalInvalid: false }
  }
  if (legacyRaw.every(raw => raw === null)) {
    runtime.lastLocallyPersistedLegacyProjection = null
    runtime.lastLocallyPersistedLegacyLearningFingerprint = null
    return { status: 'aligned', canonical, canonicalRaw }
  }
  // v91_learning is verified unconditionally, before (and independent of) the projection
  // shortcut below. A non-cooperative external mutation can rewrite it directly without ever
  // touching this runtime's own published state, so "live state hasn't changed since our last
  // write" cannot stand in as proof the disk content is still ours the way it can for
  // holdings/trust/portfolioPolicy/cashAssumptions — those four are only ever written through
  // this same Web-Lock-protected code, so skipping their re-read when live state is unchanged is
  // safe. Gating this learning check behind that same shortcut would let it go stale-blind
  // whenever nothing else changed, exactly the scenario the shortcut exists to skip.
  if (legacyRaw[6] !== null) {
    const legacyLearning = restoreLearning()
    if (legacyLearning === null) return { status: 'stale' }
    const diskLearningFingerprint = JSON.stringify(stableStructuralValue(legacyLearning))
    // learning is recomputed on every load operation (fresh lastUpdated/outcomes each run), so a
    // plain live-state-vs-disk compare would misfire whenever this runtime's own durable write
    // outran its own publish (e.g. a load's publish-before-apply hook failing after persistence
    // already committed) — the disk content is legitimately this runtime's own generation even
    // though the published state has not caught up yet. lastLocallyPersistedLegacyLearningFingerprint
    // recognizes that case; only content nobody here just wrote is compared against live state.
    const recognizedAsOwnWrite =
      runtime.lastLocallyPersistedLegacyLearningFingerprint === diskLearningFingerprint
    if (!recognizedAsOwnWrite &&
        JSON.stringify(stableStructuralValue(state.learning ?? null)) !== diskLearningFingerprint) {
      return { status: 'stale' }
    }
  }
  if (runtime.lastLocallyPersistedLegacyProjection ===
      JSON.stringify(stableStructuralValue(publishedProjection))) {
    return { status: 'aligned', canonical, canonicalRaw }
  }
  const legacyHoldings = restorePortfolio()
  const legacyTrust = restoreTrust()
  const legacyPolicy = restorePortfolioPolicy()
  const legacyCash = restoreCashAssumptions()
  if (
    (legacyRaw[0] !== null && legacyHoldings === null) ||
    (legacyRaw[1] !== null && legacyTrust === null) ||
    (legacyRaw[2] !== null && legacyPolicy === null) ||
    (legacyRaw[3] !== null && legacyCash === null)
  ) {
    return { status: 'stale' }
  }
  // A legacy portfolio generation is provable only when both core collections exist. Optional
  // legacy fields are compared when present; absent optional keys carry no overwrite authority.
  if (legacyHoldings === null || legacyTrust === null) return { status: 'stale' }
  if (!portfolioGenerationProjectionsEqual(
    { ...publishedProjection, portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null },
    { holdings: legacyHoldings, trust: legacyTrust,
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY, cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
  )) return { status: 'stale' }
  if (legacyRaw[2] !== null &&
      JSON.stringify(stableStructuralValue(state.portfolioPolicy)) !==
        JSON.stringify(stableStructuralValue(legacyPolicy))) return { status: 'stale' }
  if (legacyRaw[3] !== null &&
      JSON.stringify(stableStructuralValue(state.cashAssumptions)) !==
        JSON.stringify(stableStructuralValue(legacyCash))) return { status: 'stale' }
  const legacyMetadata = normalizeCsvMetadataProjection(
    restoreCsvImportedAt(nowMs),
    null,
    restoreCsvSyncSummary(nowMs),
    nowMs,
  )
  if ((legacyRaw[4] !== null || legacyRaw[5] !== null) &&
      JSON.stringify(stableStructuralValue({
        csvLastImportedAt: publishedProjection.csvLastImportedAt,
        csvImportProvenance: publishedProjection.csvImportProvenance,
        csvSyncSummary: publishedProjection.csvSyncSummary,
      })) !== JSON.stringify(stableStructuralValue(legacyMetadata))) return { status: 'stale' }
  return { status: 'aligned', canonical, canonicalRaw }
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

function getSafeAuthoritativeCsvSourceAsOf(
  provenance: CsvImportProvenance | null | undefined,
  nowMs: number,
): string | null {
  const validated = validateCsvImportProvenanceForRestore(provenance, nowMs)
  return validated?.sourceAsOfConfidence === 'authoritative'
    ? validated.sourceAsOf
    : null
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
// CAND-SYN-1C / D14 (P2-1 writer stop): the monetary fields are no longer set.
// `amount` / `suggestedAmount` / `maxAmount` / `candidateSizingTier` came from
// applyCandidateConstraints + SIZING_TIER_LIMIT — a parallel yen authority that
// contradicted AllocationPlan. This converter is retained for legacy structural
// compatibility only; the production candidate writer is
// projectSynthesisToOfficialDecision, which is the sole append path.
export function candidateToOfficialDecisionItem(candidate: CandidateItem): OfficialDecisionItem {
  return {
    id: `candidate-${candidate.id}`,
    assetType: candidate.assetType,
    name: candidate.name,
    action: candidate.action,
    reason: candidate.reason,
    candidateScore: candidate.score / 100,
    blockedReason: candidate.blockedReasons[0],
    source: 'candidate',
    isCandidate: true,
    candidateSource: candidate.source,
    constraintsPassed: Object.entries(candidate.constraints)
      .filter(([, v]) => v === 'pass')
      .map(([k]) => k),
    constraintsBlocked: candidate.blockedReasons.length > 0 ? candidate.blockedReasons : undefined,
  }
}

// ── HR-I2 AllocationPlanSnapshot input adapter ──────────────────────
export interface AllocationPlanInputAdapterOptions {
  generatedAt: string
  holdingsFreshness?: PortfolioFitInputFreshness
  sourceHoldingsSnapshotId?: string | null
  sourceSettingsVersion?: string | null
  instruments?: readonly AllocationInstrumentInput[]
  candidates?: readonly AllocationCandidateInput[]
  cash?: Partial<AllocationPlanInput['cash']>
  budgets?: Partial<AllocationPlanInput['budgets']>
  policy?: Partial<AllocationPlanInput['policy']>
  safetyState?: Partial<Omit<AllocationPlanInput['safetyState'], 'holdings'>>
  candidateCapture?: CandidateAllocationInputAdapterResult
}

const PORTFOLIO_SOURCE_STALE_MS = 90 * 24 * 60 * 60 * 1000

function assessAllocationHoldingsFreshness(state: AppState, nowMs: number): PortfolioFitInputFreshness {
  if (state.system.crossTabInvalidation?.status === 'stale') return 'stale'
  const provenance = state.system.csvImportProvenance ?? null
  if (state.system.csvLastImportedAt === null && provenance === null) return 'unavailable'
  if (provenance === null || provenance.sourceAsOf === null) return 'partial'
  if (provenance.sourceAsOfConfidence !== 'authoritative') return 'partial'
  const sourceMs = Date.parse(provenance.sourceAsOf)
  if (!Number.isFinite(sourceMs) || sourceMs > nowMs) return 'invalid'
  return nowMs - sourceMs > PORTFOLIO_SOURCE_STALE_MS ? 'stale' : 'fresh'
}

function collapseAllocationHoldingsFreshness(
  freshness: PortfolioFitInputFreshness,
): AllocationPlanInput['safetyState']['holdings'] {
  if (freshness === 'fresh' || freshness === 'partial') return freshness
  return 'stale'
}

function allocationAssetClassForTrust(policy: Trust['policy']): AllocationInstrumentInput['assetClass'] {
  if (policy === 'JAPAN_SHORTTERM') return 'JP_TRUST'
  if (policy === 'GOLD') return 'GOLD'
  return 'OVERSEAS_TRUST'
}

function defaultAllocationInstruments(state: AppState): AllocationInstrumentInput[] | null {
  const stockInstruments: AllocationInstrumentInput[] = []
  const stockIds = new Set<string>()
  for (const holding of state.holdings) {
    const instrumentId = candidateAllocationInstrumentId(holding.code)
    if (instrumentId === null || stockIds.has(instrumentId)) return null
    stockIds.add(instrumentId)
    // CAND-SYN-1C / DDR-1 §7.2: population A (held JP_STOCK) execution metadata.
    // holding.currentPrice is the only accepted authority and is normalized with
    // the same Math.ceil rule as new stocks; missing/invalid price keeps both
    // fields null and the engine fail-closes to a non-executable ADD.
    const execution = resolveHoldingExecutionMetadata(holding.currentPrice)
    stockInstruments.push({
      instrumentId,
      assetClass: 'JP_STOCK' as const,
      kind: 'jp_stock' as const,
      relationship: 'already_held' as const,
      currentAmount: holding.eval,
      role: holding.sector,
      reason: 'canonical holding projection',
      priceJpy: execution.priceJpy,
      lotSizeShares: execution.lotSizeShares,
    })
  }
  const trustInstruments: AllocationInstrumentInput[] = []
  const trustIds = new Set<string>()
  for (const trust of state.trust) {
    const instrumentId = trustAllocationInstrumentId(trust)
    if (instrumentId === null || trustIds.has(instrumentId)) return null
    trustIds.add(instrumentId)
    trustInstruments.push({
      instrumentId,
      assetClass: allocationAssetClassForTrust(trust.policy),
      kind: trust.policy === 'JAPAN_SHORTTERM'
        ? 'jp_trust' as const
        : trust.policy === 'GOLD'
          ? 'gold' as const
          : 'global_trust' as const,
      relationship: trust.eval > 0 ? 'already_held' as const : 'new_to_portfolio' as const,
      currentAmount: trust.eval,
      role: trust.policy,
      reason: 'canonical trust projection',
      priceJpy: null,
      lotSizeShares: null,
    })
  }
  return [...stockInstruments, ...trustInstruments]
}
export function mergeAllocationInstruments(
  base: readonly AllocationInstrumentInput[],
  candidates: readonly AllocationInstrumentInput[],
): AllocationInstrumentInput[] | null {
  const merged = [...base]
  const identities = new Set(base.map(instrument => instrument.instrumentId))
  for (const candidate of candidates) {
    if (identities.has(candidate.instrumentId)) return null
    identities.add(candidate.instrumentId)
    merged.push(candidate)
  }
  return merged
}

/**
 * Builds one coherent engine generation from one captured AppState object. It never calls get(),
 * reads storage, or reconstructs numbers from presentation strings.
 */
export function buildAllocationPlanInput(
  state: AppState,
  options: AllocationPlanInputAdapterOptions,
): AllocationPlanInput | null {
  const nowMs = Date.parse(options.generatedAt)
  if (!Number.isFinite(nowMs)) return null
  try {
    const sourceHoldingsSnapshotId = options.sourceHoldingsSnapshotId === undefined
      ? computeSnapshotGenerationIdentity({
          holdings: state.holdings,
          trust: state.trust,
          portfolioPolicy: null,
          cashAssumptions: null,
          csvImportedAt: state.system.csvLastImportedAt,
          csvImportProvenance: state.system.csvImportProvenance ?? null,
        })
      : options.sourceHoldingsSnapshotId
    const sourceSettingsVersion = options.sourceSettingsVersion === undefined
      ? computeSnapshotGenerationIdentity({
          holdings: [],
          trust: [],
          portfolioPolicy: state.portfolioPolicy,
          cashAssumptions: state.cashAssumptions,
          csvImportedAt: null,
          csvImportProvenance: null,
        })
      : options.sourceSettingsVersion
    if (!sourceHoldingsSnapshotId || !sourceSettingsVersion) return null

    // CASH-AUTH-1: 現金権限を検証済みの source authority として engine へ渡す。
    // engine（deriveCashModel）の fail-closed 挙動・headroom・cap は一切変更しない。
    const effectiveCash = selectEffectiveCashAssumptions(state)
    const cashFreshness = selectCashAssumptionsFreshness(state, nowMs)
    const grossCash = effectiveCash.grossCash
    const holdingsFreshness = options.holdingsFreshness
      ?? assessAllocationHoldingsFreshness(state, nowMs)
    const crossTab = state.system.crossTabInvalidation?.status === 'stale' ? 'stale' : 'current'
    const dqSuppressed = selectMarketDataQuality(state, nowMs).isSuppressed
    const noTrade = checkNoTrade(state)
    const safeModeQuality = selectSafeModeDataQuality(state, nowMs)
    const safeMode = state.safeMode.safe_mode.active
      ? 'active'
      : safeModeQuality.level === 'unavailable'
        ? 'unavailable'
        : safeModeQuality.isStale ? 'stale' : 'inactive'
    const tierA = state.tierAViolations.violations.some(item => item.triggered)
      ? 'hard'
      : state.tierAAlerts.alerts.some(item => item.triggered) ? 'soft' : 'normal'
    const targetAllocation = state.market.regime === 'bull'
      ? TARGET_ALLOCATION_BULL
      : state.market.regime === 'bear' ? TARGET_ALLOCATION_BEAR : TARGET_ALLOCATION_NEUTRAL
    const candidateCapture = options.candidateCapture ?? buildCandidateAllocationInputs({
      artifact: state.candidateFunnel,
      holdings: state.holdings,
    })
    const trustCandidateCapture = options.candidates === undefined
      ? buildTrustAllocationCandidates({ trust: state.trust })
      : null
    if (trustCandidateCapture?.status === 'invalid') return null
    // CAND-SYN-1B-R1: Population A（既存保有JP_STOCK）を BUY_MORE candidate として
    // 注入する。金額執行（lot/price activation）は 1C まで NOT_ACTIVE のまま。
    const holdingCandidateCapture = options.candidates === undefined
      ? buildHoldingAllocationCandidates({ holdings: state.holdings })
      : null
    if (holdingCandidateCapture?.status === 'invalid') return null
    // CAND-SYN-1C / DDR-1 §3.4-§3.9: population B (new JP_STOCK) execution
    // metadata. The join always starts from the authorized funnel candidate's
    // own code — never from candidates_stocks — and only an AVAILABLE reference
    // (fresh dataset, single exact normalized match, dataStatus ok, finite
    // positive price) activates priceJpy = ceil(raw) and lotSizeShares = 100.
    // Candidate eligibility, tier, marketRank and portfolioFit are untouched.
    const candidateExecutionPrices = captureCandidateExecutionPriceReferences({
      candidatesStocks: state.candidatesStocks,
      candidatesStocksSource: state.system.dataSourceStatus.candidatesStocks ?? 'default',
      now: nowMs,
      candidates: candidateCapture.candidates.flatMap(candidate => {
        const raw = state.candidateFunnel?.candidates[candidate.artifactIndex]
        return raw !== undefined
          && candidateAllocationInstrumentId(raw.code) === candidate.instrumentId
          ? [{ instrumentId: candidate.instrumentId, code: raw.code }]
          : []
      }),
    }).references
    const defaultInstruments = defaultAllocationInstruments(state)
    const instruments = options.instruments === undefined
      ? defaultInstruments === null
        ? null
        : mergeAllocationInstruments(
            defaultInstruments,
            applyCandidateExecutionPriceReferences(
              candidateCapture.instruments,
              candidateExecutionPrices,
            ),
          )
      : [...options.instruments]
    if (instruments === null) return null
    const candidates = options.candidates === undefined
      ? [
          ...(holdingCandidateCapture?.candidates ?? []),
          ...candidateCapture.candidates,
          ...(trustCandidateCapture?.candidates ?? []),
        ]
      : [...options.candidates]
    const candidateBuyKindByInstrument = new Map<string, AllocationCandidateInput['buyKind']>()
    for (const candidate of candidates) {
      const existingBuyKind = candidateBuyKindByInstrument.get(candidate.instrumentId)
      if (existingBuyKind !== undefined && existingBuyKind !== candidate.buyKind) return null
      candidateBuyKindByInstrument.set(candidate.instrumentId, candidate.buyKind)
    }
    const candidateFreshness = selectCandidateFunnelFreshness(state, nowMs)
    const candidateArtifactState: AllocationPlanInput['safetyState']['candidateArtifact'] =
      candidateCapture.status !== 'available' ||
      candidateFreshness === 'invalid' ||
      candidateFreshness === 'unavailable'
        ? 'invalid'
        : candidateFreshness === 'stale' || candidateFreshness === 'degraded'
          ? 'stale'
          : 'fresh'
    const shortTermBudget = Math.min(grossCash, 5_500_000)
    const basePolicy: AllocationPlanInput['policy'] = {
      jpStockMaxRatio: state.portfolioPolicy.jpStockMaxRatio,
      jpStockMaxAmountJpy: null,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio: state.portfolioPolicy.jpStockMaxRatio, maximumRatio: state.portfolioPolicy.jpStockMaxRatio, maximumAmountJpy: null },
        { assetClass: 'JP_TRUST', targetRatio: targetAllocation.JP_TRUST, maximumRatio: null, maximumAmountJpy: null },
        { assetClass: 'OVERSEAS_TRUST', targetRatio: targetAllocation.OVERSEAS_TRUST, maximumRatio: null, maximumAmountJpy: null },
        { assetClass: 'GOLD', targetRatio: targetAllocation.GOLD, maximumRatio: null, maximumAmountJpy: null },
      ],
      instrumentPolicies: instruments.map(instrument => ({
        instrumentId: instrument.instrumentId,
        targetAmountJpy: null,
        maxPositionAmountJpy: null,
        sectorHeadroomJpy: null,
        concentrationHeadroomJpy: null,
        liquidityHeadroomJpy: null,
        defaultMaxPositionShare: 0.25,
        defaultMaxSectorShare: 0.35,
        minimumPurchaseUnitJpy: 10_000,
      })),
      roundingPolicies: [
        { kind: 'jp_stock', purchaseUnitJpy: 10_000 },
        { kind: 'jp_trust', purchaseUnitJpy: 10_000 },
        { kind: 'global_trust', purchaseUnitJpy: 10_000 },
        { kind: 'gold', purchaseUnitJpy: 10_000 },
      ],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 0.25,
      buyMoreBaseShare: 0.5,
      confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0.03,
    }
    const candidateIdentity = candidates.map(candidate => ({ ...candidate }))
    const instrumentIdentity = instruments.map(instrument => ({ ...instrument }))
    const snapshotId = `allocation-plan:${sha256Utf8Hex(JSON.stringify({
      authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
      generatedAt: options.generatedAt,
      sourceHoldingsSnapshotId,
      sourceSettingsVersion,
      candidateArtifactGeneratedAt: state.candidateFunnel?._meta.generatedAt ?? null,
      candidateIdentity,
      instrumentIdentity,
    }))}`
    const input: AllocationPlanInput = {
      generatedAt: options.generatedAt,
      snapshotId,
      authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
      sourceHoldingsSnapshotId,
      sourceSettingsVersion,
      cash: {
        grossCash,
        // CASH-AUTH-1: 生活・安全余力と未約定買付確保額はユーザーが確定した
        // 権限そのもの。engine 側で一度だけ差し引かれる（重複控除はしない）。
        safetyReserve: effectiveCash.safetyReserve,
        pendingOrderCash: effectiveCash.pendingOrderCash,
        dataUncertaintyReserve: 0,
        ...options.cash,
      },
      budgets: {
        shortTermBudget,
        longTermBudget: Math.max(0, grossCash - shortTermBudget),
        ...options.budgets,
      },
      policy: { ...basePolicy, ...options.policy },
      assetClasses: [
        { assetClass: 'JP_STOCK', currentAmount: state.holdings.reduce((sum, item) => sum + item.eval, 0) },
        { assetClass: 'JP_TRUST', currentAmount: state.trust.filter(item => item.policy === 'JAPAN_SHORTTERM').reduce((sum, item) => sum + item.eval, 0) },
        { assetClass: 'OVERSEAS_TRUST', currentAmount: state.trust.filter(item => item.policy === 'OVERSEAS_LONGTERM').reduce((sum, item) => sum + item.eval, 0) },
        { assetClass: 'GOLD', currentAmount: state.trust.filter(item => item.policy === 'GOLD').reduce((sum, item) => sum + item.eval, 0) },
      ],
      instruments,
      candidates,
      safetyState: {
        safeMode,
        marketData: dqSuppressed ? 'stale' : 'fresh',
        // CASH-AUTH-1: unknown（権限なし）と stale（失効）を区別したまま engine へ渡す。
        // どちらも executable deployable cash は 0 になる。
        cash: cashFreshness.state,
        target: 'known',
        // null = 未約定買付の権限が不明（警告のみ）/ 数値 = ユーザーが確定済み
        pendingOrders: effectiveCash.pendingOrderCash === null ? 'unknown' : 'known',
        candidateArtifact: candidateArtifactState,
        dqViolation: dqSuppressed,
        tierA,
        crossTab,
        noTrade: noTrade.mode,
        ...options.safetyState,
        holdings: collapseAllocationHoldingsFreshness(holdingsFreshness),
      },
      regime: state.market.regime,
      marketMode: noTrade.mode,
    }
    return input
  } catch {
    return null
  }
}

function allocationPlanStatus(
  snapshot: AllocationPlanSnapshot | null,
  holdingsFreshness: AllocationPlanInput['safetyState']['holdings'] | null,
): AllocationPlanSnapshotState {
  if (snapshot === null) return 'invalid'
  if (holdingsFreshness === 'stale') return 'stale'
  if (holdingsFreshness === 'partial') return 'estimate_only'
  return snapshotExecutability(snapshot) === 'EXECUTABLE' ? 'current' : 'blocked'
}

// ── runFullAnalysis（内部ヘルパー）───────────────────────────
export function runFullAnalysis(
  state: AppState,
  options: {
    requireOfficialDecision?: boolean
    nowMs?: number
    trustShortInput?: TrustShortAnalysisInput
    allocationPlanInput?: Omit<AllocationPlanInputAdapterOptions, 'generatedAt'>
  } = {},
): Pick<AppState, 'analysis' | 'metrics' | 'holdings' | 'trust' | 'universe' | 'learning' | 'zeroPlan' | 'stockPlan' | 'trustPlan' | 'officialDecision' | 'stockCandidates' | 'allocationPlan' | 'allocationPlanStatus' | 'allocationPlanCandidateGenerationId' | 'candidatePortfolioRecommendations' | 'candidateDecisionSynthesis'> {
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

  // CASH-AUTH-1: 現金権限は state.cashAssumptions ただ一つ。legacy な
  // buildAssetUniverse / zeroBase へは「総現金を安全余力とそれ以外に割った」
  // 派生値として注入する — cash + cashReserve は常に grossCash と等しく、
  // 1円たりとも二重計上されない。addRoom は撤廃済みで一切加算しない。
  const effectiveCash = selectEffectiveCashAssumptions(state)
  const legacyCashDisplay = Math.max(0, effectiveCash.grossCash - effectiveCash.safetyReserve)
  const legacyCashReserveDisplay = Math.min(effectiveCash.safetyReserve, effectiveCash.grossCash)

  // CASH-AUTH-1 R1: 単一の decision-time cash usability gate。凍結TTL判定
  // （selectCashAssumptionsFreshness = 168h / source=MANUAL）はここで一度だけ行い、
  // legacy な zeroBase / trust候補 / stock候補 の新規BUY金額経路は全てこの値を
  // 共有する（168h判定の重複実装・source単独判定は禁止）。stale/unknown では
  // 新規BUY/BUY_NEW/WATCHの金額を一切生成しない。AllocationPlanSnapshot側の
  // 権威（deriveCashModel/safetyState.cash）はこの変更と独立して既に正しい。
  const cashAssumptionsUsable = selectCashAssumptionsFreshness(state, nowMs).state === 'known_fresh'

  // ゼロベース理想PF構築（metrics計算後に呼ぶ）
  const stateWithComputed: AppState = {
    ...state, holdings, trust, metrics, analysis,
    cash: legacyCashDisplay,
    cashReserve: legacyCashReserveDisplay,
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
      cash:             legacyCashDisplay,
      cashReserve:      legacyCashReserveDisplay,
      jpStockMaxRatio:  state.portfolioPolicy.jpStockMaxRatio,
      safeModeActive,
      dqSuppressed,
      cashAuthorityUsable: cashAssumptionsUsable,
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
      // CASH-AUTH-1: 総現金から安全余力・未約定買付を一度だけ差し引いた額を基準にする。
      // addRoom の上乗せは撤廃した。
      // CASH-AUTH-1 R1: 権限が stale/unknown（cashAssumptionsUsable=false）のときは
      // 新規BUY_NEW/WATCHの元手を0にする — 生の grossCash を使わない
      // （既存のGate6 INSUFFICIENT_CASHが自然にBUY_NEWを塞ぎ、suggestedAmount/maxAmountも0になる）。
      const availableCash = cashAssumptionsUsable
        ? Math.max(
            0,
            effectiveCash.grossCash
              - effectiveCash.safetyReserve
              - (effectiveCash.pendingOrderCash ?? 0)
              - MIN_CASH_FLOOR,
          )
        : 0
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
      // CAND-SYN-1C / D2 + D14: the L1 legacy append to officialDecision.actions
      // is retired here. `scored` is kept as eligibility/observability only
      // (D14 "ADAPT"); it no longer authorizes a candidate decision or a yen
      // amount. The single candidate writer is projectSynthesisToOfficialDecision,
      // applied once the canonical synthesis generation exists.
      void scored
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
    // P5-B002b-1 / CASH-AUTH-1: 現金権限が未設定（unknown）または失効（stale）の
    // 場合、BUY_NEW候補は出さない（gate内でDATA_STALEとして扱う）。
    // CASH-AUTH-1 R1: 168h TTL判定はこの関数内の cashAssumptionsUsable（冒頭で一度だけ
    // 計算済み）を共有する。ここでは重複計算しない。
    // universe（totalValue）はこの関数上部で既に同じeffectiveCashを使って計算済みのため再利用する。
    const jpStockHeadroom = computeJpStockHeadroom(
      holdings,
      state.portfolioPolicy.jpStockMaxRatio,
      universe?.totalValue ?? 0,
    )
    const STOCK_MIN_CASH_FLOOR = 1_000_000
    // CASH-AUTH-1: addRoom の上乗せは撤廃。控除は一度だけ。
    const availableCashForStock = Math.max(
      0,
      effectiveCashForStock.grossCash
        - effectiveCashForStock.safetyReserve
        - (effectiveCashForStock.pendingOrderCash ?? 0)
        - STOCK_MIN_CASH_FLOOR,
    )

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

    // P5-B005-C-D: legacy candidates_stocks decision bridge is retired.
    // stockCandidates remains an observability value but is never appended here.
  } catch (error) {
    if (options.requireOfficialDecision) throw new OfficialDecisionGenerationError(error)
    stockCandidates = []
  }

  if (options.requireOfficialDecision && officialDecision === null) {
    throw new OfficialDecisionGenerationError('officialDecisionが生成されませんでした')
  }

  // HR-I2 single writer: one captured generation is adapted, calculated, validated, and
  // returned atomically with the legacy analysis fields. No selector/action writes this field.
  let allocationPlan: AllocationPlanSnapshot | null = null
  let allocationPlanStatusValue: AllocationPlanSnapshotState = 'invalid'
  let allocationPlanCandidateGenerationId: string | null = null
  const allocationState: AppState = {
    ...state,
    analysis,
    metrics,
    holdings,
    trust,
    universe,
    learning,
    zeroPlan,
    stockPlan,
    trustPlan,
    officialDecision,
    stockCandidates,
  }
  const candidateCapture = buildCandidateAllocationInputs({
    artifact: allocationState.candidateFunnel,
    holdings: allocationState.holdings,
  })
  const hasExplicitAllocationCandidates =
    options.allocationPlanInput?.candidates !== undefined ||
    options.allocationPlanInput?.instruments !== undefined
  const allocationInput = buildAllocationPlanInput(allocationState, {
    generatedAt: nowIso,
    ...options.allocationPlanInput,
    candidateCapture,
  })
  if (allocationInput !== null) {
    try {
      allocationPlan = projectAllocationPlanSnapshot(buildAllocationPlanSnapshot(allocationInput))
      allocationPlanStatusValue = allocationPlanStatus(
        allocationPlan,
        allocationInput.safetyState.holdings,
      )
      allocationPlanCandidateGenerationId = allocationPlan !== null &&
        !hasExplicitAllocationCandidates &&
        candidateCapture.status === 'available'
        ? candidateCapture.sourceCandidateGenerationId
        : null
    } catch {
      allocationPlan = null
      allocationPlanStatusValue = 'invalid'
      allocationPlanCandidateGenerationId = null
    }
  }

  return {
    analysis, metrics, holdings, trust, universe, learning, zeroPlan, stockPlan, trustPlan,
    officialDecision,
    stockCandidates,
    allocationPlan,
    allocationPlanStatus: allocationPlanStatusValue,
    allocationPlanCandidateGenerationId,
    candidatePortfolioRecommendations: [],
    // CAND-SYN-1B single writer: filled only by appendCommittedCandidatePortfolioRecommendations,
    // after the same canonical CSV generation authority legacy candidatePortfolioRecommendations
    // uses is durably committed (fitResult needs that authority). Every other caller of
    // runFullAnalysis (cash TTL revalidation, tests) intentionally gets null — fail closed.
    candidateDecisionSynthesis: null,
  }
}

type FullAnalysisResult = ReturnType<typeof runFullAnalysis>

type CommittedCsvImportGeneration = Extract<
  CsvImportGenerationRestoreResult,
  { status: 'committed' }
>

type ExactCommittedCanonicalAuthority =
  | {
      readonly ok: true
      readonly raw: string
      readonly generation: CommittedCsvImportGeneration
    }
  | {
      readonly ok: false
      readonly reason: 'invalid_committed_raw'
    }

/**
 * Converts one transaction's receipt into the exact canonical generation it committed. This
 * helper is deliberately pure: no storage/clock read and no fallback to ambient or prior state.
 */
function restoreExactCommittedCanonicalAuthority(
  receipt: CsvImportPersistenceReceipt,
): ExactCommittedCanonicalAuthority {
  const raw = receipt.committedRaw
  const generation = restoreCsvImportGenerationFromRaw(raw)
  return generation.status === 'committed'
    ? { ok: true, raw, generation }
    : { ok: false, reason: 'invalid_committed_raw' }
}

/**
 * Durable C-D connection. Callers provide the exact canonical bytes only after persistence
 * succeeds and while the existing operation lock is still held. Any unavailable authority or
 * recommendation failure preserves the already-computed base OfficialDecision.
 */
function appendCommittedCandidatePortfolioRecommendations(
  stagedState: AppState,
  computed: FullAnalysisResult,
  authority: Extract<ExactCommittedCanonicalAuthority, { ok: true }>,
  operationNowMs: number,
): FullAnalysisResult {
  const canonicalGeneration = authority.generation
  if (
    stagedState.candidateFunnel === null ||
    computed.officialDecision === null
  ) return computed

  try {
    const compositionState: AppState = { ...stagedState, ...computed }
    const fitResult = selectCandidatePortfolioFit(
      compositionState,
      canonicalGeneration,
      computed.officialDecision.generatedAt,
    )
    const recommendations = composeCandidatePortfolioRecommendations({
      artifact: stagedState.candidateFunnel,
      fitResult,
      gates: {
        dataQualitySuppressed: selectMarketDataQuality(compositionState, operationNowMs).isSuppressed,
        noTrade: checkNoTrade(compositionState).noTrade,
        safeModeActive: selectEffectiveSafeModeActive(compositionState, operationNowMs),
      },
    })
    const candidateFreshness = selectCandidateFunnelFreshness(compositionState, operationNowMs)

    // CAND-SYN-1B: single production writer for candidateDecisionSynthesis. Computed
    // independently of the legacy early-return below — D24 keeps population A/C/D on a
    // `degraded` candidate funnel (only population B is dropped), unlike the legacy
    // recommendation projection, which drops everything for invalid/unavailable/degraded.
    const candidateDecisionSynthesis: CandidateDecisionSynthesisSnapshot | null =
      computed.allocationPlan !== null
        ? buildCandidateDecisionSynthesisFromState({
            state: compositionState,
            allocationPlan: computed.allocationPlan,
            allocationPlanStatus: computed.allocationPlanStatus,
            allocationPlanCandidateGenerationId: computed.allocationPlanCandidateGenerationId,
            fitResult,
            candidateFreshness,
            evaluatedAt: computed.officialDecision.generatedAt,
            nowMs: operationNowMs,
          })
        : null

    // CAND-SYN-1C: officialDecision's candidate component is now projected from
    // the canonical synthesis generation, and from nothing else. This runs
    // regardless of the legacy early-return below, because D24 keeps
    // populations A/C/D alive on a `degraded` funnel while the legacy
    // recommendation projection drops everything.
    const officialDecision = projectSynthesisToOfficialDecision(
      computed.officialDecision,
      candidateDecisionSynthesis,
    )

    if (
      candidateFreshness === 'invalid' ||
      candidateFreshness === 'unavailable' ||
      candidateFreshness === 'degraded'
    ) return { ...computed, candidateDecisionSynthesis, officialDecision }
    // candidatePortfolioRecommendations is retained as a 1D-compatibility
    // structure only: it is no longer written into officialDecision.
    const projectedRecommendations = projectCandidatePortfolioRecommendations({
      recommendations,
      snapshot: computed.allocationPlan,
      snapshotStatus: computed.allocationPlanStatus,
      snapshotCandidateGenerationId: computed.allocationPlanCandidateGenerationId,
      sourceCandidateGenerationId: stagedState.candidateFunnel._meta.generatedAt,
      sourceCandidateFreshness: candidateFreshness,
    })
    return {
      ...computed,
      candidateDecisionSynthesis,
      officialDecision,
      candidatePortfolioRecommendations: projectedRecommendations,
    }
  } catch {
    return computed
  }
}

function reportSubscriberException(error: unknown): void {
  // Observer failures are diagnostic events, not transaction failures. Reporting here keeps
  // later subscribers running and prevents a published durable generation from becoming a
  // false red result merely because one consumer threw while observing it.
  try { console.error('[useAppStore] subscriber callback failed', error) } catch { /* diagnostic sink */ }
}

export type AppStoreState = AppState & AppActions

// ── Store ─────────────────────────────────────────────────────
const createAppStoreStateCreator = (
  runtime: AppStoreRuntime,
): StateCreator<AppStoreState> => (set, get, api) => {
  const rawSetState = api.setState
  api.setState = ((...args: Parameters<typeof api.setState>) => {
    if (isPortfolioGenerationCriticalSection(runtime)) {
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

  // RA-008-D1: bind this store's own set/get as the runtime's invalidation flush callback,
  // exactly once per store instance. Deliberately calls the closured `set`/`get` (not
  // api.setState above) — same convention as every other publish in this file — and never
  // subscribes to the transport itself; reception stays recordPendingCrossTabInvalidation's job.
  // Note: get()/set() are only safe to call once the surrounding createStore/create() call has
  // returned (zustand assigns its internal state right after this creator function returns), so
  // the bind-time "flush anything already pending" pass happens at the createStore/create() call
  // sites below, never synchronously inside this function body.
  runtime.portfolioGenerationInvalidation.flushPendingToStore = () => {
    const invalidation = runtime.portfolioGenerationInvalidation
    if (invalidation.disposed) return
    const pending = invalidation.pending
    if (pending === null) return
    if (pending.receivedSequence <= invalidation.clearWatermark) return
    if (runtime.activePortfolioOperation !== null) return
    if (runtime.activePortfolioGenerationTransaction !== null) return
    if (get().system.crossTabInvalidation !== undefined) return
    set(state => ({
      system: { ...state.system, crossTabInvalidation: { status: 'stale' } },
      allocationPlan: null,
      allocationPlanStatus: 'stale',
      allocationPlanCandidateGenerationId: null,
      candidatePortfolioRecommendations: [],
      candidateDecisionSynthesis: null,
      // R1: the candidate compatibility component is owned only by the
      // synthesis generation that just went stale above — strip it in the
      // same atomic set so no observer can see synthesis=null coexist with
      // a candidate officialDecision action from the old generation.
      officialDecision: stripCandidateComponentFromOfficialDecision(state.officialDecision),
    }))
  }

  type ManualPortfolioState = AppState & AppActions
  type PrepareManualCandidate = (
    baseState: ManualPortfolioState,
    operationNowMs: number,
  ) => ManualPortfolioState | null
  type PersistManualLegacy = (
    finalState: ManualPortfolioState,
    operationNowMs: number,
  ) => LegacyPersistenceResult | LegacyPortfolioGenerationTransactionResult | CurrentPortfolioPersistenceResult

  const publishManualPersistenceError = (
    result: Exclude<
      LegacyPersistenceResult | LegacyPortfolioGenerationTransactionResult | CurrentPortfolioPersistenceResult,
      { status: 'persisted' }
    >,
  ): void => {
    const message = result.status === 'failed'
      ? '変更を保存できなかったため、手動変更を反映しませんでした。再試行してください。'
      : result.reason === 'metadata_misaligned'
        ? '保存済みCSVメタデータを現在の公開状態と安全に一致させられないため、手動変更を中止しました。CSVまたはportfolio snapshotを再取込してから再試行してください。'
      : result.reason === 'canonical_invalid'
        ? '保存済みcanonicalデータが不正なため、手動変更を反映しませんでした。再読み込み後に状態を確認してください。'
        : '保存中にcanonicalデータが更新されたため、手動変更を反映しませんでした。再読み込み後に状態を確認してください。'
    set(state => ({ system: { ...state.system, status: 'error', error: message } }))
  }

  /**
   * RA-006: every user-initiated portfolio input change follows one synchronous operation.
   * Candidate inputs and all analysis outputs stay off-store until their durable generation has
   * been committed. The operation ticket intentionally remains held while the single final set()
   * invokes subscribers, so synchronous re-entry cannot create a second generation.
   */
  const runManualPortfolioMutation = async (
    source: ManualPortfolioMutationOperation,
    prepareCandidateState: PrepareManualCandidate,
    persistLegacy: PersistManualLegacy,
  ): Promise<ManualMutationResult> => {
    if (runtime.activePortfolioOperation !== null || runtime.activePortfolioGenerationTransaction !== null) {
      reportRejectedPortfolioOperation(source)
      return Promise.resolve(createPortfolioCoordinationFailure(source, 'LOCAL_OPERATION_BUSY'))
    }
    const operationTicket = acquirePortfolioOperationFromRuntime(runtime, 'manual')
    if (operationTicket === null) {
      reportRejectedPortfolioOperation(source)
      return Promise.resolve(createPortfolioCoordinationFailure(source, 'LOCAL_OPERATION_BUSY'))
    }

    const failurePhase: { current: 'analysis' | 'persistence' | 'publish' } = {
      current: 'persistence',
    }
    try {
      try {
        const lockResult = await runtime.portfolioGenerationLock.runExclusive(source, async () => {
          failurePhase.current = 'persistence'
          const baseState = get()
          const operationNowMs = Date.now()
          const alignment = inspectDurablePortfolioAlignment(runtime, baseState, operationNowMs)
          if (alignment.status === 'stale') {
            return createPortfolioCoordinationFailure(source, 'CROSS_TAB_STATE_STALE')
          }
          if (alignment.status === 'invalid') {
            publishManualPersistenceError(alignment.canonicalInvalid
              ? { status: 'blocked', reason: 'canonical_invalid' }
              : { status: 'failed', reason: 'indeterminate' })
            return createManualMutationFailure(source, 'MANUAL_PERSISTENCE_ERROR')
          }

          failurePhase.current = 'analysis'
          let candidateState: ManualPortfolioState | null
          try {
            candidateState = prepareCandidateState(baseState, operationNowMs)
          } catch {
            try { console.error(`[useAppStore] manual candidate preparation failed: ${source}`) } catch { /* diagnostic sink */ }
            return createManualMutationFailure(source, 'MANUAL_ANALYSIS_ERROR')
          }
          if (candidateState === null) {
            return createManualMutationSuccess(source, 'NO_CHANGE')
          }

          let computed: ReturnType<typeof runFullAnalysis>
          try {
            computed = runFullAnalysis(candidateState, { nowMs: operationNowMs })
          } catch {
            try { console.error(`[useAppStore] manual portfolio analysis failed: ${source}`) } catch { /* diagnostic sink */ }
            return createManualMutationFailure(source, 'MANUAL_ANALYSIS_ERROR')
          }
          let finalState: ManualPortfolioState = { ...candidateState, ...computed }

          failurePhase.current = 'persistence'
          let persistenceResult: ReturnType<PersistManualLegacy>
          let canonicalPersistenceResult: CurrentPortfolioPersistenceResult | null = null
          try {
            if (alignment.canonical.status === 'committed') {
              canonicalPersistenceResult = persistCurrentPortfolioGeneration(
                finalState,
                alignment.canonical,
                alignment.canonicalRaw,
                operationNowMs,
              )
              persistenceResult = canonicalPersistenceResult
            } else {
              persistenceResult = persistLegacy(finalState, operationNowMs)
            }
          } catch {
            publishManualPersistenceError({ status: 'failed', reason: 'indeterminate' })
            return createManualMutationFailure(source, 'MANUAL_PERSISTENCE_ERROR')
          }
          if (persistenceResult.status !== 'persisted') {
            publishManualPersistenceError(persistenceResult)
            const conflict =
              (persistenceResult.status === 'blocked' &&
                (persistenceResult.reason === 'canonical_changed' ||
                  persistenceResult.reason === 'canonical_committed')) ||
              (persistenceResult.status === 'failed' &&
                'reason' in persistenceResult && persistenceResult.reason === 'ownership_lost')
            return conflict
              ? createPortfolioCoordinationFailure(source, 'PORTFOLIO_GENERATION_CONFLICT')
              : createManualMutationFailure(source, 'MANUAL_PERSISTENCE_ERROR')
          }

          let committedReceipt: CsvImportPersistenceReceipt | null = null
          if (alignment.canonical.status === 'committed') {
            if (
              canonicalPersistenceResult?.status !== 'persisted' ||
              canonicalPersistenceResult.target !== 'canonical'
            ) {
              return createManualMutationFailure(source, 'MANUAL_PERSISTENCE_ERROR')
            }
            committedReceipt = canonicalPersistenceResult.receipt
            const compositionBeforeHook = runtime.testSeams.candidateCompositionBeforeHook
            runtime.testSeams.candidateCompositionBeforeHook = null
            compositionBeforeHook?.()
            const authority = restoreExactCommittedCanonicalAuthority(committedReceipt)
            if (!authority.ok) {
              return createManualMutationFailure(source, 'MANUAL_PERSISTENCE_ERROR')
            }
            computed = appendCommittedCandidatePortfolioRecommendations(
              candidateState,
              computed,
              authority,
              operationNowMs,
            )
            finalState = { ...candidateState, ...computed }
          }

          // Cache the durable write's own identity now, before the publish attempt below: a
          // publish-before-apply failure must not leave this runtime unable to recognize its own
          // just-committed legacy generation on the very next call (mirrors the same
          // persist-before-publish-outcome ordering used by initialize/refreshAllData).
          if (alignment.canonical.status === 'committed') {
            runtime.lastLocallyPersistedLegacyProjection = null
            runtime.lastLocallyPersistedLegacyLearningFingerprint = null
          } else {
            runtime.lastLocallyPersistedLegacyProjection =
              buildLegacyProjectionOnlyFingerprint(finalState, operationNowMs)
            syncLegacyLearningFingerprintFromDisk(runtime)
          }

          if (portfolioGenerationProjectionChanged(
            buildPublishedPortfolioGenerationProjection(baseState, operationNowMs),
            buildPublishedPortfolioGenerationProjection(finalState, operationNowMs),
          )) {
            emitPortfolioGenerationInvalidationAfterCommit(runtime, {
              operation: source,
              committedAtMs: operationNowMs,
            })
          }

          failurePhase.current = 'publish'
          const previousCache = runtime.lastAppliedSnapshotGeneration
          runtime.lastAppliedSnapshotGeneration = null
          try {
            const beforeApplyHook = runtime.testSeams.manualPublishBeforeApplyHook
            runtime.testSeams.manualPublishBeforeApplyHook = null
            beforeApplyHook?.()
            if (committedReceipt !== null && !ownsCsvImportCanonicalBytes(committedReceipt)) {
              return createPortfolioCoordinationFailure(source, 'PORTFOLIO_GENERATION_CONFLICT')
            }
            // set() invokes synchronous subscribers before the lock callback resolves.
            set(finalState)
          } catch {
            const published = get()
            const applied = published.holdings === finalState.holdings &&
              published.trust === finalState.trust &&
              published.portfolioPolicy === finalState.portfolioPolicy &&
              published.cashAssumptions === finalState.cashAssumptions &&
              published.analysis === finalState.analysis &&
              published.officialDecision === finalState.officialDecision
            if (!applied) {
              runtime.lastAppliedSnapshotGeneration = previousCache
              try { console.error('[useAppStore] manual portfolio publish failed before apply') } catch { /* diagnostic sink */ }
              return createManualMutationFailure(source, 'MANUAL_PUBLISH_ERROR')
            }
            try { console.error('[useAppStore] manual portfolio publish observer failed') } catch { /* diagnostic sink */ }
          }
          return createManualMutationSuccess(source, 'SUCCESS')
        })
        return lockResult.ok
          ? lockResult.value
          : createPortfolioCoordinationFailure(source, lockResult.code)
      } catch {
        if (failurePhase.current === 'analysis') {
          return createManualMutationFailure(source, 'MANUAL_ANALYSIS_ERROR')
        }
        if (failurePhase.current === 'publish') {
          return createManualMutationFailure(source, 'MANUAL_PUBLISH_ERROR')
        }
        return createManualMutationFailure(source, 'MANUAL_PERSISTENCE_ERROR')
      }
    } finally {
      releasePortfolioOperationFromRuntime(runtime, operationTicket)
    }
  }

  /**
   * RA-007-D2: applies the fully staged initialize/refreshAllData final state exactly once and
   * classifies the outcome. If a one-shot test hook fires before apply, the durable generation is
   * already committed but the local store never sees the staged portfolio (LOAD_PUBLISH_ERROR). A
   * thrown synchronous subscriber cannot reach this catch: api.subscribe already wraps every
   * listener (reportSubscriberException), so observer failures never re-enter here — matching the
   * "subscriber throw is still SUCCESS" contract.
   *
   * RA-008-D1: initialize is the only clear authority. Its finalState folds
   * crossTabInvalidation: undefined into this SAME single publish (no second set()), and only
   * once that publish is confirmed applied does the runtime pending/watermark clear — still
   * inside the Web Lock, before the ticket (and thus any deferred flush) is released. A publish
   * that never actually applied (LOAD_PUBLISH_ERROR) must leave both the displayed warning and
   * the runtime pending untouched, so the clear happens after the failure return, never before.
   */
  const publishLoadFinalState = (
    operation: PortfolioLoadOperation,
    finalState: AppState,
    committedReceipt: CsvImportPersistenceReceipt | null,
  ): PortfolioLoadResult => {
    const stateToPublish: AppState = operation === 'initialize'
      ? { ...finalState, system: { ...finalState.system, crossTabInvalidation: undefined } }
      : finalState
    try {
      runLoadPublishBeforeApplyHookForTest(runtime)
      if (committedReceipt !== null && !ownsCsvImportCanonicalBytes(committedReceipt)) {
        return createPortfolioCoordinationFailure(operation, 'PORTFOLIO_GENERATION_CONFLICT')
      }
      set(stateToPublish)
    } catch {
      const published = get()
      const applied = published.system.status === 'success' &&
        published.holdings === stateToPublish.holdings &&
        published.trust === stateToPublish.trust &&
        published.analysis === stateToPublish.analysis
      if (!applied) {
        try { console.error(`[useAppStore] load publish failed before apply: ${operation}`) } catch { /* diagnostic sink */ }
        return createPortfolioLoadFailure(operation, 'LOAD_PUBLISH_ERROR')
      }
      try { console.error(`[useAppStore] load publish observer failed: ${operation}`) } catch { /* diagnostic sink */ }
    }
    if (operation === 'initialize') {
      clearPendingCrossTabInvalidationAfterVerifiedAlignment(runtime)
    }
    return createPortfolioLoadSuccess(operation)
  }

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
  // Phase 7 — 計算観察値 (Card 7-10/7-11)
  stockScores6Axis: null as StockScoreRecord[] | null,
  fundPhase7: null as FundPhase7Map | null,
  // P1-3A/B: Official Decision + Plan snapshots
  officialDecision: null,
  zeroPlan: null,
  stockPlan: null,
  trustPlan: null,
  allocationPlan: null,
  allocationPlanStatus: 'absent',
  allocationPlanCandidateGenerationId: null,
  candidatePortfolioRecommendations: [],
  candidateDecisionSynthesis: null,
  // P4-A9c-data-4c: role-unit candidates news（observability用・意思決定未接続）
  candidatesNews: DEFAULT_CANDIDATES_NEWS_DATA,
  // P5-B002a: 新規個別株候補（市場公開情報のみ。observability用・officialDecision未接続）
  candidatesStocks: DEFAULT_CANDIDATES_STOCKS_DATA,
  // P5-B005-B3-B: dummy候補へfallbackしないproduction artifact
  candidateFunnel: null,
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
      candidateFunnel: 'unavailable',
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
      candidateFunnel: null,
      regime: null,
    },
  },

  // ── 起動時初期化 ──────────────────────────────────────────
  // RA-007-D2: connected to the same-origin exclusive Web Lock. initialize is a bootstrap
  // operation — the latest durable canonical/legacy generation is always the restore base,
  // regardless of whatever the just-created local Zustand state currently holds. Network
  // prework starts right after the local ticket (before the Web Lock is even requested);
  // restore/analysis/persistence all stage off-store and publish exactly once, only after
  // persistence has already succeeded (persist-before-publish).
  initialize: async () => {
    const operation: PortfolioLoadOperation = 'initialize'
    if (isPortfolioGenerationCriticalSection(runtime)) {
      reportRejectedReentrantMutation('initialize')
      return createPortfolioCoordinationFailure(operation, 'LOCAL_OPERATION_BUSY')
    }
    const operationTicket = acquirePortfolioOperationFromRuntime(runtime, 'initialize')
    if (operationTicket === null) {
      reportRejectedPortfolioOperation('initialize')
      return createPortfolioCoordinationFailure(operation, 'LOCAL_OPERATION_BUSY')
    }

    // stock_scores_6axis: 本番生成ファイル（data/scoring/）を参照。contracts/v13.3 フィクスチャは
    // 使用しない。fund_phase7は本番生成物が存在しないためfetch自体を行わない。
    const prework = settlePrework(Promise.all([
      loadPublishedData({ bustCache: true }),
      fetch('data/scoring/stock_scores_6axis.json')
        .then(r => r.ok ? (r.json() as Promise<Phase7StockRaw>) : null)
        .catch(() => null),
    ]))

    const failurePhase: { current: PortfolioLoadPhase } = { current: 'restore' }
    try {
      const lockResult = await runtime.portfolioGenerationLock.runExclusive(
        operation,
        async (): Promise<PortfolioLoadResult> => {
          runLoadRestoreBeforeReadHookForTest(runtime)
          const grantedState = get()
          const nowMs = Date.now()

          // localStorage復元（P4.5-A012d: holdings/trustはTTL失効時も値を保持する。鮮度は
          // localStorageFreshnessとして表示専用にsystemへ反映する）。restore結果はまだ
          // storeへ一切publishしない — 完全にstage済みのAppStateとして保持するだけ。
          failurePhase.current = 'restore'
          const restoreOutcome = buildInitializeRestoredState(grantedState, nowMs)
          if (restoreOutcome.kind === 'invalid') {
            return createPortfolioLoadFailure(operation, 'LOAD_RESTORE_ERROR')
          }
          const restoredState = restoreOutcome.state

          // データ取得（macro / nikkei VI / SQ / Phase 7 含む）。fetchはWeb Lock grant前に
          // 開始済みで、ここではsettled outcomeを待つだけ。
          failurePhase.current = 'data'
          const preworkResult = await prework
          if (!preworkResult.ok) {
            return createPortfolioLoadFailure(operation, 'LOAD_DATA_ERROR')
          }
          const [publishedData, phase7StockRaw] = preworkResult.value
          const stagedState = buildStateWithPublishedData(restoredState, publishedData, {
            nowMs,
            hasCommittedCanonicalGeneration: restoreOutcome.hasCommittedCanonicalGeneration,
            phase7StockRaw,
          })

          // 全再計算（未publishのstaged stateに対して実行する）
          failurePhase.current = 'analysis'
          let computed: ReturnType<typeof runFullAnalysis>
          try {
            computed = runFullAnalysis(stagedState, { nowMs })
          } catch {
            return createPortfolioLoadFailure(operation, 'LOAD_ANALYSIS_ERROR')
          }
          const nowIso = new Date(nowMs).toISOString()
          let finalState: AppState = {
            ...stagedState,
            ...computed,
            system: { ...stagedState.system, status: 'success', lastUpdated: nowIso, analysisLastRunAt: nowIso, error: null },
          }

          // 永続化（persist-before-publish）
          failurePhase.current = 'persistence'
          let persistenceResult: CurrentPortfolioPersistenceResult
          try {
            persistenceResult = persistCurrentPortfolioGeneration(finalState, undefined, undefined, nowMs)
          } catch {
            return createPortfolioLoadFailure(operation, 'LOAD_PERSISTENCE_ERROR')
          }
          if (persistenceResult.status !== 'persisted') {
            return classifyLoadPersistenceFailure(operation, persistenceResult)
          }
          let committedReceipt: CsvImportPersistenceReceipt | null = null
          if (persistenceResult.target === 'canonical') {
            committedReceipt = persistenceResult.receipt
            const compositionBeforeHook = runtime.testSeams.candidateCompositionBeforeHook
            runtime.testSeams.candidateCompositionBeforeHook = null
            compositionBeforeHook?.()
            const authority = restoreExactCommittedCanonicalAuthority(committedReceipt)
            if (!authority.ok) {
              return createPortfolioLoadFailure(operation, 'LOAD_PERSISTENCE_ERROR')
            }
            computed = appendCommittedCandidatePortfolioRecommendations(
              stagedState,
              computed,
              authority,
              nowMs,
            )
            finalState = {
              ...stagedState,
              ...computed,
              system: { ...stagedState.system, status: 'success', lastUpdated: nowIso, analysisLastRunAt: nowIso, error: null },
            }
          }
          if (persistenceResult.target === 'canonical') {
            runtime.lastLocallyPersistedLegacyLearningFingerprint = null
          } else {
            syncLegacyLearningFingerprintFromDisk(runtime)
          }

          if (portfolioGenerationProjectionChanged(
            buildPublishedPortfolioGenerationProjection(restoredState, nowMs),
            buildPublishedPortfolioGenerationProjection(finalState, nowMs),
          )) {
            emitPortfolioGenerationInvalidationAfterCommit(runtime, {
              operation,
              committedAtMs: nowMs,
            })
          }

          // exactly one final publication
          failurePhase.current = 'publish'
          return publishLoadFinalState(operation, finalState, committedReceipt)
        },
      )
      return lockResult.ok
        ? lockResult.value
        : createPortfolioCoordinationFailure(operation, lockResult.code)
    } catch {
      return createPortfolioLoadFailure(operation, PORTFOLIO_LOAD_FAILURE_BY_PHASE[failurePhase.current])
    } finally {
      releasePortfolioOperationFromRuntime(runtime, operationTicket)
    }
  },

  // ── 全データ再取得 ────────────────────────────────────────
  // RA-007-D2: connected to the same-origin exclusive Web Lock. refreshAllData is NOT a
  // bootstrap — after grant it re-uses the same durable-alignment projection helper as manual
  // mutations/CSV/snapshot imports. Any mismatch between the currently published projection and
  // the latest durable generation fails closed as CROSS_TAB_STATE_STALE before any prework
  // result, analysis, persistence, or publication happens.
  refreshAllData: async () => {
    const operation: PortfolioLoadOperation = 'refreshAllData'
    if (isPortfolioGenerationCriticalSection(runtime)) {
      reportRejectedReentrantMutation('refreshAllData')
      return createPortfolioCoordinationFailure(operation, 'LOCAL_OPERATION_BUSY')
    }
    const operationTicket = acquirePortfolioOperationFromRuntime(runtime, 'refresh')
    if (operationTicket === null) {
      reportRejectedPortfolioOperation('refreshAllData')
      return createPortfolioCoordinationFailure(operation, 'LOCAL_OPERATION_BUSY')
    }

    const prework = settlePrework(loadPublishedData({ bustCache: true }))

    const failurePhase: { current: PortfolioLoadPhase } = { current: 'data' }
    try {
      const lockResult = await runtime.portfolioGenerationLock.runExclusive(
        operation,
        async (): Promise<PortfolioLoadResult> => {
          const grantedState = get()
          const nowMs = Date.now()

          // refreshはbootstrapではない。公開済みprojectionと最新durable projectionを比較し、
          // 安全なwrite baseだと証明できない限りprework結果・analysis・persistence・publishへ
          // 一切進まない（すでに開始済みのnetwork preworkがあっても結果は破棄する）。
          const alignment = inspectDurablePortfolioAlignment(runtime, grantedState, nowMs)
          if (alignment.status === 'stale') {
            return createPortfolioCoordinationFailure(operation, 'CROSS_TAB_STATE_STALE')
          }
          if (alignment.status === 'invalid') {
            return createPortfolioLoadFailure(operation, 'LOAD_PERSISTENCE_ERROR')
          }

          failurePhase.current = 'data'
          const preworkResult = await prework
          if (!preworkResult.ok) {
            return createPortfolioLoadFailure(operation, 'LOAD_DATA_ERROR')
          }

          // refreshはbootstrapでないため、future/expired化したlocal CSV metadataがそのまま
          // 前方へ持ち越されないよう正規化してからpublished dataをmergeする。
          const safeBaseState = sanitizeRefreshCsvMetadata(grantedState, nowMs)
          const stagedState = buildStateWithPublishedData(safeBaseState, preworkResult.value, {
            nowMs,
            hasCommittedCanonicalGeneration: alignment.canonical.status === 'committed',
          })

          failurePhase.current = 'analysis'
          let computed: ReturnType<typeof runFullAnalysis>
          try {
            computed = runFullAnalysis(stagedState, { nowMs })
          } catch {
            return createPortfolioLoadFailure(operation, 'LOAD_ANALYSIS_ERROR')
          }
          const nowIso = new Date(nowMs).toISOString()
          let finalState: AppState = {
            ...stagedState,
            ...computed,
            system: { ...stagedState.system, status: 'success', lastUpdated: nowIso, analysisLastRunAt: nowIso, error: null },
          }

          // Deliberately re-reads canonical rather than threading alignment.canonical/canonicalRaw
          // through: passing a known canonicalRaw makes persistCurrentPortfolioGeneration trust
          // finalState.system.csvLastImportedAt without its usual fallback to the existing
          // canonical's own csvImportedAt, while csvSyncSummary still falls back independently —
          // refresh's CSV-metadata sanitization can null csvLastImportedAt while a syncSummary
          // fallback survives, which fails schema validation (syncSummary present without a
          // matching csvImportedAt). The Web Lock already serializes writers, so there is no
          // conflict window for a known-raw CAS check to protect against here.
          failurePhase.current = 'persistence'
          let persistenceResult: CurrentPortfolioPersistenceResult
          try {
            persistenceResult = persistCurrentPortfolioGeneration(finalState, undefined, undefined, nowMs)
          } catch {
            return createPortfolioLoadFailure(operation, 'LOAD_PERSISTENCE_ERROR')
          }
          if (persistenceResult.status !== 'persisted') {
            return classifyLoadPersistenceFailure(operation, persistenceResult)
          }
          let committedReceipt: CsvImportPersistenceReceipt | null = null
          if (persistenceResult.target === 'canonical') {
            committedReceipt = persistenceResult.receipt
            const compositionBeforeHook = runtime.testSeams.candidateCompositionBeforeHook
            runtime.testSeams.candidateCompositionBeforeHook = null
            compositionBeforeHook?.()
            const authority = restoreExactCommittedCanonicalAuthority(committedReceipt)
            if (!authority.ok) {
              return createPortfolioLoadFailure(operation, 'LOAD_PERSISTENCE_ERROR')
            }
            computed = appendCommittedCandidatePortfolioRecommendations(
              stagedState,
              computed,
              authority,
              nowMs,
            )
            finalState = {
              ...stagedState,
              ...computed,
              system: { ...stagedState.system, status: 'success', lastUpdated: nowIso, analysisLastRunAt: nowIso, error: null },
            }
          }
          if (persistenceResult.target === 'canonical') {
            runtime.lastLocallyPersistedLegacyLearningFingerprint = null
          } else {
            syncLegacyLearningFingerprintFromDisk(runtime)
          }

          if (portfolioGenerationProjectionChanged(
            buildPublishedPortfolioGenerationProjection(safeBaseState, nowMs),
            buildPublishedPortfolioGenerationProjection(finalState, nowMs),
          )) {
            emitPortfolioGenerationInvalidationAfterCommit(runtime, {
              operation,
              committedAtMs: nowMs,
            })
          }

          failurePhase.current = 'publish'
          return publishLoadFinalState(operation, finalState, committedReceipt)
        },
      )
      return lockResult.ok
        ? lockResult.value
        : createPortfolioCoordinationFailure(operation, lockResult.code)
    } catch {
      return createPortfolioLoadFailure(operation, PORTFOLIO_LOAD_FAILURE_BY_PHASE[failurePhase.current])
    } finally {
      releasePortfolioOperationFromRuntime(runtime, operationTicket)
    }
  },

  // ── CSV取込（個別株 + 投信 両対応）──────────────────────────
  importCsv: async (file: File, options = {}) => {
    // Do not read Zustand before the Web Lock grant. Runtime ownership is the only local
    // preflight authority, and the acquired ticket stays held while this request is queued.
    if (runtime.activePortfolioOperation !== null || runtime.activePortfolioGenerationTransaction !== null) {
      return createPortfolioCoordinationFailure('importCsv', 'LOCAL_OPERATION_BUSY')
    }
    const operationTicket = acquirePortfolioOperationFromRuntime(runtime, 'csv')
    if (operationTicket === null) {
      return createPortfolioCoordinationFailure('importCsv', 'LOCAL_OPERATION_BUSY')
    }
    try {
      const lockResult = await runtime.portfolioGenerationLock.runExclusive(
        'importCsv',
        async (): Promise<CsvImportResult> => {
    const grantedState = get()
    const analysisNow = Date.now()
    const alignment = inspectDurablePortfolioAlignment(runtime, grantedState, analysisNow)
    if (alignment.status === 'stale') {
      return createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE')
    }
    if (alignment.status === 'invalid') {
      return alignment.canonicalInvalid
        ? csvImportFailure(
            'CSV_CANONICAL_INVALID',
            '保存済みの取込世代データが破損しているため、CSVの取込を中断しました。' +
              '破損した保存世代を修復または削除してから再試行してください。状態は変更されていません。',
          )
        : csvImportFailure(
            'PERSISTENCE_ERROR',
            '保存済みデータを読み込めないため、CSVの取込を中断しました。再読み込み後に再試行してください。',
          )
    }

    // Transaction creation and all CSV work start only after grant and alignment.
    const transaction: CsvImportTransaction = {
      token: Symbol('csv-import-owner'),
      origin: 'csv',
      phase: 'READING',
      analysisNow,
      initialFingerprint: '',
      trackerSnapshot: null,
      trackerPortfolioBaseline: null,
      canonicalPreviousRaw: alignment.canonicalRaw,
    }
    runtime.activePortfolioGenerationTransaction = transaction
    let durableCommitted = false
    let committedSuccess: CsvImportResult | null = null
    // T9-A004-R3-FIX-B (R3-F003): receipt取得後の予期しない例外recovery（outer catch）が
    // 「committed世代がstoreへ完全適用済みか」をgeneration identityで判定し、未適用なら
    // byte-exact rollbackへ進めるよう、receiptとcommitted transfer identityをtransaction
    // scopeで保持する。
    let persistenceReceipt: CsvImportPersistenceReceipt | null = null
    let committedTransferIdentity: string | null = null
    // RA-008-C2: transaction-scoped exactly-once invalidation guard. `let` (not module/runtime
    // global) so a retried transaction always gets a fresh flag. `generationCommittedAt` is
    // declared here (rather than as a `const` at its point of use) so the catch block below —
    // a sibling scope to the inner try that assigns it — can still read it through this closure.
    let generationCommittedAt: number | null = null
    let invalidationEmitted = false
    const emitCommittedInvalidationOnce = (): void => {
      if (invalidationEmitted) return
      invalidationEmitted = true
      if (generationCommittedAt === null) return
      emitPortfolioGenerationInvalidationAfterCommit(runtime, {
        operation: 'importCsv',
        committedAtMs: generationCommittedAt,
      })
    }
    const publishFailure = (failure: CsvImportResult): CsvImportResult => {
      if (failure.ok || 'operation' in failure) return failure
      if (runtime.activePortfolioGenerationTransaction?.token === transaction.token) {
        set(s => ({ system: { ...s.system, status: 'error', error: failure.message } }))
      }
      return failure
    }

    try {

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
      setPortfolioGenerationTransactionPhase(runtime, transaction, 'READING')
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
      setPortfolioGenerationTransactionPhase(runtime, transaction, 'STAGING')
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
        transaction.analysisNow,
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
        setPortfolioGenerationTransactionPhase(runtime, transaction, 'ANALYZING')
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
      setPortfolioGenerationTransactionPhase(runtime, transaction, 'PREPARED')

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

      generationCommittedAt = Date.now()
      try {
        setPortfolioGenerationTransactionPhase(runtime, transaction, 'PERSISTING')
        const stagedTransferIdentity = computeSnapshotGenerationIdentity({
          holdings: computed.holdings,
          trust: computed.trust,
          portfolioPolicy: baseState.portfolioPolicy,
          cashAssumptions: baseState.cashAssumptions,
          csvImportedAt: now,
          csvImportProvenance: incomingProvenance,
        })
        persistenceReceipt = persistCsvImportTransaction({
          holdings: computed.holdings,
          trust: computed.trust,
          learning: computed.learning,
          csvImportedAt: now,
          provenance: incomingProvenance,
          syncSummary,
          trustShortSnapshot: stagedTrustExecution.snapshot,
          portfolioPolicy: baseState.portfolioPolicy,
          cashAssumptions: baseState.cashAssumptions,
          origin: 'csv',
          snapshotTransferIdentity: stagedTransferIdentity,
        }, generationCommittedAt, transaction.canonicalPreviousRaw, {
          schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
        })
        committedTransferIdentity = stagedTransferIdentity
        durableCommitted = true
        setPortfolioGenerationTransactionPhase(runtime, transaction, 'COMMITTED')
      } catch (error) {
        setPortfolioGenerationTransactionPhase(runtime, transaction, 'PREPARED')
        if (error instanceof CsvImportPersistenceIndeterminateError) {
          return publishFailure(csvImportFailure(
            'PERSISTENCE_INDETERMINATE',
            '保存結果を確認できません。再読み込みして状態を確認してください。',
            'indeterminate',
          ))
        }
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

      // Initial post-commit ownership must succeed before any publish preparation continues.
      if (persistenceReceipt === null || !ownsCsvImportCanonicalBytes(persistenceReceipt)) {
        durableCommitted = false
        return publishFailure(csvImportFailure(
          'IMPORT_CONFLICT',
          '保存後にcanonical世代の所有権を失ったため、準備した分析結果は公開しませんでした。外部の保存世代を維持したまま再試行してください。',
          'ownership_lost',
        ))
      }

      const compositionBeforeHook = runtime.testSeams.candidateCompositionBeforeHook
      runtime.testSeams.candidateCompositionBeforeHook = null
      compositionBeforeHook?.()
      const authority = restoreExactCommittedCanonicalAuthority(persistenceReceipt)
      if (!authority.ok) {
        durableCommitted = false
        return publishFailure(csvImportFailure(
          'PERSISTENCE_ERROR',
          '保存したcanonical世代を検証できなかったため、準備した分析結果は公開しませんでした。再読み込み後に再試行してください。',
          'indeterminate',
        ))
      }
      computed = appendCommittedCandidatePortfolioRecommendations(
        stagedState,
        computed,
        authority,
        transaction.analysisNow,
      )

      // Freshness reads are the final pre-publish operation. They can yield to a storage shim or
      // observe an external writer, so exact-byte ownership is checked again immediately before
      // the single Zustand publish.
      const localStorageFreshness = computeLocalStorageFreshness(generationCommittedAt)
      if (!ownsCsvImportCanonicalBytes(persistenceReceipt)) {
        durableCommitted = false
        return publishFailure(csvImportFailure(
          'IMPORT_CONFLICT',
          '公開直前にcanonical世代の所有権を失ったため、準備した分析結果は公開しませんでした。外部の保存世代を維持したまま再試行してください。',
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
      setPortfolioGenerationTransactionPhase(runtime, transaction, 'PUBLISHED')

      // RA-008-C2: emit only after the complete state apply above is confirmed to have landed —
      // never earlier. Directly proves appliedStateIdentity === committedTransferIdentity rather
      // than assuming set() succeeded; a mismatch (should be unreachable here) suppresses emission.
      if (committedTransferIdentity !== null &&
          computeCurrentSnapshotStateIdentity(get()) === committedTransferIdentity) {
        emitCommittedInvalidationOnce()
      }

      try {
        if (trustExecution.executed && getTrustShortTodayExecutionCount(transaction.analysisNow) < 1) {
          const state = get()
          const trustPlan = buildTrustPortfolioPlan({
            trust: state.trust,
            market: state.market,
            macro: state.macro,
            news: state.news,
            sqCalendar: state.sqCalendar,
            margin: state.margin,
            flows: state.flows,
            todayEntryCount: getTrustShortTodayExecutionCount(transaction.analysisNow),
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
      // T9-A004-R3-FIX-B (R3-F003): receipt取得後〜publish完了は明示的なfailure boundary。
      // durableCommittedだけを根拠にSUCCESSへ倒さず、canonical/store/resultの三者を
      // 物理状態と一致させる。
      if (durableCommitted && committedSuccess?.ok && persistenceReceipt !== null) {
        // committed generationがstoreへ完全適用済みか（transfer identity一致）を確認する。
        // 適用済みなら成立したtransactionであり、post-publish例外は偽failure化しない。
        const appliedStateIdentity = computeCurrentSnapshotStateIdentity(get())
        if (committedTransferIdentity !== null && appliedStateIdentity === committedTransferIdentity) {
          try { console.error('[useAppStore] post-commit CSV observer/publish diagnostic', error) } catch { /* diagnostic sink */ }
          // RA-008-C2: normal path never reached its own emit call (it threw before/at set()),
          // so the exactly-once guard has not fired yet here — this is the transaction's one shot.
          emitCommittedInvalidationOnce()
          return committedSuccess
        }
        // 未適用（canonical新/store旧）。外部writerが置換済みのbytesにはbyte-exact規則上
        // 一切触れず、所有権喪失を物理状態どおりに報告する。
        if (!ownsCsvImportCanonicalBytes(persistenceReceipt)) {
          const failure = csvImportFailure(
            'IMPORT_CONFLICT',
            '保存後にエラーが発生し、canonical世代の所有権も失われていたため公開を中止しました。外部の保存世代を維持したまま再試行してください。',
            'ownership_lost',
          )
          try { return publishFailure(failure) } catch { return failure }
        }
        // 自transactionの所有bytesであることを確認した上で、previousRawへbyte-exact
        // rollbackする。rolled_backと報告する以上、canonicalへ新bytesは残さない。
        const rolledBack = rollbackCsvImportTransaction(persistenceReceipt)
        if (rolledBack) durableCommitted = false
        const failure = rolledBack
          ? csvImportFailure(
              'UNKNOWN_ERROR',
              'CSV取込の公開前に予期しないエラーが発生したため、保存済みの世代を取り消しました。状態は変更されていません。再試行してください。',
              'rolled_back',
            )
          : csvImportFailure(
              'PERSISTENCE_ERROR',
              'CSV取込の公開前に予期しないエラーが発生し、保存済み世代の取り消しを確認できませんでした。再読み込み後に内容を確認してください。',
              'rollback_failed',
            )
        try { return publishFailure(failure) } catch { return failure }
      }
      const failure = csvImportFailure(
        'UNKNOWN_ERROR',
        'CSV取込中に予期しないエラーが発生しました。状態は変更されていません。再試行してください。',
      )
      try { return publishFailure(failure) } catch { return failure }
    } finally {
      if (runtime.activePortfolioGenerationTransaction?.token === transaction.token) {
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
        runtime.activePortfolioGenerationTransaction = null
      }
    }
        },
      )
      return lockResult.ok
        ? lockResult.value
        : createPortfolioCoordinationFailure('importCsv', lockResult.code)
    } catch {
      return csvImportFailure(
        'UNKNOWN_ERROR',
        'CSV取込中に予期しないエラーが発生しました。状態は変更されていません。再試行してください。',
      )
    } finally {
      releasePortfolioOperationFromRuntime(runtime, operationTicket)
    }
  },

  setTab: (tab) => set({ activeTab: tab }),

  /**
   * CASH-AUTH-1: 開いたままのタブが 168h の境界を越えても実行可能な
   * AllocationPlanSnapshot を持ち続けないようにする、ローカル限定のTTLガード。
   *
   * 1. 現金権限がまだ有効なら何もしない（描画やTTL延長は一切行わない）。
   * 2. 失効していれば、まず現在の実行可能性を無効化する。
   * 3. そのうえで権限経路（runFullAnalysis）を通して stale-cash として
   *    blocked な snapshot を作り直す。金額欄を直接書き換えることはしない。
   *
   * 永続化は変更しない — 失効は時間の経過であってユーザーの入力ではないため、
   * 保存済みの金額は参考値としてそのまま残す。ネットワークも一切使わない。
   */
  revalidateCashAuthorityExpiry: (nowMs = Date.now()) => {
    if (isPortfolioGenerationCriticalSection(runtime)) return false
    if (runtime.activePortfolioOperation !== null) return false
    if (runtime.activePortfolioGenerationTransaction !== null) return false
    const state = get()
    if (selectCashAssumptionsFreshness(state, nowMs).state !== 'stale') return false
    if (state.allocationPlan === null && state.allocationPlanStatus === 'stale') return false

    // (2) 実行可能性を先に落としてから (3) 再構築する
    // R1: candidateDecisionSynthesis がこの世代限りで無効化される同一フェーズで、
    // officialDecision の candidate compatibility component も除去する。
    // stale generation の candidate を延命させない（generation atomicity）。
    set({
      allocationPlan: null,
      allocationPlanStatus: 'stale',
      allocationPlanCandidateGenerationId: null,
      candidatePortfolioRecommendations: [],
      candidateDecisionSynthesis: null,
      officialDecision: stripCandidateComponentFromOfficialDecision(state.officialDecision),
    })
    try {
      // CAND-SYN-1B: runFullAnalysis alone always returns candidateDecisionSynthesis: null
      // (only appendCommittedCandidatePortfolioRecommendations — not called on this path —
      // ever populates it), so a stale executable synthesis can never survive TTL expiry.
      const computed = runFullAnalysis(get(), { nowMs })
      set({
        allocationPlan: computed.allocationPlan,
        allocationPlanStatus: computed.allocationPlanStatus,
        allocationPlanCandidateGenerationId: computed.allocationPlanCandidateGenerationId,
        candidatePortfolioRecommendations: computed.candidatePortfolioRecommendations,
        candidateDecisionSynthesis: computed.candidateDecisionSynthesis,
      })
    } catch {
      // 再構築に失敗しても fail-closed のまま（実行可能な snapshot は残らない）
    }
    return true
  },

  updateHolding: (code, patch) => {
    return runManualPortfolioMutation(
      'updateHolding',
      baseState => {
        const current = baseState.holdings.find(holding => holding.code === code)
        if (!current) return null
        const changed = (Object.keys(patch) as Array<keyof Holding>)
          .some(key => !Object.is(current[key], patch[key]))
        if (!changed) return null
        const holdings = baseState.holdings.map(holding =>
          holding === current ? { ...holding, ...patch } : holding)
        return { ...baseState, holdings }
      },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        holdings: finalState.holdings,
        trust: finalState.trust,
        ...(finalState.learning ? { learning: finalState.learning } : {}),
      }, operationNowMs),
    )
  },

  updateTrust: (id, patch) => {
    return runManualPortfolioMutation(
      'updateTrust',
      baseState => {
        const current = baseState.trust.find(fund => fund.id === id)
        if (!current) return null
        const changed = (Object.keys(patch) as Array<keyof Trust>)
          .some(key => !Object.is(current[key], patch[key]))
        if (!changed) return null
        const trust = baseState.trust.map(fund =>
          fund === current ? { ...fund, ...patch } : fund)
        return { ...baseState, trust }
      },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        holdings: finalState.holdings,
        trust: finalState.trust,
        ...(finalState.learning ? { learning: finalState.learning } : {}),
      }, operationNowMs),
    )
  },

  // P4-A47: jpStockMaxRatio更新 → 再分析 → 永続化
  setPortfolioPolicy: (policy) => {
    return runManualPortfolioMutation(
      'setPortfolioPolicy',
      baseState => baseState.portfolioPolicy.jpStockMaxRatio === policy.jpStockMaxRatio
        ? null
        : { ...baseState, portfolioPolicy: policy },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        portfolioPolicy: finalState.portfolioPolicy,
      }, operationNowMs),
    )
  },

  // CASH-AUTH-1: 現金権限を保存する。レコード全体を検証してからのみ確定し、
  // 1項目でも不正なら state / 永続化 / snapshot を一切変更しない（0への丸めもしない）。
  // 保存成功時は updatedAt を更新 → sourceSettingsVersion が変化 →
  // 既存 AllocationPlanSnapshot は非権威となり、同一トランザクション内で再構築される。
  setCashAssumptions: ({ grossCash, safetyReserve, pendingOrderCash }) => {
    return runManualPortfolioMutation(
      'setCashAssumptions',
      (baseState, operationNowMs) => {
        const validation = validateCashAuthorityDraft({
          grossCash,
          safetyReserve,
          pendingOrderCash,
          updatedAt: new Date(operationNowMs).toISOString(),
        })
        if (!validation.ok) throw new Error('CASH_AUTHORITY_INVALID')
        return { ...baseState, cashAssumptions: validation.record }
      },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        cashAssumptions: finalState.cashAssumptions,
      }, operationNowMs),
    )
  },

  // CASH-AUTH-1: 現金権限を削除して「未設定」へ戻す。
  // これは confirmed zero（0円を確認済み）ではなく NO_AUTHORITY であり、
  // 以後 allocation は CASH_AUTHORITY_UNAVAILABLE で fail-closed する。
  clearCashAssumptionsOverride: () => {
    return runManualPortfolioMutation(
      'clearCashAssumptionsOverride',
      baseState => {
        if (baseState.cashAssumptions.source === 'DEFAULT') return null
        return { ...baseState, cashAssumptions: { ...NO_CASH_AUTHORITY } }
      },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        cashAssumptions: finalState.cashAssumptions,
      }, operationNowMs),
    )
  },

  // CASH-AUTH-1: 同じ金額を「現時点でも正しい」と明示的に再確認する。
  // updatedAt のみを更新して TTL を延長する意図的なユーザー操作であり、
  // ページ読み込みや再描画では決して呼ばれない。
  // 権限が未設定のときは何もしない（時刻だけ作って権限を捏造しない）。
  reconfirmCashAssumptions: () => {
    return runManualPortfolioMutation(
      'reconfirmCashAssumptions',
      (baseState, operationNowMs) => {
        const current = baseState.cashAssumptions
        if (current.source !== 'MANUAL') return null
        const validation = validateCashAuthorityDraft({
          grossCash: current.grossCash,
          safetyReserve: current.safetyReserve,
          pendingOrderCash: current.pendingOrderCash,
          updatedAt: new Date(operationNowMs).toISOString(),
        })
        if (!validation.ok) throw new Error('CASH_AUTHORITY_INVALID')
        return { ...baseState, cashAssumptions: validation.record }
      },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        cashAssumptions: finalState.cashAssumptions,
      }, operationNowMs),
    )
  },

  // P4.5-A009 / CASH-AUTH-1: export/importで既に検証済みの値をimportする。
  // setCashAssumptionsと異なり、updatedAtは現在時刻で上書きせずimport元の値を
  // そのまま引き継ぐ（呼び出し側の parseCashAssumptionsImport が不正/欠損時に
  // null へ fallback 済み — null は stale 扱いになるため、無警告で「最新」に
  // 昇格することはない）。import は transport であって第3の権限ソースではない。
  importCashAssumptions: ({ grossCash, safetyReserve, pendingOrderCash, updatedAt }) => {
    return runManualPortfolioMutation(
      'importCashAssumptions',
      baseState => {
        const next: CashAssumptions = {
          source: 'MANUAL',
          grossCash,
          safetyReserve,
          pendingOrderCash,
          updatedAt,
        }
        if (!isValidCashAuthorityRecord(next)) throw new Error('CASH_AUTHORITY_INVALID')
        const current = baseState.cashAssumptions
        if (current.source === next.source &&
            current.grossCash === next.grossCash &&
            current.safetyReserve === next.safetyReserve &&
            current.pendingOrderCash === next.pendingOrderCash &&
            current.updatedAt === next.updatedAt) return null
        return { ...baseState, cashAssumptions: next }
      },
      (finalState, operationNowMs) => persistLegacyPortfolioGenerationTransaction({
        cashAssumptions: finalState.cashAssumptions,
      }, operationNowMs),
    )
  },

  // P4.5-A012b: 保有株・投信・現金権限・portfolioPolicyのportfolio snapshotをexportする。
  // どこにも保存しない — 呼び出し側がユーザーに表示し、ユーザー自身がコピーする。
  // CASH-AUTH-1: 権限は state.cashAssumptions ただ一つなので、実効値と保存値が
  // 乖離することはない。未設定（DEFAULT）は未設定のまま書き出す。
  exportPortfolioSnapshot: () => {
    const state = get()
    const exportableCash = buildExportableCashAssumptions(state.cashAssumptions)
    return serializePortfolioSnapshotExport({
      holdings: state.holdings,
      trust: state.trust,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: exportableCash,
      csvImportedAt: state.system.csvLastImportedAt,
      csvImportProvenance: state.system.csvImportProvenance ?? null,
    })
  },

  // P4.5-A012b: 他端末でexportしたportfolio snapshotをimportする。
  // parsePortfolioSnapshotImportが既に個々のフィールドを検証済みだが、それに加えて
  // v1は未知のcode/idを全体rejectし、full-syncのv2/v3は検証済みmetadataからholdingを
  // 安全に再構築する。trust masterは全schemaでregistryとして維持する。
  importPortfolioSnapshot: async (raw) => {
    // T9-A004-R3a: CSV/snapshotは同一の共有transactionを取り合う。既に他のorigin
    // （またはnestedなsnapshot自身）が進行中なら、critical phaseに達しているかを問わず
    // 即座にblockする（importCsvのREADING等の非critical phase中も含む）。
    if (runtime.activePortfolioOperation !== null || runtime.activePortfolioGenerationTransaction !== null) {
      reportRejectedReentrantMutation('importPortfolioSnapshot')
      return createPortfolioCoordinationFailure('importPortfolioSnapshot', 'LOCAL_OPERATION_BUSY')
    }
    const operationTicket = acquirePortfolioOperationFromRuntime(runtime, 'snapshot')
    if (operationTicket === null) {
      reportRejectedReentrantMutation('importPortfolioSnapshot')
      return createPortfolioCoordinationFailure('importPortfolioSnapshot', 'LOCAL_OPERATION_BUSY')
    }
    try {
      const parsed = parsePortfolioSnapshotImport(raw)
      if (!parsed.ok) {
        return {
          ok: false,
          code: parsed.code === 'INVALID_SNAPSHOT_PROVENANCE'
            ? 'INVALID_SNAPSHOT_PROVENANCE'
            : parsed.code === 'INVALID_SNAPSHOT_GENERATION'
              ? 'INVALID_SNAPSHOT_GENERATION'
              : 'INVALID_SNAPSHOT',
          error: parsed.error,
        }
      }
      try {
        const lockResult = await runtime.portfolioGenerationLock.runExclusive(
          'importPortfolioSnapshot',
          async (): Promise<PortfolioSnapshotImportResult> => {
      const transaction: SnapshotImportTransaction = {
        token: Symbol('snapshot-import-owner'),
        origin: 'snapshot',
        phase: 'STAGING',
        analysisNow: Date.now(),
      }
      runtime.activePortfolioGenerationTransaction = transaction
      try {
      const parsedSnapshot = parsed.data
      if (parsedSnapshot.csvImportedAt !== null &&
          !isCsvMetadataTimestampNotFuture(parsedSnapshot.csvImportedAt, transaction.analysisNow)) {
        return {
          ok: false,
          code: 'INVALID_SNAPSHOT_PROVENANCE',
          error: 'snapshotのCSV取込操作時刻が現在時刻より未来または不正なため、取込を中断しました。',
        }
      }
      const validatedCsvImportProvenance = parsedSnapshot.csvImportProvenance === null
        ? null
        : validateCsvImportProvenanceForRestore(
            parsedSnapshot.csvImportProvenance,
            transaction.analysisNow,
          )
      if (parsedSnapshot.csvImportProvenance !== null && validatedCsvImportProvenance === null) {
        return {
          ok: false,
          code: 'INVALID_SNAPSHOT_PROVENANCE',
          error: 'snapshotのCSV provenanceに現在時刻より未来または不正な日時が含まれるため、取込を中断しました。',
        }
      }
      const snapshot = {
        ...parsedSnapshot,
        csvImportProvenance: validatedCsvImportProvenance,
      }
      const state = get()
      const alignment = inspectDurablePortfolioAlignment(runtime, state, transaction.analysisNow)
      if (alignment.status === 'stale') {
        return createPortfolioCoordinationFailure(
          'importPortfolioSnapshot',
          'CROSS_TAB_STATE_STALE',
        )
      }
      if (alignment.status === 'invalid' && !alignment.canonicalInvalid) {
        return {
          ok: false,
          code: 'SNAPSHOT_PERSISTENCE_ERROR',
          error: '保存済みデータを読み込めないため、snapshotの取込を中断しました。再読み込み後に再試行してください。',
        }
      }
      if (alignment.status === 'invalid') {
        return {
          ok: false,
          code: 'SNAPSHOT_CANONICAL_INVALID',
          error: '保存済みの取込世代データが破損しているため、snapshotの取込を中断しました。' +
            '破損した保存世代を修復または削除してから再試行してください。状態は変更されていません。',
        }
      }
      const canonicalPreviousRaw = alignment.canonicalRaw
      const canonicalGeneration = alignment.canonical
      const canonicalPayload = canonicalGeneration.status === 'committed'
        ? canonicalGeneration.payload
        : null

      // Only source provenance participates in monotonicity. exportedAt, csvImportedAt,
      // browser time and File.lastModified are operation/file metadata, never freshness proof.
      // T9-A004-R3d: valid committed canonicalは、storeがempty（hydration前/別tab相当）
      // でもcurrent generation evidenceとして扱う。storeだけを見たALLOW_FIRST_IMPORT
      // 扱いでcommitted世代をsilent overwriteしない。
      const currentGenerationExists = canonicalPayload !== null ||
        hasCurrentPortfolioContentEvidence(state)
      const currentStateIdentity = canonicalPayload === null && currentGenerationExists
        ? computeCurrentSnapshotStateIdentity(state)
        : null
      const canonicalStateIdentity = canonicalPayload !== null
        ? computeCanonicalSnapshotStateIdentity(canonicalPayload)
        : null
      if (snapshot.snapshotGenerationIdentity !== null && (
        (canonicalPayload === null && snapshot.snapshotGenerationIdentity === currentStateIdentity) ||
        (canonicalStateIdentity !== null &&
          snapshot.snapshotGenerationIdentity === canonicalStateIdentity) ||
        (canonicalPayload === null &&
          runtime.lastAppliedSnapshotGeneration?.incomingIdentity === snapshot.snapshotGenerationIdentity &&
          runtime.lastAppliedSnapshotGeneration.currentStateIdentity === currentStateIdentity)
      )) {
        return { ok: true, code: 'DUPLICATE_SNAPSHOT' }
      }
      if (snapshot.csvImportProvenance === null) {
        if (currentGenerationExists) {
          return {
            ok: false,
            code: 'SNAPSHOT_PROVENANCE_UNKNOWN',
            error: 'データ基準情報のないsnapshotでは、この端末の保有データを上書きできません。',
          }
        }
      } else {
        // T9-A004-R3d: 比較対象のcurrent provenanceはcanonical committed世代を優先する
        // （store側がstale/partialでもdurable世代が正）。canonical absent時のみ
        // store世代のprovenanceへfallbackする。
        const currentProvenance = canonicalPayload !== null
          ? canonicalPayload.provenance ?? null
          : state.system.csvImportProvenance ?? null
        const monotonicity = evaluateCsvImportMonotonicity({
          incoming: snapshot.csvImportProvenance,
          current: currentProvenance,
          currentGenerationExists,
        }).decision
        if (monotonicity === 'DUPLICATE') {
          // CSV semantic identity only identifies the CSV source. Snapshot policy, cash, and
          // holdings may still differ, so only the complete identity check above may no-op.
          return {
            ok: false,
            code: 'SNAPSHOT_OVERWRITE_BLOCKED',
            error: '同じCSV由来でもsnapshot全体のgenerationが異なるため、既存データを自動上書きできません。',
          }
        }
        if (monotonicity === 'REJECT_STALE') {
          return {
            ok: false,
            code: 'SNAPSHOT_STALE',
            error: 'この端末の保有データより古いデータ基準時刻のsnapshotのため、取込を中断しました。',
          }
        }
        if (monotonicity === 'REJECT_CONFLICT') {
          return {
            ok: false,
            code: 'SNAPSHOT_PROVENANCE_CONFLICT',
            error: '同じデータ基準時刻で内容識別子が異なるsnapshotのため、取込を中断しました。',
          }
        }
        if (monotonicity === 'REJECT_UNKNOWN_DOWNGRADE') {
          return {
            ok: false,
            code: 'SNAPSHOT_PROVENANCE_UNKNOWN',
            error: 'snapshotのデータ基準情報では安全な上書きを確認できないため、取込を中断しました。',
          }
        }
      }

      // A manual snapshot's provenance and unkeyed generation digest are both self-asserted by
      // anyone able to rewrite the JSON. They detect accidental mixing but do not authenticate a
      // deliberate author, so a different snapshot never receives automatic overwrite authority.
      if (currentGenerationExists) {
        return {
          ok: false,
          code: 'SNAPSHOT_OVERWRITE_BLOCKED',
          error: '別generationのsnapshotでは、この端末の既存保有データを自動上書きできません。',
        }
      }

      const isFullSync = snapshot.schemaVersion !== PORTFOLIO_SNAPSHOT_SCHEMA_VERSION

      let nextHoldings: Holding[]
      if (isFullSync) {
        // P4.5-A013-T7: v2/v3はholdingsをfull-sync（新規追加・受信端末だけの銘柄削除を含む）
        // する。ガード（消滅率>50%または絶対件数>5件）はapplyHoldingsFullSyncFromSnapshot内。
        const holdingsResult = applyHoldingsFullSyncFromSnapshot(state.holdings, snapshot.holdings)
        if (!holdingsResult.ok) return { ok: false, code: 'INVALID_SNAPSHOT', error: holdingsResult.error }
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
            code: 'INVALID_SNAPSHOT',
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
      // Trustを捏造しない（T3の原則）という一線は全schemaで変えない。
      // 違いはunknown idに遭遇した時の扱いのみ:
      //   - v1: 全体reject（既存契約を維持）
      //   - v2/v3: 該当idだけskipし、呼び出し側にskippedTrustIdsとして報告する
      //     （silent ignoreはしない。既知idの通常の値更新は巻き添えでrejectしない）。
      // 既知id側のmerge（eval/pnlPct/dayPct/accountのみ上書き。name/policy/cost/
      // sigma/mu/score/decision/ev等の静的属性・計算結果は保持）は全schemaで共通。
      const currentTrustIds = new Set(state.trust.map(t => t.id))
      const unknownTrustIds = snapshot.trust.filter(t => !currentTrustIds.has(t.id)).map(t => t.id)
      if (unknownTrustIds.length > 0 && !isFullSync) {
        return {
          ok: false,
          code: 'INVALID_SNAPSHOT',
          error: `この端末に存在しない投信IDが含まれています: ${unknownTrustIds.join(', ')}`,
        }
      }
      const skippedTrustIds = isFullSync ? unknownTrustIds : []

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

      // CASH-AUTH-1: importCashAssumptionsと同じ思想 — updatedAtは現在時刻へ
      // 差し替えずimport元をそのまま引き継ぐ（古い権限が無警告でfreshにならない）。
      // parsePortfolioSnapshotImport が identity 検証後に現行スキーマへ移行済み。
      const nextCashAssumptions: CashAssumptions = snapshot.cashAssumptions
        ? { ...snapshot.cashAssumptions }
        : state.cashAssumptions

      // T9-A004-R3c: 新世代のcandidate contentをメモリ上でstageし、analysis・decision・
      // plans・candidatesをpublish前に完了する。ここで失敗してもstore/subscriber/storageの
      // 副作用は0のまま構造化failureを返す（部分世代のset()は一切行わない）。
      const nowIso = new Date(transaction.analysisNow).toISOString()
      const stagedState: AppState = {
        ...state,
        holdings: nextHoldings,
        trust: nextTrust,
        portfolioPolicy: nextPortfolioPolicy,
        cashAssumptions: nextCashAssumptions,
        system: {
          ...state.system,
          // Operation metadata and source provenance are replaced from one incoming generation.
          csvLastImportedAt: snapshot.csvImportedAt,
          csvImportProvenance: snapshot.csvImportProvenance,
          csvSyncSummary: null,
        },
      }

      setPortfolioGenerationTransactionPhase(runtime, transaction, 'ANALYZING')
      let computed: ReturnType<typeof runFullAnalysis>
      try {
        computed = runFullAnalysis(stagedState, { nowMs: transaction.analysisNow })
      } catch {
        return {
          ok: false,
          code: 'SNAPSHOT_ANALYSIS_ERROR',
          error: 'snapshotの分析に失敗しました。状態は変更されていません。',
        }
      }

      // 当該incoming世代からtrust-short baselineをstageする。旧canonical世代の
      // 実行判定baselineを新envelopeへ再添付しない（tracker telemetry本体の
      // 別key契約はここでは変更しない）。staging失敗時は世代をpublishしない。
      let stagedTrustShortSnapshot: TrustShortPortfolioSnapshot
      try {
        stagedTrustShortSnapshot = stageTrustExecutionFromCsvSync(
          computed.trust,
          transaction.analysisNow,
          captureTrustShortPortfolioBaseline(),
        ).snapshot
      } catch {
        return {
          ok: false,
          code: 'SNAPSHOT_ANALYSIS_ERROR',
          error: 'snapshot世代のtracker baseline準備に失敗しました。状態は変更されていません。',
        }
      }

      const payload: CsvImportPersistencePayload = {
        holdings: computed.holdings,
        trust: computed.trust,
        learning: computed.learning,
        csvImportedAt: snapshot.csvImportedAt,
        provenance: snapshot.csvImportProvenance,
        syncSummary: null,
        trustShortSnapshot: stagedTrustShortSnapshot,
        portfolioPolicy: nextPortfolioPolicy,
        cashAssumptions: nextCashAssumptions,
        origin: 'snapshot',
        snapshotTransferIdentity: snapshot.snapshotGenerationIdentity,
      }

      // pre-persist CAS付き単一durable commit。transaction開始時に捕捉したbytesと
      // 物理bytesが一致する場合のみcanonical世代を置換できる（stale writerはconflict）。
      setPortfolioGenerationTransactionPhase(runtime, transaction, 'PERSISTING')
      const generationCommittedAt = Date.now()
      let receipt: CsvImportPersistenceReceipt
      try {
        receipt = persistCsvImportTransaction(payload, generationCommittedAt, canonicalPreviousRaw, {
          schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
        })
      } catch (error) {
        if (error instanceof CsvImportCanonicalConflictError) {
          return {
            ok: false,
            code: 'IMPORT_CONFLICT',
            error: '保存中にcanonicalデータが更新されたため、snapshotの取込を中断しました。再読み込み後に再試行してください。',
          }
        }
        if (error instanceof CsvImportPersistenceIndeterminateError) {
          return {
            ok: false,
            code: 'SNAPSHOT_PERSISTENCE_INDETERMINATE',
            error: '保存結果を確認できません。再読み込みして状態を確認してください。',
            persistence: { status: 'indeterminate' },
          }
        }
        return {
          ok: false,
          code: 'SNAPSHOT_PERSISTENCE_ERROR',
          error: 'snapshotを保存できませんでした。再読み込み後に再試行してください。',
        }
      }
      setPortfolioGenerationTransactionPhase(runtime, transaction, 'COMMITTED')

      // Payload equality is not ownership: only the exact serialized bytes in the receipt
      // prove that this transaction still owns the physical canonical key. 所有権を失った
      // 場合はpublishせず、外部transactionのbytesには一切触れない（rollbackは
      // rollbackCsvImportTransactionのbyte-exact規則でのみ許される）。
      if (!ownsCsvImportCanonicalBytes(receipt)) {
        return {
          ok: false,
          code: 'SNAPSHOT_OWNERSHIP_LOST',
          error: '保存後にcanonical世代の所有権を失ったため、snapshotの取込は公開しませんでした。外部の保存世代を維持したまま再試行してください。',
        }
      }

      const compositionBeforeHook = runtime.testSeams.candidateCompositionBeforeHook
      runtime.testSeams.candidateCompositionBeforeHook = null
      compositionBeforeHook?.()
      const authority = restoreExactCommittedCanonicalAuthority(receipt)
      if (!authority.ok) {
        return {
          ok: false,
          code: 'SNAPSHOT_PERSISTENCE_ERROR',
          error: '保存したcanonical世代を検証できなかったため、snapshotの取込は公開しませんでした。再読み込み後に再試行してください。',
        }
      }
      computed = appendCommittedCandidatePortfolioRecommendations(
        stagedState,
        computed,
        authority,
        transaction.analysisNow,
      )

      const successResult: PortfolioSnapshotImportResult = {
        ok: true,
        code: 'SUCCESS',
        skippedTrustIds: skippedTrustIds.length > 0 ? skippedTrustIds : undefined,
      }
      const markSnapshotGenerationApplied = () => {
        runtime.lastLocallyPersistedLegacyProjection = null
        if (snapshot.snapshotGenerationIdentity !== null) {
          const appliedStateIdentity = computeCurrentSnapshotStateIdentity(get())
          runtime.lastAppliedSnapshotGeneration = appliedStateIdentity === null
            ? null
            : {
                incomingIdentity: snapshot.snapshotGenerationIdentity,
                currentStateIdentity: appliedStateIdentity,
              }
        } else {
          runtime.lastAppliedSnapshotGeneration = null
        }
      }

      // RA-008-C2: transaction-scoped exactly-once invalidation guard (`let`, not module/runtime
      // global — a retried transaction gets a fresh flag). Declared in the outer try's scope so
      // the applied-but-exception catch below — a sibling of the inner publish try — can still
      // reach it via this closure.
      let invalidationEmitted = false
      const emitCommittedInvalidationOnce = (): void => {
        if (invalidationEmitted) return
        invalidationEmitted = true
        emitPortfolioGenerationInvalidationAfterCommit(runtime, {
          operation: 'importPortfolioSnapshot',
          committedAtMs: generationCommittedAt,
        })
      }
      // Reuses the existing projection-equality helper (no new diff formula): a successful
      // snapshot commit that leaves the tracked holdings/trust/policy/cash/CSV-metadata
      // projection unchanged (e.g. a no-op re-apply) must not notify other tabs. This whole
      // computation sits outside the rollback-protected inner try below, so — same fail-safe
      // convention as portfolioGenerationProjectionChanged itself — any failure here must default
      // to "unchanged" rather than risk an uncaught throw skipping byte-exact rollback.
      let projectionChanged = false
      try {
        projectionChanged = portfolioGenerationProjectionChanged(
          buildPublishedPortfolioGenerationProjection(state, transaction.analysisNow),
          buildPublishedPortfolioGenerationProjection({
            ...state,
            ...computed,
            portfolioPolicy: nextPortfolioPolicy,
            cashAssumptions: nextCashAssumptions,
            system: {
              ...state.system,
              csvLastImportedAt: snapshot.csvImportedAt,
              csvImportProvenance: snapshot.csvImportProvenance,
              csvSyncSummary: null,
            },
          }, transaction.analysisNow),
        )
      } catch {
        projectionChanged = false
      }

      try {
        // A valid canonical generation is the only durable writer. Legacy helpers are reserved
        // for canonical absence and are not used as mirrors behind a committed envelope.
        const localStorageFreshness = computeLocalStorageFreshness(generationCommittedAt)

        // T9-A004-R3-FIX-B (R3-F002): freshness用の最後のstorage readの後、Zustand
        // set直前にfinal ownershipを再確認する。read中に外部writerがcanonicalを
        // 置換した場合はincoming世代をpublishせず（generation通知・
        // lastAppliedSnapshotGeneration更新も0）、外部bytesにはbyte-exact規則上一切
        // 触れない（所有していないbytesへのrollback/deleteは存在しない）。
        if (!ownsCsvImportCanonicalBytes(receipt)) {
          return {
            ok: false,
            code: 'SNAPSHOT_OWNERSHIP_LOST',
            error: '公開直前にcanonical世代の所有権を失ったため、snapshotの取込は公開しませんでした。外部の保存世代を維持したまま再試行してください。',
          }
        }

        // durable commit確認後の完全世代を単一set()でpublishする。subscriberは
        // content・analysis・officialDecision・plans・candidates・policy・cash・
        // provenance・freshness・statusを同一通知で観測し、部分世代は存在しない。
        // csvSyncSummaryはここでは一切変更しない（snapshot importをCSV取込結果として
        // 偽装しないため。P4.5-A013-T6の方針を維持する）。
        set(s => ({
          ...computed,
          portfolioPolicy: nextPortfolioPolicy,
          cashAssumptions: nextCashAssumptions,
          system: {
            ...s.system,
            status: 'success',
            csvLastImportedAt: snapshot.csvImportedAt,
            csvImportProvenance: snapshot.csvImportProvenance,
            csvSyncSummary: null,
            analysisLastRunAt: nowIso,
            error: null,
            localStorageFreshness,
          },
        }))
        setPortfolioGenerationTransactionPhase(runtime, transaction, 'PUBLISHED')
        markSnapshotGenerationApplied()
        if (projectionChanged) emitCommittedInvalidationOnce()
        return successResult
      } catch (error) {
        // durable commit後・publish完了前の例外。zustandはlistener通知前にstateを
        // 適用するため、新世代が既にstoreへ載っていればcommitted generationとして
        // SUCCESSを返す（throwing observerが成立済み世代を偽failure化しない）。
        // 載っていなければbyte-exact rollbackを試み、物理状態を偽らずに報告する。
        if (get().holdings === computed.holdings) {
          try { console.error('[useAppStore] post-commit snapshot publish diagnostic', error) } catch { /* diagnostic sink */ }
          markSnapshotGenerationApplied()
          // RA-008-C2: normal path never reached its own emit call (it threw before/at set()),
          // so the exactly-once guard has not fired yet here — this is the transaction's one shot.
          if (projectionChanged) emitCommittedInvalidationOnce()
          return successResult
        }
        const rolledBack = rollbackCsvImportTransaction(receipt)
        return {
          ok: false,
          code: 'SNAPSHOT_PERSISTENCE_ERROR',
          error: rolledBack
            ? '公開直前にエラーが発生したため、保存済みのsnapshot世代を取り消しました。状態は変更されていません。再試行してください。'
            : '公開直前にエラーが発生し、保存済みsnapshot世代の取り消しを確認できませんでした。再読み込み後に内容を確認してください。',
        }
      }
    } finally {
      if (runtime.activePortfolioGenerationTransaction?.token === transaction.token) {
        runtime.activePortfolioGenerationTransaction = null
      }
      }
          },
        )
        return lockResult.ok
          ? lockResult.value
          : createPortfolioCoordinationFailure('importPortfolioSnapshot', lockResult.code)
      } catch {
        return {
          ok: false,
          code: 'SNAPSHOT_PERSISTENCE_ERROR',
          error: 'snapshot処理を安全に完了できませんでした。再読み込み後に再試行してください。',
        }
      }
    } finally {
      releasePortfolioOperationFromRuntime(runtime, operationTicket)
    }
  },
  })
}

export interface AppStoreInstanceTestControls {
  acquirePortfolioOperation(kind: PortfolioOperationKind): PortfolioOperationTicket | null
  releasePortfolioOperation(ticket: PortfolioOperationTicket): boolean
  setPortfolioGenerationPhaseObserver(observer: PortfolioGenerationPhaseObserverForTest): void
  setCandidateCompositionBeforeHook(hook: () => void): void
  setManualPublishBeforeApplyHook(hook: () => void): void
  setLoadPublishBeforeApplyHook(hook: () => void): void
  setLoadRestoreBeforeReadHook(hook: () => void): void
  reset(): void
  /** @internal RA-008-D seam: clears pending only after a verified alignment read. Not used in B2 production paths. */
  clearPendingInvalidationAfterVerifiedAlignment(): void
  /** @internal Test-instance cleanup: unsubscribes and disposes this instance's invalidation transport. Idempotent. */
  dispose(): void
  inspect(): {
    activeOperationKind: PortfolioOperationKind | null
    activeGenerationOrigin: 'csv' | 'snapshot' | null
    activeGenerationPhase: CsvImportTransactionPhase | null
    hasSnapshotCache: boolean
    hasPhaseObserver: boolean
    hasCandidateCompositionHook: boolean
    hasManualPublishHook: boolean
    hasLoadPublishHook: boolean
    hasLoadRestoreHook: boolean
    invalidationInstanceId: string
    hasInvalidationSubscription: boolean
    hasInvalidationFlushCallback: boolean
    invalidationDisposed: boolean
    invalidationReceiveSequence: number
    invalidationClearWatermark: number
    pendingInvalidation: {
      messageId: string
      senderInstanceId: string
      committedAt: string
      operation: PortfolioGenerationOperation
      receivedSequence: number
    } | null
  }
}

export interface CreateAppStoreInstanceForTestOptions {
  portfolioGenerationLock?: PortfolioGenerationLockAdapter
  portfolioGenerationInvalidation?: PortfolioGenerationInvalidationRuntimeDependency
}

/** @internal Test-only factory for a vanilla store with an isolated coordination runtime. */
export function createAppStoreInstanceForTest(
  options: CreateAppStoreInstanceForTestOptions = {},
): {
  store: StoreApi<AppStoreState>
  controls: AppStoreInstanceTestControls
} {
  const runtime = createAppStoreRuntime(
    options.portfolioGenerationLock,
    options.portfolioGenerationInvalidation ?? createDefaultTestInvalidationDependency(),
  )
  const store = createStore<AppStoreState>(createAppStoreStateCreator(runtime))
  // Surfaces a remote event recorded before this store existed (e.g. a transport whose
  // subscribe() replays synchronously) — safe only now that createStore has returned.
  flushPendingCrossTabInvalidationToStore(runtime)
  const controls: AppStoreInstanceTestControls = {
    acquirePortfolioOperation: kind => acquirePortfolioOperationFromRuntime(runtime, kind),
    releasePortfolioOperation: ticket => releasePortfolioOperationFromRuntime(runtime, ticket),
    setPortfolioGenerationPhaseObserver: observer => {
      runtime.testSeams.portfolioGenerationPhaseObserver = observer
    },
    setCandidateCompositionBeforeHook: hook => {
      runtime.testSeams.candidateCompositionBeforeHook = hook
    },
    setManualPublishBeforeApplyHook: hook => {
      runtime.testSeams.manualPublishBeforeApplyHook = hook
    },
    setLoadPublishBeforeApplyHook: hook => {
      runtime.testSeams.loadPublishBeforeApplyHook = hook
    },
    setLoadRestoreBeforeReadHook: hook => {
      runtime.testSeams.loadRestoreBeforeReadHook = hook
    },
    reset: () => {
      resetAppStoreRuntime(runtime)
      // Test-cleanup only (not a production clear authority, see RA-008-D1): re-arms the
      // instance for the next test's idle-receive assertions without a stale carryover warning.
      store.setState(state => ({ system: { ...state.system, crossTabInvalidation: undefined } }))
    },
    clearPendingInvalidationAfterVerifiedAlignment: () =>
      clearPendingCrossTabInvalidationAfterVerifiedAlignment(runtime),
    dispose: () => disposeAppStoreRuntimeInvalidation(runtime),
    inspect: () => ({
      activeOperationKind: runtime.activePortfolioOperation?.kind ?? null,
      activeGenerationOrigin: runtime.activePortfolioGenerationTransaction?.origin ?? null,
      activeGenerationPhase: runtime.activePortfolioGenerationTransaction?.phase ?? null,
      hasSnapshotCache: runtime.lastAppliedSnapshotGeneration !== null,
      hasPhaseObserver: runtime.testSeams.portfolioGenerationPhaseObserver !== null,
      hasCandidateCompositionHook: runtime.testSeams.candidateCompositionBeforeHook !== null,
      hasManualPublishHook: runtime.testSeams.manualPublishBeforeApplyHook !== null,
      hasLoadPublishHook: runtime.testSeams.loadPublishBeforeApplyHook !== null,
      hasInvalidationFlushCallback: runtime.portfolioGenerationInvalidation.flushPendingToStore !== null,
      hasLoadRestoreHook: runtime.testSeams.loadRestoreBeforeReadHook !== null,
      invalidationInstanceId: runtime.portfolioGenerationInvalidation.instanceId,
      hasInvalidationSubscription: runtime.portfolioGenerationInvalidation.unsubscribe !== null,
      invalidationDisposed: runtime.portfolioGenerationInvalidation.disposed,
      invalidationReceiveSequence: runtime.portfolioGenerationInvalidation.receiveSequence,
      invalidationClearWatermark: runtime.portfolioGenerationInvalidation.clearWatermark,
      pendingInvalidation: runtime.portfolioGenerationInvalidation.pending
        ? {
            messageId: runtime.portfolioGenerationInvalidation.pending.event.messageId,
            senderInstanceId: runtime.portfolioGenerationInvalidation.pending.event.senderInstanceId,
            committedAt: runtime.portfolioGenerationInvalidation.pending.event.committedAt,
            operation: runtime.portfolioGenerationInvalidation.pending.event.operation,
            receivedSequence: runtime.portfolioGenerationInvalidation.pending.receivedSequence,
          }
        : null,
    }),
  }
  return { store, controls }
}

export const useAppStore = create<AppStoreState>(
  createAppStoreStateCreator(defaultAppStoreRuntime),
)
// Surfaces a remote event recorded before this store existed — safe only now that create() has
// returned (see the matching call in createAppStoreInstanceForTest).
flushPendingCrossTabInvalidationToStore(defaultAppStoreRuntime)
