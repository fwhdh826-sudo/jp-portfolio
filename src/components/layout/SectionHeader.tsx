/**
 * SectionHeader — セクション見出し
 *
 * Usage:
 *   <SectionHeader title="リスク評価" />
 *   <SectionHeader title="ポジション一覧" caption="直近更新 08:30" action={<button>全表示</button>} />
 */

import { colors, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties, ReactNode } from 'react'

export interface SectionHeaderProps {
  title: string
  caption?: string
  action?: ReactNode
}

export function SectionHeader({ title, caption, action }: SectionHeaderProps) {
  const containerStyle: CSSProperties = {
    display:        'flex',
    alignItems:     'baseline',
    justifyContent: 'space-between',
    gap:            spacing[3],
    marginBottom:   spacing[3],
    borderLeft:     '4px solid var(--color-stock, #1d4ed8)',
    paddingLeft:    '10px',
  }

  const leftStyle: CSSProperties = {
    display:    'flex',
    alignItems: 'baseline',
    gap:        spacing[2],
    minWidth:   0,
  }

  const titleStyle: CSSProperties = {
    ...typography.sectionTitle,
    color:  colors.textPrimary,
    margin: 0,
  }

  const captionStyle: CSSProperties = {
    ...typography.caption,
    color: colors.textMuted,
  }

  return (
    <div style={containerStyle}>
      <div style={leftStyle}>
        <h2 style={titleStyle}>{title}</h2>
        {caption && <span style={captionStyle}>{caption}</span>}
      </div>
      {action}
    </div>
  )
}
