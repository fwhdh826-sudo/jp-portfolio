import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectSellList, selectTotalEval } from '../../store/selectors'
import { formatRelativeTime, formatJPYAuto } from '../../utils/format'
import type { NewsItem } from '../../types'

// ── ニュースカード（朝メモ形式）────────────────────────────────
function NewsCard({ item }: { item: NewsItem }) {
  const holdings = useAppStore(s => s.holdings)
  const sent = item.sentimentScore
  const sentColor = sent > 0.25 ? 'var(--g)' : sent < -0.25 ? 'var(--r)' : 'var(--d)'
  const sentLabel = sent > 0.25 ? '▲ 強気' : sent < -0.25 ? '▼ 弱気' : '─ 中立'
  const relatedNames = item.tickers.map(code =>
    holdings.find(h => h.code === code)?.name ?? code
  )

  return (
    <div style={{
      padding: '10px 0',
      borderBottom: '1px solid var(--b1)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {/* センチメント縦バー */}
        <div style={{
          width: 3, flexShrink: 0, borderRadius: 2, alignSelf: 'stretch',
          background: sent > 0.25 ? 'var(--g2)' : sent < -0.25 ? 'var(--r2)' : 'var(--b1)',
          minHeight: 40,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* タイトル */}
          <div style={{ fontSize: 12, color: 'var(--w)', lineHeight: 1.55, marginBottom: 4 }}>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'inherit', textDecoration: 'none' }}
              >
                {item.title}
              </a>
            ) : item.title}
          </div>
          {/* メタ行 */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: sentColor }}>
              {sentLabel}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
              {item.source}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
              {formatRelativeTime(item.publishedAt)}
            </span>
            {/* 関連保有銘柄 */}
            {relatedNames.map((name, i) => (
              <span key={i} style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                background: 'rgba(45,212,160,.12)', border: '1px solid var(--g2)',
                borderRadius: 4, padding: '1px 6px', color: 'var(--g)',
              }}>
                ★ {name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── T6_News ───────────────────────────────────────────────────
export function T6_History() {
  const [tab, setTab] = useState<'market' | 'stock' | 'history'>('market')
  const system    = useAppStore(s => s.system)
  const news      = useAppStore(s => s.news)
  const macro     = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const metrics   = useAppStore(s => s.metrics)
  const holdings  = useAppStore(s => s.holdings)
  const sellList  = useAppStore(selectSellList)
  const totalEval = useAppStore(selectTotalEval)
  const importCsv = useAppStore(s => s.importCsv)

  const handleDrop       = (e: React.DragEvent)        => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void importCsv(f) }
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) void importCsv(f) }

  // ニュース件数
  const marketCount = news?.marketNews?.length ?? 0
  const stockCount  = news?.stockNews?.length  ?? 0

  // 保有銘柄ニュースを重要度降順
  const stockNews = (news?.stockNews ?? []).sort((a, b) => b.importance - a.importance)
  // マーケットニュースを重要度降順
  const marketNews = (news?.marketNews ?? []).sort((a, b) => b.importance - a.importance)

  // 年間目標
  const pnlPct = totalEval > 0
    ? holdings.reduce((s, h) => s + h.pnlPct * (h.eval / totalEval), 0) : 0
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval, 0) / Math.max(totalEval, 1) * 100

  const goals = [
    { label: 'リターン +15%/年', current: pnlPct,                 target: 15,  unit: '%', invert: false },
    { label: 'Sharpe ≥2.00',     current: metrics?.sharpe ?? 0,   target: 2.0, unit: '',  invert: false },
    { label: '三菱集中 ≤35%',    current: mitsuW,                 target: 35,  unit: '%', invert: true  },
    { label: 'SELL銘柄ゼロ',     current: sellList.length,        target: 0,   unit: '件',invert: true  },
  ]

  return (
    <div className="tab-panel">

      {/* ── 朝メモ ヘッダー: マクロ4指標 + VI + SQ ── */}
      <div style={{
        background: 'linear-gradient(135deg,#0d1828,#0a1222)',
        border: '1px solid var(--b1)', borderRadius: 12,
        padding: '12px 14px', marginBottom: 10,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--head)', fontSize: 9, color: 'var(--g)', letterSpacing: '.15em' }}>
            📰 MARKET MORNING MEMO
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
            {macro?.last_updated ?? system.lastUpdated?.slice(0, 16).replace('T', ' ') ?? '─'}
          </div>
        </div>

        {/* 4指標グリッド（朝メモ形式）*/}
        {macro ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            {[
              { label: 'S&P500', val: macro.sp500.toLocaleString('en-US', { maximumFractionDigits: 0 }), chgPct: macro.sp500ChgPct },
              { label: 'VIX',    val: macro.vix.toFixed(2),  chgAbs: macro.vixChg, invertGood: true },
              { label: 'NY原油', val: macro.nyCrude.toFixed(2), chgPct: macro.nyCrudeChgPct },
              { label: 'ドル円', val: macro.usdjpy.toFixed(2),  chgPct: macro.usdjpyChgPct, neutral: true },
            ].map(item => {
              const chgVal = 'chgPct' in item
                ? item.chgPct as number
                : 'chgAbs' in item ? item.chgAbs as number : 0
              const isUp = chgVal >= 0
              const goodIsUp = !(item as { invertGood?: boolean }).invertGood
              const isGood = (item as { neutral?: boolean }).neutral ? null : (goodIsUp ? isUp : !isUp)
              const chgStr = 'chgPct' in item
                ? `${(item as { chgPct: number }).chgPct >= 0 ? '+' : ''}${(item as { chgPct: number }).chgPct.toFixed(1)}%`
                : `${chgVal >= 0 ? '+' : ''}${chgVal.toFixed(2)}`
              return (
                <div key={item.label} style={{
                  background: 'rgba(0,0,0,.3)', borderRadius: 8,
                  padding: '8px 12px',
                  border: `1px solid ${isGood === null ? 'var(--b1)' : isGood ? 'rgba(45,212,160,.3)' : 'rgba(232,64,90,.3)'}`,
                }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 3 }}>
                    {item.label}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 18, color: 'var(--w)', fontWeight: 700 }}>
                      {item.val}
                    </span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                      padding: '2px 7px', borderRadius: 6,
                      color: isGood === null ? 'var(--d)' : isGood ? 'var(--g)' : 'var(--r)',
                      background: isGood === null ? 'rgba(74,96,112,.3)' : isGood ? 'rgba(45,212,160,.2)' : 'rgba(232,64,90,.2)',
                    }}>
                      {chgStr}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', marginBottom: 10 }}>
            マクロデータ読込中...
          </div>
        )}

        {/* 日経VI + SQ情報 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {macro && (
            <div style={{
              flex: '1 1 120px', background: 'rgba(0,0,0,.2)', borderRadius: 8, padding: '7px 12px',
              border: `1px solid ${macro.nikkeiVI > 25 ? 'rgba(232,64,90,.3)' : macro.nikkeiVI > 20 ? 'rgba(212,160,23,.3)' : 'var(--b1)'}`,
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginBottom: 2 }}>
                日経225 VI <span style={{ color: 'var(--d)', fontSize: 7 }}>（VIX近似）</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700,
                  color: macro.nikkeiVI > 25 ? 'var(--r)' : macro.nikkeiVI > 20 ? 'var(--a)' : 'var(--g)',
                }}>
                  {macro.nikkeiVI.toFixed(1)}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)',
                }}>
                  {macro.nikkeiVI > 25 ? '⚠ 警戒域' : macro.nikkeiVI > 20 ? '注意' : '平穏'}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginTop: 2 }}>
                高いほど投信の短期売買タイミング注意
              </div>
            </div>
          )}
          {sqCalendar?.nextSQ && (
            <div style={{
              flex: '1 1 120px', background: 'rgba(0,0,0,.2)', borderRadius: 8, padding: '7px 12px',
              border: `1px solid ${sqCalendar.nextSQ.dayUntil <= 3 ? 'rgba(232,64,90,.4)' : sqCalendar.nextSQ.dayUntil <= 7 ? 'rgba(212,160,23,.4)' : 'var(--b1)'}`,
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginBottom: 2 }}>
                次回SQ ({sqCalendar.nextSQ.type === 'quarterly' ? '四半期 ⚡' : '月次'})
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700,
                  color: sqCalendar.nextSQ.dayUntil <= 3 ? 'var(--r)' : sqCalendar.nextSQ.dayUntil <= 7 ? 'var(--a)' : 'var(--w)',
                }}>
                  {sqCalendar.nextSQ.date.slice(5)}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: sqCalendar.nextSQ.dayUntil <= 3 ? 'var(--r)' : 'var(--d)',
                }}>
                  あと {sqCalendar.nextSQ.dayUntil}営業日
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginTop: 2 }}>
                {sqCalendar.nextSQ.dayUntil <= 3 ? '⚠ SQ直前 — 投信短期売買は慎重に' : sqCalendar.nextSQ.dayUntil <= 7 ? 'SQ週 — ボラ上昇注意' : 'SQ前はVIが上昇しやすい'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 年間目標 ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>🎯 年間目標 2026</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {goals.map(g => {
            const progress = g.invert
              ? g.target === 0
                ? (g.current === 0 ? 100 : 0)
                : Math.max(0, Math.min(100, (1 - g.current / (g.target * 2)) * 100))
              : g.target > 0
                ? Math.max(0, Math.min(100, (g.current / g.target) * 100))
                : 0
            const achieved = g.invert ? g.current <= g.target : g.current >= g.target
            return (
              <div key={g.label} style={{
                background: achieved ? 'rgba(45,212,160,.06)' : 'rgba(0,0,0,.2)',
                borderRadius: 8, padding: '8px 10px',
                border: `1px solid ${achieved ? 'var(--g3)' : 'var(--b1)'}`,
              }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>
                  {g.label}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: achieved ? 'var(--g)' : 'var(--a)' }}>
                    {typeof g.current === 'number' ? g.current.toFixed(g.unit === '' ? 2 : 1) : g.current}{g.unit}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
                    目標 {g.target}{g.unit} {achieved ? '✓' : ''}
                  </span>
                </div>
                <div style={{ height: 3, background: 'var(--b2)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progress}%`, background: achieved ? 'var(--g2)' : 'var(--a)', borderRadius: 2 }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── ニュース タブ切替 ── */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* タブバー */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--b1)' }}>
          {([
            { id: 'market',  label: `📈 マーケット (${marketCount})` },
            { id: 'stock',   label: `⭐ 保有銘柄 (${stockCount})` },
            { id: 'history', label: '📂 履歴' },
          ] as { id: typeof tab; label: string }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1, padding: '10px 4px',
                background: tab === t.id ? 'rgba(104,150,200,.1)' : 'transparent',
                border: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${tab === t.id ? 'var(--c)' : 'transparent'}`,
                fontFamily: 'var(--mono)', fontSize: 9,
                color: tab === t.id ? 'var(--c)' : 'var(--d)',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ padding: '0 14px 12px' }}>
          {/* マーケットニュース */}
          {tab === 'market' && (
            <>
              {!news ? (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '16px 0', textAlign: 'center' }}>
                  ニュースデータなし<br />
                  <span style={{ fontSize: 10 }}>GitHub Actions が news.json を生成後に表示されます</span>
                </div>
              ) : marketNews.length === 0 ? (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)', padding: '16px 0' }}>
                  マーケットニュースなし
                </div>
              ) : (
                marketNews.map(n => <NewsCard key={n.id} item={n} />)
              )}
            </>
          )}

          {/* 保有銘柄ニュース */}
          {tab === 'stock' && (
            <>
              {stockNews.length === 0 ? (
                <div style={{ padding: '16px 0', textAlign: 'center' }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>⭐</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
                    保有銘柄に関するニュースなし<br />
                    <span style={{ fontSize: 10 }}>ニュースタイトルに銘柄名が含まれる場合に表示</span>
                  </div>
                </div>
              ) : (
                stockNews.map(n => <NewsCard key={n.id} item={n} />)
              )}
            </>
          )}

          {/* 操作履歴 */}
          {tab === 'history' && (
            <div style={{ paddingTop: 10 }}>
              {/* CSV取込ゾーン */}
              <div
                className="csv-drop"
                onDrop={handleDrop}
                onDragOver={e => e.preventDefault()}
                style={{ marginBottom: 12 }}
              >
                <input type="file" accept=".csv" onChange={handleFileChange} />
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
                  📁 SBI証券CSVをドロップ or タップして選択
                </div>
                {system.csvLastImportedAt && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--g)', marginTop: 5 }}>
                    最終取込: {system.csvLastImportedAt.slice(0, 16).replace('T', ' ')}
                  </div>
                )}
              </div>

              {/* データ更新タイムライン */}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 8 }}>
                データソース更新状況
              </div>
              {(Object.entries(system.dataSourceStatus) as [string, string][]).map(([src, status]) => (
                <div key={src} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '6px 0', borderBottom: '1px solid var(--b2)',
                  fontFamily: 'var(--mono)', fontSize: 10,
                }}>
                  <span style={{ color: 'var(--d)' }}>{src}</span>
                  <span style={{
                    color: status === 'loaded' ? 'var(--g)'
                         : status === 'static' ? 'var(--a)'
                         : status === 'none'   ? 'var(--d)' : 'var(--r)',
                  }}>
                    {status === 'loaded' ? '✓ ロード済' : status === 'static' ? '○ 静的値' : status === 'none' ? '─ なし' : '✗ エラー'}
                  </span>
                  <span style={{ color: 'var(--d)', fontSize: 9 }}>
                    {system.dataTimestamps?.[src as keyof typeof system.dataTimestamps]?.slice(0, 16).replace('T', ' ') ?? '─'}
                  </span>
                </div>
              ))}

              {system.lastUpdated && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginTop: 12 }}>
                  最終全体更新: {system.lastUpdated.slice(0, 16).replace('T', ' ')}
                </div>
              )}

              {/* 総資産サマリー */}
              <div style={{ marginTop: 12, padding: '10px', background: 'rgba(0,0,0,.2)', borderRadius: 8, border: '1px solid var(--b1)' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 6 }}>総資産サマリー</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--w)' }}>
                  {formatJPYAuto(totalEval)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
