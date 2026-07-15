import type { Holding, Trust, LearningState, PortfolioPolicy, CashAssumptions, CsvSyncSummary } from '../types'
import { sanitizeLearningState } from '../domain/learning/performanceTracker'
import type { TrustShortPortfolioSnapshot } from '../domain/learning/trustShortTracker'

const PORTFOLIO_KEY = 'v81_portfolio'
const TRUST_KEY = 'v81_trust'
const LEARNING_KEY = 'v91_learning'
const CSV_IMPORTED_AT_KEY = 'v10_csv_imported_at'  // Phase 8: CSV取込時刻永続化
const TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7日
const LEARNING_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const CSV_IMPORT_GENERATION_KEY = 'v13_csv_import_committed_generation'
export const CSV_IMPORT_GENERATION_SCHEMA = 'csv-import-generation-1' as const

interface Snapshot<T> {
  data: T
  savedAt: number
}

export interface CsvImportPersistencePayload {
  holdings: Holding[]
  trust: Trust[]
  learning: LearningState | null
  importedAt: string
  syncSummary: CsvSyncSummary
  trustShortSnapshot: TrustShortPortfolioSnapshot
}

interface CsvImportGenerationManifest {
  schemaVersion: typeof CSV_IMPORT_GENERATION_SCHEMA
  generationId: string
  savedAt: number
  committed: true
  payloadChecksum: string
}

interface CsvImportGenerationEnvelope {
  manifest: CsvImportGenerationManifest
  payload: CsvImportPersistencePayload
}

export type CsvImportGenerationRestoreResult =
  | { status: 'committed'; generationId: string; savedAt: number; payload: CsvImportPersistencePayload }
  | { status: 'none' | 'invalid' }

export class CsvImportPersistenceError extends Error {
  readonly status: 'not_attempted' | 'rolled_back' | 'rollback_failed'

  constructor(message: string, status: 'not_attempted' | 'rolled_back' | 'rollback_failed') {
    super(message)
    this.name = 'CsvImportPersistenceError'
    this.status = status
  }
}

// P4.5-A012d: localStorage保存データの鮮度（表示専用）。
// TTLを超えても値そのものは削除しないため、「保存されているか／古いか」を
// UI側でstale警告に使うための読み取り専用ヘルパー。
export interface StorageFreshness {
  exists: boolean
  isStale: boolean
  savedAt: number | null
  ageDays: number | null
}

const NOT_SAVED_FRESHNESS: StorageFreshness = { exists: false, isStale: false, savedAt: null, ageDays: null }

let generationSequence = 0

function checksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function isTrustShortSnapshot(value: unknown): value is TrustShortPortfolioSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<TrustShortPortfolioSnapshot>
  return typeof snapshot.date === 'string' &&
    typeof snapshot.total === 'number' && Number.isFinite(snapshot.total) &&
    snapshot.evalById !== null && typeof snapshot.evalById === 'object' &&
    Object.values(snapshot.evalById).every(item => typeof item === 'number' && Number.isFinite(item))
}

function isCsvImportPayload(value: unknown): value is CsvImportPersistencePayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<CsvImportPersistencePayload>
  return Array.isArray(payload.holdings) &&
    Array.isArray(payload.trust) &&
    (payload.learning === null || (payload.learning !== null && typeof payload.learning === 'object')) &&
    typeof payload.importedAt === 'string' &&
    payload.syncSummary !== null && typeof payload.syncSummary === 'object' &&
    isTrustShortSnapshot(payload.trustShortSnapshot)
}

/**
 * Canonical CSV generation reader. A present but malformed envelope is invalid and must not
 * fall back to possibly partial legacy keys. Legacy fallback is allowed only when no envelope
 * exists, which preserves backward compatibility without blessing a damaged generation.
 */
