import { explainDiagnostic } from './messages.js'
/**
 * PSPP's HTML output driver writes one flat document: every table is a
 * `<table>` with an optional `<caption>`, cells carry colspan/rowspan, and
 * charts are appended as `<img src="name-N.png">`. This module turns that
 * document into ordered output items the UI can render and the agent can
 * read as JSON, plus diagnostics parsed from the engine's stderr.
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  // HTML5 named entities a browser decodes and an allow-list has to see:
  // `javascript&colon;` and `java&Tab;script:` are the scheme by the time the
  // href reaches the DOM.
  colon: ':',
  semi: ';',
  comma: ',',
  period: '.',
  sol: '/',
  bsol: '\\',
  quest: '?',
  num: '#',
  percnt: '%',
  plus: '+',
  equals: '=',
  lpar: '(',
  rpar: ')',
  Tab: '\t',
  NewLine: '\n',
  excl: '!',
  ast: '*',
  commat: '@',
}

export function decodeEntities(text) {
  // A numeric reference does not need its semicolon in an attribute value:
  // Chromium decodes `javascript&#58alert(1)` and `javascript&#58 alert(1)` to
  // the same scheme, and requiring `;` here left the colon encoded (so the URL
  // looked relative and the allow-list kept it).
  return String(text).replaceAll(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+)(;?)/g, (match, name, semi) => {
    if (!name.startsWith('#') && semi !== ';') return match
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name] ?? match
  })
}

function stripTags(html) {
  return decodeEntities(String(html).replaceAll(/<\/?(?:b|i|u|em|strong|span|br)\b[^>]*>/gi, ' '))
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function parseAttributes(text) {
  const attributes = {}
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '')
  }
  return attributes
}

/** Remove inline styling and anything executable, keep the table skeleton. */
/**
 * `javascript&#58;` and `javas&#99;ript:` parse to the same scheme in a
 * browser, so the scheme check has to run on the decoded text.
 */
/**
 * Keep only URLs a table can legitimately hold: a fragment, a relative path, or
 * http/https/mailto/tel. A deny-list of `javascript:`/`data:` cannot win — the
 * entity spellings (`&colon;`, `&Tab;`, `&NewLine;`) and control characters
 * inside the scheme are unbounded, while the set of schemes we actually want is
 * tiny.
 */
