import type { SafeModeSnapshot, TierAViolationsSnapshot, TierAAlertsSnapshot } from '../../types'
import type { TierAT1Violation } from '../../domain/constraints/tierAT1'
import { computeSafeModeDataQuality } from '../../store/selectors'
import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CSSProperties } from 'react'

interface Props {
  safeMode: SafeModeSnapshot
  safeModeSource: 'loaded' | 'default' | undefined
  /** P4-A159: safe_mode.jsonのsafe_mode.last_checked（鮮度判定用）。未指定時はstale扱い。 */
  safeModeLastChecked?: string | null
  tierAViolations: TierAViolationsSnapshot
  tierAAlerts: TierAAlertsSnapshot
  /** P4-A150: 省略可能。渡された場合のみTierA T1（含み損-40%以下）警告を表示する */
  tierAT1Violations?: TierAT1Violation[]
}

const VIOLATION_LABEL: Record<string, string> = {
  T1: 'T1 ストップロス',
  T2: 'T2 セクター集中',
  T3: 'T3 PFドローダウン',
  T4: 'T4 VIX急騰',
}

const ALERT_LABEL: Record<string, string> = {
  L1: 'L1 緊急',
  L2: 'L2 警告',
  L3: 'L3 注意',
  OPPORTUNITY: 'OPPORTUNITY',
}

// P4-A150: TierA監視データが取得不可の場合、「違反なし」と区別して不可視にしないための判定。
// 表示コンポーネントから切り離した純関数としてexportし、単体テスト可能にする。
export function isTierADataUnavailable(
  tierAViolations: Pick<TierAViolationsSnapshot, 'status'>,
  tierAAlerts: Pick<TierAAlertsSnapshot, 'status'>,
): boolean {
  return tierAViolations.status === 'unavailable' || tierAAlerts.status === 'unavailable'
}

export interface SafeModeCardVisibilityInput {
  active: boolean
  isDefault: boolean
  triggeredViolationsCount: number
  triggeredAlertsCount: number
  isTierAUnavailable: boolean
  t1ViolationsCount: number
  /** P4-A159: safe_mode.jsonはloadedしたがlast_checkedが古い/不正/欠損 */
  isStaleData?: boolean
}

// P4-A150: カード全体を非表示（silentに消す）にするかどうかの判定。純関数化してテスト可能にする。
export function shouldShowSafeModeStatusCard(input: SafeModeCardVisibilityInput): boolean {
  return (
    input.active ||
    input.isDefault ||
    input.triggeredViolationsCount > 0 ||
    input.triggeredAlertsCount > 0 ||
    input.isTierAUnavailable ||
    input.t1ViolationsCount > 0 ||
    (input.isStaleData ?? false)
  )
}

// P4-A159: sourceがdefault（取得不可）の場合は既存のisDefault表示で既にカバーされているため、
// ここでの新規stale表示はsource='loaded'だがlast_checkedが古い/不正/欠損の場合に限定する。
// 純関数として切り出し、isDefaultとの重複回避ロジックを単体テスト可能にする。
export function isSafeModeDataStale(
  dataQuality: { isStale: boolean },
  isDefault: boolean,
): boolean {
  return dataQuality.isStale && !isDefault
}

