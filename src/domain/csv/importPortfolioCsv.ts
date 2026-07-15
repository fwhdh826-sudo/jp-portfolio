import type { CsvSourceProvenance, Holding, Trust } from '../../types'
import {
  buildCsvSourceProvenance,
  extractExplicitSourceTimestamp,
  InvalidCsvSourceTimestampError,
} from './csvProvenance'
import { compareCsvSemanticRows, type CsvSemanticRow } from './csvSemanticIdentity'

type AssetType = 'stock' | 'trust'
type AccountHint = '' | '特定' | 'NISA成長' | 'NISA積立'

interface ParsedRow {
  assetType: AssetType
  code: string
  name: string
  eval: number
  pnlPct: number
  dayPct: number
  price: number
  acquiredAt?: string
  accountHint: AccountHint
}

interface HeaderMap {
  codeCol: number
  nameCol: number
  evalCol: number
  pnlPctCol: number
  dayPctCol: number
  priceCol: number
  acquiredAtCol: number
}

interface SectionContext {
  type: AssetType
  accountHint: AccountHint
}

// P4.5-A013-HARDENING-F3: 東証は2024年1月以降に上場する新規コードから、従来の数字4桁に
// 加えて4桁目に英字を使用する運用を開始した（例: 130A, 285A）。数字と視覚的に紛らわしい
// 「I」「O」の2文字は割当対象から除外されているため、4桁目は数字10種+英字24種の34種。
// 先頭3桁は従来通り数字のみ（業種割当の名残）。stockRowsのフィルタ（fail-closedの
// 安全網）とextractStockCode（CSVセルからの抽出）で同一の形式を共有する。
const STOCK_CODE_FULL_RE = /^\d{3}[0-9A-HJ-NP-Z]$/
const STOCK_CODE_SEARCH_RE = /\d{3}[0-9A-HJ-NP-Z]/

interface AggregatedState {
  assetType: AssetType
  code: string
  name: string
  accountHint: AccountHint
  eval: number
  cost: number
  dayWeighted: number
  dayWeight: number
  priceWeighted: number
  priceWeight: number
  acquiredAt: string | null
}

// P4.5-A013-T2: 個別株はCSVをsource of truthとしてfull-syncする
// （CSVにない既存保有は「売却済み」として除外し、CSVにしかない銘柄は新規追加する）。
// 削除を伴うため、CSVが不完全/別物である可能性を検知した場合は
// silent successにせずfail-closedで中断する（下記2つのガード参照）。
//
// P4.5-A013-T2a: 消滅率のみのガード（旧: 0.8）は小規模ポートフォリオで統計的に
// 脆弱だった（3銘柄中1銘柄しか一致しない=消滅率66.7%を「多少の入れ替え」として
// 通過させ、2銘柄を物理削除してしまう）。比率単独・絶対件数単独のどちらも
// 単体では不十分（比率は小規模Nで数字が暴れる／絶対件数は大規模PFでは
// 相対的な異常さを検知できない）ため、以下の複合条件のいずれかを満たせば
// fail-closedにする:
//   - 消滅率 > 50%（既存保有の"過半数"が消える＝小規模PFでの異常を検知）
//   - 絶対消滅件数 > 5（大規模PFでも「一度に5銘柄超の売却」は通常の運用より
//     CSV異常を疑うべき規模、という単純な固定閾値）
// 50%は「半分未満の入れ替えは通常のポートフォリオ運用として許容し、過半数
// 消失のみ異常とみなす」という直感的な境界。5件は「同一importで同時に
// 数銘柄を超えて売却するのは典型的な運用頻度を超える」という保守的な目安。
// いずれも恣意的な単一の数字ではなく、小規模/大規模PF双方の脅威モデルを
// カバーするための組み合わせとして選定した（詳細はP4.5-A013-T2a報告を参照）。
// P4.5-A013-T7: portfolio snapshot v2のholdings full-syncも同じ脅威モデル
// （外部ソースからのfull-syncで大量消滅を安全に検知する）を共有するため、
// この2定数をexportして再利用する（値・根拠は変更しない）。
export const STOCK_REMOVAL_RATIO_THRESHOLD = 0.5
export const STOCK_REMOVAL_ABSOLUTE_CAP = 5

