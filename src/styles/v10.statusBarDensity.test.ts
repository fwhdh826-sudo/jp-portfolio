import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'

// UI-9G G-5: StatusBar (全タブ共通chrome) がmobile幅で `overflow-x:auto` の
// 1行stripに隠れ続け、評価額・最終更新・更新buttonへスクロールでしか到達できなかった
// 問題（P1-3）の回帰防止。narrow fixは既存 `@media (max-width: 839px)` breakpoint値を
// 再利用した`.status-bar`の折返しのみで、新規breakpointは追加しない。

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readSrc(relPath: string): string {
  return readFileSync(resolve(SRC_ROOT, relPath), 'utf8')
}

describe('UI-9G G-5: StatusBar mobile density/到達性', () => {
  it('既存839pxブレークポイントを再利用して.status-barが折返し、strip型横スクロールに依存しなくなっている', () => {
    const css = readSrc('styles/v10.css')

    const dividerIdx = css.indexOf('.status-bar__divider {')
    expect(dividerIdx).toBeGreaterThan(-1)
    const dividerBlockEnd = css.indexOf('}', dividerIdx) + 1

    // narrow fixブロックは既存 .status-bar__divider ルール直後にあり、
    // 新しいbreakpoint値ではなく既存の839pxを再利用している。
    const after = css.slice(dividerBlockEnd, dividerBlockEnd + 400)
    const mediaMatch = after.match(/@media \(max-width:\s*839px\)\s*\{/)
    expect(mediaMatch, `narrow-fix media block not found after .status-bar__divider: ${after}`).not.toBeNull()

    const mediaStart = dividerBlockEnd + mediaMatch!.index!
    const mediaBlock = css.slice(mediaStart, css.indexOf('\n}\n', mediaStart) + 3)

    expect(mediaBlock).toMatch(/\.status-bar\s*\{[^}]*flex-wrap:\s*wrap;[^}]*\}/)
    expect(mediaBlock).toMatch(/\.status-bar\s*\{[^}]*overflow-x:\s*visible;[^}]*\}/)

    // mutation guard: 旧layout（nowrap + overflow-x:autoのまま折返さない）へ戻すと
    // 上記assertがRED化する。
  })

  it('839px超（tablet/desktop）は従来どおり1行表示のまま非破壊（.status-bar本体のoverflow-x:autoとdividerの通常表示を維持）', () => {
    const css = readSrc('styles/v10.css')

    const baseIdx = css.indexOf('.status-bar {')
    expect(baseIdx).toBeGreaterThan(-1)
    const baseBlock = css.slice(baseIdx, css.indexOf('}', baseIdx) + 1)
    // ベース（非media）ルールはUI-9B〜Fの1行stripを維持したまま
    // — flex-wrapを直接wrapに書き換える regression をここで検知する。
    expect(baseBlock).toMatch(/overflow-x:\s*auto;/)
    expect(baseBlock).not.toMatch(/flex-wrap:\s*wrap/)

    const dividerBaseIdx = css.indexOf('.status-bar__divider {')
    const dividerBaseBlock = css.slice(dividerBaseIdx, css.indexOf('}', dividerBaseIdx) + 1)
    // dividerの `display:none` はnarrow-fixのmedia内スコープのみに存在し、
    // ベースルールに紛れ込んでいない（840px以上でdividerが消える regression を検知）。
    expect(dividerBaseBlock).not.toMatch(/display:\s*none/)

    const mediaIdx = css.indexOf('@media (max-width: 839px) {\n  .status-bar {\n    flex-wrap: wrap;')
    expect(mediaIdx).toBeGreaterThan(-1)
    const mediaBlockEnd = css.indexOf('\n}\n', mediaIdx) + 3
    const mediaBlock = css.slice(mediaIdx, mediaBlockEnd)
    expect(mediaBlock).toMatch(/\.status-bar__divider\s*\{\s*display:\s*none;\s*\}/)
  })
})
