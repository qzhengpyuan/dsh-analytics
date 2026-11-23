/**
 * Missing-value analysis (SPSS: Analyze → Multiple Imputation → Missing Value
 * Analysis).
 *
 * PSPP 2.1.3 answers `MVA` with "MVA is not yet implemented", so this table is
 * computed from the dataset the plugin already holds. Two tables carry the
 * weight in practice: per-variable counts, and the set of missing-data patterns
 * with how many cases follow each — that is what tells you whether imputation
 * can be trusted, since a handful of dominant patterns means the missingness is
 * structured rather than scattered.
 */
import { isUserMissing } from './missing.js'

/**
 * A case is missing on a variable when the cell is blank or when it holds one of
 * the codes `MISSING VALUES` declared. Both have to count, or the analysis
 * contradicts the means printed everywhere else in the plugin.
 */
export function isMissing(variable, value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (variable?.type !== 'string' && Number.isNaN(Number(value))) return true
  return isUserMissing(variable, value)
}

function numeric(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function sd(values) {
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '.'
  const fixed = value.toFixed(digits)
  if (!fixed.includes('.')) return fixed
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

/** One row per variable: N, mean, SD, missing count and percentage. */
export function univariateTable(dataset, names) {
  const variables = (dataset?.variables ?? []).filter((variable) => names.includes(variable.name))
  const rows = dataset?.rows ?? []
  const matrix = [[
    '变量', 'N', '平均值', '标准差', '最小值', '最大值', '缺失', '缺失 %',
  ]]
  const notes = []
  for (const variable of variables) {
    const present = []
    let missing = 0
    for (const row of rows) {
      const value = row[variable.position - 1]
      if (isMissing(variable, value)) { missing += 1; continue }
      present.push(value)
    }
    const total = present.length + missing
    if (variable.type === 'string') {
      matrix.push([
        variable.name, String(present.length), '.', '.', '.', '.',
        String(missing), total === 0 ? '.' : `${((missing / total) * 100).toFixed(1)}%`,
      ])
      notes.push(`${variable.name} 是字符串变量，统计量留给数值变量`)
      continue
    }
    const values = present.map(numeric).filter((value) => value !== null)
    if (values.length !== present.length) {
      notes.push(`${variable.name} 有 ${present.length - values.length} 个格子写了非数字，没有计入统计量`)
    }
    const mean = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
    matrix.push([
      variable.name,
      String(values.length),
      formatNumber(mean),
      formatNumber(sd(values)),
      values.length === 0 ? '.' : formatNumber(Math.min(...values)),
      values.length === 0 ? '.' : formatNumber(Math.max(...values)),
      String(missing),
      total === 0 ? '.' : `${((missing / total) * 100).toFixed(1)}%`,
    ])
  }
  return {
    title: '单变量统计量',
    matrix,
    notes: notes.length > 0 ? notes : [],
  }
}

/**
 * The distinct missing-data patterns, most common first.
 *
 * SPSS marks a present value `X` for a numeric variable, `S` for a string, and
 * `.` for a missing one; the count is cases, not cells. A complete row is kept
 * as its own pattern because "how many cases had nothing missing" is the first
 * number anyone reads.
 */
export function patternTable(dataset, names) {
  const variables = (dataset?.variables ?? []).filter((variable) => names.includes(variable.name))
  const rows = dataset?.rows ?? []
  const counts = new Map()
  let usable = 0
  for (const row of rows) {
    let complete = true
    const pattern = variables.map((variable) => {
      const value = row[variable.position - 1]
      if (isMissing(variable, value)) { complete = false; return '.' }
      return variable.type === 'string' ? 'S' : 'X'
    }).join(' ')
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1)
    if (complete) usable += 1
  }
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1])
  const total = rows.length
  const matrix = [[...variables.map((variable) => `缺失模式（${variable.name}）`), '个案数', '百分比', '累计百分比']]
  let running = 0
  for (const [pattern, count] of ordered) {
    running += count
    matrix.push([
      ...pattern.split(' '),
      String(count),
      total === 0 ? '.' : `${((count / total) * 100).toFixed(1)}%`,
      total === 0 ? '.' : `${((running / total) * 100).toFixed(1)}%`,
    ])
  }
  const notes = []
  notes.push(`X = 有值（数值变量），S = 有值（字符串变量），. = 缺失`)
  if (total > 0) {
    notes.push(`完全没有缺失的个案 ${usable} 个，占 ${((usable / total) * 100).toFixed(1)}%`)
    if (ordered.length > 1) {
      const top = ordered[0]
      notes.push(`最常见的缺失模式有 ${top[1]} 个（${((top[1] / total) * 100).toFixed(1)}%）：缺失集合是集中的，插补前先看这些变量是不是同一批人`)
    }
  }
  return { title: '缺失模式', matrix, notes }
}

/**
 * Everything MVA prints for the requested variables.
 *
 * `options.univariate` / `options.patterns` default to true: both tables are on
 * in SPSS, and turning them off is only useful when the console is narrow.
 */
export function mvaTables(dataset, names, options = {}) {
  const wanted = Array.isArray(names) ? names.filter(Boolean) : []
  const known = new Set((dataset?.variables ?? []).map((variable) => variable.name))
  const missingNames = wanted.filter((name) => !known.has(name))
  if (missingNames.length > 0) {
    throw new Error(`没有这些变量：${missingNames.join('、')}`)
  }
  if (wanted.length === 0) throw new Error('missing analysis needs at least one variable')
  const tables = []
  if (options.univariate !== false) tables.push(univariateTable(dataset, wanted))
  if (options.patterns !== false) tables.push(patternTable(dataset, wanted))
  return tables
}

