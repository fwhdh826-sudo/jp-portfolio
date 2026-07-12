/**
 * MacroSignalBadge — Card 4-10
 * MacroSignal 1件を視覚的に表示するバッジコンポーネント。
 * direction に応じて色分け: positive=teal / negative=red / neutral=gray
 */
import type { MacroSignalUI } from '../../types/market_intel'

const DIRECTION_ICON: Record<string, string> = {
  positive: '↑',
  negative: '↓',
  neutral:  '→',
}

const STRENGTH_LABEL: Record<string, string> = {
  strong:   '強',
  moderate: '中',
  weak:     '弱',
}

interface Props {
  signal: MacroSignalUI
}

export function MacroSignalBadge({ signal }: Props) {
  const icon   = DIRECTION_ICON[signal.direction] ?? '→'
  const str    = STRENGTH_LABEL[signal.strength]  ?? signal.strength
  const dirCls = `macro-signal-badge--${signal.direction}`

  return (
    <span className={`macro-signal-badge ${dirCls}`} title={`${signal.tag} / ${signal.strength}`}>
      <span aria-hidden="true">{icon}</span>
      {signal.tag}
      <span style={{ opacity: 0.7, fontSize: 9 }}>{str}</span>
    </span>
  )
}
