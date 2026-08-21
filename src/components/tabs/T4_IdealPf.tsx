/**
 * T4_IdealPf — 理想ポートフォリオ / 差分
 * Phase 3: ゼロベース理想PF vs 現在PF の差分を全資産クラスで表示
 * 制約（3ヶ月ロック / 現金比率 / ノートレード）を明示
 */
import { useMemo } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useAppStore } from '../../store/useAppStore'
import { formatJPYAuto } from '../../utils/format'
import { selectMarketDataQuality, selectEffectiveCashAssumptions, selectEffectiveSafeModeActive } from '../../store/selectors'
import {
  buildIdealPfPlan,
  type FundDiffRow,
  type PfConstraint,
} from '../../domain/optimization/idealAllocation'
import { buildStockPortfolioPlan } from '../../domain/optimization/stockPortfolio'
import { CLASS_LABEL, CLASS_ROLE } from '../../types/universe'
import type { AssetClass } from '../../types/universe'

import { MetricCard }    from '../cards/MetricCard'
import { SectionHeader } from '../layout/SectionHeader'
import { PageHeader }    from '../layout/PageHeader'
import { SignalBadge }   from '../badges/SignalBadge'
import type { Signal }   from '../badges/SignalBadge'

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'
import { EMBEDDED_GOLD_EXPOSURE } from '../../constants/trust'

// ── ヘルパー ────────────────────────────────────────────────────

function diffToSignal(diffValue: number, threshold = 300_000): Signal {
  if (diffValue > threshold)  return 'BUY'
  if (diffValue < -threshold) return 'SELL'
  return 'HOLD'
}

function diffColor(diff: number, threshold = 200_000) {
  if (diff > threshold)  return colors.buy
  if (diff < -threshold) return colors.sell
  return colors.textSubtle
}

// P4-A152: SAFE_MODE/DQ抑制中はBUYバッジのみWATCH表示に変換する（表示専用）。
// SELL/TRIM/HOLD等の防御・監視シグナルは変換しない。stockPlan/jpFundRows/globalFundRows
// の元データ（row.recommendation）自体は変更しない。
function suppressBuySignal(signal: Signal, isSuppressed: boolean): Signal {
  return isSuppressed && signal === 'BUY' ? 'WATCH' : signal
}

const CLASS_ORDER: AssetClass[] = [
  'JP_STOCK', 'JP_TRUST', 'OVERSEAS_TRUST', 'GOLD', 'CASH', 'CASH_RESERVE',
]

// accent/accentBgは装飾用途（ドット・ドーナツ・バー背景、非text）専用。
// accentTextはテキスト色専用のAA 4.5:1達成済みvariant（raw accentをtext流用しない）。
const CLASS_ACCENT: Partial<Record<AssetClass, { accent: string; accentBg: string; accentText: string }>> = {
  JP_STOCK:       { accent: colors.stockAccent,      accentBg: colors.stockAccentBg,      accentText: colors.stockAccentText },
  JP_TRUST:       { accent: colors.jpFundAccent,     accentBg: colors.jpFundAccentBg,     accentText: colors.jpFundAccentText },
  OVERSEAS_TRUST: { accent: colors.globalFundAccent, accentBg: colors.globalFundAccentBg, accentText: colors.globalFundAccentText },
  GOLD:           { accent: colors.gold,             accentBg: colors.goldBg,             accentText: colors.gold },
  CASH:           { accent: colors.neutral,          accentBg: colors.neutralBg,          accentText: colors.holdText },
  CASH_RESERVE:   { accent: colors.neutral,          accentBg: colors.neutralBg,          accentText: colors.holdText },
}

function actionTypeMeta(text: string) {
  if (/買い?増し|追加買付|買付|BUY/i.test(text))
    return { color: colors.buyText,  bg: colors.buyBg,  border: colors.buyBorder,  icon: '↑', label: '買付' }
  if (/売却|SELL|解約/i.test(text))
    return { color: colors.sellText, bg: colors.sellBg, border: colors.sellBorder, icon: '↓', label: '売却' }
  if (/現金|キャッシュ|待機|CASH/i.test(text))
    return { color: colors.waitText, bg: colors.waitBg, border: colors.waitBorder, icon: '●', label: '現金' }
  return { color: colors.textSubtle, bg: colors.bgElevated, border: colors.borderSubtle, icon: '→', label: 'その他' }
}

