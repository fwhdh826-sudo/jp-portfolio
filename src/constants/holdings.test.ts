import { describe, expect, it } from 'vitest'
// @types/node is not installed in this project (consistent with the existing
// `import.meta as unknown as {...}` casts elsewhere in the codebase). These
// Node built-ins are only used here to verify the repo's file layout during
// tests and are never part of the app bundle.
// @ts-expect-error - no @types/node in this project
import { existsSync, readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { INITIAL_HOLDINGS } from './holdings'

// P4.5-A010-1a: public/data/holdings.json・public/data/trust_master.jsonは
// 個人の保有実額・投信実額・口座種別を含むため、GitHub Pages配信対象から
// 削除した（handover.md参照）。従来このファイルは削除済みのpublic/data/holdings.json
// を直接importしてconstants/holdings.tsとの整合性を検証していたが、削除対象を
// importする以上その目的は成立しなくなったため、「実額JSONが誤って再コミットされて
// いないか」を検証する再公開防止guardへ転用する。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GITIGNORE_PATH = resolve(REPO_ROOT, '.gitignore')
const PUBLIC_HOLDINGS_PATH = resolve(REPO_ROOT, 'public/data/holdings.json')
const PUBLIC_TRUST_MASTER_PATH = resolve(REPO_ROOT, 'public/data/trust_master.json')

describe('P4.5-A010-1a: public実額JSON再公開防止guard', () => {
  it('public/data/holdings.json が存在しない（個人の保有実額を再公開しない）', () => {
    expect(existsSync(PUBLIC_HOLDINGS_PATH)).toBe(false)
  })

  it('public/data/trust_master.json が存在しない（個人の投信実額・口座種別を再公開しない）', () => {
    expect(existsSync(PUBLIC_TRUST_MASTER_PATH)).toBe(false)
  })

  // セキュリティレビュー指摘対応: .toContain()によるサブストリング一致は、
  // コメントアウトされた行（例: "# public/data/holdings.json"）でも素通りして
  // しまう弱いガードだったため、コメント・空行を除いた「有効な行」として
  // 完全一致することを検証するよう強化した。
  function activeGitignoreLines(): string[] {
    const raw: string = readFileSync(GITIGNORE_PATH, 'utf-8')
    return raw
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith('#'))
  }

  it('.gitignore が public/data/holdings.json を有効な行として再コミット防止している', () => {
    expect(activeGitignoreLines()).toContain('public/data/holdings.json')
  })

  it('.gitignore が public/data/trust_master.json を有効な行として再コミット防止している', () => {
    expect(activeGitignoreLines()).toContain('public/data/trust_master.json')
  })

  // P0-PRIVACY-HOTFIX: レガシースナップショット（repo root直下のdata/holdings.json・
  // data/trust_master.json）は旧世代の個人実額を含みgit管理されていたため、
  // git rm --cachedで管理から外した。ローカルファイルはparse_sbi.py用に残すため、
  // 再コミット防止を.gitignoreで固定する。
  it('.gitignore が data/holdings.json を有効な行として再コミット防止している', () => {
    expect(activeGitignoreLines()).toContain('data/holdings.json')
  })

  it('.gitignore が data/trust_master.json を有効な行として再コミット防止している', () => {
    expect(activeGitignoreLines()).toContain('data/trust_master.json')
  })
})

describe('P0-PRIVACY-HOTFIX: INITIAL_HOLDINGSは個人の実保有を仮定しない', () => {
  it('INITIAL_HOLDINGSは空配列である（CSV/localStorage/snapshotがsource of truth）', () => {
    expect(INITIAL_HOLDINGS).toEqual([])
  })

  // 個人の実評価額・実取得日をこのテストのソースに埋め込まずに、銘柄別の
  // 静的eval/acquiredAtテーブル（旧BASE_HOLDINGS/ACQUIRED_AT_BY_CODE相当）の
  // 再導入を構造的に検知する（既知の実額リテラルを列挙する方式はそれ自体が
  // 個人データをtest sourceへ残すことになるため採らない）。
  it('holdings.ts のソースに銘柄別の静的eval/acquiredAtテーブルが存在しない', () => {
    const raw: string = readFileSync(resolve(REPO_ROOT, 'src/constants/holdings.ts'), 'utf-8')
    expect(raw).not.toMatch(/\beval\s*:\s*-?\d/)
    expect(raw).not.toMatch(/\bacquiredAt\s*:\s*['"]\d{4}-\d{2}-\d{2}['"]/)
    expect(raw).not.toMatch(/BASE_HOLDINGS/)
    expect(raw).not.toMatch(/ACQUIRED_AT_BY_CODE/)
  })
})

describe('INITIAL_HOLDINGS: acquiredAt 欠損ガード', () => {
  it('INITIAL_HOLDINGS の全銘柄に acquiredAt が存在する', () => {
    const missing = INITIAL_HOLDINGS.filter(h => !h.acquiredAt)
    expect(missing.map(h => h.code), `acquiredAt が欠損している code: ${missing.map(h => h.code).join(', ')}`).toEqual([])
  })

  it('INITIAL_HOLDINGS の lock=true 銘柄に acquiredAt が存在する', () => {
    const lockedMissing = INITIAL_HOLDINGS.filter(h => h.lock && !h.acquiredAt)
    expect(
      lockedMissing.map(h => h.code),
      `lock=true なのに acquiredAt が欠損している code: ${lockedMissing.map(h => h.code).join(', ')}`,
    ).toEqual([])
  })
})
