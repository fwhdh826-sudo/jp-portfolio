/**
 * EarningsCalendarCard — Card 4-10
 * earnings_calendar.json の実データ形式（items[]）を読み込み、
 * 今週の決算予定をテーブル表示する自己フェッチコンポーネント。
 * スマホでは横スクロール対応。
 */
import { useState, useEffect } from 'react'
import type { EarningsEventUI } from '../../types/market_intel'

const SESSION_LABEL: Record<string, string> = {
  before_open: '寄前',
  after_close: '大引後',
}

const IMPORTANCE_CLS: Record<string, string> = {
  high:   'macro-signal-badge--positive',
  medium: 'macro-signal-badge--neutral',
  low:    '',
}

interface RawEarningsData {
  items?: EarningsEventUI[]
  this_week?: EarningsEventUI[]
}

export function EarningsCalendarCard() {
  const [events, setEvents] = useState<EarningsEventUI[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
        const url = `${base.endsWith('/') ? base : base + '/'}data/earnings_calendar.json`
        const r = await fetch(url, { cache: 'no-store' })
        if (r.ok) {
          const data = await r.json() as RawEarningsData
          // 実ファイルは items[] 形式、news.ts 型は this_week[] — 両方サポート
          setEvents(data.items ?? data.this_week ?? [])
        }
      } catch { /* silent: fixture is optional */ }
    })()
  }, [])

  if (events.length === 0) return null

  return (
    <article className="card" style={{ marginTop: 12 }}>
      <div className="section-kicker" style={{ marginBottom: 10 }}>
        決算カレンダー（登録済み）
      </div>
      <div className="earnings-table-wrap">
        <table className="earnings-table">
          <thead>
            <tr>
              <th>銘柄</th>
              <th>会社名</th>
              <th>予定日</th>
              <th>発表</th>
              <th>重要度</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, idx) => {
              const impCls = IMPORTANCE_CLS[ev.importance] ?? ''
              return (
                <tr key={`${ev.code}-${ev.date}-${idx}`}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{ev.code}</td>
                  <td>{ev.name}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{ev.date}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {SESSION_LABEL[ev.session] ?? ev.session}
                  </td>
                  <td>
                    {impCls ? (
                      <span className={`macro-signal-badge ${impCls}`}>
                        {ev.importance}
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                        {ev.importance}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </article>
  )
}
