// 曲线估计：11 个模型逐个用「本来就落在曲线上的数据」验参数，再用一组带噪声
// 的数据验 R²、F、自由度与排序。没有引擎答案可比（PSPP 2.1.3 没有 CURVEFIT），
// 所以要么闭式解、要么恒等式。
import assert from 'node:assert/strict'

import { computeCurveEstimate, evaluateCurve } from '../lib/curves.js'

let checks = 0
const failures = []
const check = (name, body) => {
  try {
    body()
    checks += 1
    console.log(`ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

const dataset = (pairs) => ({
  variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
  rows: pairs.map(([x, y]) => [x, y]),
})

const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const fit = (pairs, models, extra = {}) => computeCurveEstimate(dataset(pairs), {
  dependent: 'y', independent: 'x', models, ...extra,
})
const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`)
}

check('every model recovers the parameters it was generated from', () => {
  const cases = [
    ['linear', xs.map((x) => [x, 3 + 2 * x]), [3, 2]],
    ['logarithmic', xs.map((x) => [x, 1 + 2 * Math.log(x)]), [1, 2]],
    ['inverse', xs.map((x) => [x, 4 + 3 / x]), [4, 3]],
    ['quadratic', xs.map((x) => [x, 1 + 2 * x + 3 * x * x]), [1, 2, 3]],
    ['cubic', xs.map((x) => [x, 2 - x + 0.5 * x * x + 0.25 * x ** 3]), [2, -1, 0.5, 0.25]],
    ['compound', xs.map((x) => [x, 5 * 1.3 ** x]), [5, 1.3]],
    ['power', xs.map((x) => [x, 2 * x ** 1.5]), [2, 1.5]],
    ['s', xs.map((x) => [x, Math.exp(2 + 1 / x)]), [2, 1]],
    // 增长模型的 b0、b1 是线性化后的截距与斜率，不取指数：y = e^(1.6 + 0.3x)。
    ['growth', xs.map((x) => [x, Math.exp(1.6 + 0.3 * x)]), [1.6, 0.3]],
    ['exponential', xs.map((x) => [x, 5 * Math.exp(0.3 * x)]), [5, 0.3]],
    ['logistic', xs.map((x) => [x, 1 / (1 / 10 + 2 * 0.5 ** x)]), [2, 0.5]],
  ]
  for (const [model, pairs, expected] of cases) {
    const out = fit(pairs, [model], { upper: model === 'logistic' ? 10 : undefined })
    const entry = out.parameters[0]
    assert.ok(entry, `${model} fitted`)
    assert.equal(entry.coefficients.length, expected.length, `${model} coefficient count`)
    entry.coefficients.forEach((value, index) => {
      close(value, expected[index], 1e-8)
    })
    close(entry.rSquare, 1, 1e-10)
    close(entry.rSquareOriginal, 1, 1e-10)
  }
})

check('a curve evaluated from the reported coefficients retraces the data', () => {
  const pairs = xs.map((x) => [x, 4 * Math.exp(0.2 * x)])
  const out = fit(pairs, ['exponential'])
  const entry = out.parameters[0]
  for (const [x, y] of pairs) {
    close(evaluateCurve('exponential', entry.coefficients, x), y, 1e-8)
  }
})

check('the summary counts degrees of freedom the way the model terms demand', () => {
  const pairs = xs.map((x) => [x, 1 + 2 * x + 0.1 * ((x * 7) % 3)])
  const out = fit(pairs, ['linear', 'quadratic', 'cubic'])
  const [linear, quadratic, cubic] = out.parameters
  assert.equal(linear.df1, 1)
  assert.equal(linear.df2, 8)
  assert.equal(quadratic.df1, 2)
  assert.equal(quadratic.df2, 7)
  assert.equal(cubic.df1, 3)
  assert.equal(cubic.df2, 6)
  // 嵌套模型的 R² 只能不降，这是最小二乘的常识，反过来就说明设计矩阵拼错了。
  assert.ok(quadratic.rSquare >= linear.rSquare - 1e-12)
  assert.ok(cubic.rSquare >= quadratic.rSquare - 1e-12)
})

check('F is the ratio of mean squares and P follows from it', () => {
  const pairs = xs.map((x) => [x, 2 + 1.5 * x + 0.4 * ((x * 5) % 4)])
  const out = fit(pairs, ['linear'])
  const entry = out.parameters[0]
  const n = pairs.length
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const [x, y] of pairs) {
    sxy += (x - meanX) * (y - meanY)
    sxx += (x - meanX) ** 2
    syy += (y - meanY) ** 2
  }
  const slope = sxy / sxx
  const sse = syy - slope * sxy
  const f = (sxy * sxy) / sxx / (sse / (n - 2))
  close(entry.f, f, 1e-6)
  assert.ok(entry.p >= 0 && entry.p <= 1)
  close(entry.rSquare, (sxy * sxy) / (sxx * syy), 1e-12)
})

