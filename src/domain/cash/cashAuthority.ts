// ═══════════════════════════════════════════════════════════
// CASH-AUTH-1: 現金権限（cash authority）の単一契約。
//
// NEXT-2 の凍結設計をそのまま実装する唯一のモジュール。検証・移行・鮮度判定は
// すべてここに集約し、store / selector / UI / persistence は必ずここを経由する
// （parallel authority を作らない）。
//
// 凍結語彙:
//   総現金 grossCash         updatedAt時点で決済済みの総円現金。証券評価額・未受渡金・
//                            将来入金・与信・addRoom は含まない。
//   生活・安全余力 safetyReserve  総現金のうち投資に回さない部分（部分集合であり追加現金ではない）。
//   未約定買付 pendingOrderCash   総現金のうち未約定の買付注文に拘束済みの部分。
//                            null = 権限不明（警告のみ）/ 0 = 「無し」を確認済み / 正数 = 1回だけ差引。
//   投資可能現金 deployableCash   max(0, gross - safetyReserve - pendingOrderCash - dataUncertaintyReserve)。
//                            unknown / stale / invalid では必ず 0。
//
// このモジュールはネットワーク・ストレージ・DOM に一切触れない純関数のみ。
// ═══════════════════════════════════════════════════════════
import type { CashAssumptions, CashAuthoritySource } from '../../types'
import {
  CASH_ASSUMPTIONS_STALE_HOURS,
  CASH_ASSUMPTIONS_APPROACHING_EXPIRY_HOURS,
} from '../risk/thresholds'

/** 現実的な資産規模を大きく超える上限（1兆円）。これを超える入力は全て reject する。 */
export const CASH_AUTHORITY_MAX_JPY = 1_000_000_000_000

const MS_PER_HOUR = 60 * 60 * 1000

/** 168h。ちょうど 168h は fresh（`>` 境界を維持する）。 */
export const CASH_AUTHORITY_TTL_MS = CASH_ASSUMPTIONS_STALE_HOURS * MS_PER_HOUR
/** 144h。fresh のまま「まもなく失効」を表示するための境界。 */
export const CASH_AUTHORITY_APPROACHING_EXPIRY_MS =
  CASH_ASSUMPTIONS_APPROACHING_EXPIRY_HOURS * MS_PER_HOUR

/** 権限なし（DEFAULT）。confirmed zero とは異なり常に unknown。 */
export const NO_CASH_AUTHORITY: CashAssumptions = {
  source: 'DEFAULT',
  grossCash: 0,
  safetyReserve: 0,
  pendingOrderCash: null,
  updatedAt: null,
}

/** 円は整数のみ。NaN / Infinity / 負数 / 上限超過 / 非整数は全て不正。 */
export function isIntegerJpy(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= CASH_AUTHORITY_MAX_JPY
  )
}

/**
 * 厳密な ISO 時刻のみ受け付ける。パースできない文字列は null を返し、
 * 呼び出し側は必ず stale として扱う（無警告で fresh にはならない）。
 */
export function parseAuthorityTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 保存済みレコードとして矛盾がないか（数値契約 + 準備金の重複禁止）。
 * 1円が safetyReserve と pendingOrderCash の両方を占めることはできない。
 */
export function isValidCashAuthorityRecord(record: CashAssumptions): boolean {
  if (record.source === 'DEFAULT') {
    return (
      record.grossCash === 0 &&
      record.safetyReserve === 0 &&
      record.pendingOrderCash === null &&
      record.updatedAt === null
    )
  }
  if (record.source !== 'MANUAL') return false
  if (!isIntegerJpy(record.grossCash)) return false
  if (!isIntegerJpy(record.safetyReserve)) return false
  if (record.pendingOrderCash !== null && !isIntegerJpy(record.pendingOrderCash)) return false
  const reserved = record.safetyReserve + (record.pendingOrderCash ?? 0)
  if (reserved > record.grossCash) return false
  return parseAuthorityTimestampMs(record.updatedAt) !== null
}

export type CashAuthorityState = 'unknown' | 'known_fresh' | 'stale'

