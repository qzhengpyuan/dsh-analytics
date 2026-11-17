/**
 * Exact tests for contingency tables, computed here because PSPP only has
 * Fisher's exact test for 2×2 (`CROSSTABS` prints one row, and `METHOD=EXACT`
 * is a syntax error for anything bigger).
 *
 * Two paths, same statistic:
 *   - enumerate every table with the observed margins when the count is small,
 *     and sum the probabilities of the tables that are no more likely than the
 *     observed one (Fisher–Freeman–Halton, which reduces to Fisher's 2×2);
 *   - otherwise sample tables with the same margins and report a Monte Carlo p
 *     with its confidence interval, the way SPSS's "Exact: Monte Carlo" does.
 *
 * Probabilities come from the multiple hypergeometric distribution:
 *   P = (∏ row_i! · ∏ col_j!) / (N! · ∏ cell_ij!)
 * and are compared on the log scale so a 40-case table does not underflow.
 */

const MAX_TABLES = 200000
const LOG_FACTORIAL = [0, 0]

function logFactorial(n) {
  if (!Number.isFinite(n) || n < 0) return 0
  for (let i = LOG_FACTORIAL.length; i <= n; i += 1) {
    LOG_FACTORIAL[i] = LOG_FACTORIAL[i - 1] + Math.log(i)
  }
  return LOG_FACTORIAL[n]
}

function logTableProbability(matrix, rowTotals, colTotals) {
  let log = 0
  for (const total of rowTotals) log += logFactorial(total)
  for (const total of colTotals) log += logFactorial(total)
  for (const row of matrix) for (const cell of row) log -= logFactorial(cell)
  const n = rowTotals.reduce((sum, total) => sum + total, 0)
  log -= logFactorial(n)
  return log
}

function totalsOf(matrix) {
  const rows = matrix.map((row) => row.reduce((sum, cell) => sum + cell, 0))
  const columns = matrix[0].map((_, index) => matrix.reduce((sum, row) => sum + row[index], 0))
  return { rows, columns }
}

/**
 * Drop empty rows and columns: a category with no cases carries no information
 * and would only multiply the enumeration without changing the p-value.
 */
export function trimTable(matrix) {
  const rows = matrix.filter((row) => row.some((cell) => cell > 0))
  if (rows.length === 0) return []
  const keep = []
  for (let index = 0; index < rows[0].length; index += 1) {
    if (rows.some((row) => row[index] > 0)) keep.push(index)
  }
  return rows.map((row) => keep.map((index) => row[index]))
}

export function isCountTable(matrix) {
  return Array.isArray(matrix) && matrix.length >= 2
    && matrix.every((row) => Array.isArray(row) && row.length === matrix[0].length
      && row.every((cell) => Number.isInteger(cell) && cell >= 0))
}

/**
 * Every filling of the margin totals, in row-major order. `visit` can return
 * false to stop early (that is how the cap is enforced).
 */
function enumerateTables(matrix, visit) {
  const rowTotals = matrix.map((row) => row.reduce((sum, cell) => sum + cell, 0))
  const colTotals = totalsOf(matrix).columns
  const working = matrix.map((row) => row.map(() => 0))
  const remaining = [...colTotals]
  let count = 0

  const fill = (rowIndex) => {
    if (rowIndex === matrix.length) {
      for (const left of remaining) if (left !== 0) return true
      count += 1
      return visit(working.map((row) => [...row]))
    }
    const rowTotal = rowTotals[rowIndex]
    const width = remaining.length
    const place = (columnIndex, left) => {
      if (columnIndex === width - 1) {
        if (left > remaining[columnIndex]) return true
        working[rowIndex][columnIndex] = left
        const before = remaining[columnIndex]
        remaining[columnIndex] -= left
        const keepGoing = fill(rowIndex + 1)
        remaining[columnIndex] = before
        return keepGoing
      }
      const cap = Math.min(left, remaining[columnIndex])
      for (let value = 0; value <= cap; value += 1) {
        working[rowIndex][columnIndex] = value
        const before = remaining[columnIndex]
        remaining[columnIndex] -= value
        const keepGoing = place(columnIndex + 1, left - value)
        remaining[columnIndex] = before
        if (!keepGoing) return false
      }
      return true
    }
    return place(0, rowTotal)
  }

  const completed = fill(0)
  return { count, capped: completed === false }
}

function makeRandom(seed) {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 20260101) % 2147483647
  if (state <= 0) state += 2147483646
  return () => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}

