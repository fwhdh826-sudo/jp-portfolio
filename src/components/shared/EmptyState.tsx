/**
 * EmptyState — データなし状態の表示
 *
 * Usage:
 *   <EmptyState message="データがありません" />
 *   <EmptyState message="保有銘柄なし" detail="CSVをインポートしてください" />
 */

import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export interface EmptyStateProps {
  message: string
  detail?: string
}

export function EmptyState({ message, detail }: EmptyStateProps) {
  const containerStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    justifyContent:'center',
    gap:           spacing[2],
    padding:       `${spacing[8]} ${spacing[4]}`,
    background:    colors.bgSurface,
    border:        `1px dashed ${colors.borderSubtle}`,
    borderRadius:  radius.lg,
    textAlign:     'center',
  }

  const iconStyle: CSSProperties = {
    fontSize:   '24px',
    lineHeight: '1',
    opacity:    0.4,
  }

  const messageStyle: CSSProperties = {
    ...typography.bodySmall,
    color: colors.textSubtle,
  }

  const detailStyle: CSSProperties = {
    ...typography.caption,
    color: colors.textMuted,
  }

  return (
    <div style={containerStyle} role="status" aria-label={message}>
      <span style={iconStyle} aria-hidden="true">—</span>
      <p style={messageStyle}>{message}</p>
      {detail && <p style={detailStyle}>{detail}</p>}
    </div>
  )
}
