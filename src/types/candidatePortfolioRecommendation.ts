import type { CandidateFunnelArtifact } from './candidateFunnelArtifact'
import type { CandidatePortfolioFitResult } from './candidatePortfolioFit'

export type CandidatePortfolioRecommendationAction = 'BUY_NEW' | 'WATCH'

export interface CandidatePortfolioRecommendationInput {
  readonly artifact: CandidateFunnelArtifact
  readonly fitResult: CandidatePortfolioFitResult
  readonly gates: {
    readonly dataQualitySuppressed: boolean
    readonly noTrade: boolean
    readonly safeModeActive: boolean
  }
}

export interface CandidatePortfolioRecommendation {
  readonly candidateRecordId: string
  readonly artifactIndex: number
  readonly code: string
  readonly name: string
  readonly marketRank: number | null
  readonly action: CandidatePortfolioRecommendationAction
  readonly reason: string
}
