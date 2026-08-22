/**
 * T1_Decision — V10 Phase 6: 個別株詳細画面
 * 資産クラス: jp_stock のみ
 * 構成: 銘柄一覧 → 銘柄詳細（タップで遷移）
 * 表示順: 結論 → 根拠 → リスク → 行動
 */
import { useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useAppStore } from '../../store/useAppStore'
import { selectMarketDataQuality, selectEffectiveSafeModeActive, selectCandidateDecisionSynthesis } from '../../store/selectors'
import { formatJPYAuto, formatSignedPct } from '../../utils/format'
import { SectionHeader } from '../layout/SectionHeader'
import { PageHeader } from '../layout/PageHeader'
import { EmptyState } from '../shared/EmptyState'
import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'
import type { Holding, HoldingAnalysis, StockScoreRecord, ScoreAxisId, OfficialDecisionItem } from '../../types'
import type { StockCandidateItem } from '../../types/candidatesStocks'
import { SixAxisRadar, CANONICAL_AXES_ORDER, AXIS_LABEL, AXIS_COLOR } from '../charts/SixAxisRadar'
import { CircularGauge } from '../charts/CircularGauge'
import { deriveDisplayDecision, type DisplayDecision } from '../../domain/analysis/displayDecision'
import { isSellLocked, getSellableDate } from '../../domain/constraints/stockLock'
import { TIER_A_T1_STOP_LOSS_PCT } from '../../domain/constraints/tierAT1'
import { computeHoldingsStale } from './T0_Home'
import { CandidateFunnelPanel } from '../candidates/CandidateFunnelPanel'
import { AssetTypeBadge } from '../badges/AssetTypeBadge'
import {
  SYNTHESIS_ACTION_LABEL,
  labelBlockedReasons,
  labelWarnings,
  labelLimitingFactors,
  synthesisNonExecutableReasonText,
} from '../candidates/candidateDecisionSynthesisPresentation'
import type { CandidateDecisionSynthesisEntry, SynthesisAction } from '../../types/candidateDecisionSynthesis'

// ── ユーティリティ ────────────────────────────────────────────

function rankColors(rank: string) {
  if (rank === 'S') return { bg: colors.goldBg,        text: colors.gold,          border: colors.goldBorder }
  if (rank === 'A') return { bg: colors.buyBg,         text: colors.buyText,       border: colors.buyBorder }
  if (rank === 'B') return { bg: colors.stockAccentBg,  text: colors.stockAccentText, border: '#93c5fd' }
  if (rank === 'C') return { bg: colors.holdBg,         text: colors.holdText,      border: colors.holdBorder }
  if (rank === 'D') return { bg: colors.waitBg,         text: colors.waitText,      border: colors.waitBorder }
  return              { bg: colors.sellBg,         text: colors.sellText,      border: colors.sellBorder }
}

function decisionColors(d: string) {
  if (d === 'BUY')  return { bg: colors.buyBg,  text: colors.buyText,  border: colors.buyBorder }
  if (d === 'SELL') return { bg: colors.sellBg, text: colors.sellText, border: colors.sellBorder }
  return                   { bg: colors.holdBg, text: colors.holdText, border: colors.holdBorder }
}

// ── displayDecisionLabel ──────────────────────────────────────
// deriveDisplayDecision は ../../domain/analysis/displayDecision からインポート

function displayDecisionLabel(d: DisplayDecision): string {
  if (d === 'BUY')                      return 'BUY'
  if (d === 'SELL')                     return 'SELL'
  if (d === 'WAIT' || d === 'DATA_WAIT') return 'WAIT'
  return 'HOLD'
}

// ── EightAxisRadar (UI-9-1b: 8軸 SVG レーダー) ───────────────
// axes: [{label, value(0-100)}] × 8
// 基準値ライン = 50（calculation-only / not an order）

const RADAR_N  = 8
const RADAR_CX = 130
const RADAR_CY = 134  // やや下にずらしてトップラベルの余白を確保
const RADAR_R  = 80   // 外周半径

// 軸 i のラジアン角（上 = -90° スタート、時計回り）
function radarAngle(i: number) {
  return ((i * 360 / RADAR_N) - 90) * (Math.PI / 180)
}

// 中心から距離 r、軸 i の座標
function radarPt(r: number, i: number) {
  const a = radarAngle(i)
  return { x: RADAR_CX + r * Math.cos(a), y: RADAR_CY + r * Math.sin(a) }
}

// 点列 → SVG polygon points 文字列
function pts2str(pts: Array<{x:number;y:number}>) {
  return pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

type TextAnchor = 'start' | 'middle' | 'end'

// 軸 i のラベルテキスト配置プロパティ
const AXIS_TEXT_PROPS: Array<{anchor: TextAnchor; dy: string}> = [
  { anchor: 'middle', dy: '-4'  }, // 0: top
  { anchor: 'start',  dy: '-2'  }, // 1: top-right
  { anchor: 'start',  dy:  '4'  }, // 2: right
  { anchor: 'start',  dy: '10'  }, // 3: bottom-right
  { anchor: 'middle', dy: '12'  }, // 4: bottom
  { anchor: 'end',    dy: '10'  }, // 5: bottom-left
  { anchor: 'end',    dy:  '4'  }, // 6: left
  { anchor: 'end',    dy: '-2'  }, // 7: top-left
]

function EightAxisRadar({ axes, accentColor = colors.stockAccent }: {
  axes: Array<{label: string; value: number}>
  accentColor?: string
}) {
  if (axes.length < 8) return null

  const levelRadii = [0.25, 0.5, 0.75, 1.0].map(f => RADAR_R * f)
  const scorePoints  = axes.map((ax, i) => radarPt(RADAR_R * (Math.min(100, Math.max(0, ax.value)) / 100), i))
  const baselinePoints = axes.map((_, i) => radarPt(RADAR_R * 0.5, i))
  const outerPoints    = axes.map((_, i) => radarPt(RADAR_R, i))
  const labelR = RADAR_R + 20

  return (
    <div style={{ padding: '0 12px' }}>
      <svg
        viewBox="0 0 260 268"
        style={{ width: '100%', maxWidth: '280px', display: 'block', margin: '0 auto', overflow: 'visible' }}
        aria-hidden="true"
      >
        {/* グリッド同心多角形 */}
        {levelRadii.map((r, li) => (
          <polygon
            key={li}
            points={pts2str(axes.map((_, i) => radarPt(r, i)))}
            fill="none"
            stroke={colors.borderDefault}
            strokeWidth={li === 3 ? 1 : 0.7}
            opacity={0.6}
          />
        ))}

        {/* 軸線 */}
        {outerPoints.map((op, i) => (
          <line
            key={i}
            x1={RADAR_CX} y1={RADAR_CY}
            x2={op.x.toFixed(1)} y2={op.y.toFixed(1)}
            stroke={colors.borderSubtle}
            strokeWidth={0.7}
          />
        ))}

        {/* 基準値ライン（50） */}
        <polygon
          points={pts2str(baselinePoints)}
          fill="none"
          stroke={colors.textMuted}
          strokeWidth={1.2}
          strokeDasharray="4 3"
          opacity={0.5}
        />

        {/* スコア polygon */}
        <polygon
          points={pts2str(scorePoints)}
          fill={accentColor}
          fillOpacity={0.15}
          stroke={accentColor}
          strokeWidth={1.8}
        />

        {/* スコアドット */}
        {scorePoints.map((p, i) => (
          <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={3} fill={accentColor} />
        ))}

        {/* グリッド値ラベル (25/50/75、上軸沿い) */}
        {[25, 50, 75].map(v => {
          const p = radarPt(RADAR_R * (v / 100), 0)
          return (
            <text key={v} x={(p.x + 4).toFixed(1)} y={p.y.toFixed(1)}
              fontSize="8" fill={colors.textMuted} textAnchor="start" dominantBaseline="middle">
              {v}
            </text>
          )
        })}

        {/* 軸ラベル */}
        {axes.map((ax, i) => {
          const p = radarPt(labelR, i)
          const { anchor, dy } = AXIS_TEXT_PROPS[i] ?? { anchor: 'middle', dy: '0' }
          return (
            <text key={i} x={p.x.toFixed(1)} y={p.y.toFixed(1)}
              fontSize="10" fontWeight="600" fill={colors.textPrimary}
              textAnchor={anchor} dy={dy}>
              {ax.label}
            </text>
          )
        })}
      </svg>

      {/* 凡例 */}
      <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '6px', fontSize: '10px', color: colors.textMuted }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <svg width="18" height="8" style={{ display: 'block' }}>
            <line x1="0" y1="4" x2="18" y2="4" stroke={accentColor} strokeWidth="2"/>
            <circle cx="9" cy="4" r="2.5" fill={accentColor}/>
          </svg>
          <span>自社スコア</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <svg width="18" height="8" style={{ display: 'block' }}>
            <line x1="0" y1="4" x2="18" y2="4" stroke={colors.textMuted} strokeWidth="1.5" strokeDasharray="4 3"/>
          </svg>
          <span>基準値（50）</span>
        </div>
      </div>
    </div>
  )
}

// ── Phase7StockScoreSection ───────────────────────────────────
// calculation-only, not an order, not a recommendation

function Phase7StockScoreSection({
  record,
  cardStyle,
  isMobile,
}: {
  record: StockScoreRecord
  cardStyle: CSSProperties
  isMobile: boolean
}) {
  const { six_axis, dynamic_total } = record
  return (
    <div>
      <SectionHeader
        title="Phase 7 軸別スコア (calculation-only)"
        caption="バックエンド計算観察値 — 注文指示ではありません"
      />
      <div style={cardStyle}>
        {/* カードヘッダー */}
        <div style={{
          padding: `${spacing[3]} ${spacing[4]}`,
          background: colors.bgElevated,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexWrap: 'wrap', gap: spacing[2],
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
            {dynamic_total ? (
              <>
                <span style={{ fontSize: '12px', fontWeight: 700, color: colors.stockAccentText }}>
                  総合スコア {dynamic_total.total} ({dynamic_total.rating})
                </span>
                <span style={{ fontSize: '11px', color: colors.textMuted }}>
                  レジーム: {dynamic_total.regime_used}
                </span>
              </>
            ) : (
              <span style={{ fontSize: '12px', fontWeight: 700, color: colors.stockAccentText }}>
                6軸スコア観察値
              </span>
            )}
          </div>
          <span style={{
            fontSize: '10px', color: colors.textMuted,
            background: colors.bgBase, border: `1px solid ${colors.borderSubtle}`,
            borderRadius: radius.sm, padding: `1px ${spacing[1.5]}`,
          }}>
            calculation-only
          </span>
        </div>

        {/* レーダーチャート */}
        <div style={{ padding: `${spacing[4]} ${spacing[4]} ${spacing[2]}` }}>
          <SixAxisRadar scores={six_axis} accentColor={colors.stockAccent} />
        </div>

        {/* 軸別スコアバー */}
        <div style={{ borderTop: `1px solid ${colors.borderSubtle}` }}>
          {CANONICAL_AXES_ORDER.map((axId: ScoreAxisId) => {
            const ax = six_axis[axId]
            if (!ax) return null
            const col = AXIS_COLOR[axId]
            return (
              <div key={axId} style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '60px 1fr 44px' : '80px 1fr 52px',
                gap: spacing[2],
                padding: `${spacing[2]} ${spacing[4]}`,
                borderBottom: `1px solid ${colors.borderSubtle}`,
                alignItems: 'center',
              }}>
                <span style={{ fontSize: '11px', color: col, fontWeight: 700, lineHeight: '1.2' }}>
                  {AXIS_LABEL[axId]}
                </span>
                <div style={{
                  height: '5px', background: colors.bgElevated,
                  borderRadius: '99px', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', width: `${ax.total}%`, background: col,
                    borderRadius: '99px', transition: 'width 0.4s ease',
                  }} />
                </div>
                <span style={{
                  fontSize: '11px', fontWeight: 700, textAlign: 'right',
                  color: ax.total >= 70 ? colors.buyText : ax.total >= 50 ? colors.textSubtle : colors.sell,
                }}>
                  {ax.total}<span style={{ fontSize: '9px', fontWeight: 400, marginLeft: '2px', color: colors.textMuted }}>{ax.rating}</span>
                </span>
              </div>
            )
          })}
        </div>

        {/* ディスクレーマー */}
        <div style={{ padding: `${spacing[2]} ${spacing[4]}`, background: colors.bgElevated }}>
          <p style={{ fontSize: '10px', color: colors.textMuted, lineHeight: '1.5' }}>
            このスコアは観察値です。注文指示ではありません。
            （Phase 7 calculation-only, not an order, not a recommendation）
          </p>
        </div>
      </div>
    </div>
  )
}

