// 二阶段最小二乘（2SLS / SPSS 的「二阶段最小二乘」）。
//
// 校验走三条互相独立的路径：
//   1. 退化情形：内生变量就是自己的工具（工具 = 内生）时，P_Z 在这些列上是
//      恒等映射，2SLS 必须与 OLS 逐位相同 —— 用例用二元 OLS 闭式解对照。
//   2. 恰好识别且只有一个内生变量的情形有教科书公式：
//      β = Cov(z, y) / Cov(z, x)（含常数项时分子分母都用离差），与矩阵解无关。
//   3. 过度识别的情形在用例里自己写一遍高斯消元求 P_Z = Z(Z'Z)⁻¹Z'，再按
//      β = (X'P_Z X)⁻¹X'P_Z y 算 —— 与实现共用 linalg 的求逆，但投影公式
//      是自己拼的；只要实现把 X 与 Z 弄反或漏掉外生列，这里就不成立。
import assert from 'node:assert/strict'

import { computeTwoStage } from '../lib/twosls.js'

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

// 20 个个案：y = 2 + 1.5x + 噪声，x 与 z 都是外生/工具列。
const rows = []
for (let index = 0; index < 20; index += 1) {
  const x = index / 3
  const z = ((index * 7) % 13) / 2
  rows.push([2 + 1.5 * x + ((index * 5) % 7) / 10, x, z])
}
const data = dataset([['y', 'numeric'], ['x', 'numeric'], ['z', 'numeric']], rows)

const ols = (pairs) => {
  const n = pairs.length
  const sx = pairs.reduce((sum, [x]) => sum + x, 0)
  const sy = pairs.reduce((sum, [, y]) => sum + y, 0)
  const sxx = pairs.reduce((sum, [x]) => sum + x * x, 0)
  const sxy = pairs.reduce((sum, [x, y]) => sum + x * y, 0)
  const denominator = n * sxx - sx * sx
  const slope = (n * sxy - sx * sy) / denominator
  return { slope, intercept: (sy - slope * sx) / n }
}

check('a regressor that is its own instrument reduces to ordinary least squares', () => {
  // 精确线性关系 y = 2 + 1.5x，且 z 与常数、x 正交（对称 ±1），所以三项 OLS
  // 的系数就是 (2, 1.5, 0)；内生 z 用自己的工具时 P_Z 在 z 列上是恒等映射，
  // 2SLS 必须落在同一个点上。
  const exactRows = []
  for (let index = 0; index < 20; index += 1) {
    const x = index - 9.5
    const z = index % 2 === 0 ? 1 : -1
    exactRows.push([2 + 1.5 * x, x, z])
  }
  const exact = dataset([['y', 'numeric'], ['x', 'numeric'], ['z', 'numeric']], exactRows)
  const fitted = computeTwoStage(exact, {
    dependent: 'y', endogenous: ['z'], instruments: ['z'], exogenous: ['x'],
  })
  const expected = ols(exactRows.map((row) => [row[1], row[0]]))
  // 系数按「常数、外生、内生」排序：下标 0 是常数，1 是外生的 x，2 是内生的 z。
  close(fitted.model.coefficients[0].estimate, expected.intercept, 1e-8, 'intercept')
  close(fitted.model.coefficients[1].estimate, expected.slope, 1e-8, 'slope on x')
  close(fitted.model.coefficients[2].estimate, 0, 1e-8, 'the endogenous z absorbs nothing once its own instrument explains it')
  assert.equal(fitted.tables.length, 3, 'summary, first stage and coefficients')
})

check('the just-identified case matches the textbook instrumental-variable ratio', () => {
  // x 是内生变量，z 是它唯一的工具；没有额外外生自变量。
  const pairs = rows.map((row) => [row[1], row[2], row[0]])
  const n = pairs.length
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n
  const meanZ = pairs.reduce((sum, [, z]) => sum + z, 0) / n
  const meanY = pairs.reduce((sum, [, , y]) => sum + y, 0) / n
  const covZY = pairs.reduce((sum, [, z, y]) => sum + (z - meanZ) * (y - meanY), 0)
  const covZX = pairs.reduce((sum, [x, z]) => sum + (z - meanZ) * (x - meanX), 0)
  const expectedSlope = covZY / covZX
  const fitted = computeTwoStage(data, { dependent: 'y', endogenous: ['x'], instruments: ['z'] })
  close(fitted.model.coefficients[1].estimate, expectedSlope, 1e-9, 'slope')
  close(fitted.model.coefficients[0].estimate, meanY - expectedSlope * meanX, 1e-9, 'intercept')
})

