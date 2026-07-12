/**
 * SourceStatusRow — Card 4-10
 * 8ニュースソースの稼働状況をドット+ラベルで横並び表示。
 * スマホでは flex-wrap で折り返す。
 */
import type { MarketIntelSourceStatus } from '../../types/market_intel'

const SOURCE_LABELS: Record<string, string> = {
  bloomberg:       'Bloomberg',
  reuters:         'Reuters',
  yahoo_finance_jp:'Yahoo!',
  minkabu:         'Minkabu',
  shikiho_online:  '四季報',
  tdnet:           'TDnet',
  edinet:          'EDINET',
  jpx:             'JPX',
}

const STATUS_LABEL: Record<MarketIntelSourceStatus, string> = {
  ok:           'OK',
  error:        'ERR',
  rate_limited: '制限',
  timeout:      'T/O',
}

interface Props {
  sourcesStatus: Record<string, MarketIntelSourceStatus>
}

export function SourceStatusRow({ sourcesStatus }: Props) {
  const entries = Object.entries(sourcesStatus)
  if (entries.length === 0) return null

  return (
    <div className="source-status-row" role="list" aria-label="ニュースソース稼働状況">
      {entries.map(([id, status]) => (
        <span key={id} className="source-status-item" role="listitem">
          <span
            className={`source-status-dot source-status-dot--${status}`}
            aria-hidden="true"
          />
          <span>{SOURCE_LABELS[id] ?? id}</span>
          <span style={{ opacity: 0.6 }}>{STATUS_LABEL[status]}</span>
        </span>
      ))}
    </div>
  )
}
