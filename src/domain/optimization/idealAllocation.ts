// ═══════════════════════════════════════════════════════════
// Zero-Base Ideal Portfolio Allocation Engine v9.1
// ゼロベース理想PF構築 + 差分算出 + 制約適用
// ═══════════════════════════════════════════════════════════
import type { AppState, AssetUniverse, AssetCategorySummary } from '../../types'
import {
  TARGET_ALLOCATION_NEUTRAL,
  TARGET_ALLOCATION_BULL,
  TARGET_ALLOCATION_BEAR,
} from '../../constants/market'
import {
  VIX_WARNING,
  VIX_PANIC,
  NIKKEI_VI_WARNING,
  NIKKEI_VI_PANIC,
  SQ_BUFFER_DAYS_BEFORE,
} from '../risk/thresholds'
import { HORIZON_BY_CLASS, CLASS_LABEL, CLASS_ROLE } from '../../types/universe'
import type { AssetClass } from '../../types/universe'
import { isSellLocked, getSellLockRemainingDays, getSellableDate } from '../constraints/stockLock'

export function buildAssetUniverse(state: AppState, nowMs = Date.now()): AssetUniverse {
  const { holdings, trust, cash, cashReserve, addRoom, market, metrics } = state

  // ── 現在の各資産クラス評価額 ──────────────────────────────────
  const jpStockValue  = holdings.reduce((s, h) => s + h.eval, 0)
  const jpTrustValue  = trust.filter(f => f.policy === 'JAPAN_SHORTTERM').reduce((s, f) => s + f.eval, 0)
  const overseasValue = trust.filter(f => f.policy === 'OVERSEAS_LONGTERM').reduce((s, f) => s + f.eval, 0)
  const goldValue     = trust.filter(f => f.policy === 'GOLD').reduce((s, f) => s + f.eval, 0)

  // 総資産（addRoom = 未デプロイ追加枠 も含めてベース計算）
  const totalValue = jpStockValue + jpTrustValue + overseasValue + goldValue + cash + cashReserve + addRoom

  // ── レジーム別目標配分 ──────────────────────────────────────
  const regime = market.regime
  const targetAlloc = regime === 'bull' ? TARGET_ALLOCATION_BULL
                    : regime === 'bear' ? TARGET_ALLOCATION_BEAR
                    : TARGET_ALLOCATION_NEUTRAL

  // ── カテゴリサマリー生成ヘルパー ────────────────────────────
  function makeCat(cls: AssetClass, cur: number, targetRatio: number, score = 50): AssetCategorySummary {
    const targetValue = totalValue * targetRatio
    return {
      class: cls,
      label: CLASS_LABEL[cls],
      role: CLASS_ROLE[cls],
      horizon: HORIZON_BY_CLASS[cls],
      currentValue: cur,
      currentRatio: totalValue > 0 ? cur / totalValue : 0,
      targetRatio,
      targetValue,
      diffValue: targetValue - cur,       // +: 買い増し / −: 売却
      diffRatio: targetRatio - (totalValue > 0 ? cur / totalValue : 0),
      score: Math.round(Math.max(0, Math.min(100, score))),
      lastUpdatedAt: null,
    }
  }

  // ── JP_STOCK: 上限管理（P4-A47: PortfolioPolicyのjpStockMaxRatioを優先）──
  // PortfolioPolicy未設定時はレジーム別TARGET_ALLOCATIONを維持（後方互換）
  const jpStockMaxRatio    = state.portfolioPolicy?.jpStockMaxRatio ?? targetAlloc.JP_STOCK
  const jpStockCap         = jpStockMaxRatio * totalValue                  // 比率上限額
  const jpStockTargetValue = Math.min(jpStockCap, jpStockValue)            // 上限超過時のみ cap を target とする
  const jpStockTargetRatio = totalValue > 0 ? jpStockTargetValue / totalValue : jpStockMaxRatio

  // ── 資産クラス別スコア計算 ───────────────────────────────────
  function avgTrustScore(policy: string): number {
    const funds = trust.filter(f => f.policy === policy)
    if (funds.length === 0) return 50
    return funds.reduce((s, f) => s + f.score, 0) / funds.length
  }

  const jpStockScore   = metrics
    ? Math.min(100, 40 + metrics.sharpe * 15 + metrics.sortino * 5)
    : 55
  const jpTrustScore   = avgTrustScore('JAPAN_SHORTTERM')
  const overseasScore  = avgTrustScore('OVERSEAS_LONGTERM')
  const goldScore      = avgTrustScore('GOLD')

  const categories: AssetCategorySummary[] = [
    makeCat('JP_STOCK',       jpStockValue,  jpStockTargetRatio,           jpStockScore),
    makeCat('JP_TRUST',       jpTrustValue,  targetAlloc.JP_TRUST,         jpTrustScore),
    makeCat('OVERSEAS_TRUST', overseasValue, targetAlloc.OVERSEAS_TRUST,   overseasScore),
    makeCat('GOLD',           goldValue,     targetAlloc.GOLD,             goldScore),
    makeCat('CASH',           cash,          targetAlloc.CASH),
    makeCat('CASH_RESERVE',   cashReserve,   targetAlloc.CASH_RESERVE),
  ]

  return {
    totalValue,
    categories,
    cash,
    cashReserve,
    addRoom,
    lastUpdatedAt: new Date(nowMs).toISOString(),
  }
}

