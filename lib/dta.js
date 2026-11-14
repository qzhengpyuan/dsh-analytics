// Stata .dta reader (release 117 / 118), no dependencies.
//
// A modern .dta is a single file of tagged sections — `<header>`,
// `<variable_types>`, `<varnames>`, … `<data>` — so the layout is discovered by
// section rather than by a fixed byte map. Legacy files (release 113–115) have
// no tags at all and are refused with a readable message.
//
// Every column has a fixed width in the data section, which is why the reader
// can walk it without keeping a per-column cursor table.

const TAG_START = '<stata_dta>'
const TYPE_STR_MAX = 2045
const TYPE_STRL = 32768
const TYPE_DOUBLE = 65526
const TYPE_FLOAT = 65527
const TYPE_LONG = 65528
const TYPE_INT = 65529
const TYPE_BYTE = 65530

const text = (buffer, start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '')

function findTag(buffer, tag, from = 0) {
  const at = buffer.indexOf(tag, from, 'utf8')
  if (at < 0) throw new Error(`不是一个有效的 .dta 文件（缺少 ${tag}）`)
  return at
}

function section(buffer, name) {
  const open = `${'<'}${name}>`
  const close = `</${name}>`
  const start = findTag(buffer, open) + open.length
  const end = findTag(buffer, close, start)
  return { start, end, body: buffer.subarray(start, end) }
}

const readU16 = (buffer, at) => buffer.readUInt16LE(at)
const readU32 = (buffer, at) => buffer.readUInt32LE(at)
const readI32 = (buffer, at) => buffer.readInt32LE(at)

/** Type code → byte width inside the data section. */
function typeWidth(type) {
  if (type === TYPE_DOUBLE) return 8
  if (type === TYPE_FLOAT || type === TYPE_LONG) return 4
  if (type === TYPE_INT) return 2
  if (type === TYPE_BYTE) return 1
  if (type === TYPE_STRL) return 8
  if (type >= 1 && type <= TYPE_STR_MAX) return type
  throw new Error(`不认识的 .dta 变量类型：${type}`)
}

function typeKind(type) {
  if (type === TYPE_STR_MAX + 1 || type === TYPE_STRL) return 'strl'
  if (type >= 1 && type <= TYPE_STR_MAX) return 'string'
  return 'numeric'
}

/** Stata stores missing values as the top few codes of each integer type. */
function intMissing(value, type) {
  if (type === TYPE_BYTE) return value > 100
  if (type === TYPE_INT) return value > 32740
  if (type === TYPE_LONG) return value > 2147483620
  return false
}

function readValue(buffer, at, type) {
  if (type === TYPE_BYTE) {
    const raw = buffer.readInt8(at)
    return intMissing(raw, type) ? null : raw
  }
  if (type === TYPE_INT) {
    const raw = buffer.readInt16LE(at)
    return intMissing(raw, type) ? null : raw
  }
  if (type === TYPE_LONG) {
    const raw = readI32(buffer, at)
    return intMissing(raw, type) ? null : raw
  }
  if (type === TYPE_FLOAT) {
    const raw = buffer.readFloatLE(at)
    return Number.isFinite(raw) && Math.abs(raw) < 1e30 ? raw : null
  }
  if (type === TYPE_DOUBLE) {
    const raw = buffer.readDoubleLE(at)
    return Number.isFinite(raw) && Math.abs(raw) < 8.9e307 ? raw : null
  }
  if (type >= 1 && type <= TYPE_STR_MAX) {
    const value = text(buffer, at, type)
    return value === '' ? null : value
  }
  throw new Error(`不认识的 .dta 变量类型：${type}`)
}

