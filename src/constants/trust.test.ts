import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import { INITIAL_TRUST } from './trust'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('P0-PRIVACY-HOTFIX: INITIAL_TRUSTは個人の実保有を仮定しない', () => {
  it('INITIAL_TRUSTの全ファンドがeval=0・pnlPct=0・dayPct=0である（CSV/localStorage/snapshotがsource of truth）', () => {
    const nonZero = INITIAL_TRUST.filter(t => t.eval !== 0 || t.pnlPct !== 0 || t.dayPct !== 0)
    expect(
      nonZero.map(t => t.id),
      `eval/pnlPct/dayPctが非ゼロのfund id: ${nonZero.map(t => t.id).join(', ')}`,
    ).toEqual([])
  })

  it('registry metadata（id/name/abbr/account/policy/cost/mu/sigma）は維持されている', () => {
    expect(INITIAL_TRUST.length).toBeGreaterThan(0)
    for (const t of INITIAL_TRUST) {
      expect(t.id).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.abbr).toBeTruthy()
      expect(t.account).toBeTruthy()
      expect(t.policy).toBeTruthy()
      expect(typeof t.cost).toBe('number')
      expect(typeof t.mu).toBe('number')
      expect(typeof t.sigma).toBe('number')
    }
  })

  it('同名複数account fundのmatching identityであるaccountフィールドが失われていない', () => {
    // S&P500系（特定/NISA成長/NISA積立）・FANG+系（特定/NISA成長/NISA積立）は
    // 同名複数accountのregistryであり、accountで一意に区別される。
    const sp500Accounts = INITIAL_TRUST.filter(t => t.name.includes('S&P500')).map(t => t.account)
    expect(new Set(sp500Accounts).size).toBeGreaterThan(1)
  })

  // 個人の実評価額をこのテストのソースに埋め込まずに、ファンド別の非ゼロeval
  // 静的リテラルの再導入を構造的に検知する(既知の実額リテラルを列挙する方式は
  // それ自体が個人データをtest sourceへ残すことになるため採らない)。
  // EMBEDDED_GOLD_EXPOSURE の navGoldExposure/grossGoldShare は目論見書由来の
  // 公開比率でありfund registryのeval/pnlPct/dayPctとは無関係のため対象外。
  it('trust.ts のソースにファンド別の非ゼロeval静的リテラルが存在しない', () => {
    const raw: string = readFileSync(resolve(REPO_ROOT, 'src/constants/trust.ts'), 'utf-8')
    const nonZeroEvalLiterals = [...raw.matchAll(/\beval\s*:\s*(-?\d+(?:\.\d+)?)/g)]
      .filter(m => Number(m[1]) !== 0)
    expect(nonZeroEvalLiterals.map(m => m[0])).toEqual([])
  })
})
