/**
 * T3_GlobalFund — 海外投信（中長期配分）V10 Phase 7
 * 資産クラス: global_fund / OVERSEAS_LONGTERM + GOLD のみ
 * 役割: 中長期配分 — 為替影響・VIX・分散状況・積立継続判断
 * 表示順: 中長期スタンス → 外部要因 → 配分状況 → 分散/重複 → ファンド一覧
 */
import { useMemo } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useAppStore } from '../../store/useAppStore'
import { selectGlobalFunds, selectGlobalFundTotalEval, selectMarketDataQuality, selectEffectiveSafeModeActive } from '../../store/selectors'
import { formatJPYAuto, formatRelativeTime } from '../../utils/format'

import { DecisionCard }  from '../cards/DecisionCard'
import { MetricCard }    from '../cards/MetricCard'
import { SectionHeader } from '../layout/SectionHeader'
import { SignalBadge }   from '../badges/SignalBadge'
import { EmptyState }    from '../shared/EmptyState'
import type { Signal }   from '../badges/SignalBadge'
import type { RiskLevel } from '../badges/RiskBadge'

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'
import type { Trust } from '../../types'

// ── ヘルパー ────────────────────────────────────────────────────

function decisionToSignal(d: Trust['decision']): Signal {
  if (d === 'BUY')  return 'BUY'
  if (d === 'SELL') return 'SELL'
  if (d === 'WAIT') return 'WATCH'
  return 'HOLD'
}

function pnlColor(pct: number) {
  if (pct > 5)  return colors.buy
  if (pct < -5) return colors.sell
  if (pct < 0)  return colors.wait
  return colors.textPrimary
}

const POLICY_SUBLABEL: Record<Trust['policy'], string> = {
  JAPAN_SHORTTERM:  '国内株 超短期',
  OVERSEAS_LONGTERM:'海外株 中長期',
  GOLD:             'ゴールド 長期',
}

const POLICY_ACCENT: Record<Trust['policy'], { bg: string; text: string; border: string }> = {
  JAPAN_SHORTTERM:  { bg: colors.jpFundAccentBg,    text: colors.jpFundAccentText,    border: colors.jpFundAccent },
  OVERSEAS_LONGTERM:{ bg: colors.globalFundAccentBg, text: colors.globalFundAccentText, border: colors.globalFundAccent },
  GOLD:             { bg: colors.goldBg,             text: colors.gold,                border: colors.goldBorder },
}

// VIX 評価
function vixLabel(vix: number): { label: string; color: string; bg: string; desc: string } {
  if (vix >= 35) return { label: '恐怖圏',   color: colors.sellText, bg: colors.sellBg, desc: '積立は継続。一括追加は絶対禁止' }
  if (vix >= 25) return { label: '警戒圏',   color: colors.waitText, bg: colors.waitBg, desc: '積立継続。追加投資は小幅に抑える' }
  if (vix >= 18) return { label: '注意圏',   color: colors.waitText, bg: colors.waitBg, desc: '通常通り積立継続' }
  return               { label: '安定圏',    color: colors.buyText,  bg: colors.buyBg,  desc: '積立継続。余裕資金で追加検討も可' }
}

// 為替影響評価（USD強度をσから推定）
function fxImpact(sigma: number, regime: string): string {
  if (regime === 'bear') return '円高リスク高 — 株安時は円高になりやすく、海外投信の円換算評価が下落しやすい'
  if (sigma > 0.20) return '高ボラ相場 — 為替変動が大きく、円建て評価額のブレが大きい'
  return '為替は比較的安定。中長期では平均化される'
}

// ── コンポーネント ──────────────────────────────────────────────

