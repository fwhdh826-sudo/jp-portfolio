// ═══════════════════════════════════════════════════════════

import { isStrictTimestamp } from './strictTimestamp'
import type { CashAssumptions, CsvImportProvenance } from '../types'
import { isCsvImportProvenance } from '../domain/csv/csvProvenance'
import {
  NO_CASH_AUTHORITY,
  isIntegerJpy,
  normalizeCashAuthorityRecord,
} from '../domain/cash/cashAuthority'
import {
  computeSnapshotGenerationIdentity,
  isLegacyCashAssumptionsIdentityShape,
  isSnapshotGenerationIdentity,
  type LegacyCashAssumptionsIdentityShape,
} from './snapshotGenerationIdentity'
// P4.5-A012a: 保有株・投信・現金前提・portfolioPolicyのportfolio snapshot
// export/import — 表示専用のシリアライズ/検証のみ。
// PC/スマホ間の同期はユーザーがJSON文字列を手動でコピー/貼り付けする方式に限定する
// （src/utils/cashAssumptionsTransfer.tsと同一の設計方針）。
// public repo / public data JSON / workflow / backend への書き出しは一切行わない。
//
// score / decision / ev / officialDecision / zeroPlan / candidateActions等の
// 計算結果・投資判断結果は一切含めない。含めるのはCSV取込等で更新される
// 「入力値」のみ（import後はrunFullAnalysisが再計算する前提）。
// ═══════════════════════════════════════════════════════════

export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = 'portfolio-snapshot-1' as const
// P4.5-A013-T7: v2はholdingsのfull-sync（新規銘柄追加・受信端末だけの銘柄削除）に
// 必要なmetadata（name/sector/mu/sigma/sigmaSource/beta）を追加した拡張schema。
// v1は既存のupdate-only契約のまま残し、importでは両方を受け付ける（後方互換）。
export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2 = 'portfolio-snapshot-2' as const
// T9-A004-R2: v3 transports the CSV source provenance belonging to the exported
// portfolio generation. exportedAt is operation-only and excluded from the binding;
// csvImportedAt remains non-authoritative operation metadata but is bound as transported state.
export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3 = 'portfolio-snapshot-3' as const
export type PortfolioSnapshotSchemaVersion =
  | typeof PORTFOLIO_SNAPSHOT_SCHEMA_VERSION
  | typeof PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2
  | typeof PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3

export interface PortfolioSnapshotHolding {
  code: string
  eval: number
  pnlPct: number
  currentPrice?: number
  acquiredAt?: string | null
  // P4.5-A013-T7: v2専用の追加metadata。v1は含まないため全てoptional。
  // nameはv2で新規銘柄追加に必須（受信側でHoldingを再構築するため）だが、
  // v1payloadとの型互換のためここではoptionalにし、schemaVersion別に
  // validateHoldingEntry側で必須性を切り替える。
  name?: string
  sector?: string
  mu?: number
  sigma?: number
  sigmaSource?: 'yfinance' | 'static'
  beta?: number
}

export interface PortfolioSnapshotTrust {
  id: string
  eval: number
  pnlPct: number
  dayPct?: number
  account?: string | null
}

export interface PortfolioSnapshotPortfolioPolicy {
  jpStockMaxRatio: number
}

/**
 * CASH-AUTH-1: snapshot 上の現金権限。export は常に現行スキーマで書き出すが、
 * import は CASH-AUTH-1 以前に出力された legacy スキーマも受理する
 * （generation identity は出力時のバイト列で検証してから移行する）。
 */
export type PortfolioSnapshotCashAssumptions = CashAssumptions
export type PortfolioSnapshotCashAssumptionsWire =
  | CashAssumptions
  | LegacyCashAssumptionsIdentityShape

export interface PortfolioSnapshotExportPayload {
  schemaVersion: PortfolioSnapshotSchemaVersion
  exportedAt: string
  csvImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
  snapshotGenerationIdentity: string
  source: 'manual'
  holdings: PortfolioSnapshotHolding[]
  trust: PortfolioSnapshotTrust[]
  portfolioPolicy: PortfolioSnapshotPortfolioPolicy | null
  cashAssumptions: PortfolioSnapshotCashAssumptions | null
}