// P4.5-A013-T3: 投信もCSVをsource of truthとしてfull-sync化する。
// 個別株と異なり、trust masterのid/policy/account/mu/sigma等はregistryとして
// 維持したい（同じidで再保有された時にmetadataを捏造せず復元するため、また
// trust候補ユニバース（buildCandidateUniverseはeval<=0を候補として扱う。
// roleExposure/zeroBaseはeval>0のみ合算する）が既にeval=0を「未保有」として
// 正しく扱う設計になっているため）。よって個別株のような物理削除ではなく、
// 「CSVに見つからない登録済み投信はeval/pnlPct/dayPctを0にする」を採用する。
//
// 投信はtrust masterのid単位でaccountも固定登録されている（例: 同じS&P500でも
// 特定/NISA成長/NISA積立はそれぞれ別idで登録される）ため、通常はCSVのaccountHint
// と組み合わせれば一意に照合できる。問題は、CSVのセクション見出しから
// accountHintを検出できない場合（detectAccountHintがどのパターンにも
// 一致しない未知のセクション種別）に、同名の登録投信が複数account存在すると
// どちらの実体を指しているか判別できなくなることで、この状態で推測合算した
// 値を両方へ書き込むと口座間の資産量を捏造してしまう（P4.5-A013-T2aで
// 固定化されていた既知バグ）。よって以下の複合ガードを設ける:
//   - 現在保有中(eval>0)の登録済み投信のうち、CSVで一意に照合できなかった
//     （ambiguous or CSV上で見つからない）比率が50%を超える
//   - 同、絶対件数が5件を超える
//   - trust masterに存在しないCSV行（unknown fund）が5件を超える
// 個別株ガード(T2a)と数値は揃えているが、投信はaccount単位で別レコードとして
// 登録されるregistry構造のため、根拠は個別株ガードとは独立に導出したもの
// （同じ「小規模PFでの過半数異常」「大規模PFでの絶対件数異常」という脅威モデルが
// そのまま当てはまるため同じ0.5/5を採用した。恣意的なコピーではない）。
const TRUST_UNSYNCED_RATIO_THRESHOLD = 0.5
const TRUST_UNSYNCED_ABSOLUTE_CAP = 5
// 未登録投信（trust masterに無い名前）が一度のCSVで大量に出るのは、通常の
// 「新規購入したがまだmaster登録していない」運用頻度を超える規模。別ポート
// フォリオ/別人のCSVを取り違えた可能性を疑うべき閾値として5件を採用。
const TRUST_UNKNOWN_ABSOLUTE_CAP = 5
const TRUST_MATCH_SCORE_THRESHOLD = 40

/** SBI証券CSVパーサー（ブラウザ側）
 *  - 従来形式（銘柄コード列あり）と新形式（銘柄（コード）/ファンド名）の両対応
 *  - 同一銘柄の複数行を集約して取込
 *  - 特定/NISA成長/NISA積立の投信セクションを分離して照合
 *
 * P4.5-A013-T3: source-of-truth契約（明文化・T2aから更新）
 *   - 想定入力: SBI証券「ポートフォリオ一覧」の全体エクスポートCSV
 *     （個別株セクション + 投信セクションを同一ファイルに含む）
 *   - 契約方式: 「セクション単位で、存在する資産クラスだけfull-syncする」
 *     （個別株・投信を1つのフラグで一括制御せず、各セクションの有無で
 *     それぞれ独立にfull-sync要否を判定する）
 *   - 個別株: セクションが無いCSVはfull-syncの安全性を検証できないため
 *     丸ごとreject（既存ガード、変更なし）。セクションがあれば従来通り
 *     full-sync（CSVにあれば新規追加、CSVになければ物理削除）。
 *   - 投信: セクションが「存在しない」場合と「存在するが保有行0件」の場合を
 *     区別する。
 *       - セクション自体が存在しない（投信セクション見出し行が1つも無い）:
 *         投信は一切変更しない（stock-onlyのCSVを安全に許可するための現状維持）。
 *       - セクションは存在するが保有行が0件（見出しはあるがファンド行が無い、
 *         または全行がeval<=0で捨てられた）: 「全投信を解約した」と解釈して
 *         full-syncを試みる。ただしこれは現在保有中の投信をほぼ全件eval=0化
 *         することになるため、上記の投信ガードにより通常はfail-closedで
 *         ブロックされる（大量解約を安全に反映したい場合は将来チケットで
 *         確認フローが必要になる。個別株ガードの既知の限界と同じ設計判断）。
 *   - 許可される入力: 全体エクスポート／stock-onlyのCSV
 *     拒否される入力: trust-onlyのCSV（個別株セクション0件）、
 *       投信ガード条件を満たすCSV（投信セクションのみが原因でも株式含め全体reject）
 */
export interface TrustSyncReport {
  /** CSVに投信セクション（見出し行）が検出されたか。falseの場合、投信は一切変更していない
   *  （P4.5-A013-T6: 呼び出し側でCSV sync summaryを組み立てる際、投信セクション自体が
   *  無かったのか、セクションはあったが変更対象が0件だったのかを区別するために公開する） */
  trustSectionSeen: boolean
  /** trust masterに存在しないCSV行（既存ファンドへ誤マッチさせず、捏造もせず、そのまま報告する） */
  unknownFunds: { name: string; eval: number; accountHint: AccountHint }[]
  /** CSVに見つからず、物理削除ではなくeval=0化した登録済み投信のid */
  zeroedFundIds: string[]
  /** accountHint喪失等で口座を一意に確定できず、更新を停止した登録済み投信のid */
  ambiguousFundIds: string[]
}

