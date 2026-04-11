import type { Holding, Trust } from '../../types'

interface ParsedRow {
  code: string    // 4桁数字 or 投信コード
  name: string
  eval: number
  pnlPct: number
  dayPct: number
  price: number
}

/** SBI証券CSVパーサー（ブラウザ側）
 *  - 個別株・投資信託どちらのCSVにも対応
 *  - Shift-JIS → TextDecoder で自動変換
 */
export async function importPortfolioCsv(
  file: File,
  holdings: Holding[],
  trust: Trust[],
): Promise<{ holdings: Holding[]; trust: Trust[] }> {
  const text = await readFileAsText(file)
  const rows = parseRows(text)
  if (rows.length === 0) throw new Error('CSV: 有効な行が見つかりませんでした')

  // ── 個別株: 4桁数字コードで照合 ──────────────────────────────
  const updatedHoldings = holdings.map(h => {
    const row = rows.find(r => r.code === h.code)
    if (!row) return h
    return { ...h, eval: row.eval, pnlPct: row.pnlPct }
  })

  // ── 投資信託: 銘柄名の部分一致 or trust.id/abbr で照合 ────────
  const updatedTrust = trust.map(f => {
    // 投信コードは数字以外（例: 0131103A）or 空の場合あり → 名前照合優先
    const row = rows.find(r => {
      // コード完全一致
      if (r.code && f.id && r.code === f.id) return true
      // 銘柄名部分一致（どちらかが含む）
      const rn = r.name.replace(/\s/g, '')
      const fn = f.name.replace(/\s/g, '')
      const an = f.abbr.replace(/\s/g, '')
      return rn.length > 3 && (fn.includes(rn) || rn.includes(an) || an.includes(rn))
    })
    if (!row) return f
    return {
      ...f,
      eval:   row.eval,
      pnlPct: row.pnlPct,
      dayPct: row.dayPct !== 0 ? row.dayPct : f.dayPct,
    }
  })

  return { holdings: updatedHoldings, trust: updatedTrust }
}

// ── ファイル読み込み（Shift-JIS対応）──────────────────────────
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      const buf = e.target?.result as ArrayBuffer
      try {
        // SBI CSVはShift-JIS
        resolve(new TextDecoder('shift-jis').decode(buf))
      } catch {
        // fallback: UTF-8
        resolve(new TextDecoder('utf-8').decode(buf))
      }
    }
    reader.onerror = () => reject(new Error('ファイル読み込みエラー'))
    reader.readAsArrayBuffer(file)
  })
}

// ── CSVパース ─────────────────────────────────────────────────
function parseRows(text: string): ParsedRow[] {
  const lines = text.split('\n')
  const rows: ParsedRow[] = []

  let headerIdx = -1
  let codeCol   = -1
  let nameCol   = -1
  let evalCol   = -1
  let pnlPctCol = -1
  let dayPctCol = -1
  let priceCol  = -1

  // ヘッダー行を探す
  for (let i = 0; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i])
    const codeI = cols.findIndex(c =>
      c === '銘柄コード' || c === 'コード' || c === '銘柄コード（ファンドコード）'
    )
    if (codeI >= 0) {
      headerIdx  = i
      codeCol    = codeI
      nameCol    = cols.findIndex(c => c.includes('銘柄名') || c === '銘柄')
      evalCol    = cols.findIndex(c => c.includes('評価額') || c.includes('時価評価額'))
      pnlPctCol  = cols.findIndex(c => c.includes('損益率') || c.includes('評価損益率'))
      dayPctCol  = cols.findIndex(c => c.includes('前日比') || c.includes('騰落率'))
      priceCol   = cols.findIndex(c => c === '現在値' || c === '現在単価' || c === '基準価額')
      break
    }
  }

  if (headerIdx < 0 || codeCol < 0) return []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = splitCsvLine(line)

    const rawCode = cols[codeCol] ?? ''
    // 個別株: 4桁数字 / 投信: 英数字混じりコード（最低2文字以上）
    const code = rawCode.replace(/[^\w]/g, '')
    if (!code || code.length < 2) continue

    const name     = cols[nameCol] ?? ''
    const parseNum = (idx: number) =>
      idx >= 0 ? parseFloat((cols[idx] ?? '').replace(/[^\d.-]/g, '')) || 0 : 0

    rows.push({
      code,
      name,
      eval:   parseNum(evalCol),
      pnlPct: parseNum(pnlPctCol),
      dayPct: parseNum(dayPctCol),
      price:  parseNum(priceCol),
    })
  }

  return rows
}

// クォート対応CSVパーサー
function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      inQ = !inQ
    } else if (c === ',' && !inQ) {
      result.push(cur.trim().replace(/,/g, ''))
      cur = ''
    } else {
      cur += c
    }
  }
  result.push(cur.trim().replace(/,/g, ''))
  return result
}
