import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectIsLoading, selectTotalEval } from '../../store/selectors'
import { formatDateTime, formatJPYAuto, formatRelativeTime } from '../../utils/format'
import type { NewsItem } from '../../types'

type NewsTab = 'market' | 'holding' | 'candidate' | 'trust' | 'history'

type Tone = 'positive' | 'caution' | 'negative' | 'neutral'

function getImpact(item: NewsItem) {
  const impact = item.impact ?? (item.sentimentScore > 0.2 ? 'positive' : item.sentimentScore < -0.2 ? 'negative' : 'neutral')
  if (impact === 'positive') return { label: 'プラス', tone: 'positive' as const }
  if (impact === 'negative') return { label: 'マイナス', tone: 'negative' as const }
  return { label: '中立', tone: 'neutral' as const }
}

function getImportance(item: NewsItem) {
  if (item.importance >= 0.75) return { label: '高', tone: 'negative' as const }
  if (item.importance >= 0.45) return { label: '中', tone: 'caution' as const }
  return { label: '低', tone: 'neutral' as const }
}

function parseTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function getFreshness(raw: string | null | undefined) {
  const parsed = parseTimestamp(raw)
  if (!parsed) return { label: '未取得', tone: 'neutral' as Tone, minutes: null as number | null }
  const minutes = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 60000))
  if (minutes <= 90) return { label: `${minutes}分前`, tone: 'positive' as Tone, minutes }
  if (minutes <= 360) return { label: `${minutes}分前`, tone: 'caution' as Tone, minutes }
  if (minutes <= 1440) return { label: `${Math.round(minutes / 60)}時間前`, tone: 'caution' as Tone, minutes }
  return { label: `${Math.round(minutes / 1440)}日前`, tone: 'negative' as Tone, minutes }
}

function sourceLabel(source: string) {
  const labels: Record<string, string> = {
    market: 'Market',
    correlation: 'Correlation',
    news: 'News',
    trust: 'Trust',
    macro: 'Macro',
    nikkeiVI: 'NikkeiVI',
    sq: 'SQ',
    margin: 'Margin',
    flows: 'Flows',
  }
  return labels[source] ?? source
}

function NewsEntry({ item, label }: { item: NewsItem; label: string }) {
  const holdings = useAppStore(s => s.holdings)
  const impact = getImpact(item)
  const importance = getImportance(item)
  const relatedNames = item.tickers
    .map(code => holdings.find(holding => holding.code === code)?.name ?? code)
    .slice(0, 4)

  return (
    <article className={`news-entry news-entry--${impact.tone}`}>
      <div className="news-entry__header">
        <div>
          <div className="news-entry__title">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
            ) : item.title}
          </div>
          <div className="news-entry__meta">
            <span>{label}</span>
            <span>{item.source}</span>
            <span>{formatRelativeTime(item.publishedAt)}</span>
            <span>重要度 {(item.importance * 100).toFixed(0)}</span>
          </div>
        </div>

        <div className="news-entry__chips">
          <span className={`tone-chip tone-chip--${impact.tone}`}>{impact.label}</span>
          <span className={`tone-chip tone-chip--${importance.tone}`}>{importance.label}</span>
        </div>
      </div>

      {item.summary && <p className="news-entry__summary">{item.summary}</p>}

      <div className="news-entry__notes">
        <div>
          <strong>なぜ重要か</strong>
          <span>{item.whyImportant ?? '売買前提や需給認識を更新するための材料です。'}</span>
        </div>
        <div>
          <strong>推奨アクション</strong>
          <span>{item.recommendation ?? '前提に変化があるかを確認し、執行条件を再点検します。'}</span>
        </div>
      </div>

      {relatedNames.length > 0 && (
        <div className="metrics-inline">
          {relatedNames.map(name => <span key={name}>{name}</span>)}
        </div>
      )}
    </article>
  )
}