export async function importPortfolioCsv(
  file: File,
  holdings: Holding[],
  trust: Trust[],
): Promise<{ holdings: Holding[]; trust: Trust[]; trustSync: TrustSyncReport; sourceProvenance: CsvSourceProvenance }> {
  const text = await readFileAsText(file)
  const explicitSourceTimestamp = extractExplicitSourceTimestamp(text)
  if (explicitSourceTimestamp.status === 'invalid') {
    throw new InvalidCsvSourceTimestampError(explicitSourceTimestamp.rawValue)
  }
  const { rows, semanticRows: parsedSemanticRows, trustSectionSeen } = parseRows(text)
  if (rows.length === 0) throw new Error('CSV: 有効な行が見つかりませんでした')

  const stockRows = rows.filter((row): row is ParsedRow & { code: string } => row.assetType === 'stock' && STOCK_CODE_FULL_RE.test(row.code))
  const trustRows = rows.filter(row => row.assetType === 'trust')

  // fail-closedガード1: 個別株セクションが検出できないCSVでは、
  // 既存保有を全消去してしまう危険があるため取込全体を中断する
  // （投信のみのCSV等、個別株セクションを含まない部分取込は現状未対応）。
  if (stockRows.length === 0) {
    throw new Error(
      'CSVに個別株の保有行が見つかりませんでした。取込を中断しました（保有株・投信は変更されていません）。' +
      'SBI証券の「ポートフォリオ一覧」CSV（個別株セクションを含む全体エクスポート）か確認してください。',
    )
  }

  const stockByCode = new Map(stockRows.map(row => [row.code, row]))
  const csvStockCodes = new Set(stockRows.map(row => row.code))

  // fail-closedガード2: 既存保有の消滅が「消滅率>50%」または「絶対件数>5件」
  // のいずれかに該当する場合、本当に売却されたのか部分CSV/別物のCSVなのか
  // 区別できないため、削除を伴う取込全体を中断する（理由は上記コメント参照）。
  if (holdings.length > 0) {
    const removedCount = holdings.filter(h => !csvStockCodes.has(h.code)).length
    const removalRatio = removedCount / holdings.length
    const ratioExceeded = removalRatio > STOCK_REMOVAL_RATIO_THRESHOLD
    const absoluteExceeded = removedCount > STOCK_REMOVAL_ABSOLUTE_CAP
    if (ratioExceeded || absoluteExceeded) {
      throw new Error(
        `既存保有銘柄${holdings.length}件中${removedCount}件がCSVに見つかりませんでした` +
        `（消滅率${Math.round(removalRatio * 100)}%）。部分CSVや別のCSVの可能性があるため、` +
        '取込を中断しました（保有株・投信は変更されていません）。',
      )
    }
  }

  // 既存銘柄: CSVにあれば値更新（既存metadataは維持）、なければ配列から除外する
  const updatedExistingHoldings = holdings
    .filter(holding => csvStockCodes.has(holding.code))
    .map(holding => {
      const row = stockByCode.get(holding.code)!
      return {
        ...holding,
        eval: row.eval > 0 ? row.eval : holding.eval,
        pnlPct: Number.isFinite(row.pnlPct) ? row.pnlPct : holding.pnlPct,
        currentPrice: row.price > 0 ? row.price : holding.currentPrice,
        acquiredAt: row.acquiredAt ?? holding.acquiredAt,
      }
    })

  // 新規銘柄: CSVにしか存在しない銘柄を安全なdefault metadataで追加する
  const existingCodes = new Set(holdings.map(h => h.code))
  const newHoldings = stockRows
    .filter(row => !existingCodes.has(row.code))
    .map(buildNewHoldingFromCsvRow)

  const updatedHoldings = [...updatedExistingHoldings, ...newHoldings]

  // P4.5-A013-T3: 投信full-sync。投信セクションが存在しない場合は現状維持
  // （trust masterへ一切触れない）。存在する場合のみマッチング・ガード判定・
  // full-syncを行う（「セクション欠落」と「セクションはあるが0件」を区別する）。
  let updatedTrust: Trust[] = trust
  let trustSync: TrustSyncReport = { trustSectionSeen: false, unknownFunds: [], zeroedFundIds: [], ambiguousFundIds: [] }

  if (trustSectionSeen) {
    const { matchedByFundId, ambiguousFundIds, unknownRows } = matchTrustHoldings(trust, trustRows)

    // fail-closedガード3: 現在保有中(eval>0)の登録済み投信のうち、CSVで一意に
    // 照合できなかった（eval=0化 or 口座あいまいで更新停止）割合・件数が
    // 大きい場合、投信セクションの解析不良や部分/別CSVの可能性を疑い、
    // 取込全体（個別株含む）を中断する（根拠は上部の定数コメント参照）。
    const currentlyHeldTrust = trust.filter(f => f.eval > 0)
    if (currentlyHeldTrust.length > 0) {
      const unsyncedCount = currentlyHeldTrust.filter(f => !matchedByFundId.has(f.id)).length
      const unsyncedRatio = unsyncedCount / currentlyHeldTrust.length
      const ratioExceeded = unsyncedRatio > TRUST_UNSYNCED_RATIO_THRESHOLD
      const absoluteExceeded = unsyncedCount > TRUST_UNSYNCED_ABSOLUTE_CAP
      if (ratioExceeded || absoluteExceeded) {
        throw new Error(
          `既存保有投信${currentlyHeldTrust.length}件中${unsyncedCount}件がCSVで一意に照合できませんでした` +
          `（未照合率${Math.round(unsyncedRatio * 100)}%）。投信セクションの解析不良・口座情報欠落・` +
          '部分/別CSVの可能性があるため、取込を中断しました（保有株・投信は変更されていません）。',
        )
      }
    }

    // fail-closedガード4: trust masterに存在しない投信（unknown fund）が
    // 一度のCSVで大量に出た場合、別ポートフォリオ/別人のCSVを取り違えている
    // 可能性があるため、取込全体を中断する（根拠は上部の定数コメント参照）。
    if (unknownRows.length > TRUST_UNKNOWN_ABSOLUTE_CAP) {
      throw new Error(
        `trust masterに登録されていない投信がCSV中に${unknownRows.length}件見つかりました。` +
        '件数が多く別のポートフォリオ/別人のCSVを取り違えている可能性があるため、' +
        '取込を中断しました（保有株・投信は変更されていません。該当投信をtrust masterへ登録してから再取込してください）。',
      )
    }

    updatedTrust = trust.map(fund => {
      const matchedRow = matchedByFundId.get(fund.id)
      if (matchedRow) {
        return {
          ...fund,
          eval: matchedRow.eval > 0 ? matchedRow.eval : fund.eval,
          pnlPct: Number.isFinite(matchedRow.pnlPct) ? matchedRow.pnlPct : fund.pnlPct,
          dayPct: Number.isFinite(matchedRow.dayPct) ? matchedRow.dayPct : fund.dayPct,
        }
      }
      // accountHint喪失等で口座を一意に確定できない: 推測して書き込まず、更新を停止する
      if (ambiguousFundIds.has(fund.id)) return fund
      // CSVに見つからない登録済み投信: 物理削除ではなくeval=0化する
      // （id/policy/account/mu/sigma等のregistryは維持し、再保有時に復元できるようにする）
      if (fund.eval === 0 && fund.pnlPct === 0 && fund.dayPct === 0) return fund
      return { ...fund, eval: 0, pnlPct: 0, dayPct: 0 }
    })

    trustSync = {
      trustSectionSeen: true,
      unknownFunds: unknownRows.map(row => ({ name: row.name, eval: row.eval, accountHint: row.accountHint })),
      zeroedFundIds: trust
        .filter(f => f.eval > 0 && !matchedByFundId.has(f.id) && !ambiguousFundIds.has(f.id))
        .map(f => f.id),
      ambiguousFundIds: [...ambiguousFundIds],
    }
  }

  const semanticRows = parsedSemanticRows
    .map((row): CsvSemanticRow => ({
      assetType: row.assetType,
      code: row.code,
      name: normalizeCell(row.name),
      eval: Object.is(row.eval, -0) ? 0 : row.eval,
      pnlPct: Object.is(row.pnlPct, -0) ? 0 : row.pnlPct,
      dayPct: Object.is(row.dayPct, -0) ? 0 : row.dayPct,
      price: Object.is(row.price, -0) ? 0 : row.price,
      acquiredAt: row.acquiredAt ?? null,
      accountHint: row.accountHint,
    }))
    .sort(compareCsvSemanticRows)
  const sourceProvenance = buildCsvSourceProvenance({
    text,
    fileName: String(file.name || ''),
    fileLastModified: Number(file.lastModified || 0),
    semanticContent: { trustSectionSeen, rows: semanticRows },
  })

  return { holdings: updatedHoldings, trust: updatedTrust, trustSync, sourceProvenance }
}

