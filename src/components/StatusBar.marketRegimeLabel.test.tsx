// H-P1-1 §6 addendum: StatusBar の label `市場モード`（値=market.regime）は
// `committeeDecision.ts` 生成の MarketMode（通常/警戒/緊急モード）と紛らわしいため
// `市況` へ改称する。domain 側（market.regime の値そのもの）は変更しない。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBar } from './StatusBar'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import statusBarSource from './StatusBar.tsx?raw'

describe('H-P1-1 §6: StatusBarの市場regimeラベルはcanonical`市況`', () => {
  it('canonical: `市況` ラベルが表示される', () => {
    const html = renderToStaticMarkup(<StatusBar />)
    expect(html).toContain('市況')
  })

  // mutation guard: 旧ラベル`市場モード`へ戻すとREDになることを固定する。
  it('[mutation guard] 旧ラベル`市場モード`が残存していない', () => {
    expect(statusBarSource).not.toContain('市場モード')
  })
})
