// H-P1-1: SAFE_MODE / DQ 抑制の banner/caption/reason 文言 authority。
// 「SAFE_MODE と DQ が結合した抑制」を示す表示はすべてこの prefix・helper を経由し、
// 区切り ` / `・接続 ` — `・状態語 `抑制中` を統一する。scope 語（新規買い判断/追加投資判断/
// 買付・売却の実行判断/買付/配分調整 等）はタブごとに呼出側が指定し、本 helper では固定しない。
//
// 対象外: T0_Home / SafeModeStatusCard の「SAFE_MODE 単独（DQ 結合なし）」banner
// （`発動中`/`発動` を用いる別文脈のため、本 helper を適用しない）。
export const SUPPRESSION_BANNER_PREFIX = 'SAFE_MODE / DQ抑制中'

export function suppressionBannerText(scope: string): string {
  return `⚠ ${SUPPRESSION_BANNER_PREFIX} — ${scope}停止中`
}
