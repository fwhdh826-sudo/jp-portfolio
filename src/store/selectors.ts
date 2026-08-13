import type { AppState, CashAssumptions, HoldingAnalysis, Holding, Trust } from '../types'
import { MARKET_DATA_STALE_HOURS, SYSTEM_STALE_HOURS, SAFE_MODE_STALE_HOURS } from '../domain/risk/thresholds'
import {
  deriveCashAuthorityView,
  evaluateCashAuthorityFreshness,
  type CashAuthorityFreshness,
  type CashAuthorityState,
  type CashAuthorityView,
} from '../domain/cash/cashAuthority'
import {
  evaluateCandidateFunnelFreshness,
  type CandidateFunnelFreshness,
} from '../services/candidateFunnelFreshness'

// ── ポートフォリオ集計 ─────────────────────────────────────────
export const selectTotalEval = (s: AppState) =>
  s.holdings.reduce((sum, h) => sum + h.eval, 0)

export const selectTotalPnl = (s: AppState) => {
  return s.holdings.reduce((sum, h) => {
    const cost = h.eval / (1 + h.pnlPct / 100)
    return sum + (h.eval - cost)
  }, 0)
}

export const selectBuyList = (s: AppState): HoldingAnalysis[] =>
  s.analysis.filter(a => a.decision === 'BUY').sort((a, b) => b.totalScore - a.totalScore)

export const selectSellList = (s: AppState): HoldingAnalysis[] =>
  s.analysis.filter(a => a.decision === 'SELL').sort((a, b) => a.totalScore - b.totalScore)

export const selectHoldList = (s: AppState): HoldingAnalysis[] =>
  s.analysis.filter(a => a.decision === 'HOLD').sort((a, b) => b.totalScore - a.totalScore)

export const selectHoldingByCode = (code: string) => (s: AppState): Holding | undefined =>
  s.holdings.find(h => h.code === code)

export const selectAnalysisByCode = (code: string) => (s: AppState): HoldingAnalysis | undefined =>
  s.analysis.find(a => a.code === code)

// ── 投資信託集計 ───────────────────────────────────────────────
export const selectTrustTotalEval = (s: AppState) =>
  s.trust.reduce((sum, f) => sum + f.eval, 0)

export const selectTrustByPolicy = (policy: Trust['policy']) => (s: AppState) =>
  s.trust.filter(f => f.policy === policy)

// ── 資産クラス別投信セレクター（V10: 型・ストア・UI 分離の核） ──────
/** 国内株投信（超短期回転）: JAPAN_SHORTTERM */
export const selectJpFunds = (s: AppState) =>
  s.trust.filter(f => f.policy === 'JAPAN_SHORTTERM')

/** 海外投信（中長期配分）: OVERSEAS_LONGTERM + GOLD */
export const selectGlobalFunds = (s: AppState) =>
  s.trust.filter(f => f.policy === 'OVERSEAS_LONGTERM' || f.policy === 'GOLD')

export const selectJpFundTotalEval = (s: AppState) =>
  s.trust.filter(f => f.policy === 'JAPAN_SHORTTERM').reduce((sum, f) => sum + f.eval, 0)

export const selectGlobalFundTotalEval = (s: AppState) =>
  s.trust.filter(f => f.policy !== 'JAPAN_SHORTTERM').reduce((sum, f) => sum + f.eval, 0)

// ── レジーム ───────────────────────────────────────────────────
export const selectRegime = (s: AppState) => s.market.regime

// ── P5-B005-B3-B: candidate funnel freshness（pure / observability only） ──
export function selectCandidateFunnelFreshness(
  state: AppState,
  nowMs: number,
): CandidateFunnelFreshness {
  const status = state.system.dataSourceStatus.candidateFunnel
  const timestamp = state.system.dataTimestamps?.candidateFunnel
  const data = state.candidateFunnel

  if (status === undefined) {
    return data === null && timestamp == null ? 'unavailable' : 'invalid'
  }
  if (status === 'loaded') {
    if (data === null || timestamp !== data._meta.generatedAt) return 'invalid'
    return evaluateCandidateFunnelFreshness({ status, data }, nowMs)
  }
  if (data !== null || timestamp != null) return 'invalid'
  return evaluateCandidateFunnelFreshness({ status, data: null }, nowMs)
}

// ── システム状態 ───────────────────────────────────────────────
export const selectIsLoading = (s: AppState) => s.system.status === 'loading'
export const selectStatusColor = (s: AppState) => {
  switch (s.system.status) {
    case 'loading': return '#d4a017'
    case 'success': return '#6896c8'
    case 'error':   return '#e8405a'
    default:        return '#4a6070'
  }
}

// Phase 8: データ鮮度チェック（SYSTEM_STALE_HOURS超過 = stale）
const STALE_THRESHOLD_MS = SYSTEM_STALE_HOURS * 60 * 60 * 1000

