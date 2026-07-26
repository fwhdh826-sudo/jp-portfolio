import { useReducer } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectCandidateFunnelFreshness } from '../../store/selectors'
import type {
  CandidateFunnelCandidate,
  CandidateFunnelTier,
} from '../../types/candidateFunnel'
import type { CandidateFunnelArtifact } from '../../types/candidateFunnelArtifact'
import type { CandidateFunnelFreshness } from '../../services/candidateFunnelFreshness'
import { SectionHeader } from '../layout/SectionHeader'
import { CandidateFunnelCard } from './CandidateFunnelCard'
import './CandidateFunnelPanel.css'

export type CandidateFunnelFilter = 'actionable' | 'deep_review' | 'screened'

export interface CandidateFunnelViewState {
  filter: CandidateFunnelFilter
  visibleCount: number
}

export interface IndexedCandidate {
  candidate: CandidateFunnelCandidate
  artifactIndex: number
}

export type CandidateFunnelViewAction =
  | { type: 'set_filter'; filter: CandidateFunnelFilter }
  | { type: 'show_more' }

export const CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT = 10
export const CANDIDATE_FUNNEL_VISIBLE_INCREMENT = 10
export const CANDIDATE_FUNNEL_INITIAL_VIEW_STATE: CandidateFunnelViewState = {
  filter: 'actionable',
  visibleCount: CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT,
}

const FILTER_OPTIONS: ReadonlyArray<{
  id: CandidateFunnelFilter
  label: string
  countKey: 'actionable' | 'deepReview' | 'screened'
}> = [
  { id: 'actionable', label: '重点候補', countKey: 'actionable' },
  { id: 'deep_review', label: '詳細精査', countKey: 'deepReview' },
  { id: 'screened', label: '一次選別', countKey: 'screened' },
]

export function candidateFunnelViewReducer(
  state: CandidateFunnelViewState,
  action: CandidateFunnelViewAction,
): CandidateFunnelViewState {
  if (action.type === 'set_filter') {
    return {
      filter: action.filter,
      visibleCount: CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT,
    }
  }
  return {
    ...state,
    visibleCount: state.visibleCount + CANDIDATE_FUNNEL_VISIBLE_INCREMENT,
  }
}

export function sortCandidateFunnelCandidates(
  candidates: CandidateFunnelCandidate[],
): CandidateFunnelCandidate[] {
  return sortIndexedCandidateFunnelCandidates(indexCandidateFunnelCandidates(candidates))
    .map(({ candidate }) => candidate)
}

export function indexCandidateFunnelCandidates(
  candidates: CandidateFunnelCandidate[],
): IndexedCandidate[] {
  return candidates.map((candidate, artifactIndex) => ({ candidate, artifactIndex }))
}

function sortIndexedCandidateFunnelCandidates(
  candidates: IndexedCandidate[],
): IndexedCandidate[] {
  return candidates
    .slice()
    .sort((left, right) => {
      const leftRank = left.candidate.marketRank
      const rightRank = right.candidate.marketRank
      if (leftRank === null && rightRank === null) {
        return left.artifactIndex - right.artifactIndex
      }
      if (leftRank === null) return 1
      if (rightRank === null) return -1
      return leftRank - rightRank || left.artifactIndex - right.artifactIndex
    })
}

export function candidateFunnelFilterForKey(
  current: CandidateFunnelFilter,
  key: string,
): CandidateFunnelFilter | null {
  const index = FILTER_OPTIONS.findIndex(option => option.id === current)
  if (key === 'Home') return FILTER_OPTIONS[0].id
  if (key === 'End') return FILTER_OPTIONS[FILTER_OPTIONS.length - 1].id
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return null
  const delta = key === 'ArrowRight' ? 1 : -1
  return FILTER_OPTIONS[(index + delta + FILTER_OPTIONS.length) % FILTER_OPTIONS.length].id
}

export function formatCandidateFunnelJstTimestamp(value: string | null): string {
  if (value === null) return '—'
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return '—'
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed)
}

function filterCandidates(
  candidates: IndexedCandidate[],
  filter: CandidateFunnelFilter,
): IndexedCandidate[] {
  return sortIndexedCandidateFunnelCandidates(
    candidates.filter(entry => entry.candidate.tier === filter),
  )
}

function generalPipelineLabel(artifact: CandidateFunnelArtifact): string {
  return artifact._meta.pipelinePath === 'normal' ? '通常データ経路' : '代替データ経路'
}

function filterTierForAria(filter: CandidateFunnelFilter): CandidateFunnelTier {
  return filter
}

interface CandidateFunnelPanelViewProps {
  artifact: CandidateFunnelArtifact | null
  freshness: CandidateFunnelFreshness
  viewState: CandidateFunnelViewState
  onAction: (action: CandidateFunnelViewAction) => void
}

