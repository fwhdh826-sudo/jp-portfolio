import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'
import { formatJPYAuto } from '../../utils/format'

interface CorrelationPair {
  left: string
  right: string
  value: number
}

type RiskTone = 'positive' | 'caution' | 'negative' | 'neutral'

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function getRiskTone(value: number, warnThreshold: number, cautionThreshold: number): RiskTone {
  if (value >= warnThreshold) return 'negative'
  if (value >= cautionThreshold) return 'caution'
  return 'positive'
}

function formatSigned(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function T4_Correlation() {
  const correlation = useAppStore(s => s.correlation)
  const holdings = useAppStore(s => s.holdings)
  const metrics = useAppStore(s => s.metrics)
  const analysis = useAppStore(s => s.analysis)
  const totalEval = useAppStore(selectTotalEval)

  const mitsuEval = holdings.filter(item => item.mitsu).reduce((sum, item) => sum + item.eval, 0)
  const mitsuRatio = totalEval > 0 ? (mitsuEval / totalEval) * 100 : 0

  const flags = useMemo(() => {
    const items: { code: string; title: string; detail: string; priority: 'high' | 'medium'; action: string }[] = []

    holdings.forEach(holding => {
      if (holding.pnlPct < -20) {
        items.push({
          code: holding.code,
          title: '大幅含み損',
          detail: `${holding.pnlPct.toFixed(1)}%`,
          priority: 'high',
          action: '反発待ち前提を解除し、撤退ラインを再設定',
        })
      }
      if (holding.sigma > 0.45) {
        items.push({
          code: holding.code,
          title: '高ボラティリティ',
          detail: `${(holding.sigma * 100).toFixed(1)}%`,
          priority: 'medium',
          action: '一回当たりの発注サイズを通常の70%へ抑制',
        })
      }
      if (holding.de > 5) {
        items.push({
          code: holding.code,
          title: '高D/E',
          detail: `D/E ${holding.de.toFixed(1)}`,
          priority: 'medium',
          action: '財務イベント前は新規買いを見送り',
        })
      }
      if (holding.epsG < -15) {
        items.push({
          code: holding.code,
          title: 'EPS急減速',
          detail: `${holding.epsG.toFixed(1)}%`,
          priority: 'high',
          action: '次回決算まで保有理由を再確認',
        })
      }
    })

    analysis
      .filter(item => item.decision === 'SELL')
      .forEach(item => {
        if (!items.some(flag => flag.code === item.code && flag.title === 'SELL判定')) {
          items.push({
            code: item.code,
            title: 'SELL判定',
            detail: `総合 ${item.totalScore}/100`,
            priority: 'high',
            action: '段階売却の執行順を本日中に確定',
          })
        }
      })

    return items.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority === 'high' ? -1 : 1
      return left.code.localeCompare(right.code)
    })
  }, [analysis, holdings])

  const correlationPairs = useMemo(() => {
    if (!correlation) return { high: [] as CorrelationPair[], diversifying: [] as CorrelationPair[] }

    const codes = holdings.map(item => item.code)
    const pairs: CorrelationPair[] = []

    for (let i = 0; i < codes.length; i += 1) {
      for (let j = i + 1; j < codes.length; j += 1) {
        const left = codes[i]
        const right = codes[j]
        const value = correlation.matrix[`${left}.T`]?.[`${right}.T`] ?? 0
        pairs.push({ left, right, value })
      }
    }

    return {
      high: [...pairs].sort((a, b) => b.value - a.value).slice(0, 10),
      diversifying: [...pairs].sort((a, b) => a.value - b.value).slice(0, 10),
    }
  }, [correlation, holdings])

  const riskOverview = [
    {
      label: '三菱集中',
      value: `${mitsuRatio.toFixed(1)}%`,
      tone: getRiskTone(mitsuRatio, 35, 25),
    },
    {
      label: 'PF σ',
      value: metrics ? `${(metrics.sigma * 100).toFixed(1)}%` : '—',
      tone: metrics ? getRiskTone(metrics.sigma * 100, 25, 18) : 'neutral',
    },
    {
      label: 'CVaR 95%',
      value: metrics ? `${Math.abs(metrics.cvar * 100).toFixed(1)}%` : '—',
      tone: metrics ? getRiskTone(Math.abs(metrics.cvar * 100), 20, 14) : 'neutral',
    },
    {
      label: '最大DD',
      value: metrics ? `${Math.abs(metrics.mdd * 100).toFixed(1)}%` : '—',
      tone: metrics ? getRiskTone(Math.abs(metrics.mdd * 100), 30, 20) : 'neutral',
    },
  ] as const

  const riskScore = useMemo(() => {
    const sigmaPct = (metrics?.sigma ?? 0.2) * 100
    const cvarPct = Math.abs((metrics?.cvar ?? -0.14) * 100)
    const mddPct = Math.abs((metrics?.mdd ?? -0.2) * 100)
    const highFlags = flags.filter(item => item.priority === 'high').length
    const mediumFlags = flags.length - highFlags
    const sellCount = analysis.filter(item => item.decision === 'SELL').length

    let score = 100
    score -= Math.max(0, mitsuRatio - 25) * 1.6
    score -= Math.max(0, sigmaPct - 18) * 1.4
    score -= Math.max(0, cvarPct - 14) * 1.5
    score -= Math.max(0, mddPct - 20) * 0.9
    score -= highFlags * 6 + mediumFlags * 2 + sellCount * 1.5
    return Math.round(clamp(score))
  }, [analysis, flags, metrics, mitsuRatio])

  const riskHealthTone: RiskTone = riskScore >= 72 ? 'positive' : riskScore >= 55 ? 'caution' : 'negative'
  const riskHealthLabel = riskScore >= 72 ? '安定圏' : riskScore >= 55 ? '警戒圏' : '防御圏'

  const guardrails = [
    { label: '三菱比率 <= 35%', value: mitsuRatio, threshold: 35, caution: 30, suffix: '%' },
    { label: 'PF σ <= 22%', value: (metrics?.sigma ?? 0) * 100, threshold: 22, caution: 18, suffix: '%' },
    { label: '|CVaR95| <= 16%', value: Math.abs((metrics?.cvar ?? 0) * 100), threshold: 16, caution: 13, suffix: '%' },
    { label: '最大DD <= 25%', value: Math.abs((metrics?.mdd ?? 0) * 100), threshold: 25, caution: 20, suffix: '%' },
    { label: 'SELL判定 <= 2件', value: analysis.filter(item => item.decision === 'SELL').length, threshold: 2, caution: 1, suffix: '件' },
  ]

  const concentrationRows = holdings
    .map(holding => {
      const weight = totalEval > 0 ? (holding.eval / totalEval) * 100 : 0
      const riskLoad = weight * Math.max(holding.sigma, 0.05)
      return { holding, weight, riskLoad }
    })
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 10)

  const sigma = metrics?.sigma ?? 0.22
  const scenarios = [
    {
      name: '急落連鎖',
      move: -sigma * 18,
      detail: '日経先物主導の全面安。高β・高PERから先に下落。',
      action: '逆指値を前日安値下へ再配置し、執行を分割。',
    },
    {
      name: '政策ショック',
      move: -sigma * 9,
      detail: '金利上昇でグロース株のバリュエーション圧縮。',
      action: '金利感応度の高い銘柄を優先でサイズ調整。',
    },
    {
      name: '反発再開',
      move: sigma * 12,
      detail: '需給改善でリスクオン。循環物色が進行。',
      action: '待機資金を3分割で段階投入。',
    },
  ]

  const codes = holdings.map(item => item.code)

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className={`card risk-lab risk-lab--${riskHealthTone}`}>
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">Risk cockpit</div>
              <h2 className="section-heading">総合リスク健全性</h2>
            </div>
            <div className={`risk-score-pill risk-score-pill--${riskHealthTone}`}>
              <div className="risk-score-pill__label">Risk Score</div>
              <div className="risk-score-pill__value">{riskScore}</div>
              <div className="risk-score-pill__state">{riskHealthLabel}</div>
            </div>
          </div>

          <div className="summary-grid" style={{ marginTop: 16 }}>
            {riskOverview.map(item => (
              <div key={item.label} className={`summary-tile summary-tile--${item.tone}`}>
                <div className="summary-tile__label">{item.label}</div>
                <div className="summary-tile__value">{item.value}</div>
              </div>
            ))}
          </div>

          <div className="metrics-inline">
            <span>Sharpe {metrics ? metrics.sharpe.toFixed(2) : '—'}</span>
            <span>Sortino {metrics ? metrics.sortino.toFixed(2) : '—'}</span>
            <span>Calmar {metrics ? metrics.calmar.toFixed(2) : '—'}</span>
            <span>保有評価額 {formatJPYAuto(totalEval)}</span>
          </div>

          <div className="risk-guardrails">
            {guardrails.map(item => {
              const tone = item.value > item.threshold ? 'negative' : item.value > item.caution ? 'caution' : 'positive'
              return (
                <div key={item.label} className={`risk-guardrails__item risk-guardrails__item--${tone}`}>
                  <div className="risk-guardrails__label">{item.label}</div>
                  <div className="risk-guardrails__value">
                    {item.value.toFixed(item.suffix === '件' ? 0 : 1)}
                    {item.suffix}
                  </div>
                </div>
              )
            })}
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Stress scenarios</div>
          <h2 className="section-heading">想定ショックと即応策</h2>
          <div className="scenario-list" style={{ marginTop: 16 }}>
            {scenarios.map(item => (
              <div key={item.name} className="scenario-list__item">
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.detail}</span>
                  <span>{item.action}</span>
                </div>
                <span>{formatSigned(item.move)}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Flag queue</div>
                <h3 className="section-heading">優先対応リスク</h3>
              </div>
              <div className="section-caption">{flags.length}件</div>
            </div>

            {flags.length > 0 ? (
              <div className="risk-register" style={{ marginTop: 16 }}>
                {flags.map(flag => (
                  <div key={`${flag.code}-${flag.title}`} className={`risk-register__item risk-register__item--${flag.priority}`}>
                    <div className="risk-register__title">
                      <strong>{flag.code} {flag.title}</strong>
                      <span className={`vd ${flag.priority === 'high' ? 'sell' : 'wait'}`}>
                        {flag.priority === 'high' ? 'HIGH' : 'MID'}
                      </span>
                    </div>
                    <div className="risk-register__meta">{flag.detail}</div>
                    <div className="risk-register__action">{flag.action}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ marginTop: 16 }}>
                目立ったレッドフラッグはありません。
              </div>
            )}
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Concentration map</div>
                <h3 className="section-heading">銘柄別リスク寄与</h3>
              </div>
            </div>

            <div className="risk-concentration" style={{ marginTop: 16 }}>
              {concentrationRows.map(item => (
                <div key={item.holding.code} className="risk-concentration__row">
                  <div className="risk-concentration__header">
                    <strong>{item.holding.code} {item.holding.name}</strong>
                    <span>{item.weight.toFixed(1)}%</span>
                  </div>
                  <div className="risk-concentration__meta">
                    <span>評価額 {formatJPYAuto(item.holding.eval)}</span>
                    <span>σ {(item.holding.sigma * 100).toFixed(1)}%</span>
                    <span>寄与 {item.riskLoad.toFixed(2)}</span>
                  </div>
                  <div className="risk-concentration__bar">
                    <span style={{ width: `${Math.min(100, item.weight * 1.9)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Correlation hot pairs</div>
                <h3 className="section-heading">同方向に崩れやすい組み合わせ</h3>
              </div>
            </div>

            {correlationPairs.high.length > 0 ? (
              <div className="risk-pair-list" style={{ marginTop: 16 }}>
                {correlationPairs.high.map(pair => (
                  <div key={`${pair.left}-${pair.right}`} className="risk-pair-list__item">
                    <div>
                      <strong>{pair.left} × {pair.right}</strong>
                      <span>ショック局面では同時に下げる前提で管理。</span>
                    </div>
                    <div className={`risk-pair-list__score ${pair.value >= 0.7 ? 'is-danger' : pair.value >= 0.4 ? 'is-caution' : 'is-neutral'}`}>
                      {pair.value.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ marginTop: 16 }}>
                相関データがまだ読み込まれていません。
              </div>
            )}
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Diversification</div>
                <h3 className="section-heading">分散に効く組み合わせ</h3>
              </div>
            </div>

            {correlationPairs.diversifying.length > 0 ? (
              <div className="risk-pair-list" style={{ marginTop: 16 }}>
                {correlationPairs.diversifying.map(pair => (
                  <div key={`${pair.left}-${pair.right}`} className="risk-pair-list__item">
                    <div>
                      <strong>{pair.left} × {pair.right}</strong>
                      <span>逆相関・低相関。建て増し時の候補に有効。</span>
                    </div>
                    <div className={`risk-pair-list__score ${pair.value < 0 ? 'is-positive' : pair.value < 0.35 ? 'is-neutral' : 'is-caution'}`}>
                      {pair.value.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ marginTop: 16 }}>
                分散ペアの評価には相関データが必要です。
              </div>
            )}
          </article>
        </div>
      </section>

      <article className="card" style={{ marginTop: 18 }}>
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Full matrix</div>
            <h3 className="section-heading">相関行列</h3>
          </div>
          <div className="section-caption">
            {correlation ? `${correlation.last_updated} / ${correlation.period}` : '未ロード'}
          </div>
        </div>

        <div className="risk-matrix-meta">
          <span>0.70以上: 連鎖リスク高</span>
          <span>0.40以上: 同方向バイアス</span>
          <span>0.00未満: 分散寄与</span>
        </div>

        {correlation ? (
          <div className="heatmap-table" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  {codes.map(code => <th key={code}>{code}</th>)}
                </tr>
              </thead>
              <tbody>
                {codes.map(left => (
                  <tr key={left}>
                    <th>{left}</th>
                    {codes.map(right => {
                      const value = left === right ? 1 : correlation.matrix[`${left}.T`]?.[`${right}.T`] ?? 0
                      const tone = value >= 0.7 ? 'negative' : value >= 0.4 ? 'caution' : value < 0 ? 'positive' : 'neutral'
                      return (
                        <td key={right} className={`heatmap-table__cell heatmap-table__cell--${tone}`}>
                          {value.toFixed(2)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state" style={{ marginTop: 16 }}>
            相関データ未ロードです。平日朝の自動更新後に表示されます。
          </div>
        )}
      </article>
    </div>
  )
}
