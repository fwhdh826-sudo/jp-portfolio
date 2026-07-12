/**
 * InsightCard — AI分析 4ブロック表示
 *
 * 4ブロック（結論/根拠/リスク/アクション）はすべて必須フィールド。
 * 任意フィールドなし（CLAUDE.md §6 の要件）。
 *
 * 表示順:
 *   1. 結論  — 一文で何を意味するか
 *   2. 根拠  — 2〜4点・箇条書き
 *   3. リスク — 逆シナリオ・前提崩れ
 *   4. アクション — BUY/SELL/HOLD等 + 具体的内容
 *
 * 推奨追加項目 (optional):
 *   confidence / horizon / watchMetric / changeFromLast
 *
 * Usage:
 *   <InsightCard
 *     conclusion="割安圏で積極的に買い増し可能"
 *     reasons={["PER 12x は業種平均を25%下回る", "営業CF は3期連続増加"]}
 *     risks={["米国金利再上昇で円安進行リスク"]}
 *     action="BUY — 現在価格帯で分割購入を推奨"
 *   />
 */

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export interface InsightCardProps {
  // 必須 4ブロック
  conclusion: string
  reasons:    string[]
  risks:      string[]
  action:     string
  // 推奨追加項目
  confidence?:     'HIGH' | 'MEDIUM' | 'LOW'
  horizon?:        string
  watchMetric?:    string
  changeFromLast?: string
}

const confidenceConfig = {
  HIGH:   { color: colors.buyText,   label: '確信度: 高' },
  MEDIUM: { color: colors.watchText, label: '確信度: 中' },
  LOW:    { color: colors.sellText,  label: '確信度: 低' },
}

export function InsightCard({
  conclusion,
  reasons,
  risks,
  action,
  confidence,
  horizon,
  watchMetric,
  changeFromLast,
}: InsightCardProps) {
  const cardStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[1],
    background:    colors.bgSurface,
    border:        `1px solid ${colors.borderSubtle}`,
    borderRadius:  radius.lg,
    boxShadow:     shadow.sm,
    overflow:      'hidden',
  }

  const blockStyle = (accent: string, bg: string): CSSProperties => ({
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[1.5],
    padding:       `${spacing[3]} ${spacing[4]}`,
    borderLeft:    `3px solid ${accent}`,
    background:    bg,
  })

  const blockLabelStyle = (color: string): CSSProperties => ({
    ...typography.label,
    color,
  })

  const blockTextStyle: CSSProperties = {
    ...typography.bodySmall,
    color: colors.textPrimary,
    margin: 0,
  }

  const listStyle: CSSProperties = {
    margin:         0,
    paddingLeft:    spacing[4],
    display:        'flex',
    flexDirection:  'column',
    gap:            spacing[1],
  }

  const listItemStyle: CSSProperties = {
    ...typography.bodySmall,
    color: colors.textSubtle,
  }

  const metaRowStyle: CSSProperties = {
    display:        'flex',
    flexWrap:       'wrap',
    gap:            `${spacing[1]} ${spacing[4]}`,
    padding:        `${spacing[2]} ${spacing[4]}`,
    background:     colors.bgBase,
    borderTop:      `1px solid ${colors.borderSubtle}`,
  }

  const metaItemStyle: CSSProperties = {
    ...typography.caption,
    color: colors.textMuted,
  }

  const hasMeta = confidence || horizon || watchMetric || changeFromLast

  return (
    <div style={cardStyle} role="region" aria-label="AI分析">
      {/* ブロック1: 結論 */}
      <div style={blockStyle(colors.primary, `${colors.stockAccentBg}`)}>
        <p style={blockLabelStyle(colors.stockAccentText)}>結論</p>
        <p style={blockTextStyle}>{conclusion}</p>
      </div>

      {/* ブロック2: 根拠 */}
      <div style={blockStyle(colors.buy, colors.buyBg)}>
        <p style={blockLabelStyle(colors.buyText)}>根拠</p>
        <ul style={listStyle}>
          {reasons.map((r, i) => (
            <li key={i} style={listItemStyle}>{r}</li>
          ))}
        </ul>
      </div>

      {/* ブロック3: リスク */}
      <div style={blockStyle(colors.sell, colors.sellBg)}>
        <p style={blockLabelStyle(colors.sellText)}>リスク</p>
        <ul style={listStyle}>
          {risks.map((r, i) => (
            <li key={i} style={listItemStyle}>{r}</li>
          ))}
        </ul>
      </div>

      {/* ブロック4: アクション */}
      <div style={blockStyle(colors.hold, colors.holdBg)}>
        <p style={blockLabelStyle(colors.holdText)}>アクション</p>
        <p style={blockTextStyle}>{action}</p>
      </div>

      {/* 追加メタ情報 */}
      {hasMeta && (
        <div style={metaRowStyle}>
          {confidence && (
            <span style={{ ...metaItemStyle, color: confidenceConfig[confidence].color }}>
              {confidenceConfig[confidence].label}
            </span>
          )}
          {horizon      && <span style={metaItemStyle}>時間軸: {horizon}</span>}
          {watchMetric  && <span style={metaItemStyle}>注視: {watchMetric}</span>}
          {changeFromLast && <span style={metaItemStyle}>前回比: {changeFromLast}</span>}
        </div>
      )}
    </div>
  )
}