export const selectIsStale = (s: AppState): boolean => {
  if (!s.system.lastUpdated) return true
  return Date.now() - new Date(s.system.lastUpdated).getTime() > STALE_THRESHOLD_MS
}

export const selectDataAgeMs = (s: AppState): number => {
  if (!s.system.lastUpdated) return Infinity
  return Date.now() - new Date(s.system.lastUpdated).getTime()
}

// ── P0-5: Market Data Quality Gate ────────────────────────────
// 将来P3でData Quality Score A〜Eに拡張予定。今回は最小安全装置。
export type MarketDataQualityLevel = 'ok' | 'stale' | 'static' | 'error'

export interface MarketDataQuality {
  isSuppressed: boolean          // trueのとき新規BUY提案を抑制
  level: MarketDataQualityLevel
  reason: string | null          // 抑制中の場合の表示理由
}

// "2026-06-11 15:00" のような日時文字列をミリ秒に変換（JST前提・空白→Tに変換）
function parseMarketTimestamp(ts: string | null | undefined): number | null {
  if (!ts) return null
  const d = new Date(ts.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

const MARKET_STALE_THRESHOLD_MS = MARKET_DATA_STALE_HOURS * 60 * 60 * 1000

export const selectMarketDataQuality = (s: AppState, now: number = Date.now()): MarketDataQuality => {
  const source = s.system.dataSourceStatus.market

  if (source === 'error') {
    return { isSuppressed: true, level: 'error', reason: 'データ取得エラー — 新規買いを停止しています' }
  }

  if (source === 'static') {
    return { isSuppressed: true, level: 'static', reason: 'データ更新失敗 — 最新データ取得まで新規買いを停止しています' }
  }

  // dataTimestamps.market または market.last_updated で鮮度チェック
  const tsMs = parseMarketTimestamp(s.system.dataTimestamps?.market ?? s.market.last_updated)

  if (tsMs === null) {
    return { isSuppressed: true, level: 'stale', reason: 'データの更新日時を確認できません — 新規買いを抑制中' }
  }

  const ageMs = now - tsMs
  if (ageMs > MARKET_STALE_THRESHOLD_MS) {
    const hoursAgo = Math.floor(ageMs / (60 * 60 * 1000))
    return {
      isSuppressed: true,
      level: 'stale',
      reason: `データが${hoursAgo}時間以上更新されていません — 新規買いを抑制中`,
    }
  }

  return { isSuppressed: false, level: 'ok', reason: null }
}

// ── P4-A159: SAFE_MODE data freshness gate (Fable audit A4) ──────
// safe_mode.json loading successfully (schema valid) does not guarantee the
// snapshot is current. If last_checked is missing, malformed, or older than
// SAFE_MODE_STALE_HOURS, treat it as fail-closed (isStale = true) so callers
// can force safeModeActive = true regardless of the JSON's own active flag.
export type SafeModeDataQualityLevel = 'ok' | 'stale' | 'unavailable'

export interface SafeModeDataQuality {
  isStale: boolean        // true => must be treated as fail-closed (SAFE_MODE active)
  level: SafeModeDataQualityLevel
  reason: string | null
  ageHours: number | null
}

const SAFE_MODE_STALE_THRESHOLD_MS = SAFE_MODE_STALE_HOURS * 60 * 60 * 1000

export function computeSafeModeDataQuality(
  lastChecked: string | null | undefined,
  source: 'loaded' | 'default' | undefined,
  now: number = Date.now(),
): SafeModeDataQuality {
  if (source === 'default' || source == null) {
    return {
      isStale: true,
      level: 'unavailable',
      reason: 'safe_mode.json が取得できません — 新規買付は安全側停止中',
      ageHours: null,
    }
  }

  if (!lastChecked) {
    return {
      isStale: true,
      level: 'stale',
      reason: 'SAFE_MODEデータの last_checked が確認できません — 新規買付は安全側停止中',
      ageHours: null,
    }
  }

  const tsMs = new Date(lastChecked).getTime()
  if (Number.isNaN(tsMs)) {
    return {
      isStale: true,
      level: 'stale',
      reason: 'SAFE_MODEデータの last_checked が不正です — 新規買付は安全側停止中',
      ageHours: null,
    }
  }

  const ageMs = now - tsMs
  const ageHours = ageMs / (60 * 60 * 1000)

  if (ageMs > SAFE_MODE_STALE_THRESHOLD_MS) {
    return {
      isStale: true,
      level: 'stale',
      reason: `SAFE_MODEデータが${Math.floor(ageHours)}時間以上更新されていません — 新規買付は安全側停止中`,
      ageHours,
    }
  }

  return { isStale: false, level: 'ok', reason: null, ageHours }
}

export const selectSafeModeDataQuality = (s: AppState, now: number = Date.now()): SafeModeDataQuality =>
  computeSafeModeDataQuality(
    s.system.dataTimestamps?.safeMode,
    s.system.dataSourceStatus.safeMode,
    now,
  )

// ── P4.5-A011: SAFE_MODEの実効active（生値 OR データ鮮度によるfail-closed） ──
// safe_mode.jsonの取得・schema検証に成功していても、last_checkedがSAFE_MODE_STALE_HOURSを
// 超えていれば安全側に倒す（P4-A159のfail-closed方針をタブ表示ゲートにも一貫させる）。
// runFullAnalysis（useAppStore.ts）の合成条件と同一式— 新しいゲートを追加するのではなく、
// 既存の「active || isStale」を単一のセレクタに集約し、各タブのraw active参照を置換する。
export const selectEffectiveSafeModeActive = (s: AppState, now: number = Date.now()): boolean =>
  s.safeMode.safe_mode.active || selectSafeModeDataQuality(s, now).isStale

// ── CASH-AUTH-1: 現金権限の実効値 ─────────────────────────────
// 権限は state.cashAssumptions ただ一つ。DEFAULT（未設定）は「不明」であり、
// 既定値やCSVから金額を推測しない — 実行可能金額を捏造しないための fail-closed。
// 判定ロジックは src/domain/cash/cashAuthority.ts に集約しており、ここは
// store 向けの薄い読み出し層にすぎない（parallel authority を作らない）。
export type CashAssumptionsSource = 'manual' | 'default'

export interface EffectiveCashAssumptions {
  /** 総現金。MANUAL のときのみ実値、DEFAULT は 0 */
  grossCash: number
  /** 生活・安全余力（総現金の部分集合） */
  safetyReserve: number
  /** 未約定買付確保額。null = 不明 */
  pendingOrderCash: number | null
  /**
   * 総資産計上に使う現金合計。CASH-AUTH-1 では常に grossCash と等しい
   * （safetyReserve / pendingOrderCash は部分集合であり加算しない）。
   */
  cashTotal: number
  source: CashAssumptionsSource
  updatedAt: string | null
}

export function selectEffectiveCashAssumptions(s: AppState): EffectiveCashAssumptions {
  const a = s.cashAssumptions
  if (a.source === 'MANUAL') {
    return {
      grossCash: a.grossCash,
      safetyReserve: a.safetyReserve,
      pendingOrderCash: a.pendingOrderCash,
      cashTotal: a.grossCash,
      source: 'manual',
      updatedAt: a.updatedAt,
    }
  }
  return {
    grossCash: 0,
    safetyReserve: 0,
    pendingOrderCash: null,
    cashTotal: 0,
    source: 'default',
    updatedAt: null,
  }
}

// ── CASH-AUTH-1: 現金権限の鮮度（凍結TTL 168h / 警告 144h） ──
// 値そのものは失効しても保持し（参考値として表示）、実行可能性のみを落とす。
// 既定値（権限なし）は unknown であり、fresh にも stale にもならない。
export interface CashAssumptionsFreshness {
  /** 権限として使用できない（unknown / stale）ことを示す既存互換フラグ */
  isStale: boolean
  ageHours: number | null
  /** allocation engine の safetyState.cash に渡す状態 */
  state: CashAuthorityState
  /** 144h <= age <= 168h。fresh のまま表示する「まもなく失効」警告 */
  approachingExpiry: boolean
  /** updatedAt + 168h。ローカルTTLガードのスケジュールに使う */
  expiresAtMs: number | null
  reason: CashAuthorityFreshness['reason']
}

export function computeCashAssumptionsFreshness(
  cashAssumptions: CashAssumptions,
  now: number = Date.now(),
): CashAssumptionsFreshness {
  const freshness = evaluateCashAuthorityFreshness(cashAssumptions, now)
  return {
    isStale: freshness.state === 'stale',
    ageHours: freshness.ageHours,
    state: freshness.state,
    approachingExpiry: freshness.approachingExpiry,
    expiresAtMs: freshness.expiresAtMs,
    reason: freshness.reason,
  }
}

export function selectCashAssumptionsFreshness(
  s: AppState,
  now: number = Date.now(),
): CashAssumptionsFreshness {
  return computeCashAssumptionsFreshness(s.cashAssumptions, now)
}

/**
 * CASH-AUTH-1: T0/T9 の読み取り専用サマリー用ビュー。凍結式そのままの
 * 投資可能現金（engine の headroom 制約を含まない上限）と鮮度を返す。
 */
export function selectCashAuthorityView(
  s: AppState,
  now: number = Date.now(),
): CashAuthorityView {
  return deriveCashAuthorityView(s.cashAssumptions, now)
}
