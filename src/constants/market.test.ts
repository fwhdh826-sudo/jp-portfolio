import { describe, expect, it } from 'vitest'
import { INITIAL_CASH, INITIAL_CASH_RESERVE } from './market'

describe('P0-PRIVACY-HOTFIX: INITIAL_CASH/INITIAL_CASH_RESERVEは個人の実際の現金額を仮定しない', () => {
  it('手動override無効時のfallbackはゼロである（実際の運用判断はT9入力を前提とする）', () => {
    expect(INITIAL_CASH).toBe(0)
    expect(INITIAL_CASH_RESERVE).toBe(0)
  })
})
