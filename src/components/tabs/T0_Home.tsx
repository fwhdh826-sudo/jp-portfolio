/**
 * T0_Home — V10 司令塔ホーム画面
 * 今日の結論・ToDo・市場概況・資産サマリー・理想PF差分・リスク警告
 * 表示順: 結論 → 今やること → 根拠 → リスク → 詳細
 * UI-9-3: Dashboard強化 — large verdict / donut / holding preview
 */
import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import {
  selectBuyList,
  selectHoldList,
  selectSellList,
  selectTotalEval,
  selectTotalPnl,
  selectTrustTotalEval,
  selectJpFundTotalEval,
  selectGlobalFundTotalEval,
  selectEffectiveCashAssumptions,
  selectCashAssumptionsFreshness,
  selectCashAuthorityView,
  selectEffectiveSafeModeActive,
  selectSafeModeDataQuality,
  selectCandidateDecisionSynthesis,
} from '../../store/selectors'
import { selectExecutableDeployableCash } from '../../store/allocationConsumerSelectors'
import { formatJPYAuto, formatDateTime, formatRelativeTime, formatPt, formatSignedPct, formatSignedJPY } from '../../utils/format'
import { resolveNewsDisplayText, NEWS_DISPLAY_LIMITS } from '../../utils/newsDisplay'
import { selectIsStale, selectMarketDataQuality } from '../../store/selectors'
import { Phase8SummaryCard } from '../phase8/Phase8SummaryCard'
import { SafeModeStatusCard } from '../v13/SafeModeStatusCard'
import { PageHeader } from '../layout/PageHeader'
import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import { isSellLocked, getSellableDate } from '../../domain/constraints/stockLock'
import { checkTierAT1Violations } from '../../domain/constraints/tierAT1'
import { AssetTypeBadge } from '../badges/AssetTypeBadge'
import {
  SYNTHESIS_ACTION_LABEL,
  synthesisNonExecutableReasonText,
} from '../candidates/candidateDecisionSynthesisPresentation'
import type { CandidateDecisionSynthesisEntry, CandidateDecisionSynthesisSnapshot } from '../../types/candidateDecisionSynthesis'
import type { HoldingAnalysis, Holding } from '../../types'

// ─────────────────────────────────────────────────────────────
// 型ヘルパー
// ─────────────────────────────────────────────────────────────

// P4-A143: BUY表示抑制ゲートの共通化。officialDecision.dataQualitySuppressed（分析実行時に凍結される値）と
// dq.isSuppressed（レンダー時点で再評価される実時間値）を両方ORすることで、アプリを開いたまま
// データ鮮度境界を跨いだ場合のカード間表示矛盾（P4-A142監査で確認）を防ぐ。表示専用、投資判断ロジックには影響しない。
function computeBuyDisplaySuppressed(
  dataQualitySuppressed: boolean,
  dqIsSuppressed: boolean,
  safeModeActive: boolean,
): boolean {
  return safeModeActive || dataQualitySuppressed || dqIsSuppressed
}

// CAND-SYN-1D / D13: T0's candidate surface reads CandidateDecisionSynthesis
// exclusively. `decisions` is already the canonical, ordered, <=3 ADD/BUY_NEW
// shortlist (CANDIDATE_DECISION_SYNTHESIS_DECISION_LIMIT) — this helper does
// not filter, re-slice, re-rank, or apply SAFE_MODE/DQ suppression again
// (those are already folded into the synthesis action/BLOCKED demotion).
// null/unavailable/invalid synthesis fails closed to an empty list; there is
// no fallback to legacy candidatePortfolioRecommendations or officialDecision.
export function computeSynthesisDecisionsForDisplay(
  synthesis: CandidateDecisionSynthesisSnapshot | null,
): readonly CandidateDecisionSynthesisEntry[] {
  if (synthesis === null || synthesis.status !== 'available') return []
  return synthesis.decisions
}

// UI-9: synthesis.status を使って「データ更新待ち」と「再計算が必要」を
// 文言レベルで区別する（表示専用。status===undefinedの判定ロジック自体は変更しない）。
export function candidateSynthesisUnavailableText(
  synthesis: CandidateDecisionSynthesisSnapshot | null,
): string {
  if (synthesis !== null && synthesis.status === 'invalid') {
    return '候補データの再計算が必要です。次回のデータ更新をお待ちください。'
  }
  return '候補データ更新待ちです。次回のデータ更新後に表示されます。'
}

// P5-PRE-1: TopCandidatesCard本体とuseHasCandidateSectionContentが同じ表示対象を
// 参照するよう、topBuy/topSellの算出を純関数へ抽出する。BUY抑制時のtopBuyゼロ化、
// isSellLockedによるtopSell除外、slice件数はTopCandidatesCardの既存実装と完全一致させている。
export function computeTopCandidateSignalsForDisplay(
  buyList: HoldingAnalysis[],
  sellList: HoldingAnalysis[],
  holdings: Holding[],
  dataQualitySuppressed: boolean,
  dqIsSuppressed: boolean,
  safeModeActive: boolean,
): { topBuy: HoldingAnalysis[]; topSell: HoldingAnalysis[] } {
  const isBuySuppressed = computeBuyDisplaySuppressed(dataQualitySuppressed, dqIsSuppressed, safeModeActive)
  const topBuy = isBuySuppressed ? [] : buyList.slice(0, 3)
  // ロック中銘柄は「売り候補」に表示しない（SELL文言の実行指示を防ぐ）
  const topSell = sellList
    .filter(a => {
      const holding = holdings.find(h => h.code === a.code)
      return holding ? !isSellLocked(holding) : true
    })
    .slice(0, 3)
  return { topBuy, topSell }
}

// P4-A153: SAFE_MODE/DQ抑制中はBUY表示のみWAITに変換する（表示専用）。
// SELL/HOLD/WAIT等はそのまま維持し、防御・監視表示を弱めない。decision自体（h.decision/t.decision）は変更しない。
function suppressBuyDecision(
  decision: 'BUY' | 'HOLD' | 'SELL' | 'WAIT',
  isBuySuppressed: boolean,
): 'BUY' | 'HOLD' | 'SELL' | 'WAIT' {
  return isBuySuppressed && decision === 'BUY' ? 'WAIT' : decision
}

function SignBadge({ decision }: { decision: 'BUY' | 'HOLD' | 'SELL' | 'WAIT' }) {
  const map = {
    BUY:  { cls: 'badge--buy',  label: '買い' },
    HOLD: { cls: 'badge--hold', label: '様子見' },
    SELL: { cls: 'badge--sell', label: '売り' },
    WAIT: { cls: 'badge--wait', label: '待機' },
  }
  const { cls, label } = map[decision]
  return <span className={`badge ${cls}`}>{label}</span>
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="section-header">
      <span className="section-header__icon">{icon}</span>
      {/* P1-7: L4カードタイトル。L3(SectionKicker)より弱くするため cardTitle と揃えて13px */}
      <h3 className="section-header__title" style={{ fontSize: 13, margin: 0 }}>{title}</h3>
    </div>
  )
}

// セクション間の小見出し（カードグループの区切り）
function SectionKicker({ label }: { label: string }) {
  // P1-7: L3見出し。L4(SectionTitle)より弱くならないよう14pxへ引き上げ（.home-section-kicker自体は不変）
  return <h2 className="home-section-kicker" style={{ fontSize: 14 }}>{label}</h2>
}

