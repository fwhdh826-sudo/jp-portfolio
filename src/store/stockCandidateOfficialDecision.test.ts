// P5-B003: state.stockCandidates（P5-B002b-1で計算済み）を officialDecision.actions へ
// 接続する変換・選定ロジックの単体テスト。
import { describe, expect, it } from 'vitest'
import type { StockCandidateItem, StockCandidateConstraintState } from '../domain/candidates'
import { stockCandidateToOfficialDecisionItem, selectAppendableStockCandidates } from './useAppStore'

function makeConstraints(overrides: Partial<StockCandidateConstraintState> = {}): StockCandidateConstraintState {
  return {
    dqGate: 'pass',
    noTradeGate: 'pass',
    safeMode: 'pass',
    headroomGate: 'pass',
    cashAssumptionsFresh: 'pass',
    cashBudget: 'pass',
    volatility: 'pass',
    ...overrides,
  }
}

function makeStockCandidate(overrides: Partial<StockCandidateItem> = {}): StockCandidateItem {
  return {
    code: '7203',
    name: 'トヨタ自動車',
    sector: '自動車',
    action: 'BUY_NEW',
    score: 80,
    usableAxes: 6,
    maxAmount: 50_000,
    blockedReasons: [],
    constraints: makeConstraints(),
    reason: 'スコア80（有効軸6/6）: PER9.9、ROE10.2%、配当3.5%。新規調査候補。',
    source: 'candidates_stocks',
    ...overrides,
  }
}

// ── stockCandidateToOfficialDecisionItem ────────────────────────
describe('stockCandidateToOfficialDecisionItem', () => {
  it('maps id with candidate-stock- prefix (does not collide with trust candidate-<id>)', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ code: '9984' }))
    expect(result.id).toBe('candidate-stock-9984')
    expect(result.id.startsWith('candidate-stock-')).toBe(true)
  })

  it('sets assetType to stock and code to candidate.code', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ code: '6758' }))
    expect(result.assetType).toBe('stock')
    expect(result.code).toBe('6758')
  })

  it('sets source=candidate, candidateSource=candidates_stocks, isCandidate=true', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate())
    expect(result.source).toBe('candidate')
    expect(result.candidateSource).toBe('candidates_stocks')
    expect(result.isCandidate).toBe(true)
  })

  it('carries action/name/reason through unchanged', () => {
    const candidate = makeStockCandidate({ action: 'WATCH', name: 'ソニーグループ', reason: 'test reason' })
    const result = stockCandidateToOfficialDecisionItem(candidate)
    expect(result.action).toBe('WATCH')
    expect(result.name).toBe('ソニーグループ')
    expect(result.reason).toBe('test reason')
  })

  it('normalizes score to candidateScore on a 0-1 scale', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ score: 72.4 }))
    expect(result.candidateScore).toBeCloseTo(0.724)
  })

  it('sets suggestedAmount/amount/maxAmount for BUY_NEW with positive maxAmount', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ action: 'BUY_NEW', maxAmount: 42_000 }))
    expect(result.suggestedAmount).toBe(42_000)
    expect(result.amount).toBe(42_000)
    expect(result.maxAmount).toBe(42_000)
  })

  it('does not set suggestedAmount/amount for WATCH (only maxAmount, if positive)', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ action: 'WATCH', maxAmount: 30_000 }))
    expect(result.suggestedAmount).toBeUndefined()
    expect(result.amount).toBeUndefined()
    expect(result.maxAmount).toBe(30_000)
  })

  it('leaves maxAmount/suggestedAmount undefined when maxAmount is 0', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ action: 'BLOCKED', maxAmount: 0 }))
    expect(result.maxAmount).toBeUndefined()
    expect(result.suggestedAmount).toBeUndefined()
  })

  it('maps blockedReason to the first blocked reason', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({
      action: 'BLOCKED', blockedReasons: ['SAFE_MODE_ACTIVE', 'JP_STOCK_CAP'],
    }))
    expect(result.blockedReason).toBe('SAFE_MODE_ACTIVE')
  })

  it('maps constraintsPassed to keys with pass, constraintsBlocked to blockedReasons', () => {
    const candidate = makeStockCandidate({
      action: 'BLOCKED',
      constraints: makeConstraints({ safeMode: 'fail', headroomGate: 'fail' }),
      blockedReasons: ['SAFE_MODE_ACTIVE', 'JP_STOCK_CAP'],
    })
    const result = stockCandidateToOfficialDecisionItem(candidate)
    expect(result.constraintsPassed).toEqual(
      expect.arrayContaining(['dqGate', 'noTradeGate', 'cashAssumptionsFresh', 'cashBudget', 'volatility']),
    )
    expect(result.constraintsPassed).not.toContain('safeMode')
    expect(result.constraintsPassed).not.toContain('headroomGate')
    expect(result.constraintsBlocked).toEqual(['SAFE_MODE_ACTIVE', 'JP_STOCK_CAP'])
  })

  it('constraintsBlocked is undefined when there are no blocked reasons', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate({ blockedReasons: [] }))
    expect(result.constraintsBlocked).toBeUndefined()
  })

  it('does not set candidateSizingTier (stock candidates have no sizing tier concept)', () => {
    const result = stockCandidateToOfficialDecisionItem(makeStockCandidate())
    expect(result.candidateSizingTier).toBeUndefined()
  })
})

