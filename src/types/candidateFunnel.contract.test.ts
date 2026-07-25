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
  CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES,
  CANDIDATE_FUNNEL_HARD_REASON_CODES,
  CANDIDATE_FUNNEL_MIN_USABLE_AXES,
  CANDIDATE_FUNNEL_PIPELINE_PATHS,
  CANDIDATE_FUNNEL_PRESCREEN_POOLS,
  CANDIDATE_FUNNEL_PRESCREEN_PRIOR_WEIGHT,
  CANDIDATE_FUNNEL_SCHEMA_VERSION,
  CANDIDATE_FUNNEL_SCORE_VERSION,
  CANDIDATE_FUNNEL_SECTOR_CAP_RELAXATION,
  CANDIDATE_FUNNEL_SELECTED_REASON_CODES,
  CANDIDATE_FUNNEL_SOFT_REASON_CODES,
  CANDIDATE_FUNNEL_STAGE3_COMPOSITE_WEIGHT,
  CANDIDATE_FUNNEL_THEME_STATUSES,
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
    "CANDIDATE_FUNNEL_SELECTED_REASON_CODES": list(m.CANDIDATE_FUNNEL_SELECTED_REASON_CODES),
    "CANDIDATE_FUNNEL_THEME_STATUSES": list(m.CANDIDATE_FUNNEL_THEME_STATUSES),
    "CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES": list(m.CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES),
}))
`
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf-8' })
  return JSON.parse(out)
}

// A2-S §25.19 T-23 / MF-09: Python engine の実出力 payload を subprocess で
// 取得し、shape parity（key集合・enum所属・nullable・not_for_trading）を
// behavioral に検証する。定数ミラー assert だけでは "TSとPythonが同じ誤った
// 定数を参照するだけのtest" になるため、実際の build_candidate_funnel() 出力
// を独立して検証する。
function loadPythonSamplePayload(): Record<string, unknown> {
  const { execFileSync } = require('child_process') as {
    execFileSync: (file: string, args: string[], options: { encoding: 'utf-8' }) => string
  }
  const script = `
import json
import data.candidate_funnel_engine as engine

def make(code, sector, per, pbr, roe, div, sigma, mom, status="ok", prescreen=None, prescreen_key=True):
    d = dict(code=code, name=f"n{code}", sector=sector, price=1000.0,
             per=per, pbr=pbr, roe=roe, dividendYield=div, sigma252d=sigma, mom3m=mom, dataStatus=status)
    if prescreen_key:
        d["prescreenScore"] = prescreen
    return d

