import type {
  CandidatePortfolioFitComponent,
  CandidatePortfolioFitResult,
} from '../../types/candidatePortfolioFit'
import type { CandidateFunnelTier } from '../../types/candidateFunnel'

export type CandidatePortfolioFitPresentationStatus =
  | 'pending' | 'evaluated' | 'partial' | 'unavailable' | 'invalid'

export interface CandidatePortfolioFitPresentationInput {
  readonly phase: 'pending' | 'ready'
  readonly result: CandidatePortfolioFitResult | null
}

export interface CandidatePortfolioFitDatasetViewModel {
  readonly status: CandidatePortfolioFitPresentationStatus
  readonly statusText: string
  readonly alertRole: 'none' | 'status' | 'alert'
  readonly evaluatedAtText: string | null
  readonly portfolioFreshnessText: string | null
  readonly capacityText: string | null
  readonly degradationText: string | null
  readonly canonicalMessage: string | null
  readonly hasHardFail: boolean
  readonly hasWarning: boolean
  readonly notForTradingText: string
}

export interface CandidatePortfolioFitComponentViewModel {
  readonly id: 'same_code_relationship' | 'existing_concentration' | 'sector_diversification'
  readonly label: string
  readonly status: 'evaluated' | 'partial' | 'unavailable' | 'reserved' | 'not_applicable'
  readonly statusText: string
  readonly valueText: string | null
  readonly valueAriaLabel: string | null
}

export interface CandidatePortfolioFitRecordViewModel {
  readonly artifactIndex: number
  readonly candidateRecordId: string
  readonly status: 'evaluated' | 'partial' | 'unavailable' | 'invalid'
  readonly statusText: string
  readonly relationship: 'new_to_portfolio' | 'already_held' | 'holding_match_unknown'
  readonly relationshipText: string
  readonly components: readonly CandidatePortfolioFitComponentViewModel[]
  readonly reasons: readonly string[]
  readonly risks: readonly string[]
  readonly hasUnknownLiteral: boolean
}

export interface CandidatePortfolioFitPresentationViewModel {
  readonly dataset: CandidatePortfolioFitDatasetViewModel
  readonly records: readonly CandidatePortfolioFitRecordViewModel[]
}

export type CandidatePortfolioFitCardViewModel =
  | { readonly state: 'evaluated' | 'partial'; readonly heading: 'ポートフォリオ適合';
      readonly record: CandidatePortfolioFitRecordViewModel }
  | { readonly state: 'pending' | 'missing' | 'unavailable' | 'invalid';
      readonly heading: 'ポートフォリオ適合'; readonly statusText: string }

const NOT_FOR_TRADING =
  '売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。'
const UNKNOWN = '未対応の表示値を検出しました。'

const RELATIONSHIP_LABELS = {
  already_held: '保有あり',
  new_to_portfolio: '新規候補（未保有）',
  holding_match_unknown: '保有照合不明',
} as const

const COMPONENT_LABELS = {
  same_code_relationship: '同一コード保有関係',
  existing_concentration: '既存ポートフォリオ内の同一コード比率',
  sector_diversification: '既存日本株内の同一セクター比率',
} as const

const COMPONENT_STATUS_LABELS = {
  evaluated: '評価済み',
  partial: '一部評価',
  unavailable: '利用不可',
  reserved: '将来対応（未評価）',
  not_applicable: '対象外',
} as const

const RECORD_STATUS_LABELS = {
  evaluated: 'ポートフォリオ適合を評価しました。',
  partial: 'ポートフォリオ適合は一部のみ評価できました。',
  unavailable: 'ポートフォリオ適合を評価できません。',
  invalid: 'ポートフォリオ適合データを検証できませんでした。',
} as const

const REASON_LABELS: Readonly<Record<string, string>> = {
  NEW_TO_PORTFOLIO: '未保有として照合',
  ALREADY_HELD: '保有ありとして照合',
  SECTOR_EXPOSURE_MEASURED: '同一セクター比率を確認',
  EXISTING_CODE_CONCENTRATION_MEASURED: '同一コード比率を確認',
}

const RISK_LABELS: Readonly<Record<string, string>> = {
  HOLDING_MATCH_UNKNOWN: '保有照合を確定できません',
  SECTOR_AUTHORITY_PARTIAL: 'セクター情報が不完全です',
  EXISTING_CONCENTRATION_UNAVAILABLE: '同一コード比率を評価できません',
  COMPONENT_COVERAGE_PARTIAL: '評価項目の一部を確認できません',
}

