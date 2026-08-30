/**
 * T6_Committee — AI討論ログ（Supporting Evidence）
 * Phase 4: 8代理討論 × 参考見解 × 条件管理
 * 表示順: 参考見解 → AI討論ログ → 根拠 → 条件 → 7軸
 */
import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectMarketDataQuality, selectEffectiveSafeModeActive } from '../../store/selectors'
import { formatDateTime, formatSignedPct } from '../../utils/format'
import type { HoldingAnalysis, Holding, AgentScore } from '../../types'
import { CircularGauge } from '../charts/CircularGauge'
import { colors } from '../../theme/tokens'
import { SectionHeader } from '../layout/SectionHeader'
import { PageHeader } from '../layout/PageHeader'
import { SUPPRESSION_BANNER_PREFIX } from '../shared/suppressionBanner'

// ─────────────────────────────────────────────────────────────
// サブコンポーネント
// ─────────────────────────────────────────────────────────────

function BarClass(score: number) {
  return score >= 65 ? 'high' : score >= 45 ? 'mid' : 'low'
}

// P4-A154: SAFE_MODE/DQ抑制中はBUY表示のみWAITに変換する（表示専用）。
// SELL/HOLD等はそのまま維持し、防御・監視表示を弱めない。analysisのdecision自体は変更しない。
function suppressBuyDisplayDecision(
  decision: 'BUY' | 'HOLD' | 'SELL' | 'INSUFFICIENT_EVIDENCE',
  isBuySuppressed: boolean,
): 'BUY' | 'HOLD' | 'SELL' | 'WAIT' | 'INSUFFICIENT_EVIDENCE' {
  return isBuySuppressed && decision === 'BUY' ? 'WAIT' : decision
}

// ── 0a. コンセンサスメーター ──────────────────────────────────
function ConsensusMeter({ analysis, isBuySuppressed }: { analysis: HoldingAnalysis[]; isBuySuppressed: boolean }) {
  const total = analysis.length
  if (total === 0) return null

  // P4-A154: SAFE_MODE/DQ抑制中はBUY件数に数えない（HOLD側に繰り込む集計。analysis自体は変更しない）
  const buyCount  = isBuySuppressed ? 0 : analysis.filter(a => a.decision === 'BUY').length
  const sellCount = analysis.filter(a => a.decision === 'SELL').length
  const holdCount = total - buyCount - sellCount

  const buyPct  = Math.round((buyCount  / total) * 100)
  const sellPct = Math.round((sellCount / total) * 100)
  const holdPct = 100 - buyPct - sellPct

  const dominantLabel = buyPct >= 60 ? '強い賛成多数'
    : buyPct >= 40 ? '賛成傾向'
    : holdPct >= 50 ? '慎重多数'
    : '混戦'
  const dominantColor = buyPct >= 50 ? colors.buy : holdPct >= 50 ? colors.hold : colors.sell

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${colors.borderSubtle}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: colors.textSubtle, letterSpacing: '0.04em' }}>
          コンセンサス（賛成度）
        </span>
        <span style={{ fontSize: 20, fontWeight: 800, color: dominantColor, lineHeight: 1 }}>
          {buyPct}%
          <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginLeft: 3 }}>賛成</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: colors.textMuted, marginLeft: 8 }}>{dominantLabel}</span>
        </span>
      </div>
      {/* 3色横バー */}
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, background: colors.bgElevated }}>
        {buyPct  > 0 && <div style={{ width: `${buyPct}%`,  background: colors.buy,  borderRadius: 4, transition: 'width 0.3s' }} />}
        {holdPct > 0 && <div style={{ width: `${holdPct}%`, background: colors.hold, borderRadius: 4, transition: 'width 0.3s' }} />}
        {sellPct > 0 && <div style={{ width: `${sellPct}%`, background: colors.sell, borderRadius: 4, transition: 'width 0.3s' }} />}
      </div>
      {/* カウント行 */}
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, flexWrap: 'wrap' }}>
        <span style={{ color: colors.buyText,  fontWeight: 600 }}>BUY {buyCount}銘柄</span>
        <span style={{ color: colors.hold,     fontWeight: 600 }}>待機 {holdCount}銘柄</span>
        <span style={{ color: colors.sellText, fontWeight: 600 }}>SELL {sellCount}銘柄</span>
        {isBuySuppressed && (
          <span style={{ color: colors.hold, fontWeight: 600 }}>{SUPPRESSION_BANNER_PREFIX} — 買付は参考停止</span>
        )}
      </div>
    </div>
  )
}