function randomTable(matrix, random) {
  // Shuffle the labelled cases so every table with these margins is equally
  // likely: build the column vector (one label per case), Fisher-Yates it, then
  // cut it into rows of the observed row totals. Sampling cell by cell with
  // conditional hypergeometrics is equivalent in theory but easy to get subtly
  // wrong (it once gave p = 0.36 where enumeration said 0.27).
  const rowTotals = matrix.map((row) => row.reduce((sum, cell) => sum + cell, 0))
  const colTotals = totalsOf(matrix).columns
  const labels = []
  colTotals.forEach((count, column) => { for (let i = 0; i < count; i += 1) labels.push(column) })
  for (let index = labels.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const value = labels[index]
    labels[index] = labels[swap]
    labels[swap] = value
  }
  const working = []
  let cursor = 0
  for (const total of rowTotals) {
    const row = matrix[0].map(() => 0)
    for (let step = 0; step < total; step += 1) row[labels[cursor + step]] += 1
    cursor += total
    working.push(row)
  }
  return working
}

/** Upper bound on how many tables share these margins: ∏ C(rowTotal_i + k − 1, k − 1). */
function tableBound(rowTotals, columns) {
  let bound = 1
  for (const total of rowTotals) {
    let ways = 1
    for (let step = 1; step <= columns - 1; step += 1) {
      ways = (ways * (total + step)) / step
      if (ways > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
    }
    bound *= ways
    if (bound > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  }
  return bound
}

/** Pearson's chi-square and the likelihood-ratio statistic for a table. */
function chiSquareOf(matrix, kind) {
  const { rows: rowTotals, columns: colTotals } = totalsOf(matrix)
  const total = rowTotals.reduce((sum, value) => sum + value, 0)
  if (total === 0) return 0
  let statistic = 0
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix[row].length; column += 1) {
      const expected = (rowTotals[row] * colTotals[column]) / total
      if (!(expected > 0)) continue
      const observed = matrix[row][column]
      if (kind === 'likelihood') {
        if (observed > 0) statistic += 2 * observed * Math.log(observed / expected)
      } else {
        statistic += ((observed - expected) ** 2) / expected
      }
    }
  }
  return statistic
}

/**
 * Sum the probability of every table with the observed margins whose measure is
 * at least as extreme as the observed one. Enumerates when the margins allow it
 * and samples otherwise; the caller supplies the measure and the labels.
 */
function extremeProbability(table, options, measure) {
  const { rows: rowTotals, columns: colTotals } = totalsOf(table)
  const total = rowTotals.reduce((sum, value) => sum + value, 0)
  const observed = measure(table)
  const tolerance = 1e-9
  const limit = Number.isFinite(options.maxTables) && options.maxTables > 0 ? options.maxTables : MAX_TABLES

  let matched = 0
  let kept = 0
  const tally = (working) => {
    kept += 1
    if (measure(working) >= observed - tolerance) {
      matched += Math.exp(logTableProbability(working, rowTotals, colTotals))
    }
    return kept < limit
  }
  // Walk only when the margins leave few enough tables: the recursion is
  // cheap per table but there is no point starting a walk that cannot finish.
  const bound = tableBound(rowTotals, colTotals.length)
  const walk = bound <= limit ? enumerateTables(table, tally) : { count: bound, capped: true }
  const observedProbability = Math.exp(logTableProbability(table, rowTotals, colTotals))

  if (!walk.capped) {
    return { p: Math.min(1, matched), tables: walk.count, total, observedProbability, capped: false }
  }

  const simulations = Number.isFinite(options.simulations) && options.simulations > 0
    ? Math.floor(options.simulations)
    : 10000
  const random = makeRandom(options.seed)
  let extreme = 0
  for (let step = 0; step < simulations; step += 1) {
    if (measure(randomTable(table, random)) >= observed - tolerance) extreme += 1
  }
  const p = (extreme + 1) / (simulations + 1)
  const alpha = Number.isFinite(options.alpha) && options.alpha > 0 && options.alpha < 1 ? options.alpha : 0.99
  const z = alpha >= 0.99 ? 2.5758 : 1.96
  const spread = z * Math.sqrt((p * (1 - p)) / (simulations + 1))
  return {
    p,
    simulations,
    total,
    observedProbability,
    capped: true,
    low: Math.max(0, p - spread),
    high: Math.min(1, p + spread),
    bound,
  }
}

