/**
 * Minimal read-only XLSX reader.
 *
 * An .xlsx is a ZIP of XML parts: `xl/workbook.xml` names the sheets,
 * `xl/sharedStrings.xml` holds the strings cells refer to by index, and each
 * `xl/worksheets/sheetN.xml` holds the rows. Only what a data import needs is
 * parsed here — no formulas, no styles beyond date formats, no charts.
 *
 * Zero dependencies: the ZIP container is decoded with the built-in `zlib`
 * (deflate) after reading the central directory ourselves.
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

// Zip stores the directory at the end; the comment can be up to 64 KB long.
function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 66_000)
  for (let at = buffer.length - 22; at >= start; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at
  }
  throw new Error('不是一个有效的 .xlsx 文件（找不到 ZIP 目录）')
}

/** Read the ZIP central directory: name → { method, size, offset }. */
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const total = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(cursor + 10)
    const size = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.set(name, { method, size, offset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Extract one entry as a UTF-8 string. */
// A workbook is a zip and a hostile one can inflate to gigabytes — a 408 KB
// file expanded to 419 MB of text and 2 GB of RSS in a probe. The plugin runs
// inside the host process, so refuse anything absurd before inflating.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export function readZipText(buffer, entries, name) {
  const entry = entries.get(name)
  if (!entry) return null
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`工作簿里的 ${name} 解压后是 ${Math.round(entry.size / 1024 / 1024)} MB，超过上限 ${MAX_ENTRY_BYTES / 1024 / 1024} MB，拒绝读取`)
  }
  const local = entry.offset
  if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目损坏：${name}`)
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.size)
  if (entry.method === 0) return raw.toString('utf8')
  if (entry.method === 8) return inflateRawSync(raw).toString('utf8')
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}（${name}）`)
}

const decodeXml = (text) => String(text)
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replaceAll('&#10;', '\n')
  .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replaceAll('&amp;', '&')

// Writers are not obliged to use double quotes: LibreOffice and some generators
// emit single-quoted attributes, and the old regex simply did not see them.
export const attribute = (tag, name) => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  if (!match) return null
  return decodeXml(match[1] ?? match[2] ?? '')
}

/** "A1" → 0, "AB12" → 27. */
export function columnIndex(reference) {
  const letters = /^[A-Z]+/.exec(String(reference ?? '').toUpperCase())
  if (!letters) return 0
  let index = 0
  for (const char of letters[0]) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

/** Shared strings: one entry per <si>, text from its <t> runs. */
function parseSharedStrings(xml) {
  if (!xml) return []
  const values = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const runs = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => decodeXml(run[1]))
    values.push(runs.join(''))
  }
  return values
}

// Excel's built-in date formats (14–22, 45–47) plus custom codes with y/m/d.
function parseDateStyles(xml) {
  if (!xml) return { ids: new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]), xfs: [] }
  const custom = new Map()
  for (const match of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attribute(match[0], 'numFmtId'))
    const code = attribute(match[0], 'formatCode') ?? ''
    if (Number.isFinite(id) && /[ymd]/i.test(code) && !/[#0]/.test(code.replace(/"[^"]*"/g, ''))) {
      custom.set(id, code)
    }
  }
  const builtin = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, ...custom.keys()])
  const xfs = []
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)
  if (cellXfs) {
    for (const xf of cellXfs[1].matchAll(/<xf\b[^>]*>/g)) {
      xfs.push(Number(attribute(xf[0], 'numFmtId') ?? 0))
    }
  }
  return { ids: builtin, xfs }
}

// Excel epoch: serial 1 = 1900-01-01, with the well-known 1900 leap-year bug.
function serialToDate(serial, withTime) {
  const days = Math.floor(serial)
  const fraction = serial - days
  const date = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000)
  const iso = date.toISOString().slice(0, 10)
  if (!withTime || fraction === 0) return iso
  const seconds = Math.round(fraction * 86_400)
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  return `${iso} ${hh}:${mm}`
}

/** One worksheet → rows of cell values (arrays, gaps as null). */
function parseSheet(xml, sharedStrings, styles) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r') ?? rows.length + 1)
    const cells = []
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      // A cell without r= is not the same as column A: the spec says such a
      // cell follows the previous one, so the old fallback piled a whole row
      // into the first column.
      const reference = attribute(attributes, 'r')
      const at = reference === null ? cells.length : columnIndex(reference)
      const type = attribute(attributes, 't') ?? 'n'
      const styleIndex = Number(attribute(attributes, 's') ?? -1)
      const valueTag = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)
      const raw = valueTag ? decodeXml(valueTag[1]) : null
      let value = null
      if (type === 's') {
        value = raw === null ? null : sharedStrings[Number(raw)] ?? null
      } else if (type === 'inlineStr') {
        const runs = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => decodeXml(run[1]))
        value = runs.join('') || null
      } else if (type === 'b') {
        value = raw === '1'
      } else if (type === 'e') {
        value = raw
      } else if (type === 'str') {
        value = raw
      } else if (raw !== null && raw !== '') {
        const numeric = Number(raw)
        const fmtId = styleIndex >= 0 ? styles.xfs[styleIndex] : undefined
        if (Number.isFinite(numeric) && fmtId !== undefined && styles.ids.has(fmtId)) {
          value = serialToDate(numeric, numeric % 1 !== 0)
        } else {
          value = Number.isFinite(numeric) ? numeric : raw
        }
      }
      if (value !== null) cells[at] = value
    }
    rows[rowNumber - 1] = cells
  }
  return rows
}

/**
 * Parse an .xlsx buffer.
 * @returns {{ sheets: {name: string, rows: any[][]}[], sheetNames: string[] }}
 */
export function readXlsx(buffer) {
  const entries = readZipEntries(buffer)
  const workbook = readZipText(buffer, entries, 'xl/workbook.xml')
  if (!workbook) throw new Error('不是一个有效的 .xlsx 文件（缺少 xl/workbook.xml）')
  const sharedStrings = parseSharedStrings(readZipText(buffer, entries, 'xl/sharedStrings.xml'))
  const styles = parseDateStyles(readZipText(buffer, entries, 'xl/styles.xml'))
  const relations = readZipText(buffer, entries, 'xl/_rels/workbook.xml.rels') ?? ''
  const targets = new Map()
  for (const match of relations.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], 'Id')
    const target = attribute(match[0], 'Target')
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }

  const sheets = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attribute(match[0], 'name') ?? `Sheet${sheets.length + 1}`
    const id = attribute(match[0], 'r:id') ?? attribute(match[0], 'id')
    const target = targets.get(id) ?? `worksheets/sheet${sheets.length + 1}.xml`
    const xml = readZipText(buffer, entries, `xl/${target}`) ?? readZipText(buffer, entries, target)
    if (!xml) continue
    sheets.push({ name, rows: parseSheet(xml, sharedStrings, styles) })
  }
  if (sheets.length === 0) throw new Error('这个 .xlsx 里没有工作表')
  return { sheets, sheetNames: sheets.map((sheet) => sheet.name) }
}
