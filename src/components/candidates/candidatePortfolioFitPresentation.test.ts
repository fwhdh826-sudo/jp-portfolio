import { describe, expect, it } from 'vitest'
import type {
  CandidatePortfolioFitComponent,
  CandidatePortfolioFitRecord,
  CandidatePortfolioFitResult,
} from '../../types/candidatePortfolioFit'
import {
  projectCandidatePortfolioFitPresentation,
  selectCandidatePortfolioFitCardViewModel,
} from './candidatePortfolioFitPresentation'

function component(
  id: CandidatePortfolioFitComponent['id'],
  value: number | null,
  status: CandidatePortfolioFitComponent['status'] = 'evaluated',
): CandidatePortfolioFitComponent {
  return {
    id,
    value,
    status,
    contribution: null,
    reasons: [],
    risks: [],
  }
}

function record(
  artifactIndex = 0,
  overrides: Partial<CandidatePortfolioFitRecord> = {},
): CandidatePortfolioFitRecord {
  return {
    candidateRecordId: `artifact:${artifactIndex}`,
    artifactIndex,
    code: `code-${artifactIndex}`,
    normalizedCode: `${artifactIndex}`,
    candidateMarketRank: artifactIndex + 1,
    candidateTier: 'actionable',
    holdingRelationship: 'new_to_portfolio',
    portfolioFitScore: null,
    portfolioFitRank: null,
    portfolioFitStatus: 'evaluated',
    components: [
      component('same_code_relationship', 0),
      component('existing_concentration', 0.25),
      component('sector_diversification', 2 / 3),
    ],
    fitReasons: ['NEW_TO_PORTFOLIO'],
    fitRisks: [],
    ...overrides,
  }
}

function result(
  overrides: Partial<CandidatePortfolioFitResult> = {},
): CandidatePortfolioFitResult {
  return {
    schemaVersion: 'candidate-portfolio-fit-1',
    fitVersion: 'portfolio-fit-v1-categorical',
    scoreModel: 'categorical_v1',
    targetPopulation: 'deep_review_and_actionable',
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
    evaluatedAt: '2026-07-26T08:00:00.000Z',
    candidateGeneratedAt: '2026-07-26T07:00:00.000Z',
    portfolioSourceAsOf: '2026-07-26T07:00:00.000Z',
    portfolioFreshness: 'fresh',
    status: 'evaluated',
    capacity: { assetClass: 'JP_STOCK', status: 'available', reasons: [] },
    records: [record()],
    degradationReasons: [],
    qualityGate: {
      inputTargetCount: 1,
      outputRecordCount: 1,
      hardFailIds: [],
      warningIds: [],
    },
    ...overrides,
  }
}

function project(current: CandidatePortfolioFitResult = result()) {
  return projectCandidatePortfolioFitPresentation({ phase: 'ready', result: current })
}

function recursiveKeys(value: unknown): string[] {
  const keys: string[] = []
  const seen = new WeakSet<object>()
  const visit = (current: unknown) => {
    if (current === null || typeof current !== 'object' || seen.has(current)) return
    seen.add(current)
    for (const [key, nested] of Object.entries(current)) {
      keys.push(key)
      visit(nested)
    }
  }
  visit(value)
  return keys
}

