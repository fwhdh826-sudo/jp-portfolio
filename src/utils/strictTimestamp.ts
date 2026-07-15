export interface StrictTimestampOptions {
  /** Date-only values represent a JST portfolio snapshot at 00:00:00. */
  allowDateOnly?: boolean
}

export interface StrictTimestamp {
  epochMs: number
  normalized: string
  kind: 'date-only' | 'date-time'
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
const JST_OFFSET_MINUTES = 9 * 60

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth(year, month)
}

function utcEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  // setUTCFullYear avoids Date.UTC's special interpretation of years 0..99. All calendar
  // components have already been validated, so the Date object cannot normalize bad input.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  return date.getTime()
}

export function parseStrictTimestamp(
  value: unknown,
  options: StrictTimestampOptions = {},
): StrictTimestamp | null {
  if (typeof value !== 'string' || value.length === 0) return null

  const dateOnly = DATE_ONLY_RE.exec(value)
  if (dateOnly) {
    if (!options.allowDateOnly) return null
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (!validCalendarDate(year, month, day)) return null
    const epochMs = utcEpochMs(year, month, day, 0, 0, 0, 0) - JST_OFFSET_MINUTES * 60_000
    return { epochMs, normalized: new Date(epochMs).toISOString(), kind: 'date-only' }
  }

  const dateTime = DATE_TIME_RE.exec(value)
  if (!dateTime) return null
  const year = Number(dateTime[1])
  const month = Number(dateTime[2])
  const day = Number(dateTime[3])
  const hour = Number(dateTime[4])
  const minute = Number(dateTime[5])
  const second = Number(dateTime[6])
  const millisecond = Number((dateTime[7] ?? '').padEnd(3, '0'))
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null

  const zone = dateTime[8]
  let offsetMinutes = 0
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return null
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === '+' ? 1 : -1)
  }
  const epochMs = utcEpochMs(year, month, day, hour, minute, second, millisecond) - offsetMinutes * 60_000
  if (!Number.isFinite(epochMs)) return null
  return { epochMs, normalized: new Date(epochMs).toISOString(), kind: 'date-time' }
}

export function normalizeStrictTimestamp(
  value: unknown,
  options: StrictTimestampOptions = {},
): string | null {
  return parseStrictTimestamp(value, options)?.normalized ?? null
}

export function isStrictTimestamp(
  value: unknown,
  options: StrictTimestampOptions = {},
): value is string {
  return parseStrictTimestamp(value, options) !== null
}
