/**
 * MobileBottomActionBar — スマホ用下部固定CTA
 * safe-area-inset-bottom に対応し、ホームバーと重ならないようにする。
 * デスクトップでは非表示（CSS media query）。
 *
 * Usage:
 *   <MobileBottomActionBar
 *     primaryAction={{ label: "BUY 執行", signal: "BUY", onClick: handleBuy }}
 *     secondaryAction={{ label: "詳細", onClick: openDetail }}
 *   />
 */

import { colors, radius, shadow, spacing, zIndex } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import { SignalBadge } from '../badges/SignalBadge'
import type { Signal } from '../badges/SignalBadge'
import type { CSSProperties } from 'react'

export interface MobileBottomActionBarProps {
  primaryAction: {
    label:    string
    onClick:  () => void
    signal?:  Signal
    disabled?: boolean
  }
  secondaryAction?: {
    label:   string
    onClick: () => void
  }
}

export const signalButtonColor: Partial<Record<Signal, string>> = {
  BUY:   colors.buy,
  SELL:  colors.sell,
  HOLD:  colors.hold,
  WATCH: colors.watch,
}

export function MobileBottomActionBar({
  primaryAction,
  secondaryAction,
}: MobileBottomActionBarProps) {
  // デスクトップでは非表示
  const barStyle: CSSProperties = {
    position:          'fixed',
    bottom:            0,
    left:              0,
    right:             0,
    zIndex:            zIndex.sticky,
    display:           'flex',
    gap:               spacing[2],
    padding:           `${spacing[3]} ${spacing[4]}`,
    paddingBottom:     `calc(${spacing[3]} + env(safe-area-inset-bottom, 0px))`,
    background:        colors.bgSurface,
    borderTop:         `1px solid ${colors.borderDefault}`,
    boxShadow:         shadow.xl,
  }

  const primaryColor = primaryAction.signal
    ? signalButtonColor[primaryAction.signal] ?? colors.primary
    : colors.primary

  const primaryStyle: CSSProperties = {
    flex:            secondaryAction ? 3 : 1,
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    gap:             spacing[2],
    padding:         `${spacing[3]} ${spacing[4]}`,
    background:      primaryAction.disabled ? colors.borderSubtle : primaryColor,
    // BUY/SELL/HOLD/WATCHの背景色はいずれも白文字でAA 4.5:1以上（textPrimaryではdark-on-darkでAA未達）
    color:           primaryAction.disabled ? colors.textMuted : '#ffffff',
    border:          'none',
    borderRadius:    radius.lg,
    cursor:          primaryAction.disabled ? 'not-allowed' : 'pointer',
    opacity:         primaryAction.disabled ? 0.5 : 1,
    minHeight:       '44px', // タップ領域 最低44px確保
    ...typography.body,
    fontWeight:      600,
    transition:      'opacity 0.15s ease',
  }

  const secondaryStyle: CSSProperties = {
    flex:           1,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    padding:        `${spacing[3]} ${spacing[4]}`,
    background:     colors.bgElevated,
    color:          colors.textSubtle,
    border:         `1px solid ${colors.borderDefault}`,
    borderRadius:   radius.lg,
    cursor:         'pointer',
    minHeight:      '44px',
    ...typography.body,
    transition:     'opacity 0.15s ease',
  }

  return (
    // モバイルのみ表示するため data-mobile-bar 属性を付与
    // (v5.css または新CSS側で @media(min-width:840px){ display:none } を設定)
    <div style={barStyle} data-mobile-bar="true" role="toolbar" aria-label="アクションバー">
      {secondaryAction && (
        <button style={secondaryStyle} onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
      <button
        style={primaryStyle}
        onClick={primaryAction.onClick}
        disabled={primaryAction.disabled}
      >
        {primaryAction.signal && <SignalBadge signal={primaryAction.signal} size="sm" />}
        {primaryAction.label}
      </button>
    </div>
  )
}
