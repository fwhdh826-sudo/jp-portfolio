// このプロジェクトは @types/node を導入していない（package.json変更は
// ticket scope外）。module-file内でのambient module宣言はTSの
// "invalid module name in augmentation" 制約に抵触するため、Node組み込み
// APIは `require`（グローバル関数として最小 ambient 宣言）経由で取得し、
// フル @types/node への依存を避ける。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function require(id: string): any
}

import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_FUNNEL_ACTIONABLE_HARD_MAX,
  CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE,
  CANDIDATE_FUNNEL_ACTIONABLE_MIN_MARKET_SCORE,
  CANDIDATE_FUNNEL_ACTIONABLE_MIN_QUALITY_PERCENTILE,
  CANDIDATE_FUNNEL_ACTIONABLE_MIN_VALUATION_PERCENTILE,
  CANDIDATE_FUNNEL_ACTIONABLE_SECTOR_HARD_CAP,
  CANDIDATE_FUNNEL_BEAR_CRISIS_ACTIONABLE_HARD_MAX,
  CANDIDATE_FUNNEL_BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP,
  CANDIDATE_FUNNEL_COMPONENT_IDS,
  CANDIDATE_FUNNEL_COMPONENT_STATUSES,
  CANDIDATE_FUNNEL_COMPONENT_WEIGHTS,
  CANDIDATE_FUNNEL_DATA_STATUSES,
  CANDIDATE_FUNNEL_DEEP_REVIEW_HARD_MAX,
  CANDIDATE_FUNNEL_DEEP_REVIEW_MIN_DATA_CONFIDENCE,
  CANDIDATE_FUNNEL_DEEP_REVIEW_MIN_MARKET_SCORE,
  CANDIDATE_FUNNEL_DEEP_REVIEW_SECTOR_HARD_CAP,
  CANDIDATE_FUNNEL_HARD_REASON_CODES,
  CANDIDATE_FUNNEL_MIN_USABLE_AXES,
  CANDIDATE_FUNNEL_PIPELINE_PATHS,
  CANDIDATE_FUNNEL_PRESCREEN_POOLS,
  CANDIDATE_FUNNEL_PRESCREEN_PRIOR_WEIGHT,
  CANDIDATE_FUNNEL_SCHEMA_VERSION,
  CANDIDATE_FUNNEL_SCORE_VERSION,
  CANDIDATE_FUNNEL_SECTOR_CAP_RELAXATION,
  CANDIDATE_FUNNEL_SOFT_REASON_CODES,
  CANDIDATE_FUNNEL_STAGE3_COMPOSITE_WEIGHT,
  CANDIDATE_FUNNEL_TIERS,
  CANDIDATE_FUNNEL_VALUATION_SUB_WEIGHTS,
  CANDIDATE_FUNNEL_VERSION,
  CANDIDATE_FUNNEL_VOL_HARD_LIMIT,
  CANDIDATE_FUNNEL_VOL_SOFT_LIMIT,
} from './candidateFunnel'