// 優先度バッジ（高優先/中優先/低）
function PriorityBadge({ priority }: { priority: 'high' | 'medium' | 'low' }) {
  const meta = priority === 'high'
    ? { label: '高優先', color: colors.sellText,   bg: colors.sellBg,     border: colors.sellBorder  }
    : priority === 'medium'
      ? { label: '中優先', color: colors.waitText,   bg: colors.waitBg,     border: colors.waitBorder  }
      : { label: '低',     color: colors.textSubtle, bg: colors.bgElevated, border: colors.borderSubtle }
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700,
      padding: '2px 8px', borderRadius: 10, lineHeight: '16px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// 他タブへのナビゲーション pill ボタン
function NavCtaRow() {
  const setTab = useAppStore(s => s.setTab)
  const items = [
    { id: 'T5' as const, icon: '📰', label: 'ニュース' },
    { id: 'T1' as const, icon: '📊', label: '銘柄分析' },
    { id: 'T4' as const, icon: '⚖️', label: '理想PF' },
    { id: 'T7' as const, icon: '🏦', label: '投信管理' },
    { id: 'T6' as const, icon: '🤖', label: 'AI委員会' },
  ]
  return (
    <div className="home-nav-cta">
      {items.map(item => (
        <button
          key={item.id}
          onClick={() => setTab(item.id)}
          type="button"
          className="home-nav-cta__btn"
        >
          <span>{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// UI-9-3: SVG Donut Chart (no external library)
// ─────────────────────────────────────────────────────────────

function DonutChart({ segments }: {
  segments: Array<{ ratio: number; color: string }>
}) {
  const R = 37
  const C = 2 * Math.PI * R  // ≈ 232.5
  const total = segments.reduce((s, seg) => s + seg.ratio, 0)
  if (total === 0) return null

  let cumulative = 0
  return (
    <svg viewBox="0 0 100 100" className="dash-donut-svg" aria-hidden="true">
      {/* Background ring */}
      <circle cx={50} cy={50} r={R} fill="none" stroke="#e5e7eb" strokeWidth={14} />
      {segments.map((seg, i) => {
        if (seg.ratio <= 0) return null
        const norm  = seg.ratio / total
        const dash  = norm * C
        const offset = C * (0.25 - cumulative)
        cumulative += norm
        return (
          <circle
            key={i}
            cx={50} cy={50} r={R}
            fill="none"
            stroke={seg.color}
            strokeWidth={14}
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={offset}
          />
        )
      })}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────
// A. 今日の総合判断カード（UI-9-3: large verdict display added）
// ─────────────────────────────────────────────────────────────

function TodayJudgmentCard() {
  const market           = useAppStore(s => s.market)
  const system           = useAppStore(s => s.system)
  const buyList          = useAppStore(selectBuyList)
  const holdList         = useAppStore(selectHoldList)
  const sellList         = useAppStore(selectSellList)
  const isStale          = useAppStore(selectIsStale)
  const dq               = useAppStore(selectMarketDataQuality)
  const officialDecision = useAppStore(s => s.officialDecision)

  // Fallback values (used when officialDecision is null)
  const regime    = market.regime
  const isHighVix = market.vix >= 28
  const isError   = system.status === 'error'
  const fbNoTradeReasons: string[] = []
  if (isHighVix)           fbNoTradeReasons.push(`VIX ${market.vix.toFixed(1)} — 高ボラティリティ警戒`)
  if (isError)             fbNoTradeReasons.push('データ更新エラー — 最新データで再確認してください')
  if (isStale && !isError) fbNoTradeReasons.push('データが古い可能性あり — 設定タブから更新してください')

  // Derived display values — officialDecision takes precedence when available
  const stanceRegime =
    officialDecision == null ? regime :
    officialDecision.stance === 'risk_on'  ? 'bull' :
    officialDecision.stance === 'risk_off' ? 'bear' : 'neutral'
  const displayRegimeCls   = stanceRegime === 'bull' ? 'bull' : stanceRegime === 'bear' ? 'bear' : 'neutral'
  const displayRegimeLabel = stanceRegime === 'bull' ? '強気相場' : stanceRegime === 'bear' ? '弱気相場' : '中立相場'
  const isDqSuppressed     = officialDecision != null ? officialDecision.dataQualitySuppressed : dq.isSuppressed
  const displayNoTrade     = officialDecision != null ? officialDecision.noTrade : fbNoTradeReasons.length > 0
  const displayNoTradeText = officialDecision != null
    ? (officialDecision.risks.length > 0 ? officialDecision.risks.join(' / ') : 'ノートレード推奨')
    : fbNoTradeReasons.join(' / ')

  // P4-A87: DQ抑制またはSAFE_MODE active中はBUYカウントを表示上0に抑制
  // candidate生成/スコアリングは変更しない。表示値のみ。
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive   = useAppStore(selectEffectiveSafeModeActive)
  // P4-A143: 凍結値(officialDecision.dataQualitySuppressed)に加え実時間のdq.isSuppressedもORし、共通ゲートに統一
  const isBuySuppressed  = computeBuyDisplaySuppressed(officialDecision?.dataQualitySuppressed ?? false, dq.isSuppressed, safeModeActive)
  const displayBuyCount  = isBuySuppressed ? 0 : buyList.length

  return (
    <div className={`card home-hero-card market-mode-banner ${displayRegimeCls}`}>
      {/* タイトル行 */}
      <div className="market-mode-banner__header">
        <span className="market-mode-banner__icon">
          {stanceRegime === 'bull' ? '📈' : stanceRegime === 'bear' ? '📉' : '➡️'}
        </span>
        <span className="market-mode-banner__mode">{displayRegimeLabel}</span>
        {isStale && system.lastUpdated && <span className="stale-badge">⚠️ データ鮮度注意</span>}
        {!system.lastUpdated && <span className="stale-badge">⚠️ 市場データ未取得</span>}
        {/* P4-A97: 平常時安全状態インジケーター — 異常・抑制・stale時は表示しない */}
        {!safeModeActive && !isDqSuppressed && !isBuySuppressed && !displayNoTrade && !isStale && system.lastUpdated && (
          <span className="normal-safety-badge">✓ 監視中</span>
        )}
        <span className="market-mode-banner__date">
          {formatDateTime(system.lastUpdated)} 更新
        </span>
      </div>

      {/* officialDecision ヘッドライン */}
      {officialDecision != null && (
        <div className="market-mode-banner__headline">{officialDecision.headline}</div>
      )}

      {/* UI-12-1: 3-column colored verdict boxes */}
      <div className="verdict-box-grid">
        <div className="verdict-box verdict-box--buy">
          <div className="verdict-box__count">{displayBuyCount}</div>
          <div className="verdict-box__label">{isBuySuppressed ? '停止中' : '買い候補'}</div>
        </div>
        <div className="verdict-box verdict-box--hold">
          <div className="verdict-box__count">{holdList.length}</div>
          <div className="verdict-box__label">様子見</div>
        </div>
        <div className="verdict-box verdict-box--sell">
          <div className="verdict-box__count">{sellList.length}</div>
          <div className="verdict-box__label">売却/縮小</div>
        </div>
      </div>

      {/* officialDecision 根拠リスト */}
      {officialDecision != null && officialDecision.rationale.length > 0 && (
        <ul className="market-mode-banner__rationale">
          {officialDecision.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {/* データ品質ゲートバナー（新規BUY抑制中） */}
      {isDqSuppressed && (
        <div className="no-trade-banner" style={{ background: colors.waitBg, borderColor: colors.waitBorder }}>
          <span>📡</span>
          <span>データ品質低下 — {dq.reason}</span>
        </div>
      )}

      {/* ノートレードバナー */}
      {displayNoTrade && !isDqSuppressed && (
        <div className="no-trade-banner">
          <span>⚠</span>
          <span>ノートレード推奨: {displayNoTradeText}</span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// B. 今日のToDoカード
// ─────────────────────────────────────────────────────────────

interface TodoItem {
  priority: 'high' | 'medium' | 'low'
  text: string
  cond?: string
}

function TodoCard() {
  const buyList          = useAppStore(selectBuyList)
  const sellList         = useAppStore(selectSellList)
  const market           = useAppStore(s => s.market)
  const sqCalendar       = useAppStore(s => s.sqCalendar)
  const trust            = useAppStore(s => s.trust)
  const holdings         = useAppStore(s => s.holdings)
  const dq               = useAppStore(selectMarketDataQuality)
  const officialDecision = useAppStore(s => s.officialDecision)
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive   = useAppStore(selectEffectiveSafeModeActive)

  const todos: TodoItem[] = []

  if (officialDecision != null) {
    // P1-3C: officialDecision.actions を主要ソースとして使用（BUY は dataQualitySuppressed または safeModeActive 時に除外）
    // P2-A: isCandidate=true の未保有候補は TodoCard から除外し CandidateCard に分離
    // P4-A134: safeModeActive も BUY 抑制条件に追加（TodayJudgmentCard/TopCandidatesCard と統一）
    // P4-A143: 共通ゲートに統一し、実時間dq.isSuppressedも考慮
    const shouldSuppressBuy = computeBuyDisplaySuppressed(officialDecision.dataQualitySuppressed, dq.isSuppressed, safeModeActive)
    const actions = shouldSuppressBuy
      ? officialDecision.actions.filter(a => a.action !== 'BUY' && !a.isCandidate)
      : officialDecision.actions.filter(a => !a.isCandidate)
    actions.slice(0, 3).forEach(item => {
      const priority: TodoItem['priority'] =
        item.action === 'SELL'                                  ? 'high'   :
        item.action === 'BUY'                                   ? 'medium' :
        item.action === 'BLOCKED' || item.action === 'DATA_WAIT' ? 'medium' : 'low'
      todos.push({
        priority,
        text: `${item.name}${item.code ? ` (${item.code})` : ''} — ${item.reason}`,
        cond: item.blockedReason,
      })
    })
    if (officialDecision.dataQualitySuppressed) {
      todos.push({
        priority: 'medium',
        text: 'データ更新待ち — データ品質低下のため新規買いを抑制中',
        cond: '最新データが取得されてから判断する',
      })
    }
  } else {
    // Fallback: 既存ロジック（officialDecision が null の場合）
    if (sellList.length > 0) {
      const top = sellList[0]
      const topHolding = holdings.find(h => h.code === top.code)
      const locked   = topHolding ? isSellLocked(topHolding) : false
      const lockDate = topHolding ? getSellableDate(topHolding) : null
      if (locked) {
        todos.push({
          priority: 'medium',
          text: `ロック解除後に削減候補: ${top.code}（解除日: ${lockDate ?? '不明'}）`,
          cond: 'ロック期間中は売却不可。解除後に改めて判断する',
        })
      } else {
        todos.push({
          priority: 'high',
          text: `売却確認: ${top.code} — スコア${top.totalScore}でSELLシグナル`,
          cond: '損切ライン・利確条件を再確認してから執行する',
        })
      }
    }

    const sqDays = sqCalendar?.nextSQ?.dayUntil ?? 999
    if (sqDays <= 5) {
      todos.push({
        priority: 'high',
        text: `SQ接近警戒: ${sqCalendar?.nextSQ?.date} まで残${sqDays}営業日`,
        cond: '先物絡みのポジション・投信売買は慎重に',
      })
    }

    if (market.vix >= 25) {
      todos.push({
        priority: 'high',
        text: `高ボラ状態: VIX ${market.vix.toFixed(1)} — 新規エントリーは見送り推奨`,
        cond: 'VIX 20以下になったら再判断する',
      })
    }

    // P4-A157: safeModeActive単独でも「買い候補確認」ToDoが漏れないよう、DQ抑制と同列でゲートする
    if (safeModeActive) {
      todos.push({
        priority: 'medium',
        text: 'SAFE_MODE発動中 — 新規買付停止中',
        cond: 'SAFE_MODE解除後に判断する',
      })
    } else if (dq.isSuppressed) {
      todos.push({
        priority: 'medium',
        text: `データ更新待ち — データが${dq.level === 'static' ? '更新失敗' : dq.level === 'error' ? 'エラー状態' : '更新期限超過'}のため新規買いを抑制中`,
        cond: '最新データが取得されてから判断する',
      })
    } else if (buyList.length > 0 && sellList.length === 0) {
      const top = buyList[0]
      todos.push({
        priority: 'medium',
        text: `買い候補確認: ${top.code} — スコア${top.totalScore}でBUYシグナル`,
        cond: '3ヶ月制約・分散状況・待機資金を確認してから判断する',
      })
    }

    const jpTrust = trust.filter(t => t.policy === 'JAPAN_SHORTTERM')
    if (jpTrust.length > 0) {
      todos.push({
        priority: 'medium',
        text: `国内株投信チェック: ${jpTrust.length}本 — 地合いと短期シグナルを確認`,
        cond: '日経・VIの方向感が揃ってから判断する',
      })
    }

    todos.push({
      priority: 'low',
      text: '朝の相場確認: 日経・VIX・ドル円の動向を把握する',
      cond: '前日比±2%超の動きがあれば詳細分析を優先する',
    })
  }

  const displayTodos = todos.slice(0, 5)
  // T0-CC-3: first viewでは上位2件のみ全文表示し、残りは「他N件」に圧縮する。
  // todos自体の生成・件数は変更しない。表示件数のみの調整。
  const FIRST_VIEW_VISIBLE_COUNT = 2
  const collapsedTodos = displayTodos.slice(0, FIRST_VIEW_VISIBLE_COUNT)
  const hiddenCount    = displayTodos.length - collapsedTodos.length

  // T0-CC-5(F2): 「ほかN件」を展開/折りたたみできるようにする表示専用トグル。
  // todos生成・優先度・順序には一切影響しない。
  const [isExpanded, setIsExpanded] = useState(false)
  const visibleTodos = isExpanded ? displayTodos : collapsedTodos

  return (
    <div className="card">
      <SectionTitle icon="✅" title="今日のToDo" />
      <div className="todo-list">
        {visibleTodos.map((item, i) => (
          <div key={i} className={`todo-item todo-item--${item.priority}`}>
            <PriorityBadge priority={item.priority} />
            <div>
              <div className="todo-item__text">{item.text}</div>
              {item.cond && <div className="todo-item__cond">条件: {item.cond}</div>}
            </div>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setIsExpanded(v => !v)}
            style={{
              display: 'block', width: '100%',
              fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              textAlign: 'center', padding: '8px 0',
            }}
          >
            {isExpanded ? '折りたたむ ▴' : `ほか${hiddenCount}件を表示 ▾`}
          </button>
        )}
        {displayTodos.length === 0 && (
          <div className="home-card-empty">
            現時点で特別なアクションは不要です。現状維持で監視を続けてください。
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// B-safe. SAFE_MODE / TierA 運用状態カード（P4-A27: T0でもsilentに消えないように）
// ─────────────────────────────────────────────────────────────

function SafeModeCard() {
  const safeMode        = useAppStore(s => s.safeMode)
  const tierAViolations = useAppStore(s => s.tierAViolations)
  const tierAAlerts     = useAppStore(s => s.tierAAlerts)
  const system          = useAppStore(s => s.system)
  // P4-A150: TierA T1（含み損-40%以下）frontend検出。自動売却は行わない
  const holdings        = useAppStore(s => s.holdings)
  const tierAT1Violations = checkTierAT1Violations(holdings)
  return (
    <SafeModeStatusCard
      safeMode={safeMode}
      safeModeSource={system.dataSourceStatus.safeMode}
      safeModeLastChecked={system.dataTimestamps?.safeMode}
      tierAViolations={tierAViolations}
      tierAAlerts={tierAAlerts}
      tierAT1Violations={tierAT1Violations}
    />
  )
}

// A'. システム状態バー（T0-CC-1: 今日の判断前に確認する状態サマリー）
// ─────────────────────────────────────────────────────────────
// 表示専用。既存selector（selectEffectiveSafeModeActive / selectSafeModeDataQuality /
// selectMarketDataQuality / selectCashAssumptionsFreshness / officialDecision.noTrade）
// の読み取り結果を並べるだけで、gateや判定ロジックは新設しない。

export interface SystemStatusInput {
  safeModeRaw: boolean
  safeModeDataStale: boolean
  safeModeActive: boolean
  dqSuppressed: boolean
  noTrade: boolean
  cashStale: boolean
  holdingsStale: boolean
}

export interface SystemStatusResult {
  notices: string[]
  hasWarning: boolean
  isSevere: boolean
}

// P4.5-A013-T6a: SystemStatusBarのnotices/hasWarning/isSevere算出を純関数として抽出。
// componentレンダリングなしで直接テストできるようにするだけで、条件式自体は変更しない。
export function computeSystemStatusNotices(input: SystemStatusInput): SystemStatusResult {
  const notices: string[] = []
  if (input.safeModeRaw)       notices.push('🛑 SAFE_MODE中 — 新規買付停止')
  if (input.safeModeDataStale) notices.push('⚠ SAFE_MODEデータ古い — 安全側停止中')
  if (input.dqSuppressed)      notices.push('📡 データ品質低下 — 新規買い停止中')
  if (input.noTrade)           notices.push('⚠ ノートレード推奨')
  if (input.cashStale)         notices.push('💴 資金前提が古い可能性 — 金額は参考値')
  if (input.holdingsStale)     notices.push('📦 保有データが古い可能性 — CSV再取込/snapshot同期を推奨')

  const hasWarning = input.safeModeActive || input.dqSuppressed || input.noTrade || input.cashStale || input.holdingsStale
  // T0-CC-5(F1): 警告時は平常時より弱く見えないよう、wait/sell系の背景・枠線・文字色で強調する。
  const isSevere = input.safeModeActive || input.dqSuppressed

  return { notices, hasWarning, isSevere }
}

function SystemStatusBar() {
  const officialDecision = useAppStore(s => s.officialDecision)
  const dq             = useAppStore(selectMarketDataQuality)
  const safeModeRaw     = useAppStore(s => s.safeMode.safe_mode.active)
  const safeModeDq      = useAppStore(selectSafeModeDataQuality)
  // 全体の警告有無判定は既存の統一ゲートに揃える（P4.5-A011と同じ式）
  const safeModeActive  = useAppStore(selectEffectiveSafeModeActive)
  const cashFreshness   = useAppStore(selectCashAssumptionsFreshness)
  const system          = useAppStore(s => s.system)
  const noTrade         = officialDecision?.noTrade ?? false
  // P4.5-A013-T6: 保有株/投信のlocalStorage鮮度（表示専用・投資判断ロジックには使わない）。
  // P4.5-A012dの方針を変更せず、staleでも値は捨てず警告のみ追加する。
  const holdingsStale   = computeHoldingsStale(system)

  const { notices, hasWarning, isSevere } = computeSystemStatusNotices({
    safeModeRaw,
    safeModeDataStale: safeModeDq.isStale,
    safeModeActive,
    dqSuppressed: dq.isSuppressed,
    noTrade,
    cashStale: cashFreshness.isStale,
    holdingsStale,
  })

  if (!hasWarning) {
    return (
      <div className="card" style={{ padding: '8px 12px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: colors.buyText }}>
          ✓ 判断可能
        </span>
      </div>
    )
  }

  const bg     = isSevere ? colors.sellBg     : colors.waitBg
  const border = isSevere ? colors.sellBorder : colors.waitBorder
  const text   = isSevere ? colors.sellText   : colors.waitText

  return (
    <div className="card" style={{ padding: '8px 12px', background: bg, border: `1px solid ${border}` }}>
      <div style={{ fontSize: '12px', fontWeight: 700, color: text, lineHeight: 1.5 }}>
        {notices.join('　')}
      </div>
    </div>
  )
}

// B'. 新規候補カード（未保有投信の発掘候補）P2-A / P2-E安全化
// ─────────────────────────────────────────────────────────────

// P5-B003: portfolio(holdings) localStorageの鮮度が古い場合、株候補の
// headroom/保有除外が古いデータに基づいている可能性を表示専用で警告する。
// 判定ロジック（gate/score/headroom）自体は一切変更しない — 表示専用の注記。
export function isPortfolioSnapshotStale(system: { localStorageFreshness?: { portfolio: { isStale: boolean } } }): boolean {
  return system.localStorageFreshness?.portfolio.isStale ?? false
}

// P4.5-A013-T6a: 個別株・投信いずれかのlocalStorageが古い場合にtrueを返す
// （T0/T1共通の「保有データが古い可能性」警告に使う表示専用判定。投資判断ロジックは参照しない）。
export function computeHoldingsStale(system: {
  localStorageFreshness?: { portfolio: { isStale: boolean }; trust: { isStale: boolean } }
}): boolean {
  return (system.localStorageFreshness?.portfolio.isStale ?? false)
    || (system.localStorageFreshness?.trust.isStale ?? false)
}

// P5-B003: 候補カードのフッター誘導文言。投信候補はT7（投信管理）、株候補はT1（今日の判断）へ誘導する。
// 「投信候補」固定文言を株候補セクションに使わないための分岐。
export function candidateCardFooterText(assetKind: 'fund' | 'stock'): string {
  return assetKind === 'stock'
    ? '詳細はT1（今日の判断）で確認してください'
    : '詳細評価はT7（投信管理）で確認してください'
}

// CAND-SYN-1D / D13, D26: renders one canonical synthesis decision entry.
// The only amount ever shown is entry.money.executableAmountJpy, and only
// when money.kind === 'EXECUTABLE' (verbatim AllocationPlan value, no
// recalculation). Non-executable entries show a reason, never a legacy
// suggestedAmount/maxAmount/sizingTier figure.
function CandidateListItem({ entry }: { entry: CandidateDecisionSynthesisEntry }) {
  const nonExecutableReason = synthesisNonExecutableReasonText(entry)
  const heroScore = entry.candidateQuality.marketScore
  return (
    <div
      style={{
        padding: '10px 12px',
        marginBottom: '8px',
        borderRadius: '6px',
        background: 'var(--color-wait-bg)',
        borderLeft: '3px solid var(--color-wait-border)',
      }}
    >
      {/* 行1: バッジ + アセット種別 + 銘柄/ファンド名（折り返し許可） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <span className="badge badge--wait">
          {SYNTHESIS_ACTION_LABEL[entry.action]}
        </span>
        <AssetTypeBadge type={entry.assetClass === 'JP_STOCK' ? 'stock' : 'fund'} size="sm" />
        <span style={{ fontSize: '13px', fontWeight: 700, lineHeight: '1.3' }}>
          {entry.code ? `${entry.code} ` : ''}{entry.displayName}
        </span>
      </div>

      {/* 行2: 参考スコア hero数字 + 実行可能額（あれば） / 非実行理由 */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' }}>
        {typeof heroScore === 'number' && (
          <div style={{ textAlign: 'center', minWidth: 52 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: colors.waitText, lineHeight: 1 }}>
              {Math.round(heroScore)}
            </div>
            <div style={{ fontSize: 9, color: colors.textMuted }}>参考スコア</div>
          </div>
        )}
        {entry.money.kind === 'EXECUTABLE' && (
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: colors.waitText, lineHeight: 1 }}>
              {formatJPYAuto(entry.money.executableAmountJpy)}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
              実行可能額（AllocationPlan認可）
            </div>
          </div>
        )}
        {entry.money.kind !== 'EXECUTABLE' && nonExecutableReason !== null && (
          <div style={{ fontSize: '12px', color: 'var(--color-text-subtle)', lineHeight: '1.4' }}>
            {nonExecutableReason}
          </div>
        )}
      </div>
    </div>
  )
}

// CAND-SYN-1D / D13: T0 reads candidateDecisionSynthesis.decisions only —
// never candidatePortfolioRecommendations, never officialDecision's candidate
// compatibility component, never legacy CandidateItem/StockCandidateGateResult
// money fields. synthesis===null/unavailable/invalid fails closed (no legacy
// fallback); decisions.length===0 shows a no-action state, never nothing.
function CandidateCard() {
  const synthesis = useAppStore(selectCandidateDecisionSynthesis)
  const decisions = computeSynthesisDecisionsForDisplay(synthesis)
  const isUnavailable = synthesis === null || synthesis.status !== 'available'

  return (
    <div className="card">
      <SectionTitle icon="☆" title="候補（AllocationPlan認可）" />
      <div style={{ fontSize: '12px', color: 'var(--color-text-subtle)', marginBottom: '12px' }}>
        本日の実行判断候補です。実行可能額はAllocationPlanが唯一の権限です。
      </div>

      {isUnavailable && (
        <div className="home-card-empty">{candidateSynthesisUnavailableText(synthesis)}</div>
      )}
      {!isUnavailable && decisions.length === 0 && (
        <div className="home-card-empty">現在は実行可能な候補はありません。</div>
      )}
      {decisions.map(entry => <CandidateListItem key={entry.entryId} entry={entry} />)}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// C. 市場概況カード
// ─────────────────────────────────────────────────────────────

function MarketCard() {
  const market = useAppStore(s => s.market)
  const macro  = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)

  const items = [
    {
      label: '日経平均',
      value: market.nikkei.toLocaleString('ja-JP'),
      sub:   formatSignedPct(market.nikkeiChgPct),
      up:    market.nikkeiChgPct >= 0,
    },
    {
      label: 'VIX（恐怖指数）',
      value: market.vix.toFixed(1),
      sub:   macro ? formatPt(macro.vixChg, 2) : '—',
      up:    market.vix < 20,
      warn:  market.vix >= 25,
    },
    {
      label: 'ドル円',
      value: macro ? `${macro.usdjpy.toFixed(2)}円` : '—',
      sub:   macro ? formatSignedPct(macro.usdjpyChgPct) : '—',
      up:    macro ? macro.usdjpyChgPct >= 0 : true,
    },
    {
      label: 'S&P500',
      value: macro ? macro.sp500.toLocaleString('ja-JP') : '—',
      sub:   macro ? formatSignedPct(macro.sp500ChgPct) : '—',
      up:    macro ? macro.sp500ChgPct >= 0 : true,
    },
    {
      label: 'NASDAQ',
      value: macro ? macro.nasdaq.toLocaleString('ja-JP') : '—',
      sub:   macro ? formatSignedPct(macro.nasdaqChgPct) : '—',
      up:    macro ? macro.nasdaqChgPct >= 0 : true,
    },
    {
      label: '日経225 VI',
      value: macro ? macro.nikkeiVI.toFixed(1) : '—',
      sub:   macro ? formatPt(macro.nikkeiVIChg, 2) : '—',
      up:    macro ? macro.nikkeiVI < 20 : true,
      warn:  macro ? macro.nikkeiVI >= 25 : false,
    },
    {
      label: '米10年金利',
      value: macro ? `${macro.ust10y.toFixed(2)}%` : '—',
      sub:   '長期金利',
      up:    true,
    },
    {
      label: '金（ゴールド）',
      value: macro ? `$${macro.gold.toLocaleString('ja-JP')}/oz` : '—',
      sub:   macro ? formatSignedPct(macro.goldChgPct) : '—',
      up:    macro ? macro.goldChgPct >= 0 : true,
    },
    {
      label: 'NY原油',
      value: macro ? `$${macro.nyCrude.toFixed(1)}/bbl` : '—',
      sub:   macro ? formatSignedPct(macro.nyCrudeChgPct) : '—',
      up:    macro ? macro.nyCrudeChgPct >= 0 : true,
    },
  ]

  return (
    <div className="card">
      <SectionTitle icon="🌐" title="市場概況" />
      <div className="metric-grid">
        {items.map(item => (
          <div key={item.label} className={`metric-item${(item as {warn?: boolean}).warn ? ' metric-item--warn' : ''}`}>
            <div className="metric-item__label">{item.label}</div>
            <div className={`metric-item__value${item.up ? ' up' : ' down'}`}>{item.value}</div>
            <div className="metric-item__sub">{item.sub}</div>
          </div>
        ))}
      </div>

      {sqCalendar?.nextSQ && (
        <div className="home-info-row">
          <span className="home-info-row__label">
            次回SQ: <strong>{sqCalendar.nextSQ.date}</strong>（{sqCalendar.nextSQ.type === 'quarterly' ? '先物・オプション清算' : '月次SQ'}）
          </span>
          <span className="home-sq-days" style={{
            color: sqCalendar.nextSQ.dayUntil <= 3 ? 'var(--color-sell-text)' :
                   sqCalendar.nextSQ.dayUntil <= 7 ? 'var(--color-wait-text)' :
                   'var(--color-text-subtle)',
          }}>
            残{sqCalendar.nextSQ.dayUntil}営業日
          </span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// P4.5-A004: 重要マーケットニュース（参考情報 — T0では件数を絞って表示）
// news.marketNews を重要度順にソートし、上位のみ表示。日本語フィールド
// （titleJa/summaryJa）があれば優先し、なければ原文をfallback表示する。
// 新しい判断ロジック・翻訳APIは追加しない。
// ─────────────────────────────────────────────────────────────

function MarketNewsCard() {
  const news = useAppStore(s => s.news)
  const marketNews = news?.marketNews ?? []
  if (marketNews.length === 0) return null

  const topNews = [...marketNews]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, NEWS_DISPLAY_LIMITS.T0_HOME)

  return (
    <div className="card">
      <SectionTitle icon="📰" title="重要マーケットニュース" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
        {topNews.map(item => {
          const { title, isUntranslated } = resolveNewsDisplayText(item)
          return (
            <div key={item.id} style={{ paddingBottom: spacing[2], borderBottom: `1px solid ${colors.borderSubtle}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: spacing[1.5], flexWrap: 'wrap' }}>
                {isUntranslated && (
                  <span style={{
                    ...typography.caption, fontWeight: 700,
                    color: colors.textMuted, border: `1px solid ${colors.borderSubtle}`,
                    borderRadius: radius.sm, padding: `0 ${spacing[1]}`, flexShrink: 0,
                  }}>
                    海外記事
                  </span>
                )}
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ ...typography.bodySmall, fontWeight: 600, color: colors.textPrimary }}>
                    {title}
                  </a>
                ) : (
                  <span style={{ ...typography.bodySmall, fontWeight: 600, color: colors.textPrimary }}>{title}</span>
                )}
              </div>
              <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[0.5] }}>
                {item.source} · {formatDateTime(item.publishedAt)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// P4-A135: 最大配分乖離ストリップ（ファーストビューで最も大きい乖離を1行表示）
// universe.categories の既存値のみ使用。新ロジック・閾値なし。
// ─────────────────────────────────────────────────────────────

function AllocationGapStrip() {
  const universe = useAppStore(s => s.universe)
  const setTab   = useAppStore(s => s.setTab)

  if (!universe || universe.categories.length === 0) return null

  // Math.abs(diffRatio) 最大のカテゴリを表示専用で算出
  const maxGap = universe.categories.reduce((max, c) =>
    Math.abs(c.diffRatio) > Math.abs(max.diffRatio) ? c : max
  )

  const isShort   = maxGap.diffRatio > 0  // 不足（現在 < 目標）
  const ptDiffStr = formatPt(maxGap.diffRatio * 100)
  const direction = isShort ? '不足' : '過剰'
  const mainColor = isShort ? colors.buyText   : colors.waitText
  const bgColor   = isShort ? colors.buyBg     : colors.waitBg
  const bdColor   = isShort ? colors.buyBorder : colors.waitBorder

  return (
    <div
      className="home-allocation-gap-strip"
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '6px 12px',
        background: bgColor,
        borderLeft: `3px solid ${bdColor}`,
        borderRadius: '6px',
        fontSize: '12px',
        marginBottom: '4px',
        cursor: 'pointer',
      }}
      onClick={() => setTab('T4')}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab('T4') } }}
      title="T4（理想PF）で詳細を確認"
      role="button"
      tabIndex={0}
    >
      <span style={{ color: colors.textSubtle, flexShrink: 0 }}>最大乖離</span>
      <span style={{ fontWeight: 700, color: colors.textPrimary, flexShrink: 0 }}>{maxGap.label}</span>
      <span style={{ fontWeight: 700, color: mainColor, flexShrink: 0 }}>{ptDiffStr}</span>
      <span style={{ color: colors.textMuted, flexShrink: 0 }}>
        現在{(maxGap.currentRatio * 100).toFixed(1)}% → 目標{(maxGap.targetRatio * 100).toFixed(1)}%
      </span>
      <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
        <span style={{
          fontSize: '10px', fontWeight: 700, color: mainColor,
          padding: '1px 6px', borderRadius: '8px',
          background: bgColor, border: `1px solid ${bdColor}`,
        }}>{direction}</span>
        <span style={{ fontSize: '10px', color: colors.textMuted, marginLeft: '4px' }}>→ T4</span>
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// D. 資産別サマリー
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// P4-A96: 総資産ミニバー（TodayJudgmentCard直後・ファーストビュー近く）
// 既存selector/storeを再利用。ロジック追加なし。
// ─────────────────────────────────────────────────────────────

function AssetSnapshotMini() {
  const totalEval   = useAppStore(selectTotalEval)
  const totalPnl    = useAppStore(selectTotalPnl)
  const trustTotal  = useAppStore(selectTrustTotalEval)
  const effectiveCash = useAppStore(selectEffectiveCashAssumptions)

  // CASH-AUTH-1: 総現金を一度だけ加算する（addRoom は撤廃済み）
  const total = totalEval + trustTotal + effectiveCash.cashTotal
  if (total <= 0) return null

  return (
    <div className="asset-snapshot-bar">
      <span className="asset-snapshot-bar__label">総資産（概算）</span>
      <span className="asset-snapshot-bar__total">{formatJPYAuto(total)}</span>
      <span className="asset-snapshot-bar__sep">·</span>
      <span className="asset-snapshot-bar__label">含み損益</span>
      <span className={`asset-snapshot-bar__pnl ${totalPnl >= 0 ? 'up' : 'down'}`}>
        {formatSignedJPY(totalPnl)}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CASH-AUTH-1: 現金権限の読み取り専用サマリー（T0）。
// 編集はできない — 変更は T9「現金権限」でのみ行う。
// 「OSが今いくらを投資可能現金として見ているか / その元データはいつ更新したか /
//  何円を安全余力として除外しているか」を1枚で確認できるようにする。
// ─────────────────────────────────────────────────────────────
function CashAuthoritySummaryCard() {
  const authority = useAppStore(selectCashAuthorityView)
  // CASH-AUTH-1 R2: 「投資可能現金」は canonical AllocationPlanSnapshot（deriveCashModel）
  // からのみ読む — cashBaseLimit（現金のみの上限）を実行可能額として表示しない。
  // holdings/crossTab の safety state はここでは一切再計算しない。
  const executable = useAppStore(selectExecutableDeployableCash)
  const setTab = useAppStore(s => s.setTab)

  const unavailable = authority.source !== 'MANUAL'
  const stale = !unavailable && authority.freshness.state === 'stale'
  // 現金権限自体は fresh で参照現金も正なのに、canonical snapshot が
  // 利用できない（未計算・stale・invalid）ため 0 として扱われているケース。
  // grossCash=0（confirmed zero）はここに含めない — その 0 は現金側の事実であり、
  // 配分計算の制限による 0 ではないため。
  const allocationRestricted =
    !unavailable && !stale && !executable.available && authority.referenceGrossCash > 0

  return (
    <div className="card" data-testid="t0-cash-authority-summary">
      <SectionTitle icon="💴" title="現金権限" />

      <div className="home-info-row">
        <span className="home-info-row__label">総現金{stale ? '（参考値）' : ''}</span>
        <span className="home-info-row__total" data-testid="t0-cash-authority-gross">
          {unavailable ? '未設定' : formatJPYAuto(authority.referenceGrossCash)}
        </span>
      </div>

      <div className="home-info-row">
        <span className="home-info-row__label">投資可能現金</span>
        <span className="home-info-row__total" data-testid="t0-cash-authority-deployable">
          {formatJPYAuto(executable.amount)}
        </span>
      </div>

      <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
        {unavailable ? (
          <span data-testid="t0-cash-authority-state">
            現金未設定（0円と確認済みの状態とは異なります）— 買付の提案は行われません
          </span>
        ) : stale ? (
          <span data-testid="t0-cash-authority-state" style={{ color: colors.waitText, fontWeight: 600 }}>
            ⚠ 期限切れ（168時間超）— 表示金額は参考値で、買付の提案は行われません
          </span>
        ) : allocationRestricted ? (
          <span data-testid="t0-cash-authority-state" style={{ color: colors.waitText, fontWeight: 600 }}>
            ⚠ 配分計算が未反映のため投資可能現金は0円として扱われます
            {executable.unavailableStatus === 'absent' ? '（未計算）' : '（再計算が必要）'}
          </span>
        ) : authority.freshness.approachingExpiry ? (
          <span data-testid="t0-cash-authority-state" style={{ color: colors.waitText, fontWeight: 600 }}>
            ⚠ まもなく有効期限（168時間）— 最終更新 {formatRelativeTime(authority.updatedAt ?? '')}
          </span>
        ) : (
          <span data-testid="t0-cash-authority-state">
            {authority.confirmedZero ? '0円を確認済み' : '最新'}
            {authority.updatedAt ? ` — 最終更新 ${formatRelativeTime(authority.updatedAt)}` : ''}
          </span>
        )}
      </div>

      {!unavailable && (
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
          生活・安全余力として除外: {formatJPYAuto(authority.referenceSafetyReserve)}
          {authority.referencePendingOrderCash === null
            ? '／未約定の買付注文は不明'
            : `／未約定の買付注文に確保済み: ${formatJPYAuto(authority.referencePendingOrderCash)}`}
        </div>
      )}

      <button
        className="home-nav-cta__btn"
        type="button"
        data-testid="t0-cash-authority-edit-link"
        onClick={() => setTab('T9')}
        style={{ marginTop: spacing[2] }}
      >
        {unavailable ? '現金を設定' : '設定で現金権限を編集'}
      </button>
    </div>
  )
}

function AssetSummaryCard() {
  const holdings     = useAppStore(s => s.holdings)
  const trust        = useAppStore(s => s.trust)
  const effectiveCash = useAppStore(selectEffectiveCashAssumptions)
  const cashFreshness = useAppStore(selectCashAssumptionsFreshness)
  const totalEval    = useAppStore(selectTotalEval)
  const totalPnl     = useAppStore(selectTotalPnl)
  const trustTotal   = useAppStore(selectTrustTotalEval)

  const jpTrust = trust.filter(t => t.policy === 'JAPAN_SHORTTERM')
  const overseasTrust = trust.filter(t => t.policy === 'OVERSEAS_LONGTERM')
  const goldTrust = trust.filter(t => t.policy === 'GOLD')

  const jpTrustEval = jpTrust.reduce((sum, t) => sum + t.eval, 0)
  const overseasEval = overseasTrust.reduce((sum, t) => sum + t.eval, 0)
  const goldEval = goldTrust.reduce((sum, t) => sum + t.eval, 0)
  // CASH-AUTH-1: 総現金のみを一度だけ計上する（addRoom は撤廃済み）
  const totalCash = effectiveCash.cashTotal

  const total = totalEval + trustTotal + totalCash

  function ratio(v: number) {
    return total > 0 ? ` (${((v / total) * 100).toFixed(1)}%)` : ''
  }

  return (
    <div className="card">
      <SectionTitle icon="💼" title="資産別サマリー" />

      <div className="asset-summary">
        <div className="asset-summary__item asset-summary__item--stock">
          <div className="asset-summary__label">📈 個別株</div>
          <div className="asset-summary__value">{formatJPYAuto(totalEval)}</div>
          <div className="asset-summary__sub">
            含み{formatSignedJPY(totalPnl)}{ratio(totalEval)}
          </div>
          <div className="asset-summary__sub">{holdings.length}銘柄保有</div>
        </div>

        <div className="asset-summary__item asset-summary__item--jp-fund">
          <div className="asset-summary__label">🇯🇵 国内株投信</div>
          <div className="asset-summary__value">{formatJPYAuto(jpTrustEval)}</div>
          <div className="asset-summary__sub">{jpTrust.length}本{ratio(jpTrustEval)}</div>
          <div className="asset-summary__sub">超短期回転向け</div>
        </div>

        <div className="asset-summary__item asset-summary__item--global">
          <div className="asset-summary__label">🌍 海外投信・金</div>
          <div className="asset-summary__value">{formatJPYAuto(overseasEval + goldEval)}</div>
          <div className="asset-summary__sub">{overseasTrust.length + goldTrust.length}本{ratio(overseasEval + goldEval)}</div>
          <div className="asset-summary__sub">中長期配分向け</div>
        </div>

        <div className="asset-summary__item asset-summary__item--cash">
          <div className="asset-summary__label">
            💴 現金
            {effectiveCash.source === 'manual' && (
              <span style={{ ...typography.caption, color: colors.textMuted, marginLeft: spacing[1] }}>
                （手動入力値）
              </span>
            )}
          </div>
          <div className="asset-summary__value">{formatJPYAuto(totalCash)}</div>
          <div className="asset-summary__sub">
            総現金: {formatJPYAuto(effectiveCash.grossCash)}{ratio(totalCash)}
          </div>
          <div className="asset-summary__sub">
            うち生活・安全余力: {formatJPYAuto(effectiveCash.safetyReserve)}
          </div>
          {/* CASH-AUTH-1: 未設定（unknown）と失効（stale）を区別して表示する */}
          {effectiveCash.source !== 'manual' && (
            <div className="asset-summary__sub" style={{ color: colors.textMuted, fontWeight: 600 }}>
              現金未設定
            </div>
          )}
          {effectiveCash.source === 'manual' && cashFreshness.isStale && (
            <div className="asset-summary__sub" style={{ color: colors.waitText, fontWeight: 600 }}>
              ⚠ 現金情報が期限切れ（参考値）
            </div>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="home-info-row">
          <span className="home-info-row__label">合計</span>
          <span className="home-info-row__total">{formatJPYAuto(total)}</span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// UI-9-3: ポートフォリオ ドーナツカード（実データのみ）
// ─────────────────────────────────────────────────────────────

function PortfolioDonutCard() {
  const holdings    = useAppStore(s => s.holdings)
  const trust       = useAppStore(s => s.trust)
  const effectiveCash = useAppStore(selectEffectiveCashAssumptions)
  const stockEval   = useAppStore(selectTotalEval)
  const jpEval      = useAppStore(selectJpFundTotalEval)
  const globalEval  = useAppStore(selectGlobalFundTotalEval)
  const totalPnl    = useAppStore(selectTotalPnl)
  // CASH-AUTH-1: 総現金のみ（addRoom は撤廃済み）
  const totalCash   = effectiveCash.cashTotal
  const total       = stockEval + jpEval + globalEval + totalCash

  if (total <= 0) return null

  const pct = (v: number) => total > 0 ? ((v / total) * 100).toFixed(1) : '0.0'

  const segments = [
    { ratio: stockEval,  color: colors.stockAccent,      label: '個別株',    val: stockEval  },
    { ratio: jpEval,     color: colors.jpFundAccent,     label: '国内投信',  val: jpEval     },
    { ratio: globalEval, color: colors.globalFundAccent, label: '海外投信',  val: globalEval },
    { ratio: totalCash,  color: '#94a3b8',               label: '現金等',    val: totalCash  },
  ]

  return (
    <div className="card">
      {/* 総資産 — P4-A136: AssetSnapshotMini（上部）との重複を避けラベルを差別化 */}
      <div>
        <div className="dash-total-label">合計評価額（内訳）</div>
        <div className="dash-total-value">{formatJPYAuto(total)}</div>
        <div className="dash-total-sub">
          含み損益 {formatSignedJPY(totalPnl)}
          &nbsp;·&nbsp;{holdings.length}銘柄 + 投信{trust.length}本
        </div>
      </div>

      {/* Donut + legend */}
      <div className="dash-donut-wrap">
        <DonutChart segments={segments} />
        <div className="dash-donut-legend">
          {segments.map(s => s.val > 0 && (
            <div key={s.label} className="dash-donut-legend-item">
              <span className="dash-donut-legend-dot" style={{ background: s.color }} />
              <span className="dash-donut-legend-label">{s.label}</span>
              <span className="dash-donut-legend-pct">{pct(s.val)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// UI-9-3: 保有銘柄プレビュー（上位5件）
// ─────────────────────────────────────────────────────────────

function HoldingPreviewCard() {
  const holdings = useAppStore(s => s.holdings)
  const dq       = useAppStore(selectMarketDataQuality)
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive = useAppStore(selectEffectiveSafeModeActive)
  const officialDecision = useAppStore(s => s.officialDecision)
  // P4-A153: TopCandidatesCard等と同じ共通ゲートでBUY表示のみ抑制する
  const isBuySuppressed = computeBuyDisplaySuppressed(officialDecision?.dataQualitySuppressed ?? false, dq.isSuppressed, safeModeActive)

  if (holdings.length === 0) return null

  // SELL 優先、次に評価額降順
  const sorted = [...holdings]
    .sort((a, b) => {
      if (a.decision === 'SELL' && b.decision !== 'SELL') return -1
      if (b.decision === 'SELL' && a.decision !== 'SELL') return 1
      return b.eval - a.eval
    })
    .slice(0, 5)

  return (
    <div className="card">
      <SectionTitle icon="📈" title="保有銘柄" />
      <div className="dash-preview-list">
        {sorted.map(h => (
          <div key={h.code} className="dash-preview-item">
            <div className="dash-preview-item__code">{h.code}</div>
            <div className="dash-preview-item__name">{h.name}</div>
            <div className="dash-preview-item__eval">{formatJPYAuto(h.eval)}</div>
            <div className={`dash-preview-item__pnl dash-preview-item__pnl--${h.pnlPct >= 0 ? 'pos' : 'neg'}`}>
              {formatSignedPct(h.pnlPct)}
            </div>
            {/* P4-A134: SELL+ロック中はロックバッジを優先表示（3ヶ月制約中に「売り」指示と誤認させない） */}
            {h.decision === 'SELL' && isSellLocked(h)
              ? <span className="badge badge--hold" title={`売却ロック中 / 解除: ${getSellableDate(h) ?? '不明'}`}>🔒 ロック中</span>
              : <SignBadge decision={suppressBuyDecision(h.decision, isBuySuppressed)} />
            }
          </div>
        ))}
        {holdings.length > 5 && (
          <div className="dash-preview-more">他 {holdings.length - 5} 銘柄</div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// UI-9-3: 保有投信プレビュー（上位5件）
// ─────────────────────────────────────────────────────────────

function FundPreviewCard() {
  const trust = useAppStore(s => s.trust)
  const dq       = useAppStore(selectMarketDataQuality)
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive = useAppStore(selectEffectiveSafeModeActive)
  const officialDecision = useAppStore(s => s.officialDecision)
  // P4-A153: HoldingPreviewCard等と同じ共通ゲートでBUY表示のみ抑制する
  const isBuySuppressed = computeBuyDisplaySuppressed(officialDecision?.dataQualitySuppressed ?? false, dq.isSuppressed, safeModeActive)

  if (trust.length === 0) return null

  const sorted = [...trust].sort((a, b) => b.eval - a.eval).slice(0, 5)

  return (
    <div className="card">
      <SectionTitle icon="🏦" title="保有投信" />
      <div className="dash-preview-list">
        {sorted.map(t => (
          <div key={t.id} className="dash-preview-item">
            <div className="dash-preview-item__code dash-preview-item__code--abbr">{t.abbr}</div>
            <div className="dash-preview-spacer" />
            <div className="dash-preview-item__eval">{formatJPYAuto(t.eval)}</div>
            <div className={`dash-preview-item__pnl dash-preview-item__pnl--${t.dayPct >= 0 ? 'pos' : 'neg'}`}>
              {formatSignedPct(t.dayPct)}
            </div>
            <SignBadge decision={suppressBuyDecision(t.decision, isBuySuppressed)} />
          </div>
        ))}
        {trust.length > 5 && (
          <div className="dash-preview-more">他 {trust.length - 5} 本</div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// E. 理想PF差分カード
// ─────────────────────────────────────────────────────────────

function IdealPfCard() {
  const universe        = useAppStore(s => s.universe)
  const buyList         = useAppStore(selectBuyList)
  const sellList        = useAppStore(selectSellList)
  const holdings        = useAppStore(s => s.holdings)
  const dq              = useAppStore(selectMarketDataQuality)
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive = useAppStore(selectEffectiveSafeModeActive)
  const officialDecision = useAppStore(s => s.officialDecision)
  // P4-A134: TodayJudgmentCard/TopCandidatesCard と同じ抑制条件に統一
  // P4-A143: 共通ゲートに統一し、officialDecision.dataQualitySuppressedも考慮
  const isBuySuppressed  = computeBuyDisplaySuppressed(officialDecision?.dataQualitySuppressed ?? false, dq.isSuppressed, safeModeActive)
  // P4-A134: ロック中銘柄を売却候補から除外（3ヶ月制約中に名指しで売却示唆しない）
  const unlockedSellList = sellList.filter(s => {
    const h = holdings.find(hh => hh.code === s.code)
    return h ? !isSellLocked(h) : true
  })

  if (!universe) {
    return (
      <div className="card">
        <SectionTitle icon="⚖️" title="理想PF / 差分" />
        <div className="home-card-empty">
          理想PFデータを計算中です。分析を実行してから確認してください。
        </div>
      </div>
    )
  }

  // クラス別バーカラー（表示専用）
  const CLASS_BAR_COLOR: Partial<Record<string, string>> = {
    JP_STOCK:       colors.stockAccent,
    JP_TRUST:       colors.jpFundAccent,
    OVERSEAS_TRUST: colors.globalFundAccent,
    GOLD:           colors.gold,
    CASH:           '#94a3b8',
    CASH_RESERVE:   '#94a3b8',
    ADD_ROOM:       '#94a3b8',
  }

  const categories = universe.categories.map(c => ({
    name:         c.class,
    label:        c.label,
    targetRatio:  c.targetRatio * 100,     // %値
    currentRatio: c.currentRatio * 100,    // %値
    diff:         c.diffRatio * 100,       // %pt差分（+:不足 / -:過剰）
    diffValue:    c.diffValue,             // 金額差分（表示専用）
  }))

  const addCandidates    = categories.filter(c => c.diff > 3)
  const reduceCandidates = categories.filter(c => c.diff < -3)

  return (
    <div className="card">
      <SectionTitle icon="⚖️" title="理想PF / 配分サマリー" />

      {/* P4-A132: 資産配分ミニサマリー（2色横バー比較 / 表示専用） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2], marginBottom: spacing[4] }}>
        {categories.map(c => {
          // max比正規化（T4パターン / 現在・目標の大きい方を100%として正規化）
          const maxR       = Math.max(c.currentRatio, c.targetRatio, 1)
          const currentPct = Math.min(100, Math.round((c.currentRatio / maxR) * 100))
          const targetPct  = Math.min(100, Math.round((c.targetRatio  / maxR) * 100))
          const isOver     = c.diff < -1  // 現在 > 目標（過剰）
          const accentColor = CLASS_BAR_COLOR[c.name] ?? '#94a3b8'
          const barColor    = isOver ? colors.wait : accentColor
          const ptDiffStr   = formatPt(c.diff)
          const ptColor     = c.diff > 3 ? colors.buyText : c.diff < -3 ? colors.waitText : colors.textMuted

          return (
            <div key={c.name} style={{
              padding: `${spacing[2]} ${spacing[3]}`,
              borderLeft: `3px solid ${barColor}`,
            }}>
              {/* ヘッダー: クラス名 + ptDiff */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing[1] }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: colors.textPrimary }}>{c.label}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: ptColor }}>{ptDiffStr}</span>
                  {Math.abs(c.diffValue) >= 10000 && (
                    <span style={{ fontSize: '10px', color: c.diffValue > 0 ? colors.buyText : colors.waitText }}>
                      {formatSignedJPY(c.diffValue)}
                    </span>
                  )}
                </div>
              </div>
              {/* 現在バー */}
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing[1.5], marginBottom: 3 }}>
                <span style={{ fontSize: '10px', color: colors.textMuted, width: '24px', textAlign: 'right', flexShrink: 0 }}>現在</span>
                <div style={{ flex: 1, height: '6px', background: colors.bgElevated, borderRadius: radius.full, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${currentPct}%`, background: barColor, borderRadius: radius.full, transition: 'width 0.4s ease' }} />
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, color: isOver ? colors.waitText : colors.textPrimary, width: '36px', textAlign: 'right', flexShrink: 0 }}>
                  {c.currentRatio.toFixed(1)}%
                </span>
              </div>
              {/* 目標バー */}
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing[1.5] }}>
                <span style={{ fontSize: '10px', color: colors.textMuted, width: '24px', textAlign: 'right', flexShrink: 0 }}>目標</span>
                <div style={{ flex: 1, height: '6px', background: colors.bgElevated, borderRadius: radius.full, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${targetPct}%`, background: `${accentColor}55`, borderRadius: radius.full, border: `1px solid ${accentColor}77` }} />
                </div>
                <span style={{ fontSize: '10px', color: colors.textSubtle, width: '36px', textAlign: 'right', flexShrink: 0 }}>
                  {c.targetRatio.toFixed(1)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="home-pf-grid">
        <div>
          <div className="home-pf-col__header home-pf-col__header--buy">▲ 追加候補</div>
          {addCandidates.length === 0
            ? <div className="home-pf-col__empty">なし</div>
            : addCandidates.map(c => (
              <div key={c.name} className="home-pf-col__item">
                {c.label} ({formatPt(c.diff)})
              </div>
            ))
          }
          {/* P4-A134: 買い抑制中（SAFE_MODE/DQ）は銘柄名を出さない */}
          {buyList.length > 0 && !isBuySuppressed && (
            <div className="home-pf-col__signal home-pf-col__signal--buy">
              高確信銘柄: {buyList.slice(0, 2).map(b => b.code).join(', ')}
            </div>
          )}
        </div>
        <div>
          <div className="home-pf-col__header home-pf-col__header--sell">▼ 削減候補</div>
          {reduceCandidates.length === 0
            ? <div className="home-pf-col__empty">なし</div>
            : reduceCandidates.map(c => (
              <div key={c.name} className="home-pf-col__item">
                {c.label} ({formatPt(c.diff)})
              </div>
            ))
          }
          {/* P4-A134: ロック中銘柄を除外したリストで売却候補を表示 */}
          {unlockedSellList.length > 0 && (
            <div className="home-pf-col__signal home-pf-col__signal--sell">
              売却候補: {unlockedSellList.slice(0, 2).map(s => s.code).join(', ')}
            </div>
          )}
        </div>
      </div>

      {/* P4-A89: JP_TRUST が追加候補の時、T7 headroom 条件の注記を表示 */}
      {addCandidates.some(c => c.name === 'JP_TRUST') && (
        <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '8px', lineHeight: 1.5 }}>
          ※ 日本株投信の実際の買付提案は、T7のheadroom条件に従います。ここの差分は参考値です。
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// F. リスク警告カード
// ─────────────────────────────────────────────────────────────

function RiskWarningCard() {
  const market     = useAppStore(s => s.market)
  const macro      = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const system     = useAppStore(s => s.system)
  const holdings   = useAppStore(s => s.holdings)

  interface RiskItem {
    level: 'high' | 'medium' | 'low'
    text: string
  }

  const risks: RiskItem[] = []

  if (system.status === 'error') {
    risks.push({ level: 'high', text: `データ更新エラー: ${system.error ?? '詳細不明'}` })
  }
  if (market.vix >= 28) {
    risks.push({ level: 'high', text: `VIX ${market.vix.toFixed(1)} — 極端なボラティリティ警戒` })
  } else if (market.vix >= 22) {
    risks.push({ level: 'medium', text: `VIX ${market.vix.toFixed(1)} — やや高め。急変動に備える` })
  }
  if (macro && macro.nikkeiVI >= 25) {
    risks.push({ level: 'high', text: `日経225 VI ${macro.nikkeiVI.toFixed(1)} — 国内高ボラ警戒` })
  }
  const sqDays = sqCalendar?.nextSQ?.dayUntil ?? 999
  if (sqDays <= 3) {
    risks.push({ level: 'high', text: `SQ ${sqCalendar?.nextSQ?.date} まで残${sqDays}営業日 — ポジション注意` })
  } else if (sqDays <= 7) {
    risks.push({ level: 'medium', text: `SQ接近（残${sqDays}営業日）— 先物主導の乱高下に注意` })
  }

  const locked = holdings.filter(h => isSellLocked(h))
  if (locked.length > 0) {
    risks.push({ level: 'low', text: `ロック中銘柄: ${locked.map(h => h.code).join(', ')} — 3ヶ月制約により売却不可` })
  }

  const mitsuHoldings = holdings.filter(h => h.mitsu)
  if (mitsuHoldings.length >= 3) {
    risks.push({ level: 'medium', text: `三菱グループ集中: ${mitsuHoldings.length}銘柄 — 相関リスクに注意` })
  }

  if (risks.length === 0) {
    risks.push({ level: 'low', text: '現時点で重大なリスク要因は検出されていません' })
  }

  return (
    <div className="card">
      <SectionTitle icon="⚠️" title="リスク警告" />
      <div className="risk-list">
        {risks.map((r, i) => (
          <div key={i} className={`risk-item${r.level === 'medium' ? ' risk-item--medium' : r.level === 'low' ? ' risk-item--low' : ''}`}>
            <span>{r.level === 'high' ? '🔴' : r.level === 'medium' ? '🟡' : '🟢'}</span>
            <span>{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// G. 高確信銘柄カード
// ─────────────────────────────────────────────────────────────

function TopCandidatesCard() {
  const buyList  = useAppStore(selectBuyList)
  const sellList = useAppStore(selectSellList)
  const holdings = useAppStore(s => s.holdings)
  const dq       = useAppStore(selectMarketDataQuality)
  // P4-A114: TodayJudgmentCardと同じ抑制条件に統一（SAFE_MODE only時の矛盾を解消）
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive = useAppStore(selectEffectiveSafeModeActive)
  const officialDecision = useAppStore(s => s.officialDecision)
  // P5-PRE-1: 表示対象の算出はcomputeTopCandidateSignalsForDisplayに一元化
  // （useHasCandidateSectionContentと共有）。抑制条件・isSellLocked除外・件数は従来と同一。
  const { topBuy, topSell } = computeTopCandidateSignalsForDisplay(
    buyList, sellList, holdings, officialDecision?.dataQualitySuppressed ?? false, dq.isSuppressed, safeModeActive
  )

  if (topBuy.length === 0 && topSell.length === 0) return null

  function holdingName(code: string) {
    return holdings.find(h => h.code === code)?.name ?? code
  }

  return (
    <div className="card">
      <SectionTitle icon="🎯" title="保有銘柄シグナル" />
      <div style={{ fontSize: '12px', color: 'var(--color-text-subtle)', marginBottom: '12px' }}>
        保有中銘柄の買増し・売却シグナルです。新規採用候補とは分けて表示しています。
      </div>
      <div className="home-candidates-grid">
        {topBuy.length > 0 && (
          <div>
            <div className="home-candidates-col__header home-candidates-col__header--buy">買い候補</div>
            {topBuy.map(a => (
              <div key={a.code} className="home-candidate-card home-candidate-card--buy">
                <div className="home-candidate-card__header">
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div className="home-candidate-card__code">{a.code}</div>
                    <div className="home-candidate-card__name">{holdingName(a.code)}</div>
                  </div>
                  {/* P4-A123: hero score */}
                  <div style={{ textAlign: 'center', flexShrink: 0, minWidth: 52 }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: colors.buyText, lineHeight: 1 }}>{a.totalScore}</div>
                    <div style={{ fontSize: 9, color: colors.textMuted }}>スコア</div>
                    {a.strategyRank && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: colors.buyText }}>ランク {a.strategyRank}</div>
                    )}
                  </div>
                </div>
                {a.debate?.bullReasons?.[0] && (
                  <div className="home-candidate-card__reason">▲ {a.debate.bullReasons[0]}</div>
                )}
                {/* P4-A123: 確信度 + EV ミニ行 */}
                <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ color: colors.textMuted }}>
                    確信度 <span style={{ fontWeight: 800, color: colors.buyText }}>{Math.round(a.confidence * 100)}%</span>
                  </span>
                  {a.ev >= 0 && (
                    <span style={{ color: colors.textMuted }}>
                      EV <span style={{ fontWeight: 700, color: colors.buyText }}>{formatSignedPct(a.ev * 100, 1)}</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {topSell.length > 0 && (
          <div>
            <div className="home-candidates-col__header home-candidates-col__header--sell">売り候補</div>
            {topSell.map(a => (
              <div key={a.code} className="home-candidate-card home-candidate-card--sell">
                <div className="home-candidate-card__header">
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div className="home-candidate-card__code">{a.code}</div>
                    <div className="home-candidate-card__name">{holdingName(a.code)}</div>
                  </div>
                  {/* P4-A123: hero score */}
                  <div style={{ textAlign: 'center', flexShrink: 0, minWidth: 52 }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: colors.sellText, lineHeight: 1 }}>{a.totalScore}</div>
                    <div style={{ fontSize: 9, color: colors.textMuted }}>スコア</div>
                    {a.strategyRank && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: colors.sellText }}>ランク {a.strategyRank}</div>
                    )}
                  </div>
                </div>
                {a.debate?.bearReasons?.[0] && (
                  <div className="home-candidate-card__reason">▼ {a.debate.bearReasons[0]}</div>
                )}
                {/* P4-A123: 確信度ミニ行 */}
                <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ color: colors.textMuted }}>
                    確信度 <span style={{ fontWeight: 800, color: colors.sellText }}>{Math.round(a.confidence * 100)}%</span>
                  </span>
                  {a.ev <= 0 && (
                    <span style={{ color: colors.textMuted }}>
                      EV <span style={{ fontWeight: 700, color: colors.sellText }}>{formatSignedPct(a.ev * 100, 1)}</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// T0-CC-4-1 / CAND-SYN-1D: 「候補」SectionKickerの表示判定。CandidateCardは
// CAND-SYN-1Dで常に何らかの状態（decisions/no-action/unavailable）を表示する
// ようになったため（TodoCardの「今日のアクション」kickerと同様）、孤立非表示の
// 判定はもう不要 — 候補セクションは常に表示する。
function useHasCandidateSectionContent(): boolean {
  return true
}

// ─────────────────────────────────────────────────────────────
// メインコンポーネント
// ─────────────────────────────────────────────────────────────

export function T0_Home() {
  const hasCandidateSectionContent = useHasCandidateSectionContent()
  return (
    <div className="tab-panel">
      <PageHeader tabId="T0" />

      {/* [1] Hero: 今日の総合判断（UI-9-3: large verdict）— P1-11: 結論先出しのため警告バナーより前に配置 */}
      <TodayJudgmentCard />

      {/* [0] SAFE_MODE / TierA 状態（結論の直後。有事のみ表示） */}
      <SafeModeCard />

      {/* [0b] システム状態バー（T0-CC-1: 判断直後に1行で確認。表示専用） */}
      <SystemStatusBar />

      {/* [1b] 総資産スナップショット（P4-A96: ファーストビュー近くに軽量表示） */}
      <AssetSnapshotMini />

      {/* [1c] 最大配分乖離ストリップ（P4-A135: ファーストビューで配分状態を1行サマリー） */}
      <AllocationGapStrip />

      {/* [2] 今日のアクション（P4-A92: NavCtaRowより前へ。結論の直後にToDoを配置） */}
      <SectionKicker label="今日のアクション" />
      <div className="page-grid page-grid--2col">
        <TodoCard />
        <RiskWarningCard />
      </div>

      {/* [3] 候補（T0-CC-4-1: 候補カードが1件も表示されない場合はkickerも非表示にする） */}
      {hasCandidateSectionContent && <SectionKicker label="候補" />}
      <CandidateCard />

      {/* [3b] 高確信候補（候補がある場合のみ） */}
      <TopCandidatesCard />

      {/* [5] ポートフォリオ概況（UI-9-3: donut + preview） */}
      <SectionKicker label="ポートフォリオ概況" />
      <div className="page-grid page-grid--2col">
        <PortfolioDonutCard />
        <AssetSummaryCard />
      </div>

      {/* [5a] CASH-AUTH-1: 現金権限の読み取り専用サマリー（編集はT9のみ） */}
      <CashAuthoritySummaryCard />

      {/* [5b] 保有銘柄 / 投信プレビュー（UI-9-3 new） */}
      <div className="page-grid page-grid--2col">
        <HoldingPreviewCard />
        <FundPreviewCard />
      </div>

      {/* [6] 理想PF差分 */}
      <IdealPfCard />

      {/* [7] 参考情報（P4-A92: 実行判断との分離を明示） */}
      <SectionKicker label="参考情報" />

      {/* [7a] 市場概況（P4-A92: 参考情報セクションへ移動） */}
      <MarketCard />

      {/* [7a-2] 重要マーケットニュース（P4.5-A004: T0では件数を絞って表示） */}
      <MarketNewsCard />

      {/* [7b] Phase 8 観察ダッシュボード */}
      <div className="home-phase8-section">
        <div className="home-phase8-desc">
          Phase 8 観察ダッシュボード — partial-real / hybrid estimates / 売買指示ではありません
        </div>
        <Phase8SummaryCard />
      </div>

      {/* [8] クイックナビゲーション（T0-CC-3: 主導線→補助導線へ格下げ。参考情報の下・フッター直前へ移動） */}
      <div style={{ marginTop: '4px' }}>
        <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '6px' }}>
          他のタブへ移動
        </div>
        <NavCtaRow />
      </div>

      {/* フッター注記 */}
      <div className="home-footer-note">
        Capital Allocation OS — 本情報は投資判断の参考情報です。最終判断は必ずご自身で行ってください。
      </div>
    </div>
  )
}
