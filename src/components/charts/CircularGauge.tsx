/**
 * CircularGauge — SVG donut gauge（P4-A121）
 * strokeDasharray方式でvalue/maxの割合をarcで描画。
 * T1信頼度・T2スタンス・T6総合信頼度など複数箇所で共用。
 * CSS依存なし（inline styleのみ）。ロジック変更なし・純ビジュアル。
 */
import type { CSSProperties } from 'react'
import { colors } from '../../theme/tokens'

export type GaugeTone = 'buy' | 'hold' | 'wait' | 'sell' | 'stock' | 'neutral'

export interface CircularGaugeProps {
  value: number
  max?: number
  size?: number
  strokeWidth?: number
  label?: string
  sublabel?: string
  tone?: GaugeTone
  showValue?: boolean
  unit?: string
  valueDecimals?: number
}

const TONE_COLOR: Record<GaugeTone, string> = {
  buy:     colors.buy,
  hold:    colors.hold,
  wait:    colors.wait,
  sell:    colors.sell,
  stock:   colors.stockAccent,
  neutral: colors.jpFundAccent,
}

export function CircularGauge({
  value,
  max = 100,
  size = 80,
  strokeWidth = 9,
  label,
  sublabel,
  tone = 'neutral',
  showValue = true,
  unit = '',
  valueDecimals = 0,
}: CircularGaugeProps) {
  const safeMax    = max > 0 ? max : 100
  const clamped    = Math.min(safeMax, Math.max(0, value))
  const pct        = clamped / safeMax

  const cx         = size / 2
  const cy         = size / 2
  const r          = (size - strokeWidth) / 2
  const C          = 2 * Math.PI * r          // 全周長
  const filled     = C * pct
  const trackColor = colors.bgElevated
  const arcColor   = TONE_COLOR[tone]

  const displayVal = valueDecimals === 0
    ? Math.round(clamped).toString()
    : clamped.toFixed(valueDecimals)

  const containerStyle: CSSProperties = {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    gap:            '4px',
    width:          `${size}px`,
    flexShrink:     0,
  }

  const labelStyle: CSSProperties = {
    fontSize:   '11px',
    fontWeight: 600,
    color:      colors.textSubtle,
    textAlign:  'center',
    lineHeight: 1.2,
    maxWidth:   `${size + 12}px`,
  }

  return (
    <div style={containerStyle} role="img" aria-label={`${label ?? ''}${displayVal}${unit} / ${max}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* track */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        {/* arc（-90deg回転でトップスタート） */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={arcColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${filled.toFixed(2)} ${C.toFixed(2)}`}
          strokeDashoffset="0"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        {/* 中央テキスト */}
        {showValue && (
          <>
            <text
              x={cx}
              y={cy + (label || sublabel ? -1 : 4)}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={size <= 64 ? 14 : size <= 90 ? 18 : 22}
              fontWeight="800"
              fill={arcColor}
            >
              {displayVal}{unit}
            </text>
            {sublabel && (
              <text
                x={cx}
                y={cy + (size <= 64 ? 12 : 15)}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={size <= 64 ? 8 : 9}
                fill={colors.textMuted}
              >
                {sublabel}
              </text>
            )}
          </>
        )}
      </svg>
      {label && <div style={labelStyle}>{label}</div>}
    </div>
  )
}
