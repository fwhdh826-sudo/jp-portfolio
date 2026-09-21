/**
 * EightAxisRadar — 個別株詳細の 8 軸 SVG レーダー（旧 T1_Decision から移設。描画ロジックは不変）。
 * axes: [{label, value(0-100)}] × 8。基準値ライン = 50（calculation-only / not an order）。
 * 配色は R4.1 の --u9-* トークン（装飾のみ。値は軸ラベルと隣接する数値で示す）。
 */
const RADAR_N = 8
const RADAR_CX = 130
const RADAR_CY = 134 // やや下にずらしてトップラベルの余白を確保
const RADAR_R = 80 // 外周半径

// 軸 i のラジアン角（上 = -90° スタート、時計回り）
function radarAngle(i: number) {
  return ((i * 360 / RADAR_N) - 90) * (Math.PI / 180)
}

// 中心から距離 r、軸 i の座標
function radarPt(r: number, i: number) {
  const a = radarAngle(i)
  return { x: RADAR_CX + r * Math.cos(a), y: RADAR_CY + r * Math.sin(a) }
}

// 点列 → SVG polygon points 文字列
function pts2str(pts: Array<{ x: number; y: number }>) {
  return pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

type TextAnchor = 'start' | 'middle' | 'end'

// 軸 i のラベルテキスト配置プロパティ
const AXIS_TEXT_PROPS: Array<{ anchor: TextAnchor; dy: string }> = [
  { anchor: 'middle', dy: '-4' }, // 0: top
  { anchor: 'start', dy: '-2' }, // 1: top-right
  { anchor: 'start', dy: '4' }, // 2: right
  { anchor: 'start', dy: '10' }, // 3: bottom-right
  { anchor: 'middle', dy: '12' }, // 4: bottom
  { anchor: 'end', dy: '10' }, // 5: bottom-left
  { anchor: 'end', dy: '4' }, // 6: left
  { anchor: 'end', dy: '-2' }, // 7: top-left
]

const GRID = 'rgba(23, 34, 46, .16)'
const AXIS_LINE = 'rgba(23, 34, 46, .10)'
const MUTED = '#5E6C7C'
const INK = '#17222E'
const ACCENT = '#2F6FBF'

export function EightAxisRadar({ axes, accentColor = ACCENT }: {
  axes: ReadonlyArray<{ label: string; value: number }>
  accentColor?: string
}) {
  if (axes.length < 8) return null

  const levelRadii = [0.25, 0.5, 0.75, 1.0].map(f => RADAR_R * f)
  const scorePoints = axes.map((ax, i) => radarPt(RADAR_R * (Math.min(100, Math.max(0, ax.value)) / 100), i))
  const baselinePoints = axes.map((_, i) => radarPt(RADAR_R * 0.5, i))
  const outerPoints = axes.map((_, i) => radarPt(RADAR_R, i))
  const labelR = RADAR_R + 20

  return (
    <div className="u9-radar">
      <svg viewBox="0 0 260 268" className="u9-radar__svg" aria-hidden="true">
        {levelRadii.map((r, li) => (
          <polygon key={li} points={pts2str(axes.map((_, i) => radarPt(r, i)))} fill="none" stroke={GRID} strokeWidth={li === 3 ? 1 : 0.7} />
        ))}
        {outerPoints.map((op, i) => (
          <line key={i} x1={RADAR_CX} y1={RADAR_CY} x2={op.x.toFixed(1)} y2={op.y.toFixed(1)} stroke={AXIS_LINE} strokeWidth={0.7} />
        ))}
        <polygon points={pts2str(baselinePoints)} fill="none" stroke={MUTED} strokeWidth={1.2} strokeDasharray="4 3" opacity={0.6} />
        <polygon points={pts2str(scorePoints)} fill={accentColor} fillOpacity={0.15} stroke={accentColor} strokeWidth={1.8} />
        {scorePoints.map((p, i) => (
          <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={3} fill={accentColor} />
        ))}
        {[25, 50, 75].map(v => {
          const p = radarPt(RADAR_R * (v / 100), 0)
          return (
            <text key={v} x={(p.x + 4).toFixed(1)} y={p.y.toFixed(1)} fontSize="8" fill={MUTED} textAnchor="start" dominantBaseline="middle">
              {v}
            </text>
          )
        })}
        {axes.map((ax, i) => {
          const p = radarPt(labelR, i)
          const { anchor, dy } = AXIS_TEXT_PROPS[i] ?? { anchor: 'middle', dy: '0' }
          return (
            <text key={i} x={p.x.toFixed(1)} y={p.y.toFixed(1)} fontSize="10" fontWeight="600" fill={INK} textAnchor={anchor} dy={dy}>
              {ax.label}
            </text>
          )
        })}
      </svg>
      <div className="u9-radar__legend">
        <span className="u9-radar__key">
          <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke={accentColor} strokeWidth="2" /><circle cx="9" cy="4" r="2.5" fill={accentColor} /></svg>
          観察値
        </span>
        <span className="u9-radar__key">
          <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke={MUTED} strokeWidth="1.5" strokeDasharray="4 3" /></svg>
          基準値（50）
        </span>
      </div>
    </div>
  )
}