function prepare(matrix) {
  if (!isCountTable(matrix)) return null
  const table = trimTable(matrix)
  if (table.length < 2 || table[0].length < 2) return null
  if (table.some((row) => row.some((cell) => cell < 0))) return null
  const { rows: rowTotals, columns: colTotals } = totalsOf(table)
  if (rowTotals.reduce((sum, value) => sum + value, 0) === 0) return null
  return table
}

function wrap(result, { name, monteName, limit }) {
  const shape = {
    total: result.total,
    rows: undefined,
    columns: undefined,
    observedProbability: result.observedProbability,
  }
  if (!result.capped) {
    return {
      ...shape,
      method: 'exact',
      name,
      p: result.p,
      tables: result.tables,
      note: `枚举了与观测表边际相同的全部 ${result.tables} 张表`,
    }
  }
  return {
    ...shape,
    method: 'monte-carlo',
    name: monteName ?? name,
    p: result.p,
    low: result.low,
    high: result.high,
    simulations: result.simulations,
    note: `同边际的表超过 ${limit} 张，改为抽取 ${result.simulations} 张表估计（种子固定，可复现）`,
  }
}

/**
 * @param {number[][]} matrix counts, rows × columns
 * @param {{ alpha?: number, simulations?: number, seed?: number, maxTables?: number }} options
 */
export function exactTest(matrix, options = {}) {
  const table = prepare(matrix)
  if (!table) return null
  const { rows: rowTotals, columns: colTotals } = totalsOf(table)
  const measure = (working) => -logTableProbability(working, rowTotals, colTotals)
  const limit = Number.isFinite(options.maxTables) && options.maxTables > 0 ? options.maxTables : MAX_TABLES
  const result = extremeProbability(table, options, measure)
  const wrapped = wrap(result, { name: 'Fisher–Freeman–Halton 精确检验', monteName: 'Monte Carlo 精确检验', limit })
  return { ...wrapped, rows: rowTotals.length, columns: colTotals.length }
}

/**
 * Exact p for the chi-square statistics: the probability, under fixed margins,
 * of a table whose statistic is at least as large as the observed one. This is
 * what SPSS calls "Exact" under Crosstabs → Exact Tests for Chi-Square.
 *
 * @param {number[][]} matrix counts
 * @param {'pearson'|'likelihood'} kind
 */
export function exactChiSquare(matrix, kind = 'pearson', options = {}) {
  const table = prepare(matrix)
  if (!table) return null
  const { rows: rowTotals, columns: colTotals } = totalsOf(table)
  const label = kind === 'likelihood' ? '似然比卡方' : 'Pearson 卡方'
  const measure = (working) => chiSquareOf(working, kind)
  const limit = Number.isFinite(options.maxTables) && options.maxTables > 0 ? options.maxTables : MAX_TABLES
  const result = extremeProbability(table, options, measure)
  const wrapped = wrap(result, { name: `${label}精确检验`, monteName: `${label} Monte Carlo 检验`, limit })
  return {
    ...wrapped,
    statistic: kind,
    value: measure(table),
    rows: rowTotals.length,
    columns: colTotals.length,
  }
}

/** The sentence appended to the chi-square table for one exact chi-square p. */
export function describeChiSquareExact(result) {
  if (!result) return null
  const value = Number.isFinite(result.value) ? result.value.toFixed(3) : '—'
  if (result.method === 'exact') {
    return `${result.name}：χ² = ${value}，精确 p = ${result.p.toFixed(3)}（${result.note}）`
  }
  const interval = result.low === undefined
    ? ''
    : `，99% 区间 ${result.low.toFixed(3)}–${result.high.toFixed(3)}`
  return `${result.name}：χ² = ${value}，Monte Carlo 精确 p = ${result.p.toFixed(3)}（${result.simulations} 次抽样${interval}；${result.note}）`
}

/** Fisher's exact test for a 2×2 table, the case PSPP itself prints. */
export function fisherExact(matrix, options = {}) {
  if (!isCountTable(matrix) || matrix.length !== 2 || matrix[0].length !== 2) return null
  return exactTest(matrix, { ...options, maxTables: 0, simulations: 0 })
}

/** The two-sided p as a display string, with the method that produced it. */
export function describeExact(result) {
  if (!result) return null
  const p = result.p.toFixed(3)
  if (result.method === 'exact') return `${result.name}双侧 p = ${p}（${result.note}）`
  const interval = result.low === undefined
    ? ''
    : `，99% 区间 ${result.low.toFixed(3)}–${result.high.toFixed(3)}`
  return `${result.name}双侧 p = ${p}（${result.simulations} 次抽样${interval}；${result.note}）`
}
