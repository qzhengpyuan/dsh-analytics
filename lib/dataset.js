import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { parseCsv, stringifyCsv } from './csv.js'

const NUMERIC_FORMAT = /^[A-Z]+(\d+)(?:\.(\d+))?$/

export function quoteSyntaxPath(path) {
  return `'${String(path).replaceAll("'", "''")}'`
}

/** Split an HTML/CSV dictionary dump into `{ title -> rows }`. */
function tableBlocks(text) {
  const blocks = new Map()
  let title = ''
  let rows = []
  const flush = () => {
    if (rows.length > 0) blocks.set(title, rows)
    rows = []
  }
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^Table:\s*(.*)$/.exec(line)
    if (match) {
      flush()
      title = match[1].trim()
      continue
    }
    if (line.trim() === '') continue
    rows.push(line)
  }
  flush()
  return blocks
}

function formatInfo(format) {
  const match = NUMERIC_FORMAT.exec(format ?? '')
  const type = (format ?? '').startsWith('A') ? 'string' : 'numeric'
  const width = match ? Number(match[1]) : (type === 'string' ? 8 : 8)
  const decimals = match && match[2] !== undefined ? Number(match[2]) : (type === 'string' ? 0 : 2)
  return { type, width, decimals, format: format ?? (type === 'string' ? `A${width}` : `F${width}.${decimals}`) }
}

/**
 * Read the variable dictionary. Runs in the C locale so the table headers are
 * stable regardless of the user's language; user-facing output keeps Chinese.
 */
export async function readDictionary(run, savPath) {
  const script = [`GET FILE=${quoteSyntaxPath(savPath)}.`, 'DISPLAY DICTIONARY.'].join('\n') + '\n'
  const result = await run(script, { outName: 'dictionary', format: 'csv' })
  if (result.code !== 0 && result.stderr.trim() !== '') {
    throw new Error(`DISPLAY DICTIONARY failed: ${result.stderr.trim().split('\n').slice(0, 3).join(' | ')}`)
  }
  const blocks = tableBlocks(result.outputText ?? '')
  let variableBlock = null
  let valueBlock = null
  for (const [title, rows] of blocks) {
    if (/^(Variables?|变量)$/i.test(title)) variableBlock = rows
    else if (/^(Value Labels?|值标签)$/i.test(title)) valueBlock = rows
  }

  const variables = []
  if (variableBlock) {
    const header = parseCsv(variableBlock[0])[0].map((cell) => cell.trim())
    // PSPP localizes the header words; the column order differs between
    // builds/locales, so resolve every column by its label and keep the
    // positional guesses only as a last resort.
    const alias = {
      name: [/^name$/i, /名称/],
      position: [/^position$/i, /位置/],
      measure: [/measurement/i, /测度/, /度量/, /测量级别/],
      label: [/^label$/i, /^标签$/, /变量标签/],
      role: [/^role$/i, /角色/],
      width: [/^width$/i, /宽度/],
      alignment: [/^alignment$/i, /对齐/],
      print: [/print format/i, /打印格式/],
      write: [/write format/i, /写出格式/],
      missing: [/^missing/i, /缺失/],
    }
    const column = (key, fallback) => {
      const index = header.findIndex((cell) => alias[key].some((pattern) => pattern.test(cell)))
      return index >= 0 ? index : fallback
    }
    // PSPP drops a column entirely when every cell in it is empty (no variable
    // labels -> no "Label" column), so positional fallbacks would silently
    // read the neighbouring column. Only name/position/measure are safe to
    // assume; everything else must be found by its header.
    const iName = column('name', 0)
    const iPosition = column('position', 1)
    const iMeasure = column('measure', 2)
    const iLabel = column('label', -1)
    const iAlignment = column('alignment', -1)
    const iPrint = column('print', -1)
    const iMissing = column('missing', -1)
    for (const row of variableBlock.slice(1)) {
      const cells = parseCsv(row)[0]
      if (!cells || cells.length === 0) continue
      const name = cells[iName >= 0 ? iName : 0]?.trim()
      if (!name) continue
      const format = formatInfo(iPrint >= 0 ? cells[iPrint]?.trim() : '')
      const measureRaw = (cells[iMeasure] ?? '').trim().toLowerCase()
      const measure = /nominal|名称|名义/.test(measureRaw)
        ? 'nominal'
        : /ordinal|有序|序号/.test(measureRaw)
          ? 'ordinal'
          : /scale|比例|尺度/.test(measureRaw)
            ? 'scale'
            : (format.type === 'string' ? 'nominal' : 'scale')
      const alignmentRaw = (cells[iAlignment] ?? '').trim().toLowerCase()
      // PSPP: numerics are Right, strings Left, and both fall back to those when
      // the dictionary says nothing.
      const alignment = /left|左/.test(alignmentRaw)
        ? 'left'
        : /center|中/.test(alignmentRaw)
          ? 'center'
          : /right|右/.test(alignmentRaw)
            ? 'right'
            : (format.type === 'string' ? 'left' : 'right')
      variables.push({
        name,
        label: iLabel >= 0 ? (cells[iLabel] ?? '').trim() : '',
        position: iPosition >= 0 ? Number(cells[iPosition]) || variables.length + 1 : variables.length + 1,
        type: format.type,
        width: format.width,
        decimals: format.decimals,
        format: format.format,
        measure,
        role: 'input',
        alignment,
        missing: [],
        valueLabels: {},
      })
      const missingText = (cells[iMissing] ?? '').trim()
      if (missingText) {
        variables[variables.length - 1].missing = missingText
          .split(/\s+/)
          .map((token) => (format.type === 'numeric' ? Number(token) : token))
          .filter((value) => value !== '' && !(typeof value === 'number' && Number.isNaN(value)))
      }
    }
  }

  if (valueBlock && variables.length > 0) {
    const lookup = new Map()
    for (const variable of variables) {
      if (variable.label) lookup.set(variable.label, variable)
      lookup.set(variable.name, variable)
    }
    let current = null
    for (const row of valueBlock.slice(1)) {
      const cells = parseCsv(row)[0]
      if (!cells) continue
      const rawVariable = (cells[0] ?? '').trim()
      if (rawVariable) current = lookup.get(rawVariable) ?? null
      if (!current) continue
      const rawValue = (cells[1] ?? '').trim()
      const label = (cells[2] ?? '').trim()
      if (rawValue === '') continue
      const value = current.type === 'numeric' ? Number(rawValue) : rawValue
      if (typeof value === 'number' && Number.isNaN(value)) continue
      current.valueLabels[String(value)] = label
    }
  }

  return variables
}

