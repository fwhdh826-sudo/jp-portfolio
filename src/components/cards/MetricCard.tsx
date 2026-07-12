/**
 * MetricCard — 数値表示カード
 * タイトル・主要数値・変化量・補助テキストを1枚に収める。
 *
 * Usage:
 *   <MetricCard title="評価額" value="¥1,234,567" />
 *   <MetricCard
 *     title="含み損益"
 *     value="+¥123,456"
 *     change={{ value: "+10.2%", positive: true }}
 *     subtext="前日比"
 *     assetType="stock"
 *   />
 */

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export interface MetricCardProps {
  title:     string
  value:     string | number
  change?:   { value: string | number; positive?: boolean }
  subtext?:  string
  assetType?:'stock' | 'fund'
  accent?:   boolean   // 強調表示（primaryカラーの左ボーダー）
}

export function MetricCard({ title, value, change, subtext, assetType, accent }: MetricCardProps) {
  const accentColor =
    assetType === 'fund'  ? colors.fundAccent  :
    assetType === 'stock' ? colors.stockAccent :
    colors.primary

  const containerStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[1.5],
    padding:       `${spacing[4]} ${spacing[5]}`,
    background:    colors.bgSurface,
    border:        `1px solid ${colors.borderSubtle}`,
    borderLeft:    accent ? `3px solid ${accentColor}` : `1px solid ${colors.borderSubtle}`,
    borderRadius:  radius.lg,
    boxShadow:     shadow.sm,
    minWidth:      0,
  }

  const titleStyle: CSSProperties = {
    ...typography.label,
    color: colors.textMuted,
  }

  const valueStyle: CSSProperties = {
    ...typography.metricMedium,
    color: colors.textPrimary,
  }

  const changeStyle: CSSProperties = {
    ...typography.metricSmall,
    color: change?.positive === true  ? colors.buyText  :
           change?.positive === false ? colors.sellText :
           colors.textSubtle,
  }

  const subtextStyle: CSSProperties = {
    ...typography.caption,
    color: colors.textMuted,
  }

  return (
    <div style={containerStyle}>
      <p style={titleStyle}>{title}</p>
      <p style={valueStyle}>{value}</p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: spacing[2] }}>
        {change  && <span style={changeStyle}>{change.value}</span>}
        {subtext && <span style={subtextStyle}>{subtext}</span>}
      </div>
    </div>
  )
}