export function restoreCsvImportGeneration(): CsvImportGenerationRestoreResult {
  if (typeof localStorage === 'undefined') return { status: 'invalid' }
  try {
    const raw = localStorage.getItem(CSV_IMPORT_GENERATION_KEY)
    if (raw === null) return { status: 'none' }
    const envelope = JSON.parse(raw) as Partial<CsvImportGenerationEnvelope>
    const manifest = envelope.manifest
    if (
      !manifest ||
      manifest.schemaVersion !== CSV_IMPORT_GENERATION_SCHEMA ||
      typeof manifest.generationId !== 'string' || manifest.generationId.length === 0 ||
      typeof manifest.savedAt !== 'number' || !Number.isFinite(manifest.savedAt) ||
      manifest.committed !== true ||
      typeof manifest.payloadChecksum !== 'string' ||
      !isCsvImportPayload(envelope.payload)
    ) return { status: 'invalid' }
    const serializedPayload = JSON.stringify(envelope.payload)
    if (checksum(serializedPayload) !== manifest.payloadChecksum) return { status: 'invalid' }
    return {
      status: 'committed',
      generationId: manifest.generationId,
      savedAt: manifest.savedAt,
      payload: envelope.payload,
    }
  } catch {
    return { status: 'invalid' }
  }
}

function persistUpdatedCommittedGeneration(
  update: (payload: CsvImportPersistencePayload) => CsvImportPersistencePayload,
): boolean {
  const current = restoreCsvImportGeneration()
  if (current.status !== 'committed') return false
  try {
    persistCsvImportTransaction(update(current.payload))
  } catch {
    // Individual helpers retain their historical best-effort contract.
  }
  return true
}

function readStorageFreshness(key: string, ttlMs: number): StorageFreshness {
  try {
    if (key === PORTFOLIO_KEY || key === TRUST_KEY) {
      const generation = restoreCsvImportGeneration()
      if (generation.status === 'committed') {
        const ageMs = Date.now() - generation.savedAt
        return {
          exists: true,
          isStale: ageMs > ttlMs,
          savedAt: generation.savedAt,
          ageDays: ageMs / (24 * 60 * 60 * 1000),
        }
      }
      if (generation.status === 'invalid') return NOT_SAVED_FRESHNESS
    }
    const raw = localStorage.getItem(key)
    if (!raw) return NOT_SAVED_FRESHNESS
    const snap = JSON.parse(raw) as Snapshot<unknown>
    if (typeof snap?.savedAt !== 'number') return NOT_SAVED_FRESHNESS
    const ageMs = Date.now() - snap.savedAt
    return {
      exists: true,
      isStale: ageMs > ttlMs,
      savedAt: snap.savedAt,
      ageDays: ageMs / (24 * 60 * 60 * 1000),
    }
  } catch { return NOT_SAVED_FRESHNESS }
}

export function persistPortfolio(holdings: Holding[]): void {
  if (persistUpdatedCommittedGeneration(payload => ({ ...payload, holdings }))) return
  const snap: Snapshot<Holding[]> = { data: holdings, savedAt: Date.now() }
  try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

// P4.5-A012d: TTL失効による無警告revertを廃止する（P4.5-A008のcashAssumptionsと同じ
// 思想）。CSVで取り込んだ保有株の実額が、7日経過しただけで黙って初期値（constants
// fallback）へ戻ってしまうと、資産配分・headroom等の判断が気づかれずに変わって
// しまうため。鮮度はgetPortfolioStorageFreshness()で表示専用に扱う。
export function restorePortfolio(): Holding[] | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') return generation.payload.holdings
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(PORTFOLIO_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<Holding[]>
    return snap.data
  } catch { return null }
}

export function getPortfolioStorageFreshness(): StorageFreshness {
  return readStorageFreshness(PORTFOLIO_KEY, TTL_MS)
}

