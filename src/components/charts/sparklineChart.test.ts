import { describe, expect, it } from 'vitest'
import { calcSparklinePoints, calcZeroLineY } from './SparklineChart'

describe('SparklineChart — calcSparklinePoints', () => {
  it('空配列は空文字列を返す', () => {
    expect(calcSparklinePoints([], 200, 48)).toBe('')
  })

  it('1点は水平中央線（2点で表現）を返す', () => {
    const result = calcSparklinePoints([5], 200, 48)
    const parts = result.trim().split(' ')
    expect(parts).toHaveLength(2)
    // y座標は中央（高さ48, padding4 → innerH=40 → 中央y=4+20=24）
    expect(parts[0]).toContain(',24')
    expect(parts[1]).toContain(',24')
  })

  it('min===maxのとき中央水平線', () => {
    const result = calcSparklinePoints([3, 3, 3], 200, 48)
    const parts = result.trim().split(' ')
    // 全点のyが同じ（中央）
    const ys = parts.map(p => Number(p.split(',')[1]))
    expect(ys.every(y => Math.abs(y - ys[0]) < 0.01)).toBe(true)
  })

  it('2点以上でpaddingを反映した座標を返す', () => {
    const result = calcSparklinePoints([0, 10], 200, 48, 4)
    const parts = result.trim().split(' ')
    expect(parts).toHaveLength(2)
    // 最初の点はx=padding=4（小数点表記）
    const firstX = Number(parts[0].split(',')[0])
    expect(Math.abs(firstX - 4)).toBeLessThan(0.01)
    // 最後の点はx=200-4=196
    const lastX = Number(parts[1].split(',')[0])
    expect(Math.abs(lastX - 196)).toBeLessThan(0.01)
    // 0（最小）はy=padding+innerH=4+40=44（下端）
    const firstY = Number(parts[0].split(',')[1])
    expect(Math.abs(firstY - 44)).toBeLessThan(0.01)
    // 10（最大）はy=padding=4（上端）
    const lastY = Number(parts[1].split(',')[1])
    expect(Math.abs(lastY - 4)).toBeLessThan(0.01)
  })

  it('3点の中間値は中央付近のy座標', () => {
    const result = calcSparklinePoints([0, 5, 10], 200, 48, 4)
    const parts = result.trim().split(' ')
    const midY = Number(parts[1].split(',')[1])
    // 中間値5は内側高さ40の中央 → y=4+20=24
    expect(Math.abs(midY - 24)).toBeLessThan(0.1)
  })
})

describe('SparklineChart — calcZeroLineY', () => {
  it('空配列はnullを返す', () => {
    expect(calcZeroLineY([], 48)).toBeNull()
  })

  it('1点はnullを返す', () => {
    expect(calcZeroLineY([5], 48)).toBeNull()
  })

  it('全て正の値はnullを返す（ゼロラインが範囲外）', () => {
    expect(calcZeroLineY([1, 2, 3], 48)).toBeNull()
  })

  it('全て負の値はnullを返す', () => {
    expect(calcZeroLineY([-3, -2, -1], 48)).toBeNull()
  })

  it('min=maxはnullを返す', () => {
    expect(calcZeroLineY([0, 0, 0], 48)).toBeNull()
  })

  it('正負が混在するときゼロラインY座標を返す', () => {
    // values=[-10, 10], height=48, padding=4
    // min=-10, max=10, range=20
    // innerH=40, zeroY=4+(1-(-(-10)/20))*40=4+(1-0.5)*40=4+20=24
    const y = calcZeroLineY([-10, 10], 48, 4)
    expect(y).not.toBeNull()
    expect(Math.abs(y! - 24)).toBeLessThan(0.1)
  })

  it('0を含む場合のゼロラインY（下端付近）', () => {
    // values=[0, 10], min=0, max=10 → min=0なのでゼロラインはy=padding+innerH=4+40=44
    const y = calcZeroLineY([0, 10], 48, 4)
    expect(y).not.toBeNull()
    expect(Math.abs(y! - 44)).toBeLessThan(0.1)
  })
})