// ── Phase 3: ゼロベース理想PFプラン（差分 + 制約 統合） ──────────

/** 投信差分行（jp_fund / global_fund 共通） */
export interface FundDiffRow {
  id:           string
  name:         string
  abbr:         string
  policy:       'JAPAN_SHORTTERM' | 'OVERSEAS_LONGTERM' | 'GOLD'
  currentValue: number
  /** クラス内ウェイト（0–1） */
  currentWeight: number
  targetValue:  number
  targetWeight: number
  diffValue:    number   // + = 買い増し / − = 売却
  recommendation: 'BUY' | 'HOLD' | 'SELL'
  score:        number
  ev:           number
}

/** PF制約 */
export interface PfConstraint {
  type:     'stock_lock' | 'no_trade' | 'cash_min' | 'class_cap'
  message:  string
  severity: 'info' | 'warn' | 'block'
}

/** ゼロベース理想PFプラン（全資産クラス統合） */
export interface IdealPfPlan {
  universe:        AssetUniverse
  constraints:     PfConstraint[]
  jpFundRows:      FundDiffRow[]
  globalFundRows:  FundDiffRow[]
  actionSummary:   string[]   // 今週やるべき上位 5 件
  noTrade:         boolean
  noTradeReasons:  string[]
  generatedAt:     string
}

/**
 * buildIdealPfPlan — ゼロベース理想PF + 差分算出 + 制約反映
 *
 * - 資産クラスレベルの差分は universe.categories から取得
 * - 投信レベルの差分はスコア重み付き分配で算出
 * - 個別株の差分は caller で stockPortfolio.ts から取得（循環依存回避）
 * - 3ヶ月売却不可 / 現金比率最低確保 / ノートレード判定を制約として付与
 */