export interface CashAuthorityFreshness {
  /** allocation engine の safetyState.cash にそのまま渡す値 */
  state: CashAuthorityState
  /** 正確なミリ秒差から算出した経過時間。判定不能時は null */
  ageHours: number | null
  /** 144h <= age <= 168h。fresh のまま表示する警告 */
  approachingExpiry: boolean
  /** updatedAt + 168h。ローカルTTLガードのスケジュールに使う */
  expiresAtMs: number | null
  /** stale / unknown の理由（表示用） */
  reason:
    | null
    | 'NO_AUTHORITY'
    | 'INVALID_RECORD'
    | 'MISSING_TIMESTAMP'
    | 'INVALID_TIMESTAMP'
    | 'FUTURE_TIMESTAMP'
    | 'EXPIRED'
}

/**
 * 凍結TTLを厳密なミリ秒で評価する。日付や丸めた日数比較は使わない。
 *
 *   age <= 168h                  → known_fresh
 *   144h <= age <= 168h          → known_fresh かつ approachingExpiry
 *   age > 168h                   → stale
 *   未来 / 欠損 / 不正な updatedAt → stale（known_fresh には決してならない）
 *   DEFAULT                      → unknown（confirmed zero とは別状態）
 */
export function evaluateCashAuthorityFreshness(
  record: CashAssumptions,
  nowMs: number,
): CashAuthorityFreshness {
  const base: CashAuthorityFreshness = {
    state: 'stale',
    ageHours: null,
    approachingExpiry: false,
    expiresAtMs: null,
    reason: 'INVALID_RECORD',
  }
  if (record.source !== 'MANUAL') {
    return { ...base, state: 'unknown', reason: 'NO_AUTHORITY' }
  }
  if (!isValidCashAuthorityRecord(record)) {
    // updatedAt そのものが欠損/不正な場合は理由を細分化して返す
    if (record.updatedAt === null || record.updatedAt === undefined) {
      return { ...base, reason: 'MISSING_TIMESTAMP' }
    }
    if (parseAuthorityTimestampMs(record.updatedAt) === null) {
      return { ...base, reason: 'INVALID_TIMESTAMP' }
    }
    return base
  }
  const tsMs = parseAuthorityTimestampMs(record.updatedAt)
  if (tsMs === null) return { ...base, reason: 'INVALID_TIMESTAMP' }
  if (!Number.isFinite(nowMs)) return { ...base, reason: 'INVALID_TIMESTAMP' }

  const ageMs = nowMs - tsMs
  const expiresAtMs = tsMs + CASH_AUTHORITY_TTL_MS
  if (!Number.isFinite(ageMs)) {
    return { ...base, expiresAtMs, reason: 'INVALID_TIMESTAMP' }
  }
  if (ageMs < 0) {
    return { ...base, ageHours: ageMs / MS_PER_HOUR, expiresAtMs, reason: 'FUTURE_TIMESTAMP' }
  }
  const ageHours = ageMs / MS_PER_HOUR
  if (ageMs > CASH_AUTHORITY_TTL_MS) {
    return { state: 'stale', ageHours, approachingExpiry: false, expiresAtMs, reason: 'EXPIRED' }
  }
  return {
    state: 'known_fresh',
    ageHours,
    approachingExpiry: ageMs >= CASH_AUTHORITY_APPROACHING_EXPIRY_MS,
    expiresAtMs,
    reason: null,
  }
}

export interface CashAuthorityView {
  source: CashAuthoritySource
  /** MANUAL かつ有効なときのみ実値。それ以外は 0（権威値） */
  grossCash: number
  safetyReserve: number
  pendingOrderCash: number | null
  /**
   * 失効後も保持する参考値（表示専用）。実行可能額には一切使わない。
   * 「値は消さずに実行可能性だけ落とす」凍結仕様のための入口。
   */
  referenceGrossCash: number
  referenceSafetyReserve: number
  referencePendingOrderCash: number | null
  /** 凍結式による投資可能現金。unknown / stale / invalid では必ず 0 */
  deployableCash: number
  freshness: CashAuthorityFreshness
  /** 有効な権限のもとで grossCash=0 が確認済み（unknown とは別） */
  confirmedZero: boolean
  updatedAt: string | null
}

/**
 * 凍結式そのままの表示用ビュー。allocation engine（deriveCashModel）と同じ式を
 * 使うが、engine 側の headroom / budget 制約は含まない上限値である。
 */
