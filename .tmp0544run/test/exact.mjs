import assert from 'node:assert'
import { describeChiSquareExact, describeExact, exactChiSquare, exactTest, fisherExact, trimTable, isCountTable } from '../lib/exact.js'

let checks = 0
const pending = []
function check(name, fn) {
  const result = fn()
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => {
      checks += 1
      console.log(`ok   ${checks} - ${name}`)
    }))
    return
  }
  checks += 1
  console.log(`ok   ${checks} - ${name}`)
}

// An independent implementation of the same multiple hypergeometric probability,
// written with BigInt factorials so it shares no code with lib/exact.js.
function factorial(n) {
  let value = 1n
  for (let i = 2n; i <= BigInt(n); i += 1n) value *= i
  return value
}
function probabilityOf(table) {
  const rows = table.map((row) => row.reduce((sum, cell) => sum + cell, 0))
  const columns = table[0].map((_, index) => table.reduce((sum, row) => sum + row[index], 0))
  const n = rows.reduce((sum, value) => sum + value, 0)
  let numerator = 1n
  for (const value of [...rows, ...columns]) numerator *= factorial(value)
  let denominator = factorial(n)
  for (const row of table) for (const cell of row) denominator *= factorial(cell)
  return Number(numerator) / Number(denominator)
}
function bruteForceP(observed) {
  const rowTotals = observed.map((row) => row.reduce((sum, cell) => sum + cell, 0))
  const columns = observed[0].map((_, index) => observed.reduce((sum, row) => sum + row[index], 0))
  const pObserved = probabilityOf(observed)
  let total = 0
  const working = observed.map((row) => row.map(() => 0))
  const remaining = [...columns]
  const fill = (rowIndex) => {
    if (rowIndex === observed.length) {
      if (remaining.some((value) => value !== 0)) return
      const p = probabilityOf(working)
      if (p <= pObserved * (1 + 1e-12)) total += p
      return
    }
    const left = rowTotals[rowIndex]
    const place = (columnIndex, rest) => {
      if (columnIndex === remaining.length - 1) {
        if (rest > remaining[columnIndex]) return
        working[rowIndex][columnIndex] = rest
        const before = remaining[columnIndex]
        remaining[columnIndex] -= rest
        fill(rowIndex + 1)
        remaining[columnIndex] = before
        return
      }
      for (let value = 0; value <= Math.min(rest, remaining[columnIndex]); value += 1) {
        working[rowIndex][columnIndex] = value
        const before = remaining[columnIndex]
        remaining[columnIndex] -= value
        place(columnIndex + 1, rest - value)
        remaining[columnIndex] = before
      }
    }
    place(0, left)
  }
  fill(0)
  return Math.min(1, total)
}

check('fisher puts a 2x2 table at the textbook two-sided value', () => {
  const result = fisherExact([[3, 1], [1, 3]])
  assert.equal(result.method, 'exact')
  assert.ok(Math.abs(result.p - 0.4857) < 5e-4, `p was ${result.p}`)
  assert.equal(result.tables, 5)
  assert.equal(result.rows, 2)
  assert.equal(result.columns, 2)
})

check('an r by c table matches an independent enumeration', () => {
  const table = [[3, 1, 2], [2, 4, 1]]
  const result = exactTest(table)
  const expected = bruteForceP(table)
  assert.equal(result.method, 'exact')
  assert.ok(Math.abs(result.p - expected) < 1e-9, `${result.p} vs ${expected}`)
  assert.equal(result.tables, 20)
})

check('a 3x3 table also matches the independent enumeration', () => {
  const table = [[4, 2, 1], [1, 3, 2], [2, 1, 5]]
  const result = exactTest(table)
  const expected = bruteForceP(table)
  assert.ok(Math.abs(result.p - expected) < 1e-9, `${result.p} vs ${expected}`)
})

check('transposing the table leaves the p-value alone', () => {
  const table = [[4, 2, 1], [1, 3, 2], [2, 1, 5]]
  const transposed = table[0].map((_, index) => table.map((row) => row[index]))
  assert.ok(Math.abs(exactTest(table).p - exactTest(transposed).p) < 1e-12)
})

check('a table that cannot be enumerated falls back to Monte Carlo, reproducibly', () => {
  const table = [[200, 150, 120], [150, 200, 130], [100, 90, 80]]
  const first = exactTest(table, { seed: 7 })
  const second = exactTest(table, { seed: 7 })
  assert.equal(first.method, 'monte-carlo')
  assert.equal(first.simulations, 10000)
  assert.equal(first.p, second.p)
  assert.ok(first.p >= 0 && first.p <= 1)
  assert.ok(first.low <= first.p && first.p <= first.high)
  assert.ok(first.note.includes('超过 200000 张'))
})

check('sampling lands on the enumerated p for a table small enough to check', () => {
  // Sequential sampling once drifted to 0.36 where enumeration says 0.27; the
  // sampler now shuffles the cases, and this comparison keeps it honest.
  const table = [[4, 2, 1], [1, 3, 2], [2, 1, 5]]
  const exact = exactTest(table)
  const sampled = exactTest(table, { maxTables: 1, simulations: 20000, seed: 11 })
  assert.equal(sampled.method, 'monte-carlo')
  assert.ok(Math.abs(sampled.p - exact.p) < 0.02, `sampled ${sampled.p} vs exact ${exact.p}`)
  assert.ok(sampled.low <= exact.p && exact.p <= sampled.high, 'the enumerated p sits inside the interval')
})

