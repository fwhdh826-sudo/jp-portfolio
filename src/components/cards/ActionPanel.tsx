/**
 * ActionPanel — 推奨アクションエリア
 * 次に取るべき行動を優先度順で表示する。
 *
 * Usage:
 *   <ActionPanel
 *     title="推奨アクション"
 *     actions={[
 *       { label: "7203 を100株買い増し", signal: "BUY", priority: "HIGH",
 *         description: "現値 2,800円 / 目標 3,200円" },
 *       { label: "8316 の利益確定", signal: "SELL", priority: "MEDIUM" },
 *     ]}
 *   />
 */

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import { SignalBadge } from '../badges/SignalBadge'
import type { Signal } from '../badges/SignalBadge'
import type { CSSProperties } from 'react'

export interface ActionItem {
  label:       string
  description?: string
  signal?:     Signal
  priority?:   'HIGH' | 'MEDIUM' | 'LOW'
}

export interface ActionPanelProps {
  title?:   string
  actions:  ActionItem[]
}

const priorityDot: Record<'HIGH' | 'MEDIUM' | 'LOW', string> = {
  HIGH:   colors.sell,
  MEDIUM: colors.watch,
  LOW:    colors.buy,
}

export function ActionPanel({ title = '推奨アクション', actions }: ActionPanelProps) {
  const panelStyle: CSSProperties = {
    background:   colors.bgSurface,
    border:       `1px solid ${colors.borderSubtle}`,
    borderRadius: radius.lg,
    boxShadow:    shadow.sm,
    overflow:     'hidden',
  }

  const headerStyle: CSSProperties = {
    padding:      `${spacing[3]} ${spacing[4]}`,
    borderBottom: `1px solid ${colors.borderSubtle}`,
  }

  const headerTextStyle: CSSProperties = {
    ...typography.sectionTitle,
    color:  colors.textSubtle,
    margin: 0,
  }

  const listStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    margin:        0,
    padding:       0,
    listStyle:     'none',
  }

  const itemStyle = (last: boolean): CSSProperties => ({
    display:        'flex',
    alignItems:     'flex-start',
    gap:            spacing[3],
    padding:        `${spacing[3]} ${spacing[4]}`,
    borderBottom:   last ? 'none' : `1px solid ${colors.borderSubtle}`,
    transition:     'background 0.1s ease',
  })

  const dotStyle = (priority?: 'HIGH' | 'MEDIUM' | 'LOW'): CSSProperties => ({
    width:        '6px',
    height:       '6px',
    borderRadius: radius.full,
    background:   priority ? priorityDot[priority] : colors.textMuted,
    flexShrink:   0,
    marginTop:    '6px', // 1行目のベースラインに揃える
  })

  const itemContentStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[0.5],
    flex:          1,
    minWidth:      0,
  }

  const itemLabelStyle: CSSProperties = {
    ...typography.body,
    color:  colors.textPrimary,
    margin: 0,
  }

  const itemDescStyle: CSSProperties = {
    ...typography.caption,
    color: colors.textMuted,
  }

  if (actions.length === 0) {
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>
          <p style={headerTextStyle}>{title}</p>
        </div>
        <div style={{ padding: `${spacing[6]} ${spacing[4]}`, textAlign: 'center' }}>
          <p style={{ ...typography.bodySmall, color: colors.textMuted }}>推奨アクションなし</p>
        </div>
      </div>
    )
  }

  return (
    <div style={panelStyle} role="region" aria-label={title}>
      <div style={headerStyle}>
        <p style={headerTextStyle}>{title}</p>
      </div>
      <ul style={listStyle}>
        {actions.map((action, i) => (
          <li key={i} style={itemStyle(i === actions.length - 1)}>
            <span style={dotStyle(action.priority)} aria-hidden="true" />
            <div style={itemContentStyle}>
              <p style={itemLabelStyle}>{action.label}</p>
              {action.description && (
                <p style={itemDescStyle}>{action.description}</p>
              )}
            </div>
            {action.signal && <SignalBadge signal={action.signal} size="sm" />}
          </li>
        ))}
      </ul>
    </div>
  )
}
