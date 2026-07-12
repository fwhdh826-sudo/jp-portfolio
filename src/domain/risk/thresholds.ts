// ═══════════════════════════════════════════════════════════════
// P1-1: Risk Threshold Single Source of Truth
//
// "Threshold" = a value that changes a binary gate, regime label,
// or signal decision.  Continuous scoring formula slope parameters
// (e.g. clamp interpolation anchors) are NOT moved here.
//
// Usage:
//   import { VIX_PANIC, SHORT_BEAR_VIX_TRIGGER } from '../../domain/risk/thresholds'
// ═══════════════════════════════════════════════════════════════

// ── General VIX thresholds ───────────────────────────────────
// Re-exported from constants/market so all consumers can use
// thresholds.ts as the single import point.
export {
  VIX_CALM,
  VIX_NORMAL,
  VIX_WARNING,
  VIX_PANIC,
  NIKKEI_VI_CALM,
  NIKKEI_VI_WARNING,
  NIKKEI_VI_PANIC,
  SQ_BUFFER_DAYS_BEFORE,
  SQ_BUFFER_DAYS_AFTER,
} from '../../constants/market'

// ── Risk Gate ────────────────────────────────────────────────
// VIX level at which the per-stock risk gate closes (no new entries).
// Used in computeAnalysis.ts riskGatePass condition.
// Note: VIX_WARNING (25) is used for score penalties;
//       VIX_HIGH_CAUTION (28) is the hard execution gate.
export const VIX_HIGH_CAUTION = 28

// ── Short-term trust signal boundaries ───────────────────────
// Used in trustPortfolio.ts buildBullConditions / buildBearConditions.

// Bull signal conditions
export const SHORT_BULL_VIX_MAX      = 17   // pass: vix ≤ 17 AND vixChg ≤ 0.2
export const SHORT_BULL_VIX_SOFT     = 19   // warn: vix ≤ 19 AND vixChg ≤ 0.8
export const SHORT_BULL_MIN_SQ_DAYS  = 7    // pass: sqDays ≥ 7
export const SHORT_BULL_SOFT_SQ_DAYS = 5    // warn: sqDays ≥ 5

// Bear signal conditions
export const SHORT_BEAR_VIX_TRIGGER        = 26  // pass: vix ≥ 26 or spike ≥ 5%
export const SHORT_BEAR_VIX_SOFT           = 23  // warn: vix ≥ 23 or spike ≥ 3%
export const SHORT_BEAR_NIKKEI_VI_TRIGGER  = 24  // pass: nikkeiVI ≥ 24 or rising
export const SHORT_BEAR_NIKKEI_VI_SOFT     = 22  // warn: nikkeiVI ≥ 22 or near-flat

// ── Data quality gate ────────────────────────────────────────
// Hours after which market data is considered stale (DQ gate, P0-5).
export const MARKET_DATA_STALE_HOURS = 24

// Hours after which the system analysis result itself is considered
// stale and shown with a UI warning (selectIsStale).
export const SYSTEM_STALE_HOURS = 8

// Hours after which safe_mode.json's last_checked is considered stale
// (P4-A159 / Fable audit A4). A stale snapshot must fail-closed — treated
// the same as SAFE_MODE active — rather than silently trusting old data.
export const SAFE_MODE_STALE_HOURS = 96

// Hours after which a manually-entered cashAssumptions override is shown
// as stale (P4.5-A008). Display-only warning — the manual value itself is
// NOT discarded or reverted to the default; this only surfaces "please
// re-check your funding assumption" in the UI.
export const CASH_ASSUMPTIONS_STALE_HOURS = 24 * 7