export interface PortfolioSnapshotData {
  schemaVersion: PortfolioSnapshotSchemaVersion
  exportedAt: string
  csvImportedAt: string | null
  /** null for legacy v1/v2 and for an explicitly unknown v3 generation. */
  csvImportProvenance: CsvImportProvenance | null
  /** Required and independently verified for v3; null for legacy v1/v2. */
  snapshotGenerationIdentity: string | null
  holdings: PortfolioSnapshotHolding[]
  trust: PortfolioSnapshotTrust[]
  portfolioPolicy: PortfolioSnapshotPortfolioPolicy | null
  cashAssumptions: PortfolioSnapshotCashAssumptions | null
}

export type PortfolioSnapshotParseResult =
  | { ok: true; data: PortfolioSnapshotData }
  | { ok: false; error: string; code?: 'INVALID_SNAPSHOT_PROVENANCE' | 'INVALID_SNAPSHOT_GENERATION' }

// 異常に大きすぎる値のガード（cashAssumptionsTransfer.tsと同じ基準。1兆円）
const MAX_REASONABLE_AMOUNT = 1_000_000_000_000
// pnlPct/dayPctの異常値ガード（厳密なドメイン制約ではなく、壊れた入力の弾き取り専用）
const MIN_REASONABLE_PCT = -100
const MAX_REASONABLE_PCT = 100_000

function isValidAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_REASONABLE_AMOUNT
}

function isValidPercent(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_REASONABLE_PCT && v <= MAX_REASONABLE_PCT
}

function isValidOptionalString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string'
}

function isValidIsoDateString(v: unknown): boolean {
  return isStrictTimestamp(v)
}

/**
 * 保有株・投信・現金前提・portfolioPolicyをexport用JSON文字列に変換する
 * （表示・コピー用。どこにも保存しない）。
 *
 * 呼び出し側が本物のHolding[]/Trust[]（score/decision/ev等の計算結果を含む）を
 * 渡してしまっても情報が漏れないよう、この関数の内部で必要なフィールドのみを
 * 明示的に抽出（pick）してからJSON化する。
 *
 * P4.5-A013-T7: schemaVersion v2で出力する。CSV full-sync後に増える新規個別株を
 * 別端末でも再現できるよう、name/sector/mu/sigma/sigmaSource/betaを追加で含める
 * （score/decision/ev等の計算結果は引き続き含めない）。
 */
export function serializePortfolioSnapshotExport(args: {
  holdings: Array<{
    code: string
    name: string
    eval: number
    pnlPct: number
    currentPrice?: number
    acquiredAt?: string | null
    sector?: string
    mu?: number
    sigma?: number
    sigmaSource?: 'yfinance' | 'static'
    beta?: number
  }>
  trust: Array<{ id: string; eval: number; pnlPct: number; dayPct?: number; account?: string | null }>
  portfolioPolicy: PortfolioSnapshotPortfolioPolicy | null
  cashAssumptions: PortfolioSnapshotCashAssumptions | null
  csvImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
}): string {
  const holdings: PortfolioSnapshotHolding[] = args.holdings.map(h => {
    const picked: PortfolioSnapshotHolding = { code: h.code, name: h.name, eval: h.eval, pnlPct: h.pnlPct }
    if (h.currentPrice !== undefined) picked.currentPrice = h.currentPrice
    if (h.acquiredAt !== undefined) picked.acquiredAt = h.acquiredAt ?? null
    if (h.sector !== undefined) picked.sector = h.sector
    if (h.mu !== undefined) picked.mu = h.mu
    if (h.sigma !== undefined) picked.sigma = h.sigma
    if (h.sigmaSource !== undefined) picked.sigmaSource = h.sigmaSource
    if (h.beta !== undefined) picked.beta = h.beta
    return picked
  })

  const trust: PortfolioSnapshotTrust[] = args.trust.map(t => {
    const picked: PortfolioSnapshotTrust = { id: t.id, eval: t.eval, pnlPct: t.pnlPct }
    if (t.dayPct !== undefined) picked.dayPct = t.dayPct
    if (t.account !== undefined) picked.account = t.account ?? null
    return picked
  })

  const portfolioPolicy: PortfolioSnapshotPortfolioPolicy | null = args.portfolioPolicy
    ? { jpStockMaxRatio: args.portfolioPolicy.jpStockMaxRatio }
    : null

  // CASH-AUTH-1: 権限は state.cashAssumptions ただ一つ。丸めや再構成をせず
  // そのまま書き出す（数値契約は保存時点で既に検証済み）。
  const cashAssumptions: PortfolioSnapshotCashAssumptions | null = args.cashAssumptions
    ? {
        source: args.cashAssumptions.source,
        grossCash: args.cashAssumptions.grossCash,
        safetyReserve: args.cashAssumptions.safetyReserve,
        pendingOrderCash: args.cashAssumptions.pendingOrderCash,
        updatedAt: args.cashAssumptions.updatedAt,
      }
    : null

  const payload: PortfolioSnapshotExportPayload = {
    schemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3,
    exportedAt: new Date().toISOString(),
    csvImportedAt: args.csvImportedAt,
    csvImportProvenance: args.csvImportProvenance,
    snapshotGenerationIdentity: computeSnapshotGenerationIdentity({
      holdings,
      trust,
      portfolioPolicy,
      cashAssumptions,
      csvImportedAt: args.csvImportedAt,
      csvImportProvenance: args.csvImportProvenance,
    }),
    source: 'manual',
    holdings,
    trust,
    portfolioPolicy,
    cashAssumptions,
  }
  return JSON.stringify(payload, null, 2)
}

