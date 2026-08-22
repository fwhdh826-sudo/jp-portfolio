/**
 * StateBanner — 状態（抑制・エラー・取得中など）を告知する共通バナー（UI-9F §6.1(2)）
 *
 * 新しい color token は追加しない。tone → 既存 token の対応表のみを持つ。
 * 判断ロジックは持たない。呼び出し側が決めた tone / 文言をそのまま表示する。
 *
 * a11y（D-6 対応）:
 *   live='off'（既定）  → role="region"（常設バナー。assertive に再読み上げさせない）
 *   live='polite'       → role="status"
 *   live='assertive'    → role="alert"
 *
 * Usage:
 *   <StateBanner tone="warning" label="追加投資判断 停止中" message="…" />
 *   <StateBanner tone="critical" live="assertive" label="画面を表示できませんでした"
 *                action={{ label: '再読み込み', onClick: reload }} />
 */

import { colors, radius, spacing, v13Colors } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

export type StateTone = 'info' | 'loading' | 'warning' | 'critical' | 'success'

export interface StateBannerProps {
  tone:     StateTone
  label:    string
  message?: string
  action?:  { label: string; onClick(): void }
  live?:    'off' | 'polite' | 'assertive'
}

// UI-9F §6.1(2) の frozen mapping。すべて既存 token。
const TONE_TOKENS: Record<StateTone, { bg: string; border: string; text: string }> = {
  info:     { bg: colors.neutralBg,       border: colors.borderSubtle,  text: colors.textSubtle },
  loading:  { bg: v13Colors.neutralBg,    border: colors.borderSubtle,  text: v13Colors.neutralText },
  warning:  { bg: colors.waitBg,          border: colors.waitBorder,    text: colors.waitText },
  critical: { bg: v13Colors.criticalBg,   border: v13Colors.critical,   text: v13Colors.criticalText },
  success:  { bg: colors.buyBg,           border: colors.buyBorder,     text: colors.buyText },
}

export function StateBanner({ tone, label, message, action, live = 'off' }: StateBannerProps) {
  const t = TONE_TOKENS[tone]

  const containerStyle: CSSProperties = {
    display:      'flex',
    alignItems:   'center',
    flexWrap:     'wrap',
    gap:          spacing[3],
    background:   t.bg,
    border:       `1px solid ${t.border}`,
    borderRadius: radius.lg,
    padding:      `${spacing[4]} ${spacing[5]}`,
  }

  const labelStyle: CSSProperties = {
    ...typography.bodySmall,
    color:      t.text,
    fontWeight: 700,
  }

  const messageStyle: CSSProperties = {
    ...typography.caption,
    color:      t.text,
    lineHeight: '1.6',
  }

  // F-P1-4 と同じ 44×44 最小タップターゲットを最初から満たす。
  const actionStyle: CSSProperties = {
    minWidth:     '44px',
    minHeight:    '44px',
    padding:      `${spacing[2]} ${spacing[4]}`,
    marginLeft:   'auto',
    background:   colors.bgSurface,
    color:        t.text,
    border:       `1px solid ${t.border}`,
    borderRadius: radius.md,
    fontSize:     '13px',
    fontWeight:   700,
    cursor:       'pointer',
  }

  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : 'region'

  return (
    <div
      style={containerStyle}
      role={role}
      aria-label={role === 'region' ? label : undefined}
      aria-live={live === 'off' ? undefined : live}
      data-tone={tone}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={labelStyle}>{label}</div>
        {message && <div style={messageStyle}>{message}</div>}
      </div>
      {action && (
        <button type="button" style={actionStyle} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
