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
  const rowTotals = matrix.map((row) => row.reduce((sum, cell) => sum + cell, 0))
  const colTotals = totalsOf(matrix).columns
  const working = matrix.map((row) => row.map(() => 0))
  const remaining = [...colTotals]
  let left = rowTotals.reduce((sum, total) => sum + total, 0)
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    let rowLeft = rowTotals[rowIndex]
    for (let columnIndex = 0; columnIndex < remaining.length && rowLeft > 0; columnIndex += 1) {
      const last = columnIndex === remaining.length - 1
      const cap = Math.min(rowLeft, remaining[columnIndex])
      let value = 0
      if (last) {
        value = cap
      } else if (left <= 0) {
        value = 0
      } else {
        const successes = remaining[columnIndex]
        const draws = Math.min(rowLeft, left)
        value = Math.min(cap, hypergeometricDraw(left, successes, draws, random))
      }
      working[rowIndex][columnIndex] = value
      remaining[columnIndex] -= value
      rowLeft -= value
      left -= value
    }
    if (rowLeft > 0) working[rowIndex][remaining.length - 1] += rowLeft
  }
  return working
}

function hypergeometricDraw(total, successes, draws, random) {
  if (total <= 0) return 0
  // Sequential draw without replacement: each step is a Bernoulli whose
  // probability is the fraction of successes still in the urn.
  let remainingTotal = total
  let remainingSuccess = successes
  let taken = 0
  for (let step = 0; step < draws; step += 1) {
    if (remainingTotal <= 0) break
    if (random() < remainingSuccess / remainingTotal) {
      taken += 1
      remainingSuccess -= 1
    }
    remainingTotal -= 1
  }
  return taken
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

/**
 * @param {number[][]} matrix counts, rows × columns
 * @param {{ alpha?: number, simulations?: number, seed?: number, maxTables?: number }} options
 */
export function exactTest(matrix, options = {}) {
  if (!isCountTable(matrix)) return null
  const table = trimTable(matrix)
  if (table.length < 2 || table[0].length < 2) return null
  if (table.some((row) => row.some((cell) => cell < 0))) return null
  const { rows: rowTotals, columns: colTotals } = totalsOf(table)
  const total = rowTotals.reduce((sum, value) => sum + value, 0)
  if (total === 0) return null
  const observed = logTableProbability(table, rowTotals, colTotals)
  const tolerance = 1e-9
  const limit = Number.isFinite(options.maxTables) && options.maxTables > 0 ? options.maxTables : MAX_TABLES

  let matched = 0
  let kept = 0
  const tally = (working) => {
    kept += 1
    const log = logTableProbability(working, rowTotals, colTotals)
    if (log <= observed + tolerance) matched += Math.exp(log)
    return kept < limit
  }
  // Walk only when the margins leave few enough tables: the recursion is
  // cheap per table but there is no point starting a walk that cannot finish.
  const bound = tableBound(rowTotals, colTotals.length)
  const walk = bound <= limit ? enumerateTables(table, tally) : { count: bound, capped: true }
  const tables = walk.count

  if (!walk.capped) {
    return {
      method: 'exact',
      name: 'Fisher–Freeman–Halton 精确检验',
      p: Math.min(1, matched),
      tables,
      total,
      rows: rowTotals.length,
      columns: colTotals.length,
      note: `枚举了与观测表边际相同的全部 ${tables} 张表`,
    }
  }

  // Too many tables to enumerate: sample them instead, keeping the margins.
  const simulations = Number.isFinite(options.simulations) && options.simulations > 0 ? Math.floor(options.simulations) : 10000
  const random = makeRandom(options.seed)
  const probability = Math.exp(observed)
  let extreme = 0
  for (let step = 0; step < simulations; step += 1) {
    const working = randomTable(table, random)
    const log = logTableProbability(working, rowTotals, colTotals)
    if (log <= observed + tolerance) extreme += 1
  }
  const p = (extreme + 1) / (simulations + 1)
  const alpha = Number.isFinite(options.alpha) && options.alpha > 0 && options.alpha < 1 ? options.alpha : 0.99
  const z = alpha >= 0.99 ? 2.5758 : 1.96
  const spread = z * Math.sqrt((p * (1 - p)) / (simulations + 1))
  return {
    method: 'monte-carlo',
    name: 'Monte Carlo 精确检验',
    p,
    low: Math.max(0, p - spread),
    high: Math.min(1, p + spread),
    simulations,
    total,
    rows: rowTotals.length,
    columns: colTotals.length,
    observedProbability: probability,
    note: `同边际的表超过 ${limit} 张，改为抽取 ${simulations} 张表估计（种子固定，可复现）`,
  }
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