// P4.5-A013-T7: mu/sigma/betaの妥当範囲ガード（厳密なドメイン制約ではなく、
// 壊れた入力・桁違いの入力を弾き取るための緩めの上限）。constants/holdings.tsの
// 実データ（mu: -0.05〜0.20、sigma: 0.15〜0.35、beta: 0.7〜1.4程度）より
// 十分広く取っている。
const MIN_REASONABLE_MU = -1
const MAX_REASONABLE_MU = 1
const MAX_REASONABLE_SIGMA = 3
const MIN_REASONABLE_BETA = -5
const MAX_REASONABLE_BETA = 5

function validateHoldingEntry(
  v: unknown,
  schemaVersion: PortfolioSnapshotSchemaVersion,
): { ok: true; value: PortfolioSnapshotHolding } | { ok: false; error: string } {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: '保有株のデータ形式が不正です（オブジェクトではありません）。' }
  }
  const h = v as Record<string, unknown>
  if (typeof h.code !== 'string' || h.code.trim().length === 0) {
    return { ok: false, error: '保有株のcodeが欠損または不正です。' }
  }
  if (!isValidAmount(h.eval)) {
    return { ok: false, error: `保有株(${h.code})の評価額が不正です（0以上の数値である必要があります）。` }
  }
  if (!isValidPercent(h.pnlPct)) {
    return { ok: false, error: `保有株(${h.code})の損益率が不正です。` }
  }
  if (h.currentPrice !== undefined && !isValidAmount(h.currentPrice)) {
    return { ok: false, error: `保有株(${h.code})の現在価格が不正です。` }
  }
  if (!isValidOptionalString(h.acquiredAt)) {
    return { ok: false, error: `保有株(${h.code})の取得日が不正です。` }
  }

  const value: PortfolioSnapshotHolding = { code: h.code, eval: h.eval, pnlPct: h.pnlPct }
  if (h.currentPrice !== undefined) value.currentPrice = h.currentPrice as number
  if (h.acquiredAt !== undefined) value.acquiredAt = (h.acquiredAt as string | null) ?? null

  // P4.5-A013-T7: v2はnameが必須（受信端末に存在しないcodeの場合、Holdingを
  // 新規構築するために必要）。v1はnameを持たないため要求しない。
  if (schemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2) {
    if (typeof h.name !== 'string' || h.name.trim().length === 0) {
      return { ok: false, error: `保有株(${h.code})のnameが欠損しています（v2 snapshotでは新規銘柄追加のため必須です）。` }
    }
    value.name = h.name
  } else if (typeof h.name === 'string' && h.name.trim().length > 0) {
    value.name = h.name
  }

  // 以下はv1/v2共通でoptional。存在する場合のみ検証する
  // （新規銘柄構築時のみ使われ、既存銘柄のmetadataは上書きしない）。
  if (h.sector !== undefined) {
    if (typeof h.sector !== 'string' || h.sector.trim().length === 0) {
      return { ok: false, error: `保有株(${h.code})のsectorが不正です。` }
    }
    value.sector = h.sector
  }
  if (h.mu !== undefined) {
    if (typeof h.mu !== 'number' || !Number.isFinite(h.mu) || h.mu < MIN_REASONABLE_MU || h.mu > MAX_REASONABLE_MU) {
      return { ok: false, error: `保有株(${h.code})のmuが不正です。` }
    }
    value.mu = h.mu
  }
  if (h.sigma !== undefined) {
    if (typeof h.sigma !== 'number' || !Number.isFinite(h.sigma) || h.sigma <= 0 || h.sigma > MAX_REASONABLE_SIGMA) {
      return { ok: false, error: `保有株(${h.code})のsigmaが不正です。` }
    }
    value.sigma = h.sigma
  }
  if (h.sigmaSource !== undefined) {
    if (h.sigmaSource !== 'yfinance' && h.sigmaSource !== 'static') {
      return { ok: false, error: `保有株(${h.code})のsigmaSourceが不正です。` }
    }
    value.sigmaSource = h.sigmaSource
  }
  if (h.beta !== undefined) {
    if (typeof h.beta !== 'number' || !Number.isFinite(h.beta) || h.beta < MIN_REASONABLE_BETA || h.beta > MAX_REASONABLE_BETA) {
      return { ok: false, error: `保有株(${h.code})のbetaが不正です。` }
    }
    value.beta = h.beta
  }

  return { ok: true, value }
}

