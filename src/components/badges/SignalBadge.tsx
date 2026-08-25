/**
 * SignalBadge — BUY / SELL / HOLD / WATCH シグナルバッジ
 *
 * Usage:
 *   <SignalBadge signal="BUY" />
 *   <SignalBadge signal="SELL" size="lg" />
 */

import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export type Signal = 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'WAIT' | 'SUPPRESSED'

export interface SignalBadgeProps {
  signal: Signal
  size?: 'sm' | 'md' | 'lg'
}

// UI-9H H-P0-2: 可視トークン WATCH が持っていた3義を分離する。
// ① 真の監視 = WATCH（aria-label「監視」）
// ② 条件未達WAIT = WAIT（aria-label「待機」。旧実装ではWATCHへ潰れていた）
// ③ SAFE_MODE/DQ抑制されたBUY = SUPPRESSED（aria-label「抑制中」）
// WAIT は既存の wait 系カラートークン（colors.wait系）を再利用し新色は追加しない。
const signalConfig: Record<Signal, { bg: string; text: string; border: string; label: string }> = {
  BUY:        { bg: colors.buyBg,        text: colors.buyText,        border: colors.buy,        label: '買い' },
  SELL:       { bg: colors.sellBg,       text: colors.sellText,       border: colors.sell,       label: '売り' },
  HOLD:       { bg: colors.holdBg,       text: colors.holdText,       border: colors.hold,       label: '保有' },
  WATCH:      { bg: colors.watchBg,      text: colors.watchText,      border: colors.watch,      label: '監視' },
  WAIT:       { bg: colors.waitBg,       text: colors.waitText,       border: colors.wait,       label: '待機' },
  SUPPRESSED: { bg: colors.suppressedBg, text: colors.suppressedText, border: colors.suppressed, label: '抑制中' },
}

const sizeConfig = {
  sm: { padding: `${spacing[0.5]} ${spacing[1.5]}`, fontSize: '9px'  },
  md: { padding: `${spacing[1]}  ${spacing[2]}`,   fontSize: '10px' },
  lg: { padding: `${spacing[1.5]} ${spacing[3]}`,  fontSize: '12px' },
}

export function SignalBadge({ signal, size = 'md' }: SignalBadgeProps) {
  const cfg = signalConfig[signal]
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
    <span style={style} data-signal={signal} aria-label={`シグナル: ${cfg.label}`}>
      {cfg.label}
    </span>
  )
}
