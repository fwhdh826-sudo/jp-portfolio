import type { Trust } from '../../types'
import type { CandidateAssetType } from './candidateTypes'

export interface RawCandidate {
  trust: Trust
  assetType: CandidateAssetType
}

const POLICY_TO_ASSET_TYPE: Record<string, CandidateAssetType> = {
  JAPAN_SHORTTERM: 'jp_trust',
  OVERSEAS_LONGTERM: 'global_trust',
  GOLD: 'gold',
}

export function buildCandidateUniverse(trusts: Trust[]): RawCandidate[] {
  return trusts
    .filter(f => f.eval <= 0)
    .map(f => ({
      trust: f,
      assetType: POLICY_TO_ASSET_TYPE[f.policy] ?? 'global_trust',
    }))
}
