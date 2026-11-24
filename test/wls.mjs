// 加权最小二乘（WLS / SPSS 的「权重估计」）。
//
// 三个独立校验，都不重跑同一套算法：
//   1. 权重全为 1 时必须与普通最小二乘逐位相同（原文是两条完全不同的公式
//      路径：(X'WX)⁻¹X'Wy 与 (X'X)⁻¹X'y，权重退化时才重合）。
//   2. 权重为 2 与「把该个案复制一份」在系数上等价 —— 加权正规方程与复制后
//      的 OLS 正规方程只差一个公因子，所以在用例里真复制一遍再比。
//   3. 一个小数据集的正规方程用 2×2 克拉默法则手算，与实现无关。
import assert from 'node:assert/strict'

import { computeWls } from '../lib/wls.js'

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

// 五个个案，x = 1..5，y = 2 + 3x 加上一点偏差；权重列给 1 时退化成 OLS。
const base = dataset([['x', 'numeric'], ['y', 'numeric'], ['w', 'numeric']], [
  [1, 5, 1], [2, 8, 1], [3, 12, 1], [4, 13, 1], [5, 18, 1],
])

const ols = (rows) => {
  // (X'X)⁻¹X'y，二元情形用闭式解，避免与实现共用代码。
  const n = rows.length
  const sx = rows.reduce((sum, row) => sum + row[0], 0)
  const sy = rows.reduce((sum, row) => sum + row[1], 0)
  const sxx = rows.reduce((sum, row) => sum + row[0] ** 2, 0)
  const sxy = rows.reduce((sum, row) => sum + row[0] * row[1], 0)
  const denominator = n * sxx - sx * sx
  const slope = (n * sxy - sx * sy) / denominator
  const intercept = (sy - slope * sx) / n
  return { slope, intercept }
}

check('weights of 1 reproduce ordinary least squares exactly', () => {
  const fitted = computeWls(base, { dependent: 'y', independents: ['x'], weight: 'w' })
  const expected = ols(base.rows.map((row) => [row[0], row[1]]))
  close(fitted.model.coefficients[0].estimate, expected.intercept, 1e-10, 'intercept')
  close(fitted.model.coefficients[1].estimate, expected.slope, 1e-10, 'slope')
  assert.equal(fitted.model.allEqual, true, 'the note says the weights carry no information')
})

check('a case worth two copies weighs the same as duplicating it', () => {
  const weighted = dataset([['x', 'numeric'], ['y', 'numeric'], ['w', 'numeric']], [
    [1, 5, 1], [2, 8, 1], [3, 12, 2], [4, 13, 1], [5, 18, 1],
  ])
  const duplicated = dataset([['x', 'numeric'], ['y', 'numeric'], ['w', 'numeric']], [
    [1, 5, 1], [2, 8, 1], [3, 12, 1], [3, 12, 1], [4, 13, 1], [5, 18, 1],
  ])
  const one = computeWls(weighted, { dependent: 'y', independents: ['x'], weight: 'w' })
  const two = computeWls(duplicated, { dependent: 'y', independents: ['x'], weight: 'w' })
  close(one.model.coefficients[1].estimate, two.model.coefficients[1].estimate, 1e-10, 'slope')
  close(one.model.coefficients[0].estimate, two.model.coefficients[0].estimate, 1e-10, 'intercept')
  close(one.model.rSquare, two.model.rSquare, 1e-10, 'R² is scale free')
  // 残差平方和也一样：w = 2 的个案贡献 2r²，复制一份贡献 r² + r²，
  // 两条路径算出来的是同一个数。
  close(one.model.sse, two.model.sse, 1e-9, 'SSE matches the duplicated fit')
})

check('the weighted normal equations match a hand-solved 2×2 system', () => {
  const rows = [[1, 2, 1], [2, 4, 3], [3, 7, 2], [4, 9, 1]]
  const small = dataset([['x', 'numeric'], ['y', 'numeric'], ['w', 'numeric']], rows)
  const fitted = computeWls(small, { dependent: 'y', independents: ['x'], weight: 'w' })
  // X'WX = [[Σw, Σwx], [Σwx, Σwx²]]，X'Wy = [Σwy, Σwxy]，全部手算：
  // Σw = 7, Σwx = 1+6+6+4 = 17, Σwx² = 1+12+18+16 = 47,
  // Σwy = 2+12+14+9 = 37, Σwxy = 2+24+42+36 = 104.
  const sw = 7
  const swx = 17
  const swx2 = 47
  const swy = 37
  const swxy = 104
  const determinant = sw * swx2 - swx * swx
  const slope = (sw * swxy - swx * swy) / determinant
  const intercept = (swy * swx2 - swxy * swx) / determinant
  close(fitted.model.coefficients[1].estimate, slope, 1e-12, 'slope')
  close(fitted.model.coefficients[0].estimate, intercept, 1e-12, 'intercept')
  close(fitted.model.weightTotal, sw, 1e-12, 'weight total')
  close(fitted.model.weightedMean, swy / sw, 1e-12, 'weighted mean of y')
})

