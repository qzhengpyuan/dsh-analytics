import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { parseCsv, stringifyCsv } from './csv.js'
import { describeEngineError } from './fserr.js'

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
/**
 * Parse the "Missing Values" cell of DISPLAY DICTIONARY.
 *
 * PSPP prints it the way it was declared: `99` for one value, `1 THRU 5` for a
 * range, `1, 5` for a list, and a padded, double-quoted string for character
 * variables (`"ZZ      "`). Splitting on whitespace — what this used to do —
 * turned `1 THRU 5` into two discrete values and dropped everything before a
 * semicolon, so user-missing codes either leaked into the statistics or
 * vanished.
 */
export function parseMissingValues(text, type = 'numeric') {
  const source = String(text ?? '').trim()
  if (!source) return []
  const cleaned = (token) => {
    let value = String(token ?? '').trim()
    if (!value) return null
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim()
    }
    if (type === 'numeric') {
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }
    return value === '' ? null : value
  }
  const out = []
  // PSPP prints multiple codes separated by `;` (`90 THRU 99; 999`) while the
  // syntax we write uses commas. Splitting on commas alone left the range with
  // "99; 999" as its high bound, so the whole declaration was dropped and the
  // reopened file had no missing codes at all.
  for (const part of source.split(/[;,]/).map((piece) => piece.trim()).filter(Boolean)) {
    const range = /^(.+?)\s+THRU\s+(.+)$/i.exec(part)
    if (range) {
      const lo = cleaned(range[1])
      const hi = cleaned(range[2])
      if (typeof lo === 'number' && typeof hi === 'number') {
        out.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi) })
        continue
      }
      if (typeof lo === 'string' && typeof hi === 'string') {
        out.push({ lo, hi, text: true })
        continue
      }
    }
    const value = cleaned(part)
    if (value !== null) out.push(value)
  }
  return out
}

