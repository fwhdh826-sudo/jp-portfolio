import type { Holding } from '../../types'

interface ParsedRow {
  code: string
  eval: number
  pnlPct: number
  price: number
}

// SBI証券CSVパーサー（ブラウザ側）
// encoding: shift_jis は FileReader + TextDecoder で処理
export async function importPortfolioCsv(file: File, holdings: Holding[]): Promise<Holding[]> {
  const text = await readFileAsText(file)
  const rows = parseRows(text)
  if (rows.length === 0) throw new Error('CSV: 有効な行が見つかりませんでした')

  const updated = holdings.map(h => {
    const row = rows.find(r => r.code === h.code)
    if (!row) return h
    return {
      ...h,
      eval:   row.eval,
      pnlPct: row.pnlPct,
    }
  })
  return updated
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      const buf = e.target?.result as ArrayBuffer
      // SBI CSVはShift-JIS
      const decoder = new TextDecoder('shift-jis')
      resolve(decoder.decode(buf))
    }
    reader.onerror = () => reject(new Error('ファイル読み込みエラー'))
    reader.readAsArrayBuffer(file)
  })
}

function parseRows(text: string): ParsedRow[] {
  const lines = text.split('\n')
  const rows: ParsedRow[] = []

  // ヘッダー行を探す（銘柄コードの列）
  let headerIdx = -1
  let codeCol = -1
  let evalCol = -1
  let pnlPctCol = -1
  let priceCol = -1

  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    const codeI = cols.findIndex(c => c === '銘柄コード' || c === 'コード')
    if (codeI >= 0) {
      headerIdx = i
      codeCol   = codeI
      evalCol   = cols.findIndex(c => c.includes('評価額') || c.includes('時価評価額'))
      pnlPctCol = cols.findIndex(c => c.includes('損益率') || c.includes('評価損益率'))
      priceCol  = cols.findIndex(c => c === '現在値' || c === '現在単価')
      break
    }
  }

  if (headerIdx < 0 || codeCol < 0) return []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, '').replace(/,/g, ''))
    const code = cols[codeCol]?.replace(/\D/g, '')
    if (!code || code.length !== 4) continue

    const parseNum = (idx: number) => idx >= 0 ? parseFloat(cols[idx]?.replace(/[^\d.-]/g, '') || '0') || 0 : 0

    rows.push({
      code,
      eval:   parseNum(evalCol),
      pnlPct: parseNum(pnlPctCol),
      price:  parseNum(priceCol),
    })
  }

  return rows
}