check('models that need positive values drop the cases they cannot use', () => {
  const pairs = [[0, 5], [1, 6], [2, 7], [3, 8], [4, 9], [5, 10], [-1, 4], [6, 11]]
  const out = fit(pairs, ['linear', 'logarithmic'])
  const linear = out.parameters.find((entry) => entry.model === 'linear')
  const logarithmic = out.parameters.find((entry) => entry.model === 'logarithmic')
  assert.equal(linear.cases, 8)
  assert.equal(logarithmic.cases, 6)
  assert.ok(out.notes.some((note) => /取值不满足模型要求被剔除/.test(note)), 'the note names the exclusion')
})

check('missing values drop the whole case and the note says how many', () => {
  const pairs = xs.map((x) => [x, 2 * x])
  pairs.push([null, 30])
  pairs.push([11, null])
  const out = fit(pairs, ['linear'])
  assert.equal(out.parameters[0].cases, 10)
  assert.equal(out.dropped, 2)
  assert.ok(out.notes.some((note) => /2 个案的因变量或自变量是缺失值/.test(note)))
})

check('the logistic model refuses an upper bound it cannot honour', () => {
  const pairs = xs.map((x) => [x, 1 / (1 / 10 + 2 * 0.5 ** x)])
  assert.throws(() => fit(pairs, ['logistic'], { upper: 5 }), /必须大于因变量的最大值/)
  // 不给上界时可以算，但注文必须点名这个取值是插件自己选的。
  const out = fit(pairs, ['logistic'])
  assert.ok(out.notes.some((note) => /Logistic 的上界没有指定/.test(note)))
})

check('the reported best model is the one with the largest R squared', () => {
  const pairs = xs.map((x) => [x, 3 * x * x - 2 * x + 1])
  const out = fit(pairs, ['linear', 'quadratic'], { })
  const best = out.parameters.reduce((left, right) => (right.rSquare > left.rSquare ? right : left))
  assert.equal(out.best, best.model)
  assert.equal(out.curve.model, best.model)
})

check('rejections say what is wrong in Chinese', () => {
  const pairs = xs.map((x) => [x, 1 + x])
  const datasetOf = (pairs) => ({
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }, { name: 'label', type: 'string' }],
    rows: pairs.map(([x, y]) => [x, y, 'A']),
  })
  const run = (options) => () => computeCurveEstimate(datasetOf(pairs), options)
  assert.throws(run({ independent: 'x' }), /曲线估计要指定因变量/)
  assert.throws(run({ dependent: 'y' }), /曲线估计要指定自变量/)
  assert.throws(run({ dependent: 'y', independent: 'y' }), /不能是同一个变量/)
  assert.throws(run({ dependent: 'y', independent: 'nope' }), /没有这个变量：nope/)
  assert.throws(run({ dependent: 'y', independent: 'label' }), /要求数值自变量/)
  assert.throws(run({ dependent: 'label', independent: 'x' }), /要求数值因变量/)
  assert.throws(run({ dependent: 'y', independent: 'x', models: ['spline'] }), /不认识的曲线模型/)
  assert.throws(run({ dependent: 'y', independent: 'x', upper: -1 }), /上界 u 要给定一个正数/)

})

check('a model with too few cases is skipped, not silently fitted', () => {
  const pairs = [[1, 2], [2, 4], [3, 6]]
  const out = fit(pairs, ['linear', 'cubic'])
  assert.ok(out.parameters.some((entry) => entry.model === 'linear'))
  assert.ok(out.skipped.some((entry) => entry.model === 'cubic'))
  assert.ok(out.skipped.some((entry) => /可用个案只有/.test(entry.reason)))
})

void dataset
process.stdout.write(`\n${checks} checks in test/curves.mjs\n`)
if (failures.length > 0) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