/** Read cases through the CSV export driver. */
export async function readData(run, savPath, variables, options = {}) {
  const maxRows = options.maxRows ?? 200000
  const script = [
    `GET FILE=${quoteSyntaxPath(savPath)}.`,
    `SAVE TRANSLATE /OUTFILE='data.csv' /TYPE=CSV /REPLACE.`,
  ].join('\n') + '\n'
  const result = await run(script, { outName: 'data', collectOutput: false })
  if (result.code !== 0) {
    throw new Error(`reading cases failed: ${result.stderr.trim().split('\n').slice(0, 3).join(' | ') || `exit ${result.code}`}`)
  }
  const text = await readFile(result.dataCsvPath, 'utf8')
  const parsed = parseCsv(text)
  const truncated = parsed.length > maxRows
  const rows = (truncated ? parsed.slice(0, maxRows) : parsed).map((cells) => {
    const row = []
    for (let index = 0; index < variables.length; index += 1) {
      const variable = variables[index]
      const raw = cells[index]
      // PSPP writes a system-missing numeric as a single space, so an empty
      // cell arrives as ' ' rather than ''. Trimming must happen before the
      // emptiness test: Number('') is 0, which silently turned every missing
      // value into a real zero on the save -> reopen round trip.
      const text = raw === undefined || raw === null ? '' : String(raw).trim()
      if (text === '') {
        row.push(null)
        continue
      }
      if (variable.type === 'string') {
        row.push(raw)
        continue
      }
      const numeric = Number(text)
      row.push(Number.isFinite(numeric) ? numeric : null)
    }
    return row
  })
  return { rows, truncated, caseCount: rows.length }
}

function formatFor(variable) {
  if (variable.type === 'string') {
    const width = Math.max(1, Math.min(255, variable.width || 8))
    return `A${width}`
  }
  const width = Math.max(1, variable.width || 8)
  const decimals = Math.max(0, Math.min(width - 1, variable.decimals ?? 2))
  return `F${width}.${decimals}`
}

function literal(variable, value) {
  if (variable.type === 'string') return `'${String(value ?? '').replaceAll("'", "''")}'`
  const numeric = Number(value)
  return Number.isFinite(numeric) ? String(numeric) : ''
}

