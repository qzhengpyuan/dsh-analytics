// Cox regression: the partial likelihood is maximised in lib/cox.js, and the
// score statistic is cross-checked against the log-rank test from lib/survival.js
// (they are the same quantity for a single binary covariate).
import assert from 'node:assert/strict'

import { computeCox } from '../lib/cox.js'
import { computeKaplanMeier } from '../lib/survival.js'

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

const dataset = (rows) => ({
  variables: [
    { name: 't', type: 'numeric' },
    { name: 'e', type: 'numeric' },
    { name: 'g', type: 'numeric' },
  ],
  rows,
})

// Distinct event times on purpose: with ties the log-rank variance uses the
// hypergeometric form and the Cox score test uses Breslow, so they only have to
// agree when every event time is unique.
const distinct = [
  [1, 1, 0], [2, 1, 1], [3, 1, 0], [4, 1, 1], [5, 1, 0], [6, 1, 1], [7, 1, 0],
  [9, 0, 1], [10, 0, 1], [11, 0, 0], [12, 0, 0],
]

check('the score test equals the log-rank statistic for one binary covariate', () => {
  const cox = computeCox(dataset(distinct), { time: 't', event: 'e', covariates: ['g'] })
  const km = computeKaplanMeier(
    {
      variables: [
        { name: 't', type: 'numeric' },
        { name: 'e', type: 'numeric' },
        { name: 'grp', type: 'string' },
      ],
      rows: distinct.map((row) => [row[0], row[1], row[2] === 1 ? 'B' : 'A']),
    },
    { time: 't', event: 'e', group: 'grp' },
  )
  assert.ok(
    Math.abs(cox.model.score - km.logRank.chiSquare) < 1e-3,
    `score ${cox.model.score} should match log-rank ${km.logRank.chiSquare}`,
  )
})

check('a worse group gets a hazard ratio above one', () => {
  // Group 1 collects the early events while group 0 keeps going, but both
  // groups still have events at several times: enough signal for a finite
  // estimate, not so much that the likelihood runs off to infinity.
  // Group 1 collects its events earlier, but the two groups overlap in time:
  // separation would drive the coefficient to infinity and leave no interval.
  const rows = [
    [2, 1, 1], [3, 1, 1], [4, 1, 1], [5, 1, 1], [6, 1, 1], [7, 0, 1],
    [4, 1, 0], [5, 1, 0], [6, 1, 0], [7, 1, 0], [8, 1, 0], [9, 1, 0], [10, 0, 0], [11, 0, 0],
  ]
  const cox = computeCox(dataset(rows), { time: 't', event: 'e', covariates: ['g'] })
  const coefficient = cox.model.coefficients[0]
  assert.ok(coefficient.hazardRatio > 1, `expected HR > 1, got ${coefficient.hazardRatio}`)
  assert.ok(coefficient.p < 0.2, `expected a smallish P, got ${coefficient.p}`)
  assert.ok(coefficient.ciLow < coefficient.hazardRatio && coefficient.hazardRatio < coefficient.ciHigh, 'HR sits inside its interval')
  assert.ok(cox.model.likelihoodRatio > 0, 'the model explains something')
  assert.equal(cox.model.converged, true, 'this model converges')
})

check('the table has one row per covariate and names the ties method', () => {
  const cox = computeCox(dataset(distinct), { time: 't', event: 'e', covariates: ['g'] })
  assert.equal(cox.matrix.length, 2, 'a header plus one row')
  assert.deepEqual(cox.matrix[0], ['变量', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)', '95% CI 下限', '95% CI 上限'])
  assert.equal(cox.matrix[1][0], 'g')
  assert.match(cox.notes[0], /个案 11 例，事件 7 例/, 'the note counts the cases and events')
  assert.match(cox.notes[1], /-2 对数似然/, 'and reports the fit')
  assert.match(cox.notes[3], /Breslow/, 'the ties method is stated')
})

check('two covariates are fitted at once', () => {
  const rows = [
    [1, 1, 1], [2, 1, 0], [3, 1, 1], [4, 1, 0], [5, 1, 1], [6, 1, 0],
    [7, 0, 1], [8, 1, 0], [9, 0, 1], [10, 0, 0], [11, 0, 1], [12, 0, 0],
  ]
  const cox = computeCox(
    {
      variables: [
        { name: 't', type: 'numeric' },
        { name: 'e', type: 'numeric' },
        { name: 'g', type: 'numeric' },
        { name: 'h', type: 'numeric' },
      ],
      rows: rows.map((row, index) => [...row, index % 3]),
    },
    { time: 't', event: 'e', covariates: ['g', 'h'] },
  )
  assert.equal(cox.matrix.length, 3, 'one row per covariate')
  assert.deepEqual(cox.model.coefficients.map((entry) => entry.name), ['g', 'h'])
})

check('cases with a missing covariate are dropped whole, not filled with zero', () => {
  const rows = [[1, 1, 1], [2, 1, null], [3, 1, 0], [4, 1, 1], [5, 1, 0], [6, 1, 1], [8, 0, 1], [9, 0, 0]]
  const cox = computeCox(dataset(rows), { time: 't', event: 'e', covariates: ['g'] })
  assert.equal(cox.model.n, 7, 'the incomplete case is gone')
})

check('a text covariate, a missing event and a collinear model are refused', () => {
  const text = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 'e', type: 'numeric' },
      { name: 'g', type: 'string' },
    ],
    rows: [[1, 1, 'a'], [2, 1, 'b'], [3, 1, 'a'], [4, 1, 'b'], [5, 1, 'a'], [6, 1, 'b']],
  }
  assert.throws(() => computeCox(text, { time: 't', event: 'e', covariates: ['g'] }), /只收数值协变量/, 'a text covariate is named')
  const noEvents = dataset([[1, 0, 1], [2, 0, 0], [3, 0, 1], [4, 0, 0], [5, 0, 1], [6, 0, 0]])
  assert.throws(() => computeCox(noEvents, { time: 't', event: 'e', covariates: ['g'] }), /一次事件都没有发生/, 'no events is refused')
  const collinear = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 'e', type: 'numeric' },
      { name: 'g', type: 'numeric' },
      { name: 'h', type: 'numeric' },
    ],
    rows: [[1, 1, 1, 2], [2, 1, 0, 0], [3, 1, 1, 2], [4, 1, 0, 0], [5, 1, 1, 2], [6, 1, 0, 0], [7, 1, 1, 2], [8, 0, 0, 0]],
  }
  assert.throws(() => computeCox(collinear, { time: 't', event: 'e', covariates: ['g', 'h'] }), /奇异|共线/, 'a collinear pair is refused')
  assert.throws(() => computeCox(dataset(distinct), { time: 't', event: 'e', covariates: [] }), /至少要一个协变量/, 'no covariates is refused')
})

console.log(`${checks} checks passed`)
