// ═══════════════════════════════════════════════════════════
// P5-B002b-1: candidates_stocks.json 由来の新規個別株候補
// score/headroom/gate/保有除外を計算する（observability内部計算のみ）。
//
// スコープ外（B003の責務）:
//   - officialDecision.actions への接続
//   - T0/T1/T7 UI表示
//
// 設計上の前提（read-only監査で確認済み）:
//   - stock_scores_6axis.json は保有銘柄専用（未保有候補には流用不可）
//   - universe.categories の JP_STOCK targetValue は
//     Math.min(jpStockCap, jpStockValue) に丸められるため、
//     target-current の差分は恒久的に0になる。headroomはここで独立計算する。
//   - batch側（data/build_candidates_stocks.py）は保有有無で候補を除外しない
//     （公開JSON差分からの間接的な個人情報漏洩を避けるため）。
//     保有除外はこのファイル（frontend/store側）でのみ行う。
// ═══════════════════════════════════════════════════════════
import type { Holding, CandidateBlockedReason } from '../../types'
import type { CandidatesStocksData, StockCandidateItem as RawStockCandidateItem } from '../../types/candidatesStocks'
import { MIN_BUY_AMOUNT, MAX_AMOUNT_CAP } from './applyCandidateConstraints'

export type StockCandidateAction = 'BUY_NEW' | 'WATCH' | 'BLOCKED'

export interface StockCandidateConstraintState {
  dqGate: 'pass' | 'fail'
  noTradeGate: 'pass' | 'fail'
  safeMode: 'pass' | 'fail'
  headroomGate: 'pass' | 'fail'
  cashAssumptionsFresh: 'pass' | 'fail'
  cashBudget: 'pass' | 'fail'
  volatility: 'pass' | 'fail'
}

export interface StockCandidateItem {
  code: string
  name: string
  sector: string
  action: StockCandidateAction
  score: number
  usableAxes: number
  maxAmount: number
  blockedReasons: CandidateBlockedReason[]
  constraints: StockCandidateConstraintState
  reason: string
  source: 'candidates_stocks'
}

// 個別株はtrust候補（0.30 hard / 0.25 soft）より高ボラ許容。
// トヨタ等の主力銘柄（sigma252d ≈ 0.33）を一律排除しないための個別株専用閾値。
export const STOCK_VOL_HARD_LIMIT = 0.45
export const STOCK_VOL_SOFT_LIMIT = 0.35

// score算出に使う軸の最低有効数。未満はBUY_NEW不可（WATCH上限）。
export const MIN_USABLE_AXES = 4

const BLOCKED_LABEL: Record<CandidateBlockedReason, string> = {
  DQ_SUPPRESSED:        'データ品質抑制中',
  NO_TRADE_EMERGENCY:   '緊急ノートレード',
  CLASS_FULL:           'クラス上限到達',
  CLASS_TARGET_MISSING: 'クラス目標額未取得',
  INSUFFICIENT_CASH:    '現金不足',
  JP_STOCK_CAP:         '日本株上限',
  NOT_FOR_TRADING:      '売買不可',
  SAMPLE_CONTRACT:      'サンプル契約',
  NOT_ELIGIBLE:         '適格外',
  SCORE_TOO_LOW:        'スコア不足',
  DUPLICATE_ROLE:       '役割重複',
  VOL_TOO_HIGH:         'ボラティリティ過大',
  COST_TOO_HIGH:        '信託報酬過大',
  DATA_STALE:           'データ陳腐化',
  SAFE_MODE_ACTIVE:     'SAFE_MODE発動中',
}

// ── candidates_stocks.json 全体の鮮度・利用可否ゲート ─────────
// source !== 'loaded' / status === 'empty' / updatedAt が staleThresholdHours 超過
// のいずれかで候補パイプライン全体を停止する（個別候補のBLOCKEDではなく空配列）。
export function isCandidatesStocksUsable(
  data: CandidatesStocksData,
  source: 'loaded' | 'default',
  now: number = Date.now(),
): boolean {
  if (source !== 'loaded') return false
  if (data.status === 'empty') return false
  if (!data.updatedAt) return false
  const tsMs = new Date(data.updatedAt).getTime()
  if (Number.isNaN(tsMs)) return false
  const ageMs = now - tsMs
  if (ageMs < 0) return true
  const staleMs = data.staleThresholdHours * 60 * 60 * 1000
  return ageMs <= staleMs
}

// ── JP_STOCK headroom（universe.categoriesの丸め値を使わない独立計算） ──
export function computeJpStockHeadroom(
  holdings: Holding[],
  jpStockMaxRatio: number,
  universeTotalValue: number,
): number {
  const jpStockCurrentValue = holdings.reduce((sum, h) => sum + h.eval, 0)
  const jpStockCap = jpStockMaxRatio * universeTotalValue
  return Math.max(0, jpStockCap - jpStockCurrentValue)
}