// Python 側 (data/candidate_funnel_engine.py) の定数を JSON-safe に抽出する。
// 巨大な code-generation 基盤は作らず、stdlib subprocess 一発で値だけを
// 引き抜く最小の橋渡し（P5-B005-B1-R ticket §18 の指示どおり）。
function loadPythonConstants(): Record<string, unknown> {
  const { execFileSync } = require('child_process') as {
    execFileSync: (file: string, args: string[], options: { encoding: 'utf-8' }) => string
  }
  // vitestはrepository rootから実行される契約（ticket §22 validation
  // コマンドは常にcwd=repository root）。python3 -c はcwdをsys.path[0]
  // として解決するため、__dirname/path.resolve等のNode追加APIなしに
  // `import data.candidate_funnel_engine` を解決できる。
  const script = `
import json
import data.candidate_funnel_engine as m

print(json.dumps({
    "CANDIDATE_FUNNEL_SCHEMA_VERSION": m.CANDIDATE_FUNNEL_SCHEMA_VERSION,
    "CANDIDATE_FUNNEL_VERSION": m.CANDIDATE_FUNNEL_VERSION,
    "CANDIDATE_FUNNEL_SCORE_VERSION": m.CANDIDATE_FUNNEL_SCORE_VERSION,
    "PRESCREEN_PRIOR_WEIGHT": m.PRESCREEN_PRIOR_WEIGHT,
    "STAGE3_COMPOSITE_WEIGHT": m.STAGE3_COMPOSITE_WEIGHT,
    "COMPONENT_WEIGHTS": m.COMPONENT_WEIGHTS,
    "COMPONENT_IDS": list(m.COMPONENT_IDS),
    "VALUATION_SUB_WEIGHTS": m.VALUATION_SUB_WEIGHTS,
    "CANDIDATE_FUNNEL_TIERS": list(m.CANDIDATE_FUNNEL_TIERS),
    "CANDIDATE_FUNNEL_PIPELINE_PATHS": list(m.CANDIDATE_FUNNEL_PIPELINE_PATHS),
    "CANDIDATE_FUNNEL_COMPONENT_STATUSES": list(m.CANDIDATE_FUNNEL_COMPONENT_STATUSES),
    "CANDIDATE_FUNNEL_PRESCREEN_POOLS": list(m.CANDIDATE_FUNNEL_PRESCREEN_POOLS),
    "CANDIDATE_FUNNEL_DATA_STATUSES": list(m.CANDIDATE_FUNNEL_DATA_STATUSES),
    "CANDIDATE_FUNNEL_HARD_REASON_CODES": list(m.CANDIDATE_FUNNEL_HARD_REASON_CODES),
    "CANDIDATE_FUNNEL_SOFT_REASON_CODES": list(m.CANDIDATE_FUNNEL_SOFT_REASON_CODES),
    "MIN_USABLE_AXES": m.MIN_USABLE_AXES,
    "DEEP_REVIEW_MIN_MARKET_SCORE": m.DEEP_REVIEW_MIN_MARKET_SCORE,
    "DEEP_REVIEW_MIN_DATA_CONFIDENCE": m.DEEP_REVIEW_MIN_DATA_CONFIDENCE,
    "DEEP_REVIEW_HARD_MAX": m.DEEP_REVIEW_HARD_MAX,
    "DEEP_REVIEW_SECTOR_HARD_CAP": m.DEEP_REVIEW_SECTOR_HARD_CAP,
    "ACTIONABLE_MIN_MARKET_SCORE": m.ACTIONABLE_MIN_MARKET_SCORE,
    "ACTIONABLE_MIN_DATA_CONFIDENCE": m.ACTIONABLE_MIN_DATA_CONFIDENCE,
    "ACTIONABLE_HARD_MAX": m.ACTIONABLE_HARD_MAX,
    "ACTIONABLE_SECTOR_HARD_CAP": m.ACTIONABLE_SECTOR_HARD_CAP,
    "ACTIONABLE_MIN_VALUATION_PERCENTILE": m.ACTIONABLE_MIN_VALUATION_PERCENTILE,
    "ACTIONABLE_MIN_QUALITY_PERCENTILE": m.ACTIONABLE_MIN_QUALITY_PERCENTILE,
    "BEAR_CRISIS_ACTIONABLE_HARD_MAX": m.BEAR_CRISIS_ACTIONABLE_HARD_MAX,
    "BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP": m.BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP,
    "VOL_HARD_LIMIT": m.VOL_HARD_LIMIT,
    "VOL_SOFT_LIMIT": m.VOL_SOFT_LIMIT,
    "SECTOR_CAP_RELAXATION": m.SECTOR_CAP_RELAXATION,
}))
`
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf-8' })
  return JSON.parse(out)
}

