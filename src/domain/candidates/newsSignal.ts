import type { SignalVerdict } from './candidateTypes'
import type { TrustRole } from './roleExposure'
import type { CandidatesNewsData } from '../../types'
import { isCandidatesNewsUsable } from '../../services/loadStaticData'

const NEWS_CAUTION_THRESHOLD = -0.15
const NEWS_CONFIRM_THRESHOLD = 0.15

// Maps TrustRole to the corresponding CandidatesNewsRoleKey.
// Returns null for roles that have no direct news mapping (leveraged, other).
function trustRoleToNewsKey(role: TrustRole): string | null {
  switch (role) {
    case 'jp_broad':        return 'jp_broad'
    case 'jp_semiconductor':return 'jp_semiconductor'
    case 'us_broad':        return 'us_broad'
    case 'us_growth':       return 'us_growth'
    case 'global_broad':    return 'global_broad'
    case 'gold':            return 'gold'
    case 'reit':            return 'reit'
    case 'us_div':          return 'dividend'
    case 'jp_div':          return 'dividend'
    case 'leveraged':       return null
    case 'other':           return null
  }
}

// P4-A9c: news signal helper — observability only, not connected to score/action.
// Returns SignalVerdict based on candidates_news role entry sentiment.
export function resolveNewsSignal(
  role: TrustRole,
  candidatesNews: CandidatesNewsData | null | undefined,
  candidatesNewsSource: 'loaded' | 'default' | undefined,
): SignalVerdict {
  if (candidatesNewsSource !== 'loaded') return 'unavailable'
  if (!candidatesNews || !isCandidatesNewsUsable(candidatesNews)) return 'unavailable'

  const newsKey = trustRoleToNewsKey(role)
  if (!newsKey) return 'unavailable'

  const entry = candidatesNews.assetClassNews[newsKey as keyof typeof candidatesNews.assetClassNews]
  if (!entry) return 'unavailable'
  if (entry.isStale) return 'unavailable'

  const minItems = candidatesNews.meta.minItemsForSignal ?? 3
  if (entry.itemCount < minItems) return 'unavailable'

  if (entry.avgSentiment <= NEWS_CAUTION_THRESHOLD) return 'caution'
  if (entry.avgSentiment >= NEWS_CONFIRM_THRESHOLD) return 'confirm'
  return 'neutral'
}
