import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatDateTime, formatJPYAuto } from '../../utils/format'
import type { Holding, HoldingAnalysis } from '../../types'

interface AxisDetail {
  key: string
  label: string
  value: number
  tone: 'positive' | 'negative' | 'caution'
  reason: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function toneByScore(score: number): AxisDetail['tone'] {
  if (score >= 65) return 'positive'
  if (score <= 44) return 'negative'
  return 'caution'
}

function toDisplay(value: number) {
  return Math.round(clamp(value, 0, 100))
}

function scoreValuation(holding: Holding, analysis: HoldingAnalysis) {
  const perScore = holding.per > 0 ? 100 - clamp((holding.per - 8) * 2.2, 0, 70) : 40
  const pbrScore = 100 - clamp((holding.pbr - 0.8) * 22, 0, 45)
  const debateScore = analysis.debate.sevenAxis.valuation
  return toDisplay((perScore * 0.35) + (pbrScore * 0.2) + (debateScore * 0.45))
}

function scoreEarningPower(holding: Holding) {
  const roe = clamp(holding.roe * 4.3, 0, 100)
  const cf = holding.cfOk ? 74 : 46
  return toDisplay((roe * 0.7) + (cf * 0.3))
}

function scoreGrowth(holding: Holding, analysis: HoldingAnalysis) {
  const eps = clamp(holding.epsG * 3.2 + 45, 20, 100)
  return toDisplay((eps * 0.45) + (analysis.debate.sevenAxis.growth * 0.55))
}

function scoreSafety(holding: Holding, analysis: HoldingAnalysis) {
  const leveragePenalty = clamp((holding.de - 0.3) * 11, 0, 55)
  const volatilityPenalty = clamp((holding.sigma - 0.12) * 120, 0, 45)
  const base = 100 - leveragePenalty - volatilityPenalty
  return toDisplay((base * 0.55) + (analysis.debate.sevenAxis.risk * 0.45))
}

function scoreTrend(holding: Holding, analysis: HoldingAnalysis) {
  const momentum = clamp(holding.mom3m * 4 + 50, 20, 100)
  const rsi = holding.rsi >= 42 && holding.rsi <= 68 ? 70 : holding.rsi > 70 ? 42 : 50
  return toDisplay((analysis.debate.sevenAxis.momentum * 0.55) + (momentum * 0.35) + (rsi * 0.1))
}

function scoreSupplyDemand(holding: Holding, marketVix: number) {
  const volume = holding.vol ? 72 : 50
  const regimePenalty = marketVix >= 25 ? 18 : marketVix >= 20 ? 10 : 0
  return toDisplay(volume + clamp(holding.mom3m * 1.8, -18, 20) - regimePenalty)
}

function scoreShareholderReturn(holding: Holding) {
  const div = clamp(holding.divG * 11 + 30, 20, 100)
  const cash = holding.cfOk ? 68 : 45
  return toDisplay((div * 0.7) + (cash * 0.3))
}

function scoreBusinessMoat(holding: Holding, analysis: HoldingAnalysis) {
  const quality = analysis.qualityScore * 10
  const profitability = clamp(holding.roe * 3.6, 25, 100)
  return toDisplay((quality * 0.55) + (profitability * 0.45))
}

function buildAxisDetails(
  holding: Holding,
  analysis: HoldingAnalysis,
  marketVix: number,
): AxisDetail[] {
  const valuation = scoreValuation(holding, analysis)
  const earningPower = scoreEarningPower(holding)
  const growth = scoreGrowth(holding, analysis)
  const safety = scoreSafety(holding, analysis)
  const trend = scoreTrend(holding, analysis)
  const supplyDemand = scoreSupplyDemand(holding, marketVix)
  const shareholder = scoreShareholderReturn(holding)
  const moat = scoreBusinessMoat(holding, analysis)

  return [
    {
      key: 'valuation',
      label: '割安度',
      value: valuation,
      tone: toneByScore(valuation),
      reason: `PER ${holding.per.toFixed(1)}x / PBR ${holding.pbr.toFixed(1)}x を反映。`,
    },
    {
      key: 'earningPower',
      label: '稼ぐ力',
      value: earningPower,
      tone: toneByScore(earningPower),
      reason: `ROE ${holding.roe.toFixed(1)}% とCF健全性を統合評価。`,
    },
    {
      key: 'growth',
      label: '成長性',
      value: growth,
      tone: toneByScore(growth),
      reason: `EPS成長率 ${holding.epsG.toFixed(1)}% とAI成長軸を反映。`,
    },
    {
      key: 'safety',
      label: '安全性',
      value: safety,
      tone: toneByScore(safety),
      reason: `D/E ${holding.de.toFixed(1)} とボラティリティ ${(holding.sigma * 100).toFixed(1)}% を反映。`,
    },
    {
      key: 'trend',
      label: 'トレンド',
      value: trend,
      tone: toneByScore(trend),
      reason: `3ヶ月モメンタム ${holding.mom3m.toFixed(1)}% / RSI ${holding.rsi.toFixed(0)} を反映。`,
    },
    {
      key: 'supplyDemand',
      label: '需給',
      value: supplyDemand,
      tone: toneByScore(supplyDemand),
      reason: `出来高シグナル ${holding.vol ? 'あり' : 'なし'} と地合い(VIX)を評価。`,
    },
    {
      key: 'shareholder',
      label: '還元力',
      value: shareholder,
      tone: toneByScore(shareholder),
      reason: `配当成長率 ${holding.divG.toFixed(1)}% とCF余力を評価。`,
    },
    {
      key: 'moat',
      label: '事業独占力',
      value: moat,
      tone: toneByScore(moat),
      reason: `品質スコア ${analysis.qualityScore}/10 と収益性を統合評価。`,
    },
  ]
}

function buildSummaryComment(holding: Holding, analysis: HoldingAnalysis, axes: AxisDetail[]) {
  const sorted = [...axes].sort((a, b) => b.value - a.value)
  const best = sorted[0]
  const weak = sorted[sorted.length - 1]
  const stance =
    analysis.decision === 'BUY'
      ? '分割での買い増し候補'
      : analysis.decision === 'SELL'
      ? '縮小優先候補'
      : '維持監視候補'

  return `${holding.name}は総合スコア${analysis.totalScore}点で、現時点の判断は「${stance}」です。` +
    `強みは${best.label}${best.value}点、弱みは${weak.label}${weak.value}点です。` +
    `主な強気材料は「${analysis.debate.bullReasons[0] ?? '業績と需給の改善'}」、` +
    `注意点は「${analysis.debate.bearReasons[0] ?? '短期のボラティリティ'}」です。`
}

function buildRadarPoints(values: number[], center: number, radius: number) {
  const count = values.length
  return values.map((value, index) => {
    const ratio = clamp(value, 0, 100) / 100
    const angle = ((Math.PI * 2) / count) * index - Math.PI / 2
    const x = center + Math.cos(angle) * radius * ratio
    const y = center + Math.sin(angle) * radius * ratio
    return { x, y }
  })
}

function RadarChart({ axes }: { axes: AxisDetail[] }) {
  const center = 140
  const radius = 92
  const count = axes.length
  const values = axes.map(axis => axis.value)
  const mainPoints = buildRadarPoints(values, center, radius)
  const basePoints = buildRadarPoints(Array.from({ length: count }, () => 50), center, radius)
  const mainPath = mainPoints.map(point => `${point.x},${point.y}`).join(' ')
  const basePath = basePoints.map(point => `${point.x},${point.y}`).join(' ')

  return (
    <svg className="ai-radar" viewBox="0 0 280 280" role="img" aria-label="8軸スコアレーダー">
      {[20, 40, 60, 80, 100].map(level => {
        const ring = buildRadarPoints(Array.from({ length: count }, () => level), center, radius)
        return (
          <polygon
            key={level}
            points={ring.map(point => `${point.x},${point.y}`).join(' ')}
            className="ai-radar__ring"
          />
        )
      })}

      {axes.map((axis, index) => {
        const angle = ((Math.PI * 2) / count) * index - Math.PI / 2
        const x = center + Math.cos(angle) * radius
        const y = center + Math.sin(angle) * radius
        const labelX = center + Math.cos(angle) * (radius + 22)
        const labelY = center + Math.sin(angle) * (radius + 22)
        return (
          <g key={axis.key}>
            <line x1={center} y1={center} x2={x} y2={y} className="ai-radar__axis" />
            <text x={labelX} y={labelY} className="ai-radar__label" textAnchor="middle">
              {axis.label}
            </text>
          </g>
        )
      })}

      <polygon points={basePath} className="ai-radar__base" />
      <polygon points={mainPath} className="ai-radar__main" />
      {mainPoints.map((point, index) => (
        <circle key={axes[index].key} cx={point.x} cy={point.y} r={4} className="ai-radar__dot" />
      ))}
    </svg>
  )
}

export function T3_Regime() {
  const holdings = useAppStore(s => s.holdings)
  const analysis = useAppStore(s => s.analysis)
  const market = useAppStore(s => s.market)
  const system = useAppStore(s => s.system)

  const [selectedCode, setSelectedCode] = useState('')

  const analyzedHoldings = useMemo(
    () =>
      holdings
        .map(holding => {
          const item = analysis.find(entry => entry.code === holding.code)
          return item ? { holding, analysis: item } : null
        })
        .filter((item): item is { holding: Holding; analysis: HoldingAnalysis } => Boolean(item))
        .sort((a, b) => b.analysis.totalScore - a.analysis.totalScore),
    [analysis, holdings],
  )

  useEffect(() => {
    if (analyzedHoldings.length === 0) return
    if (!selectedCode || !analyzedHoldings.some(item => item.holding.code === selectedCode)) {
      setSelectedCode(analyzedHoldings[0].holding.code)
    }
  }, [analyzedHoldings, selectedCode])

  const current = analyzedHoldings.find(item => item.holding.code === selectedCode) ?? analyzedHoldings[0]

  if (!current) {
    return (
      <div className="tab-panel">
        <article className="card">
          <h2 className="section-heading">AI分析データがありません</h2>
          <p className="section-copy">CSV取込またはデータ更新後に、AI分析レポートを表示します。</p>
        </article>
      </div>
    )
  }

  const axes = buildAxisDetails(current.holding, current.analysis, market.vix)
  const comment = buildSummaryComment(current.holding, current.analysis, axes)
  const analyzedAt = system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : formatDateTime(new Date().toISOString())

  return (
    <div className="tab-panel ai-report-tab">
      <article className="card ai-report">
        <div className="ai-report__head">
          <div>
            <div className="position-card__code">| {current.holding.code} |</div>
            <h2 className="ai-report__name">{current.holding.name}</h2>
          </div>
          <div className="ai-report__meta">
            <div>
              <span>分析日</span>
              <strong>{analyzedAt}</strong>
            </div>
            <div>
              <span>保有評価額</span>
              <strong>{formatJPYAuto(current.holding.eval)}</strong>
            </div>
            <div>
              <span>AI総合</span>
              <strong>{current.analysis.totalScore}</strong>
            </div>
          </div>
        </div>

        <div className="ai-report__selector">
          <label htmlFor="ai-stock-select">銘柄選択</label>
          <select
            id="ai-stock-select"
            value={current.holding.code}
            onChange={event => setSelectedCode(event.target.value)}
          >
            {analyzedHoldings.map(item => (
              <option key={item.holding.code} value={item.holding.code}>
                {item.holding.code} {item.holding.name}
              </option>
            ))}
          </select>
        </div>

        <div className="ai-report__top">
          <section className="ai-report__panel">
            <h3>8軸スコア レーダーチャート</h3>
            <RadarChart axes={axes} />
            <div className="ai-report__legend">
              <span><i className="dot dot-main" /> {current.holding.name}</span>
              <span><i className="dot dot-base" /> 基準値(50)</span>
            </div>
          </section>

          <section className="ai-report__panel">
            <h3>総合評価コメント</h3>
            <p>{comment}</p>
            <div className="ai-report__chips">
              <span className={`vd ${current.analysis.decision === 'BUY' ? 'buy' : current.analysis.decision === 'SELL' ? 'sell' : 'hold'}`}>
                {current.analysis.decision}
              </span>
              <span className="tone-chip tone-chip--neutral">確信度 {(current.analysis.confidence * 100).toFixed(0)}%</span>
              <span className="tone-chip tone-chip--neutral">戦略ランク {current.analysis.strategyRank}</span>
            </div>
          </section>
        </div>

        <section className="ai-report__section">
          <h3>8軸スコア一覧</h3>
          <div className="ai-score-grid">
            {axes.map(axis => (
              <article key={axis.key} className={`ai-score-card ai-score-card--${axis.tone}`}>
                <div className="ai-score-card__label">{axis.label}</div>
                <div className="ai-score-card__value">{axis.value}</div>
                <div className="ai-score-card__bar"><span style={{ width: `${axis.value}%` }} /></div>
              </article>
            ))}
          </div>
        </section>

        <section className="ai-report__section">
          <h3>各軸の詳細スコアと根拠</h3>
          <div className="ai-detail-grid">
            {axes.map(axis => (
              <article key={axis.key} className={`ai-detail-card ai-detail-card--${axis.tone}`}>
                <div className="ai-detail-card__top">
                  <strong>{axis.label}</strong>
                  <span>{axis.value}</span>
                </div>
                <div className="ai-score-card__bar"><span style={{ width: `${axis.value}%` }} /></div>
                <p>{axis.reason}</p>
              </article>
            ))}
          </div>
        </section>
      </article>
    </div>
  )
}
