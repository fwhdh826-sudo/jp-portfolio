// P4.5-A003: findHoldingName — 銘柄コード比較表示への企業名併記のためのlookupヘルパー
import { describe, expect, it } from 'vitest'
import { findHoldingName } from './format'

describe('findHoldingName', () => {
  const holdings = [
    { code: '6501', name: '日立製作所' },
    { code: '7203', name: 'トヨタ自動車' },
  ]

  it('codeが一致するholdingsのnameを返す', () => {
    expect(findHoldingName('6501', holdings)).toBe('日立製作所')
    expect(findHoldingName('7203', holdings)).toBe('トヨタ自動車')
  })

  it('一致するcodeがない場合はnullを返す（コードのみ表示へfallback）', () => {
    expect(findHoldingName('9999', holdings)).toBeNull()
  })

  it('holdingsが空配列の場合はnullを返す', () => {
    expect(findHoldingName('6501', [])).toBeNull()
  })
})
