import type { Holding, Trust } from '../../types'

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

/** SBI証券CSVパーサー（ブラウザ側）
 *  - 従来形式（銘柄コード列あり）と新形式（銘柄（コード）/ファンド名）の両対応
 *  - 同一銘柄の複数行を集約して取込
 *  - 特定/NISA成長/NISA積立の投信セクションを分離して照合
 */
export async function importPortfolioCsv(
  file: File,
  holdings: Holding[],
  trust: Trust[],
): Promise<{ holdings: Holding[]; trust: Trust[] }> {
  const text = await readFileAsText(file)
  const rows = parseRows(text)
  if (rows.length === 0) throw new Error('CSV: 有効な行が見つかりませんでした')

  const stockRows = rows.filter((row): row is ParsedRow & { code: string } => row.assetType === 'stock' && /^\d{4}$/.test(row.code))
  const trustRows = rows.filter(row => row.assetType === 'trust')

  const stockByCode = new Map(stockRows.map(row => [row.code, row]))

  const updatedHoldings = holdings.map(holding => {
    const row = stockByCode.get(holding.code)
    if (!row) return holding

    return {
      ...holding,
      eval: row.eval > 0 ? row.eval : holding.eval,
      pnlPct: Number.isFinite(row.pnlPct) ? row.pnlPct : holding.pnlPct,
      currentPrice: row.price > 0 ? row.price : holding.currentPrice,
      acquiredAt: row.acquiredAt ?? holding.acquiredAt,
    }
  })

  const updatedTrust = trust.map(fund => {
    const row = findMatchingTrustRow(fund, trustRows)
    if (!row) return fund

    return {
      ...fund,
      eval: row.eval > 0 ? row.eval : fund.eval,
      pnlPct: Number.isFinite(row.pnlPct) ? row.pnlPct : fund.pnlPct,
      dayPct: Number.isFinite(row.dayPct) ? row.dayPct : fund.dayPct,
    }
  })

  return { holdings: updatedHoldings, trust: updatedTrust }
}

// ── ファイル読み込み（UTF-8 / Shift-JIS判定）───────────────────
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = event => {
      const buffer = event.target?.result as ArrayBuffer
      const utf8 = decodeBuffer(buffer, 'utf-8')
      const sjis = decodeBuffer(buffer, 'shift-jis')
      resolve(scoreDecodedText(utf8) >= scoreDecodedText(sjis) ? utf8 : sjis)
    }
    reader.onerror = () => reject(new Error('ファイル読み込みエラー'))
    reader.readAsArrayBuffer(file)
  })
}

function decodeBuffer(buffer: ArrayBuffer, encoding: 'utf-8' | 'shift-jis') {
  try {
    return new TextDecoder(encoding).decode(buffer)
  } catch {
    return ''
  }
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
function parseRows(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/)
  const parsedRows: ParsedRow[] = []
  let section: SectionContext | null = null
  let header: HeaderMap | null = null

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

  return aggregateRows(parsedRows)
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
  for (const candidate of candidates) {
    const idx = cells.findIndex(cell => cell.includes(candidate))
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

function findMatchingTrustRow(fund: Trust, trustRows: ParsedRow[]) {
  const idKey = normalizeForMatch(fund.id)
  const nameKey = normalizeForMatch(fund.name)
  const abbrKey = normalizeForMatch(fund.abbr)
  const accountRows = trustRows.filter(row => row.accountHint === normalizeAccountLabel(fund.account))

  const pool = accountRows.length > 0 ? accountRows : trustRows

  let best: ParsedRow | null = null
  let bestScore = -1

  for (const row of pool) {
    const rowCode = normalizeForMatch(row.code)
    const rowName = normalizeForMatch(row.name)
    let score = 0

    if (rowCode && rowCode === idKey) score += 200
    if (rowName === nameKey) score += 150
    if (abbrKey && rowName.includes(abbrKey)) score += 80
    if (abbrKey && abbrKey.includes(rowName)) score += 70
    if (rowName && nameKey.includes(rowName)) score += Math.min(60, rowName.length)
    if (rowName && rowName.includes(nameKey)) score += Math.min(60, nameKey.length)

    if (score > bestScore) {
      best = row
      bestScore = score
    }
  }

  return bestScore >= 40 ? best : null
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
  const match = normalized.match(/(\d{4})/)
  return match ? match[1] : ''
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