export function T6_History() {
  const [tab, setTab] = useState<NewsTab>('market')
  const system = useAppStore(s => s.system)
  const news = useAppStore(s => s.news)
  const macro = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const metrics = useAppStore(s => s.metrics)
  const holdings = useAppStore(s => s.holdings)
  const trust = useAppStore(s => s.trust)
  const importCsv = useAppStore(s => s.importCsv)
  const refreshAllData = useAppStore(s => s.refreshAllData)
  const buyList = useAppStore(selectBuyList)
  const totalEval = useAppStore(selectTotalEval)
  const isLoading = useAppStore(selectIsLoading)

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importCsv(file)
  }

  const holdingCodes = useMemo(() => new Set(holdings.map(item => item.code)), [holdings])
  const candidateCodes = useMemo(() => new Set(buyList.map(item => item.code)), [buyList])
  const trustKeywords = useMemo(
    () => trust.map(item => item.abbr).concat(['S&P500', 'NASDAQ', 'FANG', 'オルカン', 'ゴールド', 'REIT', '日経225']),
    [trust],
  )

  const marketNews = useMemo(
    () => [...(news?.marketNews ?? [])].sort((a, b) => b.importance - a.importance),
    [news],
  )

  const stockNews = useMemo(
    () => [...(news?.stockNews ?? [])].sort((a, b) => b.importance - a.importance),
    [news],
  )

  const holdingNews = useMemo(
    () => stockNews.filter(item => item.tickers.some(code => holdingCodes.has(code))),
    [holdingCodes, stockNews],
  )

  const candidateNews = useMemo(
    () =>
      [...stockNews, ...marketNews]
        .filter(item => {
          if (item.tickers.some(code => candidateCodes.has(code))) return true
          return [...candidateCodes].some(code => item.title.includes(code) || item.summary.includes(code))
        })
        .slice(0, 40),
    [candidateCodes, marketNews, stockNews],
  )

  const trustNews = useMemo(
    () =>
      [...marketNews, ...stockNews]
        .filter(item => trustKeywords.some(keyword => keyword && (item.title.includes(keyword) || item.summary.includes(keyword))))
        .slice(0, 40),
    [marketNews, stockNews, trustKeywords],
  )

  const tabItems = [
    { id: 'market' as const, label: 'マーケット', count: marketNews.length },
    { id: 'holding' as const, label: '保有銘柄', count: holdingNews.length },
    { id: 'candidate' as const, label: '候補銘柄', count: candidateNews.length },
    { id: 'trust' as const, label: '投信関連', count: trustNews.length },
    { id: 'history' as const, label: '更新履歴', count: Object.keys(system.dataSourceStatus).length },
  ]

  const activeItems =
    tab === 'market' ? marketNews :
    tab === 'holding' ? holdingNews :
    tab === 'candidate' ? candidateNews :
    tab === 'trust' ? trustNews : []

  const weightedPnlPct = totalEval > 0
    ? holdings.reduce((sum, item) => sum + item.pnlPct * (item.eval / totalEval), 0)
    : 0

  const mitsuRatio = totalEval > 0
    ? holdings.filter(item => item.mitsu).reduce((sum, item) => sum + item.eval, 0) / totalEval * 100
    : 0

  const goals = [
    { label: '年率 +15%', current: weightedPnlPct, target: 15, invert: false, unit: '%' },
    { label: 'Sharpe 2.0', current: metrics?.sharpe ?? 0, target: 2, invert: false, unit: '' },
    { label: '三菱比率 35%以下', current: mitsuRatio, target: 35, invert: true, unit: '%' },
    { label: 'BUY候補監視', current: buyList.length, target: 3, invert: false, unit: '件' },
  ]

  const sourceRows = useMemo(() => {
    const timestamps = system.dataTimestamps
    return Object.entries(system.dataSourceStatus).map(([source, status]) => {
      const raw = timestamps?.[source as keyof typeof timestamps] ?? null
      const freshness = getFreshness(raw)
      const tone: Tone =
        status === 'error' || status === 'none'
          ? 'negative'
          : freshness.tone === 'negative'
            ? 'negative'
            : freshness.tone === 'caution'
              ? 'caution'
              : status === 'loaded'
                ? 'positive'
                : 'neutral'
      return {
        source,
        label: sourceLabel(source),
        status,
        raw,
        freshness,
        tone,
      }
    })
  }, [system.dataSourceStatus, system.dataTimestamps])

  const staleRows = sourceRows.filter(row => row.tone === 'negative')
  const digestItems = useMemo(() => {
    const merged = [...holdingNews, ...candidateNews, ...trustNews, ...marketNews]
      .sort((left, right) => right.importance - left.importance)
    const unique: NewsItem[] = []
    const seen = new Set<string>()
    merged.forEach(item => {
      if (seen.has(item.id)) return
      seen.add(item.id)
      unique.push(item)
    })
    return unique
      .filter(item => item.importance >= 0.68 || (item.impact ?? 'neutral') === 'negative')
      .slice(0, 6)
  }, [candidateNews, holdingNews, marketNews, trustNews])

  return (
    <div className="tab-panel">
      <section className="decision-grid">
        <article className="card news-command">
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">News command</div>
              <h2 className="section-heading">情報更新の全体像</h2>
            </div>
            <button
              className={`status-shell__refresh${isLoading ? ' is-loading' : ''}`}
              onClick={() => { void refreshAllData() }}
              disabled={isLoading}
              type="button"
            >
              {isLoading ? '更新中...' : 'データ更新'}
            </button>
          </div>

          <div className="summary-grid" style={{ marginTop: 16 }}>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">市場ニュース</div>
              <div className="summary-tile__value">{marketNews.length}</div>
            </div>
            <div className="summary-tile summary-tile--neutral">
              <div className="summary-tile__label">保有関連</div>
              <div className="summary-tile__value">{holdingNews.length}</div>
            </div>
            <div className="summary-tile summary-tile--positive">
              <div className="summary-tile__label">候補関連</div>
              <div className="summary-tile__value">{candidateNews.length}</div>
            </div>
            <div className="summary-tile summary-tile--caution">
              <div className="summary-tile__label">最終更新</div>
              <div className="summary-tile__value" style={{ fontSize: 18 }}>
                {news ? formatDateTime(news.updatedAt) : '未取得'}
              </div>
            </div>
          </div>

          <div className="metrics-inline">
            <span>総資産 {formatJPYAuto(totalEval)}</span>
            <span>BUY候補 {buyList.length}</span>
            <span>ニュース総数 {news?.meta.totalCount ?? 0}</span>
            <span>重複除去 {news?.meta.duplicateRemoved ?? 0}</span>
            <span>データ異常 {staleRows.length}件</span>
          </div>

          {staleRows.length > 0 && (
            <div className="news-command__alerts">
              {staleRows.map(row => (
                <div key={row.source} className="news-command__alert">
                  <strong>{row.label}</strong>
                  <span>{row.status} / {row.freshness.label}</span>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="card">
          <div className="section-kicker">Data freshness</div>
          <h2 className="section-heading">ソース鮮度ボード</h2>
          <div className="freshness-board" style={{ marginTop: 16 }}>
            {sourceRows.map(row => (
              <div key={row.source} className={`freshness-board__item freshness-board__item--${row.tone}`}>
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.raw ? formatDateTime(row.raw) : '更新日時なし'}</span>
                </div>
                <div className="freshness-board__chips">
                  <span className={`tone-chip tone-chip--${row.tone}`}>{row.freshness.label}</span>
                  <span className="tone-chip tone-chip--neutral">{row.status}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <article className="card">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Coverage</div>
            <h3 className="section-heading">年間目標と情報カバレッジ</h3>
          </div>
        </div>

        <div className="goal-grid" style={{ marginTop: 16 }}>
          {goals.map(goal => {
            const progress = goal.invert
              ? goal.target === 0
                ? goal.current === 0 ? 100 : 0
                : Math.max(0, Math.min(100, (1 - goal.current / (goal.target * 2)) * 100))
              : goal.target > 0
                ? Math.max(0, Math.min(100, (goal.current / goal.target) * 100))
                : 0
            const achieved = goal.invert ? goal.current <= goal.target : goal.current >= goal.target
            return (
              <div key={goal.label} className={`goal-card${achieved ? ' is-achieved' : ''}`}>
                <div className="goal-card__label">{goal.label}</div>
                <div className="goal-card__value">
                  {goal.current.toFixed(goal.unit === '' ? 2 : 1)}{goal.unit}
                </div>
                <div className="goal-card__meta">目標 {goal.target}{goal.unit}</div>
                <div className="goal-card__track">
                  <span style={{ width: `${progress}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      </article>

      <article className="card" style={{ marginTop: 18 }}>
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Urgent digest</div>
            <h3 className="section-heading">優先確認ヘッドライン</h3>
          </div>
        </div>

        {digestItems.length > 0 ? (
          <div className="news-urgent" style={{ marginTop: 14 }}>
            {digestItems.map(item => {
              const impact = getImpact(item)
              return (
                <div key={item.id} className={`news-urgent__item news-urgent__item--${impact.tone}`}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.source} / {formatRelativeTime(item.publishedAt)} / 重要度 {(item.importance * 100).toFixed(0)}</span>
                  </div>
                  <span className={`tone-chip tone-chip--${impact.tone}`}>{impact.label}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="empty-state" style={{ marginTop: 14 }}>
            優先ヘッドラインはまだありません。
          </div>
        )}
      </article>

      <article className="card" style={{ marginTop: 18 }}>
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Feed view</div>
            <h3 className="section-heading">ニュース一覧</h3>
          </div>
        </div>

        <div className="segmented-tabs" style={{ marginTop: 16 }}>
          {tabItems.map(item => (
            <button
              key={item.id}
              className={`segmented-tabs__item${tab === item.id ? ' active' : ''}`}
              onClick={() => setTab(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </button>
          ))}
        </div>

        {tab === 'history' ? (
          <div className="stack-layout" style={{ marginTop: 18 }}>
            <div
              className="csv-drop"
              onDrop={handleDrop}
              onDragOver={event => event.preventDefault()}
            >
              <input type="file" accept=".csv" onChange={handleFileChange} />
              <div>CSVを投入して保有・損益データを更新</div>
              <small>{system.csvLastImportedAt ? `最終取込 ${formatDateTime(system.csvLastImportedAt)}` : 'まだ取り込みはありません。'}</small>
            </div>

            <div className="freshness-board">
              {sourceRows.map(row => (
                <div key={`history-${row.source}`} className={`freshness-board__item freshness-board__item--${row.tone}`}>
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.raw ? formatDateTime(row.raw) : '更新日時なし'}</span>
                  </div>
                  <div className="freshness-board__chips">
                    <span className={`tone-chip tone-chip--${row.tone}`}>{row.freshness.label}</span>
                    <span className="tone-chip tone-chip--neutral">{row.status}</span>
                  </div>
                </div>
              ))}
            </div>

            <article className="card">
              <div className="section-kicker">Macro memo</div>
              <h3 className="section-heading">今朝の確認ポイント</h3>
              <div className="detail-grid" style={{ marginTop: 14 }}>
                <div className="detail-panel">
                  <div className="section-subtitle">マクロ</div>
                  <div className="detail-list">
                    <span>S&P500 {macro ? `${macro.sp500.toLocaleString('en-US')} / ${macro.sp500ChgPct >= 0 ? '+' : ''}${macro.sp500ChgPct.toFixed(2)}%` : '—'}</span>
                    <span>VIX {macro ? `${macro.vix.toFixed(2)} / ${macro.vixChg >= 0 ? '+' : ''}${macro.vixChg.toFixed(2)}` : '—'}</span>
                    <span>ドル円 {macro ? `${macro.usdjpy.toFixed(2)} / ${macro.usdjpyChgPct >= 0 ? '+' : ''}${macro.usdjpyChgPct.toFixed(2)}%` : '—'}</span>
                    <span>日経VI {macro ? `${macro.nikkeiVI.toFixed(1)} / ${macro.nikkeiVIChg >= 0 ? '+' : ''}${macro.nikkeiVIChg.toFixed(2)}` : '—'}</span>
                  </div>
                </div>

                <div className="detail-panel">
                  <div className="section-subtitle">イベント</div>
                  <div className="detail-list">
                    <span>次回SQ {sqCalendar?.nextSQ ? `${sqCalendar.nextSQ.date} / 残り${sqCalendar.nextSQ.dayUntil}営業日` : '—'}</span>
                    <span>CSV取込 {system.csvLastImportedAt ? formatDateTime(system.csvLastImportedAt) : '未実施'}</span>
                    <span>分析更新 {system.analysisLastRunAt ? formatDateTime(system.analysisLastRunAt) : '未実行'}</span>
                    <span>全体更新 {system.lastUpdated ? formatDateTime(system.lastUpdated) : '未更新'}</span>
                  </div>
                </div>
              </div>
            </article>
          </div>
        ) : activeItems.length > 0 ? (
          <div className="news-feed" style={{ marginTop: 18 }}>
            {activeItems.map(item => (
              <NewsEntry
                key={item.id}
                item={item}
                label={
                  tab === 'market' ? '市場全体' :
                  tab === 'holding' ? '保有銘柄' :
                  tab === 'candidate' ? '候補銘柄' : '投信関連'
                }
              />
            ))}
          </div>
        ) : (
          <div className="empty-state" style={{ marginTop: 18 }}>
            このカテゴリのニュースはまだありません。
          </div>
        )}
      </article>
    </div>
  )
}
