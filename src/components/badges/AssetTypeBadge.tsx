/**
 * AssetTypeBadge — 個別株 / 投信 区別バッジ
 *
 * 色の意味（固定）:
 *   個別株 → stockAccent (青系)
 *   投信   → fundAccent  (紫〜青紫)
 *
 * Usage:
 *   <AssetTypeBadge type="stock" />
 *   <AssetTypeBadge type="fund" size="sm" />
 */

import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export type AssetType = 'stock' | 'fund'

export interface AssetTypeBadgeProps {
  type: AssetType
  size?: 'sm' | 'md'
}

const typeConfig: Record<AssetType, { bg: string; text: string; border: string; label: string }> = {
  stock: {
    bg:     colors.stockAccentBg,
    text:   colors.stockAccentText,
    border: colors.stockAccent,
    label:  '個別株',
  },
  fund: {
    bg:     colors.fundAccentBg,
    text:   colors.fundAccentText,
    border: colors.fundAccent,
    label:  '投信',
  },
}

const sizeConfig = {
  sm: { padding: `${spacing[0.5]} ${spacing[1.5]}`, fontSize: '9px'  },
  md: { padding: `${spacing[1]}  ${spacing[2]}`,   fontSize: '10px' },
}

export function AssetTypeBadge({ type, size = 'md' }: AssetTypeBadgeProps) {
  const cfg = typeConfig[type]
  const sz  = sizeConfig[size]

  const style: CSSProperties = {
    display:       'inline-flex',
    alignItems:    'center',
    padding:       sz.padding,
    background:    cfg.bg,
    color:         cfg.text,
    border:        `1px solid ${cfg.border}`,
    borderRadius:  radius.full,
    fontSize:      sz.fontSize,
    fontWeight:    typography.badge.fontWeight,
    fontFamily:    typography.badge.fontFamily,
    letterSpacing: typography.badge.letterSpacing,
    textTransform: 'uppercase',
    lineHeight:    '1',
    whiteSpace:    'nowrap',
    userSelect:    'none',
  }

  return (
    <span style={style} aria-label={`アセットタイプ: ${cfg.label}`}>
      {cfg.label}
    </span>
  )
}