check('the sums of squares and F come out of their definitions', () => {
  const fitted = computeWls(base, { dependent: 'y', independents: ['x'], weight: 'w' })
  const expected = ols(base.rows.map((row) => [row[0], row[1]]))
  let sse = 0
  let ssr = 0
  const mean = base.rows.reduce((sum, row) => sum + row[1], 0) / base.rows.length
  for (const [x, y] of base.rows.map((row) => [row[0], row[1]])) {
    const predicted = expected.intercept + expected.slope * x
    sse += (y - predicted) ** 2
    ssr += (predicted - mean) ** 2
  }
  close(fitted.model.sse, sse, 1e-9, 'SSE')
  close(fitted.model.ssr, ssr, 1e-9, 'SSR')
  close(fitted.model.rSquare, ssr / (ssr + sse), 1e-12, 'R²')
  close(fitted.model.f, (ssr / 1) / (sse / 3), 1e-9, 'F')
  assert.equal(fitted.model.dfResidual, 3, 'five cases minus two parameters')
  close(fitted.model.standardError, Math.sqrt(sse / 3), 1e-10, 'standard error of the estimate')
})

check('zero and negative weights are dropped and counted', () => {
  const mixed = dataset([['x', 'numeric'], ['y', 'numeric'], ['w', 'numeric']], [
    [1, 5, 1], [2, 8, 0], [3, 12, -2], [4, 13, 1], [5, 18, 1],
  ])
  const fitted = computeWls(mixed, { dependent: 'y', independents: ['x'], weight: 'w' })
  assert.equal(fitted.model.cases, 3, 'only the positive weights enter the model')
  assert.equal(fitted.model.nonPositive, 2, 'and both bad weights are counted')
  assert.ok(fitted.notes.some((note) => note.includes('剔除')), 'the note says they were dropped')
})

check('missing values drop whole cases and the count is kept', () => {
  const holed = dataset([['x', 'numeric'], ['y', 'numeric'], ['w', 'numeric']], [
    [1, 5, 1], [null, 8, 1], [3, 12, 1], [4, 13, 1],
  ])
  const fitted = computeWls(holed, { dependent: 'y', independents: ['x'], weight: 'w' })
  assert.equal(fitted.model.cases, 3, 'the null case is gone')
  assert.equal(fitted.model.dropped, 1, 'and counted as dropped')
})

check('the refusals name the variable and the reason', () => {
  const cases = [
    [() => computeWls(base, {}), /先选一个因变量/],
    [() => computeWls(base, { dependent: 'y' }), /至少要一个自变量/],
    [() => computeWls(base, { dependent: 'y', independents: ['x'] }), /要选一个权重变量/],
    [() => computeWls(base, { dependent: 'nope', independents: ['x'], weight: 'w' }), /没有这个变量：nope/],
    [() => computeWls(dataset([['y', 'string'], ['x', 'numeric'], ['w', 'numeric']], [['a', 1, 1]]),
      { dependent: 'y', independents: ['x'], weight: 'w' }), /因变量要求数值变量/],
    [() => computeWls(dataset([['y', 'numeric'], ['x', 'string'], ['w', 'numeric']], [[1, 'a', 1]]),
      { dependent: 'y', independents: ['x'], weight: 'w' }), /自变量要求数值变量/],
    [() => computeWls(dataset([['y', 'numeric'], ['x', 'numeric'], ['w', 'string']], [[1, 1, 'a']]),
      { dependent: 'y', independents: ['x'], weight: 'w' }), /权重变量要求数值变量/],
    [() => computeWls(dataset([['y', 'numeric'], ['x', 'numeric'], ['w', 'numeric']], [[1, 1, 0], [2, 2, 0]]),
      { dependent: 'y', independents: ['x'], weight: 'w' }), /没有正数取值/],
    [() => computeWls(dataset([['y', 'numeric'], ['x', 'numeric'], ['w', 'numeric']], [[1, 1, 1]]),
      { dependent: 'y', independents: ['x'], weight: 'w' }), /有效个案太少/],
  ]
  for (const [run, pattern] of cases) {
    assert.throws(run, pattern)
  }
})

console.log(`${checks} wls checks (expected 7)`)
