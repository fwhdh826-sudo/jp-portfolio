import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Holding, Trust } from '../../types'
import { importPortfolioCsv } from './importPortfolioCsv'
import { computeAnalysis } from '../analysis/computeAnalysis'
import { STATIC_MARKET } from '../../constants/market'
import { buildCsvSyncSummary } from '../../store/useAppStore'

// P4.5-A013-T1: このファイルは元々「あるべき仕様」ではなく、P4.5-A013-AUDITで確認した
// 現行のupdate-onlyマージ挙動をそのまま固定するテストとして作られた。
//
// 【P4.5-A013-T1bで修正済み】
// T1のテスト作成中、実際のSBI CSV（data/private/sbi/trust_holdings.csv、個人データの
// ためリポジトリ未追跡）のヘッダーが "損益（％）"「前日比（％）」のように全角括弧・
// 全角％を使うのに対し、buildHeaderMapのcandidate文字列は全角のまま比較されるため
// findColumnが一致せず、pnlPctCol/dayPctColが常に-1になりCSV取込のたびに個別株の
// pnlPct・投信のpnlPct/dayPctが強制的に0へ上書きされるバグを発見した。
// findColumn側でもcandidateにnormalizeCellを適用する修正（importPortfolioCsv.ts）に
// より解消済み。
//
// 【P4.5-A013-T2で個別株をfull-sync化】
// 個別株はCSVをsource of truthとして扱うよう変更した:
//   - existing + absent from CSV → 物理削除（判断対象から除外）
//   - CSV-only + new → 新規Holdingとして追加（安全なdefault metadataを使用）
// このファイルの「個別株」ブロックは、上記のfull-sync後の挙動を固定する。
//
// 【P4.5-A013-T3で投信もfull-sync化】
// 投信もCSVをsource of truthとして扱うよう変更した。ただしtrust masterの
// id/policy/account等はregistryとして維持するため、個別株のような物理削除は
// しない:
//   - existing + in CSV → eval/pnlPct/dayPctを更新（既存挙動のまま）
//   - existing + absent from CSV → 物理削除ではなくeval=0化（解約済み扱い。
//     idはregistryに残るため再保有時に復元できる）
//   - CSVに存在するがtrust masterに無い投信（unknown fund） → 既存ファンドへ
//     誤マッチさせず、黙って無視もせず、trustSync.unknownFundsで報告する
//   - accountHint喪失等で同名複数口座を一意に確定できない場合 →
//     推測して合算値を書き込まず、該当ファンドの更新を停止する
//     （trustSync.ambiguousFundIdsで報告する）
// 投信テストのCSVには、T2で追加したfail-closedガード（個別株行0件→エラー）を
// 満たすため、無害な個別株スタブセクションを先頭に付与している。
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReaderPolyfill {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
    onerror: (() => void) | null = null
    result: ArrayBuffer | null = null
    readAsArrayBuffer(file: File) {
      file.arrayBuffer().then(buf => {
        this.result = buf
        this.onload?.({ target: { result: buf } })
      }).catch(() => {
        this.onerror?.()
      })
    }
  }
  // @ts-expect-error Node環境専用の最小FileReader polyfill
  globalThis.FileReader = NodeFileReaderPolyfill
}

function makeCsvFile(content: string, filename = 'portfolio.csv'): File {
  return new File([content], filename)
}

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '0000',
    name: 'テスト銘柄',
    eval: 100_000,
    pnlPct: 0,
    currentPrice: 1000,
    mu: 0.05,
    sigma: 0.20,
    sigmaSource: 'static',
    beta: 1.0,
    sector: 'テスト',
    target: 1000,
    alert: 800,
    lock: false,
    mitsu: false,
    ma: true,
    rsi: 50,
    macd: true,
    vol: false,
    mom3m: 0,
    roe: 10,
    per: 15,
    pbr: 1.0,
    epsG: 5,
    cfOk: true,
    de: 0.5,
    divG: 3,
    score: 70,
    decision: 'HOLD',
    ev: 0,
    ...overrides,
  }
}

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'test_fund',
    name: 'テストファンド',
    abbr: 'テスト',
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: 1_000_000,
    pnlPct: 10,
    dayPct: 0,
    cost: 0.2,
    mu: 0.1,
    sigma: 0.15,
    score: 50,
    signal: 'HOLD',
    ev: 0,
    decision: 'HOLD',
    ...overrides,
  }
}

// 実際のSBI CSVヘッダー形式（全角（％）表記）。以後の全テストでこの実物形式を使う。
const STOCK_HEADER = '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日'
const TRUST_HEADER = 'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日'

// 投信専用テストで「有効株式行0件→エラー」ガードを満たすための無害なスタブ
// （holdings=[]で呼ぶ限り、6501は新規追加されるだけで各テストのtrust断言に影響しない）。
const STOCK_STUB_CSV = [
  '株式（現物/特定預り）',
  STOCK_HEADER,
  '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
].join('\n')

// ═══════════════════════════════════════════════════════════
// 回帰ガード: 全角（％）ヘッダーでもpnlPct/dayPctが正しく反映される（P4.5-A013-T1bで修正）
// ═══════════════════════════════════════════════════════════
describe('importPortfolioCsv: 全角（％）ヘッダーでもpnlPct/dayPctがCSV実値へ正しく更新される', () => {
  it('個別株: 実SBI形式ヘッダーのCSV pnlPct値がholding.pnlPctへ反映される', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000, pnlPct: 42, currentPrice: 8000 })]
    const csv = STOCK_STUB_CSV

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    const h = result.holdings.find(x => x.code === '6501')!
    expect(h.eval).toBe(900_000)
    expect(h.currentPrice).toBe(8500)
    expect(h.pnlPct).toBe(15.2)
  })

  it('投信: 実SBI形式ヘッダーのCSV pnlPct/dayPct値がfund.pnlPct/dayPctへ反映される', async () => {
    const trust = [makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', account: '特定', eval: 4_000_000, pnlPct: 90, dayPct: -3 })]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    const f = result.trust.find(x => x.id === 'sp500_sbi')!
    expect(f.eval).toBe(4_500_000)
    expect(f.pnlPct).toBe(95.5)
    expect(f.dayPct).toBe(-1.8)
  })
})

