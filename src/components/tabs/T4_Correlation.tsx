import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectTotalEval } from '../../store/selectors'

interface CorrelationPair {
  left: string
  right: string
  value: number
}

function getRiskTone(value: number, warnThreshold: number, cautionThreshold: number) {
  if (value >= warnThreshold) return 'negative'
  if (value >= cautionThreshold) return 'caution'
  return 'positive'
}

export function T4_Correlation() {
  const correlation = useAppStore(s => s.correlation)
  const holdings = useAppStore(s => s.holdings)
  const metrics = useAppStore(s => s.metrics)
  const analysis = useAppStore(s => s.analysis)
  const totalEval = useAppStore(selectTotalEval)

  const mitsuRatio = holdings.filter(item => item.mitsu).reduce((sum, item) => sum + item.eval, 0) / Math.max(totalEval, 1) * 100

  const flags = useMemo(() => {
    const items: { code: string; title: string; detail: string; priority: 'high' | 'medium' }[] = []

    holdings.forEach(holding => {
      if (holding.pnlPct < -20) {
        items.push({ code: holding.code, title: '大幅含み損', detail: `${holding.pnlPct.toFixed(1)}%`, priority: 'high' })
      }
      if (holding.sigma > 0.45) {
        items.push({ code: holding.code, title: '高ボラティリティ', detail: `${(holding.sigma * 100).toFixed(1)}%`, priority: 'medium' })
      }
      if (holding.de > 5) {
        items.push({ code: holding.code, title: '高D/E', detail: `D/E ${holding.de.toFixed(1)}`, priority: 'medium' })
      }
      if (holding.epsG < -15) {
        items.push({ code: holding.code, title: 'EPS急減速', detail: `${holding.epsG.toFixed(1)}%`, priority: 'high' })
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
          })
        }
      })

    return items
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
      high: [...pairs].sort((a, b) => b.value - a.value).slice(0, 8),
      diversifying: [...pairs].sort((a, b) => a.value - b.value).slice(0, 8),
    }
  }, [correlation, holdings])

  const scenarios = [
    {
      name: 'リスクオフ',
      move: `${metrics ? `${((metrics.sigma ?? 0.25) * -15).toFixed(1)}%` : '—'}`,
      detail: '日経急落、円高、成長株のバリュエーション圧縮を想定。',
    },
    {
      name: '政策ショック',
      move: `${metrics ? `${((metrics.sigma ?? 0.25) * -8).toFixed(1)}%` : '—'}`,
      detail: '金利上昇で高PER銘柄が先に崩れるケースを想定。',
    },
    {
      name: '強気継続',
      move: `${metrics ? `+${((metrics.sigma ?? 0.25) * 12).toFixed(1)}%` : '—'}`,
      detail: '広く買い戻される局面。高β銘柄の寄与が大きい想定。',
    },
  ]

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

  const codes = holdings.map(item => item.code)

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className="card">
          <div className="section-kicker">Risk dashboard</div>
          <h2 className="section-heading">主要リスク指標</h2>
          <div className="summary-grid" style={{ marginTop: 18 }}>
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
            <span>対象銘柄 {holdings.length}</span>
          </div>
        </article>

        <article className="card">
          <div className="section-kicker">Stress scenarios</div>
          <h2 className="section-heading">想定シナリオ</h2>
          <div className="scenario-list" style={{ marginTop: 18 }}>
            {scenarios.map(item => (
              <div key={item.name} className="scenario-list__item">
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.detail}</span>
                </div>
                <span>{item.move}</span>
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
                <h3 className="section-heading">優先対応が必要なリスク</h3>
              </div>
              <div className="section-caption">{flags.length}件</div>
            </div>

            {flags.length > 0 ? (
              <div className="score-list" style={{ marginTop: 16 }}>
                {flags.map(flag => (
                  <div key={`${flag.code}-${flag.title}`} className="score-list__item">
                    <div>
                      <strong>{flag.code} {flag.title}</strong>
                      <span>{flag.detail}</span>
                    </div>
                    <span>{flag.priority === 'high' ? '高' : '中'}</span>
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
                <div className="section-kicker">Correlation summary</div>
                <h3 className="section-heading">相関の高い組み合わせ</h3>
              </div>
            </div>

            {correlationPairs.high.length > 0 ? (
              <div className="score-list" style={{ marginTop: 16 }}>
                {correlationPairs.high.map(pair => (
                  <div key={`${pair.left}-${pair.right}`} className="score-list__item">
                    <div>
                      <strong>{pair.left} × {pair.right}</strong>
                      <span>同方向に動く可能性が高い組み合わせです。</span>
                    </div>
                    <span>{pair.value.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ marginTop: 16 }}>
                相関データがまだ読み込まれていません。
              </div>
            )}
          </article>
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Diversification</div>
                <h3 className="section-heading">分散に効く組み合わせ</h3>
              </div>
            </div>

            {correlationPairs.diversifying.length > 0 ? (
              <div className="score-list" style={{ marginTop: 16 }}>
                {correlationPairs.diversifying.map(pair => (
                  <div key={`${pair.left}-${pair.right}`} className="score-list__item">
                    <div>
                      <strong>{pair.left} × {pair.right}</strong>
                      <span>値動きが逆方向または独立に近く、分散に寄与します。</span>
                    </div>
                    <span>{pair.value.toFixed(2)}</span>
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

        {correlation ? (
          <div className="heatmap-table" style={{ marginTop: 18 }}>
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
          <div className="empty-state" style={{ marginTop: 18 }}>
            相関データ未ロードです。平日朝の自動更新後に表示されます。
          </div>
        )}
      </article>
    </div>
  )
}