// ── 保有除外 ────────────────────────────────────────────────
// eval > 0 の保有銘柄コードのみ除外する。eval = 0 は実質未保有として候補対象に残す。
export function excludeHeldStockCandidates(
  candidates: RawStockCandidateItem[],
  holdings: Holding[],
): RawStockCandidateItem[] {
  const heldCodes = new Set(holdings.filter(h => h.eval > 0).map(h => h.code))
  return candidates.filter(c => !heldCodes.has(c.code))
}

// ── score算出（stock_scores_6axisは一切参照しない。candidates_stocksの7指標のみ） ──
export interface StockCandidateScoreResult {
  score: number
  usableAxes: number
}

export function computeStockCandidateScore(item: RawStockCandidateItem): StockCandidateScoreResult {
  const axes = [item.per, item.pbr, item.roe, item.dividendYield, item.sigma252d, item.mom3m]
  const usableAxes = axes.filter(v => v !== null).length

  let raw = 50

  // value: PER 0<per<15 で最大+12（線形、15以上/0以下は寄与0）
  if (item.per !== null && item.per > 0 && item.per < 15) {
    raw += ((15 - item.per) / 15) * 12
  }
  // value: PBR 0<pbr<1.2 で最大+8（線形）
  if (item.pbr !== null && item.pbr > 0 && item.pbr < 1.2) {
    raw += ((1.2 - item.pbr) / 1.2) * 8
  }
  // quality: ROE — 20%で飽和、0で寄与0（負のROEは寄与0のまま。ペナルティ化しない）
  if (item.roe !== null) {
    raw += Math.max(0, Math.min(1, item.roe / 20)) * 12
  }
  // income: 配当利回り — 3%で飽和
  if (item.dividendYield !== null) {
    raw += Math.max(0, Math.min(1, item.dividendYield / 3)) * 8
  }
  // momentum: mom3mを[-10,+10]にclampしてから緩い係数（÷2）
  if (item.mom3m !== null) {
    raw += Math.max(-10, Math.min(10, item.mom3m)) / 2
  }
  // volペナルティ: sigma252dが0.25を超える分だけ減点
  if (item.sigma252d !== null) {
    raw -= Math.max(0, item.sigma252d - 0.25) * 60
  }

  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10
  return { score, usableAxes }
}

// ── gate context ──────────────────────────────────────────
export interface StockCandidateGateContext {
  dqSuppressed: boolean
  noTrade: boolean         // emergency（checkNoTrade().noTrade相当）
  marketCaution: boolean   // checkNoTrade().mode === 'caution'
  safeModeActive: boolean
  availableCash: number
  jpStockHeadroom: number
  cashAssumptionsUsable: boolean  // manual override かつ stale でない
}

export interface StockCandidateGateResult {
  blocked: CandidateBlockedReason[]
  constraints: StockCandidateConstraintState
  maxAmount: number
}

export function applyStockCandidateGates(
  item: RawStockCandidateItem,
  ctx: StockCandidateGateContext,
): StockCandidateGateResult {
  const blocked: CandidateBlockedReason[] = []
  const constraints: StockCandidateConstraintState = {
    dqGate: 'pass',
    noTradeGate: 'pass',
    safeMode: 'pass',
    headroomGate: 'pass',
    cashAssumptionsFresh: 'pass',
    cashBudget: 'pass',
    volatility: 'pass',
  }

  // Gate 1: DQ — 後続チェックが無意味のため即終了
  if (ctx.dqSuppressed) {
    constraints.dqGate = 'fail'
    blocked.push('DQ_SUPPRESSED')
    return { blocked, constraints, maxAmount: 0 }
  }

  // Gate 2: 緊急ノートレード
  if (ctx.noTrade) {
    constraints.noTradeGate = 'fail'
    blocked.push('NO_TRADE_EMERGENCY')
  }

  // Gate 3: SAFE_MODE
  if (ctx.safeModeActive) {
    constraints.safeMode = 'fail'
    blocked.push('SAFE_MODE_ACTIVE')
  }

  // Gate 4: JP_STOCK headroom
  if (ctx.jpStockHeadroom <= 0) {
    constraints.headroomGate = 'fail'
    blocked.push('JP_STOCK_CAP')
  }

  // Gate 5: cashAssumptions鮮度（default運用中 or stale はBUY_NEW不可）
  if (!ctx.cashAssumptionsUsable) {
    constraints.cashAssumptionsFresh = 'fail'
    blocked.push('DATA_STALE')
  }

  // Gate 6: 現金予算
  if (ctx.availableCash < MIN_BUY_AMOUNT) {
    constraints.cashBudget = 'fail'
    blocked.push('INSUFFICIENT_CASH')
  }

  // Gate 7: ボラティリティ hard limit
  if (item.sigma252d !== null && item.sigma252d >= STOCK_VOL_HARD_LIMIT) {
    constraints.volatility = 'fail'
    blocked.push('VOL_TOO_HIGH')
  }

  const maxAmount = blocked.length > 0
    ? 0
    : Math.min(ctx.jpStockHeadroom, ctx.availableCash, MAX_AMOUNT_CAP)

  return { blocked, constraints, maxAmount }
}

