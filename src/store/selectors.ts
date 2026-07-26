import type { AppState, HoldingAnalysis, Holding, Trust } from '../types'
import { MARKET_DATA_STALE_HOURS, SYSTEM_STALE_HOURS, SAFE_MODE_STALE_HOURS, CASH_ASSUMPTIONS_STALE_HOURS } from '../domain/risk/thresholds'
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

// ── P4.5-A002: 資金前提（現金・待機資金）の実効値 ─────────────
// 手動override中は手動値を総額として使う（CSV/既定値との加算は行わない）。
// 手動override無効時は既定値（constants/market.ts由来のstate.cash/cashReserve）を使う。
// 将来CSV/JSON由来の値が供給されるようになった場合も、この関数のfallback先を
// 差し替えるだけで優先順位（手動 > CSV/JSON > 既定値）を維持できる。
export type CashAssumptionsSource = 'manual' | 'default'

export interface EffectiveCashAssumptions {
  cash: number
  cashReserve: number
  cashTotal: number
  source: CashAssumptionsSource
  manualUpdatedAt: string | null
}

export function selectEffectiveCashAssumptions(s: AppState): EffectiveCashAssumptions {
  const a = s.cashAssumptions
  if (a.manualOverrideEnabled) {
    return {
      cash: a.cashDeposits,
      cashReserve: a.standbyFunds,
      cashTotal: a.cashDeposits + a.standbyFunds,
      source: 'manual',
      manualUpdatedAt: a.manualUpdatedAt,
    }
  }
  return {
    cash: s.cash,
    cashReserve: s.cashReserve,
    cashTotal: s.cash + s.cashReserve,
    source: 'default',
    manualUpdatedAt: null,
  }
}

// ── P4.5-A008: 資金前提の鮮度（表示専用のstale警告。値そのものは変更しない） ──
// TTL失効による無警告revertを廃止した代わりに、manualUpdatedAtが古い場合は
// 「値は維持したまま」stale扱いにしてUIで警告する。既定値使用中（override無効）は
// 常にfalse — 既定値には「更新」という概念がないため警告対象外。
export interface CashAssumptionsFreshness {
  isStale: boolean
  ageHours: number | null
}

export function computeCashAssumptionsFreshness(
  manualOverrideEnabled: boolean,
  manualUpdatedAt: string | null | undefined,
  now: number = Date.now(),
): CashAssumptionsFreshness {
  if (!manualOverrideEnabled) {
    return { isStale: false, ageHours: null }
  }
  if (!manualUpdatedAt) {
    return { isStale: true, ageHours: null }
  }
  const tsMs = new Date(manualUpdatedAt).getTime()
  if (Number.isNaN(tsMs)) {
    return { isStale: true, ageHours: null }
  }
  const ageHours = (now - tsMs) / (60 * 60 * 1000)
  return { isStale: ageHours > CASH_ASSUMPTIONS_STALE_HOURS, ageHours }
}

export function selectCashAssumptionsFreshness(
  s: AppState,
  now: number = Date.now(),
): CashAssumptionsFreshness {
  return computeCashAssumptionsFreshness(
    s.cashAssumptions.manualOverrideEnabled,
    s.cashAssumptions.manualUpdatedAt,
    now,
  )
}
