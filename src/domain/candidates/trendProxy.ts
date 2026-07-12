import type { CandidateAssetType, SignalVerdict } from './candidateTypes'
import type { TrustRole } from './roleExposure'

export interface TrendProxyInput {
  marketNikkeiChgPct: number | null
  macroSp500ChgPct: number | null
  macroNasdaqChgPct: number | null
  macroGoldChgPct: number | null
}

const TREND_CONFIRM_THRESHOLD = 1.0
const TREND_CAUTION_THRESHOLD = -1.0

function verdictFromChgPct(value: number | null | undefined): SignalVerdict {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unavailable'
  if (value >= TREND_CONFIRM_THRESHOLD) return 'confirm'
  if (value <= TREND_CAUTION_THRESHOLD) return 'caution'
  return 'neutral'
}

export function resolveTrendProxy(
  assetType: CandidateAssetType,
  role: TrustRole,
  input: TrendProxyInput,
): SignalVerdict {
  if (role === 'leveraged') return 'unavailable'
  if (role === 'reit') return 'unavailable'
  if (role === 'us_div') return 'unavailable'
  if (role === 'jp_div') return 'unavailable'
  if (role === 'other') return 'unavailable'

  if (role === 'gold' || assetType === 'gold') {
    return verdictFromChgPct(input.macroGoldChgPct)
  }

  if (role === 'us_growth') {
    return verdictFromChgPct(input.macroNasdaqChgPct)
  }

  if (role === 'us_broad' || role === 'global_broad') {
    return verdictFromChgPct(input.macroSp500ChgPct)
  }

  if (role === 'jp_broad' || role === 'jp_semiconductor') {
    return verdictFromChgPct(input.marketNikkeiChgPct)
  }

  return 'unavailable'
}