/**
 * Replace missing values in place (SPSS: Transform → Replace Missing Values).
 *
 * PSPP has no `RMV`. All five estimators SPSS offers are computed from the
 * variable's own values, in case order, so nothing is invented:
 *   - `mean`: the series mean;
 *   - `linear`: linear interpolation between the neighbouring present values,
 *     with the ends holding the first/last present value (SPSS pads the ends the
 *     same way rather than extrapolating);
 *   - `nearby`: copy the closest present value, looking backwards first;
 *   - `nearbyMean`: mean of the nearest `span` present values on each side;
 *   - `nearbyMedian`: their median;
 *   - `trend`: least-squares line of the present values over case order,
 *     evaluated at the blank's own position.
 *
 * Returns one change per filled cell so the caller can push a single history
 * entry and report exactly what moved.
 */
export const REPLACE_METHODS = ['mean', 'linear', 'nearby', 'nearbyMean', 'nearbyMedian', 'trend']

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function replaceMissing(dataset, names, method = 'mean', options = {}) {
  const variables = (dataset?.variables ?? []).filter((variable) => names.includes(variable.name))
  if (variables.length === 0) throw new Error('没有要替换缺失值的变量')
  const rows = dataset?.rows ?? []
  const wanted = REPLACE_METHODS.includes(method) ? method : null
  if (!wanted) {
    throw new Error(`不认识的替换方法：${method}（只有 ${REPLACE_METHODS.join('、')}）`)
  }
  const span = Math.max(1, Math.min(100, Math.trunc(Number(options.span ?? 2)) || 2))
  const changes = []
  for (const variable of variables) {
    if (variable.type === 'string') {
      throw new Error(`${variable.name} 是字符串变量：替换缺失值只处理数值变量`)
    }
    const column = variable.position - 1
    const present = []
    for (let index = 0; index < rows.length; index += 1) {
      const value = rows[index][column]
      if (!isMissing(variable, value)) present.push({ index, value: numeric(value) })
    }
    if (present.length === 0) {
      throw new Error(`${variable.name} 整列都是缺失值，没有可以用来替换的数`)
    }
    const filled = []
    if (wanted === 'mean') {
      const mean = present.reduce((sum, entry) => sum + entry.value, 0) / present.length
      for (let index = 0; index < rows.length; index += 1) {
        if (isMissing(variable, rows[index][column])) filled.push({ index, value: mean })
      }
    } else if (wanted === 'linear') {
      const first = present[0]
      const last = present[present.length - 1]
      let cursor = 0
      for (let index = 0; index < rows.length; index += 1) {
        if (!isMissing(variable, rows[index][column])) continue
        while (cursor + 1 < present.length && present[cursor + 1].index < index) cursor += 1
        const before = present[cursor]
        const after = present[cursor + 1]
        if (index < first.index) { filled.push({ index, value: first.value }); continue }
        if (!after) { filled.push({ index, value: last.value }); continue }
        const gap = after.index - before.index
        const step = gap === 0 ? 0 : (after.value - before.value) / gap
        filled.push({ index, value: before.value + step * (index - before.index) })
      }
    } else if (wanted === 'nearby') {
      const set = new Set(present.map((entry) => entry.index))
      for (let index = 0; index < rows.length; index += 1) {
        if (set.has(index) || !isMissing(variable, rows[index][column])) continue
        let back = index - 1
        while (back >= 0 && !set.has(back)) back -= 1
        if (back >= 0) { filled.push({ index, value: rows[back][column] }); continue }
        let forward = index + 1
        while (forward < rows.length && !set.has(forward)) forward += 1
        if (forward < rows.length) filled.push({ index, value: rows[forward][column] })
      }
    } else if (wanted === 'nearbyMean' || wanted === 'nearbyMedian') {
      for (let index = 0; index < rows.length; index += 1) {
        if (!isMissing(variable, rows[index][column])) continue
        const near = []
        for (let back = index - 1; back >= 0 && near.length < span; back -= 1) {
          const value = rows[back][column]
          if (!isMissing(variable, value)) near.push(numeric(value))
        }
        let ahead = 0
        for (let forward = index + 1; forward < rows.length && ahead < span; forward += 1) {
          const value = rows[forward][column]
          if (!isMissing(variable, value)) { near.push(numeric(value)); ahead += 1 }
        }
        if (near.length === 0) continue
        const value = wanted === 'nearbyMean'
          ? near.reduce((sum, entry) => sum + entry, 0) / near.length
          : median(near)
        filled.push({ index, value })
      }
    } else {
      const total = present.length
      const meanIndex = present.reduce((sum, entry) => sum + entry.index, 0) / total
      const meanValue = present.reduce((sum, entry) => sum + entry.value, 0) / total
      let sxx = 0
      let sxy = 0
      for (const entry of present) {
        sxx += (entry.index - meanIndex) ** 2
        sxy += (entry.index - meanIndex) * (entry.value - meanValue)
      }
      const slope = sxx === 0 ? 0 : sxy / sxx
      for (let index = 0; index < rows.length; index += 1) {
        if (!isMissing(variable, rows[index][column])) continue
        filled.push({ index, value: meanValue + slope * (index - meanIndex) })
      }
    }
    for (const entry of filled) {
      changes.push({ row: entry.index, variable: variable.name, value: entry.value })
    }
  }
  return changes
}
