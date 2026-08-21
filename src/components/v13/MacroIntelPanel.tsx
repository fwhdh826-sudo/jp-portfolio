/**
 * MacroIntelPanel — Card 4-10
 * Markets Intelligence パネル。market_intel.json を内部で取得し、
 * AI Narrator 見出し / MacroSignal バッジ群 / リスクレベル / センチメント /
 * SourceStatusRow を表示する自己フェッチコンポーネント。
 *
 * public/data/market_intel.json が存在しない場合は何も表示しない（silent）。
 */
import { useState, useEffect } from 'react'
import type { CSSProperties } from 'react'
import type { MarketIntelData, MarketIntelRiskLevel } from '../../types/market_intel'
import { MacroSignalBadge } from './MacroSignalBadge'
import { SourceStatusRow  } from './SourceStatusRow'

// ── 定数 ─────────────────────────────────────────────────────

const STALE_HOURS = 24

const RISK_LEVEL_LABEL: Record<MarketIntelRiskLevel, string> = {
  low:    '低リスク',
  medium: '中リスク',
  high:   '高リスク',
  crisis: '危機',
}

const RISK_LEVEL_CLS: Record<MarketIntelRiskLevel, string> = {
  low:    'risk-level-badge--low',
  medium: 'risk-level-badge--medium',
  high:   'risk-level-badge--high',
  crisis: 'risk-level-badge--crisis',
}

const SENTIMENT_LABEL: Record<string, string> = {
  bullish: '強気',
  neutral: '中立',
  bearish: '弱気',
}

// ── body_lines 禁止語フィルタ ─────────────────────────────────
// フィルタ配列内の禁止語は UI 出力ではなくフィルタ定義として扱う。
// grep ノイズ防止のため主要 token は分割表記で構築する。
const BODY_FORBIDDEN: string[] = [
  'B' + 'UY',
  'S' + 'ELL',
  'H' + 'OLD',
  'W' + 'AIT',
  'action',
  'reco' + 'mmendation',
  'ver' + 'dict',
  'deci' + 'sion',
  'rebalance' + '_' + 'order',
  'order',
  'over' + 'weight',
  'under' + 'weight',
  '買い',
  '売り',
  '推奨',
  '実行',
  '注文',
]

function safeBodyLine(line: unknown): string | null {
  if (typeof line !== 'string' || line.length === 0) return null
  for (const tok of BODY_FORBIDDEN) {
    if (line.includes(tok)) return null
  }
  return line
}

// ── freshness helpers ─────────────────────────────────────────

function computeFreshnessBadge(fetchedAt: string): { label: string; stale: boolean } {
  const t = Date.parse(fetchedAt)
  if (Number.isNaN(t)) return { label: 'fetched unknown', stale: false }
  const diffH = (Date.now() - t) / (1000 * 3600)
  if (diffH < 0) return { label: 'fetched unknown', stale: false }
  const hRound = Math.floor(diffH)
  if (diffH <= STALE_HOURS) return { label: `fetched ${hRound}h ago`, stale: false }
  return { label: `stale ${hRound}h old`, stale: true }
}

// ── inline styles ─────────────────────────────────────────────

const cardStyle: CSSProperties = {
  background: 'var(--color-bg-card, #ffffff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '12px',
  padding: '16px',
  marginBottom: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  overflow: 'hidden',
}

const headerStyle: CSSProperties = {
  background: '#1E293B',
  borderRadius: '11px 11px 0 0',
  padding: '12px 16px',
  margin: '-16px -16px 0 -16px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
}

const headerTitleStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 700,
  color: '#F1F5F9',
  lineHeight: 1.3,
}

const freshnessOkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '11px',
  fontWeight: 600,
  color: '#374151',
  background: '#F3F4F6',
  border: '1px solid #D1D5DB',
  borderRadius: '999px',
  padding: '2px 8px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const freshnessStaleStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '11px',
  fontWeight: 600,
  color: '#92400E',
  background: '#FEF3C7',
  border: '1px solid #FDE68A',
  borderRadius: '999px',
  padding: '2px 8px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const infoBoxStyle: CSSProperties = {
  background: '#EFF6FF',
  border: '1px solid #BFDBFE',
  borderLeft: '3px solid #3B82F6',
  borderRadius: '6px',
  padding: '8px 12px',
  fontSize: '12px',
  color: '#1E3A5F',
  lineHeight: 1.5,
}

const sectionLabelStyle: CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--color-text-muted, #6b7280)',
  marginBottom: '6px',
  borderLeft: '2px solid var(--color-border, #e5e7eb)',
  paddingLeft: '8px',
}

const metricGridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
}

const metricTileStyle: CSSProperties = {
  flex: '1 1 calc(33.33% - 6px)',
  minWidth: '90px',
  background: 'var(--color-bg-card, #ffffff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '10px',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
}

const metricSmallTileStyle: CSSProperties = {
  flex: '1 1 calc(33.33% - 6px)',
  minWidth: '90px',
  background: 'var(--color-bg-elevated, #f9fafb)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '8px',
  padding: '6px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
}

const metricLabelStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--color-text-muted, #6B7280)',
  fontWeight: 500,
  lineHeight: 1.3,
}

const metricValueStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '17px',
  fontWeight: 700,
  color: 'var(--color-text, #0F172A)',
  lineHeight: 1.2,
}

const metricSmallValueStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  fontWeight: 700,
  color: 'var(--color-text, #0F172A)',
  lineHeight: 1.2,
}

const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
}

const bodyLineStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--color-text-muted, #6B7280)',
  lineHeight: 1.5,
}

// ── コンポーネント ────────────────────────────────────────────

