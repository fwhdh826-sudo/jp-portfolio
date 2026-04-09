import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

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
  const system = useAppStore(s => s.system)

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

  return (
    <div className="tab-panel">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: 12 }}>
        操作履歴 — ローカル保持
      </div>

      {events.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', paddingTop: 32, paddingBottom: 32 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📝</div>
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