// ── サブコンポーネント: FundaRow ─────────────────────────────

function FundaRow({
  label, value, evalLabel, reason, tone,
}: {
  label: string; value: string; evalLabel: string; reason: string
  tone: 'positive' | 'neutral' | 'negative'
}) {
  const col = tone === 'positive' ? colors.buyText : tone === 'negative' ? colors.sellText : colors.textSubtle
  const dot = tone === 'positive' ? colors.buy : tone === 'negative' ? colors.sell : colors.hold
  return (
    <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
          <span style={{ fontSize: '12px', color: colors.textSubtle }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3] }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{value}</span>
          <span style={{ fontSize: '11px', fontWeight: 600, color: col,
            background: tone === 'positive' ? colors.buyBg : tone === 'negative' ? colors.sellBg : colors.bgElevated,
            padding: `1px ${spacing[1.5]}`, borderRadius: radius.sm,
          }}>{evalLabel}</span>
        </div>
      </div>
      <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: spacing[1], paddingLeft: '15px' }}>
        {reason}
      </div>
    </div>
  )
}

// ── サブコンポーネント: TechRow ──────────────────────────────

function TechRow({
  label, state, evalStr, reason,
  signal,
}: {
  label: string; state: string; evalStr: string; reason: string
  signal: 'bull' | 'bear' | 'neutral'
}) {
  const dot = signal === 'bull' ? colors.buy : signal === 'bear' ? colors.sell : colors.wait
  const evalCol = signal === 'bull' ? colors.buyText : signal === 'bear' ? colors.sellText : colors.waitText
  const evalBg  = signal === 'bull' ? colors.buyBg  : signal === 'bear' ? colors.sellBg  : colors.waitBg
  return (
    <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2] }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
          <span style={{ fontSize: '12px', color: colors.textSubtle }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3] }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{state}</span>
          <span style={{ fontSize: '11px', fontWeight: 600, color: evalCol,
            background: evalBg, padding: `1px ${spacing[1.5]}`, borderRadius: radius.sm,
          }}>{evalStr}</span>
        </div>
      </div>
      <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: spacing[1], paddingLeft: '15px' }}>
        {reason}
      </div>
    </div>
  )
}

// ── ReasonList ───────────────────────────────────────────────

function ReasonList({ items, accent }: { items: string[]; accent: string }) {
  const filtered = items.filter(Boolean)
  if (filtered.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
      {filtered.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: spacing[2], alignItems: 'flex-start' }}>
          <span style={{ color: accent, fontSize: '12px', flexShrink: 0, lineHeight: '1.5' }}>•</span>
          <span style={{ fontSize: '12px', color: colors.textPrimary, lineHeight: '1.5' }}>{r}</span>
        </div>
      ))}
    </div>
  )
}

// ── StockList: 銘柄一覧 ───────────────────────────────────────

