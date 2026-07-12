import type { SignalVerdict } from './candidateTypes'
import type { RegimeState } from '../../types'
import { isRegimeStateUsable } from '../../services/loadStaticData'

// P4-A9d: 5-regime → SignalVerdict 変換（summary-only。score/action非接続）
export function resolveRegimeSignal(
  regimeState: RegimeState | null | undefined,
  regimeStateSource: 'loaded' | 'default' | undefined,
): SignalVerdict {
  if (regimeStateSource !== 'loaded') return 'unavailable'
  if (!regimeState || !isRegimeStateUsable(regimeState)) return 'unavailable'
  switch (regimeState.current_regime) {
    case 'bull_calm':     return 'confirm'
    case 'bull_volatile': return 'neutral'
    case 'bear':          return 'caution'
    case 'crisis':        return 'caution'
    case 'uncertain':     return 'neutral'
  }
}