// ── コンポーネント ──────────────────────────────────────────────

export function T4_IdealPf() {
  const isMobile = useIsMobile()
  const holdings   = useAppStore(s => s.holdings)
  const trust      = useAppStore(s => s.trust)
  const market     = useAppStore(s => s.market)
  const metrics    = useAppStore(s => s.metrics)
  const analysis   = useAppStore(s => s.analysis)
  const effectiveCash = useAppStore(selectEffectiveCashAssumptions)
  // CASH-AUTH-1: 総現金を「安全余力」とそれ以外に割った派生表示値。
  // cash + cashReserve は常に grossCash と等しく二重計上されない。
  // addRoom は撤廃済みで金額には一切寄与しない。
  const cash       = Math.max(0, effectiveCash.grossCash - effectiveCash.safetyReserve)
  const cashReserve = Math.min(effectiveCash.safetyReserve, effectiveCash.grossCash)
  const macro      = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  // P4.5-A011: T9のjpStockMaxRatio設定をT4のbuildAssetUniverse計算にも反映する
  // （buildAssetUniverseはstate.portfolioPolicy?.jpStockMaxRatioを参照するため、
  // 欠落するとレジーム別デフォルト比率にフォールバックし、store産universeとズレる）。
  const portfolioPolicy = useAppStore(s => s.portfolioPolicy)
  const dq              = useAppStore(selectMarketDataQuality)
  // P4.5-A011: safe_mode.jsonのraw activeだけでなく、鮮度によるfail-closedも含めて判定する
  const safeModeActive  = useAppStore(selectEffectiveSafeModeActive)
  const isSuppressed    = safeModeActive || dq.isSuppressed

  // AppState-like for buildIdealPfPlan
  const partialState = useMemo(() => ({
    holdings, trust, market, metrics, analysis,
    cash, cashReserve, macro, sqCalendar, portfolioPolicy,
    // non-required for this plan:
    correlation: null, news: null, system: null as unknown as import('../../types').SystemState,
    activeTab: 'T4' as import('../../types').TabId,
    universe: null, learning: null,
    flows: null, margin: null,
  }), [holdings, trust, market, metrics, analysis, cash, cashReserve, macro, sqCalendar, portfolioPolicy])

  const plan = useMemo(
    () => buildIdealPfPlan(partialState as import('../../types').AppState),
    [partialState],
  )

  const stockPlan = useMemo(
    () => buildStockPortfolioPlan(holdings, analysis, {
      targetTotalValue: plan.universe.categories.find(c => c.class === 'JP_STOCK')?.targetValue,
    }),
    [holdings, analysis, plan.universe],
  )

  const { universe, constraints, jpFundRows, globalFundRows, actionSummary } = plan

  const orderedCats = CLASS_ORDER
    .map(cls => universe.categories.find(c => c.class === cls))
    .filter((c): c is NonNullable<typeof c> => !!c)

  const blockConstraints = constraints.filter((c: PfConstraint) => c.severity === 'block')
  const warnConstraints  = constraints.filter((c: PfConstraint) => c.severity === 'warn')
  const infoConstraints  = constraints.filter((c: PfConstraint) => c.severity === 'info')

  // 差分サマリー集計
  const totalToBuy  = orderedCats.reduce((s, c) => c.diffValue > 0 ? s + c.diffValue : s, 0)
  const totalToSell = orderedCats.reduce((s, c) => c.diffValue < 0 ? s + Math.abs(c.diffValue) : s, 0)

  // ── スタイル ───────────────────────────────────────────────

  const panelStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[5],
    padding:       isMobile ? `${spacing[4]} ${spacing[3]}` : `${spacing[5]} ${spacing[5]}`,
    maxWidth:      '960px',
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

  // ── サブコンポーネント ─────────────────────────────────────

  function AllocationDonut() {
    const r = 48, cx = 60, cy = 60
    const C = 2 * Math.PI * r
    let cum = 0
    const segs = orderedCats
      .filter(c => c.currentRatio > 0.005)
      .map(cat => {
        const color = (CLASS_ACCENT[cat.class] ?? { accent: colors.neutral }).accent
        const seg = {
          key:        cat.class,
          color,
          dashArray:  `${cat.currentRatio * C} ${C}`,
          dashOffset: -(cum * C),
        }
        cum += cat.currentRatio
        return seg
      })
    return (
      <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={colors.bgElevated} strokeWidth="14" />
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {segs.map(s => (
            <circle key={s.key} cx={cx} cy={cy} r={r}
              fill="none" stroke={s.color} strokeWidth="14"
              strokeDasharray={s.dashArray}
              strokeDashoffset={String(s.dashOffset)}
            />
          ))}
        </g>
        <text x="60" y="57" textAnchor="middle" fontSize="10" fontWeight="700" fill={colors.textPrimary}>現在</text>
        <text x="60" y="70" textAnchor="middle" fontSize="9"  fill={colors.textSubtle}>配分</text>
      </svg>
    )
  }

  function AllocRow({ cat }: { cat: typeof orderedCats[0] }) {
    const accent  = CLASS_ACCENT[cat.class] ?? { accent: colors.neutral, accentBg: colors.neutralBg, accentText: colors.holdText }
    const isOver  = cat.currentRatio > cat.targetRatio + 0.01
    const isUnder = cat.currentRatio < cat.targetRatio - 0.01
    // 現在/目標の大きい方を100%として正規化（T3パターン）
    const maxRatio   = Math.max(cat.currentRatio, cat.targetRatio, 0.01)
    const currentPct = Math.min(100, Math.round((cat.currentRatio / maxRatio) * 100))
    const targetPct  = Math.min(100, Math.round((cat.targetRatio  / maxRatio) * 100))
    const ptDiff     = (cat.currentRatio - cat.targetRatio) * 100 // %pt差分（表示専用）
    const ptDiffStr  = `${ptDiff >= 0 ? '+' : ''}${ptDiff.toFixed(1)}pt`
    const barAccent  = isOver ? colors.wait : accent.accent

    return (
      <div style={{ padding: `${spacing[4]} ${spacing[5]}` }}>
        {/* ヘッダー: クラス名 + ロール + SignalBadge */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing[3] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
            <div style={{
              width: '10px', height: '10px',
              borderRadius: '3px',
              background: accent.accent,
              flexShrink: 0,
            }} />
            <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>
              {CLASS_LABEL[cat.class]}
            </span>
            <span style={{ ...typography.caption, color: colors.textSubtle }}>
              {CLASS_ROLE[cat.class]}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
            <span style={{
              ...typography.caption, fontWeight: 700,
              color: isOver ? colors.waitText : isUnder ? accent.accentText : colors.textMuted,
            }}>
              {ptDiffStr}
            </span>
            <SignalBadge signal={diffToSignal(cat.diffValue)} size="sm" />
          </div>
        </div>

        {/* 2色横バー比較（T3パターン / 表示専用） */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1.5], marginBottom: spacing[3] }}>
          {/* 現在バー */}
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
            <span style={{
              ...typography.caption, color: colors.textMuted,
              width: '28px', flexShrink: 0, textAlign: 'right',
            }}>現在</span>
            <div style={{
              flex: 1, height: '8px',
              background: colors.bgElevated, borderRadius: radius.full, overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${currentPct}%`,
                background: barAccent, borderRadius: radius.full,
                transition: 'width 0.4s ease',
              }} />
            </div>
            <span style={{
              ...typography.caption, fontWeight: 700,
              color: isOver ? colors.waitText : colors.textPrimary,
              width: '44px', textAlign: 'right', flexShrink: 0,
            }}>
              {(cat.currentRatio * 100).toFixed(1)}%
            </span>
          </div>
          {/* 目標バー */}
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
            <span style={{
              ...typography.caption, color: colors.textMuted,
              width: '28px', flexShrink: 0, textAlign: 'right',
            }}>目標</span>
            <div style={{
              flex: 1, height: '8px',
              background: colors.bgElevated, borderRadius: radius.full, overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${targetPct}%`,
                background: `${accent.accent}55`,
                borderRadius: radius.full,
                border: `1px solid ${accent.accent}77`,
              }} />
            </div>
            <span style={{
              ...typography.caption, fontWeight: 700, color: colors.textSubtle,
              width: '44px', textAlign: 'right', flexShrink: 0,
            }}>
              {(cat.targetRatio * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        {/* フッター: 金額サマリー */}
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing[2] }}>
          <div style={{ display: 'flex', gap: spacing[3], flexWrap: 'wrap' }}>
            <span style={{ ...typography.caption, color: colors.textSubtle }}>
              現在 <strong style={{ color: colors.textPrimary }}>
                {formatJPYAuto(cat.currentValue)}
              </strong>
            </span>
            <span style={{ ...typography.caption, color: colors.textSubtle }}>
              目標 <strong style={{ color: colors.textPrimary }}>
                {formatJPYAuto(cat.targetValue)}
              </strong>
            </span>
          </div>
          <span style={{
            ...typography.caption,
            color:      diffColor(cat.diffValue),
            fontWeight: 700,
          }}>
            {cat.diffValue >= 0 ? '+' : ''}{formatJPYAuto(cat.diffValue)}
          </span>
        </div>
      </div>
    )
  }

  function FundRow({ row, isLast, isSuppressed }: { row: FundDiffRow; isLast: boolean; isSuppressed: boolean }) {
    const accentColor =
      row.policy === 'JAPAN_SHORTTERM'   ? colors.jpFundAccent :
      row.policy === 'OVERSEAS_LONGTERM' ? colors.globalFundAccent :
      colors.gold

    // P4-A152: SAFE_MODE/DQ抑制中はBUYバッジのみWATCHへ変換（表示専用。row.recommendationは変更しない）
    const isBuySuppressed = isSuppressed && row.recommendation === 'BUY'
    const recSignal: Signal = suppressBuySignal(
      row.recommendation === 'BUY'  ? 'BUY' :
      row.recommendation === 'SELL' ? 'SELL' : 'HOLD',
      isSuppressed,
    )

    return (
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        `${spacing[3]} ${spacing[5]}`,
        borderBottom:   isLast ? 'none' : `1px solid ${colors.borderSubtle}`,
        gap:            spacing[3],
        flexWrap:       'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
            <div style={{
              width: '6px', height: '6px',
              borderRadius: '50%',
              background: accentColor,
              flexShrink: 0,
            }} />
            <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 600 }}>
              {row.abbr}
            </span>
            <SignalBadge signal={recSignal} size="sm" />
          </div>
          <div style={{ ...typography.caption, color: colors.textSubtle, marginLeft: spacing[4], marginTop: spacing[0.5] }}>
            スコア {row.score} / EV {row.ev.toFixed(3)}
            {isBuySuppressed && (
              <span style={{ color: colors.waitText, fontWeight: 600 }}> — SAFE_MODE/DQ抑制中: 買付は参考停止</span>
            )}
          </div>
          {EMBEDDED_GOLD_EXPOSURE[row.id] && (() => {
            const ex = EMBEDDED_GOLD_EXPOSURE[row.id]
            return (
              <div style={{ ...typography.caption, color: colors.gold, marginLeft: spacing[4], marginTop: spacing[0.5] }}>
                内包GOLD {Math.round(ex.navGoldExposure * 100)}%相当 / 総EX内{Math.round(ex.grossGoldShare * 100)}%
              </div>
            )
          })()}
        </div>
        <div style={{ display: 'flex', gap: spacing[4], alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {[
            { label: '現在',  val: formatJPYAuto(row.currentValue), col: colors.textPrimary },
            { label: '目標',  val: formatJPYAuto(row.targetValue),  col: colors.textPrimary },
            { label: '差分',  val: `${row.diffValue >= 0 ? '+' : ''}${formatJPYAuto(row.diffValue)}`,
              col: diffColor(row.diffValue) },
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

  function StockRow({ row, isLast, isSuppressed }: { row: typeof stockPlan.rows[0]; isLast: boolean; isSuppressed: boolean }) {
    // P4-A152: SAFE_MODE/DQ抑制中はBUYバッジのみWATCHへ変換（表示専用。row.recommendationは変更しない）
    const isBuySuppressed = isSuppressed && row.recommendation === 'BUY'
    const recSignal: Signal = suppressBuySignal(
      row.recommendation === 'BUY'  ? 'BUY'  :
      row.recommendation === 'SELL' ? 'SELL' : 'HOLD',
      isSuppressed,
    )

    return (
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        `${spacing[3]} ${spacing[5]}`,
        borderBottom:   isLast ? 'none' : `1px solid ${colors.borderSubtle}`,
        gap:            spacing[3],
        flexWrap:       'wrap',
        opacity:        row.locked ? 0.7 : 1,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* P0-4: 390px以下で銘柄名が1文字縦列化する崩壊を修正。
              minWidth:0 で行を縮小可能にし、名前はnowrap+ellipsisで通常の横書きを維持する */}
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], minWidth: 0 }}>
            <span style={{
              ...typography.bodySmall, color: colors.textPrimary, fontWeight: 600,
              minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {row.name}
            </span>
            <SignalBadge signal={recSignal} size="sm" />
            {row.locked && (
              <span style={{
                ...typography.caption,
                background: colors.holdBg, color: colors.holdText,
                border: `1px solid ${colors.holdBorder}`,
                borderRadius: radius.sm,
                padding: `0 ${spacing[1.5]}`,
              }}>
                ロック{row.lockRemainingDays}日
              </span>
            )}
          </div>
          <div style={{ ...typography.caption, color: colors.textSubtle, marginTop: spacing[0.5] }}>
            {row.reason} / スコア {row.score}
            {isBuySuppressed && (
              <span style={{ color: colors.waitText, fontWeight: 600 }}> — SAFE_MODE/DQ抑制中: 買付は参考停止</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: spacing[4], alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {[
            { label: '現在',  val: formatJPYAuto(row.currentValue), col: colors.textPrimary },
            { label: '目標',  val: formatJPYAuto(row.targetValue),  col: colors.textPrimary },
            { label: '差分',  val: `${row.diffValue >= 0 ? '+' : ''}${formatJPYAuto(row.diffValue)}`,
              col: diffColor(row.diffValue) },
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

  function SuppressedReferenceNotice() {
    if (!isSuppressed) return null
    const reason = safeModeActive ? 'SAFE_MODE有効' : 'データ品質抑制中'
    return (
      <div style={{
        background: colors.waitBg, border: `1px solid ${colors.waitBorder}`,
        borderRadius: radius.lg, padding: `${spacing[4]} ${spacing[5]}`,
        display: 'flex', alignItems: 'flex-start', gap: spacing[3],
      }}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
        <div>
          <div style={{ ...typography.bodySmall, color: colors.waitText, fontWeight: 700, marginBottom: spacing[1] }}>
            {reason} — 抑制中・参考表示
          </div>
          <div style={{ ...typography.caption, color: colors.waitText }}>
            理想PF差分は参考です。実行判断停止中 — 新規買付・売却の実行指示ではありません。
          </div>
        </div>
      </div>
    )
  }

  const DIFF_THRESHOLD = 200_000
  function DiffHighlightCards() {
    const toAdd  = orderedCats.filter(c => c.diffValue >  DIFF_THRESHOLD)
    const toSell = orderedCats.filter(c => c.diffValue < -DIFF_THRESHOLD)
    const toHold = orderedCats.filter(c => Math.abs(c.diffValue) <= DIFF_THRESHOLD)

    const col3Style = {
      display: 'grid' as const,
      gridTemplateColumns: isMobile ? 'repeat(1, 1fr)' : 'repeat(3, 1fr)',
      gap: spacing[3],
    }

    function DiffCol({
      label, items, colorText, colorBg, colorBorder, sign = '',
    }: {
      label: string
      items: typeof orderedCats
      colorText: string
      colorBg: string
      colorBorder: string
      sign?: string
    }) {
      return (
        <div style={{
          background: colorBg, border: `1px solid ${colorBorder}`,
          borderRadius: radius.lg, padding: `${spacing[3]} ${spacing[4]}`,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: colorText,
            textTransform: 'uppercase' as const, letterSpacing: '0.06em',
            marginBottom: spacing[2],
          }}>
            {label}
          </div>
          {items.length === 0
            ? <div style={{ ...typography.caption, color: colors.textMuted }}>対象なし</div>
            : items.map(c => (
                <div key={c.class} style={{
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'baseline', marginTop: spacing[1],
                }}>
                  <span style={{ ...typography.caption, color: colorText, fontWeight: 600 }}>
                    {CLASS_LABEL[c.class]}
                  </span>
                  <span style={{ ...typography.caption, color: colorText, fontWeight: 700 }}>
                    {sign}{formatJPYAuto(Math.abs(c.diffValue))}
                  </span>
                </div>
              ))
          }
        </div>
      )
    }

    return (
      <div style={col3Style}>
        <DiffCol
          label="増やす" items={toAdd}
          colorText={colors.buyText} colorBg={colors.buyBg} colorBorder={colors.buyBorder}
          sign="+"
        />
        <DiffCol
          label="減らす" items={toSell}
          colorText={colors.sellText} colorBg={colors.sellBg} colorBorder={colors.sellBorder}
          sign="−"
        />
        <DiffCol
          label="維持/許容" items={toHold}
          colorText={colors.holdText} colorBg={colors.holdBg} colorBorder={colors.holdBorder}
        />
      </div>
    )
  }

  // ── レンダリング ─────────────────────────────────────────────

  return (
    <div style={panelStyle}>

      {/* ── ページタイトル（P1-5: TAB_META再利用のPageHeaderへ統一） ── */}
      <PageHeader tabId="T4" />

      {/* ── 抑制中参考表示バナー ── */}
      <SuppressedReferenceNotice />

      {/* ── 配分ヒーローカード（総資産 + ドーナツ + 凡例） ── */}
      <div style={cardStyle}>
        <div style={{
          padding: `${spacing[4]} ${spacing[5]}`,
          borderBottom: `1px solid ${colors.borderSubtle}`,
        }}>
          <div style={{ ...typography.caption, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: spacing[1] }}>
            総資産（現在）
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.04em', color: colors.textPrimary, lineHeight: 1.2 }}>
            {formatJPYAuto(universe.totalValue)}
          </div>
          <div style={{ ...typography.caption, color: colors.textSubtle, marginTop: spacing[1] }}>
            レジーム: {market.regime.toUpperCase()} — 目標乖離合計: {formatJPYAuto(totalToBuy - totalToSell)}
          </div>
        </div>
        <div className="t4-hero-body">
          <AllocationDonut />
          <div className="t4-hero-legend">
            {orderedCats.filter(c => c.currentRatio > 0.005 || c.currentValue > 10_000).map(cat => {
              const accent = CLASS_ACCENT[cat.class] ?? { accent: colors.neutral, accentBg: colors.neutralBg }
              const diff   = cat.diffValue
              return (
                <div key={cat.class} className="t4-hero-legend__row">
                  <span className="t4-hero-legend__dot" style={{ background: accent.accent }} />
                  <span className="t4-hero-legend__name">{CLASS_LABEL[cat.class]}</span>
                  <span className="t4-hero-legend__pct">{(cat.currentRatio * 100).toFixed(1)}%</span>
                  <span className="t4-hero-legend__arrow">→</span>
                  <span className="t4-hero-legend__target">{(cat.targetRatio * 100).toFixed(0)}%</span>
                  {diff !== 0 && (
                    <span className="t4-hero-legend__diff" style={{ color: diffColor(diff) }}>
                      {diff > 0 ? '+' : ''}{formatJPYAuto(diff)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── 差分サマリーバナー（要追加 / 要削減） ── */}
      <div className="t4-diff-row">
        <div className="t4-diff-cell t4-diff-cell--buy">
          <div className="t4-diff-cell__label">要追加</div>
          <div className="t4-diff-cell__value">+{formatJPYAuto(totalToBuy)}</div>
          <div className="t4-diff-cell__sub">BUY 対象資産クラス</div>
        </div>
        <div className="t4-diff-cell t4-diff-cell--sell">
          <div className="t4-diff-cell__label">要削減</div>
          <div className="t4-diff-cell__value">−{formatJPYAuto(totalToSell)}</div>
          <div className="t4-diff-cell__sub">SELL 対象資産クラス</div>
        </div>
      </div>

      {/* ── 差分ハイライト3列カード（増やす/減らす/維持） ── */}
      <DiffHighlightCards />

      {/* ── 緊急制約 ── */}
      {blockConstraints.length > 0 && (
        <div style={{
          background: colors.sellBg, border: `1px solid ${colors.sellBorder}`,
          borderRadius: radius.lg, padding: `${spacing[4]} ${spacing[5]}`,
        }}>
          <div style={{ ...typography.bodySmall, color: colors.sellText, fontWeight: 700, marginBottom: spacing[2] }}>
            取引禁止
          </div>
          {blockConstraints.map((c, i) => (
            <div key={i} style={{ ...typography.caption, color: colors.sellText, marginTop: spacing[1] }}>
              {c.message}
            </div>
          ))}
        </div>
      )}

      {/* ── 警告制約 ── */}
      {warnConstraints.length > 0 && (
        <div style={{
          background: colors.waitBg, border: `1px solid ${colors.waitBorder}`,
          borderRadius: radius.lg, padding: `${spacing[4]} ${spacing[5]}`,
        }}>
          <div style={{ ...typography.bodySmall, color: colors.waitText, fontWeight: 700, marginBottom: spacing[2] }}>
            警戒事項
          </div>
          {warnConstraints.map((c, i) => (
            <div key={i} style={{ ...typography.caption, color: colors.waitText, marginTop: spacing[1] }}>
              • {c.message}
            </div>
          ))}
        </div>
      )}

      {/* ── KPI グリッド ── */}
      <div style={metricsGridStyle}>
        <MetricCard title="総資産"        value={formatJPYAuto(universe.totalValue)} />
        <MetricCard
          title="現金"
          value={formatJPYAuto(universe.cash)}
          change={{ value: universe.cash < universe.cashReserve * 0.5 ? '不足' : '十分', positive: universe.cash >= universe.cashReserve * 0.5 }}
        />
        <MetricCard title="暴落待機資金"   value={formatJPYAuto(universe.cashReserve)} />
        <MetricCard
          title="個別株ロック"
          value={`${stockPlan.lockCount} 件`}
          change={stockPlan.lockCount > 0 ? { value: '売却制約あり', positive: false } : undefined}
        />
        <MetricCard title="制約件数"      value={`${constraints.length}`} />
        <MetricCard title="アクション候補" value={`${actionSummary.length} 件`} />
      </div>

      {/* ── 今週のアクションサマリー ── */}
      {actionSummary.length > 0 && (
        <div>
          <SectionHeader
            title="今週のアクション候補"
            caption={isSuppressed ? '参考表示 — 実行判断停止中' : '優先度順'}
          />
          {isSuppressed && (
            <div style={{
              ...typography.caption,
              color: colors.waitText, background: colors.waitBg,
              border: `1px solid ${colors.waitBorder}`,
              borderRadius: `${radius.lg} ${radius.lg} 0 0`,
              padding: `${spacing[2]} ${spacing[5]}`,
              borderBottom: 'none',
            }}>
              ⚠️ 抑制中 — 以下は参考情報です。新規買付・売却の実行判断ではありません。
            </div>
          )}
          <div style={{
            ...cardStyle,
            ...(isSuppressed ? { borderRadius: `0 0 ${radius.lg} ${radius.lg}`, borderTop: 'none' } : {}),
          }}>
            {actionSummary.map((item, i) => {
              const meta = actionTypeMeta(item)
              return (
                <div key={i} style={{
                  display:      'flex',
                  alignItems:   'flex-start',
                  gap:          spacing[3],
                  padding:      `${spacing[3]} ${spacing[5]}`,
                  borderBottom: i < actionSummary.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                }}>
                  <div style={{
                    ...typography.caption,
                    background: colors.bgElevated, color: colors.textSubtle,
                    borderRadius: radius.sm,
                    padding:    `${spacing[0.5]} ${spacing[2]}`,
                    minWidth:   20, textAlign: 'center',
                    fontWeight: 700, flexShrink: 0,
                  }}>
                    {i + 1}
                  </div>
                  <span style={{
                    ...typography.caption,
                    background: meta.bg, color: meta.color,
                    border: `1px solid ${meta.border}`,
                    borderRadius: radius.sm,
                    padding: `0 ${spacing[2]}`,
                    fontWeight: 700, flexShrink: 0,
                    lineHeight: '20px',
                  }}>
                    {meta.icon} {meta.label}
                  </span>
                  <div style={{ ...typography.bodySmall, color: colors.textPrimary, flex: 1 }}>
                    {item}
                    {isSuppressed && (
                      <span style={{
                        ...typography.caption,
                        color: colors.waitText, fontWeight: 600,
                        marginLeft: spacing[2],
                      }}>（参考）</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── 資産クラス配分 ── */}
      <div>
        <SectionHeader
          title="資産クラス配分"
          caption={`総資産 ${formatJPYAuto(universe.totalValue)} / レジーム: ${market.regime.toUpperCase()}`}
        />
        <div style={cardStyle}>
          {orderedCats.map((cat, i) => (
            <div key={cat.class} style={{
              borderBottom: i < orderedCats.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
            }}>
              <AllocRow cat={cat} />
            </div>
          ))}
        </div>
      </div>

      {/* ── 個別株差分 ── */}
      {stockPlan.rebalanceTop.length > 0 && (
        <div>
          <SectionHeader
            title="個別株 差分ランキング"
            caption={`ロック ${stockPlan.lockCount} 件`}
          />
          <div style={cardStyle}>
            {stockPlan.rebalanceTop.slice(0, 8).map((row, i) => (
              <StockRow
                key={row.code}
                row={row}
                isLast={i === Math.min(stockPlan.rebalanceTop.length, 8) - 1}
                isSuppressed={isSuppressed}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── 国内株投信 差分 ── */}
      {jpFundRows.length > 0 && (
        <div>
          <SectionHeader title="国内株投信 差分" caption="スコア重み付き按分" />
          <div style={cardStyle}>
            {jpFundRows.map((row, i) => (
              <FundRow key={row.id} row={row} isLast={i === jpFundRows.length - 1} isSuppressed={isSuppressed} />
            ))}
          </div>
        </div>
      )}

      {/* ── 海外投信 差分 ── */}
      {globalFundRows.length > 0 && (
        <div>
          <SectionHeader title="海外投信 差分" caption="スコア重み付き按分" />
          <div style={cardStyle}>
            {globalFundRows.map((row, i) => (
              <FundRow key={row.id} row={row} isLast={i === globalFundRows.length - 1} isSuppressed={isSuppressed} />
            ))}
          </div>
        </div>
      )}

      {/* ── ロック制約一覧 ── */}
      {infoConstraints.length > 0 && (
        <div>
          <SectionHeader title="売却制約（3ヶ月ロック）" caption={`${infoConstraints.length} 件`} />
          <div style={cardStyle}>
            {infoConstraints.map((c, i) => (
              <div key={i} style={{
                display:      'flex',
                alignItems:   'center',
                gap:          spacing[3],
                padding:      `${spacing[3]} ${spacing[5]}`,
                borderBottom: i < infoConstraints.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
              }}>
                <div style={{
                  width: '8px', height: '8px',
                  borderRadius: '50%', background: colors.holdBorder, flexShrink: 0,
                }} />
                <span style={{ ...typography.bodySmall, color: colors.textPrimary }}>
                  {c.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
