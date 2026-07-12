import type { Trust, CandidateBlockedReason, CandidatesNewsData, RegimeState } from '../../types'
import type { CandidateAssetType, CandidateConstraintState } from './candidateTypes'
import { inferTrustRole, ROLE_EXPOSURE_LIMIT_RATIO, type TrustRole } from './roleExposure'

export interface ConstraintContext {
  dqSuppressed: boolean
  noTrade: boolean
  // P4-A6a: noTradeResult.mode === 'caution' をBUY_NEW降格用contextとして保持する（降格はP4-A6bで実装）
  marketCaution: boolean
  availableCash: number
  // 候補ファンドの資産クラスの現在評価額と目標額（AssetUniverse.categories から取得）
  // P4-A3: 0以下は class target 未取得として fail-safe BLOCKED にする
  classCurrentValue: number
  classTargetValue: number
  // P4-A2: role別 exposure（eval>0 の保有投信を role 別合算）
  roleExposureByRole: Record<TrustRole, number>
  totalTrustValue: number
  // P4-A8a: market.regime を signal 可視化用に保持するだけ。gateロジックには使わない。
  marketRegime: 'bull' | 'neutral' | 'bear'
  // P4-A9a: market / trust データの鮮度（日数）。reason表示用のみ。gate/DATA_STALE化には使わない。
  marketDataAgeDays: number | null
  trustDataAgeDays: number | null
  // P4-A9b: asset class proxy trend 入力値。observability用のみ。gateロジックでは使わない。
  marketNikkeiChgPct: number | null
  macroSp500ChgPct: number | null
  macroNasdaqChgPct: number | null
  macroGoldChgPct: number | null
  // P4-A9c: candidates_news signal。summary-only。score/action非接続。
  candidatesNews?: CandidatesNewsData | null
  candidatesNewsSource?: 'loaded' | 'default'
  // P4-A9d: 5-regime live state。summary-only。score/action非接続。
  regimeState?: RegimeState | null
  regimeStateSource?: 'loaded' | 'default'
  // P4-A18: backend SAFE_MODE (safe_mode.py) の new_buys_frozen 相当の接続点。
  // 現時点でこのフィールドを設定する loader は存在しない（safe_mode.json は
  // sample_contract 固定、full_batch.yml の routines job も stub のため）。
  // ローダー配線が完了した際にここへ true を渡せばBUYが確実に止まるよう
  // Gateのみ先行実装している。未設定時は false 同等として扱う。
  safeModeActive?: boolean
}

export interface ConstraintResult {
  blocked: CandidateBlockedReason[]
  constraints: CandidateConstraintState
  maxAmount: number
}

// OVERSEAS_LONGTERM / GOLD の信託報酬上限（%単位）
// jp_trust は短期売買専用のため報酬体系が異なり、cost チェックを na とする
const COST_THRESHOLD: Partial<Record<CandidateAssetType, number>> = {
  global_trust: 0.50,
  gold: 0.60,
}

// P4-A4: sigma 0.30以上は高ボラ候補として新規採用対象から除外する
export const VOL_HARD_LIMIT = 0.30

export const MIN_BUY_AMOUNT = 10_000   // 最低購入額
export const MAX_AMOUNT_CAP = 100_000  // 1候補あたり最大購入上限（参考値）

