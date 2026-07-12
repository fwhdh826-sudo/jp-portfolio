/**
 * SparklineChart — SVG折れ線チャート（P4-A125）
 * 既存データの配列を受け取りpolylineで描画する表示専用コンポーネント。
 * ロジック変更なし・純ビジュアル。データが空/1点の場合も安全に表示する。
 */
import type { CSSProperties } from 'react'
import { colors } from '../../theme/tokens'

export type SparklineTone = 'buy' | 'hold' | 'wait' | 'sell' | 'neutral'

export interface SparklineChartProps {
  values: number[]
  width?: number
  height?: number
  tone?: SparklineTone
  label?: string
  showZeroLine?: boolean
  showLastValue?: boolean
  formatValue?: (value: number) => string
}

const TONE_COLOR: Record<SparklineTone, string> = {
  buy:     colors.buy,
  hold:    colors.hold ?? '#888',
  wait:    colors.watch ?? '#f59e0b',
  sell:    colors.sell,
  neutral: colors.jpFundAccent,
}

/** min/max正規化してSVG座標配列を返す。値が1点以下またはmin===maxの場合は中央水平線。 */
export function calcSparklinePoints(
  values: number[],
  width: number,
  height: number,
  padding = 4,
): string {
  if (values.length === 0) return ''

  const innerW = width - padding * 2
  const innerH = height - padding * 2

  if (values.length === 1) {
    const y = padding + innerH / 2
    return `${padding},${y} ${padding + innerW},${y}`
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min

  const points = values.map((v, i) => {
    const x = padding + (i / (values.length - 1)) * innerW
    const y =
      range === 0
        ? padding + innerH / 2
        : padding + (1 - (v - min) / range) * innerH
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  return points.join(' ')
}

/** ゼロラインのY座標を返す（min≦0≦maxのとき）。範囲外の場合はnull。 */
export function calcZeroLineY(
  values: number[],
  height: number,
  padding = 4,
): number | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  if (range === 0 || min > 0 || max < 0) return null
  const innerH = height - padding * 2
  return padding + (1 - (0 - min) / range) * innerH
}

export function SparklineChart({
  values,
  width = 200,
  height = 48,
  tone = 'neutral',
  label,
  showZeroLine = false,
  showLastValue = false,
  formatValue = v => v.toFixed(2),
}: SparklineChartProps) {
  const PADDING = 4
  const lineColor = TONE_COLOR[tone]
  const points = calcSparklinePoints(values, width, height, PADDING)
  const zeroY = showZeroLine ? calcZeroLineY(values, height, PADDING) : null
  const lastVal = values.length > 0 ? values[values.length - 1] : null

  const ariaLabel = label
    ? `${label}: ${values.length}件の折れ線チャート${lastVal !== null ? `、最新値 ${formatValue(lastVal)}` : ''}`
    : `${values.length}件の折れ線チャート${lastVal !== null ? `、最新値 ${formatValue(lastVal)}` : ''}`

  const wrapStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  }

  if (values.length === 0) {
    return (
      <div style={wrapStyle}>
        {label && (
          <span style={{ fontSize: '11px', color: colors.textMuted, fontWeight: 600 }}>
            {label}
          </span>
        )}
        <div style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: colors.bgElevated,
          borderRadius: '4px',
          fontSize: '11px',
          color: colors.textMuted,
        }}>
          履歴蓄積後に表示
        </div>
      </div>
    )
  }

  return (
    <div style={wrapStyle}>
      {label && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '11px', color: colors.textMuted, fontWeight: 600 }}>
            {label}
          </span>
          {showLastValue && lastVal !== null && (
            <span style={{ fontSize: '12px', color: lineColor, fontWeight: 700 }}>
              {formatValue(lastVal)}
            </span>
          )}
        </div>
      )}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* 背景 */}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill={colors.bgElevated}
          rx={4}
        />
        {/* ゼロライン */}
        {zeroY !== null && (
          <line
            x1={PADDING}
            y1={zeroY}
            x2={width - PADDING}
            y2={zeroY}
            stroke={colors.textMuted}
            strokeWidth={0.75}
            strokeDasharray="3 2"
          />
        )}
        {/* 折れ線 */}
        {points && (
          <polyline
            points={points}
            fill="none"
            stroke={lineColor}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {/* 最終点マーカー */}
        {values.length >= 2 && (() => {
          const innerH = height - PADDING * 2
          const min = Math.min(...values)
          const max = Math.max(...values)
          const range = max - min
          const lastX = width - PADDING
          const lastY = range === 0
            ? PADDING + innerH / 2
            : PADDING + (1 - (lastVal! - min) / range) * innerH
          return (
            <circle
              cx={lastX}
              cy={lastY}
              r={2.5}
              fill={lineColor}
            />
          )
        })()}
      </svg>
    </div>
  )
}
