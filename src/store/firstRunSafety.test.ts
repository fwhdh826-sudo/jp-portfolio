import { describe, expect, it } from 'vitest'
import { useAppStore, runFullAnalysis } from './useAppStore'
import { INITIAL_HOLDINGS } from '../constants/holdings'
import { INITIAL_TRUST } from '../constants/trust'
import { INITIAL_CASH, INITIAL_CASH_RESERVE, INITIAL_ADD_ROOM } from '../constants/market'

// P0-PRIVACY-HOTFIX 実施4:
// localStorageなし・csvLastImportedAt=null・portfolio snapshotなしの真の初回起動状態で、
// 個人の過去portfolioを仮定したBUY_NEWや具体的資産配分を生成しないことを固定する。
describe('P0-PRIVACY-HOTFIX: 真の初回未取込状態の安全性', () => {
  function buildFreshFirstRunState() {
    const base = useAppStore.getState()
    return {
      ...base,
      holdings: INITIAL_HOLDINGS,
      trust: INITIAL_TRUST,
      cash: INITIAL_CASH,
      cashReserve: INITIAL_CASH_RESERVE,
      addRoom: INITIAL_ADD_ROOM,
      system: {
        ...base.system,
        csvLastImportedAt: null,
        dataTimestamps: { ...base.system.dataTimestamps!, trust: null },
      },
    }
  }

  it('INITIAL_HOLDINGSは空・INITIAL_TRUSTは全eval=0・INITIAL_CASHはゼロである', () => {
    expect(INITIAL_HOLDINGS).toEqual([])
    expect(INITIAL_TRUST.every(t => t.eval === 0)).toBe(true)
    expect(INITIAL_CASH).toBe(0)
    expect(INITIAL_CASH_RESERVE).toBe(0)
  })

  it('真の初回状態でrunFullAnalysisがクラッシュしない', () => {
    const state = buildFreshFirstRunState()
    expect(() => runFullAnalysis(state)).not.toThrow()
  })

  it('真の初回状態ではcsvLastImportedAtが無いため投信候補パイプラインが動かず、BUY_NEWが出ない', () => {
    const state = buildFreshFirstRunState()
    const result = runFullAnalysis(state)
    const buyNewActions = result.officialDecision?.actions.filter(a => a.action === 'BUY_NEW') ?? []
    expect(buyNewActions).toEqual([])
  })

  it('真の初回状態でも個別株candidate pipelineは資金前提未usable（既定値運用中）のためBUY_NEWを出さない', () => {
    const state = buildFreshFirstRunState()
    const result = runFullAnalysis(state)
    const buyNewStock = result.stockCandidates.filter(c => c.action === 'BUY_NEW')
    expect(buyNewStock).toEqual([])
  })

  it('真の初回状態でofficialDecisionは生成される（安全なcommittee判定は動く）', () => {
    const state = buildFreshFirstRunState()
    const result = runFullAnalysis(state)
    expect(result.officialDecision).not.toBeNull()
  })
})