export function T3_GlobalFund() {
  const isMobile    = useIsMobile()
  const globalFunds = useAppStore(selectGlobalFunds)
  const totalEval   = useAppStore(selectGlobalFundTotalEval)
  const universe    = useAppStore(s => s.universe)
  const market      = useAppStore(s => s.market)
  const system      = useAppStore(s => s.system)  // Phase 8: 更新時刻
  // P4-A119: SAFE_MODE / DQ suppression（T0/T2/T7と同パターン）
  // P4.5-A011-1: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const dq              = useAppStore(selectMarketDataQuality)
  const safeModeActive  = useAppStore(selectEffectiveSafeModeActive)
  const isSuppressed    = safeModeActive || dq.isSuppressed

  const classTarget = universe?.categories.find(c => c.class === 'OVERSEAS_TRUST')
  const goldTarget  = universe?.categories.find(c => c.class === 'GOLD')

  const overseasFunds = useMemo(() =>
    globalFunds.filter(f => f.policy === 'OVERSEAS_LONGTERM'),
    [globalFunds],
  )
  const goldFunds = useMemo(() =>
    globalFunds.filter(f => f.policy === 'GOLD'),
    [globalFunds],
  )

  const overseasEval = overseasFunds.reduce((s, f) => s + f.eval, 0)
  const goldEval     = goldFunds.reduce((s, f) => s + f.eval, 0)

  const avgScore  = globalFunds.length > 0
    ? Math.round(globalFunds.reduce((s, f) => s + f.score, 0) / globalFunds.length)
    : 0
  const buyCount  = globalFunds.filter(f => f.decision === 'BUY').length
  const sellCount = globalFunds.filter(f => f.decision === 'SELL').length

  const overallSignal: Signal =
    buyCount > sellCount ? 'BUY' :
    sellCount > buyCount ? 'SELL' : 'HOLD'

  const overallRisk: RiskLevel =
    market.regime === 'bear' ? 'HIGH' :
    market.regime === 'neutral' ? 'MEDIUM' : 'LOW'

  const regimeLabel =
    market.regime === 'bull'    ? '強気相場 — 中長期継続積立推奨' :
    market.regime === 'bear'    ? '弱気相場 — 新規エントリー抑制' :
    '中立相場 — 通常通り積立継続'

  const decisionReasons = [
    `海外投信 ${globalFunds.length} 件 / 評価額 ${formatJPYAuto(totalEval)}`,
    `BUY ${buyCount}件 / SELL ${sellCount}件 / 平均スコア ${avgScore}`,
    market.regime === 'bear' ? '弱気相場 — ドルコスト積立は継続、一括追加は抑制' : '',
    // P4-A119: isSuppressed時は注記を追加
    isSuppressed ? '⚠ SAFE_MODE / DQ抑制中 — 追加投資判断停止中' : '',
  ].filter(Boolean)

  // VIX 評価
  const vi = vixLabel(market.vix)

  // 分散状況: 最大ウェイトファンド
  const maxWeightFund = totalEval > 0
    ? globalFunds.reduce((max, f) => f.eval / totalEval > (max?.eval ?? 0) / totalEval ? f : max, globalFunds[0])
    : null
  const maxWeight = maxWeightFund && totalEval > 0 ? maxWeightFund.eval / totalEval : 0

  // 追加投資候補（BUY かつスコア上位）
  const addCandidates = [...globalFunds]
    .filter(f => f.decision === 'BUY')
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  // 積立継続判断
  const continuationJudgment =
    market.regime === 'bear' && market.vix >= 30
      ? { label: '積立継続・追加禁止', color: colors.waitText, bg: colors.waitBg, border: colors.waitBorder,
          reason: 'VIX高・弱気相場。ドルコスト積立は継続するが、一括追加投資は禁止。'}
      : market.regime === 'bear'
        ? { label: '積立継続', color: colors.waitText, bg: colors.waitBg, border: colors.waitBorder,
            reason: '弱気相場でもドルコスト平均法による積立は継続。一括買いは抑制。'}
        : buyCount > 0
          ? { label: '積立継続 + 追加検討', color: colors.buyText, bg: colors.buyBg, border: colors.buyBorder,
              reason: `BUY判定ファンド ${buyCount}件。積立継続しつつ、余裕資金での追加投資を検討可。`}
          : { label: '積立継続', color: colors.buyText, bg: colors.buyBg, border: colors.buyBorder,
              reason: '通常通り積立を継続してください。'}

  // 重複チェック: 海外株が2件以上ある場合
  const hasOverlap = overseasFunds.length >= 2

  // ── スタイル ───────────────────────────────────────────────

  const panelStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[5],
    padding:       isMobile ? `${spacing[4]} ${spacing[3]}` : `${spacing[5]} ${spacing[5]}`,
    maxWidth:      '900px',
    margin:        '0 auto',
  }

  const cardStyle: CSSProperties = {
    background:   colors.bgSurface,
    border:       `1px solid ${colors.borderSubtle}`,
    borderRadius: radius.lg,
    boxShadow:    shadow.sm,
    overflow:     'hidden',
  }

  const metricsGridStyle: CSSProperties = {
    display:             'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap:                 spacing[3],
  }

  const fundRowStyle: CSSProperties = {
    display:        'flex',
    alignItems:     'flex-start',
    justifyContent: 'space-between',
    padding:        `${spacing[4]} ${spacing[5]}`,
    gap:            spacing[3],
    flexWrap:       'wrap',
  }

  // ── 配分比較バー（現在 vs 理想 2色横バー） ──────────────────────

  function AllocationBar({
    label,
    currentValue,
    targetValue,
    currentRatio,
    targetRatio,
    accentColor = colors.globalFundAccent,
  }: {
    label: string
    currentValue: number
    targetValue: number
    currentRatio: number
    targetRatio: number
    accentColor?: string
  }) {
    const diff     = targetValue - currentValue
    const maxRatio = Math.max(currentRatio, targetRatio, 0.01)
    const currentPct = (currentRatio / maxRatio) * 100
    const targetPct  = (targetRatio  / maxRatio) * 100
    const isOver     = currentRatio > targetRatio + 0.01
    const ptDiff     = (currentRatio - targetRatio) * 100

    return (
      <div style={{ padding: `${spacing[3]} ${spacing[5]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing[2] }}>
          <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 600 }}>{label}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3] }}>
            <span style={{
              ...typography.caption,
              color: isOver ? colors.waitText : Math.abs(ptDiff) < 1 ? colors.textMuted : colors.buyText,
              fontWeight: 700,
            }}>
              {ptDiff >= 0 ? '+' : ''}{ptDiff.toFixed(1)}pt
            </span>
            <span style={{
              ...typography.caption,
              color:      diff > 0 ? colors.buy : diff < 0 ? colors.sell : colors.textSubtle,
              fontWeight: 600,
            }}>
              {diff >= 0 ? '+' : ''}{formatJPYAuto(diff)}
            </span>
          </div>
        </div>

        {/* 現在バー */}
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], marginBottom: spacing[1.5] }}>
          <span style={{ ...typography.caption, color: colors.textMuted, minWidth: 32, flexShrink: 0 }}>現在</span>
          <div style={{ flex: 1, height: '8px', background: colors.bgElevated, borderRadius: radius.full, overflow: 'hidden' }}>
            <div style={{
              height:     '100%',
              width:      `${currentPct}%`,
              background: isOver ? colors.wait : accentColor,
              borderRadius: radius.full,
              transition: 'width 0.4s ease',
            }} />
          </div>
          <span style={{ ...typography.caption, color: isOver ? colors.waitText : colors.textSubtle, fontWeight: 700, minWidth: 40, textAlign: 'right', flexShrink: 0 }}>
            {(currentRatio * 100).toFixed(1)}%
          </span>
        </div>

        {/* 理想バー */}
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
          <span style={{ ...typography.caption, color: colors.textMuted, minWidth: 32, flexShrink: 0 }}>目標</span>
          <div style={{ flex: 1, height: '8px', background: colors.bgElevated, borderRadius: radius.full, overflow: 'hidden', border: `1px solid ${accentColor}55` }}>
            <div style={{
              height:       '100%',
              width:        `${targetPct}%`,
              background:   `${accentColor}44`,
              borderRadius: radius.full,
            }} />
          </div>
          <span style={{ ...typography.caption, color: colors.textMuted, minWidth: 40, textAlign: 'right', flexShrink: 0 }}>
            {(targetRatio * 100).toFixed(1)}%
          </span>
        </div>

        {/* 金額サブテキスト */}
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1.5] }}>
          現在 {formatJPYAuto(currentValue)} → 目標 {formatJPYAuto(targetValue)}
        </div>
      </div>
    )
  }

  // ── ファンド行 ────────────────────────────────────────────────

  function FundRow({ fund, isLast }: { fund: Trust; isLast: boolean }) {
    const accent  = POLICY_ACCENT[fund.policy]
    const weight  = totalEval > 0 ? (fund.eval / totalEval * 100) : 0
    const isConc  = weight > 40

    return (
      <div style={{
        ...fundRowStyle,
        borderBottom: isLast ? 'none' : `1px solid ${colors.borderSubtle}`,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
            <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>
              {fund.abbr}
            </span>
            <span style={{
              ...typography.caption,
              background:   accent.bg,
              color:        accent.text,
              border:       `1px solid ${accent.border}`,
              borderRadius: radius.sm,
              padding:      `0 ${spacing[1.5]}`,
            }}>
              {POLICY_SUBLABEL[fund.policy]}
            </span>
            <SignalBadge signal={decisionToSignal(fund.decision)} size="sm" />
            {isConc && (
              <span style={{
                ...typography.caption,
                background: colors.waitBg, color: colors.waitText,
                border: `1px solid ${colors.waitBorder}`,
                borderRadius: radius.sm, padding: `0 ${spacing[1.5]}`,
              }}>集中注意</span>
            )}
          </div>
          <div style={{ ...typography.caption, color: colors.textSubtle, marginTop: spacing[0.5] }}>
            {fund.name}
          </div>
          <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[0.5] }}>
            口座: {fund.account} / 信託報酬: {fund.cost.toFixed(4)}% / 構成比: {weight.toFixed(1)}%
          </div>
        </div>

        <div style={{
          display:        'flex',
          gap:            spacing[4],
          flexWrap:       'wrap',
          alignItems:     'flex-end',
          justifyContent: 'flex-end',
        }}>
          {[
            { label: '評価額',   val: formatJPYAuto(fund.eval),                                         col: colors.textPrimary },
            { label: '損益率',   val: `${fund.pnlPct >= 0 ? '+' : ''}${fund.pnlPct.toFixed(2)}%`,       col: pnlColor(fund.pnlPct) },
            { label: '当日',     val: `${fund.dayPct >= 0 ? '+' : ''}${fund.dayPct.toFixed(2)}%`,        col: pnlColor(fund.dayPct) },
            { label: 'スコア',   val: `${fund.score}`,
              col: fund.score >= 60 ? colors.buy : fund.score >= 40 ? colors.wait : colors.sell },
          ].map(({ label, val, col }) => (
            <div key={label} style={{ textAlign: 'right' }}>
              <div style={{ ...typography.caption, color: colors.textSubtle }}>{label}</div>
              <div style={{ ...typography.bodySmall, color: col, fontWeight: 700 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── レンダリング ─────────────────────────────────────────────

  if (globalFunds.length === 0) {
    return (
      <div style={panelStyle}>
        <EmptyState
          message="海外投信なし"
          detail="OVERSEAS_LONGTERM / GOLD ポリシーの投信が登録されていません。"
        />
      </div>
    )
  }

  return (
    <div style={panelStyle}>

      {/* ── 資産クラスヘッダー ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
        <div style={{
          padding:      `${spacing[1]} ${spacing[3]}`,
          background:   colors.globalFundAccentBg,
          color:        colors.globalFundAccentText,
          border:       `1px solid ${colors.globalFundAccent}`,
          borderRadius: radius.full,
          ...typography.label,
          fontWeight:   700,
        }}>
          海外投信
        </div>
        <div style={{ ...typography.caption, color: colors.textSubtle }}>
          中長期配分 — 積立・リバランス専用（短期売買禁止）
        </div>
        {/* Phase 8: 更新時刻表示 */}
        <div style={{ ...typography.caption, color: colors.textMuted, marginLeft: 'auto' }}>
          {system.lastUpdated
            ? `更新 ${formatRelativeTime(system.lastUpdated)}`
            : 'データ未取得'
          }
        </div>
      </div>

      {/* ── 中長期スタンス カード ── */}
      {/* P4-A119: isSuppressed時はタイトルで抑制中を明示。overallSignal/スコア/生成ロジック変更なし */}
      <DecisionCard
        decision={overallSignal}
        title={isSuppressed ? `中長期スタンス（抑制中・参考）: ${regimeLabel}` : `中長期スタンス: ${regimeLabel}`}
        score={avgScore}
        reasons={decisionReasons}
        riskLevel={overallRisk}
      />

      {/* ── 積立継続判断 ── */}
      <div style={{
        background:   continuationJudgment.bg,
        border:       `1px solid ${continuationJudgment.border}`,
        borderRadius: radius.lg,
        padding:      `${spacing[4]} ${spacing[5]}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], marginBottom: spacing[2] }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: continuationJudgment.color }}>
            積立継続判断: {continuationJudgment.label}
          </span>
        </div>
        <div style={{ fontSize: '13px', color: continuationJudgment.color, lineHeight: '1.6' }}>
          {continuationJudgment.reason}
        </div>
      </div>

      {/* ── 外部要因影響 ── */}
      <div>
        <SectionHeader title="外部要因影響" caption="米株・金利・VIX・為替" />
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)',
          gap: spacing[3],
        }}>
          {/* VIX */}
          <div style={{
            ...cardStyle,
            padding: `${spacing[3]} ${spacing[4]}`,
            borderLeft: `3px solid ${vi.color}`,
          }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>VIX（恐怖指数）</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: vi.color, marginTop: spacing[1] }}>
              {market.vix.toFixed(1)}
            </div>
            <div style={{
              fontSize: '11px', fontWeight: 700, color: vi.color,
              background: vi.bg, padding: `1px ${spacing[2]}`, borderRadius: radius.sm,
              display: 'inline-block', marginTop: spacing[1],
            }}>
              {vi.label}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1], lineHeight: '1.4' }}>
              {vi.desc}
            </div>
          </div>

          {/* 米株・金利影響 */}
          <div style={{ ...cardStyle, padding: `${spacing[3]} ${spacing[4]}` }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>米株 / 金利影響</div>
            <div style={{
              fontSize: '14px', fontWeight: 700,
              color: market.regime === 'bull' ? colors.buy : market.regime === 'bear' ? colors.sell : colors.wait,
              marginTop: spacing[1],
            }}>
              {market.regime === 'bull' ? '良好 — 強気相場継続' : market.regime === 'bear' ? '警戒 — リスクオフ' : '中立 — 方向感待ち'}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2], lineHeight: '1.4' }}>
              レジーム {market.regime.toUpperCase()} / RSI {market.rsi14.toFixed(0)} / MACD {market.macd}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              {market.boj ? `日銀: ${market.boj}` : ''}
            </div>
          </div>

          {/* 為替影響 */}
          <div style={{
            ...cardStyle,
            padding: `${spacing[3]} ${spacing[4]}`,
            gridColumn: isMobile ? '1 / -1' : undefined,
          }}>
            <div style={{ ...typography.caption, color: colors.textMuted }}>為替影響（USD/JPY）</div>
            <div style={{
              fontSize: '13px', fontWeight: 600, color: colors.textPrimary,
              marginTop: spacing[1], lineHeight: '1.5',
            }}>
              {fxImpact(0.15, market.regime)}
            </div>
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
              中長期では為替は平均化される。毎月積立で為替リスクを分散。
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI グリッド ── */}
      <div style={metricsGridStyle}>
        <MetricCard title="海外株投信"   value={formatJPYAuto(overseasEval)} />
        <MetricCard title="ゴールド"     value={formatJPYAuto(goldEval)} />
        <MetricCard
          title="目標額（海外）"
          value={classTarget ? formatJPYAuto(classTarget.targetValue) : '—'}
          change={classTarget ? {
            value:    formatJPYAuto(classTarget.diffValue),
            positive: classTarget.diffValue > 0,
          } : undefined}
        />
        <MetricCard
          title="目標額（ゴールド）"
          value={goldTarget ? formatJPYAuto(goldTarget.targetValue) : '—'}
          change={goldTarget ? {
            value:    formatJPYAuto(goldTarget.diffValue),
            positive: goldTarget.diffValue > 0,
          } : undefined}
        />
        <MetricCard
          title="平均スコア"
          value={`${avgScore}`}
          change={{ value: avgScore >= 60 ? '良好' : '標準', positive: avgScore >= 60 }}
        />
        <MetricCard title="保有銘柄数" value={`${globalFunds.length}`} />
      </div>

      {/* ── 理想配分・現在配分との差分 ── */}
      {(classTarget || goldTarget) && (
        <div>
          <SectionHeader title="理想配分 / 現在配分との差分" caption="現在 vs 理想PF目標" />
          <div style={{ ...cardStyle, overflow: 'visible' }}>
            {classTarget && (
              <AllocationBar
                label="海外株投信"
                currentValue={overseasEval}
                targetValue={classTarget.targetValue}
                currentRatio={classTarget.currentRatio}
                targetRatio={classTarget.targetRatio}
                accentColor={colors.globalFundAccent}
              />
            )}
            {goldTarget && (
              <AllocationBar
                label="ゴールド"
                currentValue={goldEval}
                targetValue={goldTarget.targetValue}
                currentRatio={goldTarget.currentRatio}
                targetRatio={goldTarget.targetRatio}
                accentColor={colors.gold}
              />
            )}
            {/* 最終行ボーダー除去 */}
            <div style={{ height: '1px', marginTop: '-1px', background: colors.bgSurface }} />
          </div>
        </div>
      )}

      {/* ── 分散状況 / 重複チェック ── */}
      <div>
        <SectionHeader title="分散状況 / 重複チェック" />
        <div style={{ ...cardStyle, padding: `${spacing[4]} ${spacing[5]}` }}>
          {/* ポリシー別件数 */}
          <div style={{ display: 'flex', gap: spacing[5], flexWrap: 'wrap', marginBottom: spacing[4], paddingBottom: spacing[4], borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <div>
              <div style={{ ...typography.caption, color: colors.textMuted }}>海外株ファンド数</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: colors.globalFundAccentText, marginTop: spacing[1] }}>
                {overseasFunds.length} 件
              </div>
            </div>
            <div>
              <div style={{ ...typography.caption, color: colors.textMuted }}>ゴールドファンド数</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: colors.gold, marginTop: spacing[1] }}>
                {goldFunds.length} 件
              </div>
            </div>
            <div>
              <div style={{ ...typography.caption, color: colors.textMuted }}>最大ウェイト銘柄</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: maxWeight > 0.4 ? colors.waitText : colors.textPrimary, marginTop: spacing[1] }}>
                {maxWeightFund?.abbr ?? '—'} ({(maxWeight * 100).toFixed(1)}%)
              </div>
            </div>
          </div>

          {/* 分散チェック */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
            {/* 集中リスク */}
            {maxWeight > 0.4 ? (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: spacing[3],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.waitBg, border: `1px solid ${colors.waitBorder}`, borderRadius: radius.md,
              }}>
                <span style={{ color: colors.wait, fontSize: '14px', flexShrink: 0 }}>⚠</span>
                <span style={{ fontSize: '12px', color: colors.waitText }}>
                  {maxWeightFund?.abbr} が {(maxWeight * 100).toFixed(0)}% 超 — リバランスを検討してください（1銘柄40%超は集中リスク）
                </span>
              </div>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: spacing[3],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.buyBg, border: `1px solid ${colors.buyBorder}`, borderRadius: radius.md,
              }}>
                <span style={{ color: colors.buy, fontSize: '14px', flexShrink: 0 }}>✓</span>
                <span style={{ fontSize: '12px', color: colors.buyText }}>
                  集中リスクなし — 最大 {(maxWeight * 100).toFixed(0)}% で適切に分散されています
                </span>
              </div>
            )}

            {/* 重複チェック */}
            {hasOverlap ? (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: spacing[3],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.neutralBg, border: `1px solid ${colors.borderDefault}`, borderRadius: radius.md,
              }}>
                <span style={{ color: colors.textSubtle, fontSize: '14px', flexShrink: 0 }}>ℹ</span>
                <span style={{ fontSize: '12px', color: colors.textSubtle }}>
                  海外株ファンドが {overseasFunds.length} 件あります。銘柄の重複（全世界株と先進国株など）に注意してください
                </span>
              </div>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: spacing[3],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.buyBg, border: `1px solid ${colors.buyBorder}`, borderRadius: radius.md,
              }}>
                <span style={{ color: colors.buy, fontSize: '14px', flexShrink: 0 }}>✓</span>
                <span style={{ fontSize: '12px', color: colors.buyText }}>
                  海外株ファンド1件 — 重複なし
                </span>
              </div>
            )}

            {/* ゴールド有無 */}
            {goldFunds.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: spacing[3],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.neutralBg, border: `1px solid ${colors.borderDefault}`, borderRadius: radius.md,
              }}>
                <span style={{ color: colors.textSubtle, fontSize: '14px', flexShrink: 0 }}>ℹ</span>
                <span style={{ fontSize: '12px', color: colors.textSubtle }}>
                  ゴールドファンドなし — インフレ・地政学ヘッジとして少量保有を検討
                </span>
              </div>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: spacing[3],
                padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.goldBg, border: `1px solid ${colors.goldBorder}`, borderRadius: radius.md,
              }}>
                <span style={{ color: colors.gold, fontSize: '14px', flexShrink: 0 }}>◆</span>
                <span style={{ fontSize: '12px', color: colors.gold }}>
                  ゴールド {goldFunds.length} 件保有 — インフレ・地政学ヘッジとして機能
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 追加投資候補 ── */}
      {addCandidates.length > 0 && (
        <div>
          {/* P4-A119: isSuppressed時はタイトル・キャプションで参考表示を明確化。addCandidates生成変更なし */}
          <SectionHeader
            title={isSuppressed ? '追加投資候補（参考）' : '追加投資候補'}
            caption={isSuppressed ? 'SAFE_MODE / DQ抑制中 — 実行判断停止中' : `BUY判定 ${addCandidates.length}件`}
          />
          {isSuppressed && (
            <p style={{ fontSize: '11px', color: colors.textMuted, marginBottom: spacing[2] }}>
              抑制中のため、下記は参考表示です。追加投資判断は停止中です。
            </p>
          )}
          <div style={{ ...cardStyle, border: `1px solid ${colors.buyBorder}` }}>
            {addCandidates.map((fund, i) => {
              const accent = POLICY_ACCENT[fund.policy]
              return (
                <div key={fund.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: `${spacing[3]} ${spacing[4]}`,
                  borderBottom: i < addCandidates.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  flexWrap: 'wrap', gap: spacing[2],
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{fund.abbr}</span>
                      <span style={{
                        ...typography.caption, background: accent.bg, color: accent.text,
                        border: `1px solid ${accent.border}`, borderRadius: radius.sm, padding: `0 ${spacing[1.5]}`,
                      }}>{POLICY_SUBLABEL[fund.policy]}</span>
                    </div>
                    <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[0.5] }}>
                      {fund.name}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: spacing[3], alignItems: 'center', flexShrink: 0 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ ...typography.caption, color: colors.textMuted }}>損益率</div>
                      <div style={{ ...typography.bodySmall, color: pnlColor(fund.pnlPct), fontWeight: 700 }}>
                        {fund.pnlPct >= 0 ? '+' : ''}{fund.pnlPct.toFixed(2)}%
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ ...typography.caption, color: colors.textMuted }}>スコア</div>
                      <div style={{ ...typography.bodySmall, color: colors.buy, fontWeight: 700 }}>{fund.score}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── 海外株ファンド一覧 ── */}
      {overseasFunds.length > 0 && (
        <div>
          <SectionHeader
            title="海外株ファンド"
            caption={`${overseasFunds.length} 件 / ${formatJPYAuto(overseasEval)}`}
          />
          <div style={cardStyle}>
            {overseasFunds.map((fund, i) => (
              <FundRow key={fund.id} fund={fund} isLast={i === overseasFunds.length - 1} />
            ))}
          </div>
        </div>
      )}

      {/* ── ゴールドファンド一覧 ── */}
      {goldFunds.length > 0 && (
        <div>
          <SectionHeader
            title="ゴールドファンド"
            caption={`${goldFunds.length} 件 / ${formatJPYAuto(goldEval)}`}
          />
          <div style={{ ...cardStyle, border: `1px solid ${colors.goldBorder}` }}>
            {goldFunds.map((fund, i) => (
              <FundRow key={fund.id} fund={fund} isLast={i === goldFunds.length - 1} />
            ))}
          </div>
        </div>
      )}

      {/* ── 中長期運用方針ノート ── */}
      <div style={{
        background:   colors.globalFundAccentBg,
        border:       `1px solid ${colors.globalFundAccent}`,
        borderRadius: radius.lg,
        padding:      `${spacing[4]} ${spacing[5]}`,
      }}>
        <div style={{ ...typography.bodySmall, color: colors.globalFundAccentText, fontWeight: 700, marginBottom: spacing[2] }}>
          中長期運用方針
        </div>
        {[
          '海外投信は短期売買禁止。積立・リバランスのみ。',
          'ゴールドはインフレ・地政学リスクのヘッジとして長期保有。',
          'レジームがBEARでも積立は継続（ドルコスト）。新規一括は抑制。',
          '1銘柄が海外投信クラス内40%超の場合はリバランス検討。',
          'VIX≥30の際は追加一括投資禁止。積立のみ継続。',
        ].map((note, i) => (
          <div key={i} style={{ ...typography.caption, color: colors.globalFundAccentText, marginTop: spacing[1] }}>
            {i + 1}. {note}
          </div>
        ))}
      </div>

    </div>
  )
}