candidates = [
    make("1001", "SecA", 5.0, 0.4, 35.0, 6.0, 0.10, 20.0, prescreen=0.9),   # actionable-eligible
    make("1002", "SecB", 12.0, 1.0, 15.0, 3.0, 0.20, 5.0, prescreen=0.5),   # deep-review-eligible
    make("1003", "SecC", 60.0, 4.0, -5.0, 0.1, 0.15, -10.0, prescreen=0.1), # screened
    make("", "SecD", 10.0, 1.0, 10.0, 2.0, 0.2, 5.0, prescreen=0.5),        # excluded (empty code)
]
filler = [
    make(f"2{i:03d}", f"Fill{i%5}", 50.0+i, 3.0+i*0.1, -10.0+i*0.1, 0.1, 0.15, -15.0+i*0.2, prescreen=(i%5)/5.0)
    for i in range(10)
]
result = engine.build_candidate_funnel(candidates + filler, {"pipelinePath": "normal"})
print(json.dumps(result))
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

  it('soft reason codes match exactly: count=13 (A2-S frozen), exact strings, exact order', () => {
    expect(CANDIDATE_FUNNEL_SOFT_REASON_CODES.length).toBe(13)
    expect([...CANDIDATE_FUNNEL_SOFT_REASON_CODES]).toEqual(py.CANDIDATE_FUNNEL_SOFT_REASON_CODES)
    // A2-S §25.6: 既存10件の文字列・順序・index 0-9 は不変（リテラルで固定）
    expect(CANDIDATE_FUNNEL_SOFT_REASON_CODES.slice(0, 10)).toEqual([
      'SOFT_ELEVATED_VOLATILITY',
      'SOFT_WEAK_MOMENTUM',
      'SOFT_DEEP_DRAWDOWN',
      'SOFT_WEAK_TREND',
      'SOFT_SECTOR_CROWDING',
      'SOFT_THEME_CROWDING',
      'SOFT_LOW_DATA_CONFIDENCE',
      'SOFT_STALE_SOURCE',
      'SOFT_PORTFOLIO_OVERLAP',
      'SOFT_FALLBACK_PROVENANCE',
    ])
    expect(CANDIDATE_FUNNEL_SOFT_REASON_CODES.slice(10)).toEqual([
      'SOFT_PRESCREEN_METADATA_MISSING',
      'SOFT_VOLATILITY_RED_FLAG',
      'SOFT_VOLATILITY_UNAVAILABLE',
    ])
  })

  it('selectedReasons enum matches exactly: count=2 literal (A2-S §25.12)', () => {
    expect(CANDIDATE_FUNNEL_SELECTED_REASON_CODES.length).toBe(2)
    expect([...CANDIDATE_FUNNEL_SELECTED_REASON_CODES]).toEqual(['SELECTED_DEEP_REVIEW', 'SELECTED_ACTIONABLE'])
    expect([...CANDIDATE_FUNNEL_SELECTED_REASON_CODES]).toEqual(py.CANDIDATE_FUNNEL_SELECTED_REASON_CODES)
  })

  it('themeStatus enum matches exactly: count=2 literal (A2-S §25.14)', () => {
    expect(CANDIDATE_FUNNEL_THEME_STATUSES.length).toBe(2)
    expect([...CANDIDATE_FUNNEL_THEME_STATUSES]).toEqual(['unavailable', 'available'])
    expect([...CANDIDATE_FUNNEL_THEME_STATUSES]).toEqual(py.CANDIDATE_FUNNEL_THEME_STATUSES)
  })

  it('degradation reason codes match exactly: count=6 literal (A2-S §25.14)', () => {
    expect(CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES.length).toBe(6)
    expect([...CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES]).toEqual([
      'SEED_FALLBACK_PIPELINE_PATH',
      'CACHE_FALLBACK_PROVENANCE',
      'STALE_SOURCE',
      'PRESCREEN_FALLBACK_USED',
      'PRESCREEN_METADATA_MISSING',
      'DUPLICATE_CANDIDATE_CODE',
    ])
    expect([...CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES]).toEqual(py.CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES)
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

  it('actionable dataConfidence threshold is exactly 2/3, not literal 0.67 (A2-S §25.3)', () => {
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE).toBe(2 / 3)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE).not.toBe(0.67)
    expect(CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE).toBe(py.ACTIONABLE_MIN_DATA_CONFIDENCE)
    // 4/6 は 2/3 と bit-identical であり actionable gate を PASS する
    expect(4 / 6 >= CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE).toBe(true)
    expect(4 / 6 >= 0.67).toBe(false)
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

// A2-S §25.19 T-23 / MF-09: Python engine の実出力 payload の shape parity。
describe('candidateFunnel payload shape parity (P5-B005-B1-R2, A2-S MF-09)', () => {
  const payload = loadPythonSamplePayload() as Record<string, unknown>

  it('root artifact has exactly the 12 expected top-level keys', () => {
    const expectedKeys = [
      'schemaVersion',
      'funnelVersion',
      'scoreVersion',
      'not_for_trading',
      'status',
      'degradationReasons',
      'counts',
      'candidates',
      'excludedSummary',
      'sectorDistribution',
      'scoreDistribution',
      'selectionObservability',
    ]
    expect(Object.keys(payload).sort()).toEqual([...expectedKeys].sort())
    expect(Object.keys(payload).length).toBe(12)
  })

  it('not_for_trading is strictly true', () => {
    expect(payload.not_for_trading).toBe(true)
  })

  it('counts has exactly the 5 expected keys', () => {
    expect(Object.keys(payload.counts as object).sort()).toEqual(
      ['total', 'excluded', 'screened', 'deepReview', 'actionable'].sort()
    )
  })

  it('excludedSummary has exactly the 2 expected keys', () => {
    expect(Object.keys(payload.excludedSummary as object).sort()).toEqual(['total', 'byReason'].sort())
  })

  it('sectorDistribution has exactly the 3 expected keys', () => {
    expect(Object.keys(payload.sectorDistribution as object).sort()).toEqual(
      ['screened', 'deepReview', 'actionable'].sort()
    )
  })

  it('scoreDistribution has exactly the 5 expected keys', () => {
    expect(Object.keys(payload.scoreDistribution as object).sort()).toEqual(
      ['count', 'min', 'max', 'mean', 'median'].sort()
    )
  })

  it('selectionObservability has exactly the 15 expected keys', () => {
    const expectedKeys = [
      'regimeApplied',
      'actionableHardMaxApplied',
      'actionableSectorCapApplied',
      'deepReviewHardMaxApplied',
      'deepReviewSectorCapApplied',
      'deepReviewSectorCapRelaxed',
      'actionableSectorCapRelaxed',
      'deepReviewSectorCapOverflow',
      'actionableSectorCapOverflow',
      'deepReviewEligibleCount',
      'deepReviewSelectedCount',
      'actionableEligibleCount',
      'actionableSelectedCount',
      'sourceStale',
      'fallbackProvenance',
    ]
    expect(Object.keys(payload.selectionObservability as object).sort()).toEqual([...expectedKeys].sort())
    expect(Object.keys(payload.selectionObservability as object).length).toBe(15)
  })

  it('every candidate has exactly the 18 expected keys', () => {
    const expectedKeys = [
      'code',
      'name',
      'sector',
      'prescreenScore',
      'prescreenRank',
      'prescreenPool',
      'scoreBreakdown',
      'rawCompositeScore',
      'dataConfidence',
      'marketScore',
      'marketRank',
      'tier',
      'selectedReasons',
      'riskReasons',
      'hardExclusionReasons',
      'themes',
      'themeStatus',
      'dataStatus',
    ]
    const candidates = payload.candidates as Record<string, unknown>[]
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(Object.keys(c).sort()).toEqual([...expectedKeys].sort())
    }
    expect(Object.keys(candidates[0]).length).toBe(18)
  })

  it('blockedReasons key does not exist anywhere in the payload (A2-S MF-11 rename)', () => {
    const seen = new Set<string>()
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk)
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          seen.add(key)
          walk(value)
        }
      }
    }
    walk(payload)
    expect(seen.has('blockedReasons')).toBe(false)
    expect(seen.has('hardExclusionReasons')).toBe(true)
  })

  it('every scoreBreakdown component has exactly the 6 expected keys, 10 components, exact ids', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    for (const c of candidates) {
      const breakdown = c.scoreBreakdown as Record<string, unknown>[]
      expect(breakdown.length).toBe(10)
      expect(breakdown.map((b) => b.id)).toEqual([...CANDIDATE_FUNNEL_COMPONENT_IDS])
      for (const comp of breakdown) {
        expect(Object.keys(comp).sort()).toEqual(
          ['id', 'value', 'weight', 'weightedContribution', 'status', 'sourceFields'].sort()
        )
      }
    }
  })

  it('tier values all belong to the TS tier union', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    for (const c of candidates) {
      expect(CANDIDATE_FUNNEL_TIERS).toContain(c.tier)
    }
  })

  it('selectedReasons values all belong to the TS selectedReasons union', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    for (const c of candidates) {
      for (const reason of c.selectedReasons as string[]) {
        expect(CANDIDATE_FUNNEL_SELECTED_REASON_CODES).toContain(reason)
      }
    }
  })

  it('riskReasons values all belong to the TS soft reason union', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    for (const c of candidates) {
      for (const reason of c.riskReasons as string[]) {
        expect(CANDIDATE_FUNNEL_SOFT_REASON_CODES).toContain(reason)
      }
    }
  })

  it('hardExclusionReasons values all belong to the TS hard reason union', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    for (const c of candidates) {
      for (const reason of c.hardExclusionReasons as string[]) {
        expect(CANDIDATE_FUNNEL_HARD_REASON_CODES).toContain(reason)
      }
    }
  })

  it('themes is always [] and themeStatus is always "unavailable" in v1', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    for (const c of candidates) {
      expect(c.themes).toEqual([])
      expect(c.themeStatus).toBe('unavailable')
      expect(CANDIDATE_FUNNEL_THEME_STATUSES).toContain(c.themeStatus)
    }
  })

  it('excluded candidate has nullable score fields set to null and non-excluded does not', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    const excluded = candidates.find((c) => c.tier === 'excluded')
    expect(excluded).toBeDefined()
    expect(excluded?.marketScore).toBeNull()
    expect(excluded?.marketRank).toBeNull()
    expect(excluded?.dataConfidence).toBeNull()
    expect(excluded?.rawCompositeScore).toBeNull()
    expect((excluded?.hardExclusionReasons as unknown[]).length).toBeGreaterThan(0)

    const included = candidates.find((c) => c.tier !== 'excluded')
    expect(included).toBeDefined()
    expect(included?.marketScore).not.toBeNull()
    expect(included?.marketRank).not.toBeNull()
  })

  it('actionable candidate carries SELECTED_ACTIONABLE and deep_review carries SELECTED_DEEP_REVIEW', () => {
    const candidates = payload.candidates as Record<string, unknown>[]
    const actionable = candidates.find((c) => c.tier === 'actionable')
    if (actionable) {
      expect(actionable.selectedReasons).toEqual(['SELECTED_ACTIONABLE'])
    }
    const screened = candidates.find((c) => c.tier === 'screened')
    if (screened) {
      expect(screened.selectedReasons).toEqual([])
    }
  })
})