function validateTrustEntry(v: unknown): { ok: true; value: PortfolioSnapshotTrust } | { ok: false; error: string } {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: '投信のデータ形式が不正です（オブジェクトではありません）。' }
  }
  const t = v as Record<string, unknown>
  if (typeof t.id !== 'string' || t.id.trim().length === 0) {
    return { ok: false, error: '投信のidが欠損または不正です。' }
  }
  if (!isValidAmount(t.eval)) {
    return { ok: false, error: `投信(${t.id})の評価額が不正です（0以上の数値である必要があります）。` }
  }
  if (!isValidPercent(t.pnlPct)) {
    return { ok: false, error: `投信(${t.id})の損益率が不正です。` }
  }
  if (t.dayPct !== undefined && !isValidPercent(t.dayPct)) {
    return { ok: false, error: `投信(${t.id})の日次変動率が不正です。` }
  }
  if (!isValidOptionalString(t.account)) {
    return { ok: false, error: `投信(${t.id})の口座区分が不正です。` }
  }
  const value: PortfolioSnapshotTrust = { id: t.id, eval: t.eval, pnlPct: t.pnlPct }
  if (t.dayPct !== undefined) value.dayPct = t.dayPct as number
  if (t.account !== undefined) value.account = (t.account as string | null) ?? null
  return { ok: true, value }
}

function validatePortfolioPolicy(v: unknown): { ok: true; value: PortfolioSnapshotPortfolioPolicy } | { ok: false; error: string } {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'portfolioPolicyの形式が不正です。' }
  }
  const p = v as Record<string, unknown>
  if (typeof p.jpStockMaxRatio !== 'number' || !Number.isFinite(p.jpStockMaxRatio) || p.jpStockMaxRatio < 0.05 || p.jpStockMaxRatio > 0.30) {
    return { ok: false, error: 'portfolioPolicy.jpStockMaxRatioの値が不正です（0.05〜0.30の範囲である必要があります）。' }
  }
  return { ok: true, value: { jpStockMaxRatio: p.jpStockMaxRatio } }
}

