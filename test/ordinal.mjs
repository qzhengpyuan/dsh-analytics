// Ordinal (proportional odds) logistic regression. PSPP 2.1.3 has no ordered
// logit procedure — NOMREG reports "not yet implemented" and LOGISTIC
// REGRESSION stops at two categories — so the cumulative-logit model is fitted
// here by Newton–Raphson on the full log-likelihood.
//
// Two independent kinds of check, neither of which re-runs the same algorithm:
//   1. With two categories the model is ordinary binary logistic regression, so
//      a single binary predictor has a closed form: β is the log odds ratio of
//      the 2×2 table, the threshold is logit of the second column share, and the
//      standard error is sqrt(Σ 1/n) over the four cells.
//   2. The analytic gradient and the numeric Hessian are pinned against finite
//      differences of the log-likelihood itself, so a sign or a transposed index
//      fails here rather than in a standard error nobody looks at.
import assert from 'node:assert/strict'

import {
  computeOrdinal,
  gradient,
  hessian,
  logLikelihood,
} from '../lib/ordinal.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const dataset = (variables, rows) => ({
  variables: variables.map(([name, type]) => ({ name, type })),
  rows,
})

// 2×2 table: x=1 → y=0 five times and y=1 twelve times;
//           x=0 → y=0 nine times and y=1 twelve times.
const table = []
for (let index = 0; index < 5; index += 1) table.push([0, 1])
for (let index = 0; index < 12; index += 1) table.push([1, 1])
for (let index = 0; index < 9; index += 1) table.push([0, 0])
for (let index = 0; index < 12; index += 1) table.push([1, 0])
const binary = dataset([['y', 'numeric'], ['x', 'numeric']], table)

// Three ordered categories crossed with the predictor, so the categories
// overlap and the proportional-odds restriction is actually satisfied.
const crossed = []
for (let level = 1; level <= 3; level += 1) {
  for (const x of [1, 2, 3, 4, 5]) {
    const times = level === 2 ? 4 : 3
    for (let index = 0; index < times; index += 1) crossed.push([level, x + level * 0.5])
  }
}
const ordinal = dataset([['y', 'numeric'], ['x', 'numeric']], crossed)

// Same shape but the predictor is a step function of the category: with a
// two-category dependent variable this is complete separation.
const separated = []
for (let index = 0; index < 20; index += 1) separated.push([index < 10 ? 0 : 1, index])
const stepped = dataset([['y', 'numeric'], ['x', 'numeric']], separated)

const close = (left, right, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(right)),
    `${left} is not ${right}`,
  )
}

check('a two-category fit is the closed-form binary logistic regression', () => {
  const result = computeOrdinal(binary, { dependent: 'y', independents: ['x'] })
  // logit P(Y ≤ 0) = θ − βx, so β is logit(x=0) − logit(x=1) = ln(9/5).
  close(result.model.coefficients[0], Math.log(9 / 5))
  // θ is logit of the share of the first category at x = 0: ln(9/12).
  close(result.model.thresholds[0], Math.log(9 / 12))
  assert.equal(result.model.cases, 38)
  assert.equal(result.model.converged, true)
  // The standard error of a 2×2 log odds ratio has a closed form too.
  const expectedError = Math.sqrt(1 / 5 + 1 / 12 + 1 / 9 + 1 / 12)
  close(result.model.standardErrors[1], expectedError, 1e-6)
  const row = result.table.find((cells) => cells[0] === 'x')
  // The table rounds to four decimals; the exact value lives in the model.
  close(Number(row[2]), expectedError, 5e-5)
  close(Number(row[6]), 9 / 5, 1e-3)
})

check('the analytic gradient is the derivative of the log-likelihood', () => {
  const rows = [
    { x: [1], y: 0 },
    { x: [2], y: 1 },
    { x: [2], y: 2 },
    { x: [3], y: 1 },
    { x: [3], y: 2 },
    { x: [4], y: 2 },
  ]
  const theta = [0.2, 1.1]
  const beta = [0.35]
  const analytic = gradient(rows, theta, beta, 1)
  const numeric = []
  for (let index = 0; index < analytic.length; index += 1) {
    const step = 1e-6
    const plus = [...theta, ...beta]
    plus[index] += step
    const minus = [...theta, ...beta]
    minus[index] -= step
    const forward = logLikelihood(rows, plus.slice(0, 2), plus.slice(2))
    const backward = logLikelihood(rows, minus.slice(0, 2), minus.slice(2))
    numeric.push((forward - backward) / (2 * step))
  }
  for (let index = 0; index < analytic.length; index += 1) close(analytic[index], numeric[index], 1e-5)
})