export function deriveCashAuthorityView(
  record: CashAssumptions,
  nowMs: number,
): CashAuthorityView {
  const freshness = evaluateCashAuthorityFreshness(record, nowMs)
  const usable = freshness.state === 'known_fresh'
  const grossCash = usable ? record.grossCash : 0
  const safetyReserve = usable ? record.safetyReserve : 0
  const pendingOrderCash = usable ? record.pendingOrderCash : null
  const deployableCash = usable
    ? Math.max(0, grossCash - safetyReserve - (pendingOrderCash ?? 0))
    : 0
  const isManual = record.source === 'MANUAL'
  return {
    source: record.source,
    grossCash,
    safetyReserve,
    pendingOrderCash,
    referenceGrossCash: isManual && isIntegerJpy(record.grossCash) ? record.grossCash : 0,
    referenceSafetyReserve: isManual && isIntegerJpy(record.safetyReserve) ? record.safetyReserve : 0,
    referencePendingOrderCash: isManual && isIntegerJpy(record.pendingOrderCash)
      ? record.pendingOrderCash
      : null,
    deployableCash,
    freshness,
    confirmedZero: usable && record.grossCash === 0,
    updatedAt: isManual ? record.updatedAt : null,
  }
}

// ── 入力検証（T9 エディタ / import 共通） ─────────────────────

export type CashAuthorityDraftField = 'grossCash' | 'safetyReserve' | 'pendingOrderCash'

export interface CashAuthorityDraftInput {
  grossCash: unknown
  safetyReserve: unknown
  /** 空欄（null / '' ）は「不明」を意味する。0 とは区別する */
  pendingOrderCash: unknown
  updatedAt: string
}

export type CashAuthorityValidation =
  | { ok: true; record: CashAssumptions }
  | { ok: false; errors: ReadonlyArray<{ field: CashAuthorityDraftField | 'updatedAt'; message: string }> }

function readAmount(value: unknown): number | 'blank' | 'invalid' {
  if (value === null || value === undefined) return 'blank'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return 'blank'
    // 指数表記・空白・記号混じりを弾くため厳密な10進整数のみ許可する
    if (!/^\d+$/.test(trimmed)) return 'invalid'
    const parsed = Number(trimmed)
    return isIntegerJpy(parsed) ? parsed : 'invalid'
  }
  if (typeof value === 'number') {
    return isIntegerJpy(value) ? value : 'invalid'
  }
  return 'invalid'
}

/**
 * 下書きをレコード全体として検証する。1項目でも不正なら record は作らない
 * （0 への丸め・切り詰めは行わない）。呼び出し側は既存の権限を一切変更しない。
 */