/** `%9.0g` / `%12.2f` / `%-20s` → width, decimals, and the PSPP format. */
function parseFormat(format, type) {
  const match = /%(-)?(\d+)(?:\.(\d+))?([a-zA-Z]+)/.exec(format ?? '')
  const width = match ? Number(match[2]) : 0
  const decimals = match && match[3] !== undefined ? Number(match[3]) : 0
  if (typeKind(type) === 'string') {
    const size = Math.min(255, Math.max(8, width || 8))
    return { width: size, decimals: 0, format: `A${size}` }
  }
  const size = Math.min(40, Math.max(8, width || 12))
  return { width: size, decimals, format: `F${size}.${decimals}` }
}

/**
 * Value labels. A `<lbl>` block is `<u32 nameLen?>` `<name, padded>` `<n u32>`
 * `<txtlen u32>` `<two u32>` `<n × val i32>` `<text, strings separated by \0>`.
 * The name padding differs between writers, so the n/txtlen pair is located by
 * the length equation p + 8 + 8 + 4n + txtlen == blockLength instead of a
 * fixed offset.
 */
function parseLabelBlock(block) {
  for (let at = 4; at + 8 <= block.length; at += 4) {
    const pairs = block.readUInt32LE(at)
    if (pairs < 1 || pairs > 10_000) continue
    const textLength = block.readUInt32LE(at + 4)
    if (textLength < 1) continue
    if (at + 8 + 8 + pairs * 4 + textLength !== block.length) continue
    const name = block.toString('utf8', 4, at).replace(/\0.*$/s, '').trim()
    if (!name) continue
    const values = []
    let cursor = at + 16
    for (let index = 0; index < pairs; index += 1) {
      values.push(readI32(block, cursor))
      cursor += 4
    }
    const textStart = block.length - textLength
    const strings = block.toString('utf8', textStart, block.length).split('\0').filter((entry) => entry !== '')
    if (strings.length < pairs) continue
    const map = new Map()
    for (let index = 0; index < pairs; index += 1) map.set(String(values[index]), strings[index])
    return { name, map }
  }
  return null
}

function parseValueLabels(buffer) {
  const tables = new Map()
  const open = buffer.indexOf('<value_labels>', 0, 'utf8')
  if (open < 0) return tables
  const start = open + '<value_labels>'.length
  const close = buffer.indexOf('</value_labels>', start, 'utf8')
  if (close < 0) return tables
  let cursor = start
  while (cursor < close) {
    const tagAt = buffer.indexOf('<lbl>', cursor, 'utf8')
    if (tagAt < 0 || tagAt >= close) break
    const bodyStart = tagAt + '<lbl>'.length
    const bodyEnd = buffer.indexOf('</lbl>', bodyStart, 'utf8')
    if (bodyEnd < 0) break
    const parsed = parseLabelBlock(buffer.subarray(bodyStart, bodyEnd))
    if (parsed) tables.set(parsed.name, parsed.map)
    cursor = bodyEnd + '</lbl>'.length
  }
  return tables
}