function isUnsafeUrl(value) {
  const raw = decodeEntities(String(value).replace(/^["']|["']$/g, ''))
    .replaceAll(/[\s\u0000-\u001f\u007f]/g, '')
    .toLowerCase()
  if (/^(?:https?:|mailto:|tel:)/.test(raw)) return false
  if (/^(?:#|\/|\?|\.{1,2}\/)/.test(raw)) return false
  // Anything without a colon before the first slash is a relative path.
  return raw.includes(':')
}

export function sanitizeTableHtml(tableHtml) {
  return String(tableHtml)
    // Tags whose content can execute or replace the document: drop the whole
    // element, then any leftover opening/closing tag. Only quoted `on*`
    // handlers used to be removed, so `<svg onload=alert(1)>` survived into
    // dangerouslySetInnerHTML.
    .replaceAll(/<(script|iframe|object|embed|svg|math|style|link|meta|base|form|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replaceAll(/<\/?(?:script|iframe|object|embed|svg|math|style|link|meta|base|form|template)\b[^>]*>/gi, '')
    .replaceAll(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replaceAll(/[\s/]+on[a-z]{3,}\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // javascript:/vbscript:/data: URLs in href/src are script in a click.
    // The entity-encoded spellings decode to the same scheme in a browser,
    // so the check runs on the decoded value.
    .replaceAll(/\s+(?:href|src|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (match, value) => (isUnsafeUrl(value) ? '' : match))
    .replaceAll(/<img\b[^>]*>/gi, '')
    .replaceAll(/\s+(?:width|height|border|bgcolor|valign|align)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim()
}

function parseTable(tableHtml) {
  const captionMatch = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(tableHtml)
  const caption = captionMatch ? stripTags(captionMatch[1]) : ''
  const body = tableHtml.replace(/<caption\b[^>]*>[\s\S]*?<\/caption>/i, '')

  const rows = []
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowPattern.exec(body)) !== null) {
    const cells = []
    const cellPattern = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi
    let cellMatch
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const attributes = parseAttributes(cellMatch[2])
      cells.push({
        tag: cellMatch[1].toLowerCase(),
        text: stripTags(cellMatch[3]),
        colspan: Math.max(1, Number.parseInt(attributes.colspan ?? '1', 10) || 1),
        rowspan: Math.max(1, Number.parseInt(attributes.rowspan ?? '1', 10) || 1),
      })
    }
    if (cells.length > 0) rows.push(cells)
  }

  // Expand spans into a rectangular matrix so downstream consumers (agent
  // tools, CSV export, copy-to-clipboard) do not have to understand spans.
  const matrix = []
  const occupied = new Map()
  rows.forEach((cells, rowIndex) => {
    matrix[rowIndex] = matrix[rowIndex] ?? []
    let column = 0
    for (const cell of cells) {
      while (occupied.get(`${rowIndex}:${column}`)) column += 1
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          const r = rowIndex + dr
          const c = column + dc
          matrix[r] = matrix[r] ?? []
          matrix[r][c] = dr === 0 && dc === 0 ? cell.text : ''
          occupied.set(`${r}:${c}`, true)
        }
      }
      column += cell.colspan
    }
  })

  const normalized = matrix.map((row) => {
    const filled = []
    for (let index = 0; index < row.length; index += 1) filled[index] = row[index] ?? ''
    return filled
  })

  return {
    caption,
    matrix: normalized,
    html: sanitizeTableHtml(tableHtml),
    rowCount: normalized.length,
    columnCount: normalized.reduce((max, row) => Math.max(max, row.length), 0),
  }
}

/**
 * Parse the whole HTML run output into items in document order.
 * Returns `{ items }`, each item being a table, image or heading.
 */
export function parseHtmlOutput(html) {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
  const items = []
  const pattern = /<table\b[^>]*>[\s\S]*?<\/table>|<img\b[^>]*>|<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let match
  let ordinal = 0
  while ((match = pattern.exec(body)) !== null) {
    const token = match[0]
    if (/^<table/i.test(token)) {
      const table = parseTable(token)
      items.push({
        id: `item-${ordinal}`,
        kind: 'table',
        title: table.caption,
        table,
      })
      ordinal += 1
      continue
    }
    if (/^<img/i.test(token)) {
      const attributes = parseAttributes(token.slice(4, -1))
      items.push({
        id: `item-${ordinal}`,
        kind: 'image',
        title: attributes.alt ?? '',
        src: attributes.src ?? '',
        alt: attributes.alt ?? '',
      })
      ordinal += 1
      continue
    }
    const text = stripTags(match[3] ?? '')
    if (text !== '') {
      items.push({ id: `item-${ordinal}`, kind: 'heading', level: Number(match[2]), title: text, text })
      ordinal += 1
    }
  }
  return items
}

const SEVERITY = [
  { pattern: /错误|error/i, severity: 'error' },
  { pattern: /警告|warning/i, severity: 'warning' },
  { pattern: /注意|note/i, severity: 'note' },
]

/**
 * Parse PSPP's stderr diagnostics:
 *   `run.sps:12.5-12.9: 错误: message`
 *   `run.sps:12: 警告: message`
 * Also returns free-form lines (engine crashes) as `log`.
 */
export function parseDiagnostics(stderr) {
  const diagnostics = []
  const log = []
  for (const rawLine of String(stderr).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = /^(?:.*?):(\d+)(?:\.(\d+)(?:-(\d+)\.(\d+))?)?:\s*(.*)$/.exec(line)
    if (match) {
      const rest = match[5] ?? ''
      const severity = SEVERITY.find((entry) => entry.pattern.test(rest))?.severity ?? 'info'
      const message = rest.replace(/^(错误|警告|注意|error|warning|note)\s*[:：]\s*/i, '')
      diagnostics.push({
        line: Number(match[1]),
        column: match[2] ? Number(match[2]) : null,
        endLine: match[3] ? Number(match[3]) : null,
        endColumn: match[4] ? Number(match[4]) : null,
        severity,
        message,
        // The engine's own sentence stays as the record; the hint says what to
        // do about it in Chinese, because PSPP's answers assume the reader
        // already knows the command.
        hint: explainDiagnostic({ message }).hint ?? null,
        raw: line,
      })
      continue
    }
    log.push(line)
  }
  return { diagnostics, log }
}