// ── selectAppendableStockCandidates ────────────────────────────
describe('selectAppendableStockCandidates', () => {
  it('includes only BUY_NEW and WATCH candidates', () => {
    const candidates = [
      makeStockCandidate({ code: 'a', action: 'BUY_NEW' }),
      makeStockCandidate({ code: 'b', action: 'WATCH' }),
      makeStockCandidate({ code: 'c', action: 'BLOCKED' }),
    ]
    const result = selectAppendableStockCandidates(candidates)
    expect(result.map(c => c.code).sort()).toEqual(['a', 'b'])
  })

  it('sorts by score descending', () => {
    const candidates = [
      makeStockCandidate({ code: 'low', action: 'WATCH', score: 55 }),
      makeStockCandidate({ code: 'high', action: 'BUY_NEW', score: 90 }),
      makeStockCandidate({ code: 'mid', action: 'WATCH', score: 70 }),
    ]
    const result = selectAppendableStockCandidates(candidates)
    expect(result.map(c => c.code)).toEqual(['high', 'mid', 'low'])
  })

  it('caps at a maximum of 3 candidates', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeStockCandidate({ code: `c${i}`, action: 'WATCH', score: 60 + i }),
    )
    const result = selectAppendableStockCandidates(candidates)
    expect(result).toHaveLength(3)
    // 上位3件（score降順）が選ばれる
    expect(result.map(c => c.code)).toEqual(['c4', 'c3', 'c2'])
  })

  it('returns an empty array when there are no candidates', () => {
    expect(selectAppendableStockCandidates([])).toEqual([])
  })

  it('returns an empty array when all candidates are BLOCKED', () => {
    const candidates = [makeStockCandidate({ action: 'BLOCKED' }), makeStockCandidate({ code: 'x', action: 'BLOCKED' })]
    expect(selectAppendableStockCandidates(candidates)).toEqual([])
  })
})

// ── end-to-end: 選定 → 変換 の一連の流れ ────────────────────────
describe('selectAppendableStockCandidates + stockCandidateToOfficialDecisionItem 統合', () => {
  it('produces OfficialDecisionItem[] with unique candidate-stock- ids, max 3, score-desc', () => {
    const candidates = [
      makeStockCandidate({ code: '1001', action: 'BUY_NEW', score: 80 }),
      makeStockCandidate({ code: '1002', action: 'WATCH', score: 95 }),
      makeStockCandidate({ code: '1003', action: 'BLOCKED', score: 99 }),
      makeStockCandidate({ code: '1004', action: 'WATCH', score: 60 }),
      makeStockCandidate({ code: '1005', action: 'WATCH', score: 50 }),
    ]
    const items = selectAppendableStockCandidates(candidates).map(stockCandidateToOfficialDecisionItem)
    expect(items).toHaveLength(3)
    expect(items.map(i => i.id)).toEqual(['candidate-stock-1002', 'candidate-stock-1001', 'candidate-stock-1004'])
    expect(items.every(i => i.assetType === 'stock')).toBe(true)
    expect(items.every(i => i.candidateSource === 'candidates_stocks')).toBe(true)
  })
})