// ═══════════════════════════════════════════════════════════
// 個別株（P4.5-A013-T2: full-sync）
// ═══════════════════════════════════════════════════════════
describe('importPortfolioCsv: 個別株 — full-sync挙動の固定', () => {
  it('existing + in CSV: eval / pnlPct / currentPrice / acquiredAt が更新され、既存metadataは維持される', async () => {
    const holdings = [
      makeHolding({ code: '6501', name: '日立製作所', eval: 800_000, pnlPct: 5, currentPrice: 8000, acquiredAt: '2025-01-01' }),
    ]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    const h = result.holdings.find(x => x.code === '6501')!
    expect(h.eval).toBe(900_000)
    expect(h.currentPrice).toBe(8500)
    expect(h.acquiredAt).toBe('2025-06-01')
    expect(h.pnlPct).toBe(15.2)
    // name/sector等の静的属性は変更されない
    expect(h.name).toBe('日立製作所')
    expect(h.sector).toBe('テスト')
  })

  it('existing + absent from CSV: 判断対象から除外される（=売却済み銘柄として物理削除）', async () => {
    const holdings = [
      makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 }),
      makeHolding({ code: '7203', name: 'トヨタ自動車', eval: 500_000, pnlPct: 3 }),
    ]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    expect(result.holdings).toHaveLength(1)
    expect(result.holdings.find(x => x.code === '7203')).toBeUndefined()
    expect(result.holdings.find(x => x.code === '6501')).toBeDefined()
  })

  it('new + in CSV: CSV-only銘柄が安全なdefault metadataで新規Holdingとして追加される', async () => {
    const holdings = [
      makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 }),
    ]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      '6701,日本電気,2200,220000,8.50,0.50,2026-05-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    expect(result.holdings).toHaveLength(2)
    const nec = result.holdings.find(x => x.code === '6701')!
    expect(nec).toBeDefined()
    expect(nec.name).toBe('日本電気')
    expect(nec.eval).toBe(220_000)
    expect(nec.pnlPct).toBe(8.5)
    expect(nec.currentPrice).toBe(2200)
    expect(nec.acquiredAt).toBe('2026-05-01')
    // 未知metadataは捏造しない: 実データを持たない項目は「未取得」を表す
    // 保守的なdefaultのみ（sector/roe/per/pbr/cfOk等）で、score/decision/evは
    // runFullAnalysis前のプレースホルダのまま
    expect(nec.sector).toBe('未分類')
    expect(nec.roe).toBe(0)
    expect(nec.per).toBe(0)
    expect(nec.pbr).toBe(0)
    expect(nec.cfOk).toBe(false)
    expect(nec.score).toBe(0)
    expect(nec.decision).toBe('HOLD')
    expect(nec.ev).toBe(0)
  })

  it('metadata安全性: 新規追加銘柄はcomputeAnalysisでBUY判定にならない（mu=RFによるEVゲート）', async () => {
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6701,日本電気,2200,220000,8.50,0.50,2026-05-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], [])
    const nec = result.holdings.find(x => x.code === '6701')!

    const analysis = computeAnalysis([nec], STATIC_MARKET, null, null)
    const a = analysis.find(x => x.code === '6701')!
    // totalScoreの値に関わらず、ev<=0のためdecisionは絶対にBUYにならない
    expect(a.ev).toBeLessThanOrEqual(0)
    expect(a.decision).not.toBe('BUY')
  })

  it('同一コード複数行: eval集約・pnlPct/price加重平均・acquiredAt最新日付採用', async () => {
    const holdings = [
      makeHolding({ code: '6501', name: '日立製作所', eval: 100_000, pnlPct: 0, currentPrice: 1000, acquiredAt: '2024-01-01' }),
    ]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,600000,20.00,1.00,2025-03-01',
      '6501,日立製作所,8700,300000,10.00,2.00,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    const h = result.holdings.find(x => x.code === '6501')!
    expect(h.eval).toBe(900_000)
    expect(h.pnlPct).toBeCloseTo(16.47, 2)
    expect(h.currentPrice).toBeCloseTo(8566.67, 2)
    // 複数行のうち最新（最大）日付が採用される
    expect(h.acquiredAt).toBe('2025-06-01')
  })

  it('0件CSV: 有効な行がない場合はエラーになる', async () => {
    const holdings = [makeHolding({ code: '6501' })]
    await expect(importPortfolioCsv(makeCsvFile(''), holdings, [])).rejects.toThrow(
      'CSV: 有効な行が見つかりませんでした',
    )
  })

  it('CSV契約: 個別株セクションが無いCSV（trust-only CSV）はrejectされる（既存保有・投信は変更されない）', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const trust = [makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', eval: 1_000_000, pnlPct: 10 })]
    // 投信のみのCSV（個別株セクションを含まない）。個別株のfull-syncは
    // 個別株セクションの検出が前提のため、trust-only CSVは丸ごとrejectする。
    const csv = [
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
    ].join('\n')

    const before = JSON.stringify({ holdings, trust })
    await expect(importPortfolioCsv(makeCsvFile(csv), holdings, trust)).rejects.toThrow(
      'CSVに個別株の保有行が見つかりませんでした',
    )
    // atomicity: reject時は呼び出し元から渡された配列そのものも変更されない
    expect(JSON.stringify({ holdings, trust })).toBe(before)
  })

  it('CSV契約: 投信セクションが無いCSV（stock-only CSV）は受理され、投信はそのまま維持される', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const trust = [makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', eval: 1_000_000, pnlPct: 10 })]
    // 個別株セクションのみのCSV（投信セクションを含まない）。
    // 投信はT3までupdate-onlyのため、投信セクション欠落は削除リスクがなく安全。
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, trust)
    expect(result.holdings.find(x => x.code === '6501')!.eval).toBe(900_000)
    expect(result.trust).toEqual(trust)
  })

  it('fail-closedガード: 既存保有の過半数（消滅率50%超）がCSVに見つからない場合はエラーになり削除しない', async () => {
    const holdings = [
      makeHolding({ code: '6501' }),
      makeHolding({ code: '7203' }),
      makeHolding({ code: '9984' }),
    ]
    // 3件中1件のみ一致（消滅率66.7% > 50%閾値のため、消滅率条件でblockされる）
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const before = JSON.stringify(holdings)
    await expect(importPortfolioCsv(makeCsvFile(csv), holdings, [])).rejects.toThrow(
      'CSVに見つかりませんでした',
    )
    expect(JSON.stringify(holdings)).toBe(before)
  })

  it('fail-closedガード: 消滅率が50%以下でも絶対消滅件数が5件を超える場合はエラーになる', async () => {
    // 大規模ポートフォリオ（16件）で6件消滅＝消滅率37.5%（50%閾値未満）だが、
    // 絶対件数6件は5件キャップを超えるためblockされる（比率だけでは検知できない
    // 大規模PF特有のリスクを絶対件数条件が補完する）
    const holdings = Array.from({ length: 16 }, (_, i) => makeHolding({ code: String(1000 + i) }))
    const matchedCodes = holdings.slice(0, 10).map(h => h.code)
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      ...matchedCodes.map(code => `${code},テスト銘柄,1000,100000,0,0,`),
    ].join('\n')

    await expect(importPortfolioCsv(makeCsvFile(csv), holdings, [])).rejects.toThrow(
      'CSVに見つかりませんでした',
    )
  })

  it('正常な少数売却: 消滅率・絶対件数のいずれの閾値も超えない場合はfull-syncとして成功する', async () => {
    // 16件中1件のみCSVから消える（消滅率6.25%、絶対件数1件）— 正常な運用として成功する
    const holdings = Array.from({ length: 16 }, (_, i) => makeHolding({ code: String(1000 + i) }))
    const matchedCodes = holdings.slice(0, 15).map(h => h.code)
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      ...matchedCodes.map(code => `${code},テスト銘柄,1000,100000,0,0,`),
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    expect(result.holdings).toHaveLength(15)
    expect(result.holdings.find(x => x.code === holdings[15].code)).toBeUndefined()
  })

  describe('最小再現ケース（P4.5-A013-AUDIT §2-5、T2aで消滅率ガードを再評価した後の挙動）', () => {
    it('3銘柄中2銘柄が消える（消滅率66.7%）ため、full-syncはfail-closedでブロックされる', async () => {
      // P4.5-A013-T2時点ではこのケース（3→1、消滅率66.7%）を「正常なfull-sync」
      // として成功させていたが、小規模ポートフォリオでの過半数消失を見逃す
      // 安全性の弱さがT2aで判明したため、50%消滅率ガードにより意図的にblockする
      // よう変更した。実運用でこのケースを通したい場合は、ユーザーが確認の上で
      // 再取込むフロー（将来チケット）が必要になる。
      const holdings = [
        makeHolding({ code: '6501', name: '日立製作所', eval: 800_000, pnlPct: 5, currentPrice: 8000 }),
        makeHolding({ code: '7203', name: 'トヨタ自動車', eval: 500_000, pnlPct: 3, currentPrice: 2500 }),
        makeHolding({ code: '9984', name: 'ソフトバンクグループ', eval: 300_000, pnlPct: -2, currentPrice: 8000 }),
      ]
      const csv = [
        '株式（現物/特定預り）',
        STOCK_HEADER,
        '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
        '6701,日本電気,2200,220000,8.50,0.50,2026-05-01',
      ].join('\n')

      const before = JSON.stringify(holdings)
      await expect(importPortfolioCsv(makeCsvFile(csv), holdings, [])).rejects.toThrow(
        'CSVに見つかりませんでした',
      )
      // atomicity: rejectされた場合、既存保有は一切変更されない
      expect(JSON.stringify(holdings)).toBe(before)
    })
  })
})