export function CandidateFunnelPanelView({
  artifact,
  freshness,
  viewState,
  onAction,
}: CandidateFunnelPanelViewProps) {
  const canDisplayCandidates =
    artifact !== null &&
    (freshness === 'fresh' || freshness === 'stale' || freshness === 'degraded')

  const handleFilterKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: CandidateFunnelFilter,
  ) => {
    const next = candidateFunnelFilterForKey(current, event.key)
    if (next === null) return
    event.preventDefault()
    onAction({ type: 'set_filter', filter: next })
    document.getElementById(`candidate-funnel-tab-${next}`)?.focus()
  }

  const indexedCandidates = canDisplayCandidates
    ? indexCandidateFunnelCandidates(artifact.candidates)
    : []
  const selectedCandidates = canDisplayCandidates
    ? filterCandidates(indexedCandidates, viewState.filter)
    : []
  const visibleCandidates = selectedCandidates.slice(0, viewState.visibleCount)
  const selectedFilterLabel =
    FILTER_OPTIONS.find(option => option.id === viewState.filter)?.label ?? '候補'

  return (
    <section className="candidate-funnel" aria-label="市場候補ファネル">
      <SectionHeader
        title="市場候補ファネル"
        caption="市場全体から段階的に絞り込んだ観測情報"
      />

      <div className="candidate-funnel__disclaimers">
        <p>市場公開情報による一次評価です。保有状況・資金余力・購入判断は未反映です。</p>
        <p>重点候補は購入を推奨するものではなく、次段階の検討候補です。</p>
        <p className="candidate-funnel__not-for-trading">
          売買利用不可（not_for_trading）— 現在の売買判断や注文には使用しないでください。
        </p>
      </div>

      {freshness === 'unavailable' && (
        <div className="candidate-funnel__state candidate-funnel__state--neutral" role="status">
          <span aria-hidden="true">ⓘ</span>
          <span>候補データを取得できませんでした</span>
        </div>
      )}

      {(freshness === 'invalid' || (freshness !== 'unavailable' && artifact === null)) && (
        <div className="candidate-funnel__state candidate-funnel__state--danger" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>候補データを検証できませんでした</span>
        </div>
      )}

      {canDisplayCandidates && (
        <>
          {freshness === 'stale' && (
            <div
              className="candidate-funnel__state candidate-funnel__state--warning"
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true">⚠</span>
              <span>データが古い可能性があります。更新日時を確認してください。</span>
            </div>
          )}

          {freshness === 'degraded' && (
            <div
              className="candidate-funnel__state candidate-funnel__state--danger"
              role="alert"
            >
              <span aria-hidden="true">⚠</span>
              <span>代替データ経路を使用しています。現在の購入判断には使用しないでください。</span>
            </div>
          )}

          <div className="candidate-funnel__timestamps" aria-label="候補データ更新日時">
            <span>生成: {formatCandidateFunnelJstTimestamp(artifact._meta.generatedAt)} JST</span>
            <span>ソース更新: {formatCandidateFunnelJstTimestamp(artifact._meta.sourceUpdatedAt)} JST</span>
          </div>

          <ol className="candidate-funnel__summary" aria-label="候補選別の段階">
            <li>
              <span>市場候補</span>
              <strong>{artifact.counts.total}</strong>
            </li>
            <li>
              <span>一次選別</span>
              <strong>{artifact.counts.screened}</strong>
            </li>
            <li>
              <span>詳細精査</span>
              <strong>{artifact.counts.deepReview}</strong>
            </li>
            <li>
              <span>重点候補</span>
              <strong>{artifact.counts.actionable}</strong>
            </li>
          </ol>

          <details className="candidate-funnel__data-details">
            <summary>データ状態</summary>
            <dl>
              <div>
                <dt>データ経路</dt>
                <dd>{generalPipelineLabel(artifact)}</dd>
              </div>
              <div>
                <dt>一次選別の結合率</dt>
                <dd>{new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(artifact._meta.join.joinRate * 100)}%</dd>
              </div>
              <div>
                <dt>検証結果</dt>
                <dd>{artifact._meta.qualityGate.overallPass ? 'データ検証通過' : 'データ検証要確認'}</dd>
              </div>
              <div>
                <dt>重大な検証不一致</dt>
                <dd>{artifact._meta.qualityGate.hardFailIds.length}件</dd>
              </div>
              <div>
                <dt>代替・品質注記</dt>
                <dd>{artifact.degradationReasons.length}件</dd>
              </div>
            </dl>
          </details>

          <div className="candidate-funnel__filters" role="tablist" aria-label="候補の選別段階">
            {FILTER_OPTIONS.map(option => {
              const selected = option.id === viewState.filter
              return (
                <button
                  key={option.id}
                  id={`candidate-funnel-tab-${option.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="candidate-funnel-list"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onAction({ type: 'set_filter', filter: option.id })}
                  onKeyDown={event => handleFilterKeyDown(event, option.id)}
                >
                  <span>{option.label}</span>
                  <span aria-label={`${artifact.counts[option.countKey]}件`}>
                    {artifact.counts[option.countKey]}
                  </span>
                </button>
              )
            })}
          </div>

          <div
            id="candidate-funnel-list"
            className="candidate-funnel__list"
            role="tabpanel"
            aria-labelledby={`candidate-funnel-tab-${viewState.filter}`}
            data-tier={filterTierForAria(viewState.filter)}
          >
            {visibleCandidates.length === 0 ? (
              <div className="candidate-funnel__empty" role="status">
                {selectedFilterLabel}に該当する候補はありません
              </div>
            ) : (
              visibleCandidates.map(entry => (
                <CandidateFunnelCard
                  key={`candidate-funnel-record-${entry.artifactIndex}`}
                  candidate={entry.candidate}
                />
              ))
            )}
          </div>

          {selectedCandidates.length > visibleCandidates.length && (
            <button
              type="button"
              className="candidate-funnel__more"
              onClick={() => onAction({ type: 'show_more' })}
              aria-controls="candidate-funnel-list"
            >
              さらに表示
              <span>
                （{visibleCandidates.length}/{selectedCandidates.length}件）
              </span>
            </button>
          )}
        </>
      )}
    </section>
  )
}

export function CandidateFunnelPanel() {
  const artifact = useAppStore(state => state.candidateFunnel)
  const freshness = useAppStore(state => selectCandidateFunnelFreshness(state, Date.now()))
  const [viewState, dispatch] = useReducer(
    candidateFunnelViewReducer,
    CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  )

  return (
    <CandidateFunnelPanelView
      artifact={artifact}
      freshness={freshness}
      viewState={viewState}
      onAction={dispatch}
    />
  )
}