describe('P5-B005-C-B3 frozen presentation projection', () => {
  it('C-B3-T16 projects the exact dataset keys', () => {
    const dataset = project().dataset
    expect(Object.keys(dataset)).toEqual([
      'status',
      'statusText',
      'alertRole',
      'evaluatedAtText',
      'portfolioFreshnessText',
      'capacityText',
      'degradationText',
      'canonicalMessage',
      'hasHardFail',
      'hasWarning',
      'notForTradingText',
    ])
    expect(dataset.notForTradingText).toBe(
      '売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。',
    )
  })

  it('C-B3-T17 joins a record by artifactIndex', () => {
    const view = project(result({ records: [record(7)] }))
    const card = selectCandidatePortfolioFitCardViewModel(view, 7, 'actionable')
    expect(card?.state).toBe('evaluated')
    expect(card && 'record' in card ? card.record.artifactIndex : null).toBe(7)
  })

  it('C-B3-T18 fails closed when candidateRecordId mismatches the index', () => {
    const mismatched = record(7, { candidateRecordId: 'artifact:8' })
    const card = selectCandidatePortfolioFitCardViewModel(
      project(result({ records: [mismatched] })),
      7,
      'actionable',
    )
    expect(card).toMatchObject({
      state: 'missing',
      statusText: 'ポートフォリオ適合レコードが見つかりません。',
    })
  })

  it('C-B3-T19 keeps duplicate-code records at different artifact indices independent', () => {
    const first = record(2, { code: '7777' })
    const second = record(9, {
      code: '7777',
      holdingRelationship: 'already_held',
    })
    const view = project(result({ records: [first, second] }))
    const card2 = selectCandidatePortfolioFitCardViewModel(view, 2, 'actionable')
    const card9 = selectCandidatePortfolioFitCardViewModel(view, 9, 'actionable')
    expect(card2 && 'record' in card2 ? card2.record.relationshipText : null)
      .toBe('新規候補（未保有）')
    expect(card9 && 'record' in card9 ? card9.record.relationshipText : null)
      .toBe('保有あり')
  })

  it('C-B3-T20 rejects duplicate artifactIndex records instead of taking the first', () => {
    const view = project(result({ records: [record(4), record(4)] }))
    expect(selectCandidatePortfolioFitCardViewModel(view, 4, 'actionable')?.state)
      .toBe('missing')
  })

  it('C-B3-T21 exposes an explicit missing state for an absent F2 record', () => {
    expect(selectCandidatePortfolioFitCardViewModel(
      project(result({ records: [] })),
      3,
      'deep_review',
    )).toEqual({
      state: 'missing',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合レコードが見つかりません。',
    })
  })

  it('C-B3-T22 returns undefined for screened candidates', () => {
    expect(selectCandidatePortfolioFitCardViewModel(project(), 0, 'screened'))
      .toBeUndefined()
  })

  it('C-B3-T23 preserves projection order and leaves join inputs unchanged', () => {
    const records = [record(8), record(1), record(5)]
    const before = structuredClone(records)
    const view = project(result({ records }))
    expect(view.records.map(item => item.artifactIndex)).toEqual([8, 1, 5])
    expect(records).toEqual(before)
  })

  it('C-B3-T24 projects evaluated as visible non-alert status', () => {
    expect(project().dataset).toMatchObject({
      status: 'evaluated',
      statusText: 'ポートフォリオ適合を評価しました。',
      alertRole: 'none',
    })
  })

  it('C-B3-T25 projects partial with a polite status role', () => {
    expect(project(result({ status: 'partial' })).dataset).toMatchObject({
      status: 'partial',
      statusText: 'ポートフォリオ適合は一部のみ評価できました。',
      alertRole: 'status',
    })
  })

  it('C-B3-T26 hides record specifics for unavailable', () => {
    const view = project(result({ status: 'unavailable' }))
    expect(view.dataset.status).toBe('unavailable')
    expect(view.records).toEqual([])
  })

  it('C-B3-T27 makes invalid assertive and hides record specifics', () => {
    const view = project(result({ status: 'invalid' }))
    expect(view.dataset).toMatchObject({ status: 'invalid', alertRole: 'alert' })
    expect(view.records).toEqual([])
  })

  it('C-B3-T28 gives hard fail precedence over partial', () => {
    const view = project(result({
      status: 'partial',
      qualityGate: {
        inputTargetCount: 1,
        outputRecordCount: 1,
        hardFailIds: ['PF-QG-03-F2_COUNT_PARITY'],
        warningIds: ['PF-QG-02-SNAPSHOT_CONTRACT'],
      },
    }))
    expect(view.dataset).toMatchObject({
      status: 'invalid',
      hasHardFail: true,
      hasWarning: false,
      canonicalMessage: 'ポートフォリオ適合の品質検証に失敗しました。',
    })
  })

  it('C-B3-T29 retains warning on an evaluated result', () => {
    const view = project(result({
      qualityGate: {
        inputTargetCount: 1,
        outputRecordCount: 1,
        hardFailIds: [],
        warningIds: ['PF-QG-02-SNAPSHOT_CONTRACT'],
      },
    }))
    expect(view.dataset).toMatchObject({
      status: 'evaluated',
      alertRole: 'status',
      hasWarning: true,
    })
  })

  it('C-B3-T30 uses the exact cross-tab stale copy', () => {
    expect(project(result({
      status: 'unavailable',
      degradationReasons: ['CROSS_TAB_STATE_STALE'],
    })).dataset.canonicalMessage).toBe(
      '別タブで保有データが更新されました。再読み込み後に再評価してください。',
    )
  })

  it('C-B3-T31 uses the exact stale-candidate copy', () => {
    expect(project(result({
      status: 'unavailable',
      degradationReasons: ['CANDIDATE_INPUT_STALE'],
    })).dataset.canonicalMessage).toBe(
      '候補データが古いため、ポートフォリオ適合を評価できません。',
    )
  })

  it('C-B3-T32 uses the exact degraded-candidate copy', () => {
    expect(project(result({
      status: 'unavailable',
      degradationReasons: ['CANDIDATE_INPUT_DEGRADED'],
    })).dataset.canonicalMessage).toBe(
      '候補データが代替経路のため、ポートフォリオ適合を評価できません。',
    )
  })

  it('C-B3-T33 maps all relationships without percentage formatting', () => {
    const relationships = [
      record(0, { holdingRelationship: 'new_to_portfolio' }),
      record(1, { holdingRelationship: 'already_held' }),
      record(2, { holdingRelationship: 'holding_match_unknown' }),
    ]
    expect(project(result({ records: relationships })).records.map(item => item.relationshipText))
      .toEqual(['新規候補（未保有）', '保有あり', '保有照合不明'])
    expect(project(result({ records: relationships })).records
      .some(item => item.relationshipText.includes('%'))).toBe(false)
  })

  it('C-B3-T34 projects the three components in frozen order with exact labels', () => {
    expect(project().records[0].components.map(item => [item.id, item.label])).toEqual([
      ['same_code_relationship', '同一コード保有関係'],
      ['existing_concentration', '既存ポートフォリオ内の同一コード比率'],
      ['sector_diversification', '既存日本株内の同一セクター比率'],
    ])
  })

  it('C-B3-T35 formats ratio boundaries and thirds as 0%, 100%, and 66.7%', () => {
    const current = record(0, {
      components: [
        component('same_code_relationship', 1),
        component('existing_concentration', 0),
        component('sector_diversification', 1),
      ],
    })
    const values = project(result({ records: [current] })).records[0].components
      .map(item => item.valueText)
    expect(values).toEqual([null, '0%', '100%'])
    const thirds = project().records[0].components[2]
    expect(thirds).toMatchObject({
      valueText: '66.7%',
      valueAriaLabel: '既存日本株内の同一セクター比率 66.7パーセント',
    })
  })

  it('C-B3-T36 never turns null, partial, or unavailable into 0%', () => {
    const current = record(0, {
      components: [
        component('same_code_relationship', null, 'unavailable'),
        component('existing_concentration', null, 'partial'),
        component('sector_diversification', null, 'unavailable'),
      ],
    })
    expect(project(result({ records: [current] })).records[0].components
      .map(item => item.valueText)).toEqual([null, null, null])
  })

  it('C-B3-T37 shows reserved and not_applicable status without values', () => {
    const current = record(0, {
      components: [
        component('same_code_relationship', null, 'reserved'),
        component('existing_concentration', null, 'reserved'),
        component('sector_diversification', null, 'not_applicable'),
      ],
    })
    expect(project(result({ records: [current] })).records[0].components
      .map(item => [item.statusText, item.valueText])).toEqual([
        ['将来対応（未評価）', null],
        ['将来対応（未評価）', null],
        ['対象外', null],
      ])
  })

  it('C-B3-T38 fails closed for a bad evaluated ratio without exposing the raw value', () => {
    const current = record(0, {
      components: [
        component('same_code_relationship', 0),
        component('existing_concentration', 1.5),
        component('sector_diversification', Number.POSITIVE_INFINITY),
      ],
    })
    const view = project(result({ records: [current] })).records[0]
    expect(view.components.slice(1).map(item => [item.statusText, item.valueText]))
      .toEqual([[ '未対応の表示値を検出しました。', null ], [ '未対応の表示値を検出しました。', null ]])
    expect(JSON.stringify(view)).not.toContain('Infinity')
    expect(view.hasUnknownLiteral).toBe(true)
  })

  it('C-B3-T39 maps every accepted reason and risk in input order', () => {
    const current = record(0, {
      fitReasons: [
        'ALREADY_HELD',
        'NEW_TO_PORTFOLIO',
        'SECTOR_EXPOSURE_MEASURED',
        'EXISTING_CODE_CONCENTRATION_MEASURED',
      ],
      fitRisks: [
        'HOLDING_MATCH_UNKNOWN',
        'SECTOR_AUTHORITY_PARTIAL',
        'EXISTING_CONCENTRATION_UNAVAILABLE',
        'COMPONENT_COVERAGE_PARTIAL',
      ],
    })
    const view = project(result({ records: [current] })).records[0]
    expect(view.reasons).toEqual([
      '保有ありとして照合',
      '未保有として照合',
      '同一セクター比率を確認',
      '同一コード比率を確認',
    ])
    expect(view.risks).toEqual([
      '保有照合を確定できません',
      'セクター情報が不完全です',
      '同一コード比率を評価できません',
      '評価項目の一部を確認できません',
    ])
  })

  it('C-B3-T40 keeps the first duplicate literal and omits empty arrays', () => {
    const current = record(0, {
      fitReasons: ['NEW_TO_PORTFOLIO', 'NEW_TO_PORTFOLIO'],
      fitRisks: [],
    })
    const view = project(result({ records: [current] })).records[0]
    expect(view.reasons).toEqual(['未保有として照合'])
    expect(view.risks).toEqual([])
  })

  it('C-B3-T41 replaces future literals once at their first position and hides raw text', () => {
    const current = record(0, {
      fitReasons: [
        'NEW_TO_PORTFOLIO',
        'FUTURE_REASON',
        'ANOTHER_FUTURE_REASON',
        'ALREADY_HELD',
      ] as CandidatePortfolioFitRecord['fitReasons'],
      fitRisks: ['SOFT_PORTFOLIO_OVERLAP'] as unknown as CandidatePortfolioFitRecord['fitRisks'],
    })
    const view = project(result({ records: [current] })).records[0]
    expect(view.reasons).toEqual([
      '未保有として照合',
      '未対応の表示値を検出しました。',
      '保有ありとして照合',
    ])
    expect(view.risks).toEqual(['未対応の表示値を検出しました。'])
    expect(JSON.stringify(view)).not.toMatch(/FUTURE_REASON|SOFT_PORTFOLIO_OVERLAP/)
  })

  it('C-B3-T42 recursively excludes score, rank, trade, and raw authority fields', () => {
    const keys = recursiveKeys(project())
    for (const forbidden of [
      'portfolioFitScore',
      'portfolioFitRank',
      'holdings',
      'trust',
      'cash',
      'account',
      'quantity',
      'cost',
      'action',
      'officialDecision',
      'amount',
      'order',
      'sizing',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('P5-B005-C-B3-R1 pending and two-leg join acceptance', () => {
  it('R1 projects pending directly without fabricating a ready result', () => {
    const view = projectCandidatePortfolioFitPresentation({
      phase: 'pending',
      result: null,
    })

    expect(view).toEqual({
      dataset: {
        status: 'pending',
        statusText: 'ポートフォリオ適合を評価しています。',
        alertRole: 'status',
        evaluatedAtText: null,
        portfolioFreshnessText: null,
        capacityText: null,
        degradationText: null,
        canonicalMessage: null,
        hasHardFail: false,
        hasWarning: false,
        notForTradingText:
          '売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。',
      },
      records: [],
    })
    expect(JSON.stringify(view)).not.toContain('ポートフォリオ適合を評価しました。')
  })

  it('R1 pending card state exposes no relationship, component, score, or rank detail', () => {
    const pending = projectCandidatePortfolioFitPresentation({
      phase: 'pending',
      result: null,
    })

    expect(selectCandidatePortfolioFitCardViewModel(
      pending,
      1,
      'actionable',
    )).toEqual({
      state: 'pending',
      heading: 'ポートフォリオ適合',
      statusText: 'ポートフォリオ適合を評価しています。',
    })
  })

  it('R1 requires the artifactIndex leg when recordId alone matches', () => {
    const recordIdOnly = record(2, { candidateRecordId: 'artifact:1' })
    const card = selectCandidatePortfolioFitCardViewModel(
      project(result({ records: [recordIdOnly] })),
      1,
      'actionable',
    )

    expect(card?.state).toBe('missing')
  })

  it('R1 requires the candidateRecordId leg when artifactIndex alone matches', () => {
    const artifactIndexOnly = record(1, { candidateRecordId: 'artifact:2' })
    const card = selectCandidatePortfolioFitCardViewModel(
      project(result({ records: [artifactIndexOnly] })),
      1,
      'actionable',
    )

    expect(card?.state).toBe('missing')
  })

  it('R1 rejects OR semantics for either asymmetric one-leg record', () => {
    for (const mismatched of [
      record(1, { candidateRecordId: 'artifact:2' }),
      record(2, { candidateRecordId: 'artifact:1' }),
    ]) {
      expect(selectCandidatePortfolioFitCardViewModel(
        project(result({ records: [mismatched] })),
        1,
        'actionable',
      )?.state).toBe('missing')
    }
  })

  it('R1 rejects a first-match fallback for the two-record collision fixture', () => {
    const collision = [
      record(1, { candidateRecordId: 'artifact:2' }),
      record(2, { candidateRecordId: 'artifact:1' }),
    ]

    expect(selectCandidatePortfolioFitCardViewModel(
      project(result({ records: collision })),
      1,
      'actionable',
    )?.state).toBe('missing')
  })

  it('R1 keeps zero and duplicate exact matches fail-closed', () => {
    const empty = project(result({ records: [] }))
    const duplicates = project(result({ records: [record(1), record(1)] }))

    expect(selectCandidatePortfolioFitCardViewModel(empty, 1, 'actionable')?.state)
      .toBe('missing')
    expect(selectCandidatePortfolioFitCardViewModel(
      duplicates,
      1,
      'actionable',
    )?.state).toBe('missing')
  })
})
