// Discriminant analysis: PSPP 2.1.3 has no DISCRIMINANT, so the pooled
// covariance, Fisher's functions and the canonical eigenvalues are all fitted in
// lib/discriminant.js. The Wilks'-lambda identity (Λ = Π 1/(1+λᵢ)) is the
// independent check: it ties the eigenvalue search to the determinant ratio.
import assert from 'node:assert/strict'

import { computeDiscriminant } from '../lib/discriminant.js'

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

const numeric = (extra = {}) => [
  { name: 'g', type: 'numeric', ...extra },
  { name: 'x', type: 'numeric' },
  { name: 'y', type: 'numeric' },
]

const clean = [
  [1, 2, 3], [1, 3, 5], [1, 4, 2], [1, 5, 6], [1, 3, 4], [1, 4, 5],
  [2, 9, 8], [2, 10, 11], [2, 11, 7], [2, 12, 10], [2, 10, 9], [2, 11, 12],
]

const overlapping = [
  [1, 1, 2], [1, 2, 1], [1, 3, 4], [1, 4, 3], [1, 2, 5],
  [2, 2, 3], [2, 3, 2], [2, 4, 5], [2, 5, 4], [2, 3, 3],
]

const threeGroups = [
  [1, 2, 3], [1, 3, 5], [1, 4, 2], [1, 5, 6], [1, 3, 4],
  [2, 9, 8], [2, 10, 11], [2, 11, 7], [2, 12, 10], [2, 10, 9],
  [3, 5, 10], [3, 6, 12], [3, 7, 9], [3, 4, 11], [3, 8, 13],
]

check('well separated groups are classified perfectly', () => {
  const out = computeDiscriminant({ variables: numeric(), rows: clean }, { group: 'g', variables: ['x', 'y'] })
  assert.equal(out.model.accuracy, 1, `accuracy ${out.model.accuracy}`)
  assert.equal(out.model.correct, 12)
  assert.ok(out.model.wilks < 0.2, `Wilks ${out.model.wilks} should be small when the groups are far apart`)
  const classification = out.tables[0].matrix
  assert.equal(classification[0][0], '实际组')
  assert.deepEqual(classification[0].slice(1, 3), ['预测：1', '预测：2'])
  assert.deepEqual(classification[1], ['1', '6', '0', '6', '100.0%'])
})

check("Wilks' lambda equals the product of 1/(1+λ) over the canonical functions", () => {
  const out = computeDiscriminant({ variables: numeric(), rows: threeGroups }, { group: 'g', variables: ['x', 'y'] })
  assert.equal(out.model.eigenvalues.length, 2, 'three groups give two functions')
  const product = out.model.eigenvalues.reduce((total, value) => total / (1 + value), 1)
  assert.ok(Math.abs(product - out.model.wilks) < 2e-3, `product ${product} vs Wilks ${out.model.wilks}`)
  assert.ok(out.model.eigenvalues[0] >= out.model.eigenvalues[1], 'the eigenvalues come back in descending order')
})

check('the classification table adds up and reports per-group hit rates', () => {
  const out = computeDiscriminant({ variables: numeric(), rows: overlapping }, { group: 'g', variables: ['x', 'y'] })
  const table = out.tables[0].matrix
  assert.equal(table.length, 3, 'a header plus one row per group')
  const predicted = table.slice(1).reduce((sum, row) => sum + row.slice(1, 3).reduce((inner, cell) => inner + Number(cell), 0), 0)
  assert.equal(predicted, 10, 'every case lands in exactly one cell')
  const diagonal = Number(table[1][1]) + Number(table[2][2])
  assert.equal(diagonal, out.model.correct, 'the diagonal is the number of hits')
  assert.ok(out.model.accuracy < 1, 'overlapping groups do not classify perfectly')
  assert.equal(table[1][3], String(out.model.correct - Number(table[2][2])))
})

check('value labels name the predicted groups', () => {
  const variables = numeric({ valueLabels: { 1: '对照组', 2: '病例组' } })
  const out = computeDiscriminant({ variables, rows: clean }, { group: 'g', variables: ['x', 'y'] })
  assert.deepEqual(out.tables[0].matrix[0].slice(1, 3), ['预测：对照组', '预测：病例组'])
  assert.equal(out.tables[0].matrix[1][0], '对照组')
})

check('a size prior is reported and does not change the function coefficients', () => {
  const equal = computeDiscriminant({ variables: numeric(), rows: clean }, { group: 'g', variables: ['x', 'y'] })
  const sized = computeDiscriminant({ variables: numeric(), rows: clean }, { group: 'g', variables: ['x', 'y'], priors: 'size' })
  assert.match(equal.tables[0].notes[0], /相等/, 'equal priors are stated')
  assert.match(sized.tables[0].notes[0], /按各组个案数/, 'size priors are stated')
  assert.deepEqual(equal.tables[3].matrix, sized.tables[3].matrix, 'the Fisher coefficients do not depend on the priors')
})

check('a text predictor, one group, collinear predictors and too few cases are refused', () => {
  const text = {
    variables: [{ name: 'g', type: 'numeric' }, { name: 'x', type: 'string' }, { name: 'y', type: 'numeric' }],
    rows: [[1, 'a', 2], [2, 'b', 3], [1, 'c', 2], [2, 'd', 3]],
  }
  assert.throws(() => computeDiscriminant(text, { group: 'g', variables: ['x'] }), /判别变量要求数值变量/, 'a text predictor is named')
  const oneGroup = { variables: numeric(), rows: [[1, 2, 3], [1, 3, 4], [1, 4, 5], [1, 5, 6]] }
  assert.throws(() => computeDiscriminant(oneGroup, { group: 'g', variables: ['x'] }), /至少要两个组/, 'one group is refused')
  const collinear = {
    variables: [
      { name: 'g', type: 'numeric' }, { name: 'x', type: 'numeric' }, { name: 'h', type: 'numeric' },
    ],
    rows: [[1, 1, 2], [1, 2, 4], [1, 3, 6], [2, 9, 18], [2, 10, 20], [2, 11, 22]],
  }
  assert.throws(() => computeDiscriminant(collinear, { group: 'g', variables: ['x', 'h'] }), /奇异/, 'collinear predictors are refused')
  assert.throws(() => computeDiscriminant({ variables: numeric(), rows: clean }, { group: 'g', variables: [] }), /至少需要一个判别变量/, 'no predictors is refused')
  const sparse = { variables: numeric(), rows: [[1, 1, 1], [2, 2, 2]] }
  assert.throws(() => computeDiscriminant(sparse, { group: 'g', variables: ['x', 'y'] }), /个案太少/, 'two cases and two predictors are refused')
})

check('cases with a missing value are dropped whole', () => {
  const rows = [...clean, [1, null, 5], [2, 10, null]]
  const out = computeDiscriminant({ variables: numeric(), rows }, { group: 'g', variables: ['x', 'y'] })
  assert.equal(out.model.n, 12, 'the two incomplete cases are gone')
})

console.log(`${checks} checks passed`)
