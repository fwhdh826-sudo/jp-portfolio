// UI-9H-H1-R1: WATCH の3義（真の監視 / 条件未達WAIT / 抑制されたBUY）のうち、
// H-P0-2 の前回実装では③抑制のみを SUPPRESSED へ分離し、②条件未達WAIT
// （TrustSignalAction==='WAIT' → actionToSignal / shortTermSignal==='WAIT' → signalToSignal）
// は WATCH のまま残っていた。
//
// actionToSignal/signalToSignal は trustPlan（buildTrustPortfolioPlan の出力）経由でのみ
// 到達する表示専用ヘルパーで、実際にWAITを再現するには市況ゲート通過を要する複雑な
// domain fixtureが必要になる。表示専用変換であることを明示するため helper を export し、
// 変換ロジックそのものを直接・非vacuousに固定する。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { signalToSignal, actionToSignal } from './T7_Trust'
import { SignalBadge } from '../badges/SignalBadge'
import type { TrustSignalAction } from '../../domain/optimization/trustPortfolio'

describe('UI-9H-H1-R1: T7 signalToSignal / actionToSignal — 条件未達WAITとWATCHの分離', () => {
  it('signalToSignal(WAIT) は WAIT を返す（WATCHではない）', () => {
    expect(signalToSignal('WAIT')).toBe('WAIT')
    expect(signalToSignal('WAIT')).not.toBe('WATCH')
  })

  it('actionToSignal(WAIT) は WAIT を返す（WATCHではない）', () => {
    expect(actionToSignal('WAIT')).toBe('WAIT')
    expect(actionToSignal('WAIT')).not.toBe('WATCH')
  })

  it('signalToSignal/actionToSignal の BULL/BEAR系マッピングはWAIT分離の影響を受けない（回帰確認）', () => {
    expect(signalToSignal('BULL')).toBe('BUY')
    expect(signalToSignal('BEAR')).toBe('SELL')
    expect(actionToSignal('BUY')).toBe('BUY')
    expect(actionToSignal('BULL')).toBe('BUY')
    expect(actionToSignal('EXIT')).toBe('SELL')
    expect(actionToSignal('TRIM')).toBe('SELL')
    expect(actionToSignal('BEAR')).toBe('SELL')
    const otherAction: TrustSignalAction = 'HOLD' as TrustSignalAction
    expect(actionToSignal(otherAction)).toBe('HOLD')
  })

  it('actionToSignal(WAIT) が生成する WAIT バッジは SignalBadge 上で「待機」となり、「監視」と区別できる', () => {
    const html = renderToStaticMarkup(<SignalBadge signal={actionToSignal('WAIT')} />)
    expect(html).toContain('aria-label="シグナル: 待機"')
    expect(html).not.toContain('aria-label="シグナル: 監視"')
  })

  // mutation guard: signalToSignal/actionToSignal の `return 'WAIT'` を
  // 旧実装の `return 'WATCH'` に戻すと上記の直接呼び出しテストが RED になる。
  it('[mutation guard] WAIT由来のSignalはWATCH/SUPPRESSEDのいずれでもない', () => {
    expect(['WAIT']).toContain(signalToSignal('WAIT'))
    expect(['WAIT']).toContain(actionToSignal('WAIT'))
  })
})
