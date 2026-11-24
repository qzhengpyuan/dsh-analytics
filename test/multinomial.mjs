// Multinomial logistic regression. PSPP 2.1.3 only fits LOGISTIC REGRESSION
// with two categories, so the K−1 logits are fitted here by Newton–Raphson.
//
// The two-category case has a closed form — for a single binary predictor the
// slope is the log odds ratio of the 2×2 table — so that is checked exactly
// rather than against another implementation of the same algorithm. The
// three-category case is checked through invariants that a wrong information
// matrix or a misindexed reference category breaks immediately.
import assert from 'node:assert/strict'

import { computeMultinomial } from '../lib/multinomial.js'

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

// 2×2 table: y=1 with x=1 twelve times, y=1 with x=0 four times,
// y=0 with x=1 five times, y=0 with x=0 nine times.
const table = []
for (let index = 0; index < 12; index += 1) table.push([1, 1])
for (let index = 0; index < 4; index += 1) table.push([0, 1])
for (let index = 0; index < 5; index += 1) table.push([1, 0])
for (let index = 0; index < 9; index += 1) table.push([0, 0])
const binary = dataset([['y', 'numeric'], ['x', 'numeric']], table)

// Three overlapping groups on one predictor: no separation, so every standard
// error exists and the fit is an ordinary interior maximum.
const spread = []
for (let index = 0; index < 60; index += 1) {
  const x = index / 10 + ((index * 37) % 11) / 10
  spread.push([x, ['a', 'b', 'c'][index % 3]])
}
const three = dataset([['x', 'numeric'], ['g', 'string']], spread)

check('a two-category fit reproduces the closed-form log odds ratio', () => {
  // Reference category is the last one after sorting, so the fitted level is
  // y = 0 and its slope is ln((n01·n10)/(n00·n11)).
  const out = computeMultinomial(binary, { dependent: 'y', independents: ['x'] })
  assert.equal(out.model.reference, '1')
  assert.deepEqual(out.model.categories, ['0', '1'])
  const slope = out.model.coefficients[0].terms[1].estimate
  const expected = Math.log((5 * 4) / (9 * 12))
  assert.ok(Math.abs(slope - expected) < 1e-9, `${slope} vs ${expected}`)
  // At x = 0 the odds of the fitted level (y = 0) are 9 to 5, so the intercept
  // is ln(9/5); at x = 1 they are 4 to 12, which makes the slope ln((4·5)/(12·9)).
  const intercept = out.model.coefficients[0].terms[0].estimate
  assert.ok(Math.abs(intercept - Math.log(9 / 5)) < 1e-9, `intercept ${intercept}`)
  assert.equal(out.model.cases, 30)
  assert.equal(out.model.converged, true)
})

check('the reference category can be any level and the blocks follow it', () => {
  const out = computeMultinomial(three, { dependent: 'g', independents: ['x'], reference: 'b' })
  assert.equal(out.model.reference, 'b')
  assert.deepEqual(out.model.categories, ['a', 'c', 'b'])
  assert.deepEqual(out.model.coefficients.map((block) => block.level), ['a', 'c'])
  // Two fitted blocks of two terms each (intercept + slope).
  assert.equal(out.table.length - 1, 4)
  // The third category is the reference: its parameter row must not exist.
  assert.equal(out.table.slice(1).filter((row) => row[0] === 'b').length, 0)
})

check('a three-category fit has (K−1)(p+1) parameters and a usable classification', () => {
  const out = computeMultinomial(three, { dependent: 'g', independents: ['x'] })
  assert.equal(out.model.categories.length, 3)
  assert.equal(out.table.length - 1, 2 * 2)
  assert.deepEqual(out.matrix[0], ['实测', 'a', 'b', 'c', '正确率'])
  const rows = out.matrix.slice(1, 1 + 3)
  const total = rows.reduce((sum, row) => sum + row.slice(1, 4).reduce((inner, cell) => inner + Number(cell), 0), 0)
  assert.equal(total, out.model.cases)
  const predicted = out.matrix[out.matrix.length - 1].slice(1, 4).map(Number)
  assert.equal(predicted.reduce((sum, value) => sum + value, 0), out.model.cases)
  assert.ok(out.model.accuracy > 0 && out.model.accuracy <= 1)
})