// ═══════════════════════════════════════════════════════════
// 個別株 — 英字入りJPX証券コード（P4.5-A013-HARDENING-F3）
// 東証は2024年1月以降の新規上場コードから、従来の数字4桁に加えて4桁目に英字
// （数字と紛らわしい「I」「O」を除くA-Z）を使用する運用を開始した。
// 旧実装（stockRows filter: /^\d{4}$/、extractStockCode: /(\d{4})/）はこれらの
// 有効なコードをsilent dropしていた。
// ═══════════════════════════════════════════════════════════
describe('importPortfolioCsv: 英字入りJPX証券コード（P4.5-A013-HARDENING-F3）', () => {
  it('既存の数字4桁コード（6501）は引き続き正しく取込まれる（回帰なし）', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    expect(result.holdings).toHaveLength(1)
    expect(result.holdings.find(x => x.code === '6501')?.eval).toBe(900_000)
  })

  it('英字入りコード（285A）の新規追加: silent dropされずstockRowsへ到達し新規Holdingとして追加される', async () => {
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      '285A,新規上場銘柄,3000,300000,0,0,2026-01-15',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], [])
    expect(result.holdings).toHaveLength(2)
    const added = result.holdings.find(x => x.code === '285A')
    expect(added).toBeDefined()
    expect(added?.eval).toBe(300_000)
    expect(added?.name).toBe('新規上場銘柄')
  })

  it('英字入りコード（130A）の既存更新: 既存保有のeval/pnlPctがCSV値へ正しく更新される', async () => {
    const holdings = [
      makeHolding({ code: '130A', name: '新規上場銘柄B', eval: 100_000, pnlPct: 0 }),
    ]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '130A,新規上場銘柄B,4200,420000,12.00,0.80,2026-02-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    const h = result.holdings.find(x => x.code === '130A')!
    expect(h).toBeDefined()
    expect(h.eval).toBe(420_000)
    expect(h.pnlPct).toBe(12.0)
    expect(h.currentPrice).toBe(4200)
  })

  it('全角文字正規化の回帰: 全角数字・全角英字のコードセルもNFKC正規化後に半角コードとして一致する', async () => {
    const holdings = [makeHolding({ code: '285A', name: '新規上場銘柄', eval: 100_000 })]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      // コードセルが全角（２８５Ａ）で来ても既存銘柄285Aと一致する必要がある
      '２８５Ａ,新規上場銘柄,3200,320000,5.00,0.10,2026-01-20',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    expect(result.holdings).toHaveLength(1)
    const h = result.holdings.find(x => x.code === '285A')!
    expect(h).toBeDefined()
    expect(h.eval).toBe(320_000)
  })

  it('不正なコード文字列は誤って有効なコードとして受理されない（該当行はstockRowsに到達しない）', async () => {
    // 先頭3桁が数字でない・4桁を満たさない・過去はエラー無く単に無視されていた
    // ケースと同じ扱い（今回のcharset拡張後も無条件受理にはしない）
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      'ABCD,不正コード銘柄,1000,100000,0,0,',
      '12,不正コード銘柄2,1000,100000,0,0,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    // 6501のみ取込まれ、ABCD/12由来の銘柄は追加されない
    expect(result.holdings).toHaveLength(1)
    expect(result.holdings.find(x => x.code === '6501')).toBeDefined()
  })

  it('csvSyncSummary集計: 英字入りコードの新規追加もstock.addedへ正しくカウントされる', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      '285A,新規上場銘柄,3000,300000,0,0,2026-01-15',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    const summary = buildCsvSyncSummary(holdings, result.holdings, [], result.trust, result.trustSync, '2026-07-11T00:00:00.000Z')
    expect(summary.stock.added).toBe(1)
    expect(summary.stock.updated).toBe(1)
    expect(summary.stock.removed).toBe(0)
  })

  it('total assets/headroom: 英字入りコードの保有もeval合算に到達できる（silent dropで欠落しない）', async () => {
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      '285A,新規上場銘柄,3000,300000,0,0,2026-01-15',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], [])
    const totalEval = result.holdings.reduce((sum, h) => sum + h.eval, 0)
    expect(totalEval).toBe(900_000 + 300_000)
  })
})

