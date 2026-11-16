// Word (.docx) and Excel (.xlsx) writers for the output view.
//
// Both formats are ZIP archives of XML parts; with lib/zip.js in hand a report
// export needs no dependency, and the result opens in Word/WPS/LibreOffice and
// Excel/WPS/Calc respectively. Charts are embedded as PNG so the same picture
// the panel shows lands in the document.

import { buildZip, xmlEscape } from './zip.js'

/** EMU per pixel at 96 dpi, the unit a DrawingML extent measures in. */
const EMU_PER_PIXEL = 9525
/** Height of a default Excel row, in EMU (15 pt). */
const ROW_EMU = 190_500
/** Text column width on an A4 page with 2 cm margins, in EMU (14 cm). */
const MAX_IMAGE_CX = 5_040_000

/**
 * One size for a picture in both Word and Excel.
 *
 * Word measures with wp:extent and Excel with xdr:ext, but a document that
 * shows the same chart at 396.9 pt in Word and 432 pt in the spreadsheet looks
 * careless. Both writers call this: pixels at 96 dpi, capped to the text column
 * so nothing overflows the table.
 */
export function imageExtent(width, height) {
  const ratio = width > 0 && height > 0 ? width / height : 1.55
  const wanted = width > 0 ? width * EMU_PER_PIXEL : MAX_IMAGE_CX
  const cx = Math.max(600_000, Math.min(MAX_IMAGE_CX, Math.round(wanted)))
  return { cx, cy: Math.max(300_000, Math.round(cx / ratio)) }
}

/**
 * Decide which table a picture belongs to.
 *
 * "The nearest table above it" was a guess, and a wrong one: a distribution
 * chart drawn after a logistic regression landed inside the coefficients table.
 * A chart now carries the run it was drawn for (`sourceRunId`) and, when that
 * run produced exactly one table, that table is the answer. A multi-table run
 * is only trusted when both the chart's variable and its grouping variable
 * appear in the same table's text — one unambiguous hit — otherwise the picture
 * stays on its own, which is the honest outcome when the association is not
 * known.
 */
export function pairCharts(items = []) {
  const tables = items.filter((item) => item.kind === 'table')
  const textOf = (table) => [
    table.table?.caption,
    table.title,
    ...(Array.isArray(table.table?.matrix) ? table.table.matrix.flat() : []),
  ].map((cell) => String(cell ?? '')).join(' ').toLowerCase()
  const paired = new Map()
  const standalone = new Set()
  for (const image of items) {
    if (image.kind !== 'image') continue
    let target = null
    if (image.tableId !== null && image.tableId !== undefined) {
      target = tables.find((table) => table.id === image.tableId) ?? null
    } else if (image.sourceRunId !== null && image.sourceRunId !== undefined) {
      const same = tables.filter((table) => String(table.runId) === String(image.sourceRunId))
      if (same.length === 1) target = same[0]
      else if (same.length > 1 && image.chartSpec?.variable) {
        const terms = [image.chartSpec.variable, image.chartSpec.by]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase())
        const hits = same.filter((table) => {
          const text = textOf(table)
          return terms.every((term) => text.includes(term))
        })
        if (hits.length === 1) target = hits[0]
        // Several tables mention the variable (FREQUENCIES prints both a
        // Statistics summary and the distribution). The one titled after the
        // variable is the picture's table.
        else if (hits.length > 1) {
          const variable = String(image.chartSpec.variable).toLowerCase()
          const titled = hits.filter((table) => String(table.table?.caption ?? table.title ?? '').toLowerCase().includes(variable))
          if (titled.length === 1) target = titled[0]
        }
      }
    }
    if (target) {
      if (!paired.has(target)) paired.set(target, [])
      paired.get(target).push(image)
    } else {
      standalone.add(image)
    }
  }
  return { paired, standalone }
}

const DOCX_CONTENT_TYPE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

/** A paragraph with an optional style. */
export function paragraph(text, { bold = false, italic = false, size = null, align = null, keepNext = false } = {}) {
  const runProps = `${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}`
  const props = `${keepNext ? '<w:keepNext/>' : ''}${align ? `<w:jc w:val="${align}"/>` : ''}${runProps ? `<w:rPr>${runProps}</w:rPr>` : ''}`
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r>${runProps ? `<w:rPr>${runProps}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
}

/**
 * The caveats that belong to a table (separation, skipped variables, tolerance).
 *
 * They live in `item.notes` so the panel and the agent can read them; without
 * this the exported document silently drops them, which is where they matter
 * most (a thesis file that a supervisor reads). One paragraph per note, italic
 * 10.5 pt, prefixed 注： like a journal table note.
 */
export function notesParagraphs(notes = []) {
  return (Array.isArray(notes) ? notes : [])
    .map((note) => String(note ?? '').trim())
    .filter(Boolean)
    .map((note) => paragraph(`注：${note}`, { size: 21, italic: true }))
}

/**
 * Runs for one table cell, with a trailing significance marker as superscript.
 *
 * A journal table writes "−10.000**" with the stars raised; Word only does that
 * with a separate run carrying <w:vertAlign w:val="superscript"/>, so the text
 * has to be split before it goes into the document.
 */
const SIGNIFICANCE_STARS = /^(.*?)\s*(\*{1,3})$/

export function cellRuns(text, header = false) {
  const props = header ? '<w:b/><w:sz w:val="18"/><w:szCs w:val="18"/>' : '<w:sz w:val="18"/><w:szCs w:val="18"/>'
  const value = String(text ?? '')
  const match = header ? null : value.match(SIGNIFICANCE_STARS)
  if (!match) return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(value)}</w:t></w:r>`
  const base = match[1]
  const stars = `<w:r><w:rPr>${props}<w:vertAlign w:val="superscript"/></w:rPr><w:t>${xmlEscape(match[2])}</w:t></w:r>`
  if (base.trim() === '') return stars
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(base)}</w:t></w:r>${stars}`
}

/**
 * A borderless table where the header row and the bottom rule carry the lines.
 *
 * `options.image` ({relId, aspect}) appends one merged row holding the inline
 * picture: a chart stays inside the table it belongs to instead of becoming a
 * loose paragraph that a page break can separate from its numbers.
 */
export function tableXml(matrix, options = {}) {
  if (!Array.isArray(matrix) || matrix.length === 0) return ''
  const columns = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  const borders = (bottom) => `<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="${bottom ? 'single' : 'nil'}" w:sz="8" w:color="000000"/><w:right w:val="nil"/>`
  const rows = matrix.map((row, rowIndex) => {
    const header = rowIndex === 0
    const cells = []
    for (let column = 0; column < columns; column += 1) {
      const text = row[column] ?? ''
      // One tcPr per cell and nothing after the paragraph: XML schema order
      // matters to Word, and a second w:tcBorders appended after </w:p> (the old
      // shape) makes the cell content invalid, so Word silently drops the rule.
      const cellBorders = header
        ? '<w:top w:val="single" w:sz="12" w:color="000000"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="8" w:color="000000"/><w:right w:val="nil"/>'
        : borders(false)
      cells.push(`<w:tc><w:tcPr><w:tcBorders>${cellBorders}</w:tcBorders></w:tcPr>`
        + `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${cellRuns(text, header)}</w:p></w:tc>`)
    }
    return `<w:tr>${cells.join('')}</w:tr>`
  })
  const width = Math.floor(9360 / Math.max(1, columns))
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')
  // The picture sits between the caption and the header row: that is where a
  // journal puts a figure, and it keeps the header line directly above its data.
  const list = options.images ?? (options.image ? [options.image] : [])
  const imageRow = list
    .map((image) => `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="${columns}"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr>`
      + `${imageXml(image.relId, image.extent ?? image.aspect)}</w:tc></w:tr>`)
    .join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${imageRow}${rows.join('')}</w:tbl>`
}

