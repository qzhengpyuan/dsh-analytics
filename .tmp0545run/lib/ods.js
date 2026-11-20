// OpenDocument Spreadsheet (.ods) reader — no dependencies.
//
// An .ods is a ZIP whose `content.xml` holds the sheets; the ZIP plumbing and
// the tiny XML helpers are shared with the .xlsx reader. Values come from the
// `office:value*` attributes (the displayed text is only a rendering), and
// `table:number-*-repeated` is expanded with a cap so a spreadsheet that
// repeats an empty row a million times cannot hang the importer.

import { attribute, readZipEntries, readZipText } from './xlsx.js'

const decodeXml = (text) => String(text)
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replaceAll('&amp;', '&')

const MAX_ROWS = 200_000
const MAX_COLUMNS = 1_000
// A repeated empty row is how ODS pads to the sheet's full height; stop there.
const EMPTY_REPEAT_LIMIT = 1_000

/** Flatten a cell's body: paragraphs become lines, <text:s/> becomes spaces. */
function cellText(body) {
  if (!body) return ''
  const paragraphs = [...body.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((match) => match[1])
  const source = paragraphs.length ? paragraphs.join('\n') : body
  return decodeXml(source
    .replaceAll(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/>/g, (_, count) => ' '.repeat(Number(count)))
    .replaceAll(/<text:s\b[^>]*\/>/g, ' ')
    .replaceAll(/<text:line-break\b[^>]*\/>/g, '\n')
    .replaceAll(/<text:tab\b[^>]*\/>/g, '\t')
    .replaceAll(/<[^>]+>/g, ''))
    .trim()
}

/** One <table:table-cell> (or <table:covered-table-cell>) → a plain value. */
function cellValue(tag, body) {
  const type = attribute(tag, 'office:value-type')
  const number = attribute(tag, 'office:value')
  if (type === 'float' || type === 'percentage' || type === 'currency') {
    const value = Number(number)
    return Number.isFinite(value) ? value : cellText(body)
  }
  if (type === 'boolean') {
    const flag = attribute(tag, 'office:boolean-value')
    return flag === 'true' ? 1 : 0
  }
  if (type === 'date') {
    return attribute(tag, 'office:date-value') ?? cellText(body)
  }
  if (type === 'time') {
    return attribute(tag, 'office:time-value') ?? cellText(body)
  }
  const text = cellText(body)
  return text === '' ? null : text
}

/** Parse the `office:spreadsheet` body of content.xml into sheets. */
function parseSheets(xml) {
  const sheets = []
  for (const table of xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = attribute(table[1], 'table:name') ?? `Sheet${sheets.length + 1}`
    const rows = []
    for (const rowMatch of table[2].matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>|<table:table-row\b([^>]*)\/>/g)) {
      const attributes = rowMatch[1] ?? rowMatch[3] ?? ''
      const body = rowMatch[2] ?? ''
      const repeated = Math.max(1, Number(attribute(attributes, 'table:number-rows-repeated') ?? 1) || 1)
      const cells = []
      for (const cell of body.matchAll(/<(table:table-cell|table:covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
        const kind = cell[1]
        const cellAttributes = cell[2] ?? ''
        const cellBody = cell[3] ?? ''
        const count = Math.max(1, Number(attribute(cellAttributes, 'table:number-columns-repeated') ?? 1) || 1)
        const value = kind === 'table:covered-table-cell' ? null : cellValue(cellAttributes, cellBody)
        const filled = count
        for (let index = 0; index < filled && cells.length < MAX_COLUMNS; index += 1) {
          cells.push(index === 0 ? value : (typeof value === 'number' ? value : null))
        }
      }
      const empty = cells.every((cell) => cell === null || cell === '')
      if (empty && repeated > EMPTY_REPEAT_LIMIT) break
      const times = Math.min(repeated, Math.max(1, MAX_ROWS - rows.length))
      for (let index = 0; index < times; index += 1) rows.push([...cells])
      if (rows.length >= MAX_ROWS) break
    }
    sheets.push({ name, rows })
  }
  return sheets
}

export function readOds(buffer) {
  let entries
  try {
    entries = readZipEntries(buffer)
  } catch {
    throw new Error('不是一个有效的 .ods 文件（不是 ZIP 容器）')
  }
  const content = readZipText(buffer, entries, 'content.xml')
  if (!content) throw new Error('不是一个有效的 .ods 文件（缺少 content.xml）')
  const sheets = parseSheets(content)
  if (sheets.length === 0) throw new Error('这个 .ods 里没有工作表')
  return { sheets, sheetNames: sheets.map((sheet) => sheet.name) }
}
