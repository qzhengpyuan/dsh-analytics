// Poisson regression (log link, IRLS). PSPP 2.1.3 has no procedure that fits a
// Poisson mean model directly, so lib/poisson.js carries its own iteration.
//
// The checks below avoid re-running the same algorithm:
//   1. With only an intercept the maximum-likelihood estimate has a closed form:
//      β₀ = ln(mean), so the whole fit is compared against arithmetic.
//   2. With one binary predictor the slope is the log ratio of the two group
//      means, and the standard error is sqrt(1/(n₁μ₁) + 1/(n₀μ₀)) — two more
//      closed forms that a transposed index or a wrong sign cannot survive.
//   3. The deviance and the Pearson statistic are recomputed in the test from
//      their definitions.
//   4. The score equations must vanish at the reported optimum: Σ(y − μ)x = 0
//      for every term. That is the definition of the estimate, independent of
//      how it was found.
//   5. AIC and BIC are recomputed from the log-likelihood and the parameter
//      count.
import assert from 'node:assert/strict'

import { computePoisson } from '../lib/poisson.js'

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

const close = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected} (tolerance ${tolerance})`)
}

// Intercept only: counts 0,1,1,2,3,4,4,6 → mean 21/8.
const simple = dataset([['count', 'numeric']], [[0], [1], [1], [2], [3], [4], [4], [6]])
const simpleMean = 21 / 8

check('an intercept-only fit has the closed form ln(mean)', () => {
  const fitted = computePoisson(simple, { dependent: 'count' })
  close(fitted.model.coefficients[0].estimate, Math.log(simpleMean), 1e-9, 'intercept')
  close(fitted.model.coefficients[0].exp, simpleMean, 1e-9, 'Exp(B)')
  assert.equal(fitted.model.df, 0, 'no predictors means no likelihood-ratio degrees of freedom')
  assert.equal(fitted.model.converged, true, 'the iteration converges in one step here')
})

// 2 × 2: x=1 → counts 2,3,3,4,5 (mean 3.4); x=0 → counts 0,1,1,2 (mean 1).
const paired = dataset([['count', 'numeric'], ['group', 'numeric']], [
  [2, 1], [3, 1], [3, 1], [4, 1], [5, 1],
  [0, 0], [1, 0], [1, 0], [2, 0],
])

check('a binary predictor has the closed-form slope and standard error', () => {
  const fitted = computePoisson(paired, { dependent: 'count', independents: ['group'] })
  const slope = Math.log(3.4 / 1)
  close(fitted.model.coefficients[1].estimate, slope, 1e-8, 'slope')
  close(fitted.model.coefficients[1].exp, 3.4, 1e-8, 'Exp(B)')
  const variance = 1 / (5 * 3.4) + 1 / (4 * 1)
  close(fitted.model.coefficients[1].error, Math.sqrt(variance), 1e-8, 'standard error')
  // Wald is z² on one degree of freedom.
  const wald = (slope / Math.sqrt(variance)) ** 2
  close(fitted.model.coefficients[1].wald, wald, 1e-6, 'Wald')
})

check('the deviance, the Pearson statistic and AIC/BIC come out of their definitions', () => {
  const fitted = computePoisson(paired, { dependent: 'count', independents: ['group'] })
  const mu = { 1: 3.4, 0: 1 }
  let deviance = 0
  let pearson = 0
  let logLikelihood = 0
  let logFactorial = 0
  for (const [y, x] of paired.rows) {
    const expected = mu[x]
    deviance += y === 0 ? 2 * expected : 2 * (y * Math.log(y / expected) - (y - expected))
    pearson += ((y - expected) ** 2) / expected
    logLikelihood += y * Math.log(expected) - expected
    logFactorial += Math.log(1 + y) // ln(y!) for y ≤ 5, computed without a library
  }
  // ln(y!) from a product of the integers, so the check does not reuse logGamma.
  let factorials = 0
  for (const [y] of paired.rows) {
    let value = 0
    for (let term = 2; term <= y; term += 1) value += Math.log(term)
    factorials += value
  }
  assert.ok(logFactorial > 0)
  close(fitted.model.deviance, deviance, 1e-8, 'deviance')
  close(fitted.model.pearson, pearson, 1e-8, 'Pearson')
  close(fitted.model.logLikelihood, logLikelihood - factorials, 1e-8, 'log-likelihood')
  const width = 2
  close(fitted.model.aic, -2 * (logLikelihood - factorials) + 2 * width, 1e-8, 'AIC')
  close(fitted.model.bic, -2 * (logLikelihood - factorials) + width * Math.log(9), 1e-8, 'BIC')
  close(fitted.model.dispersion, pearson / 7, 1e-8, 'dispersion')
})

check('the score equations vanish at the reported optimum', () => {
  const fitted = computePoisson(paired, { dependent: 'count', independents: ['group'] })
  const intercept = fitted.model.coefficients[0].estimate
  const slope = fitted.model.coefficients[1].estimate
  let scoreIntercept = 0
  let scoreSlope = 0
  for (const [y, x] of paired.rows) {
    const expected = Math.exp(intercept + slope * x)
    scoreIntercept += y - expected
    scoreSlope += (y - expected) * x
  }
  close(scoreIntercept, 0, 1e-8, 'score for the intercept')
  close(scoreSlope, 0, 1e-8, 'score for the slope')
})

check('the likelihood-ratio test compares against the intercept-only model', () => {
  const fitted = computePoisson(paired, { dependent: 'count', independents: ['group'] })
  const nullFit = computePoisson(paired, { dependent: 'count' })
  const statistic = 2 * (fitted.model.logLikelihood - nullFit.model.logLikelihood)
  close(fitted.model.chiSquare, statistic, 1e-8, 'chi-square')
  assert.equal(fitted.model.df, 1, 'one predictor means one degree of freedom')
  assert.ok(fitted.model.p >= 0 && fitted.model.p <= 1, `P is a probability: ${fitted.model.p}`)
  assert.match(fitted.matrix[0].join(','), /参数,B,标准误,Wald,df,P,Exp\(B\)/,
    'the parameter table keeps the SPSS column order')
  assert.equal(fitted.tables.length, 3, 'fit information, goodness of fit and parameters')
})

check('overdispersion is reported instead of hidden', () => {
  // Counts whose variance is far above their mean: Poisson would call this
  // impossible, so the note has to say so.
  const spread = dataset([['count', 'numeric'], ['x', 'numeric']], [
    [0, 0], [0, 0], [0, 0], [40, 0], [0, 1], [0, 1], [0, 1], [60, 1],
  ])
  const fitted = computePoisson(spread, { dependent: 'count', independents: ['x'] })
  assert.ok(fitted.model.dispersion > 1.5, `dispersion ${fitted.model.dispersion}`)
  assert.ok(fitted.notes.some((note) => note.includes('过度离散')), 'the note names overdispersion')
})

check('missing values drop whole cases and the count is kept', () => {
  const withHole = dataset([['count', 'numeric'], ['x', 'numeric']], [
    [1, 1], [null, 2], [3, 3], [4, 4],
  ])
  const fitted = computePoisson(withHole, { dependent: 'count', independents: ['x'] })
  assert.equal(fitted.model.cases, 3, 'the null case is gone')
  assert.equal(fitted.model.dropped, 1, 'and counted as dropped')
  assert.ok(fitted.notes.some((note) => note.includes('整例剔除')), 'the note says how the gap was handled')
})

check('the refusals name the variable and the reason', () => {
  const cases = [
    [() => computePoisson(simple, {}), /先选一个计数因变量/],
    [() => computePoisson(simple, { dependent: 'nope' }), /没有这个变量：nope/],
    [() => computePoisson(dataset([['g', 'string'], ['count', 'numeric']], [['a', 1]]),
      { dependent: 'g' }), /因变量要求数值变量/],
    [() => computePoisson(dataset([['count', 'numeric'], ['s', 'string']], [[1, 'a']]),
      { dependent: 'count', independents: ['s'] }), /自变量要求数值变量/],
    [() => computePoisson(dataset([['count', 'numeric']], [[1.5], [2]]), { dependent: 'count' }),
      /非负整数计数/],
    [() => computePoisson(dataset([['count', 'numeric']], [[0], [0]]), { dependent: 'count' }),
      /全是 0/],
    [() => computePoisson(dataset([['count', 'numeric'], ['x', 'numeric']], [[1, 1]]),
      { dependent: 'count', independents: ['x'] }), /个案太少/],
  ]
  for (const [run, pattern] of cases) {
    assert.throws(run, pattern)
  }
})

check('a negative count is refused separately from a fraction', () => {
  assert.throws(
    () => computePoisson(dataset([['count', 'numeric']], [[-1], [2]]), { dependent: 'count' }),
    /不能是负数/,
  )
})

console.log(`${checks} poisson checks (expected 9)`)
