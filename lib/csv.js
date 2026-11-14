/** Minimal RFC-4180 style CSV parsing and serialization. */

export function parseCsv(text, options = {}) {
  const separator = options.delimiter ?? ','
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let index = 0

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (index < text.length) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === separator) {
      pushField()
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      pushRow()
      index += 1
      continue
    }
    field += char
    index += 1
  }

  if (field !== '' || row.length > 0) pushRow()
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop()
  }
  return rows
}

export function stringifyCsv(rows) {
  const escape = (value) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  // An empty matrix must serialise to an empty file. Emitting a lone newline
  // makes the engine read it as one blank record, so importing a header-only
  // CSV produced a phantom case with every value missing.
  if (rows.length === 0) return ''
  return rows.map((row) => row.map(escape).join(',')).join('\n') + '\n'
}