function validateCashAssumptions(
  v: unknown,
): { ok: true; value: PortfolioSnapshotCashAssumptionsWire } | { ok: false; error: string } {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'cashAssumptionsの形式が不正です。' }
  }
  const c = v as Record<string, unknown>

  // CASH-AUTH-1 現行スキーマ
  if (c.source === 'DEFAULT' || c.source === 'MANUAL') {
    if (c.source === 'DEFAULT') {
      return { ok: true, value: { ...NO_CASH_AUTHORITY } }
    }
    if (!isIntegerJpy(c.grossCash)) {
      return { ok: false, error: '総現金の値が不正です（0以上1兆円以下の整数である必要があります）。' }
    }
    if (!isIntegerJpy(c.safetyReserve)) {
      return { ok: false, error: '生活・安全余力の値が不正です（0以上1兆円以下の整数である必要があります）。' }
    }
    if (c.pendingOrderCash !== null && !isIntegerJpy(c.pendingOrderCash)) {
      return { ok: false, error: '未約定の買付注文額が不正です（0以上1兆円以下の整数、または未指定である必要があります）。' }
    }
    const pendingOrderCash = c.pendingOrderCash === null ? null : (c.pendingOrderCash as number)
    if ((c.safetyReserve as number) + (pendingOrderCash ?? 0) > (c.grossCash as number)) {
      return { ok: false, error: '安全余力と未約定買付の合計が総現金を超えています。' }
    }
    const updatedAt = c.updatedAt
    if (typeof updatedAt !== 'string' || !isValidIsoDateString(updatedAt)) {
      return { ok: false, error: 'cashAssumptions.updatedAtの日時形式が不正です。' }
    }
    return {
      ok: true,
      value: {
        source: 'MANUAL',
        grossCash: c.grossCash as number,
        safetyReserve: c.safetyReserve as number,
        pendingOrderCash,
        updatedAt,
      },
    }
  }

  // CASH-AUTH-1 以前の legacy スキーマ（identity 検証のため原形のまま返す）
  if (!isValidAmount(c.cashDeposits)) {
    return { ok: false, error: '現金・預貯金の値が不正です（0以上の数値である必要があります）。' }
  }
  if (!isValidAmount(c.standbyFunds)) {
    return { ok: false, error: '待機・追加資金の値が不正です（0以上の数値である必要があります）。' }
  }
  if (typeof c.manualOverrideEnabled !== 'boolean') {
    return { ok: false, error: 'cashAssumptions.manualOverrideEnabledの値が不正です。' }
  }
  const rawUpdatedAt = c.manualUpdatedAt
  const manualUpdatedAt =
    typeof rawUpdatedAt === 'string' && isValidIsoDateString(rawUpdatedAt) ? rawUpdatedAt : null
  return {
    ok: true,
    value: {
      cashDeposits: Math.round(c.cashDeposits as number),
      standbyFunds: Math.round(c.standbyFunds as number),
      manualOverrideEnabled: c.manualOverrideEnabled,
      manualUpdatedAt,
    },
  }
}

/**
 * 貼り付けられたJSON文字列を検証し、有効な場合のみimport可能な値を返す。
 * 不正な入力は全てreject（ok: false）とする。cashAssumptionsTransfer.tsと同じく
 * 「1件でも不正なら全体reject」方式を採用し、部分的な取り込みは行わない
 * （不完全なスナップショットが判断ロジックに混入するリスクを避けるため）。
 */