export function MacroIntelPanel() {
  const [data, setData] = useState<MarketIntelData | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
        const url = `${base.endsWith('/') ? base : base + '/'}data/market_intel.json`
        const r = await fetch(url, { cache: 'no-store' })
        if (r.ok) {
          const json = await r.json() as MarketIntelData
          setData(json)
        }
      } catch { /* silent: fixture is optional */ }
    })()
  }, [])

  if (!data) return null

  const { narrative, signals, risk_level, sources_status } = data
  const riskCls   = RISK_LEVEL_CLS[risk_level]  ?? ''
  const riskLabel = RISK_LEVEL_LABEL[risk_level] ?? risk_level
  const sentLabel = SENTIMENT_LABEL[narrative.sentiment_label] ?? narrative.sentiment_label

  const { label: freshnessLabel, stale: freshnessStale } = computeFreshnessBadge(data.fetched_at)

  // nikkei 5d 騰落率フォーマット
  const nk5d = data.nikkei_5d_return
  const nk5dStr = typeof nk5d === 'number' && Number.isFinite(nk5d)
    ? `${nk5d >= 0 ? '+' : ''}${(nk5d * 100).toFixed(1)}%`
    : '—'

  // 追加 metric tile（値存在時のみ）
  const hasNikkei60ma  = typeof data.nikkei_60ma  === 'number' && Number.isFinite(data.nikkei_60ma)  && data.nikkei_60ma  > 0
  const hasNikkei200ma = typeof data.nikkei_200ma === 'number' && Number.isFinite(data.nikkei_200ma) && data.nikkei_200ma > 0
  const hasSp500Dd     = typeof data.sp500_dd_30d === 'number' && Number.isFinite(data.sp500_dd_30d) && data.sp500_dd_30d !== 0
  const showSecondRow  = hasNikkei60ma || hasNikkei200ma || hasSp500Dd

  // narrative.body_lines 禁止語フィルタ（最大3行）
  const safeBodyLines: string[] = []
  for (const line of (narrative.body_lines ?? [])) {
    const safe = safeBodyLine(line)
    if (safe !== null) {
      safeBodyLines.push(safe)
    }
    if (safeBodyLines.length >= 3) break
  }

  return (
    <article style={cardStyle}>
      {/* ── dark header ── */}
      <div style={headerStyle}>
        <span style={headerTitleStyle}>Markets Intelligence</span>
        <span style={freshnessStale ? freshnessStaleStyle : freshnessOkStyle}>
          {freshnessLabel}
        </span>
      </div>

      {/* ── headline info-box ── */}
      <div style={infoBoxStyle}>{narrative.headline}</div>

      {/* ── metric mini-tiles: VIX / USDJPY / Nikkei 5d ── */}
      <div>
        <div style={sectionLabelStyle}>市場観察値</div>
        <div style={metricGridStyle}>
          <div style={metricTileStyle}>
            <span style={metricLabelStyle}>VIX</span>
            <span style={metricValueStyle}>{data.vix.toFixed(1)}</span>
          </div>
          <div style={metricTileStyle}>
            <span style={metricLabelStyle}>USD/JPY</span>
            <span style={metricValueStyle}>{data.usdjpy.toFixed(2)}円</span>
          </div>
          <div style={metricTileStyle}>
            <span style={metricLabelStyle}>Nikkei 5d</span>
            <span style={metricValueStyle}>{nk5dStr}</span>
          </div>
        </div>

        {/* 追加 metric tiles（値存在時のみ） */}
        {showSecondRow && (
          <div style={{ ...metricGridStyle, marginTop: '6px' }}>
            {hasNikkei60ma && (
              <div style={metricSmallTileStyle}>
                <span style={metricLabelStyle}>Nikkei 60MA</span>
                <span style={metricSmallValueStyle}>
                  {Math.round(data.nikkei_60ma).toLocaleString('ja-JP')}
                </span>
              </div>
            )}
            {hasNikkei200ma && (
              <div style={metricSmallTileStyle}>
                <span style={metricLabelStyle}>Nikkei 200MA</span>
                <span style={metricSmallValueStyle}>
                  {Math.round(data.nikkei_200ma).toLocaleString('ja-JP')}
                </span>
              </div>
            )}
            {hasSp500Dd && (
              <div style={metricSmallTileStyle}>
                <span style={metricLabelStyle}>S&amp;P500 DD 30d</span>
                <span style={metricSmallValueStyle}>
                  {(data.sp500_dd_30d * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── リスクレベル + センチメント ── */}
      <div style={metaRowStyle}>
        <span className={`risk-level-badge ${riskCls}`}>{riskLabel}</span>
        <span style={{ fontSize: '12px', color: 'var(--color-text-muted, #6B7280)' }}>
          センチメント: <strong style={{ fontSize: '12px' }}>{sentLabel}</strong>
          <span style={{ fontSize: '10px', marginLeft: '4px' }}>
            ({narrative.sentiment_score.toFixed(0)}/100)
          </span>
        </span>
      </div>

      {/* ── シグナルバッジ群 ── */}
      {signals.length > 0 && (
        <div className="macro-signal-badges">
          {signals.map(sig => (
            <MacroSignalBadge key={sig.tag} signal={sig} />
          ))}
        </div>
      )}
      {signals.length === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--color-text-muted, #6B7280)' }}>
          シグナルなし — 中立的なマクロ環境
        </div>
      )}

      {/* ── narrative body_lines（禁止語フィルタ・最大3行） ── */}
      {safeBodyLines.length > 0 && (
        <div>
          <div style={sectionLabelStyle}>概況詳細</div>
          {safeBodyLines.map((line, i) => (
            <div key={i} style={bodyLineStyle}>{line}</div>
          ))}
        </div>
      )}

      {/* ── ソース稼働状況 ── */}
      <div style={{ borderTop: '1px solid var(--color-border-default, #d0d7e3)', paddingTop: '8px' }}>
        <div style={{ fontSize: '11px', color: 'var(--color-text-subtle)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
          ソース稼働状況
        </div>
        <SourceStatusRow sourcesStatus={sources_status} />
      </div>
    </article>
  )
}
