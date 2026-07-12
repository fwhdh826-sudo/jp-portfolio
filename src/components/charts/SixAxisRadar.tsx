/**
 * SixAxisRadar — Phase 7 6軸スコアレーダーチャート (Card 7-10)
 * CANONICAL_AXES: value / quality / growth / safety / momentum / shareholder_return
 * calculation-only, not an order, not a recommendation
 * CSS依存なし（inline style のみ）
 */
import type { SixAxisScore, ScoreAxisId } from '../../types/scoring'
import { colors, v13Colors } from '../../theme/tokens'

const AXES: ScoreAxisId[] = [
  'value', 'quality', 'growth', 'safety', 'momentum', 'shareholder_return',
]

const AXIS_LABEL: Record<ScoreAxisId, string> = {
  value:             'バリュー',
  quality:           'クオリティ',
  growth:            'グロース',
  safety:            '安全性',
  momentum:          'モメンタム',
  shareholder_return:'還元力',
}

const AXIS_COLOR: Record<ScoreAxisId, string> = {
  value:             v13Colors.axisValue,
  quality:           v13Colors.axisQuality,
  growth:            v13Colors.axisGrowth,
  safety:            v13Colors.axisSafety,
  momentum:          v13Colors.axisMomentum,
  shareholder_return:v13Colors.axisShareholderReturn,
}

function polarXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * (Math.PI / 180)
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

interface Props {
  scores: SixAxisScore
  accentColor?: string
}

export function SixAxisRadar({ scores, accentColor = colors.stockAccent }: Props) {
  const cx = 120
  const cy = 120
  const maxR = 76
  const count = AXES.length

  const vals = AXES.map(ax => Math.min(100, Math.max(0, scores[ax]?.total ?? 0)))

  const scorePoints = vals.map((v, i) => {
    const angle = (360 / count) * i
    const r = (v / 100) * maxR
    return polarXY(cx, cy, r, angle)
  })

  const scorePath = scorePoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return (
    <svg
      viewBox="0 0 240 240"
      width="100%"
      style={{ maxWidth: '220px', display: 'block', margin: '0 auto' }}
      role="img"
      aria-label="6軸スコアレーダー（バックエンド計算観察値）"
    >
      {/* Grid rings */}
      {[25, 50, 75, 100].map(level => {
        const pts = AXES.map((_, i) => {
          const p = polarXY(cx, cy, (level / 100) * maxR, (360 / count) * i)
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
        }).join(' ')
        return (
          <polygon
            key={level}
            points={pts}
            fill="none"
            stroke={level === 50 ? '#c8d0da' : '#e8ecf2'}
            strokeWidth={level === 50 ? '1.5' : '1'}
            strokeDasharray={level < 100 && level !== 50 ? '3,3' : undefined}
          />
        )
      })}

      {/* Axis lines + labels */}
      {AXES.map((ax, i) => {
        const angle = (360 / count) * i
        const tip   = polarXY(cx, cy, maxR, angle)
        const lbl   = polarXY(cx, cy, maxR + 24, angle)
        return (
          <g key={ax}>
            <line
              x1={cx} y1={cy}
              x2={tip.x.toFixed(1)} y2={tip.y.toFixed(1)}
              stroke="#e8ecf2" strokeWidth="1"
            />
            <text
              x={lbl.x.toFixed(1)}
              y={lbl.y.toFixed(1)}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="9.5"
              fontWeight="700"
              fill={AXIS_COLOR[ax]}
            >
              {AXIS_LABEL[ax]}
            </text>
          </g>
        )
      })}

      {/* Score polygon */}
      <polygon
        points={scorePath}
        fill={accentColor}
        fillOpacity="0.18"
        stroke={accentColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Score dots (per-axis color) */}
      {scorePoints.map((p, i) => (
        <circle
          key={AXES[i]}
          cx={p.x.toFixed(1)}
          cy={p.y.toFixed(1)}
          r="4"
          fill={AXIS_COLOR[AXES[i]]}
          stroke="#ffffff"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  )
}

export { AXIS_COLOR, AXIS_LABEL, AXES as CANONICAL_AXES_ORDER }