export async function readDictionary(run, savPath) {
  const script = [`GET FILE=${quoteSyntaxPath(savPath)}.`, 'DISPLAY DICTIONARY.'].join('\n') + '\n'
  const result = await run(script, { outName: 'dictionary', format: 'csv' })
  if (result.code !== 0 && result.stderr.trim() !== '') {
    throw new Error(`读不出数据字典（文件可能损坏或不是 SPSS 数据文件）：${describeEngineError(result.stderr, basename(savPath))}`)
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
        variables[variables.length - 1].missing = parseMissingValues(missingText, format.type)
      }
    }
  }

  if (valueBlock && variables.length > 0) {
    // The value-labels table names each variable by its label when it has one,
    // and by its name otherwise. On a Windows build the output encoding is the
    // ANSI code page, so every label made of Chinese characters comes back as
    // `??????` -- several variables can collapse onto the same text. Keep a list
    // per text (in dictionary order, which is the order the table lists them)
    // and consume it front to back, so collided labels still land on the right
    // variable instead of the last one winning.
    const byText = new Map()
    const remember = (text, variable) => {
      if (!text) return
      const list = byText.get(text)
      if (list) {
        if (!list.includes(variable)) list.push(variable)
      } else {
        byText.set(text, [variable])
      }
    }
    for (const variable of variables) remember(variable.name, variable)
    for (const variable of variables) remember(variable.label, variable)
    const used = new Set()
    let current = null
    for (const row of valueBlock.slice(1)) {
      const cells = parseCsv(row)[0]
      if (!cells) continue
      const rawVariable = (cells[0] ?? '').trim()
      if (rawVariable) {
        const list = byText.get(rawVariable) ?? []
        current = list.find((variable) => !used.has(variable)) ?? null
        if (current) used.add(current)
      }
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
  // The engine formats numbers in its own locale: a German one writes 1,5 and
  // the CSV then parses as two columns. open/export already pin C; this one did
  // not, so a non-C locale corrupted every reread silently.
  const result = await run(script, { outName: 'data', collectOutput: false, env: { LC_ALL: 'C', LANG: 'C' } })
  if (result.code !== 0) {
    throw new Error(`读不出数据：${describeEngineError(result.stderr, basename(savPath))}`)
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
  // A THRU range arrives as `{ lo, hi }` (parseMissingValues) or `[lo, hi]`.
  // Without this branch the range serialised to an empty string and the saved
  // file carried `MISSING VALUES age ().` — PSPP accepts that line and reads
  // back a variable with no missing codes at all, silently.
  if (value !== null && typeof value === 'object') {
    const rawLow = Array.isArray(value) ? value[0] : value.lo
    const rawHigh = Array.isArray(value) ? value[1] : value.hi
    if (variable.type === 'string') {
      // PSPP 2.1.3 rejects `MISSING VALUES s ('a' THRU 'b')` outright
      // ("expecting string"), so a string range cannot be written at all.
      // Serialising nothing was the silent version of that; writeSav() reports
      // it before anything is written.
      return ''
    }
    const low = Number(rawLow)
    const high = Number(rawHigh)
    if (!Number.isFinite(low) || !Number.isFinite(high)) return ''
    return `${Math.min(low, high)} THRU ${Math.max(low, high)}`
  }
  if (variable.type === 'string') return `'${String(value ?? '').replaceAll("'", "''")}'`
  const numeric = Number(value)
  return Number.isFinite(numeric) ? String(numeric) : ''
}

/** Write the dataset model back to an SPSS system file through the engine. */
export async function writeSav(run, dataset, outPath) {
  const { variables, rows } = dataset
  // PSPP reads the staging file with GET DATA /TYPE=TXT, whose reader cannot
  // keep a line break inside a quoted field: one embedded newline turns case 1
  // into two cases and shifts everything after it. Flatten them here and say
  // so, instead of writing a file that reads back with the wrong case count.
  const notes = []
  const flattened = new Map()
  const csvRows = rows.map((row) => row.map((cell, index) => {
    if (cell === null || cell === undefined) return ''
    const variable = variables[index]
    let text = String(cell)
    if (variable?.type === 'string' && /[\r\n]/.test(text)) {
      flattened.set(variable.name, (flattened.get(variable.name) ?? 0) + 1)
      text = text.replaceAll(/\r\n|\r|\n/g, ' ')
    }
    return text
  }))
  for (const [name, count] of flattened) {
    notes.push(`${name} 有 ${count} 个值里带换行：文本格式的 .sav 读不回来，保存时已把换行换成空格`)
  }
  const csvPath = `${outPath}.source.csv`
  await writeFile(csvPath, stringifyCsv(csvRows), 'utf8')
  try {
    const result = await writeSavFromCsv({
      run, outPath, csvPath, rows, variables,
      names: variables.map((variable) => variable.name),
    })
    return { ...result, notes }
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

  // 标签里的换行必须压成空格：PSPP 的语法是一行一条命令，标签里带 \n 会变成
  // `VALUE LABELS: Unterminated string constant`，整个 .sav 就写不出来
  // （复验 O2：0.114.0 是静默丢弃标签，0.115.0 改成保留后暴露了这个口子）。
  const oneLine = (text) => String(text ?? '').replaceAll(/[\r\n\t]+/g, ' ').trim()
  for (const variable of variables) {
    const label = oneLine(variable.label)
    if (label) lines.push(`VARIABLE LABELS ${variable.name} '${label.replaceAll("'", "''")}'.`)
  }
  for (const variable of variables) {
    const entries = Object.entries(variable.valueLabels ?? {})
    if (entries.length === 0) continue
    const parts = entries
      .map(([value, label]) => [value, oneLine(label)])
      .filter(([, label]) => label !== '')
      .map(([value, label]) => `${literal(variable, value)} '${label.replaceAll("'", "''")}'`)
    if (parts.length === 0) continue
    lines.push(`VALUE LABELS ${variable.name} ${parts.join(' ')}.`)
  }
  const stringRanges = variables.filter((variable) => variable.type === 'string'
    && (variable.missing ?? []).some((entry) => entry !== null && typeof entry === 'object'))
  if (stringRanges.length > 0) {
    const names = stringRanges.map((variable) => variable.name).join('、')
    throw new Error(`字符串变量 ${names} 的缺失值里有区间（THRU）：PSPP 只支持字符串用单个码，这样的区间写不进 .sav。请把区间换成单独的码，或把该变量改成数值变量`)
  }
  for (const variable of variables) {
    const missing = (variable.missing ?? [])
      .filter((value) => value !== '' && value !== null && value !== undefined)
      .map((value) => literal(variable, value))
      .filter((text) => text !== '')
    if (missing.length === 0) continue
    lines.push(`MISSING VALUES ${variable.name} (${missing.join(', ')}).`)
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
    // A timeout leaves no stderr at all, and "引擎没有给出原因" reads like a
    // broken file when the real answer is "it took too long".
    if (result.timedOut) {
      throw new Error(`保存数据失败：写 ${basename(outPath)} 超时了，引擎还没写完就被停下。数据量大或磁盘忙时会这样，可以在「设置 → 选项」里把超时调大再试`)
    }
    throw new Error(`保存数据失败：${describeEngineError(result.stderr, basename(outPath))}`)
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
  // A byte-order mark is the file telling us its encoding; ignoring it decodes
  // UTF-16LE as GB18030 and produces mojibake with no error to show for it.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3))
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
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
  // Count separators only outside quotes: a header like "Name, Vorname";Alter
  // otherwise makes the comma look like the real delimiter.
  const counts = new Map([',', ';', '\t', '|'].map((mark) => [mark, 0]))
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (counts.has(char)) counts.set(char, counts.get(char) + 1)
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1])
  return ranked[0][1] > 0 ? ranked[0][0] : ','
}

export async function importDelimited(text, options = {}) {
  const delimiter = options.delimiter && options.delimiter !== 'auto'
    ? options.delimiter
    : guessDelimiter(text)
  const parsed = parseCsv(text, { delimiter })
  // Files exported by other software often carry a title, a blank line, a note
  // and then the real table. Skipping rows is the user telling us where the
  // table starts, and the number they give is the line number they see in their
  // editor — so it is applied before blank lines are dropped, not after.
  const skip = Number(options.skipRows ?? 0)
  const skipped = Number.isFinite(skip) && skip > 0 ? parsed.slice(skip) : parsed
  const rows = skipped.filter((row) => row.some((cell) => String(cell).trim() !== ''))
  // The worksheet path gets this message from buildTable. Here the lines were
  // already dropped, so an empty result has to explain itself before buildTable
  // falls back to its bare "the file has no rows".
  if (rows.length === 0 && Number.isFinite(skip) && skip > 0) {
    throw new Error(`跳过的行数（${skip}）把整个文件都跳完了：请把行数调小，或确认这个文件的第一行数据在哪`)
  }
  // A 合计 row at the end is a table footnote, not a case. Dropping it here
  // keeps it out of every count (the wizard shows the number so the user knows
  // what left).
  const tail = Number(options.skipTailRows ?? 0)
  const trimmed = Number.isFinite(tail) && tail > 0 ? rows.slice(0, Math.max(0, rows.length - tail)) : rows
  if (trimmed.length === 0 && Number.isFinite(tail) && tail > 0) {
    throw new Error(`跳过的行数（${tail}）把整个文件都跳完了：请把行数调小，或确认这个文件的数据到哪一行为止`)
  }
  // Already skipped here (by file line), so buildTable must not skip again.
  // Both skips already applied: buildTable must not take them off again.
  return buildTable(trimmed, { ...options, skipRows: 0, skipTailRows: 0 })
}

/**
 * Turn a matrix of cells (from a CSV or a worksheet) into PSPP variables and
 * rows. Names stay ASCII, headings that are not become labels — see the note
 * below about PSPP reading our syntax in its own locale.
 */
export function buildTable(rows, options = {}) {
  if (rows.length === 0) throw new Error('the file has no rows')
  // A worksheet also carries title rows and notes above the table. Here the
  // count is over the sheet's own rows (blank rows are not part of it), which is
  // why it is applied here and not in the caller.
  const blankSkipped = Number(options.skipRows ?? 0)
  if (Number.isFinite(blankSkipped) && blankSkipped > 0) {
    rows = rows.slice(blankSkipped)
    if (rows.length === 0) throw new Error(`跳过的行数（${blankSkipped}）把整个文件都跳完了：请把行数调小，或确认这个文件的第一行数据在哪`)
  }
  // A worksheet can end with a totals line too; same meaning as in the CSV path.
  const tailRows = Number(options.skipTailRows ?? 0)
  if (Number.isFinite(tailRows) && tailRows > 0) {
    rows = rows.slice(0, Math.max(0, rows.length - tailRows))
    if (rows.length === 0) throw new Error(`跳过的行数（${tailRows}）把整个文件都跳完了：请把行数调小，或确认这个文件的数据到哪一行为止`)
  }
  const header = options.hasHeader === false ? rows[0].map((_, index) => `V${index + 1}`) : rows[0]
  // A heading like "年龄" cannot become a PSPP name, so the wizard lets the user
  // pick the name and the type per column after seeing the preview. Both arrive
  // here as arrays indexed like the columns; an empty entry means "decide it
  // the way the import would".
  const wantedNames = Array.isArray(options.names) ? options.names : []
  const wantedTypes = Array.isArray(options.types) ? options.types : []
  const missingTokens = (Array.isArray(options.missing) ? options.missing : [])
    .map((token) => String(token ?? '').trim())
    .filter((token) => token !== '')
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
    const asked = String(wantedNames[index] ?? '').trim()
    if (asked && asked !== name) {
      const asciiAsked = asked.replaceAll(/[^A-Za-z0-9_]/g, '').replace(/^(\d)/, 'V$1').slice(0, 64)
      let chosen = asciiAsked || name
      if (used.has(chosen) && chosen !== name) {
        let suffix = 2
        while (used.has(`${chosen}_${suffix}`)) suffix += 1
        chosen = `${chosen}_${suffix}`
      }
      if (chosen !== asked) {
        notes.push(`第 ${index + 1} 列按你填的名字「${asked}」存成「${chosen}」（PSPP 变量名只能用字母、数字、下划线，且不能重名）`)
      }
      used.delete(name)
      used.add(chosen)
      name = chosen
    }
    used.add(name)
    // Whenever the name had to change, the original heading goes into the
    // label so the column can still be recognised — including the plain
    // "longer than 64 characters" case, which is ASCII but still renamed.
    const label = name !== rawName ? rawName : ''
    // Every row is scanned, not the first 200: a column of numbers followed by
    // long text would otherwise be cut to the width of its first 200 cells, and
    // a column whose 201st cell is "n/a" would change type unnoticed.
    let numericCount = 0
    let otherCount = 0
    let longest = 0
    for (const row of bodyRows) {
      const raw = row[index]
      if (raw === undefined) continue
      const text = String(raw)
      if (text.trim() === '') continue
      // A declared code ("-9", "NA") is not data: counting it as a number or as
      // text would decide the column's type from the marker instead of from the
      // values.
      if (missingTokens.includes(text.trim())) continue
      if (text.length > longest) longest = text.length
      if (Number.isFinite(Number(text.trim()))) numericCount += 1
      else otherCount += 1
    }
    // A numeric column with a stray "n/a" stays numeric: that cell becomes a
    // missing value and the loss is reported below. Downgrading the whole
    // column to text because of one cell would make every number in it
    // unusable for analysis. A text column keeps its majority: "2024" in a
    // column of names must not turn it into a number.
    const askedType = String(wantedTypes[index] ?? '')
    const numeric = askedType === 'numeric'
      ? true
      : askedType === 'string'
        ? false
        : numericCount > 0 && otherCount <= numericCount
    const width = Math.min(255, Math.max(8, longest, 8))
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
  // Type inference only looked at the first 200 rows. A spreadsheet with
  // 999 rows of numbers and one "n/a" further down would silently become a
  // missing value, so count what was lost and say it.
  const lostNumeric = new Map()
  const lostText = new Map()
  const declared = new Map()
  for (const variable of variables) {
    const codes = []
    for (const token of missingTokens) {
      if (variable.type === 'string') {
        if (!Number.isFinite(Number(token))) codes.push(token)
      } else if (Number.isFinite(Number(token))) {
        codes.push(Number(token))
      }
    }
    if (codes.length === 0) continue
    variable.missing = [...(variable.missing ?? []), ...codes.filter((code) => !(variable.missing ?? []).includes(code))]
    declared.set(variable.name, codes.length)
  }
  if (declared.size > 0) {
    const names = [...declared.keys()].join('、')
    notes.push(`${names} 里你声明的缺失值标记（${missingTokens.join('、')}）已存成变量的用户缺失值，统计时不计入个案`)
  }
  const rowsOut = bodyRows.map((row) => variables.map((variable, index) => {
    const raw = row[index]
    if (raw === undefined || String(raw).trim() === '') return null
    // The marker is declared in the file's own spelling; store it as missing.
    // It only counts for a column of the matching kind — judging here by type is
    // what keeps this in step with variable.missing above. Otherwise the panel
    // clears "-9" out of a text column without recording it as a declared value,
    // and the frequency table shows an empty label nobody can explain.
    const marker = String(raw).trim()
    if (missingTokens.includes(marker)) {
      const sameKind = variable.type === 'string' ? !Number.isFinite(Number(marker)) : Number.isFinite(Number(marker))
      if (sameKind) return null
    }
    if (variable.type === 'string') {
      const text = String(raw)
      if (text.length > variable.width) {
        lostText.set(variable.name, (lostText.get(variable.name) ?? 0) + 1)
      }
      return text
    }
    const numeric = Number(String(raw).trim())
    if (!Number.isFinite(numeric)) {
      lostNumeric.set(variable.name, (lostNumeric.get(variable.name) ?? 0) + 1)
      return null
    }
    return numeric
  }))
  for (const [name, count] of lostNumeric) {
    notes.push(`${name} 有 ${count} 个格子不是数字，已当缺失值处理；要保留原文请把该列改成字符串变量重新导入`)
  }
  for (const [name, count] of lostText) {
    notes.push(`${name} 有 ${count} 个格子超过列宽 ${variables.find((v) => v.name === name)?.width}，存成 .sav 时会被截断；需要完整文本请在变量视图里调大宽度`)
  }
  return { variables, rows: rowsOut, source: basename(options.sourcePath ?? 'imported'), notes }
}