check('lowering the cap switches a small table to sampling too', () => {
  const result = exactTest([[3, 1, 2], [2, 4, 1]], { maxTables: 5, simulations: 2000, seed: 3 })
  assert.equal(result.method, 'monte-carlo')
  assert.equal(result.simulations, 2000)
})

check('rows and columns with no cases are trimmed before counting', () => {
  const trimmed = trimTable([[3, 0, 1], [0, 0, 0], [1, 0, 3]])
  assert.deepEqual(trimmed, [[3, 1], [1, 3]])
  const withEmpty = exactTest([[3, 0, 1], [0, 0, 0], [1, 0, 3]])
  assert.equal(withEmpty.tables, 5)
})

check('a table that is not a matrix of counts is refused', () => {
  assert.equal(isCountTable([[1, 2], [3.5, 4]]), false)
  assert.equal(isCountTable([[1, 2], [3]]), false)
  assert.equal(isCountTable([[-1, 2], [3, 4]]), false)
  assert.equal(exactTest([[1, 2], [3.5, 4]]), null)
  assert.equal(exactTest([[1, 2]]), null)
  assert.equal(exactTest([]), null)
})

check('a table with a single non-empty row has no test', () => {
  assert.equal(exactTest([[5, 5], [0, 0]]), null)
  assert.equal(exactTest([[0, 0], [0, 0]]), null)
})

check('an all-in-one-diagonal table is as extreme as it gets', () => {
  const result = exactTest([[100, 0, 0], [0, 100, 0], [0, 0, 100]])
  // The observed table is the least likely filling of these margins, so the
  // p-value is that table's own probability — about one in ten thousand.
  assert.ok(result.p < 1e-3, `p was ${result.p}`)
  // These margins admit ~10^11 fillings, so the sampler is the right path.
  assert.equal(result.method, 'monte-carlo')
})

check('describeExact says which method produced the number', () => {
  const exact = describeExact(exactTest([[3, 1], [1, 3]]))
  assert.ok(exact.includes('Fisher–Freeman–Halton'), exact)
  assert.ok(exact.includes('p = 0.486'), exact)
  assert.ok(exact.includes('5 张表'), exact)
  const monte = describeExact(exactTest([[200, 150, 120], [150, 200, 130], [100, 90, 80]], { seed: 7 }))
  assert.ok(monte.includes('Monte Carlo'), monte)
  assert.ok(monte.includes('10000 次抽样'), monte)
  assert.equal(describeExact(null), null)
})

check('the exact p of Pearson chi-square and the likelihood ratio come from the same walk', () => {
  // A 2×2 table orders its tables by chi-square exactly as Fisher's test orders
  // them by probability, so both exact p-values must land on the same number.
  const small = [[3, 1], [1, 3]]
  const pearson = exactChiSquare(small, 'pearson')
  const likelihood = exactChiSquare(small, 'likelihood')
  assert.equal(pearson.method, 'exact')
  assert.equal(pearson.p.toFixed(4), '0.4857')
  assert.equal(pearson.tables, 5)
  assert.equal(likelihood.p.toFixed(4), '0.4857')
  assert.equal(likelihood.value.toFixed(3), '2.093', 'the likelihood ratio of this table')

  // 3×3: disagreeing with Fisher–Freeman–Halton is the point (different statistic).
  const wide = [[4, 2, 1], [1, 3, 2], [2, 1, 5]]
  const chi = exactChiSquare(wide, 'pearson')
  assert.equal(chi.tables, 602)
  assert.equal(chi.value.toFixed(3), '5.873')
  assert.equal(chi.p.toFixed(6), '0.243675', 'checked against an independent enumeration')
  assert.notEqual(chi.p.toFixed(3), exactTest(wide).p.toFixed(3))

  // A table too wide to enumerate samples instead, with a fixed seed.
  const big = [[200, 150, 120], [150, 200, 130], [100, 90, 80]]
  const sampled = exactChiSquare(big, 'pearson', { seed: 5 })
  assert.equal(sampled.method, 'monte-carlo')
  assert.ok(sampled.low <= sampled.p && sampled.p <= sampled.high)
  assert.equal(exactChiSquare(big, 'pearson', { seed: 5 }).p, sampled.p, 'same seed, same p')
  assert.equal(exactChiSquare([[1, 2]], 'pearson'), null, 'a single row has no chi-square')
  assert.equal(exactChiSquare(small, 'pearson', { maxTables: 2 }).method, 'monte-carlo')

  const text = describeChiSquareExact(pearson)
  assert.ok(text.includes('Pearson 卡方精确检验'), text)
  assert.ok(text.includes('χ² = 2.000'), text)
  assert.ok(text.includes('精确 p = 0.486'), text)
  assert.ok(describeChiSquareExact(exactChiSquare(small, 'likelihood')).includes('似然比卡方精确检验'))
  assert.equal(describeChiSquareExact(null), null)
})

Promise.all(pending).then(() => {
  console.log(`\n${checks} checks passed in test/exact.mjs`)
  if (checks < 13) process.exitCode = 1
})