/** Write the dataset model back to an SPSS system file through the engine. */
export async function writeSav(run, dataset, outPath) {
  const { variables, rows } = dataset
  const csvRows = rows.map((row) => row.map((cell) => {
    if (cell === null || cell === undefined) return ''
    return String(cell)
  }))
  const csvPath = `${outPath}.source.csv`
  await writeFile(csvPath, stringifyCsv(csvRows), 'utf8')
  try {
    return await writeSavFromCsv({
      run, outPath, csvPath, rows, variables,
      names: variables.map((variable) => variable.name),
    })
  } finally {
    // The CSV is only an input for the engine; leaving it behind puts a stray
    // `<target>.source.csv` next to the user's data file on every save.
    await rm(csvPath, { force: true }).catch(() => { /* best effort */ })
  }
}

/** Build the syntax that turns the staging CSV into the target system file. */
async function writeSavFromCsv({ run, outPath, csvPath, names, variables, rows }) {
  const lines = []
  lines.push(`GET DATA /TYPE=TXT /FILE=${quoteSyntaxPath(csvPath)} /DELIMITERS="," /QUALIFIER='"' /ARRANGEMENT=DELIMITED /FIRSTCASE=1`)
  lines.push(`  /VARIABLES=${variables.map((variable) => `${variable.name} ${formatFor(variable)}`).join(' ')}.`)
  lines.push('EXECUTE.')

  for (const variable of variables) {
    if (variable.label) lines.push(`VARIABLE LABELS ${variable.name} '${String(variable.label).replaceAll("'", "''")}'.`)
  }
  for (const variable of variables) {
    const entries = Object.entries(variable.valueLabels ?? {})
    if (entries.length === 0) continue
    const parts = entries.map(([value, label]) => `${literal(variable, value)} '${String(label).replaceAll("'", "''")}'`)
    lines.push(`VALUE LABELS ${variable.name} ${parts.join(' ')}.`)
  }
  for (const variable of variables) {
    const missing = (variable.missing ?? []).filter((value) => value !== '' && value !== null)
    if (missing.length === 0) continue
    lines.push(`MISSING VALUES ${variable.name} (${missing.map((value) => literal(variable, value)).join(', ')}).`)
  }
  // Column widths and decimal places belong to the print format, not to the
  // GET DATA spec, so they only survive when declared again here.
  for (const variable of variables) {
    lines.push(`FORMATS ${variable.name} (${formatFor(variable)}).`)
  }
  // The sheet lines values up by the variable's own alignment; PSPP keeps
  // whatever it was given, and defaults everything to right.
  for (const variable of variables) {
    const alignment = String(variable.alignment ?? 'right').toLowerCase()
    const keyword = alignment === 'left' ? 'LEFT' : alignment === 'center' ? 'CENTER' : 'RIGHT'
    lines.push(`VARIABLE ALIGNMENT ${variable.name} (${keyword}).`)
  }
  for (const variable of variables) {
    const level = String(variable.measure ?? '').toLowerCase()
    const keyword = level === 'nominal' ? 'NOMINAL' : level === 'ordinal' ? 'ORDINAL' : level === 'scale' ? 'SCALE' : null
    if (keyword) lines.push(`VARIABLE LEVEL ${variable.name} (${keyword}).`)
  }
  lines.push('EXECUTE.')
  lines.push(`SAVE OUTFILE=${quoteSyntaxPath(outPath)}.`)
  const script = lines.join('\n') + '\n'
  const result = await run(script, { outName: 'save', collectOutput: false })
  if (result.code !== 0) {
    throw new Error(`saving dataset failed: ${result.stderr.trim().split('\n').slice(0, 4).join(' | ') || `exit ${result.code}`}`)
  }
  return { path: outPath, variables: names.length, cases: rows.length }
}

/** Import a delimited text file: infer types, then round-trip through the engine. */
/**
 * Decode a delimited text file. Chinese CSV exports are still often GBK, so
 * try UTF-8 strictly first and fall back instead of producing mojibake.
 */
