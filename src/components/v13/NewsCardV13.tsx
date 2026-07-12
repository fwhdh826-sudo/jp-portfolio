/**
 * NewsCardV13 — Card 4-10
 * v13.3 MarketNewsItemV13 に対応したニュースカード。
 * importance_score バー / sentiment バッジ / source_id / related_tickers を表示。
 * 既存 news-card CSS クラスを再利用してスタイルを統一する。
 */
import { formatRelativeTime } from '../../utils/format'
import type { MarketNewsItemV13 } from '../../types/news'

const SOURCE_DISPLAY: Record<string, string> = {
  bloomberg:       'Bloomberg',
  reuters:         'Reuters',
  yahoo_finance_jp:'Yahoo!ファイナンス',
  minkabu:         'Minkabu',
  shikiho_online:  '会社四季報',
  tdnet:           'TDnet',
  edinet:          'EDINET',
  jpx:             'JPX',
}

const CATEGORY_LABEL: Record<string, string> = {
  macro:             'マクロ',
  international:     '海外',
  japan:             '国内',
  markets:           '市場',
  earnings:          '決算',
  disclosure:        '開示',
  regulatory:        '規制',
  individual_stocks: '個別株',
  market_structure:  '市場構造',
}

function importanceLabel(score: number): { text: string; cls: string } {
  if (score >= 75) return { text: '高', cls: 'high' }
  if (score >= 45) return { text: '中', cls: 'medium' }
  return { text: '低', cls: 'low' }
}

function sentimentCls(score: number): string {
  if (score > 0.1) return 'positive'
  if (score < -0.1) return 'negative'
  return 'neutral'
}

function sentimentLabel(score: number): string {
  if (score > 0.1) return 'ポジティブ'
  if (score < -0.1) return 'ネガティブ'
  return '中立'
}

function cardBorderCls(sentScore: number): string {
  if (sentScore > 0.1) return 'news-card--positive'
  if (sentScore < -0.1) return 'news-card--negative'
  return 'news-card--neutral'
}

interface Props {
  item: MarketNewsItemV13
}

export function NewsCardV13({ item }: Props) {
  const impInfo   = importanceLabel(item.importance_score)
  const sentClsV  = sentimentCls(item.sentiment_score)
  const borderCls = cardBorderCls(item.sentiment_score)
  const srcLabel  = SOURCE_DISPLAY[item.source_id] ?? item.source_id

  // positive/negative の左 border を buy/sell 色変数から観察系中立色へ上書き
  const cardBorderStyle: React.CSSProperties =
    item.sentiment_score > 0.1  ? { borderLeft: '4px solid #38bdf8' } :  // sky-400
    item.sentiment_score < -0.1 ? { borderLeft: '4px solid #f59e0b' } :  // amber-500
    {}

  const displayCategories = item.category.slice(0, 3)

  return (
    <div className={`news-card ${borderCls}`} style={cardBorderStyle}>
      {/* タイトル + センチメントバッジ */}
      <div className="news-card__header">
        <div className="news-card__title">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
          ) : item.title}
        </div>
        <div className="news-card__chips">
          <span className={`news-v13-sentiment news-v13-sentiment--${sentClsV}`}>
            {sentimentLabel(item.sentiment_score)}
          </span>
        </div>
      </div>

      {/* メタ情報 */}
      <div className="news-card__meta">
        <span>{srcLabel}</span>
        <span style={{ background: '#f1f5f9', color: '#64748b', fontSize: 10, padding: '1px 5px', borderRadius: 4, fontWeight: 600 }}>
          {item.language === 'ja' ? 'JA' : 'EN'}
        </span>
        <span>{formatRelativeTime(item.published_at)}</span>
        {/* 重要度バー */}
        <span className="news-v13-importance">
          重要度
          <span className="news-v13-importance__bar">
            <span
              className="news-v13-importance__fill"
              style={{ width: `${Math.round(item.importance_score)}%` }}
            />
          </span>
          <span>{impInfo.text}</span>
        </span>
        {/* 関連銘柄 */}
        {item.related_tickers.length > 0 && (
          <span className="news-v13-tickers">
            {item.related_tickers.slice(0, 4).map(t => (
              <span key={t} className="news-v13-ticker">{t}</span>
            ))}
          </span>
        )}
      </div>

      {/* category chips（最大3件） */}
      {displayCategories.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
          {displayCategories.map(cat => (
            <span
              key={cat}
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '2px 7px',
                borderRadius: 10,
                background: '#f1f5f9',
                color: '#475569',
                border: '1px solid #e2e8f0',
                whiteSpace: 'nowrap',
              }}
            >
              {CATEGORY_LABEL[cat] ?? cat}
            </span>
          ))}
        </div>
      )}

      {/* 要約（3行clip） */}
      {item.summary && (
        <div
          className="news-card__summary"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {item.summary}
        </div>
      )}
    </div>
  )
}