export function buildIdealPfPlan(state: AppState): IdealPfPlan {
  const universe   = buildAssetUniverse(state)
  const noTradeResult = checkNoTrade(state)

  // ── 制約収集 ─────────────────────────────────────────────────
  const constraints: PfConstraint[] = []

  // ノートレード
  if (noTradeResult.noTrade) {
    constraints.push({
      type:     'no_trade',
      message:  `緊急ノートレード: ${noTradeResult.reasons.join(' / ')}`,
      severity: 'block',
    })
  } else {
    for (const reason of noTradeResult.reasons) {
      constraints.push({ type: 'no_trade', message: reason, severity: 'warn' })
    }
  }

  // 3ヶ月売却ロック
  const lockedHoldings = state.holdings.filter(h => isSellLocked(h))
  for (const h of lockedHoldings) {
    const days = getSellLockRemainingDays(h)
    const date = getSellableDate(h)
    constraints.push({
      type:     'stock_lock',
      message:  `${h.name}（${h.code}）— 売却不可あと${days}日（${date ?? '不明'}解除）`,
      severity: 'info',
    })
  }

  // 現金最低維持チェック（現金 < cashReserve の場合）
  if (state.cash < state.cashReserve * 0.5) {
    constraints.push({
      type:     'cash_min',
      message:  `現金残高 ${Math.round(state.cash / 10_000)}万円 — 暴落待機資金の50%を下回っています`,
      severity: 'warn',
    })
  }

  // JP_STOCK上限チェック（P4-A47: PortfolioPolicy優先。削減分は長期資産へ再配分方針）
  const regimeAlloc   = state.market.regime === 'bull' ? TARGET_ALLOCATION_BULL
                      : state.market.regime === 'bear' ? TARGET_ALLOCATION_BEAR
                      : TARGET_ALLOCATION_NEUTRAL
  const jpStockCat      = universe.categories.find(c => c.class === 'JP_STOCK')
  const effectiveJpStockCap = state.portfolioPolicy?.jpStockMaxRatio ?? regimeAlloc.JP_STOCK
  const jpStockCapValue = effectiveJpStockCap * universe.totalValue
  if (jpStockCat && jpStockCat.currentValue > jpStockCapValue * 1.001) {
    constraints.push({
      type:     'class_cap',
      message:  `個別株比率 ${(jpStockCat.currentRatio * 100).toFixed(1)}% — 上限${(effectiveJpStockCap * 100).toFixed(0)}%超過。新規買い停止。既存保有はロック解除後に削減候補（長期資産へ再配分）`,
      severity: 'warn',
    })
  }

  // ── JP投信 差分算出 ──────────────────────────────────────────
  const jpFunds = state.trust.filter(f => f.policy === 'JAPAN_SHORTTERM')
  const jpClassTarget = universe.categories.find(c => c.class === 'JP_TRUST')
  const jpFundRows: FundDiffRow[] = buildFundDiffRows(jpFunds, jpClassTarget?.targetValue ?? 0)

  // ── 海外投信 差分算出 ────────────────────────────────────────
  const globalFunds = state.trust.filter(f => f.policy === 'OVERSEAS_LONGTERM' || f.policy === 'GOLD')
  // 海外株投信 と ゴールドを合算した目標
  const overseasTarget = universe.categories.find(c => c.class === 'OVERSEAS_TRUST')?.targetValue ?? 0
  const goldTarget     = universe.categories.find(c => c.class === 'GOLD')?.targetValue ?? 0

  const overseasFunds = globalFunds.filter(f => f.policy === 'OVERSEAS_LONGTERM')
  const goldFunds     = globalFunds.filter(f => f.policy === 'GOLD')

  const overseasRows = buildFundDiffRows(overseasFunds, overseasTarget)
  const goldRows     = buildFundDiffRows(goldFunds, goldTarget)
  const globalFundRows: FundDiffRow[] = [...overseasRows, ...goldRows]

  // ── アクションサマリー生成 ────────────────────────────────────
  const actionSummary = buildActionSummary(universe, jpFundRows, globalFundRows, constraints, state)

  return {
    universe,
    constraints,
    jpFundRows,
    globalFundRows,
    actionSummary,
    noTrade:       noTradeResult.noTrade,
    noTradeReasons: noTradeResult.reasons,
    generatedAt:   new Date().toISOString(),
  }
}

/** スコア重み付きで投信クラス予算を各ファンドに按分 */
function buildFundDiffRows(
  funds: AppState['trust'],
  classBudget: number,
): FundDiffRow[] {
  if (funds.length === 0) return []

  const totalCurrentValue = funds.reduce((s, f) => s + f.eval, 0)
  const totalScore = funds.reduce((s, f) => s + Math.max(f.score, 1), 0)

  return funds.map(f => {
    const scoreRatio  = totalScore > 0 ? Math.max(f.score, 1) / totalScore : 1 / funds.length
    const targetValue = classBudget * scoreRatio
    const diffValue   = targetValue - f.eval
    const currentWeight = totalCurrentValue > 0 ? f.eval / totalCurrentValue : 0
    const targetWeight  = scoreRatio

    const recommendation: FundDiffRow['recommendation'] =
      diffValue > 200_000 ? 'BUY' :
      diffValue < -200_000 ? 'SELL' : 'HOLD'

    return {
      id:            f.id,
      name:          f.name,
      abbr:          f.abbr,
      policy:        f.policy,
      currentValue:  f.eval,
      currentWeight,
      targetValue:   Math.round(targetValue),
      targetWeight,
      diffValue:     Math.round(diffValue),
      recommendation,
      score:         f.score,
      ev:            f.ev,
    }
  })
}

