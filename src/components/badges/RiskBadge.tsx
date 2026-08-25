/**
 * RiskBadge — リスクレベルバッジ（HIGH / MEDIUM / LOW）
 *
 * Usage:
 *   <RiskBadge level="HIGH" />
 *   <RiskBadge level="LOW" size="sm" />
 */

import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW'

export interface RiskBadgeProps {
  level: RiskLevel
  size?: 'sm' | 'md'
}

const levelConfig: Record<RiskLevel, { bg: string; text: string; border: string; label: string }> = {
  HIGH:   { bg: colors.sellBg,   text: colors.sellText,  border: colors.sell,  label: '高リスク' },
  MEDIUM: { bg: colors.watchBg,  text: colors.watchText, border: colors.watch, label: '中リスク' },
  LOW:    { bg: colors.buyBg,    text: colors.buyText,   border: colors.buy,   label: '低リスク' },
}

const sizeConfig = {
  sm: { padding: `${spacing[0.5]} ${spacing[1.5]}`, fontSize: '9px'  },
  md: { padding: `${spacing[1]}  ${spacing[2]}`,   fontSize: '10px' },
}

export function RiskBadge({ level, size = 'md' }: RiskBadgeProps) {
  const cfg = levelConfig[level]
  const sz  = sizeConfig[size]

  const style: CSSProperties = {
    display:       'inline-flex',
    alignItems:    'center',
    gap:           spacing[1],
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
    <span style={style} data-risk={level} aria-label={cfg.label}>
      {cfg.label}
    </span>
  )
}
