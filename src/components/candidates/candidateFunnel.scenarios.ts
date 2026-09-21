// UI-9I Phase 2B-1R: Candidate Funnel の視覚検証 / 描画テスト共通のシナリオ fixture。
// dev ハーネス（src/dev/ui9iHarness.tsx）と Vitest が同じ入力を使い、実コンポーネント
// CandidateFunnelPanelView を描画する。値は production artifact の実 shape（parser 通過形）
// を最小構成で再現したもので、業務ロジックは持たない。
import { buildValidCandidateFunnelArtifact } from '../../services/candidateFunnelArtifact.fixtures'
import type { CandidateFunnelArtifact } from '../../types/candidateFunnelArtifact'
import type { CandidateFunnelFreshness } from '../../services/candidateFunnelFreshness'
import type {
  CandidatePortfolioFitPresentationStatus,
  CandidatePortfolioFitPresentationViewModel,
  CandidatePortfolioFitRecordViewModel,
} from './candidatePortfolioFitPresentation'

export type CandidateFunnelScenarioName =
  | 'normal' | 'warning' | 'quality' | 'empty' | 'unavailable' | 'invalid'

export interface CandidateFunnelScenario {
  readonly artifact: CandidateFunnelArtifact | null
  readonly freshness: CandidateFunnelFreshness
  readonly portfolioFit: CandidatePortfolioFitPresentationViewModel
  /** portfolio-fit の evaluatedAt に相当する評価時刻（View は時計を持たない）。 */
  readonly nowMs: number
}

export const CANDIDATE_FUNNEL_SCENARIO_NAMES: readonly CandidateFunnelScenarioName[] =
  ['normal', 'warning', 'quality', 'empty', 'unavailable', 'invalid']

// buildValidCandidateFunnelArtifact() の generatedAt（2026-07-26T07:11:40Z）から 2 時間後。
export const CANDIDATE_FUNNEL_SCENARIO_NOW_MS = Date.parse('2026-07-26T09:00:00.000Z')

const NOT_FOR_TRADING =
  '売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。'

function fitRecord(
  artifactIndex: number,
  status: CandidatePortfolioFitRecordViewModel['status'] = 'evaluated',
): CandidatePortfolioFitRecordViewModel {
  const partial = status === 'partial'
  return {
    artifactIndex,
    candidateRecordId: `artifact:${artifactIndex}`,
    status,
    statusText: partial
      ? 'ポートフォリオ適合は一部のみ評価できました。'
      : 'ポートフォリオ適合を評価しました。',
    relationship: 'new_to_portfolio',
    relationshipText: '新規候補（未保有）',
    components: [
      {
        id: 'same_code_relationship', label: '同一コード保有関係',
        status: 'evaluated', statusText: '評価済み', valueText: null, valueAriaLabel: null,
      },
      {
        id: 'existing_concentration', label: '既存ポートフォリオ内の同一コード比率',
        status: partial ? 'partial' : 'evaluated', statusText: partial ? '一部評価' : '評価済み',
        valueText: partial ? null : '25%',
        valueAriaLabel: partial ? null : '既存ポートフォリオ内の同一コード比率 25パーセント',
      },
      {
        id: 'sector_diversification', label: '既存日本株内の同一セクター比率',
        status: 'evaluated', statusText: '評価済み',
        valueText: '66.7%', valueAriaLabel: '既存日本株内の同一セクター比率 66.7パーセント',
      },
    ],
    reasons: ['未保有として照合'],
    risks: partial ? ['セクター情報が不完全です'] : [],
    hasUnknownLiteral: false,
  }
}

