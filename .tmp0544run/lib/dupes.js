/**
 * Duplicate cases, computed here because PSPP has no such command.
 *
 * SPSS's "Identify Duplicate Cases" is a data step, not a statistical
 * procedure: it groups rows by the key variables and marks every row with its
 * position inside the group. The plugin does the same on the matrix it already
 * holds, so the result is a table plus, on request, two indicator variables
 * that "Select Cases" can filter on.
 */
import { isUserMissing } from './missing.js'

function keyOf(row, columns) {
  return columns.map((column) => {
    const value = row[column.at]
    if (value === null || value === undefined || value === '') return '·'
    return String(value)
  }).join('\u0001')
}

export function duplicateReport(dataset, options = {}) {
  const requested = Array.isArray(options.variables) ? options.variables.map(String) : []
  if (!dataset || dataset.variables.length === 0) return null
  const columns = []
  for (const name of requested) {
    const at = dataset.variables.findIndex((variable) => variable.name === name)
    if (at < 0) continue
    columns.push({ at, name, label: dataset.variables[at].label || name })
  }
  if (columns.length === 0) {
    for (const [index, variable] of dataset.variables.entries()) {
      columns.push({ at: index, name: variable.name, label: variable.label || variable.name })
    }
  }
  const groups = new Map()
  const sequence = []
  const lastOfGroup = []
  for (const [rowIndex, row] of dataset.rows.entries()) {
    // A row whose key holds a declared missing code cannot be matched with
    // confidence, so it counts as its own key rather than a group of one that
    // looks like real duplication.
    const missingKey = columns.some((column) => isUserMissing(dataset.variables[column.at], row[column.at]))
    const key = missingKey ? `\u0000missing-${rowIndex}` : keyOf(row, columns)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(rowIndex)
  }
  const duplicateGroups = [...groups.values()].filter((rows) => rows.length > 1)
  const duplicateRows = duplicateGroups.reduce((total, rows) => total + rows.length, 0)
  // Sequence inside the group and "is this the last occurrence", the two
  // indicators SPSS's dialog offers.
  for (const rows of groups.values()) {
    rows.forEach((rowIndex, position) => {
      sequence[rowIndex] = rows.length > 1 ? position + 1 : 0
      lastOfGroup[rowIndex] = rows.length > 1 && position === rows.length - 1 ? 1 : 0
    })
  }
  const header = ['组', ...columns.map((column) => column.label), '个案号', '组内序号', '是否末条']
  const matrix = [header]
  const shown = duplicateGroups.slice(0, 50)
  for (const [groupIndex, rows] of shown.entries()) {
    rows.forEach((rowIndex, position) => {
      matrix.push([
        String(groupIndex + 1),
        ...columns.map((column) => {
          const value = dataset.rows[rowIndex][column.at]
          if (value === null || value === undefined || value === '') return '·'
          return String(value)
        }),
        String(rowIndex + 1),
        String(position + 1),
        position === rows.length - 1 ? '是' : '',
      ])
    })
  }
  const notes = [
    `按键变量 ${columns.map((column) => column.label).join('、')} 分组：共 ${dataset.rows.length} 个个案，其中 ${duplicateRows} 个落在 ${duplicateGroups.length} 组重复里`,
  ]
  if (duplicateGroups.length === 0) notes.push('没有发现重复个案：每组的键值都唯一')
  if (duplicateGroups.length > shown.length) {
    notes.push(`表里只列出前 ${shown.length} 组（共 ${duplicateGroups.length} 组）；要看全部，把键变量减少一些再来一次`)
  }
  notes.push('判定口径与其它表一致：声明为缺失的码不参与比对，含缺失的个案各自单列，不会被当成重复')
  return {
    title: '标识重复个案（插件计算）',
    matrix,
    notes,
    groups: duplicateGroups.length,
    duplicates: duplicateRows,
    sequence,
    lastOfGroup,
  }
}
