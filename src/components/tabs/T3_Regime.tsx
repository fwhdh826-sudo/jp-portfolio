import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { formatDateTime } from '../../utils/format'

function getTone(value: number, positiveThreshold: number, cautionThreshold: number) {
  if (value >= positiveThreshold) return 'positive'
  if (value >= cautionThreshold) return 'caution'
  return 'negative'
}

export function T3_Regime() {
  const market = useAppStore(s => s.market)
  const macro = useAppStore(s => s.macro)
  const metrics = useAppStore(s => s.metrics)
  const analysis = useAppStore(s => s.analysis)
  const holdings = useAppStore(s => s.holdings)
  const news = useAppStore(s => s.news)
  const learning = useAppStore(s => s.learning)
  const margin = useAppStore(s => s.margin)
  const flows = useAppStore(s => s.flows)

  const overviewItems = [
    {
      label: '市場レジーム',
      value: market.regime === 'bull' ? '強気' : market.regime === 'bear' ? '弱気' : '中立',
      tone: market.regime === 'bull' ? 'positive' : market.regime === 'bear' ? 'negative' : 'caution',
    },
    {
      label: 'RSI (14)',
      value: market.rsi14.toFixed(0),
      tone: market.rsi14 > 70 ? 'negative' : market.rsi14 < 35 ? 'positive' : 'caution',
    },
    {
      label: 'MACD',
      value: market.macd === 'golden' ? 'GC' : 'DC',
      tone: market.macd === 'golden' ? 'positive' : 'negative',
    },
    {
      label: 'Sharpe',
      value: metrics ? metrics.sharpe.toFixed(2) : '—',
      tone: metrics ? getTone(metrics.sharpe, 1, 0.5) : 'neutral',
    },
  ] as const

  const scoredHoldings = useMemo(
    () =>
      holdings
        .map(holding => {
          const item = analysis.find(entry => entry.code === holding.code)
          return item ? { holding, analysis: item } : null
        })
        .filter((item): item is { holding: typeof holdings[number]; analysis: typeof analysis[number] } => !!item),
    [analysis, holdings],
  )

  const technicalLeaders = [...scoredHoldings]
    .sort((left, right) => right.analysis.technicalScore - left.analysis.technicalScore)
    .slice(0, 6)

  const fundamentalLeaders = [...scoredHoldings]
    .sort((left, right) => right.analysis.fundamentalScore - left.analysis.fundamentalScore)
    .slice(0, 6)

  const bestDebate = analysis.length > 0
    ? analysis.reduce((best, current) =>
        current.debate.debateScore > best.debate.debateScore ? current : best,
      analysis[0])
    : null

  const bestHolding = bestDebate
    ? holdings.find(holding => holding.code === bestDebate.code)
    : null

  const relatedNews = bestHolding && news
    ? news.stockNews.filter(item => item.tickers.includes(bestHolding.code)).slice(0, 4)
    : []

  const learningReady = (learning?.summary.total ?? 0) >= 20

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className="card">
          <div className="section-kicker">Regime view</div>
          <h2 className="section-heading">市場判断の前提</h2>
          <div className="summary-grid" style={{ marginTop: 18 }}>
            {overviewItems.map(item => (
              <div key={item.label} className={`summary-tile summary-tile--${item.tone}`}>
                <div className="summary-tile__label">{item.label}</div>
                <div className="summary-tile__value">{item.value}</div>
              </div>
            ))}
          </div>

          <div className="metrics-inline">
            <span>日経 {market.nikkei.toLocaleString('ja-JP')}</span>
            <span>VIX {market.vix.toFixed(1)}</span>
            <span>MA5 {market.ma5.toLocaleString('ja-JP')}</span>
            <span>MA25 {market.ma25.toLocaleString('ja-JP')}</span>
            <span>MA75 {market.ma75.toLocaleString('ja-JP')}</span>
          </div>

          {macro && (
            <div className="detail-grid" style={{ marginTop: 18 }}>
              <div className="detail-panel">
                <div className="section-subtitle">マクロ指標</div>
                <div className="detail-list">
                  <span>S&P500 {macro.sp500.toLocaleString('en-US')} / {macro.sp500ChgPct >= 0 ? '+' : ''}{macro.sp500ChgPct.toFixed(2)}%</span>
                  <span>NASDAQ {macro.nasdaq.toLocaleString('en-US')} / {macro.nasdaqChgPct >= 0 ? '+' : ''}{macro.nasdaqChgPct.toFixed(2)}%</span>
                  <span>ドル円 {macro.usdjpy.toFixed(2)} / {macro.usdjpyChgPct >= 0 ? '+' : ''}{macro.usdjpyChgPct.toFixed(2)}%</span>
                  <span>日経VI {macro.nikkeiVI.toFixed(1)} / {macro.nikkeiVIChg >= 0 ? '+' : ''}{macro.nikkeiVIChg.toFixed(2)}</span>
                </div>
              </div>

              <div className="detail-panel">
                <div className="section-subtitle">需給メモ</div>
                <div className="detail-list">
                  <span>BOJ {market.boj}</span>
                  <span>次回観測 {market.bojNext}</span>
                  <span>米10年 {macro.ust10y.toFixed(2)}%</span>
                  <span>日10年 {macro.jgb10y.toFixed(2)}%</span>
                </div>
              </div>
            </div>
          )}
        </article>

        <article className="card">
          <div className="section-kicker">Learning engine</div>
          <h2 className="section-heading">自己学習の状態</h2>

          {learning ? (
            <>
              <div className="summary-grid" style={{ marginTop: 18 }}>
                <div className={`summary-tile summary-tile--${learningReady ? 'positive' : 'caution'}`}>
                  <div className="summary-tile__label">総判定数</div>
                  <div className="summary-tile__value">{learning.summary.total}</div>
                </div>
                <div className={`summary-tile summary-tile--${getTone(learning.summary.accuracy, 55, 45)}`}>
                  <div className="summary-tile__label">勝率</div>
                  <div className="summary-tile__value">{learning.summary.accuracy.toFixed(1)}%</div>
                </div>
                <div className={`summary-tile summary-tile--${learning.summary.avgReward >= 0 ? 'positive' : 'negative'}`}>
                  <div className="summary-tile__label">平均報酬</div>
                  <div className="summary-tile__value">{learning.summary.avgReward >= 0 ? '+' : ''}{learning.summary.avgReward.toFixed(3)}</div>
                </div>
                <div className="summary-tile summary-tile--neutral">
                  <div className="summary-tile__label">最終更新</div>
                  <div className="summary-tile__value" style={{ fontSize: 18 }}>
                    {formatDateTime(learning.lastUpdated)}
                  </div>
                </div>
              </div>

              <div className="detail-grid" style={{ marginTop: 18 }}>
                {(['BUY', 'HOLD', 'SELL'] as const).map(key => {
                  const summary = learning.summary.byDecision[key]
                  return (
                    <div key={key} className="detail-panel">
                      <div className="section-subtitle">{key} 精度</div>
                      <div className="detail-list">
                        <span>精度 {summary.accuracy.toFixed(1)}%</span>
                        <span>{summary.wins}勝 / {summary.losses}敗 / {summary.flats}保留</span>
                        <span>平均報酬 {summary.avgReward >= 0 ? '+' : ''}{summary.avgReward.toFixed(3)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="section-subtitle">次サイクル重み</div>
                <div className="metrics-inline">
                  {Object.entries(learning.suggestedWeights).map(([key, value]) => (
                    <span key={key}>{key} {(value * 100).toFixed(1)}%</span>
                  ))}
                </div>
                <p className="section-copy" style={{ marginTop: 12 }}>
                  {learningReady
                    ? '現在の推奨重みは分析ロジックへ適用済みです。'
                    : `適用前です。あと ${Math.max(0, 20 - learning.summary.total)} 件の実績が必要です。`}
                </p>
              </div>

              {learning.summary.driftSignals.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div className="section-subtitle">ドリフト検知</div>
                  <ul className="simple-list simple-list--alert">
                    {learning.summary.driftSignals.map(signal => <li key={signal}>{signal}</li>)}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state" style={{ marginTop: 18 }}>
              学習ログがまだありません。分析を複数回まわすと自動で蓄積されます。
            </div>
          )}
        </article>
      </section>

      <section className="content-grid">
        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Technical ranking</div>
                <h3 className="section-heading">テクニカル上位</h3>
              </div>
            </div>
            <div className="score-list">
              {technicalLeaders.map(item => (
                <div key={item.holding.code} className="score-list__item">
                  <div>
                    <strong>{item.holding.code} {item.holding.name}</strong>
                    <span>
                      RSI {item.holding.rsi.toFixed(0)} / 3M {item.holding.mom3m >= 0 ? '+' : ''}{item.holding.mom3m.toFixed(1)}%
                    </span>
                  </div>
                  <span>{item.analysis.technicalScore}/20</span>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Fundamental ranking</div>
                <h3 className="section-heading">ファンダ上位</h3>
              </div>
            </div>
            <div className="score-list">
              {fundamentalLeaders.map(item => (
                <div key={item.holding.code} className="score-list__item">
                  <div>
                    <strong>{item.holding.code} {item.holding.name}</strong>
                    <span>
                      ROE {item.holding.roe.toFixed(1)}% / EPS {item.holding.epsG >= 0 ? '+' : ''}{item.holding.epsG.toFixed(1)}% / PER {item.holding.per.toFixed(1)}x
                    </span>
                  </div>
                  <span>{item.analysis.fundamentalScore}/30</span>
                </div>
              ))}
            </div>
          </article>

          {bestDebate && bestHolding && (
            <article className="card">
              <div className="section-heading-row">
                <div>
                  <div className="section-kicker">Consensus</div>
                  <h3 className="section-heading">AIコンセンサス</h3>
                </div>
                <div className="section-caption">{bestHolding.code}</div>
              </div>

              <div className="recommendation-card recommendation-card--neutral" style={{ marginTop: 16 }}>
                <div className="recommendation-card__top">
                  <div>
                    <div className="recommendation-card__code">{bestHolding.code}</div>
                    <div className="recommendation-card__name">{bestHolding.name}</div>
                  </div>
                  <div className="recommendation-card__meta">
                    <span className={`vd ${bestDebate.decision === 'BUY' ? 'buy' : bestDebate.decision === 'SELL' ? 'sell' : 'hold'}`}>
                      {bestDebate.decision}
                    </span>
                    <span className="recommendation-card__score">{bestDebate.debate.debateScore}</span>
                  </div>
                </div>

                <div className="metrics-inline">
                  {Object.entries(bestDebate.debate.sevenAxis).map(([key, value]) => (
                    <span key={key}>{key} {value}</span>
                  ))}
                </div>

                <div className="detail-grid" style={{ marginTop: 18 }}>
                  <div className="detail-panel">
                    <div className="section-subtitle">強気材料</div>
                    <ul className="simple-list">
                      {(bestDebate.debate.bullReasons.length > 0 ? bestDebate.debate.bullReasons : ['強気理由の集約中です。'])
                        .slice(0, 4)
                        .map(reason => <li key={reason}>{reason}</li>)}
                    </ul>
                  </div>

                  <div className="detail-panel">
                    <div className="section-subtitle">弱気材料</div>
                    <ul className="simple-list simple-list--alert">
                      {(bestDebate.debate.bearReasons.length > 0 ? bestDebate.debate.bearReasons : ['弱気理由の集約中です。'])
                        .slice(0, 4)
                        .map(reason => <li key={reason}>{reason}</li>)}
                    </ul>
                  </div>
                </div>

                {relatedNews.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <div className="section-subtitle">関連ニュース</div>
                    <div className="score-list">
                      {relatedNews.map(item => (
                        <div key={item.id} className="score-list__item">
                          <div>
                            <strong>{item.title}</strong>
                            <span>{item.source} / {formatDateTime(item.publishedAt)}</span>
                          </div>
                          <span>{(item.importance * 100).toFixed(0)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </article>
          )}
        </div>

        <div className="stack-layout">
          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Flow and margin</div>
                <h3 className="section-heading">需給と資金フロー</h3>
              </div>
            </div>

            <div className="detail-grid" style={{ marginTop: 16 }}>
              <div className="detail-panel">
                <div className="section-subtitle">外国人・個人・機関</div>
                <div className="detail-list">
                  <span>外国人 {flows ? `${flows.foreignNet >= 0 ? '+' : ''}${flows.foreignNet.toLocaleString('ja-JP')}億円` : '—'}</span>
                  <span>個人 {flows ? `${flows.individualNet >= 0 ? '+' : ''}${flows.individualNet.toLocaleString('ja-JP')}億円` : '—'}</span>
                  <span>機関 {flows ? `${flows.institutionalNet >= 0 ? '+' : ''}${flows.institutionalNet.toLocaleString('ja-JP')}億円` : '—'}</span>
                  <span>信託5週 {flows ? `${flows.trust5w >= 0 ? '+' : ''}${flows.trust5w.toLocaleString('ja-JP')}億円` : '—'}</span>
                </div>
              </div>

              <div className="detail-panel">
                <div className="section-subtitle">信用需給</div>
                <div className="detail-list">
                  <span>買残 {margin ? `${margin.buyingMargin.toLocaleString('ja-JP')}億円` : '—'}</span>
                  <span>売残 {margin ? `${margin.sellingMargin.toLocaleString('ja-JP')}億円` : '—'}</span>
                  <span>貸借倍率 {margin ? margin.ratio.toFixed(2) : '—'}</span>
                  <span>週次 {margin?.weekOf ?? '—'}</span>
                </div>
              </div>
            </div>
          </article>

          <article className="card">
            <div className="section-heading-row">
              <div>
                <div className="section-kicker">Decision distribution</div>
                <h3 className="section-heading">判定分布</h3>
              </div>
            </div>
            <div className="summary-grid" style={{ marginTop: 16 }}>
              {[
                { label: 'BUY', value: analysis.filter(item => item.decision === 'BUY').length, tone: 'positive' },
                { label: 'HOLD', value: analysis.filter(item => item.decision === 'HOLD').length, tone: 'neutral' },
                { label: 'SELL', value: analysis.filter(item => item.decision === 'SELL').length, tone: 'negative' },
                { label: '対象数', value: analysis.length, tone: 'neutral' },
              ].map(item => (
                <div key={item.label} className={`summary-tile summary-tile--${item.tone}`}>
                  <div className="summary-tile__label">{item.label}</div>
                  <div className="summary-tile__value">{item.value}</div>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