// ── 1. 銘柄セレクター ──────────────────────────────────────────
function StockSelector({
  holdings,
  analysis,
  selected,
  onSelect,
  isBuySuppressed,
}: {
  holdings: Holding[]
  analysis: HoldingAnalysis[]
  selected: string
  onSelect: (code: string) => void
  isBuySuppressed: boolean
}) {
  return (
    <div className="stock-selector">
      {analysis.map(a => {
        const h = holdings.find(x => x.code === a.code)
        if (!h) return null
        // P4-A154: SAFE_MODE/DQ抑制中はBUYバッジのみWAITへ変換（表示専用。a.decisionは変更しない）
        // stock-selector__item--wait は未定義のため、外側スタイルはholdにフォールバック（内側badgeはbadge--waitが既存定義済み）
        const dec = suppressBuyDisplayDecision(a.decision, isBuySuppressed)
        const cls = dec === 'BUY' ? 'buy' : dec === 'SELL' ? 'sell' : 'hold'
        return (
          <button
            key={a.code}
            className={`stock-selector__item stock-selector__item--${cls}${selected === a.code ? ' active' : ''}`}
            onClick={() => onSelect(a.code)}
            type="button"
          >
            <span className={`badge badge--${dec === 'INSUFFICIENT_EVIDENCE' ? 'wait' : dec.toLowerCase()}`} style={{ fontSize: 9 }}>
              {dec === 'INSUFFICIENT_EVIDENCE' ? '分析データ不足' : dec}
            </span>
            <span>{h.name.length > 6 ? h.name.slice(0, 6) + '…' : h.name}</span>
            <span style={{ fontSize: 10, opacity: 0.75 }}>{a.debate.debateScore}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── 2. ヒーロー判定パネル（選択銘柄の参考判定 大見出し版） ────
function HeroVerdictPanel({ a, h, isBuySuppressed }: { a: HoldingAnalysis; h: Holding; isBuySuppressed: boolean }) {
  // P4-A154: SAFE_MODE/DQ抑制中はBUY表示のみWAITへ変換（表示専用。a.decisionは変更しない）
  const rawDec = a.decision
  const dec    = suppressBuyDisplayDecision(rawDec, isBuySuppressed)
  const debate = a.debate
  const cls    = dec === 'BUY' ? 'buy' : dec === 'SELL' ? 'sell' : dec === 'WAIT' ? 'wait' : 'hold'
  const confidencePct = Math.round(debate.confidence * 100)
  const tone: 'buy' | 'hold' | 'wait' = debate.confidence >= 0.65 ? 'buy'
    : debate.confidence >= 0.45 ? 'hold' : 'wait'

  const decHeadline = dec === 'INSUFFICIENT_EVIDENCE' ? '分析データ不足 — 取得後に再評価'
    : dec === 'WAIT' ? `${SUPPRESSION_BANNER_PREFIX} — 買付は参考停止`
    : dec === 'BUY'  ? '新規・買増しを参考推奨'
    : dec === 'SELL' ? '売却を参考検討'
    : '維持 / 様子見 — ポジション継続'

  // 代理人コンセンサス（選択銘柄の agents から集計）
  const agents   = debate.agents
  const agentBuy  = agents.filter(ag =>
    ag.buyReasons.length > Math.max(ag.waitReasons.length, ag.sellReasons.length)).length
  const agentSell = agents.filter(ag =>
    ag.sellReasons.length > Math.max(ag.buyReasons.length, ag.waitReasons.length)).length
  const agentWait = agents.length - agentBuy - agentSell

  return (
    <div style={{
      background: `var(--color-${cls}-bg)`,
      border: `1px solid var(--color-${cls}-border)`,
      borderRadius: 12,
      padding: '16px 16px 14px',
    }}>
      {/* 上段: 銘柄名・大見出し + CircularGauge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: `var(--color-${cls}-text)` }}>
              {h.code} {h.name}
            </span>
            <span className={`badge badge--${cls}`}>{dec}</span>
          </div>
          <div style={{
            fontSize: 20, fontWeight: 800,
            color: `var(--color-${cls}-text)`,
            lineHeight: 1.3, marginBottom: 6,
          }}>
            {decHeadline}
          </div>
          {/* P4-A154: 抑制中はdebate.recommendedAction（AI討論の生の実行指示文言）をSAFE_MODE/DQ文言で上書きする */}
          {isBuySuppressed && rawDec === 'BUY' ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', lineHeight: 1.5 }}>
              {SUPPRESSION_BANNER_PREFIX}のため、新規・買増しの参考推奨は停止しています。
            </div>
          ) : debate.recommendedAction && (
            <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', lineHeight: 1.5 }}>
              {debate.recommendedAction}
            </div>
          )}
        </div>
        <CircularGauge
          value={confidencePct}
          size={90}
          strokeWidth={10}
          tone={tone}
          label="信頼度"
          unit="%"
        />
      </div>

      {/* 下段: メトリクス行 */}
      <div style={{
        display: 'flex', gap: 16, flexWrap: 'wrap',
        marginTop: 14, paddingTop: 12,
        borderTop: `1px solid var(--color-${cls}-border)`,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>討論スコア</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: `var(--color-${cls}-text)`, lineHeight: 1 }}>
            {debate.debateScore}
          </div>
          <div style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>/ 100</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>ランク</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: `var(--color-${cls}-text)`, lineHeight: 1 }}>
            {a.strategyRank}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>EV</div>
          <div style={{
            fontSize: 14, fontWeight: 700, lineHeight: 1,
            color: a.ev > 0 ? 'var(--color-buy-text)' : 'var(--color-sell-text)',
          }}>
            {formatSignedPct(a.ev * 100, 1)}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>リスクゲート</div>
          <div style={{
            fontSize: 13, fontWeight: 700, lineHeight: 1,
            color: debate.riskGatePass ? colors.buyText : colors.sellText,
          }}>
            {debate.riskGatePass ? '✓ 通過' : '✗ 注意'}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>代理人投票</div>
          <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.6 }}>
            <span style={{ color: colors.buyText  }}>賛 {agentBuy}</span>
            <span style={{ color: colors.hold,    marginLeft: 6 }}>慎 {agentWait}</span>
            <span style={{ color: colors.sellText, marginLeft: 6 }}>反 {agentSell}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 3. 委員会メンバーカード ─────────────────────────────────────
function AgentCard({ agent }: { agent: AgentScore }) {
  const bc = BarClass(agent.score)
  const hasReasons = agent.buyReasons.length > 0 || agent.waitReasons.length > 0 || agent.sellReasons.length > 0

  // スタンス判定（理由リスト長で推定）
  const bLen = agent.buyReasons.length
  const wLen = agent.waitReasons.length
  const sLen = agent.sellReasons.length
  const total = bLen + wLen + sLen
  const stance: 'buy' | 'wait' | 'sell' = total === 0 || (bLen >= sLen && bLen >= wLen)
    ? 'buy' : sLen > wLen ? 'sell' : 'wait'
  const stanceMeta = {
    buy:  { label: '賛成', color: colors.buyText,  bg: colors.buyBg,  border: colors.buyBorder  },
    wait: { label: '慎重', color: colors.waitText, bg: colors.waitBg, border: colors.waitBorder },
    sell: { label: '反対', color: colors.sellText, bg: colors.sellBg, border: colors.sellBorder },
  }[stance]
  const iconChar = agent.agent.slice(0, 1)

  return (
    <div className="agent-card">
      {/* ヘッダー: 円形アイコン + 名前 + スタンスバッジ + スコア */}
      <div className="agent-card__header" style={{ alignItems: 'center' }}>
        <div style={{
          width: 34, height: 34, borderRadius: '50%',
          background: stanceMeta.bg, border: `2px solid ${stanceMeta.border}`,
          color: stanceMeta.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 800, flexShrink: 0, marginRight: 8,
        }}>
          {iconChar}
        </div>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="agent-card__name">{agent.agent}</div>
          <div className="agent-card__style">{agent.style}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: stanceMeta.color, background: stanceMeta.bg,
            padding: '2px 7px', borderRadius: 10,
            border: `1px solid ${stanceMeta.border}`,
          }}>
            {stanceMeta.label}
          </span>
          <span style={{ fontSize: 14, fontWeight: 800, color: stanceMeta.color }}>
            {agent.score}<span style={{ fontSize: 9, color: colors.textMuted, fontWeight: 400 }}>/100</span>
          </span>
        </div>
      </div>

      {/* スコアバー */}
      <div className="agent-score-bar">
        <div
          className={`agent-score-bar__fill agent-score-bar__fill--${bc}`}
          style={{ width: `${agent.score}%` }}
        />
      </div>

      {/* 行動理由 */}
      {hasReasons && (
        <div className="agent-card__reasons">
          {agent.buyReasons.map((r, i) => (
            <div key={`buy-${i}`} className="agent-reason-item">
              <span className="agent-reason-item__dot agent-reason-item__dot--buy" />
              <span style={{ color: 'var(--color-buy-text)' }}>{r}</span>
            </div>
          ))}
          {agent.waitReasons.map((r, i) => (
            <div key={`wait-${i}`} className="agent-reason-item">
              <span className="agent-reason-item__dot agent-reason-item__dot--wait" />
              <span style={{ color: 'var(--color-wait-text)' }}>{r}</span>
            </div>
          ))}
          {agent.sellReasons.map((r, i) => (
            <div key={`sell-${i}`} className="agent-reason-item">
              <span className="agent-reason-item__dot agent-reason-item__dot--sell" />
              <span style={{ color: 'var(--color-sell-text)' }}>{r}</span>
            </div>
          ))}
        </div>
      )}

      {/* 前提条件 (折りたたまれた形) */}
      {agent.premise.filter(Boolean).length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-border-default)', paddingTop: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', fontWeight: 600, marginBottom: 3 }}>
            前提条件
          </div>
          {agent.premise.filter(Boolean).map((p, i) => (
            <div key={i} className="agent-reason-item">
              <span className="agent-reason-item__dot agent-reason-item__dot--premise" />
              <span style={{ color: 'var(--color-text-subtle)', fontSize: 10 }}>{p}</span>
            </div>
          ))}
        </div>
      )}

      {/* 前提崩れ条件 */}
      {agent.premiseBreak.filter(Boolean).length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--color-sell-text)', fontWeight: 600, marginBottom: 3 }}>
            前提崩れ
          </div>
          {agent.premiseBreak.filter(Boolean).map((p, i) => (
            <div key={i} className="agent-reason-item">
              <span className="agent-reason-item__dot agent-reason-item__dot--sell" />
              <span style={{ color: 'var(--color-sell-text)', fontSize: 10 }}>{p}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 4. Conviction Panel（Bull/Bear + 行動理由 統合） ───────────
function ConvictionPanel({ a }: { a: HoldingAnalysis }) {
  const debate = a.debate
  const hasBuy  = debate.buyReasons.length > 0
  const hasWait = debate.waitReasons.length > 0
  const hasSell = debate.sellReasons.length > 0
  const hasActions = hasBuy || hasWait || hasSell

  return (
    <div className="conviction-panel">
      {/* Bull / Bear 2カラム */}
      <div className="conviction-panel__grid">
        <div className="conviction-panel__block conviction-panel__block--bull">
          <div className="section-kicker" style={{ marginBottom: 8 }}>▲ Bull要因</div>
          <div className="reason-list">
            {debate.bullReasons.length > 0 ? debate.bullReasons.map((r, i) => (
              <div key={i} className="reason-list__item reason-list__item--bull">▲ {r}</div>
            )) : (
              <div className="reason-list__item reason-list__item--wait">データなし</div>
            )}
          </div>
        </div>
        <div className="conviction-panel__block conviction-panel__block--bear">
          <div className="section-kicker" style={{ marginBottom: 8 }}>▼ Bear要因</div>
          <div className="reason-list">
            {debate.bearReasons.length > 0 ? debate.bearReasons.map((r, i) => (
              <div key={i} className="reason-list__item reason-list__item--bear">▼ {r}</div>
            )) : (
              <div className="reason-list__item reason-list__item--bull">懸念材料なし</div>
            )}
          </div>
        </div>
      </div>

      {/* 行動理由: 今買う / 待つ / 売る */}
      {hasActions && (
        <div className="conviction-panel__actions">
          {hasBuy && (
            <div className="conviction-action-card conviction-action-card--buy">
              <div className="conviction-action-card__label">今買う理由</div>
              <div className="reason-list">
                {debate.buyReasons.map((r, i) => (
                  <div key={i} className="reason-list__item reason-list__item--bull">▲ {r}</div>
                ))}
              </div>
            </div>
          )}
          {hasWait && (
            <div className="conviction-action-card conviction-action-card--wait">
              <div className="conviction-action-card__label">待つ理由</div>
              <div className="reason-list">
                {debate.waitReasons.map((r, i) => (
                  <div key={i} className="reason-list__item reason-list__item--wait">… {r}</div>
                ))}
              </div>
            </div>
          )}
          {hasSell && (
            <div className="conviction-action-card conviction-action-card--sell">
              <div className="conviction-action-card__label">売る理由</div>
              <div className="reason-list">
                {debate.sellReasons.map((r, i) => (
                  <div key={i} className="reason-list__item reason-list__item--bear">▼ {r}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 6. 条件管理パネル ──────────────────────────────────────────
function ConditionPanel({ a }: { a: HoldingAnalysis }) {
  const debate = a.debate
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="section-kicker" style={{ marginBottom: 8 }}>利確条件</div>
        <div className="condition-panel">
          {debate.takeProfitConditions.map((c, i) => (
            <div key={i} className="condition-item condition-item--profit">
              <span className="condition-item__icon">↑</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="section-kicker" style={{ marginBottom: 8 }}>損切条件</div>
        <div className="condition-panel">
          {debate.stopLossConditions.map((c, i) => (
            <div key={i} className="condition-item condition-item--loss">
              <span className="condition-item__icon">↓</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="section-kicker" style={{ marginBottom: 8 }}>前提崩れ条件</div>
        <div className="condition-panel">
          {debate.premiseBreakConditions.map((c, i) => (
            <div key={i} className="condition-item condition-item--premise">
              <span className="condition-item__icon">!</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── 7. 7軸スコア ───────────────────────────────────────────────
function SevenAxis({ a }: { a: HoldingAnalysis }) {
  const ax = a.debate.sevenAxis
  const axes = [
    { key: 'growth',    label: '成長', value: ax.growth },
    { key: 'valuation', label: '割安', value: ax.valuation },
    { key: 'momentum',  label: 'モメン', value: ax.momentum },
    { key: 'macro',     label: 'マクロ', value: ax.macro },
    { key: 'quality',   label: '品質', value: ax.quality },
    { key: 'risk',      label: 'リスク', value: ax.risk },
    { key: 'news',      label: 'ニュース', value: ax.news },
  ]
  return (
    <div className="axis-grid">
      {axes.map(ax => {
        const cls = ax.value >= 65 ? 'high' : ax.value >= 40 ? 'mid' : 'low'
        const color = ax.value >= 65 ? 'var(--color-buy-text)' : ax.value >= 40 ? 'var(--color-hold-text, #1e40af)' : 'var(--color-sell-text)'
        return (
          <div key={ax.key} className="axis-tile">
            <div className="axis-tile__name">{ax.label}</div>
            <div className="axis-tile__value" style={{ color }}>{ax.value}</div>
            <div className="axis-tile__bar">
              <div
                className={`axis-tile__fill axis-tile__fill--${cls}`}
                style={{ width: `${ax.value}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 0. エージェントヒートマップ行（8代理スコア概観） ───────────
function AgentHeatRow({ agents }: { agents: AgentScore[] }) {
  function heatCls(score: number) {
    return score >= 65 ? 'high' : score >= 45 ? 'mid' : 'low'
  }
  function shortName(name: string) {
    return name.length <= 4 ? name : name.slice(0, 4)
  }
  return (
    <div className="agent-heat-row">
      {agents.map(agent => (
        <div key={agent.agent} className={`agent-heat-tile agent-heat-tile--${heatCls(agent.score)}`}>
          <div className="agent-heat-tile__name">{shortName(agent.agent)}</div>
          <div className="agent-heat-tile__score">{agent.score}</div>
        </div>
      ))}
    </div>
  )
}

// ── 8. 委員会サマリー（全銘柄俯瞰） ────────────────────────────
function CommitteeSummary({ analysis, isBuySuppressed }: { analysis: HoldingAnalysis[]; isBuySuppressed: boolean }) {
  // P4-A154: SAFE_MODE/DQ抑制中はBUY件数に数えない（analysis自体は変更しない）
  const buyCount  = isBuySuppressed ? 0 : analysis.filter(a => a.decision === 'BUY').length
  const sellCount = analysis.filter(a => a.decision === 'SELL').length
  const avgScore  = analysis.length
    ? Math.round(analysis.reduce((s, a) => s + a.debate.debateScore, 0) / analysis.length)
    : 0
  const gatePass = analysis.filter(a => a.debate.riskGatePass).length

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      {/* P4-A121: AI討論平均スコアを円形ゲージで表示 */}
      <CircularGauge
        value={avgScore}
        size={80}
        strokeWidth={9}
        tone={avgScore >= 65 ? 'buy' : avgScore >= 45 ? 'hold' : 'wait'}
        label="AI討論平均"
        sublabel="/ 100"
      />
      <div className="t6-stat-row" style={{ flex: '1 1 auto' }}>
        {[
          { label: isBuySuppressed ? 'BUY候補（抑制中）' : 'BUY候補', value: buyCount, variant: 'buy', unit: '銘柄' },
          { label: 'SELL候補',   value: sellCount, variant: 'sell',    unit: '銘柄' },
          { label: 'ゲート観察', value: gatePass,  variant: 'pass',    unit: '銘柄' },
        ].map(item => (
          <div key={item.label} className={`t6-stat__item t6-stat__item--${item.variant}`}>
            <div className="t6-stat__label">{item.label}</div>
            <div className="t6-stat__value">
              {item.value}
              <span className="t6-stat__unit">{item.unit}</span>
            </div>
          </div>
        ))}
      </div>
      <ConsensusMeter analysis={analysis} isBuySuppressed={isBuySuppressed} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────────────────────

export function T6_Committee() {
  const holdings = useAppStore(s => s.holdings)
  const analysis = useAppStore(s => s.analysis)
  const system   = useAppStore(s => s.system)
  // P4-A154: SAFE_MODE/DQ抑制中はBUYカウント・BUY文言のみ表示上抑制する
  const dq       = useAppStore(selectMarketDataQuality)
  // P4.5-A011: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const isBuySuppressed = useAppStore(selectEffectiveSafeModeActive) || dq.isSuppressed

  const [selectedCode, setSelectedCode] = useState<string>(() =>
    analysis.length > 0 ? analysis[0].code : '',
  )

  const selected  = analysis.find(a => a.code === selectedCode)
  const selectedH = holdings.find(h => h.code === selectedCode)

  if (analysis.length === 0) {
    return (
      <div className="tab-panel">
        <PageHeader tabId="T6" />
        <div className="card">
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-subtle)', fontSize: 13 }}>
            保有銘柄データを取込み後にAI討論ログが表示されます
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-panel">
      <PageHeader tabId="T6" />

      {/* Supporting Evidence 注記 */}
      <div style={{
        padding: '8px 12px',
        marginBottom: 8,
        background: 'var(--color-hold-bg)',
        border: '1px solid var(--color-hold-border)',
        borderRadius: 6,
        fontSize: 11,
        color: 'var(--color-text-subtle)',
        lineHeight: 1.6,
      }}>
        この画面はAI討論ログです。正式な売買判断はT0の公式判断を優先してください。
        ここに表示されるスコア・参考アクション・リスクゲート参考判定は、正式判断ではなく、根拠確認・反対意見確認・リスク観察のための補助情報です。
      </div>

      {/* ── ヘッダー情報（P0-1/D-18: 未定義の.section-heading-rowを廃止しSectionHeaderへ統一） ── */}
      <article className="card">
        <div>
          <div className="section-kicker">AI Debate Log / Supporting Evidence</div>
          <SectionHeader
            title="AI討論ログ"
            action={
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'right' }}>
                <div>8代理討論</div>
                <div>{system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行'}</div>
              </div>
            }
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <CommitteeSummary analysis={analysis} isBuySuppressed={isBuySuppressed} />
        </div>

        {/* 銘柄セレクター */}
        <div style={{ marginTop: 16 }}>
          <div className="section-kicker" style={{ marginBottom: 8 }}>銘柄を選んでAI討論ログを確認</div>
          <StockSelector
            holdings={holdings}
            analysis={analysis}
            selected={selectedCode}
            onSelect={setSelectedCode}
            isBuySuppressed={isBuySuppressed}
          />
        </div>

        {/* 8代理スコア概観 */}
        {selected && (
          <div style={{ marginTop: 12 }}>
            <div className="section-kicker" style={{ marginBottom: 8 }}>8代理スコア概観</div>
            <AgentHeatRow agents={selected.debate.agents} />
          </div>
        )}
      </article>

      {/* ── 選択銘柄の委員会詳細 ── */}
      {selected && selectedH && (
        <>
          {/* [1] 参考見解（結論） */}
          <article className="card" style={{ marginTop: 12 }}>
            <h2 className="section-heading" style={{ marginBottom: 10 }}>
              1 / 参考見解 — {selectedH.code} {selectedH.name}
            </h2>
            <HeroVerdictPanel a={selected} h={selectedH} isBuySuppressed={isBuySuppressed} />
          </article>

          {/* [2] 8代理討論 */}
          <article className="card" style={{ marginTop: 12 }}>
            <h2 className="section-heading" style={{ marginBottom: 12 }}>2 / AI討論ログ — 8代理スコア</h2>
            <div className="agent-grid">
              {selected.debate.agents.map(agent => (
                <AgentCard key={agent.agent} agent={agent} />
              ))}
            </div>
          </article>

          {/* [3] 判断根拠 — Bull / Bear / Action（統合） */}
          <article className="card" style={{ marginTop: 12 }}>
            <h2 className="section-heading" style={{ marginBottom: 12 }}>3 / 判断根拠 — Bull / Bear / Action</h2>
            <ConvictionPanel a={selected} />
          </article>

          {/* [4] 条件管理（利確/損切/前提崩れ） */}
          <article className="card" style={{ marginTop: 12 }}>
            <h2 className="section-heading" style={{ marginBottom: 12 }}>4 / 条件管理 — 利確 / 損切 / 前提崩れ</h2>
            <ConditionPanel a={selected} />
          </article>

          {/* [5] 7軸スコア */}
          <article className="card" style={{ marginTop: 12 }}>
            <h2 className="section-heading" style={{ marginBottom: 12 }}>5 / 7軸スコア</h2>
            <SevenAxis a={selected} />
          </article>
        </>
      )}
    </div>
  )
}