export function scenarioFitPresentation(
  status: CandidatePortfolioFitPresentationStatus,
  recordCount = 3,
): CandidatePortfolioFitPresentationViewModel {
  const statusText = {
    pending: 'ポートフォリオ適合を評価しています。',
    evaluated: 'ポートフォリオ適合を評価しました。',
    partial: 'ポートフォリオ適合は一部のみ評価できました。',
    unavailable: 'ポートフォリオ適合を評価できません。',
    invalid: 'ポートフォリオ適合データを検証できませんでした。',
  }[status]
  const noRecords = status === 'invalid' || status === 'unavailable'
  return {
    dataset: {
      status,
      statusText,
      alertRole: status === 'invalid' ? 'alert' : status === 'evaluated' ? 'none' : 'status',
      evaluatedAtText: status === 'pending' ? null : '2026/07/26 18:00:00',
      portfolioFreshnessText: status === 'pending' ? null : '保有データ鮮度: 有効',
      capacityText: status === 'pending' ? null : '日本株枠: 余力あり',
      degradationText: status === 'partial' ? '1件' : null,
      canonicalMessage: null,
      hasHardFail: status === 'invalid',
      hasWarning: status === 'partial',
      notForTradingText: NOT_FOR_TRADING,
    },
    records: noRecords
      ? []
      : Array.from({ length: recordCount }, (_, index) =>
          fitRecord(index, status === 'partial' ? 'partial' : 'evaluated')),
  }
}

function baseArtifact(): CandidateFunnelArtifact {
  const data = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  const names: Record<string, [string, string]> = {
    '1001': ['三菱UFJフィナンシャル・グループ', '銀行業'],
    '1002': ['トヨタ自動車', '輸送用機器'],
    '1003': ['ソニーグループ', '電気機器'],
  }
  data.candidates = data.candidates.map(candidate => ({
    ...candidate,
    name: names[candidate.code]?.[0] ?? candidate.name,
    sector: names[candidate.code]?.[1] ?? candidate.sector,
  }))
  return data
}

export function candidateFunnelScenario(name: CandidateFunnelScenarioName): CandidateFunnelScenario {
  const nowMs = CANDIDATE_FUNNEL_SCENARIO_NOW_MS
  switch (name) {
    case 'normal':
      return { artifact: baseArtifact(), freshness: 'fresh', portfolioFit: scenarioFitPresentation('evaluated'), nowMs }
    case 'warning': {
      // 除外候補あり（1銘柄に複数の hard 除外理由）+ 確認事項（riskReasons）あり + データが古い可能性。
      const data = baseArtifact()
      data.candidates.push({
        ...structuredClone(data.candidates[0]),
        code: '9999',
        name: '除外テスト銘柄',
        sector: 'サービス業',
        prescreenScore: null,
        prescreenRank: null,
        prescreenPool: null,
        rawCompositeScore: null,
        dataConfidence: null,
        marketScore: null,
        marketRank: null,
        tier: 'excluded',
        selectedReasons: [],
        riskReasons: [],
        hardExclusionReasons: ['HARD_NOT_PRIME_DOMESTIC', 'HARD_INSUFFICIENT_HISTORY'],
      })
      data.counts = { ...data.counts, total: 4, excluded: 1 }
      data.excludedSummary = {
        total: 1,
        byReason: { HARD_NOT_PRIME_DOMESTIC: 1, HARD_INSUFFICIENT_HISTORY: 1 },
      }
      data.selectionObservability.sourceStale = true
      data.candidates[2] = {
        ...data.candidates[2],
        riskReasons: ['SOFT_ELEVATED_VOLATILITY', 'SOFT_SECTOR_CROWDING'],
      }
      return { artifact: data, freshness: 'stale', portfolioFit: scenarioFitPresentation('partial'), nowMs }
    }
    case 'quality': {
      // 代替データ経路 + データ品質注記 + 検証要確認。
      const data = baseArtifact()
      data._meta.pipelinePath = 'cache_fallback'
      data.degradationReasons = ['CACHE_FALLBACK_PROVENANCE: cached', 'PRESCREEN_METADATA_MISSING: sector']
      data._meta.join = { ...data._meta.join, joinRate: 0.923 }
      return { artifact: data, freshness: 'degraded', portfolioFit: scenarioFitPresentation('partial'), nowMs }
    }
    case 'empty': {
      const data = baseArtifact()
      data.candidates = []
      data.counts = { total: 0, excluded: 0, screened: 0, deepReview: 0, actionable: 0 }
      return { artifact: data, freshness: 'fresh', portfolioFit: scenarioFitPresentation('evaluated', 0), nowMs }
    }
    case 'unavailable':
      return { artifact: null, freshness: 'unavailable', portfolioFit: scenarioFitPresentation('unavailable'), nowMs }
    case 'invalid':
      return { artifact: null, freshness: 'invalid', portfolioFit: scenarioFitPresentation('invalid'), nowMs }
  }
}
