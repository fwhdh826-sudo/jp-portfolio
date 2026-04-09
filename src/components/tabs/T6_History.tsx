import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectSellList, selectTotalEval } from '../../store/selectors'

interface HistoryEntry {
  ts: string
  event: string
  detail: string
}

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem('v81_history') || '[]') as HistoryEntry[]
  } catch { return [] }
}

const TAG_COLORS: Record<string, string> = {
  'データ更新': 'lt-sys',
  'CSV取込':    'lt-buy',
  '売却':       'lt-sell',
  '購入':       'lt-buy',
  'HOLD':       'lt-hold',
}

export function T6_History() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const system    = useAppStore(s => s.system)
  const news      = useAppStore(s => s.news)
  const metrics   = useAppStore(s => s.metrics)
  const holdings  = useAppStore(s => s.holdings)
  const sellList  = useAppStore(selectSellList)
  const totalEval = useAppStore(selectTotalEval)
  const importCsv = useAppStore(s => s.importCsv)

  const history = loadHistory()

  const events: HistoryEntry[] = [
    ...(system.lastUpdated
      ? [{ ts: system.lastUpdated, event: 'データ更新', detail: `市場:${system.dataSourceStatus.market} / 相関:${system.dataSourceStatus.correlation} / ニュース:${system.dataSourceStatus.news}` }]
      : []),
    ...(system.csvLastImportedAt
      ? [{ ts: system.csvLastImportedAt, event: 'CSV取込', detail: 'SBI証券CSVを取込みました' }]
      : []),
    ...history,
  ].sort((a, b) => b.ts.localeCompare(a.ts))

  const toggle = (i: number) => {
    const next = new Set(expanded)
    next.has(i) ? next.delete(i) : next.add(i)
    setExpanded(next)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) void importCsv(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void importCsv(file)
  }

  // ── 年間目標 2026 ─────────────────────────────────────────────
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval, 0) / Math.max(totalEval, 1) * 100

  // 推定PnL%（holdings 平均加重）
  const pnlPct = totalEval > 0
    ? holdings.reduce((s, h) => s + h.pnlPct * (h.eval / totalEval), 0)
    : 0

  const goals = [
    { label: 'リターン +15%/年', current: pnlPct,            target: 15,  unit: '%',  invert: false },
    { label: 'Sharpe ≥2.00',     current: metrics?.sharpe ?? 0, target: 2.0, unit: '',   invert: false },
    { label: '三菱集中 ≤35%',    current: mitsuW,             target: 35,  unit: '%',  invert: true },
    { label: 'SELL銘柄ゼロ',     current: sellList.length,   target: 0,   unit: '件', invert: true },
  ]

  // ── ニュース ──────────────────────────────────────────────────
  const allNews = news
    ? [...(news.marketNews ?? []), ...(news.stockNews ?? [])]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 12)
    : []

  return (
    <div className="tab-panel">

      {/* ── CSV ドロップゾーン ── */}
      <div
        className="csv-drop"
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        style={{ marginBottom: 10 }}
      >
        <input type="file" accept=".csv" onChange={handleFileChange} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
          📁 SBI証券CSVをドロップ or タップして選択
        </div>
        {system.csvLastImportedAt && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--g)', marginTop: 5 }}>
            最終取込: {system.csvLastImportedAt.slice(0, 10)}
          </div>
        )}
      </div>

      {/* ── マーケットニュース ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">
          マーケットニュース{' '}
          {news && <span className="badge live">{news.meta.totalCount}件</span>}
        </div>
        {allNews.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '8px 0' }}>
            ニュースデータなし — news.json が未ロードです
          </div>
        ) : (
          allNews.map(n => {
            const sentiment = n.sentimentScore
            const levelClass = sentiment > 0.3 ? 'ni-high' : sentiment < -0.3 ? 'ni-high' : 'ni-med'
            const sentColor  = sentiment > 0.3 ? 'var(--g)' : sentiment < -0.3 ? 'var(--r)' : 'var(--d)'
            return (
              <div key={n.id} className={`news-item ${levelClass}`} style={{
                padding: '7px 0', borderBottom: '1px solid var(--b1)',
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', flexShrink: 0, minWidth: 50 }}>
                    {n.publishedAt.slice(5, 16).replace('T', ' ')}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: 'var(--w)', lineHeight: 1.5, marginBottom: 2 }}>
                      {n.title}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: sentColor }}>
                        {sentiment > 0 ? '▲' : sentiment < 0 ? '▼' : '─'} {Math.abs(sentiment * 100).toFixed(0)}%
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
                        {n.source}
                      </span>
                      {n.tickers.slice(0, 2).map(t => (
                        <span key={t} style={{
                          fontFamily: 'var(--mono)', fontSize: 8,
                          background: 'var(--bg3)', border: '1px solid var(--b1)',
                          borderRadius: 4, padding: '1px 5px', color: 'var(--c)',
                        }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── 年間目標 2026 ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">年間目標 2026</div>
        {goals.map(g => {
          let progress: number
          if (g.invert) {
            // lower is better
            progress = g.target === 0
              ? (g.current === 0 ? 100 : 0)
              : Math.max(0, Math.min(100, (1 - g.current / (g.target * 2)) * 100))
          } else {
            progress = g.target > 0
              ? Math.max(0, Math.min(100, (g.current / g.target) * 100))
              : 0
          }
          const isAchieved = g.invert ? g.current <= g.target : g.current >= g.target
          return (
            <div key={g.label} className="pr-row" style={{ marginBottom: 8 }}>
              <div className="pr-label" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)' }}>{g.label}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: isAchieved ? 'var(--g)' : 'var(--a)' }}>
                  {typeof g.current === 'number' ? g.current.toFixed(g.unit === '' ? 2 : 1) : g.current}{g.unit}
                  {' '}/{' '}{g.target}{g.unit}
                  {isAchieved ? ' ✓' : ''}
                </span>
              </div>
              <div className="pr-bar">
                <div
                  className="pr-fill"
                  style={{
                    width: `${progress}%`,
                    background: isAchieved ? 'var(--g2)' : 'var(--a)',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── 操作履歴 ── */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: 8 }}>
        操作履歴 — ローカル保持
      </div>

      {events.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', paddingTop: 32, paddingBottom: 32 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📂</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
            履歴がありません
          </div>
        </div>
      ) : (
        events.map((e, i) => (
          <div key={i} className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 6 }}>
            <button
              onClick={() => toggle(i)}
              style={{
                width: '100%', textAlign: 'left', background: 'none', border: 'none',
                padding: '10px 14px', cursor: 'pointer', display: 'flex',
                alignItems: 'center', gap: 10, touchAction: 'manipulation',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span className={`log-tag ${TAG_COLORS[e.event] ?? 'lt-sys'}`}>{e.event}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)' }}>
                {e.ts.slice(0, 19).replace('T', ' ')}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--d)', fontSize: 12 }}>
                {expanded.has(i) ? '▲' : '▼'}
              </span>
            </button>
            {expanded.has(i) && (
              <div style={{
                padding: '0 14px 12px',
                borderTop: '1px solid var(--b2)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--c)',
                lineHeight: 1.6,
              }}>
                {e.detail}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
