/**
 * verdict.ts — 表示専用 verdict 抑制ユーティリティ（UI-9F §6.1(1)）
 *
 * SAFE_MODE / DQ 抑制中に「BUY」を画面へ出さないための表示変換のみを持つ。
 * domain 側の decision / score / candidate 生成には一切触れない
 * （store の fund.decision 等は BUY のまま保持される）。
 *
 * UI-9F-B 時点では T2 / T3 / T4 / T7 の Signal 系のみを一本化する。
 * T0 / T6 の DisplayDecision 系（BUY→WAIT）と T1 の DATA_WAIT/WAIT の
 * 2状態区別は F-P1-1 の担当であり、ここでは統合しない。
 */

import type { Signal } from '../badges/SignalBadge'

/**
 * 抑制時に BUY の代わりに表示する verdict token。
 * UI-9H H-P0-2: 旧 'WATCH' は「真の監視」「条件未達WAIT」「抑制されたBUY」の
 * 3義が同一グリフに潰れており区別不能だった。抑制は専用の 'SUPPRESSED' トークンへ、
 * 条件未達WAITは各タブの decisionToSignal/actionToSignal 等で 'WAIT' トークンへ
 * それぞれ分離した（表示専用。domain の decision には触れない）。
 */
export const SUPPRESSED_VERDICT: Signal = 'SUPPRESSED'

/**
 * 抑制中は BUY 表示のみ WATCH に変換する（表示専用）。
 * SELL / HOLD / WATCH はそのまま維持し、防御・監視表示を弱めない。
 */
export function suppressBuySignal(signal: Signal, isSuppressed: boolean): Signal {
  return isSuppressed && signal === 'BUY' ? SUPPRESSED_VERDICT : signal
}