function StockList({
  holdings,
  analysis,
  onSelect,
}: {
  holdings: Holding[]
  analysis: HoldingAnalysis[]
  onSelect: (code: string) => void
}) {
  const isMobile         = useIsMobile()
  const system           = useAppStore(s => s.system)
  const dq               = useAppStore(selectMarketDataQuality)
  const officialDecision = useAppStore(s => s.officialDecision)
  const universe         = useAppStore(s => s.universe)
  // P4-A149: SAFE_MODE発動中はBUY表示を抑制する
  // P4.5-A011-1: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive   = useAppStore(selectEffectiveSafeModeActive)

  // P4-A37: 国内個別株上限超過判定（cap超過時はBUY→WAIT表示抑制）— 上限はPortfolioPolicyのjpStockMaxRatioで可変
  const jpStockCat         = universe?.categories.find(c => c.class === 'JP_STOCK')
  const jpStockCapExceeded = jpStockCat != null && jpStockCat.currentRatio > jpStockCat.targetRatio

  // P4.5-A013-T6: 保有株/投信のlocalStorage鮮度（表示専用・投資判断ロジックには使わない）。
  // P4.5-A012dの方針を変更せず、staleでも値は捨てず警告のみ追加する。
  const holdingsStale = computeHoldingsStale(system)

  const analysisMap = new Map(analysis.map(a => [a.code, a]))

  const sorted = [...holdings].sort((a, b) => {
    const order: Record<string, number> = { BUY: 0, HOLD: 1, SELL: 2 }
    const ao = order[a.decision] ?? 1
    const bo = order[b.decision] ?? 1
    if (ao !== bo) return ao - bo
    const as_ = analysisMap.get(a.code)?.totalScore ?? 0
    const bs_ = analysisMap.get(b.code)?.totalScore ?? 0
    return bs_ - as_
  })

  const headerDqSuppressed = officialDecision?.dataQualitySuppressed ?? dq.isSuppressed
  const buyCount = holdings.filter(h => {
    const locked       = isSellLocked(h)
    const oa           = officialDecision?.actions.find(
      a => a.assetType === 'stock' && (a.code === h.code || a.name === h.name)
    )
    return deriveDisplayDecision({ hDecision: h.decision, officialAction: oa, dqSuppressed: headerDqSuppressed, locked, capExceeded: jpStockCapExceeded, safeModeActive }) === 'BUY'
  }).length
  const lockCount = holdings.filter(h => isSellLocked(h)).length

  const panelStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: spacing[4],
    padding: isMobile ? `${spacing[4]} ${spacing[3]}` : `${spacing[5]} ${spacing[5]}`,
    maxWidth: '900px', margin: '0 auto',
  }

  return (
    <div style={panelStyle}>
      <PageHeader tabId="T1" />

      {/* P0-5: データ品質ゲートバナー */}
      {dq.isSuppressed && (
        <div style={{
          padding: `${spacing[2]} ${spacing[4]}`,
          background: colors.waitBg,
          border: `1px solid ${colors.waitBorder}`,
          borderRadius: '6px',
          fontSize: '12px',
          color: colors.waitText,
          display: 'flex', alignItems: 'center', gap: spacing[2],
        }}>
          <span>📡</span>
          <span>データ品質低下 — {dq.reason}。BUYシグナルは参考値です（実行推奨停止）。</span>
        </div>
      )}

      {/* P4.5-A013-T6: 保有データ鮮度バナー（表示専用。stale時のみ表示） */}
      {holdingsStale && (
        <div style={{
          padding: `${spacing[2]} ${spacing[4]}`,
          background: colors.waitBg,
          border: `1px solid ${colors.waitBorder}`,
          borderRadius: '6px',
          fontSize: '12px',
          color: colors.waitText,
          display: 'flex', alignItems: 'center', gap: spacing[2],
        }}>
          <span>📦</span>
          <span>保有データが古い可能性があります。CSV再取込または保有株・投信の同期（手動）を確認してください。</span>
        </div>
      )}

      {/* ヘッダー（P1-5: page titleはPageHeaderへ集約したためpillは削除、件数情報のみ残す） */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing[2] }}>
        <span style={{ fontSize: '12px', color: colors.textSubtle }}>
          {holdings.length} 銘柄 — BUY {buyCount} / ロック {lockCount}
        </span>
        {system.analysisLastRunAt && (
          <span style={{ fontSize: '11px', color: colors.textMuted }}>
            分析 {new Date(system.analysisLastRunAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {/* 凡例 */}
      <div style={{ display: 'flex', gap: spacing[4], fontSize: '11px', color: colors.textMuted, flexWrap: 'wrap' }}>
        <span>ランク S≥90 A≥75 B≥60 C≥45 D≥30 E&lt;30</span>
        <span>タップで詳細表示</span>
      </div>

      {/* 銘柄リスト */}
      <div style={{
        background: colors.bgSurface, border: `1px solid ${colors.borderSubtle}`,
        borderRadius: radius.lg, boxShadow: shadow.sm, overflow: 'hidden',
      }}>
        {sorted.length === 0 ? (
          <EmptyState message="保有銘柄なし" detail="CSVをインポートするか、データを更新してください。" />
        ) : (
          sorted.map((h, i) => {
            const a                  = analysisMap.get(h.code)
            const locked             = isSellLocked(h)
            const listOfficialAction = officialDecision?.actions.find(
              oa => oa.assetType === 'stock' && (oa.code === h.code || oa.name === h.name)
            )
            const listDqSuppressed   = (officialDecision?.dataQualitySuppressed ?? dq.isSuppressed)
            const displayDecision    = deriveDisplayDecision({ hDecision: h.decision, officialAction: listOfficialAction, dqSuppressed: listDqSuppressed, locked, capExceeded: jpStockCapExceeded, safeModeActive })
            const dc                 = decisionColors(displayDecision)
            const rank               = a?.strategyRank ?? null
            const rc     = rank ? rankColors(rank) : null
            const score  = a?.totalScore ?? h.score

            return (
              <button
                key={h.code}
                type="button"
                onClick={() => onSelect(h.code)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: `${spacing[3]} ${spacing[4]}`,
                  background: 'transparent', border: 'none',
                  borderBottom: i < sorted.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  cursor: 'pointer', textAlign: 'left', gap: spacing[3],
                }}
              >
                {/* 左: コード・名前・セクター */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: spacing[1.5], flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: colors.textPrimary }}>{h.code}</span>
                    {locked && (
                      <span style={{
                        fontSize: '10px', fontWeight: 700,
                        background: colors.waitBg, color: colors.waitText,
                        border: `1px solid ${colors.waitBorder}`,
                        borderRadius: radius.sm, padding: `0 ${spacing[1]}`,
                      }}>ロック</span>
                    )}
                    {h.pnlPct <= TIER_A_T1_STOP_LOSS_PCT && (
                      <span
                        title="TierA T1警告 — 含み損-40%以下（強制売却ルール対象。最終判断は人間が行う）"
                        style={{
                          fontSize: '10px', fontWeight: 700,
                          background: colors.sellBg, color: colors.sellText,
                          border: `1px solid ${colors.sellBorder}`,
                          borderRadius: radius.sm, padding: `0 ${spacing[1]}`,
                        }}>🔴 TierA T1</span>
                    )}
                    {rc && rank && (
                      <span style={{
                        fontSize: '10px', fontWeight: 700,
                        background: rc.bg, color: rc.text,
                        border: `1px solid ${rc.border}`,
                        borderRadius: radius.sm, padding: `0 ${spacing[1.5]}`,
                      }}>{rank}</span>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: colors.textSubtle, marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {h.name}
                  </div>
                  <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '1px' }}>{h.sector}</div>
                </div>

                {/* 右: 損益・スコア・判断 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '10px', color: colors.textMuted }}>損益</div>
                    <div style={{
                      fontSize: '13px', fontWeight: 700,
                      color: h.pnlPct > 0 ? colors.buy : h.pnlPct < 0 ? colors.sell : colors.textSubtle,
                    }}>
                      {formatSignedPct(h.pnlPct)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '10px', color: colors.textMuted }}>スコア</div>
                    <div style={{
                      fontSize: '13px', fontWeight: 700,
                      color: score >= 60 ? colors.buy : score >= 40 ? colors.wait : colors.sell,
                    }}>{score}</div>
                  </div>
                  <div style={{
                    padding: `${spacing[1]} ${spacing[2]}`,
                    background: dc.bg, color: dc.text,
                    border: `1px solid ${dc.border}`,
                    borderRadius: radius.sm, fontSize: '11px', fontWeight: 700,
                  }}>
                    {displayDecisionLabel(displayDecision)}
                  </div>
                  <span style={{ color: colors.textMuted, fontSize: '14px' }}>›</span>
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* ── 銘柄スコア比較マトリクス（ヒートマップ調） ── */}
      {sorted.length >= 2 && (() => {
        // 表示専用分類（ロジック変更なし）
        function scoreCell(s: number): { bg: string; text: string } {
          if (s >= 70) return { bg: colors.buyBg,  text: colors.buyText  }
          if (s >= 50) return { bg: 'transparent', text: colors.textSubtle }
          return             { bg: colors.sellBg, text: colors.sellText }
        }
        function pnlCell(pct: number): { bg: string; text: string } {
          if (pct >  3) return { bg: colors.buyBg,  text: colors.buyText  }
          if (pct < -3) return { bg: colors.sellBg, text: colors.sellText }
          return              { bg: 'transparent', text: colors.textMuted }
        }
        function rsiCell(rsi: number): { bg: string; text: string } {
          if (rsi <= 30) return { bg: colors.buyBg,  text: colors.buyText  } // 売られすぎ
          if (rsi >= 70) return { bg: colors.sellBg, text: colors.sellText } // 買われすぎ
          return               { bg: 'transparent', text: colors.textMuted }
        }
        function rankCell(rank: string | null): { bg: string; text: string } {
          if (!rank)                   return { bg: 'transparent',      text: colors.textMuted      }
          if (rank === 'S')            return { bg: colors.goldBg,      text: colors.gold           }
          if (rank === 'A')            return { bg: colors.buyBg,       text: colors.buyText        }
          if (rank === 'B')            return { bg: colors.stockAccentBg, text: colors.stockAccentText }
          if (rank === 'C')            return { bg: 'transparent',      text: colors.textSubtle     }
          if (rank === 'D')            return { bg: colors.waitBg,      text: colors.waitText       }
          return                              { bg: colors.sellBg,      text: colors.sellText       }
        }
        function decCell(dec: string): { bg: string; text: string } {
          if (dec === 'BUY')  return { bg: colors.buyBg,  text: colors.buyText  }
          if (dec === 'SELL') return { bg: colors.sellBg, text: colors.sellText }
          return                    { bg: colors.holdBg,  text: colors.holdText }
        }

        const COLS = [
          { key: 'decision', label: '判断' },
          { key: 'score',    label: 'スコア' },
          { key: 'pnl',      label: '損益' },
          { key: 'rsi',      label: 'RSI' },
          { key: 'rank',     label: 'ランク' },
        ]

        const cellBase: CSSProperties = {
          padding:      `${spacing[1.5]} ${spacing[2]}`,
          borderRadius: radius.sm,
          textAlign:    'center' as const,
          fontSize:     '11px',
          fontWeight:   700,
          minWidth:     '44px',
        }
        const pnlCellBase: CSSProperties = isMobile
          ? { ...cellBase, padding: `${spacing[1.5]} ${spacing[0.5]}`, fontSize: '10px', minWidth: 0, whiteSpace: 'nowrap' }
          : cellBase

        return (
          <div>
            <SectionHeader title="銘柄スコア比較" caption="スコア/損益/RSI（表示専用）" />
            <div style={{
              background:   colors.bgSurface,
              border:       `1px solid ${colors.borderSubtle}`,
              borderRadius: radius.lg,
              boxShadow:    shadow.sm,
              overflowX:    'auto',
            }}>
              {/* ヘッダー行 */}
              <div style={{
                display:             'grid',
                gridTemplateColumns: isMobile ? `64px repeat(${COLS.length}, 1fr)` : `80px repeat(${COLS.length}, 1fr)`,
                gap:                 spacing[1],
                padding:             `${spacing[2]} ${spacing[3]}`,
                background:          colors.bgElevated,
                borderBottom:        `1px solid ${colors.borderSubtle}`,
              }}>
                <span style={{ ...typography.caption, color: colors.textMuted }}>銘柄</span>
                {COLS.map(c => (
                  <span key={c.key} style={{ ...typography.caption, color: colors.textMuted, textAlign: 'center' }}>{c.label}</span>
                ))}
              </div>
              {/* データ行 */}
              {sorted.map((row, i) => {
                const rowA       = analysisMap.get(row.code)
                const rowLocked  = isSellLocked(row)
                const rowOA      = officialDecision?.actions.find(
                  oa => oa.assetType === 'stock' && (oa.code === row.code || oa.name === row.name)
                )
                const rowDqSup   = officialDecision?.dataQualitySuppressed ?? dq.isSuppressed
                const rowDec     = deriveDisplayDecision({ hDecision: row.decision, officialAction: rowOA, dqSuppressed: rowDqSup, locked: rowLocked, capExceeded: jpStockCapExceeded, safeModeActive })
                const rowScore   = rowA?.totalScore ?? row.score
                const rowRank    = rowA?.strategyRank ?? null
                const sc  = scoreCell(rowScore)
                const pnl = pnlCell(row.pnlPct)
                const rs  = rsiCell(row.rsi)
                const rk  = rankCell(rowRank)
                const dc2 = decCell(rowDec)

                return (
                  <div key={row.code} style={{
                    display:             'grid',
                    gridTemplateColumns: isMobile ? `64px repeat(${COLS.length}, 1fr)` : `80px repeat(${COLS.length}, 1fr)`,
                    gap:                 spacing[1],
                    padding:             `${spacing[2]} ${spacing[3]}`,
                    borderBottom:        i < sorted.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                    alignItems:          'center',
                  }}>
                    {/* 銘柄コード + 企業名（P4.5-A003: コードだけで脳内変換しなくてよいように併記） */}
                    <div style={{ minWidth: 0 }}>
                      <span style={{ ...typography.bodySmall, color: colors.textPrimary, fontWeight: 700 }}>{row.code}</span>
                      {row.name && (
                        <div style={{
                          fontSize: '10px', color: colors.textSubtle, marginTop: '1px',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {row.name}
                        </div>
                      )}
                      {rowLocked && (
                        <div style={{ fontSize: '9px', color: colors.waitText, marginTop: '1px' }}>ロック</div>
                      )}
                    </div>
                    {/* 判断 */}
                    <div style={{ ...cellBase, background: dc2.bg, color: dc2.text }}>
                      {displayDecisionLabel(rowDec)}
                    </div>
                    {/* スコア */}
                    <div style={{ ...cellBase, background: sc.bg, color: sc.text }}>{rowScore}</div>
                    {/* 損益 */}
                    <div style={{ ...pnlCellBase, background: pnl.bg, color: pnl.text }}>
                      {formatSignedPct(row.pnlPct)}
                    </div>
                    {/* RSI */}
                    <div style={{ ...cellBase, background: rs.bg, color: rs.text }}>{row.rsi.toFixed(0)}</div>
                    {/* ランク */}
                    <div style={{ ...cellBase, background: rk.bg, color: rk.text }}>{rowRank ?? '—'}</div>
                  </div>
                )
              })}
              {/* 凡例 */}
              <div style={{
                padding:      `${spacing[2]} ${spacing[3]}`,
                background:   colors.bgElevated,
                borderTop:    `1px solid ${colors.borderSubtle}`,
                display:      'flex',
                gap:          spacing[3],
                flexWrap:     'wrap',
              }}>
                {[
                  { bg: colors.buyBg,  text: colors.buyText,  label: '良好' },
                  { bg: colors.sellBg, text: colors.sellText, label: '注意' },
                ].map(e => (
                  <span key={e.label} style={{ ...typography.caption, color: e.text, background: e.bg, padding: `1px ${spacing[1.5]}`, borderRadius: radius.sm }}>
                    {e.label}
                  </span>
                ))}
                <span style={{ ...typography.caption, color: colors.textMuted }}>
                  RSI: ≤30=売られすぎ / ≥70=買われすぎ（表示専用）
                </span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── CAND-SYN-1D: 候補判断（CandidateDecisionSynthesis由来。唯一の候補UI authority） ── */}
      <CandidateDecisionSection />

      {/* ── P5-B005-B3-C: 市場全体candidate funnel（observability only） ── */}
      <CandidateFunnelPanel />

    </div>
  )
}

// ── CAND-SYN-1D / D13: 候補詳細セクション ────────────────────────
// candidateDecisionSynthesis.decisions（≤3）+ watchList（≤10）のみを唯一の
// 候補UI authorityとして読む。順序は synthesis が既に確定した canonical order
// のままとし（D13「UI側で独立filter/slice/抑制判定を持たない」）、再ソート・
// 再フィルタ・第二の金額計算は一切行わない。legacy state.stockCandidates /
// applyStockCandidateGates.maxAmount は候補UI authorityとして参照しない
// （P2-2退役）。PER/PBR/ROE等はstate.candidatesStocksの生データをevidenceとして
// 表示するのみで、金額・順位には一切使わない。
export function formatStockMetric(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '—' : `${value}${suffix}`
}

function CandidateSynthesisActionBadge({ action }: { action: SynthesisAction }) {
  const cfg =
    action === 'ADD'     ? { bg: colors.buyBg,  text: colors.buyText,  label: SYNTHESIS_ACTION_LABEL.ADD } :
    action === 'BUY_NEW' ? { bg: colors.buyBg,  text: colors.buyText,  label: SYNTHESIS_ACTION_LABEL.BUY_NEW } :
    action === 'WATCH'   ? { bg: colors.waitBg, text: colors.waitText, label: SYNTHESIS_ACTION_LABEL.WATCH } :
                            { bg: colors.sellBg, text: colors.sellText, label: SYNTHESIS_ACTION_LABEL.BLOCKED }
  return (
    <span style={{ fontSize: '10px', fontWeight: 700, padding: `2px ${spacing[1.5]}`, borderRadius: radius.sm, background: cfg.bg, color: cfg.text }}>
      {cfg.label}
    </span>
  )
}

function CandidateSynthesisEntryCard({
  entry,
  rawByCode,
}: {
  entry: CandidateDecisionSynthesisEntry
  rawByCode: Map<string, StockCandidateItem>
}) {
  const raw = entry.code !== null ? rawByCode.get(entry.code) : undefined
  const nonExecutableReason = synthesisNonExecutableReasonText(entry)
  const warnings = labelWarnings(entry.warnings)
  const limitingFactors = labelLimitingFactors(entry.limitingFactors)

  return (
    <div
      style={{
        padding: `${spacing[3]} ${spacing[4]}`,
        background: colors.bgSurface,
        border: `1px solid ${colors.borderSubtle}`,
        borderRadius: radius.lg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap', marginBottom: spacing[1.5] }}>
        {entry.code && <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>{entry.code}</span>}
        <span style={{ fontSize: '13px', color: colors.textPrimary }}>{entry.displayName}</span>
        <AssetTypeBadge type={entry.assetClass === 'JP_STOCK' ? 'stock' : 'fund'} size="sm" />
        <CandidateSynthesisActionBadge action={entry.action} />
        {typeof entry.candidateQuality.marketScore === 'number' && (
          <span style={{ fontSize: '11px', color: colors.textMuted, marginLeft: 'auto' }}>
            スコア {entry.candidateQuality.marketScore.toFixed(1)}
          </span>
        )}
      </div>

      {raw && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))',
          gap: spacing[1], fontSize: '11px', color: colors.textSubtle, marginBottom: spacing[2],
        }}>
          <div>PER {formatStockMetric(raw.per)}</div>
          <div>PBR {formatStockMetric(raw.pbr)}</div>
          <div>ROE {formatStockMetric(raw.roe, '%')}</div>
          <div>配当 {formatStockMetric(raw.dividendYield, '%')}</div>
          <div>σ252d {formatStockMetric(raw.sigma252d)}</div>
          <div>3M {formatStockMetric(raw.mom3m, '%')}</div>
        </div>
      )}

      {entry.money.kind === 'EXECUTABLE' && (
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.buyText, marginBottom: spacing[1] }}>
          実行可能額 {formatJPYAuto(entry.money.executableAmountJpy)}（AllocationPlan認可）
        </div>
      )}
      {entry.money.kind !== 'EXECUTABLE' && nonExecutableReason !== null && (
        <div style={{ fontSize: '12px', color: colors.textSubtle, marginBottom: spacing[1] }}>
          {nonExecutableReason}
        </div>
      )}

      {entry.blockingReasons.length > 0 && (
        <div style={{ fontSize: '11px', color: colors.sellText, marginBottom: spacing[1.5] }}>
          除外理由: {labelBlockedReasons(entry.blockingReasons).join('・')}
        </div>
      )}
      {warnings.length > 0 && (
        <div style={{ fontSize: '11px', color: colors.waitText, marginBottom: spacing[1.5] }}>
          注意: {warnings.join('・')}
        </div>
      )}
      {limitingFactors.length > 0 && (
        <div style={{ display: 'flex', gap: spacing[1], flexWrap: 'wrap' }}>
          {limitingFactors.map(f => (
            <span
              key={f}
              style={{
                fontSize: '10px', padding: `1px ${spacing[1]}`, borderRadius: radius.sm,
                background: colors.holdBg, color: colors.holdText,
              }}
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function CandidateDecisionSection() {
  const synthesis           = useAppStore(selectCandidateDecisionSynthesis)
  const rawCandidatesStocks = useAppStore(s => s.candidatesStocks)
  const system              = useAppStore(s => s.system)

  const rawByCode = new Map(rawCandidatesStocks.candidates.map(c => [c.code, c]))
  // P5-B003由来: 判断ロジックには一切影響しない表示専用の警告（P4.5-A012整合）。
  const portfolioStale = system.localStorageFreshness?.portfolio.isStale ?? false

  const isUnavailable = synthesis === null || synthesis.status !== 'available'
  const decisions = isUnavailable ? [] : synthesis.decisions
  const watchList = isUnavailable ? [] : synthesis.watchList

  return (
    <div>
      <SectionHeader title="候補（AllocationPlan認可）" caption={isUnavailable ? undefined : `${decisions.length + watchList.length}件`} />
      <div style={{ ...typography.caption, color: colors.textMuted, margin: `${spacing[1]} 0 ${spacing[2]}` }}>
        調査候補であり、投資判断ではありません。実行可能額はAllocationPlanが唯一の権限です。売買はご自身の判断で行ってください。
      </div>
      {portfolioStale && (
        <div style={{
          fontSize: '11px', color: colors.waitText, marginBottom: spacing[3],
          padding: `${spacing[2]} ${spacing[3]}`, background: colors.waitBg,
          border: `1px solid ${colors.waitBorder}`, borderRadius: radius.md,
        }}>
          ⚠ 保有データが古い可能性があります。スマホからのportfolio snapshot同期を推奨します。
        </div>
      )}

      {isUnavailable && (
        <EmptyState message={synthesis?.status === 'invalid' ? '候補データの再計算が必要です' : '候補データ更新待ちです'} detail="次回のデータ更新後に表示されます" />
      )}
      {!isUnavailable && decisions.length === 0 && watchList.length === 0 && (
        <EmptyState message="現在は候補がありません" />
      )}
      {(decisions.length > 0 || watchList.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
          {decisions.map(entry => <CandidateSynthesisEntryCard key={entry.entryId} entry={entry} rawByCode={rawByCode} />)}
          {watchList.map(entry => <CandidateSynthesisEntryCard key={entry.entryId} entry={entry} rawByCode={rawByCode} />)}
        </div>
      )}
    </div>
  )
}

// ── officialAction → 表示テキスト変換 ────────────────────────
function officialActionText(oa: OfficialDecisionItem): string {
  if (oa.action === 'BUY')       return `公式判断: 買い候補 — ${oa.reason}`
  if (oa.action === 'SELL')      return `公式判断: 売却確認 — ${oa.reason}`
  if (oa.action === 'HOLD')      return `公式判断: 継続保有 — ${oa.reason}`
  if (oa.action === 'WAIT')      return `公式判断: 待機 — ${oa.reason}`
  if (oa.action === 'MONITOR')   return `公式判断: 監視強化 — ${oa.reason}`
  if (oa.action === 'BLOCKED')   return `公式判断: 新規買い停止 — ${oa.blockedReason ?? oa.reason}`
  if (oa.action === 'DATA_WAIT') return `公式判断: データ更新待ち — ${oa.reason}`
  return oa.reason
}

// ── StockDetail: 銘柄詳細 ─────────────────────────────────────

function StockDetail({ code, onBack }: { code: string; onBack: () => void }) {
  const isMobile        = useIsMobile()
  const holdings        = useAppStore(s => s.holdings)
  const analysis        = useAppStore(s => s.analysis)
  const system          = useAppStore(s => s.system)
  const stockScores6Axis = useAppStore(s => s.stockScores6Axis)
  const dq               = useAppStore(selectMarketDataQuality)
  const officialDecision = useAppStore(s => s.officialDecision)
  const universe         = useAppStore(s => s.universe)
  // P4-A149: SAFE_MODE発動中はBUY表示を抑制する
  // P4.5-A011-1: raw active値だけでなく、safe_mode.jsonの鮮度によるfail-closedも含めて判定する
  const safeModeActive   = useAppStore(selectEffectiveSafeModeActive)
  const phase7Record     = stockScores6Axis?.find(r => r.ticker === code) ?? null

  // P4-A37: 国内個別株上限超過判定（上限はPortfolioPolicyのjpStockMaxRatioで可変）
  const jpStockCat         = universe?.categories.find(c => c.class === 'JP_STOCK')
  const jpStockCapExceeded = jpStockCat != null && jpStockCat.currentRatio > jpStockCat.targetRatio

  const h = holdings.find(x => x.code === code)
  const a = analysis.find(x => x.code === code)

  const panelStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: spacing[4],
    padding: isMobile ? `${spacing[3]} ${spacing[3]}` : `${spacing[5]} ${spacing[5]}`,
    maxWidth: '900px', margin: '0 auto',
  }

  const cardStyle: CSSProperties = {
    background: colors.bgSurface, border: `1px solid ${colors.borderSubtle}`,
    borderRadius: radius.lg, boxShadow: shadow.sm, overflow: 'hidden',
  }

  if (!h) {
    return (
      <div style={panelStyle}>
        <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.stockAccentText, fontSize: '13px', fontWeight: 600, padding: 0, alignSelf: 'flex-start' }}>
          ← 銘柄一覧
        </button>
        <EmptyState message="銘柄データなし" />
      </div>
    )
  }

  const locked     = isSellLocked(h)
  const unlockDate = getSellableDate(h)
  const rank       = a?.strategyRank ?? null
  const rc         = rank ? rankColors(rank) : null
  const debate = a?.debate

  // P1-3D: officialDecision から該当銘柄の action を引く（code 優先 → name フォールバック）
  const officialAction = officialDecision?.actions.find(
    oa => oa.assetType === 'stock' && (oa.code === h.code || oa.name === h.name)
  )

  // P1-4B / P4-A149: displayDecision — officialAction / DQ / SAFE_MODE / ロック制約 を統合した表示用判定
  const dqSuppressed    = (officialDecision?.dataQualitySuppressed ?? dq.isSuppressed)
  const displayDecision = deriveDisplayDecision({ hDecision: h.decision, officialAction, dqSuppressed, locked, capExceeded: jpStockCapExceeded, safeModeActive })
  const dc              = decisionColors(displayDecision)

  // ── 8軸スコア (0–100 正規化) ──────────────────────────────
  const axes = [
    { label: '割安度',     value: debate?.sevenAxis.valuation  ?? 50 },
    { label: '稼ぐ力',     value: a ? (a.fundamentalScore / 30 * 100) : 50 },
    { label: '成長性',     value: debate?.sevenAxis.growth     ?? 50 },
    { label: '安全性',     value: a ? (a.qualityScore / 10 * 100)     : 50 },
    { label: 'トレンド',   value: debate?.sevenAxis.momentum   ?? 50 },
    { label: '需給',       value: a ? (a.technicalScore / 20 * 100)   : 50 },
    { label: '還元力',     value: Math.min(100, Math.max(0, h.divG * 12 + 50)) },
    { label: '事業独自性', value: debate?.sevenAxis.quality    ?? 50 },
  ]

  // ── ファンダメンタル項目 ──────────────────────────────────
  const fundaRows = [
    {
      label: '稼ぐ力 — ROE',
      value: `${h.roe}%`,
      evalLabel: h.roe >= 15 ? '高収益' : h.roe >= 8 ? '標準' : '低収益',
      reason: h.roe >= 15 ? '資本効率が高く、利益創出力が強い' : h.roe >= 8 ? '平均的な収益性を維持' : '収益力の改善が課題',
      tone: (h.roe >= 15 ? 'positive' : h.roe >= 8 ? 'neutral' : 'negative') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '成長性 — EPS成長率',
      value: `${h.epsG >= 0 ? '+' : ''}${h.epsG}%`,
      evalLabel: h.epsG >= 15 ? '高成長' : h.epsG >= 5 ? '増益' : h.epsG >= 0 ? '横ばい' : '減益',
      reason: h.epsG >= 15 ? '二桁増益継続、将来性が高い' : h.epsG >= 5 ? '安定した利益成長が続く' : h.epsG >= 0 ? '成長鈍化、横ばい推移' : 'EPS減少は前提崩れのリスク',
      tone: (h.epsG >= 5 ? 'positive' : h.epsG >= 0 ? 'neutral' : 'negative') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '割安度 — PER',
      value: h.per > 0 ? `${h.per.toFixed(1)}倍` : '—',
      evalLabel: h.per > 0 && h.per <= 15 ? '割安' : h.per > 0 && h.per <= 25 ? '適正' : h.per > 40 ? '割高' : '—',
      reason: h.per > 0 && h.per <= 15 ? 'バリュー水準、PER低め' : h.per > 0 && h.per <= 25 ? '業種比較で適正水準' : h.per > 40 ? '高PER、期待先行に注意' : 'PERデータなし',
      tone: (h.per > 0 && h.per <= 15 ? 'positive' : h.per > 40 ? 'negative' : 'neutral') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '割安度 — PBR',
      value: h.pbr > 0 ? `${h.pbr.toFixed(2)}倍` : '—',
      evalLabel: h.pbr > 0 && h.pbr < 1 ? '解散価値以下' : h.pbr <= 1.5 ? '低PBR' : h.pbr <= 3 ? '標準' : '割高',
      reason: h.pbr > 0 && h.pbr < 1 ? '株価が純資産を下回る。資本効率改善期待' : h.pbr <= 1.5 ? '比較的低PBR、割安感あり' : h.pbr <= 3 ? '標準的なPBR水準' : '高PBR、成長期待を反映',
      tone: (h.pbr > 0 && h.pbr < 1.5 ? 'positive' : h.pbr > 4 ? 'negative' : 'neutral') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '安全性 — D/Eレシオ',
      value: `${h.de.toFixed(1)}倍`,
      evalLabel: h.de <= 0.5 ? '無借金' : h.de <= 1.0 ? '健全' : h.de <= 3.0 ? '標準' : '高レバ',
      reason: h.de <= 0.5 ? '財務体質が非常に堅固' : h.de <= 1.0 ? '健全な財務バランスを維持' : h.de <= 3.0 ? '業種平均的な負債水準' : '高負債比率、金利上昇リスクあり',
      tone: (h.de <= 1.0 ? 'positive' : h.de > 3.0 ? 'negative' : 'neutral') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '安全性 — CF良否',
      value: h.cfOk ? '良好' : '要確認',
      evalLabel: h.cfOk ? '本業安定' : '注意',
      reason: h.cfOk ? '本業での現金創出力が確認できる' : 'CF改善余地あり、利益の質を要確認',
      tone: (h.cfOk ? 'positive' : 'negative') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '株主還元 — 配当成長率',
      value: `${h.divG >= 0 ? '+' : ''}${h.divG}%`,
      evalLabel: h.divG >= 8 ? '高成長還元' : h.divG >= 3 ? '安定成長' : h.divG >= 0 ? '横ばい' : '減配',
      reason: h.divG >= 8 ? '配当を継続増配、株主還元姿勢が優れる' : h.divG >= 3 ? '着実な増配実績あり' : h.divG >= 0 ? '配当維持、特段の変化なし' : '減配は株主還元姿勢の後退を示す',
      tone: (h.divG >= 3 ? 'positive' : h.divG < 0 ? 'negative' : 'neutral') as 'positive' | 'neutral' | 'negative',
    },
    {
      label: '事業の強さ — 品質スコア',
      value: `${a?.qualityScore ?? '—'} / 10`,
      evalLabel: (a?.qualityScore ?? 0) >= 8 ? '高品質' : (a?.qualityScore ?? 0) >= 5 ? '標準' : '要改善',
      reason: `セクター: ${h.sector}${h.mitsu ? ' (三菱Gグループ)' : ''} / β ${h.beta.toFixed(2)}`,
      tone: ((a?.qualityScore ?? 0) >= 7 ? 'positive' : (a?.qualityScore ?? 0) >= 4 ? 'neutral' : 'negative') as 'positive' | 'neutral' | 'negative',
    },
  ]

  // ── テクニカル項目 ────────────────────────────────────────
  const techRows = [
    {
      label: '中期トレンド',
      state: h.ma && h.macd ? 'MA上位 + MACD陽転' : h.ma ? 'MA上位のみ' : h.macd ? 'MACD陽転のみ' : 'MA下位 + MACD陰転',
      evalStr: h.ma && h.macd ? '強気' : h.ma || h.macd ? '中立' : '弱気',
      reason: h.ma && h.macd ? '移動平均線上位+MACDが上向き。上昇トレンド継続' : !h.ma && !h.macd ? 'MA下位・MACD陰転。下降トレンドに注意' : 'トレンド混在。方向感確認が必要',
      signal: (h.ma && h.macd ? 'bull' : !h.ma && !h.macd ? 'bear' : 'neutral') as 'bull' | 'bear' | 'neutral',
    },
    {
      label: '短期トレンド — RSI',
      state: `RSI ${h.rsi.toFixed(0)}`,
      evalStr: h.rsi < 30 ? '売られすぎ' : h.rsi <= 65 ? '適正圏' : '買われすぎ',
      reason: h.rsi < 30 ? 'RSI低水準。短期反転の可能性あり' : h.rsi <= 65 ? '過熱感なく安定した水準' : 'RSI高水準。短期調整に注意',
      signal: (h.rsi < 30 ? 'neutral' : h.rsi > 75 ? 'bear' : 'bull') as 'bull' | 'bear' | 'neutral',
    },
    {
      label: 'モメンタム — 3M',
      state: `${h.mom3m >= 0 ? '+' : ''}${h.mom3m.toFixed(1)}%`,
      evalStr: h.mom3m > 8 ? '強い上昇' : h.mom3m > 0 ? 'プラス圏' : h.mom3m > -5 ? '弱含み' : '下降圧力',
      reason: h.mom3m > 8 ? '直近3ヶ月で強い上昇モメンタム。トレンドフォロー有利' : h.mom3m < -5 ? '3ヶ月下落継続。底打ち確認まで慎重' : '緩やかな値動き',
      signal: (h.mom3m > 0 ? 'bull' : h.mom3m < -5 ? 'bear' : 'neutral') as 'bull' | 'bear' | 'neutral',
    },
    {
      label: '出来高',
      state: h.vol ? '増加傾向' : '通常水準',
      evalStr: h.vol ? '需給改善' : '変化なし',
      reason: h.vol ? '出来高増加は機関参入の可能性。需給改善シグナル' : '通常の出来高水準、特段の動きなし',
      signal: (h.vol ? 'bull' : 'neutral') as 'bull' | 'bear' | 'neutral',
    },
    {
      label: 'サポート / レジスタンス',
      state: h.currentPrice ? `現値 ${h.currentPrice.toLocaleString('ja-JP')}円` : `評価額 ${formatJPYAuto(h.eval)}`,
      evalStr: `目標 ${h.target.toLocaleString('ja-JP')}円`,
      reason: `アラートライン ${h.alert.toLocaleString('ja-JP')}円。このラインを下回ったら損切り検討`,
      signal: 'neutral' as const,
    },
    {
      label: '過熱感',
      state: h.rsi > 75 ? '過熱' : h.rsi < 35 ? '割安感あり' : '正常',
      evalStr: h.rsi > 75 ? '注意' : h.rsi < 35 ? 'チャンス' : '良好',
      reason: `RSI ${h.rsi.toFixed(0)} — ${h.rsi > 75 ? '高水準での追加購入は短期リスクが高い' : '過熱感なし'}`,
      signal: (h.rsi > 75 ? 'bear' : h.rsi < 35 ? 'bull' : 'neutral') as 'bull' | 'bear' | 'neutral',
    },
    {
      label: '需給',
      state: `含み損益 ${formatSignedPct(h.pnlPct)}`,
      evalStr: h.vol && h.pnlPct > 5 ? '良好' : h.pnlPct < -10 ? '悪化' : '中立',
      reason: h.pnlPct > 20 ? '大きな含み益あり。一部利確の検討も' : h.pnlPct < -15 ? '含み損拡大。損切りラインを要確認' : '需給は比較的安定',
      signal: (h.vol && h.pnlPct > 5 ? 'bull' : h.pnlPct < -10 ? 'bear' : 'neutral') as 'bull' | 'bear' | 'neutral',
    },
  ]

  // ── 各軸詳細（UI-9-1: アイコン + 根拠テキスト付き）────────
  const axisDetails = [
    { label: '割安度',     icon: '💎', value: axes[0].value, reason: `PER: ${fundaRows[2].value} — ${fundaRows[2].reason}。PBR: ${fundaRows[3].value} — ${fundaRows[3].reason}` },
    { label: '稼ぐ力',     icon: '📈', value: axes[1].value, reason: `ROE ${fundaRows[0].value} — ${fundaRows[0].reason}` },
    { label: '成長性',     icon: '🚀', value: axes[2].value, reason: `EPS成長率 ${fundaRows[1].value} — ${fundaRows[1].reason}` },
    { label: '安全性',     icon: '🛡️', value: axes[3].value, reason: `D/Eレシオ ${fundaRows[4].value} — ${fundaRows[4].reason}。CF: ${fundaRows[5].value}` },
    { label: 'トレンド',   icon: '📊', value: axes[4].value, reason: `${techRows[0].state} — ${techRows[0].reason}` },
    { label: '需給',       icon: '⚖️', value: axes[5].value, reason: `${techRows[6].state} — ${techRows[6].reason}` },
    { label: '還元力',     icon: '💰', value: axes[6].value, reason: `配当成長率 ${fundaRows[6].value} — ${fundaRows[6].reason}` },
    { label: '事業独自性', icon: '🏢', value: axes[7].value, reason: fundaRows[7].reason },
  ]

  // 結論サマリー用（20文字truncate）
  const truncate = (s: string | undefined, n = 20) =>
    s ? (s.length > n ? s.slice(0, n) + '…' : s) : '—'

  function axisColor(v: number) {
    return v >= 60 ? colors.buy : v >= 40 ? colors.wait : colors.sell
  }

  return (
    <div style={panelStyle}>
      <PageHeader tabId="T1" />

      {/* ── 戻るボタン ── */}
      <button type="button" onClick={onBack} className="stock-detail__back-btn">
        ← 銘柄一覧に戻る
      </button>

      {/* ━━━ 1. ヘッダーカード (UI-9-1 redesign) ━━━━━━━━━━━━━━━━━━ */}
      <div className="card stock-detail__header-card">
        <div className="stock-detail__header-main">
          {/* 左: コード・銘柄名・セクター */}
          <div>
            <div className="stock-detail__code-kicker">{h.code}</div>
            {/* P0-3: page h1はPageHeaderが担うため、個別銘柄名はh2（このdrill-down viewの主見出し） */}
            <h2 className="stock-detail__name">{h.name}</h2>
            <div className="stock-detail__sector">
              {h.sector}{h.mitsu ? ' / 三菱G' : ''} / β {h.beta.toFixed(2)}
            </div>
            {locked && (
              <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, marginTop: '6px', padding: `${spacing[1]} ${spacing[2]}`, background: colors.waitBg, color: colors.waitText, border: `1px solid ${colors.waitBorder}`, borderRadius: radius.sm }}>
                売却ロック中
              </span>
            )}
            {h.pnlPct <= TIER_A_T1_STOP_LOSS_PCT && (
              <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, marginTop: '6px', marginLeft: locked ? spacing[1.5] : 0, padding: `${spacing[1]} ${spacing[2]}`, background: colors.sellBg, color: colors.sellText, border: `1px solid ${colors.sellBorder}`, borderRadius: radius.sm }}>
                🔴 TierA T1警告 — 含み損{formatSignedPct(h.pnlPct)}
              </span>
            )}
          </div>
          {/* 右: 分析日・株価・スコア・判断バッジ */}
          <div className="stock-detail__header-meta">
            {system.analysisLastRunAt && (
              <div className="stock-detail__meta-item">
                <div className="stock-detail__meta-label">分析日</div>
                <div className="stock-detail__meta-value">
                  {new Date(system.analysisLastRunAt).toLocaleDateString('ja-JP')}
                </div>
              </div>
            )}
            {h.currentPrice != null && (
              <div className="stock-detail__meta-item">
                <div className="stock-detail__meta-label">株価（現在値）</div>
                <div className="stock-detail__meta-value stock-detail__meta-price">
                  {h.currentPrice.toLocaleString('ja-JP')}
                </div>
              </div>
            )}
            {a && (
              <div className="stock-detail__meta-item">
                <div className="stock-detail__meta-label">総合スコア</div>
                <div className="stock-detail__meta-value" style={{ color: axisColor(a.totalScore) }}>
                  {a.totalScore}
                </div>
              </div>
            )}
            <div className="stock-detail__decision-badge" style={{ background: dc.bg, color: dc.text, border: `1px solid ${dc.border}` }}>
              {displayDecisionLabel(displayDecision)}
              {rank && rc && <span style={{ marginLeft: '6px', fontSize: '11px' }}>{rank}</span>}
            </div>
          </div>
        </div>
        {/* KPI サブ行 */}
        <div style={{ display: 'flex', gap: spacing[5], flexWrap: 'wrap', marginTop: spacing[3], paddingTop: spacing[3], borderTop: `1px solid ${colors.borderSubtle}` }}>
          {[
            { label: '評価額',     val: formatJPYAuto(h.eval),     col: undefined },
            { label: '損益率',     val: formatSignedPct(h.pnlPct), col: h.pnlPct > 0 ? colors.buy : h.pnlPct < 0 ? colors.sell : undefined },
            { label: '3Mモメンタム', val: `${h.mom3m >= 0 ? '+' : ''}${h.mom3m.toFixed(1)}%`, col: h.mom3m > 0 ? colors.buy : colors.sell },
            { label: 'EV',         val: formatSignedPct(h.ev * 100, 1), col: h.ev > 0 ? colors.buy : colors.sell },
            { label: '信頼度',     val: a ? `${(a.confidence * 100).toFixed(0)}%` : '—', col: undefined },
          ].map(({ label, val, col }) => (
            <div key={label}>
              <div style={{ fontSize: '10px', color: colors.textMuted }}>{label}</div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: col ?? colors.textPrimary, marginTop: '2px' }}>{val}</div>
            </div>
          ))}
        </div>
        {/* ロック制約 */}
        {locked && unlockDate && (
          <div style={{ marginTop: spacing[3], padding: `${spacing[2]} ${spacing[3]}`, background: colors.waitBg, border: `1px solid ${colors.waitBorder}`, borderRadius: radius.md }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: colors.waitText, marginBottom: spacing[1] }}>3ヶ月制約中 — 売却不可</div>
            <div style={{ fontSize: '12px', color: colors.waitText }}>
              売却可能予定日: <strong>{unlockDate}</strong> / 取得日: {h.acquiredAt}
            </div>
          </div>
        )}
        {h.lock && !locked && (
          <div style={{ marginTop: spacing[3], padding: `${spacing[2]} ${spacing[3]}`, background: colors.buyBg, border: `1px solid ${colors.buyBorder}`, borderRadius: radius.md, fontSize: '12px', color: colors.buyText }}>
            ロック期間終了 — 売却可能です（取得日: {h.acquiredAt}）
          </div>
        )}
        {/* P4-A150: TierA T1警告 — ロック中でも消さない（自動売却は行わない。検出・警告表示のみ） */}
        {h.pnlPct <= TIER_A_T1_STOP_LOSS_PCT && (
          <div style={{ marginTop: spacing[3], padding: `${spacing[2]} ${spacing[3]}`, background: colors.sellBg, border: `1px solid ${colors.sellBorder}`, borderRadius: radius.md }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: colors.sellText, marginBottom: spacing[1] }}>
              🔴 TierA T1警告 — 含み損 {formatSignedPct(h.pnlPct)}（-40%以下）
            </div>
            <div style={{ fontSize: '12px', color: colors.sellText }}>
              強制売却ルール対象。ただし最終判断は人間が行う（自動売却は行いません）。
              {locked && '3ヶ月ロック中でもこの警告は表示され続けます。'}
            </div>
          </div>
        )}
      </div>

      {/* ━━━ 2. レーダー + 評価コメント 2カラム (UI-9-1b: 8軸) ━━━━━ */}
      <div className="stock-detail__top-grid">
        {/* 左: 8軸レーダーチャート */}
        <div className="card" style={{ padding: '16px 16px 12px' }}>
          <div className="stock-detail__section-header">8軸スコア レーダーチャート</div>
          <EightAxisRadar axes={axes} accentColor={colors.stockAccent} />
          <div style={{ fontSize: '10px', color: colors.textMuted, marginTop: '4px', textAlign: 'center' }}>
            calculation-only / not an order
          </div>
        </div>
        {/* 右: 総合評価コメント */}
        <div className="card comment-card">
          <div className="comment-card__title">
            <span>💬</span>
            <span>総合評価コメント</span>
          </div>
          <div className="comment-card__action">
            {displayDecision === 'DATA_WAIT'
              ? 'データ更新待ち — データ品質低下のため新規買いを抑制中。シグナルは参考値のみです。'
              : safeModeActive && h.decision === 'BUY'
                ? (officialAction?.blockedReason ?? `${h.name} はSAFE_MODE発動中のためBUY抑制中（WAIT）。解除後に再判定されます。`)
                : debate?.recommendedAction
                ? debate.recommendedAction
                : displayDecision === 'BUY'
                  ? `${h.name} はBUYシグナルです。投資妙味・リスク条件を確認してください。`
                  : displayDecision === 'SELL'
                    ? `${h.name} はSELLシグナルです。損切・利確条件を確認してください。`
                    : displayDecision === 'WAIT'
                      ? jpStockCapExceeded && h.decision === 'BUY'
                        ? `${h.name} は国内個別株上限超過のためBUY抑制中（WAIT）。上限が解消されると再判定されます。必要ならT9で方針比率を見直せます。`
                        : locked
                          ? `${h.name} は3ヶ月売却ロック中のためSELL不可（WAIT）。${unlockDate ? `${unlockDate}以降に再判定します。` : '解除後に再判定します。'}`
                          : `${h.name} はWAIT判定です。条件未達のため次のシグナルを待ちます。`
                      : `${h.name} はHOLDシグナルです。継続監視をお勧めします。`
            }
          </div>
          {((debate?.bullReasons?.length ?? 0) > 0 || (debate?.bearReasons?.length ?? 0) > 0) && (
            <div className="comment-card__points">
              {debate?.bullReasons?.slice(0, 2).map((r, i) => (
                <div key={`bull-${i}`} className="comment-card__point comment-card__point--bull">▲ {r}</div>
              ))}
              {debate?.bearReasons?.slice(0, 2).map((r, i) => (
                <div key={`bear-${i}`} className="comment-card__point comment-card__point--bear">▼ {r}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ━━━ 3. 8軸スコア大カード横列 (UI-9-1) ━━━━━━━━━━━━━━━━━━ */}
      <div>
        <div className="stock-detail__section-header">8軸スコア一覧</div>
        <div className="stock-detail__score-row">
          {axes.map(ax => {
            const col = axisColor(ax.value)
            return (
              <div key={ax.label} className="score-card">
                <div className="score-card__label">{ax.label}</div>
                <div className="score-card__value" style={{ color: col }}>{Math.round(ax.value)}</div>
                <div className="score-card__bar">
                  <div className="score-card__bar-fill" style={{ width: `${ax.value}%`, background: col }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ━━━ 4. 各軸詳細カード (UI-9-1) ━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div>
        <div className="stock-detail__section-header">各軸の詳細スコアと根拠</div>
        <div className="axis-detail-grid">
          {axisDetails.map(ad => {
            const col = axisColor(ad.value)
            return (
              <div key={ad.label} className="card axis-detail-card">
                <div className="axis-detail-card__header">
                  <div className="axis-detail-card__icon-name">
                    <span className="axis-detail-card__icon">{ad.icon}</span>
                    <span className="axis-detail-card__name">{ad.label}</span>
                  </div>
                  <span className="axis-detail-card__score" style={{ color: col }}>{Math.round(ad.value)}</span>
                </div>
                <div className="axis-detail-card__bar">
                  <div className="axis-detail-card__bar-fill" style={{ width: `${ad.value}%`, background: col }} />
                </div>
                <div className="axis-detail-card__text">{ad.reason}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ━━━ 4a. 主要指標テーブル (UI-9-1c) ━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div>
        <div className="stock-detail__section-header">主要指標</div>
        <div className="metrics-key-grid">
          {[
            { label: 'PER',     value: h.per > 0 ? `${h.per.toFixed(1)}倍` : '—', eval: h.per > 0 && h.per <= 15 ? '割安' : h.per > 0 && h.per <= 25 ? '適正' : h.per > 40 ? '割高' : '—', tone: h.per > 0 && h.per <= 15 ? 'positive' : h.per > 40 ? 'negative' : 'neutral' },
            { label: 'PBR',     value: h.pbr > 0 ? `${h.pbr.toFixed(2)}倍` : '—', eval: h.pbr > 0 && h.pbr < 1 ? '割安' : h.pbr <= 1.5 ? '低PBR' : h.pbr <= 3 ? '標準' : '割高', tone: h.pbr > 0 && h.pbr < 1.5 ? 'positive' : h.pbr > 4 ? 'negative' : 'neutral' },
            { label: 'ROE',     value: `${h.roe}%`,  eval: h.roe >= 15 ? '高収益' : h.roe >= 8 ? '標準' : '低収益', tone: h.roe >= 15 ? 'positive' : h.roe >= 8 ? 'neutral' : 'negative' },
            { label: 'EPS成長',  value: `${h.epsG >= 0 ? '+' : ''}${h.epsG}%`, eval: h.epsG >= 15 ? '高成長' : h.epsG >= 5 ? '増益' : h.epsG >= 0 ? '横ばい' : '減益', tone: h.epsG >= 5 ? 'positive' : h.epsG >= 0 ? 'neutral' : 'negative' },
            { label: 'D/Eレシオ', value: `${h.de.toFixed(1)}倍`, eval: h.de <= 0.5 ? '無借金' : h.de <= 1.0 ? '健全' : h.de <= 3.0 ? '標準' : '高レバ', tone: h.de <= 1.0 ? 'positive' : h.de > 3.0 ? 'negative' : 'neutral' },
            { label: '配当成長',  value: `${h.divG >= 0 ? '+' : ''}${h.divG}%`, eval: h.divG >= 8 ? '高成長還元' : h.divG >= 3 ? '安定成長' : h.divG >= 0 ? '横ばい' : '減配', tone: h.divG >= 3 ? 'positive' : h.divG < 0 ? 'negative' : 'neutral' },
          ].map(({ label, value, eval: evalLabel, tone }) => {
            const toneColor = tone === 'positive' ? colors.buy : tone === 'negative' ? colors.sell : colors.textMuted
            return (
              <div key={label} className="metrics-key-card">
                <div className="metrics-key-card__label">{label}</div>
                <div className="metrics-key-card__value">{value}</div>
                <div className="metrics-key-card__eval" style={{ color: toneColor }}>{evalLabel}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ━━━ 4b. 価格・モメンタムサマリー (UI-9-1c) ━━━━━━━━━━━━━━━ */}
      <div className="card price-summary-card">
        <div className="stock-detail__section-header">価格・モメンタム</div>
        <div className="price-summary-row">
          {h.currentPrice != null && (
            <div className="price-summary-item">
              <div className="price-summary-item__label">株価（現在値）</div>
              <div className="price-summary-item__value">
                {h.currentPrice.toLocaleString('ja-JP')}
                <span style={{ fontSize: '11px', fontWeight: 500, marginLeft: '3px' }}>円</span>
              </div>
            </div>
          )}
          <div className="price-summary-item">
            <div className="price-summary-item__label">評価額</div>
            <div className="price-summary-item__value" style={{ fontSize: '14px' }}>{formatJPYAuto(h.eval)}</div>
          </div>
          <div className="price-summary-item">
            <div className="price-summary-item__label">損益率</div>
            <div className="price-summary-item__value" style={{ fontSize: '16px', color: h.pnlPct > 0 ? colors.buy : h.pnlPct < 0 ? colors.sell : colors.textPrimary }}>
              {formatSignedPct(h.pnlPct)}
            </div>
          </div>
          <div className="price-summary-item">
            <div className="price-summary-item__label">3Mモメンタム</div>
            <div className="price-summary-item__value" style={{ fontSize: '16px', color: h.mom3m > 0 ? colors.buy : colors.sell }}>
              {h.mom3m >= 0 ? '+' : ''}{h.mom3m.toFixed(1)}%
            </div>
          </div>
          <div className="price-summary-item">
            <div className="price-summary-item__label">RSI</div>
            <div className="price-summary-item__value" style={{ fontSize: '16px', color: h.rsi > 70 ? colors.sell : h.rsi < 30 ? colors.buy : colors.textPrimary }}>
              {h.rsi.toFixed(0)}
            </div>
            <div className="rsi-bar-wrap">
              <div className="rsi-bar-fill" style={{ width: `${h.rsi}%`, background: h.rsi > 70 ? colors.sell : h.rsi < 30 ? colors.buy : colors.wait }} />
            </div>
          </div>
          <div className="price-summary-item">
            <div className="price-summary-item__label">β（ベータ）</div>
            <div className="price-summary-item__value" style={{ fontSize: '16px' }}>{h.beta.toFixed(2)}</div>
          </div>
        </div>
        <div style={{ fontSize: '10px', color: colors.textMuted, borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: '8px', marginTop: '4px' }}>
          ※ 本カードはモメンタム指標の参照用表示です。株価チャート表示には時系列データが必要です（indicative only）
        </div>
      </div>

      {/* ━━━ 4c. アクションプランカード (UI-9-1c) ━━━━━━━━━━━━━━━━━ */}
      <div className="card action-plan-card">
        <div className="stock-detail__section-header" style={{ marginBottom: '14px' }}>アクションプラン</div>
        <div className="action-plan-grid">
          <div>
            <div className="action-plan-item__label">目標株価</div>
            <div className="action-plan-item__value" style={{ color: colors.buy }}>
              {h.target.toLocaleString('ja-JP')}
              <span style={{ fontSize: '12px', fontWeight: 500, marginLeft: '3px' }}>円</span>
            </div>
            {h.currentPrice != null && h.currentPrice > 0 && (
              <div className="action-plan-item__sub">
                {((h.target / h.currentPrice - 1) * 100).toFixed(1)}% 上昇余地
              </div>
            )}
          </div>
          <div>
            <div className="action-plan-item__label">損切ライン（アラート）</div>
            <div className="action-plan-item__value" style={{ color: colors.sell }}>
              {h.alert.toLocaleString('ja-JP')}
              <span style={{ fontSize: '12px', fontWeight: 500, marginLeft: '3px' }}>円</span>
            </div>
            {h.currentPrice != null && h.currentPrice > 0 && (
              <div className="action-plan-item__sub">
                {((h.alert / h.currentPrice - 1) * 100).toFixed(1)}% 下落で発動
              </div>
            )}
          </div>
          <div>
            <div className="action-plan-item__label">リスクゲート</div>
            <div className="action-plan-item__value" style={{ fontSize: '14px', color: debate?.riskGatePass ? colors.buy : colors.sell }}>
              {debate?.riskGatePass ? '✓ 通過' : '✗ 非通過'}
            </div>
            <div className="action-plan-item__sub">
              {debate?.riskGatePass ? '執行条件を充足' : '追加リスク確認が必要'}
            </div>
          </div>
        </div>
        {(debate?.takeProfitConditions?.filter(Boolean).length ?? 0) > 0 && (
          <div style={{ borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.stockAccentText, marginBottom: '6px' }}>利確条件</div>
            <div style={{ fontSize: '12px', color: colors.textSecond, lineHeight: 1.6 }}>
              {debate?.takeProfitConditions?.filter(Boolean)[0]}
            </div>
          </div>
        )}
        {(debate?.stopLossConditions?.filter(Boolean).length ?? 0) > 0 && (
          <div style={{ borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: '10px', marginTop: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.sellText, marginBottom: '6px' }}>損切条件</div>
            <div style={{ fontSize: '12px', color: colors.textSecond, lineHeight: 1.6 }}>
              {debate?.stopLossConditions?.filter(Boolean)[0]}
            </div>
          </div>
        )}
        <div style={{ fontSize: '10px', color: colors.textMuted, marginTop: '12px', paddingTop: '8px', borderTop: `1px solid ${colors.borderSubtle}` }}>
          ※ 参照用表示です。注文・実行機能はありません（UI only / not an order）
        </div>
      </div>

      {/* ━━━ 5. 総合判断 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {a && (
        <div style={cardStyle}>
          <div style={{ padding: `${spacing[3]} ${spacing[5]}`, background: colors.bgElevated, borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: colors.textPrimary }}>総合判断</span>
            <span style={{ fontSize: '11px', color: colors.textSubtle, marginLeft: spacing[3] }}>結論 → 根拠 → リスク → 行動</span>
          </div>
          <div style={{ padding: `${spacing[4]} ${spacing[5]}` }}>

            {/* スタンス・アクション・リスクゲート */}
            <div style={{ display: 'flex', gap: spacing[5], flexWrap: 'wrap', marginBottom: spacing[4], paddingBottom: spacing[4], borderBottom: `1px solid ${colors.borderSubtle}` }}>
              <div>
                <div style={{ fontSize: '10px', color: colors.textMuted }}>現在スタンス</div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: dc.text, marginTop: '2px' }}>
                  {displayDecision === 'BUY'
                    ? '積極保有 / 追加検討'
                    : displayDecision === 'SELL'
                      ? '売却推奨 / 条件確認'
                      : displayDecision === 'DATA_WAIT'
                        ? 'データ更新待ち / シグナル参考値のみ'
                        : displayDecision === 'WAIT'
                          ? '待機 / 条件未達'
                          : '継続保有 / 様子見'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: colors.textMuted }}>推奨アクション</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary, marginTop: '2px' }}>
                  {(officialDecision?.dataQualitySuppressed ?? dq.isSuppressed) && h.decision === 'BUY'
                    ? 'データ更新待ち — データ品質低下のため新規買いを抑制中。シグナルは参考値のみ。'
                    : officialAction != null
                      ? officialActionText(officialAction)
                      : safeModeActive && h.decision === 'BUY'
                        ? 'SAFE_MODE発動中 — 新規買付停止。解除後に再判定されます。'
                        : debate?.recommendedAction ?? '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: colors.textMuted }}>リスクゲート</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: debate?.riskGatePass ? colors.buy : colors.sell, marginTop: '2px' }}>
                  {debate?.riskGatePass ? '通過 — 執行可' : '非通過 — 執行抑制'}
                </div>
              </div>
              {/* P4-A121: AI確信度を円形ゲージ表示 */}
              <CircularGauge
                value={Math.round(a.confidence * 100)}
                size={72}
                strokeWidth={8}
                tone={a.confidence >= 0.65 ? 'buy' : a.confidence >= 0.45 ? 'hold' : 'wait'}
                label="AI確信度"
                unit="%"
              />
            </div>

            {/* 前提崩れ条件 */}
            {debate?.premiseBreakConditions && debate.premiseBreakConditions.filter(Boolean).length > 0 && (
              <div style={{
                background: colors.sellBg, border: `1px solid ${colors.sellBorder}`,
                borderRadius: radius.md, padding: `${spacing[3]} ${spacing[4]}`,
              }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: colors.sellText, marginBottom: spacing[2] }}>
                  前提崩れ条件（発生時は即座に再評価）
                </div>
                <ReasonList items={debate.premiseBreakConditions} accent={colors.sell} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ━━━ 旧 section 3 多軸スコア可視化は UI-9-1 8軸スコア大カードに統合 ━━━ */}

      {/* ━━━ 6. ファンダメンタル分析 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div>
        <SectionHeader title="ファンダメンタル分析" caption="数値 + 評価ラベル + 一言理由" />
        <div style={cardStyle}>
          {fundaRows.map((item) => (
            <FundaRow
              key={item.label}
              label={item.label}
              value={item.value}
              evalLabel={item.evalLabel}
              reason={item.reason}
              tone={item.tone}
            />
          ))}
          {/* 末尾ボーダー除去 */}
          <div style={{ height: '1px', marginTop: '-1px', background: colors.bgSurface }} />
        </div>
      </div>

      {/* ━━━ 5. テクニカル分析 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div>
        <SectionHeader title="テクニカル分析" caption="状態ラベル + 評価 + 一言理由" />
        <div style={cardStyle}>
          {techRows.map(item => (
            <TechRow
              key={item.label}
              label={item.label}
              state={item.state}
              evalStr={item.evalStr}
              reason={item.reason}
              signal={item.signal}
            />
          ))}
          <div style={{ height: '1px', marginTop: '-1px', background: colors.bgSurface }} />
        </div>
      </div>

      {/* ━━━ 6. Bull / Bear 要因 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {debate && (debate.bullReasons.filter(Boolean).length > 0 || debate.bearReasons.filter(Boolean).length > 0) && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
          gap: spacing[3],
        }}>
          {debate.bullReasons.filter(Boolean).length > 0 && (
            <div>
              <SectionHeader title="Bull 要因" />
              <div style={{ ...cardStyle, border: `1px solid ${colors.buyBorder}` }}>
                <div style={{ padding: `${spacing[3]} ${spacing[4]}` }}>
                  <ReasonList items={debate.bullReasons} accent={colors.buy} />
                </div>
              </div>
            </div>
          )}
          {debate.bearReasons.filter(Boolean).length > 0 && (
            <div>
              <SectionHeader title="Bear 要因" />
              <div style={{ ...cardStyle, border: `1px solid ${colors.sellBorder}` }}>
                <div style={{ padding: `${spacing[3]} ${spacing[4]}` }}>
                  <ReasonList items={debate.bearReasons} accent={colors.sell} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ━━━ 7. 執行条件 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {debate && (
        <div>
          <SectionHeader title="執行条件" caption="エントリー / 利確 / 損切" />
          <div style={cardStyle}>
            {debate.buyReasons.filter(Boolean).length > 0 && (
              <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: colors.buyText, marginBottom: spacing[2] }}>
                  エントリー条件（今買う理由）
                </div>
                <ReasonList items={debate.buyReasons} accent={colors.buy} />
              </div>
            )}
            {debate.takeProfitConditions.filter(Boolean).length > 0 && (
              <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: colors.textPrimary, marginBottom: spacing[2] }}>
                  利確条件
                </div>
                <ReasonList items={debate.takeProfitConditions} accent={colors.stockAccent} />
              </div>
            )}
            {debate.stopLossConditions.filter(Boolean).length > 0 && (
              <div style={{ padding: `${spacing[3]} ${spacing[4]}`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: colors.sellText, marginBottom: spacing[2] }}>
                  損切条件
                </div>
                <ReasonList items={debate.stopLossConditions} accent={colors.sell} />
              </div>
            )}
            {debate.waitReasons && debate.waitReasons.filter(Boolean).length > 0 && (
              <div style={{ padding: `${spacing[3]} ${spacing[4]}` }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: colors.waitText, marginBottom: spacing[2] }}>
                  継続保有理由 / 待機理由
                </div>
                <ReasonList items={debate.waitReasons} accent={colors.wait} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ━━━ 8. 理想PF役割 / 現在PF位置づけ ━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
        gap: spacing[3],
      }}>
        <div>
          <SectionHeader title="理想PFでの役割" />
          <div style={{ ...cardStyle, padding: `${spacing[3]} ${spacing[4]}` }}>
            <div style={{ fontSize: '12px', color: colors.textPrimary, lineHeight: '1.6' }}>
              {h.beta >= 1.2
                ? '高ベータ成長株 — ブル相場での収益牽引役として積極保有'
                : h.beta <= 0.8
                  ? 'ディフェンシブ株 — 下落局面での損失抑制役として重要'
                  : '標準ベータ株 — バランス型のコアポジション'}
            </div>
            <div style={{ fontSize: '11px', color: colors.textSubtle, marginTop: spacing[2] }}>
              セクター: {h.sector} / β {h.beta.toFixed(2)}
            </div>
            {h.mitsu && (
              <div style={{ fontSize: '11px', color: colors.waitText, marginTop: spacing[1] }}>
                三菱Gグループ — 集中リスクあり（40%超でリバランス検討）
              </div>
            )}
          </div>
        </div>
        <div>
          <SectionHeader title="現在PFでの位置づけ" />
          <div style={{ ...cardStyle, padding: `${spacing[3]} ${spacing[4]}` }}>
            <div style={{ fontSize: '12px', color: colors.textPrimary, lineHeight: '1.6' }}>
              評価額 {formatJPYAuto(h.eval)} / 損益 {formatSignedPct(h.pnlPct)}
            </div>
            <div style={{ fontSize: '12px', color: colors.textSubtle, marginTop: spacing[1], lineHeight: '1.6' }}>
              {displayDecision === 'BUY'
                ? '積極的に保有継続。追加余地あり。'
                : displayDecision === 'DATA_WAIT'
                  ? '最新データ取得後に再判定してください。'
                  : displayDecision === 'SELL'
                    ? '売却を検討してください。損切・利確条件を確認してください。'
                    : displayDecision === 'WAIT'
                      ? safeModeActive && h.decision === 'BUY'
                        ? 'SAFE_MODE発動中 — 新規買付停止。解除後に再判定されます。'
                        : jpStockCapExceeded && h.decision === 'BUY'
                        ? '国内個別株上限超過のためBUY抑制（WAIT）。上限超過が解消されると再判定されます。必要ならT9で方針比率を見直せます。'
                        : '待機。ロック制約または条件未達のため、次のシグナルを待ちます。'
                      : '現状維持。次のシグナルを待つ。'}
            </div>
            {locked && unlockDate && (
              <div style={{
                marginTop: spacing[2], padding: `${spacing[2]} ${spacing[3]}`,
                background: colors.waitBg, border: `1px solid ${colors.waitBorder}`,
                borderRadius: radius.sm, fontSize: '11px', color: colors.waitText,
              }}>
                売却可能: {unlockDate}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ━━━ 9. Phase 7 軸別スコア (calculation-only) ━━━━━━━━━━━━ */}
      {phase7Record && (
        <Phase7StockScoreSection
          record={phase7Record}
          cardStyle={cardStyle}
          isMobile={isMobile}
        />
      )}

      {/* ━━━ 10. 結論サマリー CTA (UI-9-1) ━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div className="card conclusion-card">
        <div className="stock-detail__section-header" style={{ marginBottom: '16px' }}>結論サマリー</div>
        <div className="conclusion-card__grid">
          <div>
            <div className="conclusion-card__item-label">結論</div>
            <div className="conclusion-card__item-title" style={{ color: dc.text }}>
              {displayDecision === 'BUY'
                ? '中長期で有望'
                : displayDecision === 'SELL'
                  ? '売却を検討'
                  : displayDecision === 'DATA_WAIT'
                    ? 'データ更新待ち'
                    : displayDecision === 'WAIT'
                      ? '待機（見送り）'
                      : '現状維持'}
            </div>
            <div className="conclusion-card__item-text">
              {displayDecision === 'DATA_WAIT'
                ? 'データ品質低下のためシグナルは参考値のみです。最新データ取得後に再判定してください。'
                : debate?.buyReasons?.[0] ?? (
                    displayDecision === 'BUY'
                      ? '現在の水準では投資妙味あり'
                      : displayDecision === 'SELL'
                        ? '損切・利確条件を確認してください'
                        : '継続監視をお勧めします'
                  )}
            </div>
          </div>
          <div>
            <div className="conclusion-card__item-label">注目ポイント</div>
            <div className="conclusion-card__item-title">{truncate(debate?.bullReasons?.[0])}</div>
            <div className="conclusion-card__item-text">{debate?.bullReasons?.[0] ?? '詳細分析を参照してください'}</div>
          </div>
          <div>
            <div className="conclusion-card__item-label">注意点</div>
            <div className="conclusion-card__item-title">{truncate(debate?.bearReasons?.[0])}</div>
            <div className="conclusion-card__item-text">{debate?.bearReasons?.[0] ?? 'リスク管理を徹底してください'}</div>
          </div>
        </div>
        <p className="conclusion-card__manual-note">
          ※ 売買・登録はご自身の証券口座で手動で行ってください
        </p>
      </div>

      {/* ━━━ UI-12-3: Bottom Sticky CTA ━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {/* spacer: prevent last content being hidden behind fixed bar */}
      <div aria-hidden="true" style={{ height: isMobile ? '148px' : '80px' }} />
      <div className="stock-sticky-cta">
        <div className="stock-sticky-cta__content">
          <span
            className="stock-sticky-cta__decision"
            style={{
              background: displayDecision === 'BUY'  ? colors.buy
                        : displayDecision === 'SELL' ? colors.sell
                        : colors.hold,
              color: '#fff',
            }}
          >
            {displayDecisionLabel(displayDecision)}
          </span>
          <div className="stock-sticky-cta__summary">
            <div className="stock-sticky-cta__name">{h.name}</div>
            {debate?.bullReasons?.[0] ? (
              <div className="stock-sticky-cta__point stock-sticky-cta__point--bull">
                ▲ {truncate(debate.bullReasons[0], 28)}
              </div>
            ) : debate?.bearReasons?.[0] ? (
              <div className="stock-sticky-cta__point stock-sticky-cta__point--bear">
                ▼ {truncate(debate.bearReasons[0], 28)}
              </div>
            ) : null}
          </div>
        </div>
      </div>

    </div>
  )
}

// ── メインコンポーネント ──────────────────────────────────────

export function T1_Decision() {
  const holdings = useAppStore(s => s.holdings)
  const analysis = useAppStore(s => s.analysis)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)

  if (selectedCode) {
    return <StockDetail code={selectedCode} onBack={() => setSelectedCode(null)} />
  }

  return (
    <StockList
      holdings={holdings}
      analysis={analysis}
      onSelect={setSelectedCode}
    />
  )
}
