// P4-A143: BUY表示抑制ゲートの共通化。officialDecision.dataQualitySuppressed（分析実行時に凍結される値）と
// dq.isSuppressed（レンダー時点で再評価される実時間値）を両方ORすることで、アプリを開いたまま
// データ鮮度境界を跨いだ場合のカード間表示矛盾（P4-A142監査で確認）を防ぐ。表示専用、投資判断ロジックには影響しない。
//
// UI-9I Phase 2B-2R: 旧 T0_Home 内の private 関数を、レガシー T0_Home と R4.1 Today の
// 両方が同じ式を使えるよう、挙動を変えずにここへ移した（新しい SAFE_MODE / DQ 推論はここに作らない）。
export function computeBuyDisplaySuppressed(
  dataQualitySuppressed: boolean,
  dqIsSuppressed: boolean,
  safeModeActive: boolean,
): boolean {
  return safeModeActive || dataQualitySuppressed || dqIsSuppressed
}
