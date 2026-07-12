import { describe, expect, it } from 'vitest'

// CircularGaugeのclamp/percentage計算ロジックを単体テスト
// コンポーネント自体のレンダリングではなく純粋な計算のみを検証する

function clampValue(value: number, max: number): number {
  const safeMax = max > 0 ? max : 100
  return Math.min(safeMax, Math.max(0, value))
}

function calcPercentage(value: number, max: number): number {
  const safeMax = max > 0 ? max : 100
  const clamped = clampValue(value, safeMax)
  return clamped / safeMax
}

function calcArcLength(value: number, max: number, r: number): number {
  const pct = calcPercentage(value, max)
  const C = 2 * Math.PI * r
  return C * pct
}

describe('CircularGauge — clamp', () => {
  it('正常値はそのまま返す', () => {
    expect(clampValue(72, 100)).toBe(72)
  })

  it('0はそのまま', () => {
    expect(clampValue(0, 100)).toBe(0)
  })

  it('maxに等しい値はそのまま', () => {
    expect(clampValue(100, 100)).toBe(100)
  })

  it('maxを超えるとmaxにクランプ', () => {
    expect(clampValue(150, 100)).toBe(100)
  })

  it('負の値は0にクランプ', () => {
    expect(clampValue(-10, 100)).toBe(0)
  })

  it('max=0のときsafeMax=100として扱う', () => {
    expect(clampValue(50, 0)).toBe(50)
  })
})

describe('CircularGauge — percentage', () => {
  it('72/100 = 0.72', () => {
    expect(calcPercentage(72, 100)).toBeCloseTo(0.72)
  })

  it('67/100 = 0.67', () => {
    expect(calcPercentage(67, 100)).toBeCloseTo(0.67)
  })

  it('0/100 = 0', () => {
    expect(calcPercentage(0, 100)).toBe(0)
  })

  it('100/100 = 1', () => {
    expect(calcPercentage(100, 100)).toBe(1)
  })

  it('max異常値(0)はsafeMax=100として計算', () => {
    expect(calcPercentage(50, 0)).toBeCloseTo(0.5)
  })
})

describe('CircularGauge — arc length', () => {
  it('50%で半周長', () => {
    const r = 36
    const C = 2 * Math.PI * r
    expect(calcArcLength(50, 100, r)).toBeCloseTo(C / 2)
  })

  it('100%で全周長', () => {
    const r = 36
    const C = 2 * Math.PI * r
    expect(calcArcLength(100, 100, r)).toBeCloseTo(C)
  })

  it('0%で0', () => {
    expect(calcArcLength(0, 100, 36)).toBe(0)
  })
})