check('the pseudo R squares and the likelihood ratio agree with the log likelihoods', () => {
  const out = computeMultinomial(three, { dependent: 'g', independents: ['x'] })
  const { logLikelihood, nullLogLikelihood, chiSquare, coxSnell, nagelkerke, mcfadden } = out.model
  assert.ok(nullLogLikelihood <= logLikelihood, 'the null model cannot fit better')
  assert.ok(Math.abs(chiSquare - 2 * (logLikelihood - nullLogLikelihood)) < 1e-9)
  assert.ok(Math.abs(mcfadden - (1 - logLikelihood / nullLogLikelihood)) < 1e-12)
  assert.ok(Math.abs(coxSnell - (1 - Math.exp((2 / out.model.cases) * (nullLogLikelihood - logLikelihood)))) < 1e-12)
  assert.ok(Math.abs(nagelkerke - coxSnell / (1 - Math.exp((2 / out.model.cases) * nullLogLikelihood))) < 1e-12)
  assert.ok(coxSnell >= 0 && coxSnell < 1 && nagelkerke >= 0 && nagelkerke <= 1 + 1e-12)
})

check('a perfectly separated predictor reports huge coefficients instead of standard errors', () => {
  const rows = []
  for (let index = 0; index < 20; index += 1) rows.push([index, index < 10 ? 'lo' : 'hi'])
  const out = computeMultinomial(dataset([['x', 'numeric'], ['g', 'string']], rows), { dependent: 'g', independents: ['x'] })
  assert.equal(out.model.separated, true)
  // 'hi' and 'lo' sort as hi < lo, so the reference is 'lo' and 'hi' is fitted.
  assert.equal(out.model.reference, 'lo')
  const slopeRow = out.table.find((row) => row[0] === 'hi' && row[1] === 'x')

  assert.equal(slopeRow[3], '—', `standard error should be missing, got ${slopeRow[3]}`)
  assert.equal(slopeRow[6], '—', `P should be missing, got ${slopeRow[6]}`)
  assert.ok(Math.abs(Number(slopeRow[2])) > 15, `B should be large, got ${slopeRow[2]}`)
  assert.ok(out.notes.some((note) => note.includes('完全可分')), out.notes.join(' | '))
})

check('missing values are dropped case by case and the case count follows', () => {
  const rows = [...table.map((row) => [...row])]
  rows[0] = [null, 1]
  rows[1] = [1, null]
  const out = computeMultinomial(dataset([['y', 'numeric'], ['x', 'numeric']], rows), { dependent: 'y', independents: ['x'] })
  assert.equal(out.model.cases, 28)
  assert.ok(out.notes[0].includes('缺失值按整例剔除'), out.notes[0])
})

check('the refusals name the reason', () => {
  assert.throws(() => computeMultinomial(binary, { dependent: 'nope', independents: ['x'] }), /没有这个变量：nope/)
  assert.throws(() => computeMultinomial(binary, { dependent: 'y', independents: [] }), /至少要一个自变量/)
  assert.throws(
    () => computeMultinomial(dataset([['y', 'numeric'], ['s', 'string']], [[1, 'p'], [2, 'q'], [1, 'r']]), { dependent: 'y', independents: ['s'] }),
    /自变量要求数值变量：s 是文本变量/
  )
  assert.throws(
    () => computeMultinomial(dataset([['y', 'numeric'], ['x', 'numeric']], [[1, 1], [1, 2], [1, 3]]), { dependent: 'y', independents: ['x'] }),
    /至少要两个类别/
  )
  assert.throws(() => computeMultinomial(binary, { dependent: 'y', independents: ['x'], reference: '9' }), /参照类别「9」不在因变量的取值里（可用：0、1）/)
  assert.throws(
    () => computeMultinomial(binary, { dependent: 'y', independents: ['x', 'x'] }),
    /奇异的|不可逆/
  )
})

console.log(`\n${checks} checks`)
