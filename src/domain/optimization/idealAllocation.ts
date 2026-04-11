// ═══════════════════════════════════════════════════════════
// Zero-Base Ideal Portfolio Allocation Engine v9.1
// ゼロベース理想PF構築 + 差分算出 + 制約適用
// ═══════════════════════════════════════════════════════════
import type { AppState, AssetUniverse, AssetCategorySummary } from '../../types'
import {
  TARGET_ALLOCATION_NEUTRAL,
  TARGET_ALLOCATION_BULL,
  TARGET_ALLOCATION_BEAR,
  JP_STOCK_MAX_VALUE,
} from '../../constants/market'
import { HORIZON_BY_CLASS, CLASS_LABEL, CLASS_ROLE } from '../../types/universe'
import type { AssetClass } from '../../types/universe'

export function buildAssetUniverse(state: AppState): AssetUniverse {
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

  // ── JP_STOCK: 上限制約 8,000,000円 適用 ──────────────────────
  const jpStockRawTarget  = targetAlloc.JP_STOCK * totalValue
  const jpStockCapped     = Math.min(jpStockRawTarget, JP_STOCK_MAX_VALUE)
  const jpStockTargetRatio = totalValue > 0 ? jpStockCapped / totalValue : targetAlloc.JP_STOCK

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
    lastUpdatedAt: new Date().toISOString(),
  }
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
  if (vix >= 30) {
    reasons.push(`VIX ${vix.toFixed(1)} — 暴落水準。新規買い禁止、損切優先`)
  } else if (vix >= 25) {
    reasons.push(`VIX ${vix.toFixed(1)} — 警戒水準。リスク資産の買い増し抑制`)
  }

  // Nikkei VI警戒
  const nvi = state.macro?.nikkeiVI
  if (nvi && nvi >= 35) {
    reasons.push(`日経225 VI ${nvi.toFixed(1)} — パニック水準。投信短期売買禁止`)
  } else if (nvi && nvi >= 25) {
    reasons.push(`日経225 VI ${nvi.toFixed(1)} — 高ボラ警戒。投信打診買いのみ`)
  }

  // SQ直前
  if (sq && sq.dayUntil <= 2) {
    reasons.push(`SQ ${sq.date} まで${sq.dayUntil}営業日 — 直前。短期売買抑制`)
  }

  // ベアレジーム
  if (regime === 'bear') {
    reasons.push('市場レジーム: ベア — 新規エントリー最小化、現金比率維持')
  }

  const mode: NoTradeResult['mode'] =
    vix >= 30 || (nvi && nvi >= 35) ? 'emergency'
    : reasons.length > 0            ? 'caution'
    : 'normal'

  return {
    noTrade: mode === 'emergency',
    reasons,
    mode,
  }
}