export function applyCandidateConstraints(
  trust: Trust,
  assetType: CandidateAssetType,
  ctx: ConstraintContext,
): ConstraintResult {
  const blocked: CandidateBlockedReason[] = []
  const constraints: CandidateConstraintState = {
    dqGate: 'pass',
    noTradeGate: 'pass',
    classHeadroom: 'pass',
    duplicateRole: 'pass',
    volatility: 'pass',
    cashBudget: 'pass',
    eligibility: 'pass',
    cost: 'pass',
    notForTrading: 'pass',
    safeMode: 'pass',
  }

  // Gate 1: DQ — データ品質抑制中は後続チェックが無意味のため即終了
  if (ctx.dqSuppressed) {
    constraints.dqGate = 'fail'
    blocked.push('DQ_SUPPRESSED')
    return { blocked, constraints, maxAmount: 0 }
  }

  // Gate 2: 緊急ノートレード — 新規エントリー全停止
  if (ctx.noTrade) {
    constraints.noTradeGate = 'fail'
    blocked.push('NO_TRADE_EMERGENCY')
  }

  // Gate 3: 資産クラスのヘッドルーム
  let headroomCap: number
  if (ctx.classTargetValue > 0) {
    const headroom = Math.max(0, ctx.classTargetValue - ctx.classCurrentValue)
    if (headroom <= 0) {
      constraints.classHeadroom = 'fail'
      blocked.push('CLASS_FULL')
    }
    headroomCap = headroom
  } else {
    // P4-A3: class target が未取得/0 の場合は fail-open させず候補を止める。
    constraints.classHeadroom = 'fail'
    blocked.push('CLASS_TARGET_MISSING')
    headroomCap = 0
  }

  // Gate 4: role重複 — 同roleの既存保有比率が閾値以上なら DUPLICATE_ROLE でブロック
  // leveraged / gold / other は role gate 対象外（score/cost/sigma 側で別管理）
  const role = inferTrustRole(trust)
  const ROLE_GATE_EXCLUDED: TrustRole[] = ['leveraged', 'gold', 'other']
  if (!ROLE_GATE_EXCLUDED.includes(role)) {
    const roleExposureValue = ctx.roleExposureByRole[role] ?? 0
    const roleExposureRatio = ctx.totalTrustValue > 0
      ? roleExposureValue / ctx.totalTrustValue
      : 0
    if (roleExposureRatio >= ROLE_EXPOSURE_LIMIT_RATIO) {
      constraints.duplicateRole = 'fail'
      blocked.push('DUPLICATE_ROLE')
    } else {
      constraints.duplicateRole = 'pass'
    }
  } else {
    // P4-A8a: gate対象外は 'na' で明示（warningではなく中立）
    constraints.duplicateRole = 'na'
  }

  // Gate 5: ボラティリティ — sigmaが高すぎる候補は fail-safe にブロック
  if (trust.sigma >= VOL_HARD_LIMIT) {
    constraints.volatility = 'fail'
    blocked.push('VOL_TOO_HIGH')
  }

  // Gate 6: 現金予算
  if (ctx.availableCash < MIN_BUY_AMOUNT) {
    constraints.cashBudget = 'fail'
    blocked.push('INSUFFICIENT_CASH')
  }

  // Gate 7: 適格性 — NISA積立は自動積立専用で手動 BUY_NEW 不可
  if (trust.account === 'NISA積立') {
    constraints.eligibility = 'fail'
    blocked.push('NOT_ELIGIBLE')
  }

  // Gate 8: 信託報酬 — jp_trust は 'na'（短期運用のため基準が異なる）
  const costThreshold = COST_THRESHOLD[assetType]
  if (costThreshold !== undefined) {
    if (trust.cost > costThreshold) {
      constraints.cost = 'fail'
      blocked.push('COST_TOO_HIGH')
    }
  } else {
    constraints.cost = 'na'
  }

  // Gate 9: 取引不可 — notForTrading フラグが立っている銘柄は候補から排除する
  if (trust.notForTrading === true) {
    constraints.notForTrading = 'fail'
    blocked.push('NOT_FOR_TRADING')
  }

  // Gate 10: SAFE_MODE — システム全体の新規買付凍結シグナル（P4-A18 / P4-A25）
  // P4-A25: useAppStore の baseCtx へ state.safeMode.safe_mode.active を配線済み。
  // fail-closed default (safe_mode.json 未取得時) は active=true → BUY全止め。
  if (ctx.safeModeActive === true) {
    constraints.safeMode = 'fail'
    blocked.push('SAFE_MODE_ACTIVE')
  }

  const maxAmount = blocked.length > 0
    ? 0
    : Math.min(headroomCap, ctx.availableCash, MAX_AMOUNT_CAP)

  return { blocked, constraints, maxAmount }
}
