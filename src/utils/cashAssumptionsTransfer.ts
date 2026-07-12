// ═══════════════════════════════════════════════════════════
// P4.5-A009: 資金前提（現金・待機資金）のexport/import — 表示専用のシリアライズ/検証のみ。
// PC/スマホ間の同期はユーザーがJSON文字列を手動でコピー/貼り付けする方式に限定する。
// public repo / public data JSON / workflow / backend への書き出しは一切行わない。
// ═══════════════════════════════════════════════════════════
import type { CashAssumptions, CashAssumptionsExportPayload } from '../types'
import { CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION } from '../types'

/**
 * cashAssumptionsをexport用JSON文字列に変換する（表示・コピー用）。
 * どこにも保存しない — 呼び出し側がUIに表示し、ユーザー自身がコピーする。
 * 注意: rawのCashAssumptionsをそのまま渡すと、manualOverrideEnabled=falseのとき
 * cashDeposits/standbyFundsが「実際に使われている値」と一致しない（初回起動時は0/0、
 * override解除後は解除前の古い値が残る）。呼び出し側は必ず
 * buildExportableCashAssumptions()で実効値ベースに変換してから渡すこと。
 */
export function serializeCashAssumptionsExport(cashAssumptions: CashAssumptions): string {
  const payload: CashAssumptionsExportPayload = {
    schemaVersion: CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    cashDeposits: cashAssumptions.cashDeposits,
    standbyFunds: cashAssumptions.standbyFunds,
    manualOverrideEnabled: cashAssumptions.manualOverrideEnabled,
    manualUpdatedAt: cashAssumptions.manualUpdatedAt,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * P4.5-A009 ミニ監査: 実効値（selectEffectiveCashAssumptionsの結果）からexport可能な
 * CashAssumptions形のオブジェクトを構築する。manualOverrideEnabled=falseの場合でも
 * 「実際に使われている値」（既定値含む）を正しくexportするための変換。
 * manualOverrideEnabledは常にtrueにする — importは常に手動override扱いになる仕様
 * （useAppStore.importCashAssumptions）と整合させるため。
 * manualUpdatedAtはeffective側にあればそれを、無ければ（既定値使用中）現在時刻を使う
 * （既定値には「最終更新日時」の概念がないため、export実行時刻を代わりに使う）。
 */
export function buildExportableCashAssumptions(
  effective: { cash: number; cashReserve: number; manualUpdatedAt: string | null },
): CashAssumptions {
  return {
    cashDeposits: effective.cash,
    standbyFunds: effective.cashReserve,
    manualOverrideEnabled: true,
    manualUpdatedAt: effective.manualUpdatedAt ?? new Date().toISOString(),
  }
}

export interface CashAssumptionsImportData {
  cashDeposits: number
  standbyFunds: number
  /**
   * import元のmanualUpdatedAtをそのまま引き継ぐ。欠損・不正な日時文字列の場合はnullにする
   * （加算・現在時刻への差し替えはしない）。nullはP4.5-A008のcomputeCashAssumptionsFreshnessで
   * isStale=true（要更新の警告）として扱われるため、「不正/欠損時はstale扱いになる」設計を採用した。
   */
  manualUpdatedAt: string | null
}

export type CashAssumptionsImportResult =
  | { ok: true; data: CashAssumptionsImportData }
  | { ok: false; error: string }

// 異常に大きすぎる値のガード（現実的な資産規模を大きく超える上限。1兆円）
const MAX_REASONABLE_AMOUNT = 1_000_000_000_000

function isValidAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_REASONABLE_AMOUNT
}

/**
 * 貼り付けられたJSON文字列を検証し、有効な場合のみimport可能な値を返す。
 * 不正な入力は全てreject（ok: false）とし、呼び出し側は既存のcashAssumptionsを
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

  if (p.schemaVersion !== CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION) {
    return { ok: false, error: 'このアプリからエクスポートされたデータではないようです（schemaVersion不一致）。' }
  }

  if (!isValidAmount(p.cashDeposits)) {
    return { ok: false, error: '現金・預貯金の値が不正です（0以上の数値である必要があります）。' }
  }
  if (!isValidAmount(p.standbyFunds)) {
    return { ok: false, error: '待機・追加資金の値が不正です（0以上の数値である必要があります）。' }
  }

  const rawUpdatedAt = p.manualUpdatedAt
  const manualUpdatedAt =
    typeof rawUpdatedAt === 'string' && !Number.isNaN(new Date(rawUpdatedAt).getTime())
      ? rawUpdatedAt
      : null

  return {
    ok: true,
    data: {
      cashDeposits: Math.round(p.cashDeposits),
      standbyFunds: Math.round(p.standbyFunds),
      manualUpdatedAt,
    },
  }
}