export function validateCashAuthorityDraft(
  input: CashAuthorityDraftInput,
): CashAuthorityValidation {
  const errors: Array<{ field: CashAuthorityDraftField | 'updatedAt'; message: string }> = []

  const gross = readAmount(input.grossCash)
  if (gross === 'blank') {
    errors.push({ field: 'grossCash', message: '総現金を入力してください（0円の場合は 0 と入力）。' })
  } else if (gross === 'invalid') {
    errors.push({ field: 'grossCash', message: '総現金は0以上1兆円以下の整数（円）で入力してください。' })
  }

  const reserve = readAmount(input.safetyReserve)
  if (reserve === 'blank') {
    errors.push({ field: 'safetyReserve', message: '生活・安全余力を入力してください（無い場合は 0 と入力）。' })
  } else if (reserve === 'invalid') {
    errors.push({ field: 'safetyReserve', message: '生活・安全余力は0以上1兆円以下の整数（円）で入力してください。' })
  }

  const pending = readAmount(input.pendingOrderCash)
  if (pending === 'invalid') {
    errors.push({
      field: 'pendingOrderCash',
      message: '未約定の買付注文額は0以上1兆円以下の整数（円）で入力してください（不明な場合は空欄）。',
    })
  }

  const updatedAtMs = parseAuthorityTimestampMs(input.updatedAt)
  if (updatedAtMs === null) {
    errors.push({ field: 'updatedAt', message: '更新時刻を確定できませんでした。もう一度お試しください。' })
  }

  if (typeof gross === 'number' && typeof reserve === 'number') {
    const pendingValue = typeof pending === 'number' ? pending : 0
    if (reserve + pendingValue > gross) {
      errors.push({
        field: 'safetyReserve',
        message: '安全余力と未約定買付の合計が総現金を超えています。同じ1円を二重に確保することはできません。',
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    record: {
      source: 'MANUAL',
      grossCash: gross as number,
      safetyReserve: reserve as number,
      pendingOrderCash: pending === 'blank' ? null : (pending as number),
      updatedAt: input.updatedAt,
    },
  }
}

// ── 永続化レコードの正規化 / legacy 移行 ──────────────────────

interface LegacyCashAssumptionsShape {
  cashDeposits: number
  standbyFunds: number
  manualOverrideEnabled: boolean
  manualUpdatedAt: string | null
}

function isLegacyShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.manualOverrideEnabled === 'boolean' &&
    'cashDeposits' in value &&
    'standbyFunds' in value
  )
}

/**
 * CASH-AUTH-1 の一度きりの legacy 移行。
 *
 *   manualOverrideEnabled=false → DEFAULT / 権限なし
 *   manualOverrideEnabled=true  → source=MANUAL
 *                                 grossCash = cashDeposits + standbyFunds
 *                                 safetyReserve = 0
 *                                 pendingOrderCash = null
 *                                 updatedAt = manualUpdatedAt
 *   addRoom（任意の値）          → 一切移行せず、加算もしない
 *
 * standbyFunds を「生活防衛資金」と推測せずに従来の金額上限をそのまま保つ。
 * 1円が二重に入らないよう合計は一度だけ行う。不正・非整数・1兆円超は fail closed。
 * 欠損 updatedAt を現在時刻で捏造しない（null のまま → stale 判定）。
 */
export function migrateLegacyCashAssumptions(
  legacy: LegacyCashAssumptionsShape,
): CashAssumptions | null {
  // 壊れたレコードは null（呼び出し側が「復元できなかった」として扱う）。
  // 権限として成立しないだけの正常なレコードは NO_CASH_AUTHORITY。
  const deposits = legacy.cashDeposits
  const standby = legacy.standbyFunds
  if (
    typeof deposits !== 'number' || !Number.isFinite(deposits) || deposits < 0 ||
    typeof standby !== 'number' || !Number.isFinite(standby) || standby < 0
  ) {
    return null
  }
  if (legacy.manualOverrideEnabled !== true) return { ...NO_CASH_AUTHORITY }
  const grossCash = deposits + standby
  if (!Number.isInteger(grossCash) || grossCash > CASH_AUTHORITY_MAX_JPY) {
    return null
  }
  const updatedAt =
    typeof legacy.manualUpdatedAt === 'string' &&
    parseAuthorityTimestampMs(legacy.manualUpdatedAt) !== null
      ? legacy.manualUpdatedAt
      : null
  if (updatedAt === null) {
    // 権限としては MANUAL だが時刻が無いレコードは実行可能にできない。
    // 現在時刻の捏造はせず、権限なしへ fail closed する。
    return { ...NO_CASH_AUTHORITY }
  }
  return {
    source: 'MANUAL',
    grossCash,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt,
  }
}

/**
 * 任意の永続化値を現行スキーマへ正規化する。新スキーマはそのまま検証し、
 * legacy スキーマは migrateLegacyCashAssumptions を通す。決定的・冪等。
 * 判別できない/壊れた値は null（呼び出し側が NO_AUTHORITY へ倒す）。
 */
export function normalizeCashAuthorityRecord(raw: unknown): CashAssumptions | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>

  if (value.source === 'DEFAULT' || value.source === 'MANUAL') {
    const record: CashAssumptions = {
      source: value.source,
      grossCash: value.grossCash as number,
      safetyReserve: value.safetyReserve as number,
      pendingOrderCash: (value.pendingOrderCash ?? null) as number | null,
      updatedAt: (value.updatedAt ?? null) as string | null,
    }
    if (record.source === 'DEFAULT') return { ...NO_CASH_AUTHORITY }
    return isValidCashAuthorityRecord(record) ? record : null
  }

  if (isLegacyShape(value)) {
    return migrateLegacyCashAssumptions(value as unknown as LegacyCashAssumptionsShape)
  }

  return null
}