// P4.5-A013-T2: CSVにしか存在しない新規銘柄のHolding生成。
// ファンダ/テクニカルのmetadataはCSVに含まれないため捏造せず、
// 「情報不足＝BUYを出さない」方向に倒す安全なdefaultを使う。
// 中心的な安全機構: mu=RF（無リスク金利=0.005。市場超過リターン不明のため
// 超過リターン0と仮定）とすることで、calcEV()（h.mu - RF - sigma由来ペナルティ）
// が sigma>0 である限り必ず負になり、decision==='BUY'の必須条件
// （totalScore>=75 かつ ev>0、computeAnalysis.ts参照）を構造的に満たせなくする。
// sector/roe/per/pbr等の個別スコア分岐は、UIの「—」表示規約（値>0のときのみ
// 表示）に合わせて0/false/未分類を使い、実データの捏造ではなく
// 「未取得」を意味する値にしている。
// P4.5-A013-T7: portfolio snapshot v2の新規銘柄追加でもこの同じsafe default方針を
// 再利用するため、exportして共有する（値・ロジックは変更しない）。
export function buildNewHoldingFromCsvRow(row: ParsedRow & { code: string }): Holding {
  return {
    code: row.code,
    name: row.name,
    eval: row.eval,
    pnlPct: Number.isFinite(row.pnlPct) ? row.pnlPct : 0,
    currentPrice: row.price > 0 ? row.price : undefined,
    mu: 0.005,
    sigma: 0.25,
    sigmaSource: 'static',
    beta: 1.0,
    sector: '未分類',
    target: 0,
    alert: 0,
    lock: false,
    acquiredAt: row.acquiredAt,
    mitsu: false,
    ma: false,
    rsi: 50,
    macd: false,
    vol: false,
    mom3m: 0,
    roe: 0,
    per: 0,
    pbr: 0,
    epsG: 0,
    cfOk: false,
    de: 1.5,
    divG: 0,
    score: 0,
    decision: 'HOLD',
    ev: 0,
  }
}