export function persistTrust(trust: Trust[]): void {
  if (persistUpdatedCommittedGeneration(payload => ({ ...payload, trust }))) return
  const snap: Snapshot<Trust[]> = { data: trust, savedAt: Date.now() }
  try { localStorage.setItem(TRUST_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

// P4.5-A012d: restorePortfolioと同じ理由でTTL失効による無警告revertを廃止する。
export function restoreTrust(): Trust[] | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') return generation.payload.trust
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(TRUST_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<Trust[]>
    return snap.data
  } catch { return null }
}

export function getTrustStorageFreshness(): StorageFreshness {
  return readStorageFreshness(TRUST_KEY, TTL_MS)
}

export function persistLearning(learning: LearningState): void {
  if (persistUpdatedCommittedGeneration(payload => ({ ...payload, learning }))) return
  const snap: Snapshot<LearningState> = { data: learning, savedAt: Date.now() }
  try { localStorage.setItem(LEARNING_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restoreLearning(): LearningState | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      if (Date.now() - generation.savedAt > LEARNING_TTL_MS) return null
      return generation.payload.learning ? sanitizeLearningState(generation.payload.learning) : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(LEARNING_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<unknown>
    if (Date.now() - snap.savedAt > LEARNING_TTL_MS) {
      localStorage.removeItem(LEARNING_KEY)
      return null
    }
    return sanitizeLearningState(snap.data)
  } catch { return null }
}

// ── Phase 8: CSV取込時刻の永続化（リロード跨ぎ・90日TTL） ─────
const CSV_TTL_MS = 90 * 24 * 60 * 60 * 1000  // 90日

interface CsvSnapshot { at: string; savedAt: number }

export function persistCsvImportedAt(at: string): void {
  if (persistUpdatedCommittedGeneration(payload => ({ ...payload, importedAt: at }))) return
  const snap: CsvSnapshot = { at, savedAt: Date.now() }
  try { localStorage.setItem(CSV_IMPORTED_AT_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restoreCsvImportedAt(): string | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      return Date.now() - generation.savedAt <= CSV_TTL_MS ? generation.payload.importedAt : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(CSV_IMPORTED_AT_KEY)
    if (!raw) return null
    // レガシー: 生のISO文字列だった場合は移行
    if (!raw.startsWith('{')) {
      localStorage.removeItem(CSV_IMPORTED_AT_KEY)
      return null
    }
    const snap = JSON.parse(raw) as CsvSnapshot
    if (Date.now() - snap.savedAt > CSV_TTL_MS) {
      localStorage.removeItem(CSV_IMPORTED_AT_KEY)
      return null
    }
    return snap.at
  } catch { return null }
}

// ── P4.5-A013-T6: CSV取込結果summaryの永続化（表示専用・90日TTL） ──────
// csvLastImportedAtと同じTTLを使う（詳細summaryは「最終CSV取込がいつだったか」の
// 補助情報であり、csvLastImportedAt自体のTTL失効時に古い詳細だけが残っても
// 意味がないため）。portfolio snapshot importはこのkeyへ一切書き込まない
// （snapshot importの結果をCSV取込結果として偽装しないため）。
const CSV_SYNC_SUMMARY_KEY = 'v13_csv_sync_summary'

interface CsvSyncSummarySnapshot { data: CsvSyncSummary; savedAt: number }

/**
 * CSV import専用の同期永続化境界。
 *
 * 通常の個別persist helperは既存互換のためquota例外を握り潰すが、CSV importは
 * UI成功判定へ結果を返す必要がある。payload・manifest・commit markerを単一envelopeへ
 * serializeし、canonical keyを1回だけ置換する。localStorageの単一setItemが失敗した
 * 場合は旧envelopeが有効なままで、multi-key rollbackやその再失敗に依存しない。
 */
export function persistCsvImportTransaction(payload: CsvImportPersistencePayload): void {
  if (typeof localStorage === 'undefined') {
    throw new CsvImportPersistenceError('永続化ストレージを利用できません', 'not_attempted')
  }

  const savedAt = Date.now()
  let serializedEnvelope: string
  try {
    const serializedPayload = JSON.stringify(payload)
    const generationId = `${savedAt.toString(36)}-${(generationSequence += 1).toString(36)}`
    serializedEnvelope = JSON.stringify({
      manifest: {
        schemaVersion: CSV_IMPORT_GENERATION_SCHEMA,
        generationId,
        savedAt,
        committed: true,
        payloadChecksum: checksum(serializedPayload),
      },
      payload,
    } satisfies CsvImportGenerationEnvelope)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CsvImportPersistenceError(`CSV取込データを保存形式へ変換できませんでした: ${detail}`, 'not_attempted')
  }

  try {
    localStorage.setItem(CSV_IMPORT_GENERATION_KEY, serializedEnvelope)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CsvImportPersistenceError(`CSV取込データの永続化に失敗しました: ${detail}`, 'rolled_back')
  }
}

export function persistCsvSyncSummary(summary: CsvSyncSummary): void {
  if (persistUpdatedCommittedGeneration(payload => ({ ...payload, syncSummary: summary }))) return
  const snap: CsvSyncSummarySnapshot = { data: summary, savedAt: Date.now() }
  try { localStorage.setItem(CSV_SYNC_SUMMARY_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restoreCsvSyncSummary(): CsvSyncSummary | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      return Date.now() - generation.savedAt <= CSV_TTL_MS ? generation.payload.syncSummary : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(CSV_SYNC_SUMMARY_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as CsvSyncSummarySnapshot
    if (Date.now() - snap.savedAt > CSV_TTL_MS) {
      localStorage.removeItem(CSV_SYNC_SUMMARY_KEY)
      return null
    }
    return snap.data
  } catch { return null }
}

export function restoreCsvTrustShortSnapshot(): TrustShortPortfolioSnapshot | null {
  const generation = restoreCsvImportGeneration()
  return generation.status === 'committed' ? generation.payload.trustShortSnapshot : null
}

// ── P4-A47: PortfolioPolicy 永続化（TTL: 7日） ─────────────
const PORTFOLIO_POLICY_KEY = 'v13_portfolio_policy'

export function persistPortfolioPolicy(policy: PortfolioPolicy): void {
  const snap: Snapshot<PortfolioPolicy> = { data: policy, savedAt: Date.now() }
  try { localStorage.setItem(PORTFOLIO_POLICY_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restorePortfolioPolicy(): PortfolioPolicy | null {
  try {
    const raw = localStorage.getItem(PORTFOLIO_POLICY_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<PortfolioPolicy>
    if (Date.now() - snap.savedAt > TTL_MS) {
      localStorage.removeItem(PORTFOLIO_POLICY_KEY)
      return null
    }
    const r = snap.data?.jpStockMaxRatio
    if (typeof r !== 'number' || r < 0.05 || r > 0.30) return null
    return { jpStockMaxRatio: r }
  } catch { return null }
}

// ── P4.5-A002: 資金前提（現金・待機資金）手動override 永続化（TTL: 7日） ──
// この端末（ブラウザ）にのみ保存される。PC/スマホ間の自動共有は未実装（次チケットで検討）。
const CASH_ASSUMPTIONS_KEY = 'v13_cash_assumptions'

export function persistCashAssumptions(assumptions: CashAssumptions): void {
  const snap: Snapshot<CashAssumptions> = { data: assumptions, savedAt: Date.now() }
  try { localStorage.setItem(CASH_ASSUMPTIONS_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restoreCashAssumptions(): CashAssumptions | null {
  try {
    const raw = localStorage.getItem(CASH_ASSUMPTIONS_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<CashAssumptions>
    // P4.5-A008: 資金前提はTTL失効による無警告revertを廃止する（手動値が黙って既定値へ
    // 戻ると、総資産分母・headroom・P5買付余力が気づかれずに変わってしまうため）。
    // 鮮度はmanualUpdatedAt基準のstale警告（selectCashAssumptionsFreshness）で表示専用に扱う。
    const d = snap.data
    if (
      typeof d?.cashDeposits !== 'number' || !Number.isFinite(d.cashDeposits) || d.cashDeposits < 0 ||
      typeof d?.standbyFunds !== 'number' || !Number.isFinite(d.standbyFunds) || d.standbyFunds < 0 ||
      typeof d?.manualOverrideEnabled !== 'boolean'
    ) return null
    return {
      cashDeposits: d.cashDeposits,
      standbyFunds: d.standbyFunds,
      manualOverrideEnabled: d.manualOverrideEnabled,
      manualUpdatedAt: typeof d.manualUpdatedAt === 'string' ? d.manualUpdatedAt : null,
    }
  } catch { return null }
}