/** An inline picture occupying the text column of an A4 page. */
export function imageXml(relId, extent) {
  const size = extent && typeof extent === 'object' && extent.cx
    ? extent
    : imageExtent(MAX_IMAGE_CX, null)
  const cx = size.cx
  const cy = size.cy
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${relId.replace(/\D/g, '') || 1}" name="chart"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

/**
 * Build a .docx from output items.
 * @param {{ title?: string, items: Array<object>, images?: Array<{name: string, bytes: Buffer}> }} options
 *   `images` are keyed by `item.artifactUrl` through `item.chartImage`.
 * @returns {Buffer}
 */
/** A W3CDTF stamp for docProps/core.xml (no locale surprises). */
function w3cdtf(ms) {
  const date = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
}

/** "2026-11-16 12:34" in local time, for the line a reader actually sees. */
function readableTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * One line per source dataset: what a printed table has to carry so it can still
 * be traced after it leaves the panel. `origin` decides how the source is named —
 * a dataset built in the panel has no file and must not be printed as one.
 * @param {Array<object>} sources provenance records
 * @returns {string[]}
 */
export function describeSources(sources) {
  const list = Array.isArray(sources) ? sources : []
  return list.map((source) => {
    const when = readableTime(source?.openedAt)
    const count = source?.caseCount ?? 0
    const vars = source?.varCount ?? 0
    let which
    if (source?.origin === 'new') {
      which = source?.name ? `新建数据集（${source.name}，未保存）` : '新建数据集（未保存）'
    } else if (source?.origin === 'upload' || source?.temporary === true) {
      which = `拖入的副本${source?.name ? `（${source.name}）` : ''}`
    } else {
      which = source?.sourcePath ?? source?.name ?? '未命名数据'
    }
    const size = typeof source?.sourceSize === 'number'
      ? `，${source.sourceSize < 1024 ? `${source.sourceSize} B` : `${(source.sourceSize / 1024).toFixed(1)} KB`}`
      : ''
    return `${which} · ${count} 例 · ${vars} 变量${size}${when ? ` · 打开于 ${when}` : ''}`
  })
}

/**
 * One line saying where a single table came from. The document-level list at
 * the end names every source in the session; a reader who is handed one table
 * needs the answer next to that table, not at the bottom of the file.
 */
export function sourceStamp(provenance) {
  const source = provenance ?? {}
  const count = source.caseCount ?? 0
  const when = readableTime(source.openedAt)
  let which
  if (source.origin === 'new') which = `新建数据集${source.name ? `（${source.name}）` : ''}`
  else if (source.origin === 'upload' || source.temporary === true) which = `拖入的副本${source.name ? `（${source.name}）` : ''}`
  else which = source.name ?? source.sourcePath ?? '未命名数据'
  const parts = [`来源：${which}`, `${count} 例`]
  if (typeof source.sourceSize === 'number') parts.push(`${source.sourceSize < 1024 ? `${source.sourceSize} B` : `${(source.sourceSize / 1024).toFixed(1)} KB`}`)
  if (when) parts.push(`打开于 ${when}`)
  return parts.join(' · ')
}

/** docProps/core.xml — the title/subject a reader sees in 文件 → 属性. */
function corePropsXml(title, lines) {
  const escape = (text) => String(text ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const subject = lines.length > 0 ? `数据来源：${lines.join('；')}` : ''
  const description = lines.length > 0
    ? `本文件的每张表都由下列数据计算：\n${lines.map((line) => `· ${line}`).join('\n')}\n由 dsh-analytics（GNU PSPP 引擎）生成；表上的数字与这份数据一致，改动数据后请重新运行分析。`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escape(title)}</dc:title>
<dc:subject>${escape(subject)}</dc:subject>
<dc:description>${escape(description)}</dc:description>
<dc:creator>dsh-analytics</dc:creator>
<cp:lastModifiedBy>dsh-analytics</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${w3cdtf(Date.now())}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${w3cdtf(Date.now())}</dcterms:modified>
</cp:coreProperties>`
}

// Both packages need the same two things to carry docProps/core.xml: the part
// override in [Content_Types].xml and a relationship from the package root.
const CORE_PROPS_TYPE = '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
const CORE_PROPS_REL = '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'

export function buildDocx({ title = '统计输出', items = [], images = [], sources = [] }) {
  const body = [paragraph(title, { bold: true, size: 32, align: 'center' })]
  const media = []
  const rels = []
  // Artifact URLs carry a cache-busting `v=`, so match on path and name.
  const keyOf = (url) => String(url ?? '').replace(/([?&])v=[^&]*/g, '$1').replace(/[?&]$/, '')
  const byUrl = new Map(images.map((image) => [keyOf(image.url), image]))
  // Which table a chart belongs to is decided by pairCharts, not by position:
  // a page break must not separate a picture from the table it explains, and a
  // chart from another run must not be dropped into the table that happens to
  // sit above it.
  const { paired, standalone } = pairCharts(items)
  let index = 0
  const embed = (item) => {
    const image = byUrl.get(keyOf(item.url ?? item.artifactUrl))
    if (!image || !image.bytes) return null
    index += 1
    const name = `chart${index}.png`
    media.push({ name, bytes: Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes) })
    rels.push(`<Relationship Id="rIdImg${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`)
    const extent = imageExtent(image.width, image.height)
    return { relId: `rIdImg${index}`, extent, image }
  }
  for (const item of items) {
    if (item.kind === 'table') {
      const caption = item.table?.caption ?? item.title ?? ''
      const charts = (paired.get(item) ?? []).map(embed).filter(Boolean)
      if (caption) body.push(paragraph(caption, { bold: true, size: 20, keepNext: true }))
      body.push(tableXml(item.table?.matrix, { images: charts.map(({ relId, extent }) => ({ relId, extent })) }))
      // Per-table stamp first: it answers "which data produced this table"
      // without making the reader hunt for the document footer.
      if (item.provenance) body.push(paragraph(sourceStamp(item.provenance), { size: 14 }))
      body.push(...notesParagraphs(item.notes))
      body.push(paragraph(''))
    } else if (item.kind === 'image') {
      if (!standalone.has(item)) continue
      if (item.title) body.push(paragraph(item.title, { bold: true, size: 20, keepNext: true }))
      const chart = embed(item)
      if (chart) body.push(imageXml(chart.relId, chart.extent))
      else body.push(paragraph('（图表缺失）'))
    } else if (item.title) {
      body.push(paragraph(item.title, { bold: true, size: 20 }))
    }
  }

  // The source line is visible on purpose: a docx that is printed or mailed has
  // to say what it was computed from, and docProps alone is easy to miss.
  const sourceLines = describeSources(sources)
  if (sourceLines.length > 0) {
    body.push(paragraph('数据来源：', { bold: true, size: 16 }))
    body.push(...sourceLines.map((line) => paragraph(`· ${line}`, { size: 16 })))
    body.push(paragraph('（由 dsh-analytics 生成，引擎 GNU PSPP；改动数据后请重新运行分析。）', { size: 16 }))
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${WORD_NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`

  const files = {
    '[Content_Types].xml': DOCX_CONTENT_TYPE.replace('</Types>', `${CORE_PROPS_TYPE}</Types>`),
    '_rels/.rels': DOCX_RELS.replace('</Relationships>', `${CORE_PROPS_REL}</Relationships>`),
    'docProps/core.xml': corePropsXml(title, sourceLines),
    'word/document.xml': document,
    'word/_rels/document.xml.rels': documentRels,
  }
  for (const entry of media) files[`word/media/${entry.name}`] = entry.bytes
  return buildZip(files)
}

/**
 * Read a PNG's pixel size from its IHDR chunk.
 * @param {Buffer} bytes
 * @returns {{width: number|null, height: number|null}}
 */
export function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    return { width: null, height: null }
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const XLSX_CONTENT_TYPE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
{sheets}
</Types>`

/** Excel forbids these characters in a sheet name and caps it at 31 chars. */
export function sheetName(title, index, used = new Set()) {
  const cleaned = String(title ?? '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
  let name = cleaned || `Sheet${index + 1}`
  let suffix = 2
  while (used.has(name.toLowerCase())) {
    const tail = ` (${suffix})`
    name = `${name.slice(0, 31 - tail.length)}${tail}`
    suffix += 1
  }
  used.add(name.toLowerCase())
  return name
}

function columnLetter(index) {
  let value = index + 1
  let letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return letters
}

/**
 * Styles beyond the four defaults, by cellXfs index: a percentage cell needs a
 * number format, otherwise `12 / 63 * 100` would read as `19.047619` and not as
 * the `19.0%` the printed table showed.
 */
const PERCENT_STYLE = 4
const DECIMAL2_STYLE = 5
const DECIMAL3_STYLE = 6

/**
 * A cell Excel should treat as a number: optional sign, optional leading dot,
 * optional exponent, and no surrounding whitespace (a padded value is a label).
 */
function isNumericText(text) {
  const raw = String(text ?? '')
  if (raw === '' || raw.trim() !== raw) return false
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
}

function numericOf(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const value = Number(raw.replace(/%$/, ''))
  return Number.isFinite(value) ? value : null
}

function columnOf(row, pattern) {
  if (!Array.isArray(row)) return -1
  return row.findIndex((cell) => pattern.test(String(cell ?? '').trim()))
}

/**
 * Excel formulas for the quantities a table already carries.
 *
 * Only sums-of-its-own-cells are written: a percentage is its count over the
 * total, a total row is SUM of the column, Wald is (B/S.E.)², and an Exp(B)
 * interval is exp(B ± 1.96·S.E.). A mean, a standard deviation or a p value of
 * a test cannot be recovered from the printed table, so they stay numbers — a
 * formula there would be fiction.
 *
 * Each entry keeps the printed value as the cached result, so the workbook
 * shows exactly what PSPP printed until someone edits an input cell.
 *
 * @param {Array<Array<string>>} matrix
 * @param {string} caption
 * @returns {Map<string, {cached: number|null, style: number, build: (ref: (row: number, column: number) => string) => string}>}
 */
/** Excel sheet name as a formula prefix: plain identifiers stay bare, the rest are quoted. */
export function escapeSheetName(name) {
  const text = String(name ?? '').trim()
  if (text === '') return "''"
  const plain = /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*$/.test(text) && !/^[A-Za-z]{1,3}\d+$/.test(text)
  return plain ? text : `'${text.replace(/'/g, "''")}'`
}

/** The subject a table belongs to, taken from a trailing "(name)" in its title. */
function subjectOf(caption) {
  const text = String(caption ?? '').trim()
  const match = /^[^(]*\((.+)\)\s*$/.exec(text)
  return match ? match[1].trim() : ''
}

export function formulaMap(matrix, caption = '', context = {}) {
  const cells = new Map()
  if (!Array.isArray(matrix) || matrix.length < 2) return cells
  const head = matrix.slice(0, 4)
  const frequencyRow = head.findIndex((row) => columnOf(row, /^Frequency$/i) >= 0 && columnOf(row, /^Percent$/i) >= 0)
  if (frequencyRow >= 0) return frequencyFormulas(matrix, frequencyRow)
  const coefficientRow = head.findIndex((row) => columnOf(row, /^B$/) >= 0 && columnOf(row, /^S\.E\.$/i) >= 0 && columnOf(row, /^Exp\(B\)$/i) >= 0)
  if (coefficientRow >= 0) return coefficientFormulas(matrix, coefficientRow)
  // R, R Square and Adjusted R Square are all functions of the ANOVA sums of
  // squares, so they become formulas only when that sheet is in the same file.
  const modelRow = head.findIndex((row) => columnOf(row, /^R Square$/i) >= 0 && columnOf(row, /^R$/i) >= 0)
  if (modelRow >= 0 && context.anova) {
    const model = modelSummaryFormulas(matrix, modelRow, context.anova)
    if (model.size > 0) return model
  }
  const statistic = statisticFormulas(matrix, context)
  if (statistic.size > 0) return statistic
  // Correlations print r, its p value and N in one column, so the p value is a
  // t tail that the sheet itself can recompute.
  const correlation = correlationFormulas(matrix)
  if (correlation.size > 0) return correlation
  // Non-parametric tables stack the statistic, its df and the p value in a
  // column instead of a row, which is the transposed shape of the above.
  const vertical = verticalStatisticFormulas(matrix)
  if (vertical.size > 0) return vertical
  if (/×/.test(caption)) return crosstabFormulas(matrix)
  return cells
}

/**
 * A correlation column carries r, Sig. and N, and Sig. is the tail of
 * t = r·√((N-2)/(1-r²)) with N-2 df — all three numbers are in the same
 * column, so the printed p value can be recomputed without any other table.
 */
function correlationFormulas(matrix) {
  const cells = new Map()
  const correlationLabel = /^(Pearson|Spearman) Correlation$|^Correlation Coefficient$/i
  // The label column is one column in, because the first column of a block is
  // the variable name; find it rather than assume either layout.
  let labelColumn = -1
  for (const row of matrix) {
    for (let column = 0; column < (row?.length ?? 0); column += 1) {
      if (correlationLabel.test(String(row[column] ?? '').trim())) { labelColumn = column; break }
    }
    if (labelColumn >= 0) break
  }
  if (labelColumn < 0) return cells
  const labelOf = (rowIndex) => String(matrix[rowIndex]?.[labelColumn] ?? '').trim()
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    if (!correlationLabel.test(labelOf(rowIndex))) continue
    // The three rows that belong to this block: r now, Sig. next, N after.
    let sigRow = -1
    let countRow = -1
    for (let index = rowIndex + 1; index < Math.min(rowIndex + 4, matrix.length); index += 1) {
      const next = labelOf(index)
      if (sigRow < 0 && /^Sig\. \(2-tailed\)$/i.test(next)) sigRow = index
      else if (sigRow >= 0 && /^N$/i.test(next)) { countRow = index; break }
    }
    if (sigRow < 0 || countRow < 0) continue
    const columns = matrix[rowIndex]?.length ?? 0
    for (let column = labelColumn + 1; column < columns; column += 1) {
      const r = numericOf(matrix[rowIndex]?.[column])
      const count = numericOf(matrix[countRow]?.[column])
      const sig = numericOf(matrix[sigRow]?.[column])
      // The diagonal prints 1.000 with an empty Sig., and an empty cell is not
      // a number the sheet could reproduce.
      if (r === null || count === null || sig === null) continue
      if (Math.abs(r) >= 1 || count <= 2) continue
      cells.set(`${sigRow}:${column}`, {
        cached: sig,
        style: DECIMAL3_STYLE,
        build: (ref) => `_xlfn.T.DIST.2T(ABS(${ref(rowIndex, column)}*SQRT((${ref(countRow, column)}-2)/(1-${ref(rowIndex, column)}^2))),${ref(countRow, column)}-2)`,
      })
    }
  }
  return cells
}

/**
 * NPAR stacks the statistic, its df and the p value in one column:
 *
 *   ["", "score"]
 *   ["Chi-Square", ".26"]
 *   ["df", "2"]
 *   ["Asymp. Sig.", ".878"]
 *
 * A chi-square or a Z therefore still yields a p value the reader can audit.
 */
function verticalStatisticFormulas(matrix) {
  const cells = new Map()
  const findRow = (pattern) => matrix.findIndex((row) => pattern.test(String(row?.[0] ?? '').trim()))
  const valueColumn = (rowIndex) => {
    const row = matrix[rowIndex] ?? []
    for (let column = row.length - 1; column >= 1; column -= 1) {
      if (numericOf(row[column]) !== null) return column
    }
    return -1
  }
  const chiRow = findRow(/^Chi-square$/i)
  const dfRow = findRow(/^df$/i)
  const zRow = findRow(/^Z$/i)
  const twoTailed = findRow(/^Asymp\. Sig\. \(2-tailed\)$/i)
  const oneTailed = findRow(/^Asymp\. Sig\. \(1-tailed\)$/i)
  const asymp = twoTailed >= 0 ? twoTailed : oneTailed >= 0 ? oneTailed : findRow(/^Asymp\. Sig\.$/i)
  if (asymp < 0) return cells
  const asympColumn = valueColumn(asymp)
  if (asympColumn < 0 || numericOf(matrix[asymp]?.[asympColumn]) === null) return cells
  const cached = numericOf(matrix[asymp][asympColumn])
  if (chiRow >= 0 && dfRow >= 0) {
    const chiColumn = valueColumn(chiRow)
    const dfColumn = valueColumn(dfRow)
    if (chiColumn > 0 && dfColumn > 0 && numericOf(matrix[chiRow]?.[chiColumn]) !== null && numericOf(matrix[dfRow]?.[dfColumn]) !== null) {
      cells.set(`${asymp}:${asympColumn}`, {
        cached,
        style: DECIMAL3_STYLE,
        build: (ref) => `_xlfn.CHISQ.DIST.RT(${ref(chiRow, chiColumn)},${ref(dfRow, dfColumn)})`,
      })
      return cells
    }
  }
  if (zRow >= 0 && twoTailed === asymp) {
    const zColumn = valueColumn(zRow)
    if (zColumn > 0 && numericOf(matrix[zRow]?.[zColumn]) !== null) {
      cells.set(`${asymp}:${asympColumn}`, {
        cached,
        style: DECIMAL3_STYLE,
        build: (ref) => `2*(1-_xlfn.NORM.S.DIST(ABS(${ref(zRow, zColumn)}),TRUE))`,
      })
    }
  }
  return cells
}

/**
 * A test's p value is the tail of its own distribution, so when the statistic
 * and its df sit in the same row the p value is a formula, not a constant.
 * A mean or an SD still cannot be recovered, which is why only these two
 * shapes are recognised.
 */
function statisticFormulas(matrix, context = {}) {
  const cells = new Map()
  for (let headerRow = 0; headerRow < Math.min(4, matrix.length); headerRow += 1) {
    const header = matrix[headerRow]
    const dfColumn = columnOf(header, /^df$/i)
    const tColumn = columnOf(header, /^t$/i)
    // "Sig. (2-tailed)" is the test's own p value; a bare "Sig." beside an F
    // column belongs to Levene, so the specific header wins when both exist.
    const twoTailed = columnOf(header, /^Sig\. \(2-tailed\)$/i)
    const sigColumn = twoTailed >= 0 ? twoTailed : columnOf(header, /^Sig\.$/i)
    // A t test prints t and Sig. in the same row. When its df is missing from
    // that table (REGRESSION keeps it in the ANOVA sheet) the caller supplies
    // a cross-sheet reference; without either, the p value stays a constant.
    if (tColumn >= 0 && sigColumn >= 0) {
      const residual = typeof context.residualDf === 'string' && context.residualDf !== '' ? context.residualDf : null
      for (let index = headerRow + 1; index < matrix.length; index += 1) {
        const line = matrix[index]
        const t = numericOf(line?.[tColumn])
        const sig = numericOf(line?.[sigColumn])
        if (t === null || sig === null) continue
        const df = dfColumn >= 0 ? numericOf(line?.[dfColumn]) : null
        if (df === null && residual === null) continue
        cells.set(`${index}:${sigColumn}`, {
          cached: sig,
          style: DECIMAL3_STYLE,
          build: (ref) => `_xlfn.T.DIST.2T(ABS(${ref(index, tColumn)}),${df !== null ? ref(index, dfColumn) : residual})`,
        })
      }
      if (cells.size > 0) return cells
    }
    if (dfColumn < 0) continue
    // ANOVA prints F, its two df and Sig.; df1 is the model row, df2 the
    // residual row, so the p value is recoverable inside one sheet.
    const fColumn = columnOf(header, /^F$/i)
    const fSigColumn = columnOf(header, /^Sig\.$/i)
    if (fColumn >= 0 && fSigColumn >= 0) {
      const residualRow = matrix.findIndex((row, index) => index > headerRow && /^Residual$/i.test(String(row?.[0] ?? '').trim()))
      if (residualRow >= 0) {
        for (let index = headerRow + 1; index < matrix.length; index += 1) {
          const line = matrix[index]
          const f = numericOf(line?.[fColumn])
          const sig = numericOf(line?.[fSigColumn])
          const df1 = numericOf(line?.[dfColumn])
          const df2 = numericOf(matrix[residualRow]?.[dfColumn])
          if (f === null || sig === null || df1 === null || df2 === null) continue
          cells.set(`${index}:${fSigColumn}`, {
            cached: sig,
            style: DECIMAL3_STYLE,
            build: (ref) => `_xlfn.F.DIST.RT(${ref(index, fColumn)},${ref(index, dfColumn)},${ref(residualRow, dfColumn)})`,
          })
        }
        if (cells.size > 0) return cells
      }
    }
    const named = columnOf(header, /^Chi-square$/i)
    const chiColumn = named >= 0 ? named : columnOf(header, /^Value$/i)
    const asympColumn = columnOf(header, /^Asymp/i)
    if (chiColumn >= 0 && asympColumn >= 0) {
      for (let index = headerRow + 1; index < matrix.length; index += 1) {
        const line = matrix[index]
        const label = String(line?.[0] ?? '').trim()
        const value = numericOf(line?.[chiColumn])
        const df = numericOf(line?.[dfColumn])
        if (value === null || df === null || numericOf(line[asympColumn]) === null) continue
        // CROSSTABS prints the statistic in a "Value" column and names the test
        // in the row label; the p value still comes from a chi-square tail, but
        // exact tests (Fisher) and the case count are not chi-square at all.
        if (named < 0 && !/chi-square|likelihood ratio|continuity|linear-by-linear|mcnemar|kendall/i.test(label)) continue
        if (/fisher|exact|精确/i.test(label)) continue
        if (/^n of valid cases|有效个案数/i.test(label)) continue
        cells.set(`${index}:${asympColumn}`, {
          cached: numericOf(line[asympColumn]),
          style: DECIMAL3_STYLE,
          build: (ref) => `_xlfn.CHISQ.DIST.RT(${ref(index, chiColumn)},${ref(index, dfColumn)})`,
        })
      }
      if (cells.size > 0) return cells
    }
  }
  return cells
}

/**
 * Model Summary keeps R, R Square and Adjusted R Square, and all three follow
 * from the ANOVA sums of squares: R² = 1 - SSres/SStot, R = SQRT(R²), and
 * adj = 1 - (1 - R²)(n - 1)/(n - p - 1), where n - 1 and n - p - 1 are exactly
 * the two df the ANOVA sheet prints, so nothing else has to be known.
 */
function modelSummaryFormulas(matrix, headerRow, anova) {
  const cells = new Map()
  const header = matrix[headerRow]
  const rColumn = columnOf(header, /^R$/i)
  const squareColumn = columnOf(header, /^R Square$/i)
  const adjustedColumn = columnOf(header, /^Adjusted R Square$/i)
  if (rColumn < 0 || squareColumn < 0) return cells
  const has = (value) => typeof value === 'string' && value !== ''
  if (!has(anova.ssResidual) || !has(anova.ssTotal)) return cells
  const square = `(1-${anova.ssResidual}/${anova.ssTotal})`
  for (let index = headerRow + 1; index < matrix.length; index += 1) {
    const line = matrix[index]
    if (numericOf(line?.[squareColumn]) === null) continue
    cells.set(`${index}:${squareColumn}`, {
      cached: numericOf(line[squareColumn]),
      style: DECIMAL3_STYLE,
      build: () => square,
    })
    if (numericOf(line?.[rColumn]) !== null) {
      cells.set(`${index}:${rColumn}`, {
        cached: numericOf(line[rColumn]),
        style: DECIMAL3_STYLE,
        build: () => `SQRT(${square})`,
      })
    }
    if (adjustedColumn >= 0 && numericOf(line?.[adjustedColumn]) !== null && has(anova.dfResidual) && has(anova.dfRegression)) {
      cells.set(`${index}:${adjustedColumn}`, {
        cached: numericOf(line[adjustedColumn]),
        style: DECIMAL3_STYLE,
        build: () => `1-(1-${square})*(${anova.dfResidual}+${anova.dfRegression})/${anova.dfResidual}`,
      })
    }
  }
  return cells
}

function frequencyFormulas(matrix, headerRow) {
  const cells = new Map()
  const header = matrix[headerRow]
  const countColumn = columnOf(header, /^Frequency$|^Count$/i)
  const percentColumn = columnOf(header, /^Percent$/i)
  const validColumn = columnOf(header, /^Valid Percent$/i)
  const cumulativeColumn = columnOf(header, /^Cumulative Percent$/i)
  const totalRow = matrix.findIndex((row, index) => index > headerRow && /^(Total|合计)$/i.test(String(row?.[0] ?? '').trim()))
  if (countColumn < 0 || totalRow < 0) return cells
  const rows = []
  for (let index = headerRow + 1; index < totalRow; index += 1) {
    const count = numericOf(matrix[index]?.[countColumn])
    if (count === null) continue
    rows.push({ index, count })
  }
  if (rows.length === 0) return cells
  const validTotal = rows.reduce((sum, entry) => sum + entry.count, 0)
  const first = rows[0].index
  const last = rows[rows.length - 1].index
  for (const entry of rows) {
    const line = matrix[entry.index]
    if (percentColumn >= 0) {
      cells.set(`${entry.index}:${percentColumn}`, {
        cached: numericOf(line[percentColumn]),
        style: PERCENT_STYLE,
        build: (ref) => `${ref(entry.index, countColumn)}/${ref(totalRow, countColumn)}*100`,
      })
    }
    if (validColumn >= 0 && validTotal > 0) {
      cells.set(`${entry.index}:${validColumn}`, {
        cached: numericOf(line[validColumn]),
        style: PERCENT_STYLE,
        // SUM of the valid counts, not the total: a missing-value row makes the
        // two differ, and editing a count has to move both percentages.
        build: (ref) => `${ref(entry.index, countColumn)}/SUM(${ref(first, countColumn)}:${ref(last, countColumn)})*100`,
      })
    }
    if (cumulativeColumn >= 0 && validColumn >= 0) {
      cells.set(`${entry.index}:${cumulativeColumn}`, {
        cached: numericOf(line[cumulativeColumn]),
        style: PERCENT_STYLE,
        build: (ref) => (entry.index === first
          ? ref(entry.index, validColumn)
          : `SUM(${ref(first, validColumn)}:${ref(entry.index, validColumn)})`),
      })
    }
  }
  cells.set(`${totalRow}:${countColumn}`, {
    cached: numericOf(matrix[totalRow][countColumn]),
    style: 0,
    build: (ref) => `SUM(${ref(first, countColumn)}:${ref(last, countColumn)})`,
  })
  if (percentColumn >= 0 && numericOf(matrix[totalRow][percentColumn]) !== null) {
    cells.set(`${totalRow}:${percentColumn}`, {
      cached: numericOf(matrix[totalRow][percentColumn]),
      style: PERCENT_STYLE,
      build: (ref) => `SUM(${ref(first, percentColumn)}:${ref(last, percentColumn)})`,
    })
  }
  return cells
}

function coefficientFormulas(matrix, headerRow) {
  const cells = new Map()
  const header = matrix[headerRow]
  const next = matrix[headerRow + 1] ?? []
  const bColumn = columnOf(header, /^B$/)
  const seColumn = columnOf(header, /^S\.E\.$/i)
  const waldColumn = columnOf(header, /^Wald$/i)
  const sigColumn = columnOf(header, /^Sig\.$/i)
  const expColumn = columnOf(header, /^Exp\(B\)$/i)
  const lowerColumn = columnOf(header, /^Lower$/i) >= 0 ? columnOf(header, /^Lower$/i) : columnOf(next, /^Lower$/i)
  const upperColumn = columnOf(header, /^Upper$/i) >= 0 ? columnOf(header, /^Upper$/i) : columnOf(next, /^Upper$/i)
  if (bColumn < 0 || seColumn < 0) return cells
  for (let index = headerRow + 1; index < matrix.length; index += 1) {
    const line = matrix[index]
    const b = numericOf(line?.[bColumn])
    const se = numericOf(line?.[seColumn])
    if (b === null || se === null) continue
    if (waldColumn >= 0 && numericOf(line[waldColumn]) !== null) {
      cells.set(`${index}:${waldColumn}`, {
        cached: numericOf(line[waldColumn]),
        style: DECIMAL2_STYLE,
        build: (ref) => `(${ref(index, bColumn)}/${ref(index, seColumn)})^2`,
      })
    }
    if (sigColumn >= 0 && waldColumn >= 0 && numericOf(line[sigColumn]) !== null) {
      cells.set(`${index}:${sigColumn}`, {
        cached: numericOf(line[sigColumn]),
        style: DECIMAL3_STYLE,
        build: (ref) => `_xlfn.CHISQ.DIST.RT(${ref(index, waldColumn)},1)`,
      })
    }
    if (expColumn >= 0 && numericOf(line[expColumn]) !== null) {
      cells.set(`${index}:${expColumn}`, {
        cached: numericOf(line[expColumn]),
        style: 0,
        build: (ref) => `EXP(${ref(index, bColumn)})`,
      })
    }
    if (lowerColumn >= 0 && numericOf(line[lowerColumn]) !== null) {
      cells.set(`${index}:${lowerColumn}`, {
        cached: numericOf(line[lowerColumn]),
        style: 0,
        build: (ref) => `EXP(${ref(index, bColumn)}-1.96*${ref(index, seColumn)})`,
      })
    }
    if (upperColumn >= 0 && numericOf(line[upperColumn]) !== null) {
      cells.set(`${index}:${upperColumn}`, {
        cached: numericOf(line[upperColumn]),
        style: 0,
        build: (ref) => `EXP(${ref(index, bColumn)}+1.96*${ref(index, seColumn)})`,
      })
    }
  }
  return cells
}

/** A crosstab's row and column totals are sums of the counts beside them. */
function crosstabFormulas(matrix) {
  const cells = new Map()
  const totalRow = matrix.findIndex((row, index) => index > 0 && /^(Total|合计)$/i.test(String(row?.[0] ?? '').trim()))
  if (totalRow < 2) return cells
  const countColumn = matrix.slice(0, totalRow).reduce((found, row) => (found >= 0 ? found : columnOf(row, /^Count$/i)), -1)
  if (countColumn < 0) return cells
  const firstData = matrix.findIndex((row, index) => index > 0 && index < totalRow && String(row?.[countColumn] ?? '').trim() === 'Count')
  if (firstData < 0) return cells
  const columns = matrix[totalRow].length
  const last = columns - 1
  for (let index = firstData; index < totalRow; index += 1) {
    if (String(matrix[index]?.[countColumn] ?? '').trim() !== 'Count') continue
    const from = countColumn + 1
    if (numericOf(matrix[index][from]) === null) continue
    cells.set(`${index}:${last}`, {
      cached: numericOf(matrix[index][last]),
      style: 0,
      build: (ref) => `SUM(${ref(index, from)}:${ref(index, last - 1)})`,
    })
  }
  for (let column = countColumn + 1; column < columns; column += 1) {
    const cached = numericOf(matrix[totalRow][column])
    if (cached === null) continue
    cells.set(`${totalRow}:${column}`, {
      cached,
      style: 0,
      build: (ref) => `SUM(${ref(firstData, column)}:${ref(totalRow - 1, column)})`,
    })
  }
  return cells
}

/**
 * One worksheet: optional blank rows reserved for a picture, a merged caption
 * row, the matrix, then the table notes.
 *
 * The reserved rows are what keeps an anchored chart off the cells: Excel
 * floats a drawing over the grid, so the grid itself has to make room.
 */
export function sheetXml(matrix, caption, options = {}) {
  const rows = []
  const data = Array.isArray(matrix) ? matrix : []
  const columns = data.reduce((max, row) => Math.max(max, row.length), 0)
  const spacerRows = Math.max(0, Math.round(options.spacerRows ?? 0))
  for (let index = 1; index <= spacerRows; index += 1) {
    rows.push(`<row r="${index}" ht="15" customHeight="1"/>`)
  }
  const startRow = spacerRows + (caption ? 2 : 1)
  if (caption) rows.push(`<row r="${spacerRows + 1}"><c r="A${spacerRows + 1}" t="inlineStr" s="1"><is><t>${xmlEscape(caption)}</t></is></c></row>`)
  // Formula cells reference other cells of *this* sheet, so the row offset has
  // to be resolved here rather than in formulaMap.
  const formulas = options.formulas instanceof Map ? options.formulas : null
  const refOf = (row, column) => `${columnLetter(column)}${startRow + row}`
  // The raw-data sheet leaves a missing cell out entirely instead of writing an
  // empty string: COUNTA counts "" as filled, so a blank written that way makes
  // "how many values are there" come out higher than the N in the tables.
  const omitEmpty = options.omitEmptyCells === true
  data.forEach((row, rowIndex) => {
    const style = rowIndex === 0 ? 2 : 0
    const cells = row.map((cell, column) => {
      const text = cell === null || cell === undefined ? '' : String(cell)
      const ref = `${columnLetter(column)}${startRow + rowIndex}`
      if (omitEmpty && rowIndex > 0 && text === '') return ''
      const formula = formulas?.get(`${rowIndex}:${column}`)
      if (formula && typeof formula.build === 'function') {
        const cached = Number(formula.cached)
        const formulaStyle = formula.style ?? style
        const body = `<f>${xmlEscape(formula.build(refOf))}</f>${Number.isFinite(cached) ? `<v>${cached}</v>` : ''}`
        return `<c r="${ref}" s="${formulaStyle}">${body}</c>`
      }
      // Numbers get numeric cells so Excel can sum and chart them afterwards.
      // PSPP prints probabilities as `.50` and `-.23` (no leading zero); the
      // old pattern rejected those, so a whole p column arrived as text that
      // Excel could not sort or average.
      if (isNumericText(text)) {
        return `<c r="${ref}" s="${style}"><v>${text.trim()}</v></c>`
      }
      return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
    })
    rows.push(`<row r="${startRow + rowIndex}">${cells.join('')}</row>`)
  })
  const widths = []
  for (let column = 0; column < Math.max(columns, 1); column += 1) {
    const longest = data.reduce((max, row) => Math.max(max, String(row[column] ?? '').length), 8)
    widths.push(`<col min="${column + 1}" max="${column + 1}" width="${Math.min(60, Math.max(9, longest + 2))}" customWidth="1"/>`)
  }
  const notes = (Array.isArray(options.notes) ? options.notes : [])
    .map((note) => String(note ?? '').trim())
    .filter(Boolean)
  let noteRow = startRow + data.length
  const merges = []
  if (caption && columns > 0) merges.push(`A1:${columnLetter(columns - 1)}1`)
  for (const note of notes) {
    const ref = `A${noteRow}`
    rows.push(`<row r="${noteRow}"><c r="${ref}" t="inlineStr" s="3"><is><t xml:space="preserve">${xmlEscape(`注：${note}`)}</t></is></c></row>`)
    if (columns > 1) merges.push(`A${noteRow}:${columnLetter(columns - 1)}${noteRow}`)
    noteRow += 1
  }
  const merge = merges.length > 0
    ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : ''
  const drawing = options.drawingId ? `<drawing r:id="rId1"/>` : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols>${widths.join('')}</cols><sheetData>${rows.join('')}</sheetData>${merge}${drawing}</worksheet>`
}

/**
 * OneCellAnchor keeps a chart pinned to a cell instead of letting Excel float it
 * wherever the last scroll position was: the from-cell is the table's first
 * cell, so the picture can never drift away from its numbers.
 */
function drawingXml(anchors) {
  const body = anchors.map((anchor, index) => {
    const cx = anchor.cx ?? 5_486_400
    const cy = anchor.cy ?? Math.round(cx / 1.55)
    return '<xdr:oneCellAnchor>'
      + `<xdr:from><xdr:col>${anchor.col ?? 0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.row ?? 0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="${cx}" cy="${cy}"/>`
      + '<xdr:pic><xdr:nvPicPr>'
      + `<xdr:cNvPr id="${index + 2}" name="chart${index + 1}.png"/><xdr:cNvPicPr/>`
      + '</xdr:nvPicPr>'
      + `<xdr:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
      + '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${body}</xdr:wsDr>`
}

/**
 * Build a .xlsx with one sheet per table.
 * @param {{ items: Array<object> }} options
 * @returns {Buffer}
 */
export function buildXlsx({ items = [], images = [], formulas = true, data = null, sources = [] }) {
  const tables = items.filter((item) => item.kind === 'table' && Array.isArray(item.table?.matrix))
  const keyOf = (url) => String(url ?? '').replace(/([?&])v=[^&]*/g, '$1').replace(/[?&]$/, '')
  const byUrl = new Map(images.map((image) => [keyOf(image.url), image]))
  // Same decision as the Word writer (pairCharts), and the same extent helper,
  // so one picture has one size in both documents.
  const { paired, standalone } = pairCharts(items)
  const used = new Set()
  // Layout first: a cross-sheet formula needs the other sheet's name and the
  // row its value landed on, and both depend on the reserved picture rows.
  const layouts = tables.map((item, index) => {
    const charts = (paired.get(item) ?? [])
      .map((entry) => byUrl.get(keyOf(entry.url ?? entry.artifactUrl)))
      .filter((image) => image?.bytes)
    const first = charts[0] ?? null
    const size = first ? imageExtent(first.width, first.height) : null
    const spacerRows = size ? Math.ceil(size.cy / ROW_EMU) + 1 : 0
    const caption = (item.table?.caption ?? item.title ?? '').trim()
    const startRow = spacerRows + (caption ? 2 : 1)
    return {
      item,
      charts,
      first,
      size,
      caption,
      spacerRows,
      startRow,
      name: sheetName(item.table?.caption ?? item.title, index, used),
    }
  })
  // Residual df of an ANOVA sheet, addressed from any other sheet: REGRESSION
  // keeps df in ANOVA and the t/Sig. pair in Coefficients.
  const residualDf = new Map()
  const anovaRefs = new Map()
  // Tables are keyed by subject *and* run: two runs of the same model both write
  // "ANOVA (score)", and matching on the subject alone would point the second
  // run's Coefficients at the first run's ANOVA sheet.
  const subjectKey = (layout) => `${subjectOf(layout.caption)}\u0000${layout.item.runId ?? ''}`
  for (const layout of layouts) {
    const matrix = layout.item.table.matrix
    const headerRow = matrix.findIndex((row) => columnOf(row, /^df$/i) >= 0)
    if (headerRow < 0 || headerRow > 3) continue
    const dfColumn = columnOf(matrix[headerRow], /^df$/i)
    const residualRow = matrix.findIndex((row, index) => index > headerRow && /^Residual$/i.test(String(row?.[0] ?? '').trim()))
    if (residualRow < 0) continue
    if (numericOf(matrix[residualRow]?.[dfColumn]) === null) continue
    const prefix = escapeSheetName(layout.name)
    const at = (row, column) => `${prefix}!${columnLetter(column)}${layout.startRow + row}`
    residualDf.set(subjectKey(layout), at(residualRow, dfColumn))
    // The ANOVA sheet is also where the sums of squares live, which is what
    // makes R² and its adjusted form recoverable from another sheet.
    const ssColumn = columnOf(matrix[headerRow], /^Sum of Squares$/i)
    const totalRow = matrix.findIndex((row, index) => index > headerRow && /^Total$/i.test(String(row?.[0] ?? '').trim()))
    if (ssColumn < 0 || totalRow < 0) continue
    if (numericOf(matrix[totalRow]?.[ssColumn]) === null) continue
    if (numericOf(matrix[residualRow]?.[ssColumn]) === null) continue
    anovaRefs.set(subjectKey(layout), {
      ssResidual: at(residualRow, ssColumn),
      ssTotal: at(totalRow, ssColumn),
      dfResidual: at(residualRow, dfColumn),
      dfRegression: '',
    })
  }
  // The regression row's df (p) is only needed by Adjusted R Square, so it is
  // filled in a second pass over the same table rather than recomputed.
  for (const layout of layouts) {
    const refs = anovaRefs.get(subjectKey(layout))
    if (!refs) continue
    const matrix = layout.item.table.matrix
    const headerRow = matrix.findIndex((row) => columnOf(row, /^df$/i) >= 0)
    const dfColumn = columnOf(matrix[headerRow], /^df$/i)
    const modelRow = matrix.findIndex((row, index) => index > headerRow && /^Regression$/i.test(String(row?.[0] ?? '').trim()))
    if (modelRow < 0) continue
    refs.dfRegression = `${escapeSheetName(layout.name)}!${columnLetter(dfColumn)}${layout.startRow + modelRow}`
  }
  const sheets = layouts.map((layout) => ({
    name: layout.name,
    xml: sheetXml(layout.item.table.matrix, layout.caption, {
      notes: layout.item.notes,
      spacerRows: layout.spacerRows,
      drawingId: layout.first ? 1 : null,
      // Optional: an export that must be a dead picture of the printed table
      // can turn the formulas off (`formulas: false`).
      formulas: formulas
        ? formulaMap(layout.item.table.matrix, layout.caption, {
          residualDf: residualDf.get(subjectKey(layout)) ?? null,
          anova: anovaRefs.get(subjectKey(layout)) ?? null,
        })
        : null,
    }),
    anchors: layout.first ? [{ cx: layout.size.cx, cy: layout.size.cy, row: 0, col: 0, bytes: layout.first.bytes }] : [],
    extra: layout.charts.slice(1),
  }))
  const leftover = items
    .filter((item) => standalone.has(item))
    .map((item) => byUrl.get(keyOf(item.url ?? item.artifactUrl)))
    .filter((image) => image?.bytes)
    .concat(sheets.flatMap((sheet) => sheet.extra))
  if (leftover.length > 0) {
    let row = 0
    const anchors = leftover.map((image) => {
      const size = imageExtent(image.width, image.height)
      const anchor = { cx: size.cx, cy: size.cy, row, col: 0, bytes: image.bytes }
      row += Math.ceil(size.cy / ROW_EMU) + 1
      return anchor
    })
    sheets.push({
      name: sheetName('图表', sheets.length, used),
      xml: sheetXml([['（图表见上方）']], '', { spacerRows: row, drawingId: 1 }),
      anchors,
    })
  }
  // Optional raw-data sheet: a hidden copy of the cases so a reader can rebuild
  // the quantities that are not printed in any table (means, SDs) with ordinary
  // spreadsheet functions, instead of trusting the numbers blindly.
  if (data && Array.isArray(data.rows) && data.rows.length > 0) {
    const names = (data.variables ?? []).map((variable) => String(variable.name ?? ''))
    const header = names.length > 0 ? names : data.rows[0].map((_, index) => `V${index + 1}`)
    const rows = [header, ...data.rows.map((row) => header.map((_, index) => row[index] ?? ''))]
    sheets.push({
      name: sheetName('数据', sheets.length, used),
      xml: sheetXml(rows, '', { omitEmptyCells: true }),
      hidden: true,
    })
  }
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', xml: sheetXml([['（没有表格输出）']], '') })

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${index + 1}"/>`)
    .join('')}</sheets></workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.0&quot;%&quot;"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="10"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`

  const withCharts = sheets.filter((sheet) => (sheet.anchors ?? []).length > 0)
  // Excel has no visible footer on a sheet, so the sources travel in
  // docProps/core.xml (文件 → 信息 → 属性, and the PDF export of the workbook
  // keeps them) instead of being appended as an extra row.
  const sourceLines = describeSources(sources)
  const files = {
    '[Content_Types].xml': XLSX_CONTENT_TYPE.replace('{sheets}', sheets
      .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + (withCharts.length > 0
        ? '<Default Extension="png" ContentType="image/png"/>'
          + withCharts.map((_, index) => `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')
        : '')
      + CORE_PROPS_TYPE),
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>${CORE_PROPS_REL}</Relationships>`,
    'docProps/core.xml': corePropsXml('统计输出', sourceLines),
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': workbookRels,
    'xl/styles.xml': styles,
  }
  sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml })
  withCharts.forEach((sheet, drawingIndex) => {
    const number = drawingIndex + 1
    const sheetIndex = sheets.indexOf(sheet) + 1
    files[`xl/drawings/drawing${number}.xml`] = drawingXml(sheet.anchors)
    files[`xl/drawings/_rels/drawing${number}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheet.anchors
      .map((anchor, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${number}-${index + 1}.png"/>`)
      .join('')}</Relationships>`
    files[`xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${number}.xml"/></Relationships>`
    sheet.anchors.forEach((anchor, index) => {
      files[`xl/media/image${number}-${index + 1}.png`] = Buffer.isBuffer(anchor.bytes) ? anchor.bytes : Buffer.from(anchor.bytes)
    })
  })
  return buildZip(files)
}