describe('candidateFunnel Python/TypeScript parity (P5-B005-B1-R)', () => {
  const py = loadPythonConstants()

  it('version strings match exactly', () => {
    expect(CANDIDATE_FUNNEL_SCHEMA_VERSION).toBe(py.CANDIDATE_FUNNEL_SCHEMA_VERSION)
    expect(CANDIDATE_FUNNEL_VERSION).toBe(py.CANDIDATE_FUNNEL_VERSION)
    expect(CANDIDATE_FUNNEL_SCORE_VERSION).toBe(py.CANDIDATE_FUNNEL_SCORE_VERSION)
  })

  it('prior/stage3 weights match exactly and sum to 1.0', () => {
    expect(CANDIDATE_FUNNEL_PRESCREEN_PRIOR_WEIGHT).toBe(py.PRESCREEN_PRIOR_WEIGHT)
    expect(CANDIDATE_FUNNEL_STAGE3_COMPOSITE_WEIGHT).toBe(py.STAGE3_COMPOSITE_WEIGHT)
    expect(CANDIDATE_FUNNEL_PRESCREEN_PRIOR_WEIGHT + CANDIDATE_FUNNEL_STAGE3_COMPOSITE_WEIGHT).toBeCloseTo(1.0, 10)
  })

  it('component ids match exactly (order included)', () => {
    expect([...CANDIDATE_FUNNEL_COMPONENT_IDS]).toEqual(py.COMPONENT_IDS)
  })

  it('component weights match exactly for all 10 components', () => {
    const pyWeights = py.COMPONENT_WEIGHTS as Record<string, number>
    for (const id of CANDIDATE_FUNNEL_COMPONENT_IDS) {
      expect(CANDIDATE_FUNNEL_COMPONENT_WEIGHTS[id]).toBe(pyWeights[id])
    }
    expect(Object.keys(pyWeights).length).toBe(10)
  })

  it('valuation sub-weights match exactly', () => {
    const pySub = py.VALUATION_SUB_WEIGHTS as Record<string, number>
    expect(CANDIDATE_FUNNEL_VALUATION_SUB_WEIGHTS.earningsYield).toBeCloseTo(pySub.earningsYield, 10)
    expect(CANDIDATE_FUNNEL_VALUATION_SUB_WEIGHTS.bookYield).toBeCloseTo(pySub.bookYield, 10)
    expect(CANDIDATE_FUNNEL_VALUATION_SUB_WEIGHTS.dividendYield).toBeCloseTo(pySub.dividendYield, 10)
  })

  it('tier enum matches exactly (order included)', () => {
    expect([...CANDIDATE_FUNNEL_TIERS]).toEqual(py.CANDIDATE_FUNNEL_TIERS)
  })

  it('pipeline path enum matches exactly', () => {
    expect([...CANDIDATE_FUNNEL_PIPELINE_PATHS]).toEqual(py.CANDIDATE_FUNNEL_PIPELINE_PATHS)
  })

  it('component status enum matches exactly', () => {
    expect([...CANDIDATE_FUNNEL_COMPONENT_STATUSES]).toEqual(py.CANDIDATE_FUNNEL_COMPONENT_STATUSES)
  })

  it('prescreen pool enum matches exactly', () => {
    expect([...CANDIDATE_FUNNEL_PRESCREEN_POOLS]).toEqual(py.CANDIDATE_FUNNEL_PRESCREEN_POOLS)
  })

  it('data status enum matches exactly', () => {
    expect([...CANDIDATE_FUNNEL_DATA_STATUSES]).toEqual(py.CANDIDATE_FUNNEL_DATA_STATUSES)
  })

  it('hard reason codes match exactly: count=8, exact strings, exact order', () => {
    expect(CANDIDATE_FUNNEL_HARD_REASON_CODES.length).toBe(8)
    expect([...CANDIDATE_FUNNEL_HARD_REASON_CODES]).toEqual(py.CANDIDATE_FUNNEL_HARD_REASON_CODES)
  })

  it('soft reason codes match exactly: count=10, exact strings, exact order', () => {
    expect(CANDIDATE_FUNNEL_SOFT_REASON_CODES.length).toBe(10)
    expect([...CANDIDATE_FUNNEL_SOFT_REASON_CODES]).toEqual(py.CANDIDATE_FUNNEL_SOFT_REASON_CODES)
  })

  it('minUsableAxes matches exactly', () => {
    expect(CANDIDATE_FUNNEL_MIN_USABLE_AXES).toBe(py.MIN_USABLE_AXES)
  })

  it('deep-review thresholds/maxima/sector cap match exactly', () => {
    expect(CANDIDATE_FUNNEL_DEEP_REVIEW_MIN_MARKET_SCORE).toBe(py.DEEP_REVIEW_MIN_MARKET_SCORE)
    expect(CANDIDATE_FUNNEL_DEEP_REVIEW_MIN_DATA_CONFIDENCE).toBe(py.DEEP_REVIEW_MIN_DATA_CONFIDENCE)
    expect(CANDIDATE_FUNNEL_DEEP_REVIEW_HARD_MAX).toBe(py.DEEP_REVIEW_HARD_MAX)
    expect(CANDIDATE_FUNNEL_DEEP_REVIEW_SECTOR_HARD_CAP).toBe(py.DEEP_REVIEW_SECTOR_HARD_CAP)
  })

  it('actionable thresholds/maxima/sector cap/floors match exactly', () => {
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_MARKET_SCORE).toBe(py.ACTIONABLE_MIN_MARKET_SCORE)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE).toBe(py.ACTIONABLE_MIN_DATA_CONFIDENCE)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_HARD_MAX).toBe(py.ACTIONABLE_HARD_MAX)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_SECTOR_HARD_CAP).toBe(py.ACTIONABLE_SECTOR_HARD_CAP)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_VALUATION_PERCENTILE).toBe(py.ACTIONABLE_MIN_VALUATION_PERCENTILE)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_QUALITY_PERCENTILE).toBe(py.ACTIONABLE_MIN_QUALITY_PERCENTILE)
  })

  it('bear/crisis actionable hard max and sector cap match exactly', () => {
    expect(CANDIDATE_FUNNEL_BEAR_CRISIS_ACTIONABLE_HARD_MAX).toBe(py.BEAR_CRISIS_ACTIONABLE_HARD_MAX)
    expect(CANDIDATE_FUNNEL_BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP).toBe(py.BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP)
  })

  it('vol hard/soft limits match exactly', () => {
    expect(CANDIDATE_FUNNEL_VOL_HARD_LIMIT).toBe(py.VOL_HARD_LIMIT)
    expect(CANDIDATE_FUNNEL_VOL_SOFT_LIMIT).toBe(py.VOL_SOFT_LIMIT)
  })

  it('sector cap relaxation is false on both sides', () => {
    expect(CANDIDATE_FUNNEL_SECTOR_CAP_RELAXATION).toBe(false)
    expect(py.SECTOR_CAP_RELAXATION).toBe(false)
  })
})