export function SafeModeStatusCard({ safeMode, safeModeSource, safeModeLastChecked, tierAViolations, tierAAlerts, tierAT1Violations }: Props) {
  const active = safeMode.safe_mode.active
  const isDefault = safeModeSource === 'default' || safeModeSource == null

  const dataQuality = computeSafeModeDataQuality(safeModeLastChecked, safeModeSource)
  const isStaleData = isSafeModeDataStale(dataQuality, isDefault)

  const triggeredViolations = tierAViolations.violations.filter(v => v.triggered)
  const triggeredAlerts = tierAAlerts.alerts.filter(a => a.triggered)

  const isTierAUnavailable = isTierADataUnavailable(tierAViolations, tierAAlerts)
  const t1Violations = tierAT1Violations ?? []

  const hasAnything = shouldShowSafeModeStatusCard({
    active,
    isDefault,
    triggeredViolationsCount: triggeredViolations.length,
    triggeredAlertsCount: triggeredAlerts.length,
    isTierAUnavailable,
    t1ViolationsCount: t1Violations.length,
    isStaleData,
  })
  if (!hasAnything) return null

  const isRealSafeMode = active && !isDefault

  const bannerStyle: CSSProperties = {
    padding:      `${spacing[3]} ${spacing[4]}`,
    borderRadius: radius.md,
    border:       `1px solid ${isRealSafeMode ? colors.sellBorder : colors.waitBorder}`,
    background:   isRealSafeMode ? colors.sellBg : colors.waitBg,
  }

  const titleColor = isRealSafeMode ? colors.sellText : colors.waitText
  const tagStyle: CSSProperties = {
    ...typography.badge,
    padding:      `${spacing[0.5]} ${spacing[1.5]}`,
    borderRadius: radius.full,
    background:   isRealSafeMode ? colors.sellBg : colors.waitBg,
    color:        titleColor,
    border:       `1px solid ${isRealSafeMode ? colors.sellBorder : colors.waitBorder}`,
    flexShrink:   0,
  }

  const violationTagStyle: CSSProperties = {
    ...typography.badge,
    padding:      `${spacing[0.5]} ${spacing[1.5]}`,
    borderRadius: radius.full,
    background:   colors.sellBg,
    color:        colors.sellText,
    border:       `1px solid ${colors.sellBorder}`,
    flexShrink:   0,
  }

  const alertTagStyle: CSSProperties = {
    ...typography.badge,
    padding:      `${spacing[0.5]} ${spacing[1.5]}`,
    borderRadius: radius.full,
    background:   colors.waitBg,
    color:        colors.waitText,
    border:       `1px solid ${colors.waitBorder}`,
    flexShrink:   0,
  }

  return (
    <div style={bannerStyle} role="alert" aria-label="SAFE_MODE / TierA状態">

      {/* SAFE_MODE ステータス */}
      {active && (
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap', marginBottom: spacing[2] }}>
          <span style={tagStyle}>
            {isRealSafeMode ? '🔴 SAFE_MODE発動中' : '🟡 安全側停止（データ未取得）'}
          </span>
          <span style={{ ...typography.bodySmall, color: titleColor, fontWeight: 600 }}>
            {isRealSafeMode ? 'SAFE_MODE発動 — 新規買付全停止中' : 'safe_mode.json 未取得 — フォールバック停止中'}
          </span>
        </div>
      )}

      {/* 説明テキスト */}
      {active && (
        <p style={{ ...typography.caption, color: isRealSafeMode ? colors.sellText : colors.waitText, marginBottom: (triggeredViolations.length > 0 || triggeredAlerts.length > 0) ? spacing[2] : 0 }}>
          {isRealSafeMode
            ? `BUY候補はSAFE_MODE_ACTIVEでブロックされています。${safeMode.safe_mode.trigger_reason ? `原因: ${safeMode.safe_mode.trigger_reason}` : ''}`
            : 'safe_mode.json が取得できないため、安全側のデフォルト（新規買付停止）が適用されています。データ取得後に自動解除されます。'
          }
        </p>
      )}

      {/* P4-A159: SAFE_MODEデータ鮮度問題 — safe_mode.jsonがloadedしたがlast_checkedが古い/不正/欠損 */}
      {isStaleData && (
        <div style={{ marginTop: active ? spacing[2] : 0 }}>
          <span style={tagStyle}>🟠 SAFE_MODEデータ鮮度問題</span>
          <p style={{ ...typography.caption, color: titleColor, marginTop: spacing[1] }}>
            SAFE_MODEデータが古い / 取得不可 — 新規買付は安全側停止しています。
            {dataQuality.reason ? `（${dataQuality.reason}）` : ''}
          </p>
        </div>
      )}

      {/* TierA Violations */}
      {triggeredViolations.length > 0 && (
        <div style={{ marginTop: active ? spacing[2] : 0 }}>
          <div style={{ ...typography.caption, color: colors.textSubtle, marginBottom: spacing[1] }}>
            TierA Hard Gate 発動
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing[1] }}>
            {triggeredViolations.map(v => (
              <span key={v.code} style={violationTagStyle} title={v.message}>
                {VIOLATION_LABEL[v.code] ?? v.code}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* TierA Alerts */}
      {triggeredAlerts.length > 0 && (
        <div style={{ marginTop: spacing[2] }}>
          <div style={{ ...typography.caption, color: colors.textSubtle, marginBottom: spacing[1] }}>
            TierA アラート発報
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing[1] }}>
            {triggeredAlerts.map(a => (
              <span key={a.code} style={alertTagStyle} title={a.message}>
                {ALERT_LABEL[a.code] ?? a.code}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* P4-A150: TierA監視データ取得不可 — 「違反なし」と区別して不可視にしない */}
      {isTierAUnavailable && (
        <div style={{ marginTop: (active || triggeredViolations.length > 0 || triggeredAlerts.length > 0) ? spacing[2] : 0 }}>
          <span style={alertTagStyle}>⚠ TierA監視データ取得不可</span>
          <p style={{ ...typography.caption, color: colors.waitText, marginTop: spacing[1] }}>
            違反判定は完全ではありません。TierAの自動監視データが取得できていないため、
            表示されている「違反なし」は保証されません。
          </p>
        </div>
      )}

      {/* P4-A150: TierA T1（ストップロス-40%）警告 — 検出専用。自動売却は行わない */}
      {t1Violations.length > 0 && (
        <div style={{ marginTop: spacing[2] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap', marginBottom: spacing[1] }}>
            <span style={violationTagStyle}>🔴 TierA T1警告 — 含み損-40%以下</span>
          </div>
          <p style={{ ...typography.caption, color: colors.sellText, marginBottom: spacing[1] }}>
            強制売却ルール対象。ただし最終判断は人間が行う（自動売却は行いません）。
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing[1] }}>
            {t1Violations.map(v => (
              <span
                key={v.code}
                style={violationTagStyle}
                title={v.locked ? 'ロック中でも警告表示（自動売却なし）' : undefined}
              >
                {v.name}（{v.code}） {v.pnlPct.toFixed(1)}%{v.locked ? ' 🔒' : ''}
              </span>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