function formatEvaluatedAt(value: string): string | null {
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) return null
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function projectLiterals(
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
): { values: string[]; unknown: boolean } {
  const seen = new Set<string>()
  const projected: string[] = []
  let unknownAdded = false
  for (const value of values) {
    const label = labels[value]
    if (label === undefined) {
      if (!unknownAdded) {
        projected.push(UNKNOWN)
        unknownAdded = true
      }
      continue
    }
    if (seen.has(value)) continue
    seen.add(value)
    projected.push(label)
  }
  return { values: projected, unknown: unknownAdded }
}

function projectComponent(
  component: CandidatePortfolioFitComponent,
): { viewModel: CandidatePortfolioFitComponentViewModel; unknown: boolean } {
  const label = COMPONENT_LABELS[component.id]
  const isRatio =
    component.id === 'existing_concentration' ||
    component.id === 'sector_diversification'
  const validRatio =
    isRatio &&
    component.status === 'evaluated' &&
    component.value !== null &&
    Number.isFinite(component.value) &&
    component.value >= 0 &&
    component.value <= 1
  const invalidEvaluatedRatio =
    isRatio &&
    component.status === 'evaluated' &&
    !validRatio
  let valueText: string | null = null
  let valueAriaLabel: string | null = null
  if (validRatio) {
    const numeric = new Intl.NumberFormat('ja-JP', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(component.value! * 100)
    valueText = `${numeric}%`
    valueAriaLabel = `${label} ${numeric}パーセント`
  }

  return {
    viewModel: {
      id: component.id,
      label,
      status: component.status,
      statusText: invalidEvaluatedRatio ? UNKNOWN : COMPONENT_STATUS_LABELS[component.status],
      valueText,
      valueAriaLabel,
    },
    unknown: invalidEvaluatedRatio,
  }
}

function portfolioFreshnessText(
  freshness: CandidatePortfolioFitResult['portfolioFreshness'],
): string {
  const labels = {
    fresh: '保有データ鮮度: 有効',
    stale: '保有データ鮮度: 期限切れ',
    partial: '保有データ鮮度: 一部確認',
    unavailable: '保有データ鮮度: 利用不可',
    invalid: '保有データ鮮度: 検証不可',
  } as const
  return labels[freshness]
}

function capacityText(status: CandidatePortfolioFitResult['capacity']['status']): string {
  const labels = {
    available: '日本株枠: 余力あり',
    constrained: '日本株枠: 制約あり',
    unknown: '日本株枠: 判定不明',
    unavailable: '日本株枠: 利用不可',
  } as const
  return labels[status]
}

function canonicalMessage(
  result: CandidatePortfolioFitResult,
  hasHardFail: boolean,
): string | null {
  if (hasHardFail) return 'ポートフォリオ適合の品質検証に失敗しました。'
  const reasons = new Set<string>(result.degradationReasons)
  if (reasons.has('PORTFOLIO_SNAPSHOT_INVALID')) {
    return '確定済みの保有データを検証できませんでした。'
  }
  if (reasons.has('CROSS_TAB_STATE_STALE')) {
    return '別タブで保有データが更新されました。再読み込み後に再評価してください。'
  }
  if (reasons.has('PORTFOLIO_SNAPSHOT_UNAVAILABLE')) {
    return '確定済みの保有データがありません。'
  }
  if (reasons.has('CANDIDATE_INPUT_INVALID')) {
    return 'ポートフォリオ適合データを検証できませんでした。'
  }
  if (reasons.has('CANDIDATE_INPUT_STALE')) {
    return '候補データが古いため、ポートフォリオ適合を評価できません。'
  }
  if (reasons.has('CANDIDATE_INPUT_DEGRADED')) {
    return '候補データが代替経路のため、ポートフォリオ適合を評価できません。'
  }
  return null
}

export function projectCandidatePortfolioFitPresentation(
  input: CandidatePortfolioFitPresentationInput,
): CandidatePortfolioFitPresentationViewModel {
  if (input.phase === 'pending') {
    return {
      dataset: {
        status: 'pending',
        statusText: 'ポートフォリオ適合を評価しています。',
        alertRole: 'status',
        evaluatedAtText: null,
        portfolioFreshnessText: null,
        capacityText: null,
        degradationText: null,
        canonicalMessage: null,
        hasHardFail: false,
        hasWarning: false,
        notForTradingText: NOT_FOR_TRADING,
      },
      records: [],
    }
  }
  if (input.result === null) {
    return {
      dataset: {
        status: 'invalid',
        statusText: 'ポートフォリオ適合データを検証できませんでした。',
        alertRole: 'alert',
        evaluatedAtText: null,
        portfolioFreshnessText: null,
        capacityText: null,
        degradationText: null,
        canonicalMessage: null,
        hasHardFail: false,
        hasWarning: false,
        notForTradingText: NOT_FOR_TRADING,
      },
      records: [],
    }
  }

  const result = input.result
  const hasHardFail = result.qualityGate.hardFailIds.length > 0
  const hasWarning = !hasHardFail && result.qualityGate.warningIds.length > 0
  const status: Exclude<CandidatePortfolioFitPresentationStatus, 'pending'> =
    hasHardFail || result.status === 'invalid'
      ? 'invalid'
      : result.status === 'unavailable'
        ? 'unavailable'
        : result.status === 'partial'
          ? 'partial'
          : 'evaluated'
  const alertRole =
    status === 'invalid'
      ? 'alert'
      : status === 'evaluated' && !hasWarning
        ? 'none'
        : 'status'
  const records =
    status === 'invalid' || status === 'unavailable'
      ? []
      : result.records.map(record => {
          const componentResults = record.components.map(projectComponent)
          const reasons = projectLiterals(record.fitReasons as readonly string[], REASON_LABELS)
          const risks = projectLiterals(record.fitRisks as readonly string[], RISK_LABELS)
          return {
            artifactIndex: record.artifactIndex,
            candidateRecordId: record.candidateRecordId,
            status: record.portfolioFitStatus,
            statusText: RECORD_STATUS_LABELS[record.portfolioFitStatus],
            relationship: record.holdingRelationship,
            relationshipText: RELATIONSHIP_LABELS[record.holdingRelationship],
            components: componentResults.map(item => item.viewModel),
            reasons: reasons.values,
            risks: risks.values,
            hasUnknownLiteral:
              reasons.unknown ||
              risks.unknown ||
              componentResults.some(item => item.unknown),
          } satisfies CandidatePortfolioFitRecordViewModel
        })

  return {
    dataset: {
      status,
      statusText: RECORD_STATUS_LABELS[status],
      alertRole,
      evaluatedAtText: formatEvaluatedAt(result.evaluatedAt),
      portfolioFreshnessText: portfolioFreshnessText(result.portfolioFreshness),
      capacityText: capacityText(result.capacity.status),
      degradationText:
        result.degradationReasons.length > 0
          ? `${result.degradationReasons.length}件`
          : null,
      canonicalMessage: canonicalMessage(result, hasHardFail),
      hasHardFail,
      hasWarning,
      notForTradingText: NOT_FOR_TRADING,
    },
    records,
  }
}

export function selectCandidatePortfolioFitCardViewModel(
  presentation: CandidatePortfolioFitPresentationViewModel,
  artifactIndex: number,
  tier: CandidateFunnelTier,
): CandidatePortfolioFitCardViewModel | undefined {
  if (tier !== 'deep_review' && tier !== 'actionable') return undefined
  if (presentation.dataset.status === 'pending') {
    return {
      state: 'pending',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合を評価しています。',
    }
  }
  if (presentation.dataset.status === 'invalid') {
    return {
      state: 'invalid',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合データを検証できませんでした。',
    }
  }
  if (presentation.dataset.status === 'unavailable') {
    return {
      state: 'unavailable',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合を評価できません。',
    }
  }

  const matches = presentation.records.filter(record =>
    record.artifactIndex === artifactIndex &&
    record.candidateRecordId === `artifact:${artifactIndex}`,
  )
  if (matches.length !== 1) {
    return {
      state: 'missing',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合レコードが見つかりません。',
    }
  }

  const record = matches[0]
  if (record.status === 'invalid') {
    return {
      state: 'invalid',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合データを検証できませんでした。',
    }
  }
  if (record.status === 'unavailable') {
    return {
      state: 'unavailable',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合を評価できません。',
    }
  }
  return {
    state: record.status,
    heading: 'ポートフォリオ適合',
    record,
  }
}
