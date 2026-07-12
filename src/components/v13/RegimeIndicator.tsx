// ── Regime Indicator — v13.3 新規コンポーネント ─────────────────
// 参照: docs/v13.3/07_v13.3_spec.md Section 12.1
// 参照: docs/constitution/CLAUDE_DESIGN_BRIEF.md Section 2
//
// 純粋表示コンポーネント。レジーム検出ロジック・金融計算は含まない。
// データは親から Props で受け取る。

import type { CSSProperties } from 'react'
import { REGIME_DISPLAY_META } from '../../types/regime'
import type { RegimeId } from '../../types/regime'
import { colors, radius, shadow, spacing, font } from '../../theme/tokens'

interface Props {
  regime: RegimeId
  consensus: number          // 0.0 ~ 1.0
  structuralChanges: string[]
  changedAt: string          // ISO8601
}

function formatChangedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function RegimeIndicator({ regime, consensus, structuralChanges, changedAt }: Props) {
  const display = REGIME_DISPLAY_META[regime]

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing[2],
    padding: `${spacing[2]} ${spacing[3]}`,
    background: colors.bgSurface,
    borderRadius: radius.md,
    boxShadow: shadow.sm,
    borderLeft: `4px solid ${display.colorVar}`,
  }

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: spacing[2],
    flexWrap: 'wrap',
  }

  const labelStyle: CSSProperties = {
    fontWeight: 600,
    fontSize: font.sm,
    color: colors.textPrimary,
  }

  const consensusStyle: CSSProperties = {
    fontSize: font.xs,
    color: colors.textSubtle,
    background: colors.bgElevated,
    padding: `${spacing['0.5']} ${spacing[2]}`,
    borderRadius: radius.full,
  }

  const changesBoxStyle: CSSProperties = {
    fontSize: font.xs,
    color: colors.textSecond,
    padding: `${spacing['1.5']} ${spacing[2]}`,
    background: colors.bgElevated,
    borderRadius: radius.sm,
  }

  const changesListStyle: CSSProperties = {
    margin: `${spacing[1]} 0 0 ${spacing[4]}`,
    paddingLeft: 0,
  }

  const metaStyle: CSSProperties = {
    fontSize: font.xs,
    color: colors.textMuted,
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span role="img" aria-label={display.label}>{display.icon}</span>
        <span style={labelStyle}>市況: {display.label}</span>
        <span style={consensusStyle}>
          合意度 {(consensus * 100).toFixed(0)}%
        </span>
      </div>

      {structuralChanges.length > 0 && (
        <div style={changesBoxStyle}>
          ⚠️ 構造変化検出:
          <ul style={changesListStyle}>
            {structuralChanges.map((change, i) => (
              <li key={i}>{change}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={metaStyle}>変化: {formatChangedAt(changedAt)}</div>
    </div>
  )
}