check('an over-identified fit matches a hand-built projection matrix', () => {
  // 两个工具、一个内生变量：先自己算 P_Z，再解 (X'P_Z X)⁻¹X'P_Z y。
  const data2 = dataset([['y', 'numeric'], ['x', 'numeric'], ['z1', 'numeric'], ['z2', 'numeric']], rows.map((row, index) => [
    row[0], row[1], row[2], ((index * 11) % 17) / 4,
  ]))
  const X = [rows.map(() => 1), rows.map((row) => row[1])]
  const Z = [rows.map(() => 1), rows.map((row) => row[2]), rows.map((row, index) => ((index * 11) % 17) / 4)]
  const y = rows.map((row) => row[0])
  const solveSmall = (matrix, vector) => {
    const size = vector.length
    const work = matrix.map((row, index) => [...row, vector[index]])
    for (let column = 0; column < size; column += 1) {
      let pivot = column
      for (let row = column + 1; row < size; row += 1) {
        if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row
      }
      ;[work[column], work[pivot]] = [work[pivot], work[column]]
      const lead = work[column][column]
      for (let index = column; index <= size; index += 1) work[column][index] /= lead
      for (let row = 0; row < size; row += 1) {
        if (row === column) continue
        const factor = work[row][column]
        for (let index = column; index <= size; index += 1) work[row][index] -= factor * work[column][index]
      }
    }
    return work.map((row) => row[size])
  }
  const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0)
  const ztz = Z.map((left) => Z.map((right) => dot(left, right)))
  const ztzInverse = ztz[0].map((_, column) => {
    const unit = ztz.map((_, index) => (index === column ? 1 : 0))
    return solveSmall(ztz, unit)
  })
  // P_Z y 与 P_Z X 的每一列。
  const project = (vector) => {
    const coefficients = solveSmall(ztz, Z.map((row) => dot(row, vector)))
    return rows.map((_, index) => Z.reduce((sum, row, term) => sum + coefficients[term] * row[index], 0))
  }
  const projectX = X.map(project)
  const projectY = project(y)
  const xtpx = projectX.map((left) => projectX.map((right) => dot(left, right)))
  const xtpy = projectX.map((left) => dot(left, projectY))
  const expected = solveSmall(xtpx, xtpy)
  const fitted = computeTwoStage(data2, {
    dependent: 'y', endogenous: ['x'], instruments: ['z1', 'z2'],
  })
  close(fitted.model.coefficients[1].estimate, expected[1], 1e-7, 'slope')
  close(fitted.model.coefficients[0].estimate, expected[0], 1e-7, 'intercept')
  assert.equal(fitted.model.overIdentified, true, 'two instruments for one endogenous variable is over-identified')
  assert.ok(fitted.notes.some((note) => note.includes('过度识别')), 'the note says so')
})

check('the first stage reports the instrument strength', () => {
  const fitted = computeTwoStage(data, {
    dependent: 'y', endogenous: ['x'], instruments: ['z'], exogenous: [],
  })
  const stage = fitted.model.stageOne[0]
  assert.equal(stage.name, 'x')
  const expected = ols(rows.map((row) => [row[2], row[1]]))
  const predicted = rows.map((row) => expected.intercept + expected.slope * row[2])
  const mean = rows.reduce((sum, row) => sum + row[1], 0) / rows.length
  const residual = rows.reduce((sum, row, index) => sum + (row[1] - predicted[index]) ** 2, 0)
  const total = rows.reduce((sum, row) => sum + (row[1] - mean) ** 2, 0)
  close(stage.rSquare, 1 - residual / total, 1e-10, 'first-stage R²')
  close(stage.f, (stage.rSquare / 1) / ((1 - stage.rSquare) / (rows.length - 2)), 1e-8, 'first-stage F')
})

check('missing values drop whole cases and the count is kept', () => {
  const holed = dataset([['y', 'numeric'], ['x', 'numeric'], ['z', 'numeric']], [
    [1, 2, 3], [null, 2, 3], [3, 4, 1], [4, 1, 2], [5, 3, 1],
  ])
  const fitted = computeTwoStage(holed, { dependent: 'y', endogenous: ['x'], instruments: ['z'] })
  assert.equal(fitted.model.cases, 4, 'the null case is gone')
  assert.equal(fitted.model.dropped, 1, 'and counted as dropped')
})

check('the refusals name the variable and the reason', () => {
  const cases = [
    [() => computeTwoStage(data, {}), /先选一个因变量/],
    [() => computeTwoStage(data, { dependent: 'y' }), /至少要一个内生自变量/],
    [() => computeTwoStage(data, { dependent: 'y', endogenous: ['x'] }), /至少要一个工具变量/],
    [() => computeTwoStage(data, { dependent: 'y', endogenous: ['x', 'z'], instruments: ['x'] }), /工具变量不足/],
    [() => computeTwoStage(data, { dependent: 'nope', endogenous: ['x'], instruments: ['z'] }), /没有这个变量：nope/],
    [() => computeTwoStage(dataset([['y', 'string'], ['x', 'numeric'], ['z', 'numeric']], [['a', 1, 2]]),
      { dependent: 'y', endogenous: ['x'], instruments: ['z'] }), /因变量要求数值变量/],
    [() => computeTwoStage(dataset([['y', 'numeric'], ['x', 'string'], ['z', 'numeric']], [[1, 'a', 2]]),
      { dependent: 'y', endogenous: ['x'], instruments: ['z'] }), /内生自变量要求数值变量/],
    [() => computeTwoStage(dataset([['y', 'numeric'], ['x', 'numeric'], ['z', 'string']], [[1, 2, 'a']]),
      { dependent: 'y', endogenous: ['x'], instruments: ['z'] }), /工具变量要求数值变量/],
  ]
  for (const [run, pattern] of cases) {
    assert.throws(run, pattern)
  }
})

console.log(`${checks} twosls checks (expected 6)`)
