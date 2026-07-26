import { useId } from 'react'
import type {
  CandidateFunnelCandidate,
  CandidateFunnelTier,
} from '../../types/candidateFunnel'

const CANDIDATE_TIER_LABELS: Record<CandidateFunnelTier, string> = {
  excluded: '対象外',
  eligible: '評価対象',
  screened: '一次選別',
  deep_review: '詳細精査',
  actionable: '重点候補',
}

const CANDIDATE_RISK_REASON_LABELS: Record<string, string> = {
  SOFT_ELEVATED_VOLATILITY: '値動きが大きい可能性',
  SOFT_WEAK_MOMENTUM: '直近の勢いが弱い可能性',
  SOFT_DEEP_DRAWDOWN: '下落幅が大きい可能性',
  SOFT_WEAK_TREND: '価格トレンドが弱い可能性',
  SOFT_SECTOR_CROWDING: '同業種への集中を確認',
  SOFT_THEME_CROWDING: '同一テーマへの集中を確認',
  SOFT_LOW_DATA_CONFIDENCE: '利用可能な評価データが限定的',
  SOFT_STALE_SOURCE: '参照データが古い可能性',
  SOFT_PORTFOLIO_OVERLAP: '他の評価対象との重複確認が必要',
  SOFT_FALLBACK_PROVENANCE: '代替データ経路による評価',
  SOFT_PRESCREEN_METADATA_MISSING: '一次選別情報の一部が未取得',
  SOFT_VOLATILITY_RED_FLAG: '値動きの大きさに注意',
  SOFT_VOLATILITY_UNAVAILABLE: '値動きデータを確認できません',
}

const SELECTED_REASON_LABELS: Record<string, string> = {
  SELECTED_DEEP_REVIEW: '詳細精査の対象',
  SELECTED_ACTIONABLE: '次段階の検討対象',
}

export function formatCandidateTier(tier: CandidateFunnelTier): string {
  return CANDIDATE_TIER_LABELS[tier]
}

export function formatCandidateMetric(value: number | null): string {
  return value === null ? '—' : String(value)
}

export function formatCandidateDataConfidence(value: number | null): string {
  if (value === null) return '—'
  return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(value * 100)}%`
}

export function formatCandidateRiskReason(reason: string): string {
  return CANDIDATE_RISK_REASON_LABELS[reason] ?? 'その他のリスク要因'
}

export function formatCandidateTheme(
  themeStatus: CandidateFunnelCandidate['themeStatus'],
  themes: string[],
): string {
  if (themeStatus === 'unavailable') return 'テーマ評価未接続'
  return themes.length > 0 ? themes.join('・') : 'テーマ情報なし'
}

function formatSelectedReason(reason: string): string {
  return SELECTED_REASON_LABELS[reason] ?? '選別条件に合致'
}

function formatDataStatus(status: CandidateFunnelCandidate['dataStatus']): string {
  if (status === null) return '—'
  return status === 'ok' ? '主要データ確認済み' : '一部データ不足'
}

export interface CandidateFunnelCardProps {
  candidate: CandidateFunnelCandidate
}

export function CandidateFunnelCard({ candidate }: CandidateFunnelCardProps) {
  const generatedId = useId()
  const titleId = `candidate-funnel-card-title-${generatedId.replace(/:/g, '')}`

  return (
    <article className="candidate-funnel-card" aria-labelledby={titleId}>
      <header className="candidate-funnel-card__header">
        <div className="candidate-funnel-card__identity">
          <div className="candidate-funnel-card__code">{candidate.code}</div>
          <h3 id={titleId} className="candidate-funnel-card__name">{candidate.name}</h3>
          <div className="candidate-funnel-card__sector">{candidate.sector}</div>
        </div>
        <span className={`candidate-funnel-tier candidate-funnel-tier--${candidate.tier}`}>
          {formatCandidateTier(candidate.tier)}
        </span>
      </header>

      <dl className="candidate-funnel-card__metrics">
        <div>
          <dt>市場スコア</dt>
          <dd>{formatCandidateMetric(candidate.marketScore)}</dd>
        </div>
        <div>
          <dt>市場順位</dt>
          <dd>{formatCandidateMetric(candidate.marketRank)}</dd>
        </div>
        <div>
          <dt>データ確度</dt>
          <dd>{formatCandidateDataConfidence(candidate.dataConfidence)}</dd>
        </div>
        <div>
          <dt>一次選別順位</dt>
          <dd>{formatCandidateMetric(candidate.prescreenRank)}</dd>
        </div>
        <div>
          <dt>選別段階</dt>
          <dd>{formatCandidateTier(candidate.tier)}</dd>
        </div>
      </dl>

      <dl className="candidate-funnel-card__observations">
        <div>
          <dt>テーマ</dt>
          <dd>{formatCandidateTheme(candidate.themeStatus, candidate.themes)}</dd>
        </div>
        <div>
          <dt>データ状態</dt>
          <dd>{formatDataStatus(candidate.dataStatus)}</dd>
        </div>
      </dl>

      {candidate.selectedReasons.length > 0 && (
        <div className="candidate-funnel-card__reason-group">
          <div className="candidate-funnel-card__reason-label">選別理由</div>
          <ul>
            {candidate.selectedReasons.map(reason => (
              <li key={reason}>{formatSelectedReason(reason)}</li>
            ))}
          </ul>
        </div>
      )}

      {candidate.riskReasons.length > 0 && (
        <div className="candidate-funnel-card__reason-group candidate-funnel-card__reason-group--risk">
          <div className="candidate-funnel-card__reason-label">確認事項</div>
          <ul>
            {candidate.riskReasons.map((reason, index) => (
              <li key={`${reason}-${index}`}>{formatCandidateRiskReason(reason)}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  )
}
