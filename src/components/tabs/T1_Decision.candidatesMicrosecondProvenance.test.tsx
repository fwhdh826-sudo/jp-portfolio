import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../../types'
import type {
  CandidateDecisionSynthesisCandidateInput,
  CandidateDecisionSynthesisInput,
} from '../../types/candidateDecisionSynthesis'
import { buildCandidateDecisionSynthesis } from '../../domain/candidates/candidateDecisionSynthesis'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('T1 microsecond provenance fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

const { T1_Decision } = await import('./T1_Decision')
const isolatedStore = createAppStoreInstanceForTest()
const BASE_APP_STATE = isolatedStore.store.getState()
isolatedStore.controls.dispose()

const PRODUCTION_TIMESTAMP = '2026-09-17T08:43:43.456938+09:00'
const ALLOCATION_ID = 'allocation:microsecond-ui'

function candidate(code: string, artifactIndex: number): CandidateDecisionSynthesisCandidateInput {
  return {
    instrumentId: `stock:${code}`,
    assetClass: 'JP_STOCK',
    namespace: 'jp_stock_funnel',
    displayName: `本番形状候補${code}`,
    code,
    artifactIndex,
    candidateQuality: {
      source: 'candidate_funnel', marketRank: artifactIndex + 1, marketScore: 80 - artifactIndex,
      tier: 'actionable', dataConfidence: 1, selectedReasons: [], riskReasons: [],
    },
    portfolioFit: {
      status: 'evaluated', relationship: 'new_to_portfolio', reasons: ['NEW_TO_PORTFOLIO'],
      risks: [], hardGatePassed: true,
    },
    canonicalAllocation: {
      relationship: 'new_to_portfolio', executable: false, finalSuggestedAmount: 0,
      calculationSnapshotId: ALLOCATION_ID,
      classNeed: { targetGap: 500_000, targetAmount: 1_000_000, blockedReasons: [] },
      allocationRole: {
        assetClassTargetGap: 500_000, assetClassTargetRatio: 0.2,
        classHeadroom: 500_000, instrumentHeadroom: 250_000,
      },
      blockedReasons: [], warnings: [], limitingFactors: [],
    },
    whyThis: [],
    whyNotExecutable: [],
    usesCandidatesStocksExecutionPrice: true,
  }
}

function synthesis(candidatesStocksUpdatedAt: string) {
  const candidates = ['5021', '9508', '8725'].map(candidate)
  const input: CandidateDecisionSynthesisInput = {
    generatedAt: '2026-09-17T08:49:00+00:00',
    provenance: {
      candidateGenerationId: '2026-09-16T23:47:17.089980+00:00',
      candidatePublicationState: 'published_pass',
      candidateFreshness: 'fresh',
      allocationSnapshotId: ALLOCATION_ID,
      allocationSnapshotGeneratedAt: '2026-09-17T08:48:59+00:00',
      allocationSnapshotStatus: 'current',
      sourceHoldingsSnapshotId: 'holdings:microsecond-ui',
      sourceSettingsVersion: 'settings:microsecond-ui',
      cashAuthorityUpdatedAt: '2026-09-17T08:48:58+00:00',
      marketDataAsOf: '2026-09-17T08:48:51+00:00',
      portfolioFitEvaluatedAt: '2026-09-17T08:48:59+00:00',
      candidatesStocksUpdatedAt,
      candidatesStocksSourceUpdatedAt: PRODUCTION_TIMESTAMP,
      candidatesStocksRunToken: 'production-shaped-run',
    },
    allocationPlanCandidateGenerationId: '2026-09-16T23:47:17.089980+00:00',
    canonicalExecution: { instrumentId: null, executableAmountJpy: 0 },
    candidates,
    datasetReasons: [],
  }
  return buildCandidateDecisionSynthesis(input)
}

function renderWithSynthesis(candidateDecisionSynthesis: AppState['candidateDecisionSynthesis']): string {
  mockedStore.state = {
    ...BASE_APP_STATE,
    holdings: [],
    analysis: [],
    candidateDecisionSynthesis,
  }
  return renderToStaticMarkup(<T1_Decision />)
}

describe('OPS-P5-B005-E2E-A1 T1 candidates_stocks microsecond provenance', () => {
  it('does not show the false recalculation fallback for exact production six-digit provenance', () => {
    const result = synthesis(PRODUCTION_TIMESTAMP)
    expect(result.status).toBe('available')

    const html = renderWithSynthesis(result)
    expect(html).not.toContain('候補データの再計算が必要です')
    for (const code of ['5021', '9508', '8725']) {
      expect(html).toContain(`本番形状候補${code}`)
    }
  })

  it('keeps fail-closed UI behavior for malformed seven-digit provenance', () => {
    const result = synthesis('2026-09-17T08:43:43.1234567+09:00')
    expect(result.status).toBe('invalid')
    expect(result.datasetReasons).toContain('MISSING_REQUIRED_PROVENANCE')

    const html = renderWithSynthesis(result)
    expect(html).toContain('候補データの再計算が必要です')
    for (const code of ['5021', '9508', '8725']) {
      expect(html).not.toContain(`本番形状候補${code}`)
    }
  })
})
