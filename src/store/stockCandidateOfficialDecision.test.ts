// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runFullAnalysis, useAppStore } from './useAppStore'

const useAppStoreSource = readFileSync(
  new URL('./useAppStore.ts', import.meta.url),
  'utf8',
)

describe('P5-B005-C-D legacy candidates_stocks decision bridge retirement', () => {
  it('C-C-T51 old conversion export/source is absent', () => {
    expect(useAppStoreSource).not.toContain('stockCandidateToOfficialDecisionItem')
    expect(useAppStore).not.toHaveProperty('stockCandidateToOfficialDecisionItem')
  })

  it('C-C-T52 old selection export/source is absent', () => {
    expect(useAppStoreSource).not.toContain('selectAppendableStockCandidates')
    expect(useAppStore).not.toHaveProperty('selectAppendableStockCandidates')
  })

  it('C-C-T53 emits no candidates_stocks decision item while observability remains', () => {
    expect(useAppStoreSource).not.toContain("candidateSource: 'candidates_stocks'")
    const state = useAppStore.getState()
    const computed = runFullAnalysis({
      ...state,
      candidatesStocks: {
        ...state.candidatesStocks,
        status: 'ok',
        updatedAt: new Date().toISOString(),
        candidates: [{
          code: '9999',
          name: '旧候補',
          sector: 'テスト',
          price: 1_000,
          per: 10,
          pbr: 1,
          roe: 10,
          dividendYield: 2,
          sigma252d: 0.1,
          mom3m: 5,
          screenReasons: ['旧候補理由'],
          dataStatus: 'ok',
        }],
      },
    }, { nowMs: Date.now() })

    expect(computed.stockCandidates).toBeDefined()
    expect(computed.officialDecision?.actions.some(
      item => item.candidateSource === 'candidates_stocks',
    )).toBe(false)
  })
})