export function parsePortfolioSnapshotImport(raw: string): PortfolioSnapshotParseResult {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, error: '貼り付け欄が空です。エクスポートしたJSON文字列を貼り付けてください。' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'JSONとして読み取れませんでした。コピーした文字列全体を貼り付けてください。' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '形式が不正です（JSONオブジェクトではありません）。' }
  }

  const p = parsed as Record<string, unknown>

  // v1/v2 remain parseable as legacy/unknown provenance. v3 requires an explicit
  // provenance field, including null, so malformed provenance cannot downgrade silently.
  // 不明schemaとしてfail-closedでreject（将来schemaとの誤動作を防ぐ）。
  if (
    p.schemaVersion !== PORTFOLIO_SNAPSHOT_SCHEMA_VERSION &&
    p.schemaVersion !== PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2 &&
    p.schemaVersion !== PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3
  ) {
    return { ok: false, error: 'このアプリからエクスポートされたデータではないようです（schemaVersion不一致）。' }
  }
  const schemaVersion = p.schemaVersion

  if (!Array.isArray(p.holdings)) {
    return { ok: false, error: 'holdingsが配列ではありません。' }
  }
  if (!Array.isArray(p.trust)) {
    return { ok: false, error: 'trustが配列ではありません。' }
  }

  const holdings: PortfolioSnapshotHolding[] = []
  for (const item of p.holdings) {
    const result = validateHoldingEntry(item, schemaVersion)
    if (!result.ok) return { ok: false, error: result.error }
    holdings.push(result.value)
  }

  const trust: PortfolioSnapshotTrust[] = []
  for (const item of p.trust) {
    const result = validateTrustEntry(item)
    if (!result.ok) return { ok: false, error: result.error }
    trust.push(result.value)
  }

  let portfolioPolicy: PortfolioSnapshotPortfolioPolicy | null = null
  if (p.portfolioPolicy !== null && p.portfolioPolicy !== undefined) {
    const result = validatePortfolioPolicy(p.portfolioPolicy)
    if (!result.ok) return { ok: false, error: result.error }
    portfolioPolicy = result.value
  }

  // CASH-AUTH-1: generation identity は「出力されたバイト列」に対して検証する
  // 必要があるため、legacy スキーマはここでは移行せず原形（wire）で保持する。
  let cashAssumptionsWire: PortfolioSnapshotCashAssumptionsWire | null = null
  if (p.cashAssumptions !== null && p.cashAssumptions !== undefined) {
    const result = validateCashAssumptions(p.cashAssumptions)
    if (!result.ok) return { ok: false, error: result.error }
    cashAssumptionsWire =
      schemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3 &&
      isLegacyCashAssumptionsIdentityShape(result.value)
        ? { ...result.value, manualOverrideEnabled: true }
        : result.value
  }

  if (p.csvImportedAt !== null && !isValidIsoDateString(p.csvImportedAt)) {
    return { ok: false, error: 'csvImportedAtの日時形式が不正です。' }
  }
  if (!isValidIsoDateString(p.exportedAt)) {
    return { ok: false, error: 'exportedAtの日時形式が不正です。' }
  }
  const csvImportedAt = p.csvImportedAt as string | null
  const exportedAt = p.exportedAt as string

  let csvImportProvenance: CsvImportProvenance | null = null
  let snapshotGenerationIdentity: string | null = null
  if (schemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3) {
    if (!Object.prototype.hasOwnProperty.call(p, 'csvImportProvenance')) {
      return { ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE', error: 'snapshotのCSV provenanceが欠損しています。' }
    }
    if (p.csvImportProvenance !== null) {
      if (!isCsvImportProvenance(p.csvImportProvenance)) {
        return { ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE', error: 'snapshotのCSV provenanceが不正です。' }
      }
      csvImportProvenance = p.csvImportProvenance
      if (csvImportedAt !== csvImportProvenance.importedAt) {
        return { ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE', error: 'snapshotのCSV取込操作時刻とprovenanceが一致しません。' }
      }
    }
    if (!Object.prototype.hasOwnProperty.call(p, 'snapshotGenerationIdentity') ||
        !isSnapshotGenerationIdentity(p.snapshotGenerationIdentity)) {
      return { ok: false, code: 'INVALID_SNAPSHOT_GENERATION', error: 'snapshotのgeneration identityが欠損または不正です。' }
    }
    snapshotGenerationIdentity = p.snapshotGenerationIdentity
    const recomputedIdentity = computeSnapshotGenerationIdentity({
      holdings,
      trust,
      portfolioPolicy,
      cashAssumptions: cashAssumptionsWire,
      csvImportedAt,
      csvImportProvenance,
    })
    if (snapshotGenerationIdentity !== recomputedIdentity) {
      return { ok: false, code: 'INVALID_SNAPSHOT_GENERATION', error: 'snapshotの内容とgeneration identityが一致しません。' }
    }
  } else if (Object.prototype.hasOwnProperty.call(p, 'csvImportProvenance')) {
    return { ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE', error: 'legacy snapshotに未対応のprovenanceが含まれています。' }
  }

  // identity 検証後に一度だけ現行スキーマへ移行する（決定的・冪等）。
  // legacy の addRoom 相当は存在せず、cashDeposits + standbyFunds を一度だけ合算する。
  const cashAssumptions: PortfolioSnapshotCashAssumptions | null =
    cashAssumptionsWire === null
      ? null
      : normalizeCashAuthorityRecord(cashAssumptionsWire) ?? { ...NO_CASH_AUTHORITY }

  return {
    ok: true,
    data: {
      schemaVersion,
      exportedAt,
      csvImportedAt,
      csvImportProvenance,
      snapshotGenerationIdentity,
      holdings,
      trust,
      portfolioPolicy,
      cashAssumptions,
    },
  }
}