check('the numeric Hessian is symmetric and curves the likelihood downwards', () => {
  const rows = [
    { x: [1], y: 0 },
    { x: [2], y: 1 },
    { x: [2], y: 2 },
    { x: [3], y: 1 },
    { x: [3], y: 2 },
    { x: [4], y: 2 },
  ]
  const matrix = hessian(rows, [0.2, 1.1], [0.35], 1)
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix.length; column += 1) {
      close(matrix[row][column], matrix[column][row], 1e-9)
    }
  }
  // The diagonal of the log-likelihood Hessian is negative at an interior point.
  for (let index = 0; index < matrix.length; index += 1) assert.ok(matrix[index][index] < 0, 'diagonal')
})

check('three ordered categories keep the thresholds increasing', () => {
  const result = computeOrdinal(ordinal, { dependent: 'y', independents: ['x'] })
  const thresholds = result.model.thresholds
  assert.equal(thresholds.length, 2)
  assert.ok(thresholds[0] < thresholds[1], 'thresholds must increase')
  // A bigger predictor pushes cases towards the higher categories.
  assert.ok(result.model.coefficients[0] > 0, 'positive slope')
  assert.equal(result.table[0].length, 7)
  assert.equal(result.table.filter((cells) => cells[0].startsWith('阈值')).length, 2)
  assert.ok(result.model.accuracy > 0 && result.model.accuracy <= 1)
  // 2(K−2) = 2 free parameters in the unrestricted model, 1 predictor ⇒ df 1.
  assert.equal(result.model.parallel.df, 1)
  assert.ok(result.model.parallel.p > 0 && result.model.parallel.p <= 1)
})

check('the classification table counts every case once', () => {
  const result = computeOrdinal(ordinal, { dependent: 'y', independents: ['x'] })
  const matrix = result.matrix
  assert.equal(matrix[0][0], '实测')
  assert.equal(matrix.length, 5)
  const body = matrix.slice(1, 4)
  const rowSums = body.map((cells) => cells.slice(1, 4).reduce((sum, value) => sum + Number(value), 0))
  assert.equal(rowSums.reduce((sum, value) => sum + value, 0), result.model.cases)
  assert.equal(matrix[4][0], '总计')
  // The totals row counts predictions per column, so the three columns add up
  // to the number of cases just like the rows do.
  const columnSums = matrix[4].slice(1, 4).reduce((sum, value) => sum + Number(value), 0)
  assert.equal(columnSums, result.model.cases)
})

check('a two-category dependent variable skips the parallel-lines test', () => {
  const result = computeOrdinal(binary, { dependent: 'y', independents: ['x'] })
  assert.equal(result.model.parallel, null)
  assert.ok(result.notes.some((note) => note.includes('两个类别')))
})

check('separation reports dashes instead of standard errors', () => {
  const result = computeOrdinal(stepped, { dependent: 'y', independents: ['x'] })
  assert.equal(result.model.separated, true)
  const row = result.table.find((cells) => cells[0] === 'x')
  assert.equal(row[2], '—')
  assert.equal(row[5], '—')
  assert.ok(result.notes.some((note) => note.includes('完全可分')))
})

check('missing values drop whole cases, and the reasons are named', () => {
  const rows = [
    [1, 1],
    [2, null],
    [3, 3],
    [2, 2],
    [1, 3],
    [3, 1],
    [1, 2],
    [2, 3],
  ]
  const result = computeOrdinal(dataset([['y', 'numeric'], ['x', 'numeric']], rows), {
    dependent: 'y',
    independents: ['x'],
  })
  assert.equal(result.model.cases, 7)

  assert.throws(
    () => computeOrdinal(ordinal, { dependent: 'y', independents: [] }),
    /至少要一个自变量/,
  )
  assert.throws(
    () => computeOrdinal(ordinal, { dependent: 'nope', independents: ['x'] }),
    /没有这个变量：nope/,
  )
  const text = dataset([['y', 'numeric'], ['s', 'string'], ['x', 'numeric']], [[1, 'a', 1]])
  assert.throws(
    () => computeOrdinal(text, { dependent: 'y', independents: ['s'] }),
    /自变量要求数值变量：s 是文本变量/,
  )
  const single = dataset([['y', 'numeric'], ['x', 'numeric']], [[1, 1], [1, 2], [1, 3], [1, 4]])
  assert.throws(() => computeOrdinal(single, { dependent: 'y', independents: ['x'] }), /至少要两个类别/)
  const many = dataset(
    [['y', 'numeric'], ...Array.from({ length: 11 }, (_, index) => [`x${index}`, 'numeric'])],
    [[1, ...Array.from({ length: 11 }, () => 1)]],
  )
  assert.throws(
    () => computeOrdinal(many, {
      dependent: 'y',
      independents: Array.from({ length: 11 }, (_, index) => `x${index}`),
    }),
    /一次最多 10 个自变量/,
  )
})

console.log(checks === 9 ? `${checks} ordinal checks` : `${checks} ordinal checks (expected 8)`)
