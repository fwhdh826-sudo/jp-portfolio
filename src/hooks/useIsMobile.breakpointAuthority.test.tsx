import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { breakpoints } from '../theme/tokens'
import { useIsMobile } from './useIsMobile'

function withStubbedWindow<T>(innerWidth: number, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth },
  })
  try {
    return run()
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'window', original)
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

function Probe({ onRender }: { onRender: (isMobile: boolean) => void }) {
  onRender(useIsMobile())
  return null
}

function readInitialIsMobile(innerWidth: number): boolean {
  let result: boolean | undefined
  withStubbedWindow(innerWidth, () => {
    renderToStaticMarkup(<Probe onRender={(v) => { result = v }} />)
  })
  if (result === undefined) {
    throw new Error('useIsMobile did not render')
  }
  return result
}

describe('UI-9G-G7: mobile breakpoint authority (JS 768 / CSS 839-840px 不整合の解消)', () => {
  it('breakpoints.md は 840 — CSS shellのmobile境界(max-width:839px)とuseIsMobileの契約元が一致する', () => {
    expect(breakpoints.md).toBe(840)
    expect(breakpoints.md - 1).toBe(839)
  })

  it('useIsMobileの初期判定は839pxでmobile、840pxでnon-mobileに切り替わる（旧768境界へのmutationでRED）', () => {
    expect(readInitialIsMobile(839)).toBe(true)
    expect(readInitialIsMobile(840)).toBe(false)
  })
})