// ═══════════════════════════════════════════════════════════
// 投信
// ═══════════════════════════════════════════════════════════
describe('importPortfolioCsv: 投信 — P4.5-A013-T3 full-sync挙動の固定', () => {
  it('existing + in CSV: eval / pnlPct / dayPct が更新される', async () => {
    const trust = [
      makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', account: '特定', eval: 4_000_000, pnlPct: 90, dayPct: 0 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    const f = result.trust.find(x => x.id === 'sp500_sbi')!
    expect(f.eval).toBe(4_500_000)
    expect(f.pnlPct).toBe(95.5)
    expect(f.dayPct).toBe(-1.8)
  })

  it('existing + absent from CSV: 物理削除ではなくeval=0化される（解約済み投信として判断対象から除外、registryは維持）', async () => {
    const trust = [
      makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', account: '特定', eval: 4_000_000, pnlPct: 90, policy: 'OVERSEAS_LONGTERM' }),
      makeTrust({ id: 'gold_mufg', name: '三菱UFJ純金ファンド', account: 'NISA成長', eval: 100_000, pnlPct: -1, policy: 'GOLD' }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    const gold = result.trust.find(x => x.id === 'gold_mufg')!
    // 物理削除ではなく残存する（idはregistryとして維持され再保有時に復元できる）
    expect(result.trust).toHaveLength(2)
    expect(gold.eval).toBe(0)
    expect(gold.pnlPct).toBe(0)
    expect(gold.dayPct).toBe(0)
    // policy/account等のmetadataは捏造されず維持される
    expect(gold.policy).toBe('GOLD')
    expect(gold.account).toBe('NISA成長')
    expect(result.trustSync.zeroedFundIds).toEqual(['gold_mufg'])
  })

  it('registered fund (eval=0) + in CSV: match成立時にeval / pnlPct / dayPctが更新される（新規購入の反映経路）', async () => {
    const trust = [
      makeTrust({ id: 'acwi_tsumi', name: 'eMAXIS Slim全世界株式', account: 'NISA積立', eval: 0, pnlPct: 0, dayPct: 0 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/NISA預り(つみたて投資枠)）',
      TRUST_HEADER,
      'eMAXIS Slim全世界株式,15000,300000,3.20,-0.50,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    const f = result.trust.find(x => x.id === 'acwi_tsumi')!
    expect(f.eval).toBe(300_000)
    expect(f.pnlPct).toBe(3.2)
    expect(f.dayPct).toBe(-0.5)
  })

  it('unknown fund + in CSV: 既存ファンドへ誤マッチさせず、捏造もせず、trustSync.unknownFundsで報告される', async () => {
    const trust = [
      makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', account: '特定', eval: 4_000_000, pnlPct: 90 }),
      makeTrust({ id: 'gold_mufg', name: '三菱UFJ純金ファンド', account: 'NISA成長', eval: 100_000, pnlPct: -1 }),
      makeTrust({ id: 'acwi_tsumi', name: 'eMAXIS Slim全世界株式', account: 'NISA積立', eval: 0, pnlPct: 0 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
      '謎の投信,10000,150000,5.00,0.20,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    // unknown fundは新規Trustとして追加されない（fabricateしない）
    expect(result.trust).toHaveLength(3)
    // マッチした行はsp500のみ更新される
    expect(result.trust.find(x => x.id === 'sp500_sbi')!.eval).toBe(4_500_000)
    // gold_mufgはCSVに見つからないためfull-syncでeval=0化される（謎の投信の値が紛れ込むことはない）
    expect(result.trust.find(x => x.id === 'gold_mufg')!.eval).toBe(0)
    expect(result.trust.find(x => x.id === 'acwi_tsumi')!.eval).toBe(0)
    expect(result.trust.some(f => f.eval === 150_000)).toBe(false)
    // unknown fundの件数・名称・評価額はtrustSyncで返される（silent ignoreしない）
    expect(result.trustSync.unknownFunds).toHaveLength(1)
    expect(result.trustSync.unknownFunds[0].name).toBe('謎の投信')
    expect(result.trustSync.unknownFunds[0].eval).toBe(150_000)
  })

  it('同一ファンド名・accountHintが正しく検出できている場合は口座ごとに正しく振り分けられる', async () => {
    const trust = [
      makeTrust({ id: 'dup_toku', name: 'セゾン共有ファンド', account: '特定', eval: 100, pnlPct: 0 }),
      makeTrust({ id: 'dup_nisa', name: 'セゾン共有ファンド', account: 'NISA成長', eval: 100, pnlPct: 0 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'セゾン共有ファンド,12000,1200000,15.00,0.80,',
      '投資信託（金額/NISA預り(成長投資枠)）',
      TRUST_HEADER,
      'セゾン共有ファンド,12000,600000,8.00,0.80,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    expect(result.trust.find(x => x.id === 'dup_toku')!.eval).toBe(1_200_000)
    expect(result.trust.find(x => x.id === 'dup_nisa')!.eval).toBe(600_000)
    expect(result.trustSync.ambiguousFundIds).toEqual([])
  })

  it('accountHint喪失（小規模な影響）: 同名複数口座を一意に確定できないファンドは更新を停止するだけで、他のファンド・全体の取込には影響しない', async () => {
    // '一般預り'はdetectAccountHintのどのパターンにも一致しないためaccountHint=''になる。
    // dup_toku/dup_nisaは同名なので一意に決められずambiguous扱いになるが、
    // 他4ファンドは正しくaccountHintが取れているCSVのため、全体消滅率は50%を
    // 超えず（6件中2件=33%）、取込自体は成功する。
    const trust = [
      makeTrust({ id: 'dup_toku', name: 'セゾン共有ファンド', account: '特定', eval: 1_000_000, pnlPct: 10 }),
      makeTrust({ id: 'dup_nisa', name: 'セゾン共有ファンド', account: 'NISA成長', eval: 500_000, pnlPct: 5 }),
      makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', account: '特定', eval: 4_000_000, pnlPct: 90 }),
      makeTrust({ id: 'us_reit', name: 'eMAXIS Slim先進国REIT', account: '特定', eval: 300_000, pnlPct: 3 }),
      makeTrust({ id: 'gold_mufg', name: '三菱UFJ純金ファンド', account: 'NISA成長', eval: 100_000, pnlPct: -1 }),
      makeTrust({ id: 'acwi', name: 'eMAXIS Slim全世界株式', account: 'NISA成長', eval: 200_000, pnlPct: 2 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/一般預り）',
      TRUST_HEADER,
      'セゾン共有ファンド,12000,1200000,15.00,0.80,',
      'セゾン共有ファンド,12000,600000,8.00,0.80,',
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
      'eMAXIS Slim先進国REIT,18000,320000,4.00,0.10,',
      '投資信託（金額/NISA預り(成長投資枠)）',
      TRUST_HEADER,
      '三菱UFJ純金ファンド,20000,110000,-0.50,0.30,',
      'eMAXIS Slim全世界株式,15000,210000,3.00,-0.20,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    const toku = result.trust.find(x => x.id === 'dup_toku')!
    const nisa = result.trust.find(x => x.id === 'dup_nisa')!

    // 合算値(1,800,000)を書き込まず、更新前のstale値のまま停止する（silent corruption禁止）
    expect(toku.eval).toBe(1_000_000)
    expect(nisa.eval).toBe(500_000)
    expect(result.trustSync.ambiguousFundIds.sort()).toEqual(['dup_nisa', 'dup_toku'])

    // accountHintが正しく検出できた他のファンドは通常通りfull-syncされる
    expect(result.trust.find(x => x.id === 'sp500_sbi')!.eval).toBe(4_500_000)
    expect(result.trust.find(x => x.id === 'us_reit')!.eval).toBe(320_000)
    expect(result.trust.find(x => x.id === 'gold_mufg')!.eval).toBe(110_000)
    expect(result.trust.find(x => x.id === 'acwi')!.eval).toBe(210_000)
  })

  it('fail-closedガード: 登録済み投信の過半数（未照合率50%超）がaccountHint喪失で一意照合できない場合は取込全体を中断する', async () => {
    // 登録2件中2件（100%）がambiguousになる小規模ケース。個別株T2aと同じ思想で、
    // 小規模registryでの過半数異常を検知してfail-closedにする。
    const trust = [
      makeTrust({ id: 'dup_toku', name: 'セゾン共有ファンド', account: '特定', eval: 1_000_000, pnlPct: 10 }),
      makeTrust({ id: 'dup_nisa', name: 'セゾン共有ファンド', account: 'NISA成長', eval: 500_000, pnlPct: 5 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/一般預り）',
      TRUST_HEADER,
      'セゾン共有ファンド,12000,1200000,15.00,0.80,',
      'セゾン共有ファンド,12000,600000,8.00,0.80,',
    ].join('\n')

    const beforeTrust = JSON.stringify(trust)
    await expect(importPortfolioCsv(makeCsvFile(csv), [], trust)).rejects.toThrow(
      'CSVで一意に照合できませんでした',
    )
    // atomicity: rejectされた場合、既存投信は一切変更されない
    expect(JSON.stringify(trust)).toBe(beforeTrust)
  })

  it('fail-closedガード: 投信セクションはあるが保有行が0件の場合（セクション自体が無い場合とは区別する）はfail-closedで中断する', async () => {
    const trust = [
      makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', eval: 4_000_000, pnlPct: 90 }),
      makeTrust({ id: 'gold_mufg', name: '三菱UFJ純金ファンド', account: 'NISA成長', eval: 100_000, pnlPct: -1 }),
    ]
    // 投信セクションの見出し・ヘッダー行はあるが、ファンド行が1件も続かない
    // （＝「全投信を解約した」full-sync要求だが、現在保有中2件が100%消滅する
    // ため投信ガードでブロックされる）
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
    ].join('\n')

    const beforeTrust = JSON.stringify(trust)
    await expect(importPortfolioCsv(makeCsvFile(csv), [], trust)).rejects.toThrow(
      'CSVで一意に照合できませんでした',
    )
    expect(JSON.stringify(trust)).toBe(beforeTrust)
  })

  it('投信セクション欠落: 投信セクション自体が無いCSV（stock-onlyのCSV）では投信は一切変更されない（セクション0件とは区別する）', async () => {
    const trust = [makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', eval: 4_000_000, pnlPct: 90 })]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trust)
    expect(result.trust).toEqual(trust)
    expect(result.trustSync).toEqual({ trustSectionSeen: false, unknownFunds: [], zeroedFundIds: [], ambiguousFundIds: [] })
  })

  it('fail-closedガード: 既存保有投信の消滅率が50%を超える場合は取込全体を中断する（小規模registry・比率条件の単独検証）', async () => {
    // 3件中1件のみCSVに存在（消滅率66.7% > 50%閾値、絶対消滅件数2件は5件キャップ未満）
    const trust = [
      makeTrust({ id: 'f0', name: 'ファンドA', account: '特定', eval: 100_000 }),
      makeTrust({ id: 'f1', name: 'ファンドB', account: '特定', eval: 100_000 }),
      makeTrust({ id: 'f2', name: 'ファンドC', account: '特定', eval: 100_000 }),
    ]
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'ファンドA,10000,150000,1.00,0.10,',
    ].join('\n')

    await expect(importPortfolioCsv(makeCsvFile(csv), [], trust)).rejects.toThrow(
      'CSVで一意に照合できませんでした',
    )
  })

  it('fail-closedガード: 消滅率が50%以下でも絶対消滅件数が5件を超える場合は取込全体を中断する（大規模registry・絶対件数条件の単独検証）', async () => {
    // 16件中10件消滅＝消滅率62.5%…ではなく、絶対件数条件を単独検証するため
    // 16件中6件消滅（消滅率37.5%、50%閾値未満）だが絶対件数6件は5件キャップ超過
    const trust = Array.from({ length: 16 }, (_, i) => makeTrust({ id: `f${i}`, name: `ファンド${i}`, account: '特定', eval: 100_000 }))
    const matchedFunds = trust.slice(0, 10)
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      ...matchedFunds.map(f => `${f.name},10000,150000,1.00,0.10,`),
    ].join('\n')

    await expect(importPortfolioCsv(makeCsvFile(csv), [], trust)).rejects.toThrow(
      'CSVで一意に照合できませんでした',
    )
  })

  it('fail-closedガード: unknown fundが5件を超える場合は取込全体を中断する', async () => {
    const trust = [makeTrust({ id: 'sp500_sbi', name: 'SBI・V・S&P500', account: '特定', eval: 4_000_000, pnlPct: 90 })]
    const unknownNames = ['謎1', '謎2', '謎3', '謎4', '謎5', '謎6']
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
      ...unknownNames.map(name => `${name},10000,50000,1.00,0.10,`),
    ].join('\n')

    const beforeTrust = JSON.stringify(trust)
    await expect(importPortfolioCsv(makeCsvFile(csv), [], trust)).rejects.toThrow(
      'trust masterに登録されていない投信',
    )
    expect(JSON.stringify(trust)).toBe(beforeTrust)
  })

  it('atomicity: 投信ガードでrejectされた場合、既存保有株も一切変更されない', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const trust = [
      makeTrust({ id: 'dup_toku', name: 'セゾン共有ファンド', account: '特定', eval: 1_000_000, pnlPct: 10 }),
      makeTrust({ id: 'dup_nisa', name: 'セゾン共有ファンド', account: 'NISA成長', eval: 500_000, pnlPct: 5 }),
    ]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8600,950000,18.00,2.00,2025-07-01',
      '投資信託（金額/一般預り）',
      TRUST_HEADER,
      'セゾン共有ファンド,12000,1200000,15.00,0.80,',
      'セゾン共有ファンド,12000,600000,8.00,0.80,',
    ].join('\n')

    const beforeHoldings = JSON.stringify(holdings)
    const beforeTrust = JSON.stringify(trust)
    await expect(importPortfolioCsv(makeCsvFile(csv), holdings, trust)).rejects.toThrow(
      'CSVで一意に照合できませんでした',
    )
    // 投信ガードでの中断でも、個別株側の妥当な更新は一切適用されない（全体アトミック）
    expect(JSON.stringify(holdings)).toBe(beforeHoldings)
    expect(JSON.stringify(trust)).toBe(beforeTrust)
  })
})

// ═══════════════════════════════════════════════════════════
// trust execution detectionとの回帰確認（P4.5-A013-T3）
// ═══════════════════════════════════════════════════════════
describe('importPortfolioCsv: 投信full-syncとtrust execution detectionの整合性', () => {
  // detectTrustExecutionFromCsvSyncはwindow.localStorageに前回スナップショットを
  // 保存する。window未スタブ（デフォルトのnode環境）だとisBrowser()が常にfalseに
  // なり「前回スナップショットなし」の分岐（executed:false固定）しか通らず、
  // 比較ロジック自体が実行されない。ここでは実際に比較ロジックへ到達させるため
  // window.localStorageをスタブする。
  let store: Record<string, string>
  const lsMock = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('CSVに見つからず物理削除ではなくeval=0化されたJAPAN_SHORTTERM投信は、detectTrustExecutionFromCsvSyncにおいてexecution=trueと誤判定されない', async () => {
    const { detectTrustExecutionFromCsvSync } = await import('../learning/trustShortTracker')
    store = {}
    vi.stubGlobal('window', { localStorage: lsMock })

    const trustDay1 = [
      makeTrust({ id: 'nk225_sbi', name: 'SBI 日経225', account: '特定', policy: 'JAPAN_SHORTTERM', eval: 500_000, pnlPct: -1 }),
      makeTrust({ id: '4x3bull', name: 'SBI 4.3ブル', account: '特定', policy: 'JAPAN_SHORTTERM', eval: 900_000, pnlPct: -14 }),
    ]
    // 前日分のスナップショットを先に確立しておく
    detectTrustExecutionFromCsvSync(trustDay1, '2026-07-10T00:00:00.000Z')

    // 翌日のCSVでは4x3bullの行が消えている（full-syncにより物理削除ではなくeval=0化される）
    const csv = [
      STOCK_STUB_CSV,
      '投資信託（金額/特定預り）',
      TRUST_HEADER,
      'SBI 日経225,12000,505000,-0.50,0.10,',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), [], trustDay1)
    const bull = result.trust.find(x => x.id === '4x3bull')!
    expect(bull.eval).toBe(0)
    expect(bull.policy).toBe('JAPAN_SHORTTERM')

    const detection = detectTrustExecutionFromCsvSync(result.trust, '2026-07-11T00:00:00.000Z')
    // eval=0化（4x3bullの-900,000）は減少のため一切集計されず、nk225_sbiの
    // 軽微な増加（+5,000）のみがabsDiffSumに計上される
    expect(detection.executed).toBe(false)
    expect(detection.absDiffSum).toBe(5_000)
    expect(detection.changedFunds).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 文字コード（UTF-8 / Shift-JIS 両対応）
// ═══════════════════════════════════════════════════════════
describe('importPortfolioCsv: 文字コード判定', () => {
  it('UTF-8: 日本語を含むCSVを正しくデコード・パースできる', async () => {
    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const csv = [
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    ].join('\n')

    const result = await importPortfolioCsv(makeCsvFile(csv), holdings, [])
    expect(result.holdings.find(x => x.code === '6501')!.eval).toBe(900_000)
  })

  it('Shift-JIS: 日本語を含むCSVを正しくデコード・パースできる', async () => {
    // 内容（Python `str.encode('shift_jis')` で生成・decode roundtripで検証済みのバイト列。
    // 個人の実データではなく、この日立製作所/6501のサンプルはテスト用の合成値）:
    //   株式（現物/特定預り）
    //   銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日
    //   6501,日立製作所,9500,950000,12.50,1.20,2025-08-01
    const shiftJisHex =
      '8a948eae81698cbb95a82f93c192e8976182e8816a0d0a96c195bf8352815b83682c96c195bf96bc2c8cbb8ddd926c2c955d89bf' +
      '8a7a2c91b9897681698193816a2c914f93fa94e481698193816a2c8ee693be93fa0d0a' +
      '363530312c93fa97a790bb8dec8f8a2c393530302c3935303030302c31322e35302c312e32302c323032352d30382d30310d0a'
    const bytes = new Uint8Array(shiftJisHex.match(/.{2}/g)!.map(byte => Number.parseInt(byte, 16)))
    const file = new File([bytes], 'sjis.csv')

    const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
    const result = await importPortfolioCsv(file, holdings, [])
    const utf8Result = await importPortfolioCsv(makeCsvFile([
      '株式（現物/特定預り）',
      STOCK_HEADER,
      '6501,日立製作所,9500,950000,12.50,1.20,2025-08-01',
    ].join('\n')), holdings, [])
    const h = result.holdings.find(x => x.code === '6501')!
    expect(h.eval).toBe(950_000)
    expect(h.pnlPct).toBe(12.5)
    expect(h.currentPrice).toBe(9500)
    expect(h.acquiredAt).toBe('2025-08-01')
    expect(result.sourceProvenance.semanticIdentity).toBe(utf8Result.sourceProvenance.semanticIdentity)
  })

  it('row order / whitespace / line ending / irrelevant column differences keep one semantic identity', async () => {
    const first = [
      '株式（現物/特定預り）',
      `${STOCK_HEADER},メモ`,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01,first',
      '7203,トヨタ自動車,3000,600000,5.00,0.50,2025-07-01,ignored A',
    ].join('\r\n')
    const second = [
      '株式（現物/特定預り）',
      `${STOCK_HEADER},別メモ`,
      ' 7203 , トヨタ自動車 , 3000 , 600000 , 5.00 , 0.50 , 2025-07-01 ,ignored B',
      ' 6501 , 日立製作所 , 8500 , 900000 , 15.20 , 1.10 , 2025-06-01 ,second',
    ].join('\n')

    const firstResult = await importPortfolioCsv(makeCsvFile(first), [], [])
    const secondResult = await importPortfolioCsv(makeCsvFile(second), [], [])
    expect(firstResult.sourceProvenance.semanticIdentity)
      .toBe(secondResult.sourceProvenance.semanticIdentity)
  })

  it('a relevant parsed field difference changes semantic identity', async () => {
    const base = STOCK_STUB_CSV
    const changed = STOCK_STUB_CSV.replace('900000', '900001')
    const baseResult = await importPortfolioCsv(makeCsvFile(base), [], [])
    const changedResult = await importPortfolioCsv(makeCsvFile(changed), [], [])
    expect(baseResult.sourceProvenance.semanticIdentity)
      .not.toBe(changedResult.sourceProvenance.semanticIdentity)
  })
})

describe('T9-A004-R1-F1: semantic row ordering is a locale-independent total order', () => {
  const stockSection = (rows: string[], account = '特定預り') => [
    `株式（現物/${account}）`,
    STOCK_HEADER,
    ...rows,
  ].join('\n')
  const trustSection = (rows: string[], account = '特定預り') => [
    `投資信託（金額/${account}）`,
    TRUST_HEADER,
    ...rows,
  ].join('\n')
  const identity = async (csv: string) =>
    (await importPortfolioCsv(makeCsvFile(csv), [], [])).sourceProvenance.semanticIdentity

  it('keeps the known あ / ア reverse-order counterexample identical even if the runtime collation treats them as equal', async () => {
    const first = [
      STOCK_STUB_CSV,
      trustSection([
        'あ,10000,100000,1.00,0.10,',
        'ア,10000,200000,2.00,0.20,',
      ]),
    ].join('\n')
    const reversed = [
      STOCK_STUB_CSV,
      trustSection([
        'ア,10000,200000,2.00,0.20,',
        'あ,10000,100000,1.00,0.10,',
      ]),
    ].join('\n')
    const nativeLocaleCompare = String.prototype.localeCompare
    const localeSpy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) {
      const left = String(this)
      const right = String(other)
      const isCounterexample = [left, right].some(value => value.includes('"name":"あ"')) &&
        [left, right].some(value => value.includes('"name":"ア"'))
      return isCounterexample ? 0 : nativeLocaleCompare.call(left, right)
    })

    try {
      expect(await identity(first)).toBe(await identity(reversed))
    } finally {
      localeSpy.mockRestore()
    }
  })

  it.each([
    ['ordinary stock',
      stockSection([
        '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
        '7203,トヨタ自動車,3000,600000,5.00,0.50,2025-07-01',
      ]),
      stockSection([
        '7203,トヨタ自動車,3000,600000,5.00,0.50,2025-07-01',
        '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      ])],
    ['trust',
      [STOCK_STUB_CSV, trustSection([
        'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
        'eMAXIS Slim 全世界株式,21000,3500000,55.00,0.80,',
      ])].join('\n'),
      [STOCK_STUB_CSV, trustSection([
        'eMAXIS Slim 全世界株式,21000,3500000,55.00,0.80,',
        'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
      ])].join('\n')],
    ['mixed assets',
      [stockSection(['6501,日立製作所,8500,900000,15.20,1.10,2025-06-01']),
        trustSection(['SBI・V・S&P500,26000,4500000,95.50,-1.80,'])].join('\n'),
      [trustSection(['SBI・V・S&P500,26000,4500000,95.50,-1.80,']),
        stockSection(['6501,日立製作所,8500,900000,15.20,1.10,2025-06-01'])].join('\n')],
    ['same name with different codes',
      stockSection([
        '6501,同名銘柄,8500,900000,15.20,1.10,2025-06-01',
        '7203,同名銘柄,3000,600000,5.00,0.50,2025-07-01',
      ]),
      stockSection([
        '7203,同名銘柄,3000,600000,5.00,0.50,2025-07-01',
        '6501,同名銘柄,8500,900000,15.20,1.10,2025-06-01',
      ])],
  ])('%s rows have one identity when input order is reversed', async (_label, first, reversed) => {
    expect(await identity(first)).toBe(await identity(reversed))
  })

  it('preserves same-code rows with different account hints and remains order-independent', async () => {
    const taxable = stockSection([
      '6501,日立製作所,8500,600000,15.20,1.10,2025-06-01',
    ], '特定預り')
    const nisa = stockSection([
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
    ], 'NISA預り（成長投資枠）')

    expect(await identity([taxable, nisa].join('\n')))
      .toBe(await identity([nisa, taxable].join('\n')))

    const redistributedTaxable = stockSection([
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
    ], '特定預り')
    const redistributedNisa = stockSection([
      '6501,日立製作所,8500,600000,15.20,1.10,2025-06-01',
    ], 'NISA預り（成長投資枠）')
    expect(await identity([taxable, nisa].join('\n')))
      .not.toBe(await identity([redistributedTaxable, redistributedNisa].join('\n')))
  })

  it.each([
    ['code', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '7203,日立製作所,8500,900000,15.20,1.10,2025-06-01'],
    ['name', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '6501,日立製作所A,8500,900000,15.20,1.10,2025-06-01'],
    ['eval', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '6501,日立製作所,8500,900001,15.20,1.10,2025-06-01'],
    ['pnlPct', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '6501,日立製作所,8500,900000,15.21,1.10,2025-06-01'],
    ['dayPct', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '6501,日立製作所,8500,900000,15.20,1.11,2025-06-01'],
    ['price', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '6501,日立製作所,8501,900000,15.20,1.10,2025-06-01'],
    ['acquiredAt', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', '6501,日立製作所,8500,900000,15.20,1.10,2025-06-02'],
  ])('%s remains identity-relevant', async (_field, first, changed) => {
    expect(await identity(stockSection([first])))
      .not.toBe(await identity(stockSection([changed])))
  })

  it('does not lose duplicate-row multiplicity', async () => {
    const row = '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01'
    expect(await identity(stockSection([row])))
      .not.toBe(await identity(stockSection([row, row])))
  })

  it.each([
    ['NFKC full-width/half-width', 'ABC', 'ＡＢＣ'],
    ['NFKC composed/decomposed', 'é', 'e\u0301'],
  ])('%s representations normalize to one identity', async (_label, firstName, secondName) => {
    const row = (name: string) => `6501,${name},8500,900000,15.20,1.10,2025-06-01`
    expect(await identity(stockSection([row(firstName)])))
      .toBe(await identity(stockSection([row(secondName)])))
  })
})

describe('T9-A004-R1-F1: invalid explicit timestamp precedence', () => {
  it('rejects recognized invalid authority before row parsing or full-sync guards', async () => {
    await expect(importPortfolioCsv(
      makeCsvFile('データ基準日時,2026-02-30'),
      [],
      [],
    )).rejects.toMatchObject({
      name: 'InvalidCsvSourceTimestampError',
      code: 'INVALID_CSV_SOURCE_TIMESTAMP',
      rawValue: '2026-02-30',
    })
  })
})

describe('T9-A001/A002-R2: FileReader Promise totality', () => {
  const originalReader = globalThis.FileReader
  const holdings = [makeHolding({ code: '6501', name: '日立製作所', eval: 800_000 })]
  const VALID_UTF8_CSV = [
    '株式（現物/特定預り）',
    STOCK_HEADER,
    '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
  ].join('\n')

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalReader) globalThis.FileReader = originalReader
  })

  function installReader(
    trigger: (reader: {
      onload: ((event: ProgressEvent<FileReader>) => void) | null
      onerror: (() => void) | null
      onabort: (() => void) | null
    }) => void,
  ) {
    class AdversarialFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      readAsArrayBuffer() { trigger(this) }
    }
    vi.stubGlobal('FileReader', AdversarialFileReader)
  }

  const settleWithin = <T>(promise: Promise<T>) => Promise.race([
    promise.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 30)),
  ])

  it('settles when an unexpected exception occurs inside the asynchronous onload callback', async () => {
    installReader(reader => {
      queueMicrotask(() => {
        try {
          reader.onload?.({
            target: {
              get result() { throw new Error('result getter exploded') },
            },
          } as unknown as ProgressEvent<FileReader>)
        } catch {
          // Browsers report uncaught event-listener exceptions out-of-band. Keeping the
          // harness alive lets Promise.race prove whether the wrapper settled.
        }
      })
    })

    const settled = await settleWithin(importPortfolioCsv(makeCsvFile(VALID_UTF8_CSV), holdings, []))
    expect(settled.kind).toBe('rejected')
  })

  it.each([
    ['error', (reader: any) => reader.onerror?.()],
    ['abort', (reader: any) => reader.onabort?.()],
    ['null target', (reader: any) => reader.onload?.({ target: null })],
  ])('settles for async %s', async (_label, fire) => {
    installReader(reader => queueMicrotask(() => fire(reader)))
    const settled = await settleWithin(importPortfolioCsv(makeCsvFile(VALID_UTF8_CSV), holdings, []))
    expect(settled.kind).toBe('rejected')
  })

  it('settles when readAsArrayBuffer throws synchronously', async () => {
    class ThrowingReader {
      onload = null
      onerror = null
      onabort = null
      readAsArrayBuffer() { throw new Error('sync read exploded') }
    }
    vi.stubGlobal('FileReader', ThrowingReader)
    const settled = await settleWithin(importPortfolioCsv(makeCsvFile(VALID_UTF8_CSV), holdings, []))
    expect(settled.kind).toBe('rejected')
  })

  it('honors only the first terminal event', async () => {
    installReader(reader => queueMicrotask(() => {
      reader.onerror?.()
      reader.onload?.({ target: { result: new TextEncoder().encode(VALID_UTF8_CSV).buffer } } as unknown as ProgressEvent<FileReader>)
    }))
    const settled = await settleWithin(importPortfolioCsv(makeCsvFile(VALID_UTF8_CSV), holdings, []))
    expect(settled.kind).toBe('rejected')
  })

  it('ignores an error event after a successful onload settlement', async () => {
    installReader(reader => queueMicrotask(() => {
      reader.onload?.({ target: { result: new TextEncoder().encode(VALID_UTF8_CSV).buffer } } as unknown as ProgressEvent<FileReader>)
      reader.onerror?.()
    }))
    const settled = await settleWithin(importPortfolioCsv(makeCsvFile(VALID_UTF8_CSV), holdings, []))
    expect(settled.kind).toBe('resolved')
  })

  it('converts a decoder exception into rejection', async () => {
    const NativeTextDecoder = TextDecoder
    class ThrowingDecoder extends NativeTextDecoder {
      decode(): string { throw new Error('decoder exploded') }
    }
    vi.stubGlobal('TextDecoder', ThrowingDecoder)
    installReader(reader => queueMicrotask(() => {
      reader.onload?.({ target: { result: new TextEncoder().encode(VALID_UTF8_CSV).buffer } } as unknown as ProgressEvent<FileReader>)
    }))
    const settled = await settleWithin(importPortfolioCsv(makeCsvFile(VALID_UTF8_CSV), holdings, []))
    expect(settled.kind).toBe('rejected')
  })
})
