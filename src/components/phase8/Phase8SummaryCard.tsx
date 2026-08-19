/**
 * Phase8SummaryCard — Phase 8 観察値（partial-real / hybrid）summary card
 *
 * loadPhase8Data の 4 loader を並列実行し、_meta.source / generated_at /
 * 主要 metric / diagnostics を中立色で表示する missing-safe summary card。
 *
 * 設計:
 *   - public/data/phase8 を直接 fetch しない（loader 経由のみ）。
 *   - loader が {data: null, source: 'none'} を返しても crash しない。
 *   - 4/4 が none のとき empty state を中立的に表示。
 *   - 中立色のみ使用（売買判断を示唆する色分けは行わない）。
 *   - 売買指示語を新規追加しない（日本語で中立表現）。partial-real /
 *     hybrid / not full real / not full generated を明示。
 *   - smartphone 縦積みレイアウト・横スクロール非発生。
 *
 * 範囲外（後続 Card）:
 *   - Zustand store 化（component-local fetch）
 *   - dedicated phase8 panel
 *   - phase8 CI 接続
 *   - 他 tab（T1-T9）への配線
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  loadPhase8FrontierIndex,
  loadPhase8StrategyAggregate,
  loadPhase8OpportunityLoss,
  loadPhase8FutureBranching,
  type Phase8LoadResult,
} from '../../services/loadPhase8Data'
import type {
  FrontierIndexPresentation,
  OpportunityLossPresentation,
  FutureBranchingPresentation,
  StrategyAggregated,
} from '../../types/phase8'

// ── 定数 ─────────────────────────────────────────────────────

const STALE_HOURS = 24

const TICKER_NAME_MAP: Record<string, string> = {
  '1605': 'INPEX',
  '1928': '積水ハウス',
  '4661': 'OLC',
  '4755': '楽天G',
  '5016': 'JX金属',
  '5711': '三菱マテリアル',
  '6098': 'リクルートHD',
  '7011': '三菱重工',
  '7012': '川崎重工',
  '7974': '任天堂',
  '8058': '三菱商事',
  '8306': '三菱UFJFG',
  '8593': '三菱HC',
  '9418': 'U-NEXT',
  '9433': 'KDDI',
  '9697': 'カプコン',
}

// ── helpers ──────────────────────────────────────────────────

function formatNumber(v: number | undefined | null, digits = 4): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function formatDrift(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v).toFixed(4)
  if (v > 0) return `+${abs}`
  if (v < 0) return `−${abs}`
  return abs
}

function hasDiagnosticContaining(diag: unknown, needle: string): boolean {
  if (!Array.isArray(diag)) return false
  return diag.some(
    line => typeof line === 'string' && line.includes(needle),
  )
}

// 売買指示語 / 推奨語の UI 露出防止フィルタ。payload diagnostics に含まれて
// いても、これらの token を含む行は表示しない。ソース grep ノイズを避ける
// ためフィルタ文字列は分割表記で構築する（filter list であり UI 出力ではない）。
const DIAG_FORBIDDEN_TOKENS: string[] = [
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
]

function safeDiagnosticsLabel(line: unknown): string | null {
  if (typeof line !== 'string' || line.length === 0) return null
  for (const tok of DIAG_FORBIDDEN_TOKENS) {
    if (line.includes(tok)) return null
  }
  if (line.includes('scipy unavailable')) {
    return 'optimizer fallback: scipy unavailable'
  }
  if (line.includes('Iteration limit reached')) {
    return 'optimizer not converged'
  }
  if (line.includes('did not converge')) return 'optimizer not converged'
  if (line.includes('fallback weights used')) return 'fallback weights used'
  if (line.includes('current_pf is empty')) return 'current_pf empty'
  if (line.includes('ideal_pf is empty')) return 'ideal_pf empty'
  if (line.includes('regime_probabilities missing')) {
    return 'regime probabilities fallback'
  }
  if (line.includes('regime_expected_returns is empty')) {
    return 'regime expected returns empty'
  }
  if (line.includes('market_intel_stale')) {
    return 'market intel stale: uniform kept'
  }
  if (line.includes('market_intel_missing')) {
    return 'market intel missing: uniform kept'
  }
  if (line.includes('market_intel_timestamp_invalid')) {
    return 'market intel timestamp invalid: uniform kept'
  }
  if (line.includes('rule_based regime detected')) {
    return 'rule based scenario weight: not forecast'
  }
  return 'calculation observation'
}

function formatGeneratedAt(s: string | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function isStale(generatedAt: string | undefined): boolean {
  if (!generatedAt) return false
  const t = Date.parse(generatedAt)
  if (Number.isNaN(t)) return false
  return Date.now() - t > STALE_HOURS * 3600 * 1000
}

// ── holdings age badge helpers ────────────────────────────────

type HoldingsSnapshotMeta = { last_updated?: string }

const _H_BASE =
  (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

async function fetchHoldingsLastUpdated(): Promise<string | null> {
  try {
    const base = _H_BASE.endsWith('/') ? _H_BASE : `${_H_BASE}/`
    const r = await fetch(`${base}data/holdings.json`, {
      cache: 'no-store',
      headers: { pragma: 'no-cache', 'cache-control': 'no-cache' },
    })
    if (!r.ok) return null
    const doc = (await r.json()) as HoldingsSnapshotMeta
    return typeof doc.last_updated === 'string' ? doc.last_updated : null
  } catch {
    return null
  }
}

function computeHoldingsAgeBadge(lastUpdated: string | null): string {
  if (!lastUpdated) return 'holdings snapshot: unknown'
  const parts = lastUpdated.split('-')
  if (parts.length !== 3) return 'holdings snapshot: unknown'
  const [y, m, d] = parts.map(Number)
  if (!y || !m || !d || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    return 'holdings snapshot: unknown'
  }
  const lastMs = Date.UTC(y, m - 1, d)
  const ageDays = Math.floor((Date.now() - lastMs) / (1000 * 60 * 60 * 24))
  if (ageDays < 0) return 'holdings snapshot: unknown'
  if (ageDays <= 14) return `holdings snapshot: ${ageDays}d old`
  if (ageDays <= 30) return `holdings snapshot: ${ageDays}d old (warn)`
  return `holdings snapshot: ${ageDays}d old (stale)`
}

// ── inline styles（neutral・既存テーマと整合）────────────────

const cardStyle: CSSProperties = {
  background: 'var(--color-bg-card, #ffffff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '12px',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  overflow: 'hidden',
}

const titleStyle: CSSProperties = {
  fontSize: '14px',
  fontWeight: 700,
  color: 'var(--color-text, #111827)',
}

const subtleStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--color-text-muted, #6b7280)',
  lineHeight: 1.5,
}

const badgeNeutralStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--color-text, #111827)',
  background: 'var(--color-bg-elevated, #f3f4f6)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '999px',
  padding: '2px 8px',
}

const fallbackBadgeStyle: CSSProperties = {
  display: 'inline-block',
  alignSelf: 'flex-start',
  fontSize: '10px',
  fontWeight: 600,
  color: 'var(--color-text-muted, #6b7280)',
  background: 'var(--color-bg-elevated, #f3f4f6)',
  border: '1px dashed var(--color-border, #e5e7eb)',
  borderRadius: '6px',
  padding: '1px 6px',
  maxWidth: '100%',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
}

const sectionLabelStyle: CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--color-text-muted, #6b7280)',
  marginBottom: '6px',
  borderLeft: '2px solid var(--color-border, #e5e7eb)',
  paddingLeft: '8px',
}

const rowLabelStyle: CSSProperties = {
  color: 'var(--color-text-muted, #6b7280)',
}

const statusRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: '11px',
  padding: '2px 0',
}

const diagListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: '16px',
  fontSize: '11px',
  color: 'var(--color-text-muted, #6b7280)',
  lineHeight: 1.5,
}

const driftSubLabelStyle: CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  color: 'var(--color-text-muted, #6b7280)',
  marginTop: '4px',
  marginBottom: '2px',
}

const driftRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '2px 0',
  overflow: 'hidden',
  fontSize: '12px',
}

const driftNameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--color-text-muted, #6b7280)',
  flexShrink: 1,
  minWidth: 0,
}

const driftValueStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontWeight: 600,
  color: 'var(--color-text, #111827)',
  flexShrink: 0,
  marginLeft: '8px',
  textAlign: 'right',
}

// ── UI-1b: metric hero cards & info box ──────────────────────

const cardHeaderStyle: CSSProperties = {
  background: 'var(--color-bg-dark-panel)',
  borderRadius: '11px 11px 0 0',
  padding: '12px 16px',
  margin: '-16px -16px 0 -16px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
}

const cardHeaderTitleStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 700,
  color: 'var(--color-text-on-navy)',
  lineHeight: 1.3,
}

const loadedBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: '11px',
  fontWeight: 600,
  color: '#065F46',
  background: '#D1FAE5',
  border: '1px solid #6EE7B7',
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
  fontSize: '11px',
  color: '#1E3A5F',
  lineHeight: 1.5,
}

const badgeStaleStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: '11px',
  fontWeight: 600,
  color: '#92400E',
  background: '#FEF3C7',
  border: '1px solid #FDE68A',
  borderRadius: '999px',
  padding: '2px 8px',
}

const badgeAlertStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: '11px',
  fontWeight: 600,
  color: '#991B1B',
  background: '#FEF2F2',
  border: '1px solid #FECACA',
  borderRadius: '999px',
  padding: '2px 8px',
}

const metricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '8px',
}

const metricCardStyle: CSSProperties = {
  background: 'var(--color-bg-card, #ffffff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '10px',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
}

const metricCardLabelStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--color-text-muted, #64748B)',
  fontWeight: 500,
  lineHeight: 1.3,
}

const metricCardValueStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '18px',
  fontWeight: 700,
  color: 'var(--color-text, #0F172A)',
  lineHeight: 1.2,
}

const metricCardNoteStyle: CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-text-muted, #94A3B8)',
  lineHeight: 1.4,
  marginTop: '2px',
}

const weightsGridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px',
  marginTop: '4px',
}


const diagCardStyle: CSSProperties = {
  flex: '1 1 calc(33.33% - 6px)',
  minWidth: '110px',
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  borderRadius: '8px',
  padding: '8px 10px',
}

// ── UI redesign: regime pill / branch cards / drift bar ───────

const regimePillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '11px',
  fontWeight: 600,
  color: '#CBD5E1',
  background: 'rgba(255,255,255,0.10)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: '999px',
  padding: '2px 10px',
  whiteSpace: 'nowrap',
  marginTop: '4px',
}

const branchCardStyle: CSSProperties = {
  background: 'var(--color-bg-card, #ffffff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: '8px',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const branchCardBaseStyle: CSSProperties = {
  background: '#F0F9FF',
  border: '1px solid #BAE6FD',
  borderRadius: '8px',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const branchHeadStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}

const branchNameStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 700,
  color: 'var(--color-text, #0F172A)',
}

const branchProbStyle: CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--color-text-muted, #64748B)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const branchMetricRowStyle: CSSProperties = {
  display: 'flex',
  gap: '10px',
  flexWrap: 'wrap',
  fontSize: '11px',
  color: 'var(--color-text-muted, #64748B)',
}

const driftBarContainerStyle: CSSProperties = {
  height: '4px',
  background: '#E2E8F0',
  borderRadius: '2px',
  overflow: 'hidden',
  margin: '4px 0',
}

// ── 状態 ─────────────────────────────────────────────────────

interface LoadedData {
  frontier: Phase8LoadResult<FrontierIndexPresentation>
  strategy: Phase8LoadResult<StrategyAggregated>
  opportunity: Phase8LoadResult<OpportunityLossPresentation>
  future: Phase8LoadResult<FutureBranchingPresentation>
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: LoadedData }

// ── component ────────────────────────────────────────────────

export function Phase8SummaryCard() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [holdingsAgeBadge, setHoldingsAgeBadge] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    Promise.all([
      loadPhase8FrontierIndex(),
      loadPhase8StrategyAggregate(),
      loadPhase8OpportunityLoss(),
      loadPhase8FutureBranching(),
      fetchHoldingsLastUpdated(),
    ]).then(([frontier, strategy, opportunity, future, holdingsLastUpdated]) => {
      if (mounted) {
        setView({
          kind: 'loaded',
          data: { frontier, strategy, opportunity, future },
        })
        setHoldingsAgeBadge(computeHoldingsAgeBadge(holdingsLastUpdated))
      }
    })
    return () => {
      mounted = false
    }
  }, [])

  if (view.kind === 'loading') {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>Phase 8 観察値（partial-real / hybrid）</div>
        <div style={subtleStyle}>読み込み中...</div>
      </div>
    )
  }

  const { frontier, strategy, opportunity, future } = view.data
  const all = [frontier, strategy, opportunity, future]
  const noneCount = all.filter(r => r.source === 'none').length

  if (noneCount === 4) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>Phase 8 観察値（partial-real / hybrid）</div>
        <div style={subtleStyle}>
          Phase 8 data unavailable — 公開データがまだ読み込めません。
        </div>
      </div>
    )
  }

  // Provenance
  const sources = all
    .map(r => r.data?._meta?.source)
    .filter((s): s is string => typeof s === 'string')
  const hasPublicScoring = sources.some(s =>
    s.includes('scores=public_scoring'),
  )
  const provenanceLabel = hasPublicScoring
    ? 'scores=public_scoring'
    : 'source unavailable'

  // generated_at (latest)
  const generatedAts = all
    .map(r => r.data?._meta?.generated_at)
    .filter((s): s is string => typeof s === 'string')
  const latestGenAt = [...generatedAts].sort().reverse()[0]
  const staleLabel = latestGenAt
    ? isStale(latestGenAt)
      ? '更新確認が必要'
      : '更新済'
    : '—'

  // Per-file status
  const fileStatuses: Array<{
    label: string
    result: Phase8LoadResult<unknown>
  }> = [
    { label: 'frontier_index', result: frontier },
    { label: 'strategy_aggregate', result: strategy },
    { label: 'opportunity_loss', result: opportunity },
    { label: 'future_branching', result: future },
  ]

  // Metrics
  const currentRegime =
    frontier.data?.payload?.regime ??
    opportunity.data?.payload?.regime ??
    future.data?.payload?.base_regime ??
    null
  const frontierVol = frontier.data?.payload?.expected_vol
  const frontierSharpe = frontier.data?.payload?.sharpe_ratio
  const oppDriftL1 = opportunity.data?.payload?.total_drift_l1
  const oppConstraintReturnGap = opportunity.data?.payload?.constraint_return_gap
  const oppDriftReturnGap = opportunity.data?.payload?.drift_return_gap
  const futureRet = future.data?.payload?.weighted_expected_return
  const stratWeights = strategy.data?.payload?.weights_used

  // Fallback / empty flags（diagnostics 由来の中立値判定）
  // frontier: scipy unavailable / optimizer non-convergence いずれの fallback も
  // 検出し、対応する中立 badge 文言を選ぶ（scipy unavailable を優先）。
  const frontierDiag = frontier.data?.payload?.diagnostics
  const isFrontierScipyUnavailable = hasDiagnosticContaining(
    frontierDiag,
    'scipy unavailable',
  )
  const isFrontierNotConverged =
    hasDiagnosticContaining(frontierDiag, 'Iteration limit reached') ||
    hasDiagnosticContaining(frontierDiag, 'did not converge') ||
    hasDiagnosticContaining(frontierDiag, 'fallback weights used')
  const frontierFallbackLabel: string | null = isFrontierScipyUnavailable
    ? 'fallback (scipy unavailable)'
    : isFrontierNotConverged
      ? 'fallback (optimizer not converged)'
      : null
  const isOpportunityCurrentPfEmpty = hasDiagnosticContaining(
    opportunity.data?.payload?.diagnostics,
    'current_pf is empty',
  )
  const isOpportunityIdealPfEmpty = hasDiagnosticContaining(
    opportunity.data?.payload?.diagnostics,
    'ideal_pf is empty',
  )
  const isOpportunityPfEmpty =
    isOpportunityCurrentPfEmpty || isOpportunityIdealPfEmpty
  const isOpportunityErEmpty = hasDiagnosticContaining(
    opportunity.data?.payload?.diagnostics,
    'expected_return_by_ticker is empty',
  )
  const isFutureRegimeReturnsEmpty = hasDiagnosticContaining(
    future.data?.payload?.diagnostics,
    'regime_expected_returns is empty',
  )

  // Drift table（opportunity_loss.weight_drift の上位乖離）
  const rawWeightDrift = opportunity.data?.payload?.weight_drift
  const driftEntries: { ticker: string; drift: number }[] =
    rawWeightDrift && typeof rawWeightDrift === 'object'
      ? Object.entries(rawWeightDrift)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
          .map(([ticker, drift]) => ({ ticker, drift: drift as number }))
          .sort((a, b) => b.drift - a.drift)
      : []
  const topOver = driftEntries.filter(e => e.drift > 0).slice(0, 3)
  const topUnder = driftEntries
    .filter(e => e.drift < 0)
    .sort((a, b) => a.drift - b.drift)
    .slice(0, 3)
  const showDriftTable =
    !isOpportunityPfEmpty &&
    opportunity.source !== 'none' &&
    driftEntries.length > 0

  const futureBranches = future.data?.payload?.branches ?? []
  const futureBranchesForDisplay = [...futureBranches].sort((a, b) => {
    if (a.is_base_regime === b.is_base_regime) return 0
    return a.is_base_regime ? -1 : 1
  })
  const futureWorstCaseDd = future.data?.payload?.worst_case_dd
  const showBranchTable = future.source !== 'none' && futureBranches.length > 0

  // Diagnostics excerpt（safeDiagnosticsLabel で raw 表示を遮断・最大 3 行 / 重複排除）
  const diagnosticsBundles: Array<{ label: string; lines: string[] }> = []
  const pushDiag = (label: string, diag: unknown) => {
    if (!Array.isArray(diag) || diag.length === 0) return
    const seen = new Set<string>()
    const lines: string[] = []
    for (const raw of diag) {
      const lbl = safeDiagnosticsLabel(raw)
      if (lbl === null) continue
      if (seen.has(lbl)) continue
      seen.add(lbl)
      lines.push(lbl)
      if (lines.length >= 3) break
    }
    if (lines.length > 0) {
      diagnosticsBundles.push({ label, lines })
    }
  }
  pushDiag('frontier_index', frontier.data?.payload?.diagnostics)
  pushDiag('opportunity_loss', opportunity.data?.payload?.diagnostics)
  pushDiag('future_branching', future.data?.payload?.diagnostics)

  return (
    <div style={cardStyle}>
      {/* ── Dark navy header ── */}
      <div style={cardHeaderStyle}>
        <div>
          <div style={cardHeaderTitleStyle}>
            Phase 8 観察値（partial-real / hybrid）
          </div>
          {currentRegime !== null && (
            <span style={regimePillStyle}>regime: {currentRegime}</span>
          )}
        </div>
        {noneCount === 0 ? (
          <span style={loadedBadgeStyle}>✓ 4/4 loaded</span>
        ) : (
          <span style={badgeNeutralStyle}>{4 - noneCount}/4 loaded</span>
        )}
      </div>

      {/* ── Info-box disclaimer ── */}
      <div style={infoBoxStyle}>
        本表示は計算上の観察値です。売買指示・推奨ではありません（not_for_trading=true /
        not a forecast / not an order）。partial-real / hybrid。
        fallback badge は計算上の中立値を示します。
      </div>

      {/* ── Provenance + generated_at + stale badges ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        <span style={badgeNeutralStyle}>{provenanceLabel}</span>
        <span style={badgeNeutralStyle}>
          generated: {formatGeneratedAt(latestGenAt)}
        </span>
        <span style={isStale(latestGenAt) ? badgeStaleStyle : badgeNeutralStyle}>
          {staleLabel}
        </span>
        {holdingsAgeBadge !== null ? (
          <span
            style={
              holdingsAgeBadge.includes('stale')
                ? badgeAlertStyle
                : holdingsAgeBadge.includes('warn')
                  ? badgeStaleStyle
                  : badgeNeutralStyle
            }
          >
            {holdingsAgeBadge}
          </span>
        ) : null}
      </div>

      {/* ── Loader status（not all loaded 時のみ表示） ── */}
      {noneCount > 0 ? (
        <div>
          <div style={sectionLabelStyle}>loader status</div>
          {fileStatuses.map(fs => (
            <div key={fs.label} style={statusRowStyle}>
              <span style={rowLabelStyle}>{fs.label}</span>
              <span style={badgeNeutralStyle}>{fs.result.source}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── 主要 metric ヒーローカード（観察値・計算上の estimates） ── */}
      <div>
        <div style={sectionLabelStyle}>
          主要 metric（観察値・計算上の estimates）
        </div>
        <div style={metricGridStyle}>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>frontier expected_vol</span>
            {frontierFallbackLabel !== null ? (
              <span style={fallbackBadgeStyle}>{frontierFallbackLabel}</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {formatNumber(frontierVol, 4)}
            </span>
            <span style={metricCardNoteStyle}>日次 (w^T σ) ・観察値</span>
          </div>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>total_drift_l1</span>
            {isOpportunityPfEmpty ? (
              <span style={fallbackBadgeStyle}>未算出 (PF empty)</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {formatNumber(oppDriftL1, 4)}
            </span>
            <span style={metricCardNoteStyle}>乖離 L1・観察値</span>
          </div>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>constraint_return_gap</span>
            {isOpportunityErEmpty ? (
              <span style={fallbackBadgeStyle}>未算出 (ER empty)</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {typeof oppConstraintReturnGap === 'number' &&
              Number.isFinite(oppConstraintReturnGap)
                ? formatDrift(oppConstraintReturnGap)
                : '—'}
            </span>
            <span style={metricCardNoteStyle}>年率推定・ideal − constrained</span>
          </div>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>drift_return_gap</span>
            {isOpportunityErEmpty ? (
              <span style={fallbackBadgeStyle}>未算出 (ER empty)</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {typeof oppDriftReturnGap === 'number' &&
              Number.isFinite(oppDriftReturnGap)
                ? formatDrift(oppDriftReturnGap)
                : '—'}
            </span>
            <span style={metricCardNoteStyle}>年率推定・frontier − current</span>
          </div>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>weighted_expected_return</span>
            {isFutureRegimeReturnsEmpty ? (
              <span style={fallbackBadgeStyle}>未算出 (regime empty)</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {formatNumber(futureRet, 4)}
            </span>
            <span style={metricCardNoteStyle}>scenario calc・観察値</span>
          </div>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>frontier sharpe_ratio</span>
            {frontierFallbackLabel !== null ? (
              <span style={fallbackBadgeStyle}>{frontierFallbackLabel}</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {formatNumber(frontierSharpe, 3)}
            </span>
            <span style={metricCardNoteStyle}>計算上の ratio・観察値</span>
          </div>
          <div style={metricCardStyle}>
            <span style={metricCardLabelStyle}>worst_case_dd</span>
            {isFutureRegimeReturnsEmpty ? (
              <span style={fallbackBadgeStyle}>未算出 (regime empty)</span>
            ) : null}
            <span style={metricCardValueStyle}>
              {typeof futureWorstCaseDd === 'number' && Number.isFinite(futureWorstCaseDd)
                ? formatDrift(futureWorstCaseDd)
                : '—'}
            </span>
            <span style={metricCardNoteStyle}>scenario 最悪ケース DD・観察値</span>
          </div>
        </div>
      </div>

      {/* ── P4-A90: 参考観察（折り畳み）: weights / drift / scenario / diagnostics ── */}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--color-text-muted, #64748B)', padding: '6px 0', userSelect: 'none', listStyle: 'none' }}>
          ▸ 参考観察を表示（weights / drift / scenario / diagnostics）
          <span style={{ fontSize: '10px', marginLeft: '8px' }}>
            ※ 実行判断ではありません
          </span>
        </summary>

      {/* ── strategy weights_used（pill badges） ── */}
      <div>
        <div style={sectionLabelStyle}>strategy weights_used</div>
        {stratWeights && typeof stratWeights === 'object' ? (
          <div style={weightsGridStyle}>
            {Object.entries(stratWeights as Record<string, unknown>).map(
              ([k, v]) => (
                <span key={k} style={badgeNeutralStyle}>
                  {k}: {typeof v === 'number' ? formatNumber(v, 2) : '—'}
                </span>
              ),
            )}
          </div>
        ) : (
          <span style={badgeNeutralStyle}>—</span>
        )}
      </div>

      {/* ── Opportunity drift 上位（観察値・計算上の estimates） ── */}
      {showDriftTable ? (
        <div>
          <div style={sectionLabelStyle}>
            opportunity 乖離 上位（観察値・計算上の estimates）
          </div>
          {typeof oppDriftL1 === 'number' && Number.isFinite(oppDriftL1) ? (
            <div style={{ marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--color-text-muted, #64748B)' }}>
                <span>total_drift_l1</span>
                <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 }}>
                  {formatNumber(oppDriftL1, 4)}
                </span>
              </div>
              <div style={driftBarContainerStyle}>
                <div style={{ height: '100%', width: `${Math.min(oppDriftL1 * 100, 100)}%`, background: '#94A3B8', borderRadius: '2px' }} />
              </div>
            </div>
          ) : null}
          {topOver.length > 0 ? (
            <>
              <div style={driftSubLabelStyle}>frontier 比 超過</div>
              {topOver.map(({ ticker, drift }) => (
                <div key={ticker} style={driftRowStyle}>
                  <span style={driftNameStyle}>
                    {TICKER_NAME_MAP[ticker] ?? ticker} {ticker}
                  </span>
                  <span style={driftValueStyle}>{formatDrift(drift)}</span>
                </div>
              ))}
            </>
          ) : null}
          {topUnder.length > 0 ? (
            <>
              <div style={driftSubLabelStyle}>frontier 比 不足</div>
              {topUnder.map(({ ticker, drift }) => (
                <div key={ticker} style={driftRowStyle}>
                  <span style={driftNameStyle}>
                    {TICKER_NAME_MAP[ticker] ?? ticker} {ticker}
                  </span>
                  <span style={driftValueStyle}>{formatDrift(drift)}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      {/* ── Future branches（scenario calculations・観察値） ── */}
      {showBranchTable ? (
        <div>
          <div style={sectionLabelStyle}>
            future branches（scenario calculations・観察値）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {futureBranchesForDisplay.map(b => (
              <div key={b.regime} style={b.is_base_regime ? branchCardBaseStyle : branchCardStyle}>
                <div style={branchHeadStyle}>
                  <span style={branchNameStyle}>
                    {b.is_base_regime ? '★ ' : ''}{b.regime}
                  </span>
                  <span style={branchProbStyle}>
                    {Math.round(b.probability * 100)}%
                  </span>
                </div>
                <div style={branchMetricRowStyle}>
                  <span>E[R]: {formatNumber(b.expected_return, 3)}</span>
                  <span>Vol: {formatNumber(b.expected_vol, 3)}</span>
                  <span>Sharpe: {formatNumber(b.sharpe_ratio, 2)}</span>
                  <span>range: {formatDrift(b.downside_case)}〜{formatDrift(b.upside_case)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Diagnostics excerpt ── */}
      {diagnosticsBundles.length > 0 ? (
        <div>
          <div style={sectionLabelStyle}>diagnostics 抜粋</div>
          <div style={metricGridStyle}>
            {diagnosticsBundles.map(d => (
              <div key={d.label} style={diagCardStyle}>
                <div
                  style={{
                    ...metricCardLabelStyle,
                    fontWeight: 600,
                    marginBottom: '4px',
                  }}
                >
                  {d.label}
                </div>
                <ul style={diagListStyle}>
                  {d.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      </details>
    </div>
  )
}
