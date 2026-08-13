// ═══════════════════════════════════════════════════════════
// P4.5-A009 / CASH-AUTH-1: 現金権限のexport/import — 表示専用のシリアライズ/検証のみ。
// PC/スマホ間の同期はユーザーがJSON文字列を手動でコピー/貼り付けする方式に限定する。
// public repo / public data JSON / workflow / backend への書き出しは一切行わない。
//
// import は transport であって第3の権限ソースではない。取り込んだ結果は常に
// source=MANUAL となり、updatedAt は取り込み元の値を引き継ぐ（現在時刻で
// 上書きして「新鮮」に見せかけない）。
// ═══════════════════════════════════════════════════════════
import type { CashAssumptions, CashAssumptionsExportPayload } from '../types'
import {
  CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION,
  CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION_V1,
} from '../types'
import {
  CASH_AUTHORITY_MAX_JPY,
  NO_CASH_AUTHORITY,
  isIntegerJpy,
  migrateLegacyCashAssumptions,
  parseAuthorityTimestampMs,
} from '../domain/cash/cashAuthority'

/**
 * 現金権限をexport用JSON文字列に変換する（表示・コピー用）。
 * どこにも保存しない — 呼び出し側がUIに表示し、ユーザー自身がコピーする。
 */
export function serializeCashAssumptionsExport(cashAssumptions: CashAssumptions): string {
  const payload: CashAssumptionsExportPayload = {
    schemaVersion: CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source: cashAssumptions.source,
    grossCash: cashAssumptions.grossCash,
    safetyReserve: cashAssumptions.safetyReserve,
    pendingOrderCash: cashAssumptions.pendingOrderCash,
    updatedAt: cashAssumptions.updatedAt,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * CASH-AUTH-1: export 対象は state.cashAssumptions そのもの（権限は1つしかなく、
 * 実効値と保存値が乖離しない）。権限未設定（DEFAULT）はそのまま DEFAULT として
 * export し、受け取り側でも「未設定」のままにする — 0円を confirmed zero に
 * 昇格させない。
 */
export function buildExportableCashAssumptions(record: CashAssumptions): CashAssumptions {
  return record.source === 'MANUAL' ? { ...record } : { ...NO_CASH_AUTHORITY }
}

export interface CashAssumptionsImportData {
  grossCash: number
  safetyReserve: number
  pendingOrderCash: number | null
  /**
   * import元のupdatedAtをそのまま引き継ぐ。欠損・不正な日時文字列の場合はnullにする
   * （現在時刻への差し替えはしない）。nullは鮮度判定でstale扱いになるため、
   * 「不正/欠損時は無警告でfreshにならない」設計を維持する。
   */
  updatedAt: string | null
}

export type CashAssumptionsImportResult =
  | { ok: true; data: CashAssumptionsImportData }
  | { ok: false; error: string }

function isValidAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= CASH_AUTHORITY_MAX_JPY
}

/**
 * 貼り付けられたJSON文字列を検証し、有効な場合のみimport可能な値を返す。
 * 不正な入力は全てreject（ok: false）とし、呼び出し側は既存の現金権限を
 * 一切変更してはならない。
 */
export function parseCashAssumptionsImport(raw: string): CashAssumptionsImportResult {
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

  // CASH-AUTH-1 以前のペイロードは同じ移行規則（gross = 現金 + 待機資金、
  // 安全余力 0、未約定 null）で変換する。addRoom は存在せず加算もしない。
  if (p.schemaVersion === CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION_V1) {
    if (!isValidAmount(p.cashDeposits)) {
      return { ok: false, error: '現金・預貯金の値が不正です（0以上の数値である必要があります）。' }
    }
    if (!isValidAmount(p.standbyFunds)) {
      return { ok: false, error: '待機・追加資金の値が不正です（0以上の数値である必要があります）。' }
    }
    const migrated = migrateLegacyCashAssumptions({
      cashDeposits: Math.round(p.cashDeposits),
      standbyFunds: Math.round(p.standbyFunds),
      manualOverrideEnabled: true,
      manualUpdatedAt: typeof p.manualUpdatedAt === 'string' ? p.manualUpdatedAt : null,
    })
    if (migrated === null || migrated.source !== 'MANUAL') {
      return {
        ok: false,
        error: '取り込めるデータがありませんでした（更新時刻が欠損しているか、金額が不正です）。',
      }
    }
    return {
      ok: true,
      data: {
        grossCash: migrated.grossCash,
        safetyReserve: migrated.safetyReserve,
        pendingOrderCash: migrated.pendingOrderCash,
        updatedAt: migrated.updatedAt,
      },
    }
  }

  if (p.schemaVersion !== CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION) {
    return { ok: false, error: 'このアプリからエクスポートされたデータではないようです（schemaVersion不一致）。' }
  }

  if (p.source !== 'MANUAL') {
    return { ok: false, error: '取り込み元で現金権限が未設定です。先に相手側の端末で現金を設定してください。' }
  }
  if (!isIntegerJpy(p.grossCash)) {
    return { ok: false, error: '総現金の値が不正です（0以上1兆円以下の整数である必要があります）。' }
  }
  if (!isIntegerJpy(p.safetyReserve)) {
    return { ok: false, error: '生活・安全余力の値が不正です（0以上1兆円以下の整数である必要があります）。' }
  }
  if (p.pendingOrderCash !== null && !isIntegerJpy(p.pendingOrderCash)) {
    return { ok: false, error: '未約定の買付注文額が不正です（0以上1兆円以下の整数、または未指定である必要があります）。' }
  }
  const pendingOrderCash = p.pendingOrderCash === null ? null : (p.pendingOrderCash as number)
  if ((p.safetyReserve as number) + (pendingOrderCash ?? 0) > (p.grossCash as number)) {
    return { ok: false, error: '安全余力と未約定買付の合計が総現金を超えています。' }
  }

  const updatedAt =
    typeof p.updatedAt === 'string' && parseAuthorityTimestampMs(p.updatedAt) !== null
      ? p.updatedAt
      : null

  return {
    ok: true,
    data: {
      grossCash: p.grossCash as number,
      safetyReserve: p.safetyReserve as number,
      pendingOrderCash,
      updatedAt,
    },
  }
}