export function decodeText(buffer, encoding) {
  const chosen = String(encoding ?? 'auto').toLowerCase()
  if (chosen !== 'auto' && chosen !== '') {
    try {
      return new TextDecoder(chosen).decode(buffer)
    } catch {
      throw new Error(`不认识的编码：${encoding}（可用 utf-8、gbk、gb18030、big5、latin1）`)
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gb18030').decode(buffer)
  }
}

/** Guess the separator from the first non-empty line. */
export function guessDelimiter(text) {
  const line = String(text).split(/\r?\n/).find((row) => row.trim() !== '') ?? ''
  const counts = [',', ';', '\t', '|'].map((mark) => [mark, line.split(mark).length - 1])
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

export async function importDelimited(text, options = {}) {
  const delimiter = options.delimiter && options.delimiter !== 'auto'
    ? options.delimiter
    : guessDelimiter(text)
  const rows = parseCsv(text, { delimiter }).filter((row) => row.some((cell) => String(cell).trim() !== ''))
  return buildTable(rows, options)
}

/**
 * Turn a matrix of cells (from a CSV or a worksheet) into PSPP variables and
 * rows. Names stay ASCII, headings that are not become labels — see the note
 * below about PSPP reading our syntax in its own locale.
 */
export function buildTable(rows, options = {}) {
  if (rows.length === 0) throw new Error('the file has no rows')
  const header = options.hasHeader === false ? rows[0].map((_, index) => `V${index + 1}`) : rows[0]
  const bodyRows = options.hasHeader === false ? rows : rows.slice(1)
  const columns = header.length
  const variables = []
  // PSPP variable names are ASCII, at most 64 characters and unique, but a
  // spreadsheet heading is none of those. Renaming is unavoidable; renaming
  // silently is not, because the user then cannot find the column they
  // imported. Every rename is reported back through `notes`.
  const notes = []
  const used = new Set()
  for (let index = 0; index < columns; index += 1) {
    const rawName = String(header[index] ?? `V${index + 1}`).trim()
    // PSPP reads the generated syntax in its own locale, so a Chinese column
    // heading would arrive as mojibake and fail as an identifier. Keep names
    // ASCII and put the original heading in the variable label instead.
    const ascii = rawName.replaceAll(/[^A-Za-z0-9_]/g, '').replace(/^(\d)/, 'V$1').slice(0, 64)
    let name = ascii || `V${index + 1}`
    if (ascii && ascii !== rawName) {
      notes.push(ascii.length < rawName.length && rawName.startsWith(ascii)
        ? `第 ${index + 1} 列的表头「${rawName}」超过 64 个字符，变量名截成「${name}」，原表头保留为标签`
        : `第 ${index + 1} 列的表头「${rawName}」含 PSPP 变量名不允许的字符，变量名改为「${name}」，原表头保留为标签`)
    }
    if (!ascii) {
      notes.push(`第 ${index + 1} 列的表头「${rawName}」没有可用的 ASCII 字符，变量名改为「${name}」，原表头保留为标签`)
    }
    if (used.has(name)) {
      let suffix = 2
      while (used.has(`${name}_${suffix}`)) suffix += 1
      notes.push(`第 ${index + 1} 列的表头「${rawName}」与前面的列重名，变量名改为「${name}_${suffix}」`)
      name = `${name}_${suffix}`
    }
    used.add(name)
    // Whenever the name had to change, the original heading goes into the
    // label so the column can still be recognised — including the plain
    // "longer than 64 characters" case, which is ASCII but still renamed.
    const label = name !== rawName ? rawName : ''
    const samples = bodyRows.slice(0, 200).map((row) => row[index]).filter((value) => value !== undefined && String(value).trim() !== '')
    const numeric = samples.length > 0 && samples.every((value) => Number.isFinite(Number(String(value).trim())))
    const width = Math.min(255, Math.max(8, ...samples.map((value) => String(value).length), 8))
    variables.push({
      name,
      label,
      type: numeric ? 'numeric' : 'string',
      width: numeric ? 12 : width,
      decimals: numeric ? 2 : 0,
      format: numeric ? 'F12.2' : `A${width}`,
      measure: numeric ? 'scale' : 'nominal',
      role: 'input',
      alignment: numeric ? 'right' : 'left',
      missing: [],
      valueLabels: {},
    })
  }
  const rowsOut = bodyRows.map((row) => variables.map((variable, index) => {
    const raw = row[index]
    if (raw === undefined || String(raw).trim() === '') return null
    if (variable.type === 'string') return String(raw)
    const numeric = Number(String(raw).trim())
    return Number.isFinite(numeric) ? numeric : null
  }))
  return { variables, rows: rowsOut, source: basename(options.sourcePath ?? 'imported'), notes }
}