export function readDta(buffer) {
  if (buffer.subarray(0, TAG_START.length).toString('utf8') !== TAG_START) {
    const release = buffer.length > 0 ? buffer[0] : 0
    if (release >= 113 && release <= 115) {
      throw new Error(`这是 Stata 12 及更早的 .dta（release ${release}），暂不支持；请用 Stata 另存为 .dta(118) 或导出 CSV`)
    }
    throw new Error('不是一个有效的 .dta 文件（缺少 <stata_dta> 标记）')
  }

  // Every real file ends with the closing tag; without it the tail was lost.
  const tail = buffer.toString('utf8', Math.max(0, buffer.length - 64))
  if (!tail.includes('</stata_dta>')) throw new Error('这个 .dta 文件被截断（缺少结尾标记）')

  const header = section(buffer, 'header').body
  // <release> and <byteorder> are text, but <K>, <N> and <label> are raw
  // fields whose width depends on the release (K is 2 bytes, N is 4 or 8), so
  // read the width from the layout instead of assuming one.
  const field = (name) => {
    const open = Buffer.from(`<${name}>`, 'utf8')
    const close = Buffer.from(`</${name}>`, 'utf8')
    const start = header.indexOf(open)
    if (start < 0) return null
    const from = start + open.length
    const end = header.indexOf(close, from)
    if (end < 0) return null
    return header.subarray(from, end)
  }
  const release = Number(field('release')?.toString('utf8') ?? 0)
  if (release !== 117 && release !== 118) {
    throw new Error(`暂不支持这个 .dta 版本（release ${release || '未知'}）；支持 117/118`)
  }
  const order = field('byteorder')?.toString('utf8') ?? 'LSF'
  if (order !== 'LSF') throw new Error('暂不支持大端（MSF）的 .dta 文件')
  const kBytes = field('K')
  const nBytes = field('N')
  const count = kBytes && kBytes.length >= 4 ? kBytes.readUInt32LE(0) : (kBytes ? kBytes.readUInt16LE(0) : 0)
  const cases = nBytes && nBytes.length >= 8
    ? Number(nBytes.readBigUInt64LE(0))
    : (nBytes && nBytes.length >= 4 ? nBytes.readUInt32LE(0) : 0)
  if (count <= 0) throw new Error('这个 .dta 里没有变量')
  const dataLabel = (field('label')?.toString('utf8').replace(/\0/g, '') ?? '').trim()

  const typesSection = section(buffer, 'variable_types')
  const types = []
  for (let index = 0; index < count; index += 1) types.push(readU16(typesSection.body, index * 2))

  // Fixed-width string lists: 118 widened names (33 → 129) and labels
  // (81 → 321), so the width comes from the section length rather than a
  // constant — a 117 file and a 118 file then read the same way.
  const stringColumn = (name) => {
    const body = section(buffer, name).body
    const width = count > 0 && body.length % count === 0 ? body.length / count : 0
    if (!width) throw new Error(`这个 .dta 的 ${name} 段长度异常`)
    const values = []
    for (let index = 0; index < count; index += 1) values.push(text(body, index * width, width).trim())
    return values
  }
  const names = stringColumn('varnames')
  const formats = stringColumn('formats')
  const labelNames = stringColumn('value_label_names')
  const variableLabels = stringColumn('variable_labels')

  const labelTables = parseValueLabels(buffer)

  const kinds = types.map(typeKind)
  if (kinds.some((kind) => kind === 'strl')) {
    throw new Error('这个 .dta 含 strL 长字符串变量，暂不支持；请在 Stata 里改用普通字符串或导出 CSV')
  }

  const widths = types.map(typeWidth)
  const rowWidth = widths.reduce((sum, width) => sum + width, 0)
  const dataStart = findTag(buffer, '<data>') + '<data>'.length
  if (buffer.length < dataStart + rowWidth * cases) {
    throw new Error('这个 .dta 的数据段不完整（文件被截断？）')
  }

  const variables = names.map((name, index) => {
    const type = types[index]
    const kind = kinds[index]
    const parsed = parseFormat(formats[index], type)
    const labels = labelTables.get(labelNames[index]) ?? new Map()
    return {
      // Stata names are already plain identifiers, but a hand-made file could
      // carry something else; keep PSPP happy with the same ASCII rule.
      name: name.replaceAll(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, 'V$1').slice(0, 64) || `V${index + 1}`,
      label: variableLabels[index] || '',
      type: kind === 'string' ? 'string' : 'numeric',
      width: parsed.width,
      decimals: parsed.decimals,
      format: parsed.format,
      measure: kind === 'string' ? 'nominal' : 'scale',
      role: 'input',
      alignment: kind === 'string' ? 'left' : 'right',
      missing: [],
      valueLabels: Object.fromEntries(labels),
    }
  })

  const rows = []
  for (let row = 0; row < cases; row += 1) {
    let at = dataStart + row * rowWidth
    const values = []
    for (let column = 0; column < count; column += 1) {
      values.push(readValue(buffer, at, types[column]))
      at += widths[column]
    }
    rows.push(values)
  }

  return {
    variables,
    rows,
    sheetName: undefined,
    label: dataLabel,
    sheetNames: undefined,
  }
}