// ── ファイル読み込み（UTF-8 / Shift-JIS判定）───────────────────
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let reader: FileReader

    const cleanup = () => {
      try { reader.onload = null } catch { /* cleanup is best-effort after settlement */ }
      try { reader.onerror = null } catch { /* cleanup is best-effort after settlement */ }
      try { reader.onabort = null } catch { /* cleanup is best-effort after settlement */ }
    }
    const settleResolve = (value: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const settleReject = (reason: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      let detail = 'unknown callback failure'
      try { detail = reason instanceof Error ? reason.message : String(reason) } catch { /* hostile error value */ }
      reject(new Error(`ファイル読み込みエラー${detail ? `: ${detail}` : ''}`))
    }

    try {
      reader = new FileReader()
    } catch (error) {
      reject(new Error(`ファイル読み込みエラー: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    reader.onload = event => {
      try {
        const target = event.target
        if (!target) throw new Error('読み込み結果を取得できませんでした')
        const result = target.result
        if (!(result instanceof ArrayBuffer)) throw new Error('読み込み結果の形式が不正です')
        const utf8 = decodeBuffer(result, 'utf-8')
        const sjis = decodeBuffer(result, 'shift-jis')
        settleResolve(scoreDecodedText(utf8) >= scoreDecodedText(sjis) ? utf8 : sjis)
      } catch (error) {
        settleReject(error)
      }
    }
    reader.onerror = () => {
      try { settleReject(reader.error ?? new Error('FileReader error event')) } catch (error) { settleReject(error) }
    }
    reader.onabort = () => settleReject(new Error('ファイル読み込みが中断されました'))

    try {
      reader.readAsArrayBuffer(file)
    } catch (error) {
      settleReject(error)
    }
  })
}

function decodeBuffer(buffer: ArrayBuffer, encoding: 'utf-8' | 'shift-jis') {
  return new TextDecoder(encoding).decode(buffer)
}

function scoreDecodedText(text: string) {
  if (!text) return -9999
  let score = 0
  const keywords = ['銘柄', '評価額', '投資信託', '株式', '買付日', '損益', '前日比']
  keywords.forEach(keyword => {
    if (text.includes(keyword)) score += 25
  })
  const japaneseCount = (text.match(/[ぁ-んァ-ヶ一-龠]/g) ?? []).length
  score += Math.min(250, japaneseCount * 0.05)
  const brokenCharCount = (text.match(/�/g) ?? []).length
  score -= brokenCharCount * 8
  return score
}

// ── CSVパース ─────────────────────────────────────────────────
function parseRows(text: string): {
  rows: ParsedRow[]
  semanticRows: ParsedRow[]
  trustSectionSeen: boolean
} {
  const lines = text.split(/\r?\n/)
  const parsedRows: ParsedRow[] = []
  let section: SectionContext | null = null
  let header: HeaderMap | null = null
  let trustSectionSeen = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const cols = splitCsvLine(line)
    const normalizedCols = cols.map(normalizeCell)
    const first = normalizedCols[0] ?? ''

    const nextSection = detectSection(first)
    if (nextSection) {
      section = nextSection
      header = null
      if (nextSection.type === 'trust') trustSectionSeen = true
      continue
    }

    const maybeHeader = detectHeader(normalizedCols, section?.type ?? null)
    if (maybeHeader) {
      header = buildHeaderMap(normalizedCols)
      if (maybeHeader === 'stock') {
        section = {
          type: 'stock',
          accountHint: section?.accountHint ?? '',
        }
      } else {
        section = {
          type: 'trust',
          accountHint: section?.accountHint ?? '',
        }
        trustSectionSeen = true
      }
      continue
    }

    if (!section || !header) continue
    if (isSummaryRow(first)) continue

    const row = section.type === 'stock'
      ? parseStockRow(cols, header, section.accountHint)
      : parseTrustRow(cols, header, section.accountHint)

    if (row) parsedRows.push(row)
  }

  return { rows: aggregateRows(parsedRows), semanticRows: parsedRows, trustSectionSeen }
}

function detectSection(firstCellRaw: string): SectionContext | null {
  const first = normalizeCell(firstCellRaw)
  if (!first) return null
  if (first.includes('株式') && first.includes('預り')) {
    return {
      type: 'stock',
      accountHint: detectAccountHint(first),
    }
  }
  if (first.includes('投資信託') && first.includes('預り')) {
    return {
      type: 'trust',
      accountHint: detectAccountHint(first),
    }
  }
  return null
}

function detectAccountHint(labelRaw: string): AccountHint {
  const label = normalizeCell(labelRaw).replace(/\s/g, '')
  if (label.includes('特定預り')) return '特定'
  if (label.includes('NISA預り(成長投資枠)') || label.includes('NISA預り（成長投資枠）')) return 'NISA成長'
  if (label.includes('NISA預り(つみたて投資枠)') || label.includes('NISA預り（つみたて投資枠）')) return 'NISA積立'
  return ''
}

function detectHeader(cells: string[], currentType: AssetType | null): AssetType | null {
  const hasEval = cells.some(cell => cell.includes('評価額') || cell.includes('時価評価額'))
  if (!hasEval) return null
  if (cells.some(cell => cell.includes('ファンド名'))) return 'trust'
  if (cells.some(cell => cell.includes('銘柄') || cell.includes('コード'))) return 'stock'
  return currentType
}

function buildHeaderMap(cells: string[]): HeaderMap {
  return {
    codeCol: findColumn(cells, ['銘柄コード', 'コード', '銘柄コード（ファンドコード）']),
    nameCol: findColumn(cells, ['銘柄（コード）', '銘柄名', '銘柄', 'ファンド名']),
    evalCol: findColumn(cells, ['評価額', '時価評価額']),
    pnlPctCol: findColumn(cells, ['損益（％）', '損益率', '評価損益率']),
    dayPctCol: findColumn(cells, ['前日比（％）', '騰落率']),
    priceCol: findColumn(cells, ['現在値', '現在単価', '基準価額']),
    acquiredAtCol: findColumn(cells, ['取得日', '買付日', '購入日']),
  }
}

function findColumn(cells: string[], candidates: string[]) {
  // cellsは呼び出し元でnormalizeCell（NFKC）済み（全角括弧・全角％等は半角化される）。
  // candidate側も同じ正規化を通してから比較しないと、candidateを全角表記のまま書いた場合に
  // 一致しなくなる（実SBI CSVの「損益（％）」「前日比（％）」ヘッダーで再現）。
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCell(candidate)
    const idx = cells.findIndex(cell => cell.includes(normalizedCandidate))
    if (idx >= 0) return idx
  }
  return -1
}

function parseStockRow(cols: string[], header: HeaderMap, accountHint: AccountHint): ParsedRow | null {
  const codeCell = getCell(cols, header.codeCol) || getCell(cols, header.nameCol) || getCell(cols, 0)
  const code = extractStockCode(codeCell)
  if (!code) return null

  const nameCell = getCell(cols, header.nameCol) || getCell(cols, 0)
  const name = cleanupStockName(nameCell, code)
  if (!name) return null

  const evalValue = parseNum(getCell(cols, header.evalCol))
  if (evalValue <= 0) return null

  const pnlPct = parseNum(getCell(cols, header.pnlPctCol))
  const dayPct = parseNum(getCell(cols, header.dayPctCol))
  const price = parseNum(getCell(cols, header.priceCol))
  const acquiredAt = normalizeDate(getCell(cols, header.acquiredAtCol))

  return {
    assetType: 'stock',
    code,
    name,
    eval: evalValue,
    pnlPct,
    dayPct,
    price,
    acquiredAt: acquiredAt ?? undefined,
    accountHint,
  }
}

function parseTrustRow(cols: string[], header: HeaderMap, accountHint: AccountHint): ParsedRow | null {
  const name = getCell(cols, header.nameCol) || getCell(cols, 0)
  if (!name || isSummaryRow(name)) return null
  const evalValue = parseNum(getCell(cols, header.evalCol))
  if (evalValue <= 0) return null

  const rawCode = getCell(cols, header.codeCol) || ''
  const code = extractTrustCode(rawCode)
  const pnlPct = parseNum(getCell(cols, header.pnlPctCol))
  const dayPct = parseNum(getCell(cols, header.dayPctCol))
  const price = parseNum(getCell(cols, header.priceCol))
  const acquiredAt = normalizeDate(getCell(cols, header.acquiredAtCol))

  return {
    assetType: 'trust',
    code,
    name,
    eval: evalValue,
    pnlPct,
    dayPct,
    price,
    acquiredAt: acquiredAt ?? undefined,
    accountHint,
  }
}

function aggregateRows(rows: ParsedRow[]): ParsedRow[] {
  const stateMap = new Map<string, AggregatedState>()

  rows.forEach(row => {
    const key = row.assetType === 'stock'
      ? `stock:${row.code}`
      : `trust:${row.accountHint}:${normalizeForMatch(row.name)}`

    const current = stateMap.get(key) ?? {
      assetType: row.assetType,
      code: row.code,
      name: row.name,
      accountHint: row.accountHint,
      eval: 0,
      cost: 0,
      dayWeighted: 0,
      dayWeight: 0,
      priceWeighted: 0,
      priceWeight: 0,
      acquiredAt: null,
    }

    current.eval += row.eval
    current.code = row.code || current.code
    if (row.name.length > current.name.length) current.name = row.name

    const baseCost = estimateCost(row.eval, row.pnlPct)
    current.cost += baseCost

    const weight = row.eval > 0 ? row.eval : 1
    current.dayWeighted += row.dayPct * weight
    current.dayWeight += weight
    if (row.price > 0) {
      current.priceWeighted += row.price * weight
      current.priceWeight += weight
    }

    if (row.acquiredAt) {
      current.acquiredAt = current.acquiredAt
        ? (row.acquiredAt > current.acquiredAt ? row.acquiredAt : current.acquiredAt)
        : row.acquiredAt
    }

    stateMap.set(key, current)
  })

  return [...stateMap.values()].map(state => {
    const pnlPct = state.cost > 0
      ? ((state.eval - state.cost) / state.cost) * 100
      : 0
    const dayPct = state.dayWeight > 0 ? state.dayWeighted / state.dayWeight : 0
    const price = state.priceWeight > 0 ? state.priceWeighted / state.priceWeight : 0

    return {
      assetType: state.assetType,
      code: state.code,
      name: state.name,
      eval: round2(state.eval),
      pnlPct: round2(pnlPct),
      dayPct: round2(dayPct),
      price: round2(price),
      acquiredAt: state.acquiredAt ?? undefined,
      accountHint: state.accountHint,
    } satisfies ParsedRow
  })
}

function estimateCost(evalValue: number, pnlPct: number) {
  const denom = 1 + pnlPct / 100
  if (!Number.isFinite(denom) || denom <= 0.0001) return evalValue
  return evalValue / denom
}

interface TrustMatchOutcome {
  /** 一意に照合できた登録済み投信id → 対応するCSV行 */
  matchedByFundId: Map<string, ParsedRow>
  /** 口座を一意に確定できず、更新を停止した登録済み投信id */
  ambiguousFundIds: Set<string>
  /** trust masterのどの登録済み投信にも一致しなかったCSV行 */
  unknownRows: ParsedRow[]
}

// P4.5-A013-T3: 投信CSV行と登録済み投信(trust master)の照合。
// 行driven（各CSV行についてベストマッチのfundを探す）にすることで、
// 「どのfundにも一致しないCSV行＝unknown fund」を自然に検出できる
// （旧findMatchingTrustRowはfund-drivenでこの検出ができなかった）。
// accountHintが判明している行はaccount一致に大きなボーナスを与えて
// 同名複数口座を一意に解決し、accountHintが失われている（もしくは
// 複数fundが同点1位になる）場合はambiguousとして更新自体を止める
// （推測で合算値を両方へ書き込むP4.5-A013-T2aの既知バグを再発させない）。
function matchTrustHoldings(trust: Trust[], trustRows: ParsedRow[]): TrustMatchOutcome {
  const matchedByFundId = new Map<string, ParsedRow>()
  const ambiguousFundIds = new Set<string>()
  const unknownRows: ParsedRow[] = []

  trustRows.forEach(row => {
    const scored = trust
      .map(fund => ({ fund, score: scoreTrustMatch(fund, row) }))
      .filter(entry => entry.score >= TRUST_MATCH_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) {
      unknownRows.push(row)
      return
    }

    const topScore = scored[0].score
    const topGroup = scored.filter(entry => entry.score === topScore)

    if (topGroup.length > 1) {
      // 同点1位が複数 → accountHint喪失等で口座を一意に決められない
      topGroup.forEach(entry => ambiguousFundIds.add(entry.fund.id))
      return
    }

    const fundId = topGroup[0].fund.id
    if (matchedByFundId.has(fundId) || ambiguousFundIds.has(fundId)) {
      // 既に別のCSV行がこのfundへ一意マッチ済み → 一意性が崩れるため両方止める
      matchedByFundId.delete(fundId)
      ambiguousFundIds.add(fundId)
      return
    }

    matchedByFundId.set(fundId, row)
  })

  return { matchedByFundId, ambiguousFundIds, unknownRows }
}

function scoreTrustMatch(fund: Trust, row: ParsedRow): number {
  const idKey = normalizeForMatch(fund.id)
  const nameKey = normalizeForMatch(fund.name)
  const abbrKey = normalizeForMatch(fund.abbr)
  const rowCode = normalizeForMatch(row.code)
  const rowName = normalizeForMatch(row.name)

  let baseScore = 0
  if (rowCode && rowCode === idKey) baseScore += 200
  if (rowName === nameKey) baseScore += 150
  if (abbrKey && rowName.includes(abbrKey)) baseScore += 80
  if (abbrKey && abbrKey.includes(rowName)) baseScore += 70
  if (rowName && nameKey.includes(rowName)) baseScore += Math.min(60, rowName.length)
  if (rowName && rowName.includes(nameKey)) baseScore += Math.min(60, nameKey.length)

  // コード/名前による根拠が一切無いfundは、accountHintが一致するというだけで
  // マッチさせない（unknown fundの行がaccountだけを頼りに無関係なfundへ
  // 誤マッチするのを防ぐ）。accountボーナスは、既に名前根拠のある候補同士の
  // 同点（同名複数口座）を解消するためだけに使う。
  if (baseScore === 0) return 0

  let score = baseScore
  const fundAccount = normalizeAccountLabel(fund.account)
  if (row.accountHint !== '' && fundAccount !== '' && row.accountHint === fundAccount) {
    score += 500
  }

  return score
}

function normalizeAccountLabel(account: string): AccountHint {
  const normalized = normalizeCell(account).replace(/\s/g, '')
  if (normalized.includes('特定')) return '特定'
  if (normalized.includes('NISA成長')) return 'NISA成長'
  if (normalized.includes('NISA積立')) return 'NISA積立'
  return ''
}

function extractStockCode(raw: string) {
  const normalized = normalizeCell(raw)
  const match = normalized.match(STOCK_CODE_SEARCH_RE)
  return match ? match[0] : ''
}

function extractTrustCode(raw: string) {
  const normalized = normalizeCell(raw).replace(/\s/g, '')
  if (!normalized) return ''
  const match = normalized.match(/[A-Za-z0-9]{4,}/)
  return match ? match[0] : ''
}

function cleanupStockName(raw: string, code: string) {
  const normalized = normalizeCell(raw)
  return normalized
    .replace(new RegExp(`^${code}\\s*`), '')
    .replace(/^[\-\s]+/, '')
    .trim()
}

function getCell(cols: string[], index: number) {
  if (index < 0 || index >= cols.length) return ''
  return cols[index] ?? ''
}

function isSummaryRow(firstCellRaw: string) {
  const first = normalizeCell(firstCellRaw)
  if (!first) return true
  if (first.includes('合計')) return true
  if (first === '評価額') return true
  if (first.startsWith('総合計')) return true
  if (first.startsWith('総件数')) return true
  if (first.startsWith('選択範囲')) return true
  if (first.startsWith('ページ')) return true
  if (first === 'ポートフォリオ一覧' || first === '個別表示' || first === 'PTS株価非表示') return true
  return false
}

function normalizeCell(value: string) {
  return (value ?? '')
    .trim()
    .normalize('NFKC')
}

function normalizeForMatch(value: string) {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/[・･\-_（）()\[\]［］]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function parseNum(value: string) {
  const normalized = normalizeCell(value)
    .replace(/,/g, '')
    .replace(/−/g, '-')
    .replace(/--/g, '')
  if (!normalized) return 0
  const num = Number.parseFloat(normalized)
  return Number.isFinite(num) ? num : 0
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

// クォート対応CSVパーサー
function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  result.push(current.trim())
  return result
}

function normalizeDate(raw: string): string | null {
  if (!raw) return null
  const cleaned = normalizeCell(raw)
  if (!cleaned || cleaned.includes('----')) return null
  const match = cleaned.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/)
  if (!match) return null
  const y = match[1]
  const m = match[2].padStart(2, '0')
  const d = match[3].padStart(2, '0')
  return `${y}-${m}-${d}`
}
