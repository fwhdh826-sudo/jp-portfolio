import { describe, expect, it } from 'vitest'
import { deriveDisplayDecision } from './displayDecision'
import type { OfficialDecisionItem } from '../../types'

function makeAction(action: OfficialDecisionItem['action']): OfficialDecisionItem {
  return {
    id: 'test-stock-1',
    assetType: 'stock',
    name: 'テスト株',
    action,
    reason: 'test',
    source: 'committee',
  }
}

describe('deriveDisplayDecision', () => {
  describe('capExceeded=false / undefined — 既存挙動を維持', () => {
    it('BUY → BUY', () => {
      expect(deriveDisplayDecision({ hDecision: 'BUY', dqSuppressed: false, locked: false })).toBe('BUY')
    })
    it('HOLD → HOLD', () => {
      expect(deriveDisplayDecision({ hDecision: 'HOLD', dqSuppressed: false, locked: false })).toBe('HOLD')
    })
    it('SELL → SELL', () => {
      expect(deriveDisplayDecision({ hDecision: 'SELL', dqSuppressed: false, locked: false })).toBe('SELL')
    })
    it('SELL + locked → WAIT', () => {
      expect(deriveDisplayDecision({ hDecision: 'SELL', dqSuppressed: false, locked: true })).toBe('WAIT')
    })
    it('BUY + dqSuppressed → DATA_WAIT', () => {
      expect(deriveDisplayDecision({ hDecision: 'BUY', dqSuppressed: true, locked: false })).toBe('DATA_WAIT')
    })
    it('officialAction=BUY → BUY', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('BUY'), dqSuppressed: false, locked: false,
      })).toBe('BUY')
    })
    it('officialAction=SELL + locked → WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('SELL'), dqSuppressed: false, locked: true,
      })).toBe('WAIT')
    })
    it('officialAction=SELL + not locked → SELL', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('SELL'), dqSuppressed: false, locked: false,
      })).toBe('SELL')
    })
    it('officialAction=BLOCKED → WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', officialAction: makeAction('BLOCKED'), dqSuppressed: false, locked: false,
      })).toBe('WAIT')
    })
    it('officialAction=BUY + dqSuppressed → DATA_WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('BUY'), dqSuppressed: true, locked: false,
      })).toBe('DATA_WAIT')
    })
  })

  describe('capExceeded=true — 国内個別株上限超過（PortfolioPolicy.jpStockMaxRatioで可変）', () => {
    it('BUY + capExceeded → WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: false, locked: false, capExceeded: true,
      })).toBe('WAIT')
    })

    it('officialAction=BUY + capExceeded → WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('BUY'), dqSuppressed: false, locked: false, capExceeded: true,
      })).toBe('WAIT')
    })

    it('BUY + capExceeded + dqSuppressed → DATA_WAIT（dqSuppressed が優先）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: true, locked: false, capExceeded: true,
      })).toBe('DATA_WAIT')
    })

    it('officialAction=BUY + capExceeded + dqSuppressed → DATA_WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('BUY'), dqSuppressed: true, locked: false, capExceeded: true,
      })).toBe('DATA_WAIT')
    })

    it('SELL + capExceeded (not locked) → SELL（cap は BUY にのみ作用）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'SELL', dqSuppressed: false, locked: false, capExceeded: true,
      })).toBe('SELL')
    })

    it('SELL + capExceeded + locked → WAIT（ロックゲートが適用される）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'SELL', dqSuppressed: false, locked: true, capExceeded: true,
      })).toBe('WAIT')
    })

    it('HOLD + capExceeded → HOLD（cap は BUY にのみ作用）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', dqSuppressed: false, locked: false, capExceeded: true,
      })).toBe('HOLD')
    })

    it('officialAction=SELL + capExceeded (not locked) → SELL', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('SELL'), dqSuppressed: false, locked: false, capExceeded: true,
      })).toBe('SELL')
    })
  })

  // P4-A149: SAFE_MODE表示ゲート（Fable監査S3後半対応）
  // officialActionが存在しない銘柄（SAFE_MODE中はzeroBase.ts側でBUY提案自体が
  // 生成されないため、その銘柄のofficialActionが見つからないケースが増える）でも
  // hDecisionへのフォールバック時にBUYを表示させないためのゲート。
  describe('safeModeActive=true — SAFE_MODE発動中のBUY表示抑制（P4-A149）', () => {
    it('BUY + safeModeActive → WAIT（officialActionなし・hDecisionへのフォールバック経路）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: false, locked: false, safeModeActive: true,
      })).toBe('WAIT')
    })

    it('SELL + safeModeActive → SELL（SAFE_MODEはBUYのみ抑制。SELLは維持）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'SELL', dqSuppressed: false, locked: false, safeModeActive: true,
      })).toBe('SELL')
    })

    it('HOLD + safeModeActive → HOLD（不必要に変換しない）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', dqSuppressed: false, locked: false, safeModeActive: true,
      })).toBe('HOLD')
    })

    it('officialAction=BUY + safeModeActive → WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('BUY'), dqSuppressed: false, locked: false, safeModeActive: true,
      })).toBe('WAIT')
    })

    it('officialAction=SELL + safeModeActive（not locked） → SELL（防御行動は維持）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('SELL'), dqSuppressed: false, locked: false, safeModeActive: true,
      })).toBe('SELL')
    })

    it('officialAction=WATCH相当（MONITOR） + safeModeActive → HOLD（監視系は維持）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('MONITOR'), dqSuppressed: false, locked: false, safeModeActive: true,
      })).toBe('HOLD')
    })

    it('BUY + safeModeActive + dqSuppressed → DATA_WAIT（dqSuppressedが最優先）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: true, locked: false, safeModeActive: true,
      })).toBe('DATA_WAIT')
    })

    it('officialAction=BUY + safeModeActive + dqSuppressed → DATA_WAIT', () => {
      expect(deriveDisplayDecision({
        hDecision: 'HOLD', officialAction: makeAction('BUY'), dqSuppressed: true, locked: false, safeModeActive: true,
      })).toBe('DATA_WAIT')
    })

    it('BUY + safeModeActive + capExceeded → WAIT（両方WAITだが優先順位はsafeModeActiveが先）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: false, locked: false, safeModeActive: true, capExceeded: true,
      })).toBe('WAIT')
    })

    it('SELL + safeModeActive + locked → WAIT（既存のロックゲートは維持される）', () => {
      expect(deriveDisplayDecision({
        hDecision: 'SELL', dqSuppressed: false, locked: true, safeModeActive: true,
      })).toBe('WAIT')
    })

    it('safeModeActive=false（既存/省略時） → 既存挙動を維持', () => {
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: false, locked: false, safeModeActive: false,
      })).toBe('BUY')
      expect(deriveDisplayDecision({
        hDecision: 'BUY', dqSuppressed: false, locked: false,
      })).toBe('BUY')
    })
  })
})
