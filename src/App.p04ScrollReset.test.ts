import { describe, expect, it } from 'vitest'
import { resetScrollOwnerToTop } from './App'
// Vite's `?raw` suffix returns a module's own source text as a plain string (see
// StatusBar.crossTabInvalidation.test.tsx for the established pattern in this repo).
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import appSource from './App.tsx?raw'

describe('P0-4 tab-switch scroll reset', () => {
  it('resets the confirmed scroll owner to (0,0) without a smooth animation', () => {
    const calls: ScrollToOptions[] = []
    resetScrollOwnerToTop({ scrollTo: options => calls.push(options) })
    expect(calls).toEqual([{ top: 0, left: 0, behavior: 'instant' }])
  })

  it('is idempotent when already at the top (no-op visually, still called once)', () => {
    const calls: ScrollToOptions[] = []
    const target = { scrollTo: (options: ScrollToOptions) => calls.push(options) }
    resetScrollOwnerToTop(target)
    resetScrollOwnerToTop(target)
    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.top === 0 && c.left === 0 && c.behavior === 'instant')).toBe(true)
  })

  it('App wires the reset to a useEffect keyed only on activeTab (no unnecessary resets on unrelated re-renders)', () => {
    expect(appSource).toMatch(/useEffect\(\(\) => \{\s*resetScrollOwnerToTop\(window\)\s*\}, \[activeTab\]\)/)
  })

  it('no longer performs the ineffective main-content-ref scrollTo (RCA: main-content never overflows)', () => {
    expect(appSource).not.toContain('mainRef')
  })
})