/** アクションサマリーを優先度順に最大5件生成 */
function buildActionSummary(
  universe:       AssetUniverse,
  jpFundRows:     FundDiffRow[],
  globalFundRows: FundDiffRow[],
  constraints:    PfConstraint[],
  state:          AppState,
): string[] {
  const items: Array<{ priority: number; text: string }> = []

  // ノートレード・警告を最優先
  for (const c of constraints) {
    if (c.severity === 'block') {
      items.push({ priority: 0, text: `[緊急] ${c.message}` })
    } else if (c.severity === 'warn' && c.type === 'no_trade') {
      items.push({ priority: 1, text: `[警戒] ${c.message}` })
    }
  }

  // 資産クラスレベルの大きな差分
  for (const cat of universe.categories) {
    const absDiff = Math.abs(cat.diffValue)
    if (absDiff < 300_000) continue
    const dir = cat.diffValue > 0 ? '買い増し' : '削減'
    items.push({
      priority: cat.diffValue > 0 ? 2 : 3,
      text:     `[${cat.label}] ${dir} ${Math.round(absDiff / 10_000)}万円 — 現在${Math.round(cat.currentRatio * 100)}% → 目標${Math.round(cat.targetRatio * 100)}%`,
    })
  }

  // 投信レベル差分（大きい順）
  const allFundRows = [...jpFundRows, ...globalFundRows]
    .filter(r => Math.abs(r.diffValue) > 200_000)
    .sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue))
    .slice(0, 3)

  for (const row of allFundRows) {
    const dir = row.diffValue > 0 ? '買い増し' : '削減'
    items.push({
      priority: 4,
      text:     `[投信] ${row.abbr}: ${dir} ${Math.round(Math.abs(row.diffValue) / 10_000)}万円（スコア${row.score}）`,
    })
  }

  // 個別株のうちロックが外れる最近銘柄
  const soonUnlocked = state.holdings
    .filter(h => isSellLocked(h))
    .map(h => ({ h, days: getSellLockRemainingDays(h) }))
    .filter(x => x.days <= 14)
    .sort((a, b) => a.days - b.days)
    .slice(0, 2)

  for (const { h, days } of soonUnlocked) {
    items.push({
      priority: 5,
      text:     `[個別株] ${h.name}（${h.code}）— あと${days}日でロック解除。売却候補の場合は準備を`,
    })
  }

  return items
    .sort((a, b) => a.priority - b.priority)
    .map(i => i.text)
    .slice(0, 5)
}

// ── ノートレード判定 ────────────────────────────────────────────
export interface NoTradeResult {
  noTrade: boolean
  reasons: string[]
  mode: 'normal' | 'caution' | 'emergency'
}

export function checkNoTrade(state: AppState): NoTradeResult {
  const reasons: string[] = []
  const vix = state.market.vix
  const regime = state.market.regime
  const sq = state.sqCalendar?.nextSQ

  // VIX警戒
  if (vix >= VIX_PANIC) {
    reasons.push(`VIX ${vix.toFixed(1)} — 暴落水準。新規買い禁止、損切優先`)
  } else if (vix >= VIX_WARNING) {
    reasons.push(`VIX ${vix.toFixed(1)} — 警戒水準。リスク資産の買い増し抑制`)
  }

  // Nikkei VI警戒
  const nvi = state.macro?.nikkeiVI
  if (nvi && nvi >= NIKKEI_VI_PANIC) {
    reasons.push(`日経225 VI ${nvi.toFixed(1)} — パニック水準。投信短期売買禁止`)
  } else if (nvi && nvi >= NIKKEI_VI_WARNING) {
    reasons.push(`日経225 VI ${nvi.toFixed(1)} — 高ボラ警戒。投信打診買いのみ`)
  }

  // SQ直前
  if (sq && sq.dayUntil <= SQ_BUFFER_DAYS_BEFORE) {
    reasons.push(`SQ ${sq.date} まで${sq.dayUntil}営業日 — 直前。短期売買抑制`)
  }

  // ベアレジーム
  if (regime === 'bear') {
    reasons.push('市場レジーム: ベア — 新規エントリー最小化、現金比率維持')
  }

  const mode: NoTradeResult['mode'] =
    vix >= VIX_PANIC || (nvi && nvi >= NIKKEI_VI_PANIC) ? 'emergency'
    : reasons.length > 0            ? 'caution'
    : 'normal'

  return {
    noTrade: mode === 'emergency',
    reasons,
    mode,
  }
}