// ── action決定 ────────────────────────────────────────────
export function resolveStockCandidateAction(
  blocked: CandidateBlockedReason[],
  score: number,
  usableAxes: number,
  dataStatus: RawStockCandidateItem['dataStatus'],
  sigma252d: number | null,
  marketCaution: boolean,
): StockCandidateAction {
  if (blocked.length > 0) return 'BLOCKED'

  const axesInsufficient = usableAxes < MIN_USABLE_AXES || dataStatus !== 'ok'
  const volSoft = sigma252d !== null && sigma252d >= STOCK_VOL_SOFT_LIMIT
  const capAtWatch = axesInsufficient || volSoft || marketCaution

  if (score >= 75) return capAtWatch ? 'WATCH' : 'BUY_NEW'
  if (score >= 50) return 'WATCH'
  return 'BLOCKED'
}

function buildStockCandidateReason(
  action: StockCandidateAction,
  item: RawStockCandidateItem,
  score: number,
  usableAxes: number,
  blocked: CandidateBlockedReason[],
): string {
  if (action === 'BLOCKED') {
    const labels = blocked.map(r => BLOCKED_LABEL[r] ?? r).join('・')
    return `候補除外: ${labels || 'スコア不足'}`
  }
  const per = item.per !== null ? item.per.toFixed(1) : '—'
  const roe = item.roe !== null ? item.roe.toFixed(1) : '—'
  const div = item.dividendYield !== null ? item.dividendYield.toFixed(1) : '—'
  const base = `スコア${score.toFixed(0)}（有効軸${usableAxes}/6）: PER${per}、ROE${roe}%、配当${div}%。`
  if (action === 'BUY_NEW') return `${base}新規調査候補。`
  return `${base}条件通過だが監視段階。`
}

// ── 候補パイプライン全体 ─────────────────────────────────────
export interface StockCandidatePlanContext {
  holdings: Holding[]
  candidatesStocks: CandidatesStocksData
  candidatesStocksSource: 'loaded' | 'default'
  dqSuppressed: boolean
  noTrade: boolean
  marketCaution: boolean
  safeModeActive: boolean
  availableCash: number
  jpStockHeadroom: number
  cashAssumptionsUsable: boolean
  now?: number
}

// officialDecisionへは一切接続しない（B003の責務）。純粋な内部候補リストを返すのみ。
export function buildStockCandidatePlan(ctx: StockCandidatePlanContext): StockCandidateItem[] {
  if (!isCandidatesStocksUsable(ctx.candidatesStocks, ctx.candidatesStocksSource, ctx.now)) {
    return []
  }

  const eligible = excludeHeldStockCandidates(ctx.candidatesStocks.candidates, ctx.holdings)

  return eligible.map(raw => {
    const { score, usableAxes } = computeStockCandidateScore(raw)
    const gateResult = applyStockCandidateGates(raw, {
      dqSuppressed: ctx.dqSuppressed,
      noTrade: ctx.noTrade,
      marketCaution: ctx.marketCaution,
      safeModeActive: ctx.safeModeActive,
      availableCash: ctx.availableCash,
      jpStockHeadroom: ctx.jpStockHeadroom,
      cashAssumptionsUsable: ctx.cashAssumptionsUsable,
    })
    const blocked = [...gateResult.blocked]
    const action = resolveStockCandidateAction(blocked, score, usableAxes, raw.dataStatus, raw.sigma252d, ctx.marketCaution)

    if (action === 'BLOCKED' && blocked.length === 0) {
      blocked.push('SCORE_TOO_LOW')
    }

    return {
      code: raw.code,
      name: raw.name,
      sector: raw.sector,
      action,
      score,
      usableAxes,
      maxAmount: gateResult.maxAmount,
      blockedReasons: blocked,
      constraints: gateResult.constraints,
      reason: buildStockCandidateReason(action, raw, score, usableAxes, blocked),
      source: 'candidates_stocks' as const,
    }
  })
}
