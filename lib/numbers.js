// 把一张表的矩阵转成「能直接算的数值」。
//
// 表格是给人看的：`5.500`、`<0.001`、`1,234`、`—`、`+Infinit` 这些写法混在一起，
// agent 拿到字符串矩阵要自己再写一遍解析。表里的空字符串、破折号、区间记号
// 都不是数字，这里一律给 null，并把原文留在 `raw` 里 —— 静默写成 0 会让
// 后续计算悄悄算错。

/** 是不是一个「占位符」而不是数字（空、破折号、点、斜杠）。 */
const BLANK_CELLS = new Set(['', '—', '–', '-', '.', '..', '/', 'N/A', 'n/a'])

/**
 * 解析一个单元格：能确定是数字就回 number，否则回 null。
 * 只认十进制（可带正负号、千分位、小数点），不认中文数字与日期。
 */
export function parseCell(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (BLANK_CELLS.has(text)) return null
  // 千分位：1,234.5 —— 只去掉逗号，别的分隔符（如小数点用逗号的地区）不动。
  const plain = text.replace(/,/g, '')
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(plain)) return null
  const parsed = Number(plain)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 一张表 → `{columns, rows, raw, numeric}`。
 * - `columns`：第一行（表头），原样保留（PSPP 的表头常有多行，第二行起算数据）。
 * - `rows`：数据行，每格是 number 或原字符串 —— 混在一行里也能看出哪格不是数。
 * - `numeric`：所有数据格都能解析成数字时为 true，agent 可以整块丢进计算。
 */
export function toNumbers(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return { columns: [], rows: [], numeric: false, note: '这张表是空的' }
  }
  const [head, ...body] = matrix
  const columns = head.map((cell) => String(cell ?? '').trim())
  const rows = body.map((row) => row.map((cell) => {
    const parsed = parseCell(cell)
    if (parsed !== null) return parsed
    // 空、「—」、「N/A」这类占位符给 null（不是 0，也不是空字符串），
    // 别的文本（组名、变量名、`<0.001`）原样留着。
    const text = String(cell ?? '').trim()
    return BLANK_CELLS.has(text) ? null : text
  }))
  const cells = rows.flat()
  const numeric = cells.length > 0 && cells.every((cell) => typeof cell === 'number')
  return { columns, rows, numeric }
}

/**
 * 一组表 → 一次回给 agent 的结构。
 * `tables` 里每张表带标题与来源（哪次运行、哪个数据集），因为 agent 可能在十几个
 * 回合之后才引用其中一张。
 */
export function numbersOf(items) {
  return (items ?? [])
    .filter((item) => item.kind === 'table' && item.table?.matrix)
    .map((item) => ({
      title: item.title || item.table.caption || '表格',
      ...(item.plugin === true ? { pluginComputed: true } : {}),
      ...(item.provenance?.runId !== undefined && item.provenance?.runId !== null
        ? { runId: item.provenance.runId }
        : {}),
      ...toNumbers(item.table.matrix),
      ...(item.notes?.length ? { notes: [...item.notes] } : {}),
    }))
}
