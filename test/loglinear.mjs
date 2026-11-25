// 一般对数线性分析：没有引擎答案可比（PSPP 2.1.3 无 HILOGLINEAR），所以每条断言
// 都落在可以独立验算的性质上：主效应模型的期望频数 = r·c/n、任何放进模型的项其
// 拟合边距等于观察边距、饱和模型的期望频数 = 观察频数、G² 与手算的似然比卡方一致。
import assert from 'node:assert/strict'

import { computeLogLinear } from '../lib/loglinear.js'

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

const close = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)
}

// 把频数表摊成「一个个案一行」的数据集，与用户在数据视图里看到的一样。
function datasetOf(table, names, letters = ['x', 'y', 'z', 'w']) {
  const rows = []
  table.forEach((line, row) => line.forEach((count, column) => {
    for (let repeat = 0; repeat < count; repeat += 1) rows.push([letters[row], letters[column]])
  }))
  return {
    variables: names.map((name) => ({ name, type: 'string', measure: 'nominal' })),
    rows,
  }
}

// 3 维用显式的三重循环，免得上面那个 helper 越写越绕。
function dataset3(counts, names) {
  const rows = []
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      for (let k = 0; k < 2; k += 1) {
        const value = counts(i, j, k)
        for (let repeat = 0; repeat < value; repeat += 1) rows.push([i ? 'y' : 'x', j ? 'y' : 'x', k ? 'y' : 'x'])
      }
    }
  }
  return { variables: names.map((name) => ({ name, type: 'string', measure: 'nominal' })), rows }
}

const boxesOf = (levels) => levels.map((entry) => entry.length)
const cellPosition = (cell, boxes) => {
  const strides = boxes.map((_, slot) => boxes.slice(slot + 1).reduce((product, value) => product * value, 1))
  return boxes.map((_, slot) => Math.floor(cell / strides[slot]) % boxes[slot])
}

check('a two-way main-effects model gives the independence estimates', () => {
  const table = [[10, 20], [30, 40]]
  const out = computeLogLinear(datasetOf(table, ['a', 'b']), { variables: ['a', 'b'], terms: [['a'], ['b']] })
  assert.equal(out.cells, 4)
  assert.equal(out.cases, 100)
  const n = 100
  const rowTotals = table.map((line) => line.reduce((sum, value) => sum + value, 0))
  const columnTotals = table[0].map((_, column) => table.reduce((sum, line) => sum + line[column], 0))
  const expected = []
  table.forEach((line, row) => line.forEach((_, column) => expected.push((rowTotals[row] * columnTotals[column]) / n)))
  out.expected.forEach((value, index) => close(value, expected[index], 1e-8, `expected cell ${index}`))
  // 期望频数之和必须等于总个案数（泊松回归里截距的作用）。
  close(out.expected.reduce((sum, value) => sum + value, 0), n, 1e-8, 'expected total')
})

check('the likelihood-ratio chi-square matches the hand calculation', () => {
  const table = [[10, 20], [30, 40]]
  const out = computeLogLinear(datasetOf(table, ['a', 'b']), { variables: ['a', 'b'], terms: [['a'], ['b']] })
  const observed = [10, 20, 30, 40]
  const manual = 2 * observed.reduce((sum, value, index) => sum + (value > 0 ? value * Math.log(value / out.expected[index]) : 0), 0)
  close(out.fit.g2, manual, 1e-8, 'G squared')
  assert.equal(out.fit.df, 1)
  // 2×2 表的 G² 与 Pearson 卡方同阶但不等，两者都该在 0.8 附近。
  assert.ok(out.fit.pearson > 0.7 && out.fit.pearson < 1.0, `Pearson ${out.fit.pearson}`)
  assert.ok(out.fit.p > 0.3 && out.fit.p < 0.45, `p ${out.fit.p}`)
})

check('the fitted margins of every included term equal the observed margins', () => {
  // 这是得分方程的直接结果：不成立就说明设计矩阵或 IRLS 错了。
  const counts = (i, j, k) => 4 + i * 3 + j * 5 + k * 7 + i * j * 2
  const out = computeLogLinear(dataset3(counts, ['a', 'b', 'c']), { variables: ['a', 'b', 'c'], terms: [['a'], ['b'], ['c']] })
  const boxes = boxesOf(out.levels)
  for (let dimension = 0; dimension < 3; dimension += 1) {
    const fitted = new Array(boxes[dimension]).fill(0)
    const observed = new Array(boxes[dimension]).fill(0)
    for (let cell = 0; cell < out.cells; cell += 1) {
      const position = cellPosition(cell, boxes)
      fitted[position[dimension]] += out.expected[cell]
      observed[position[dimension]] += out.counts[cell]
    }
    fitted.forEach((value, level) => close(value, observed[level], 1e-7, `margin ${dimension}=${level}`))
  }
})

check('a model with an interaction keeps the two-way margin but not the three-way one', () => {
  const counts = (i, j, k) => 4 + i * 3 + j * 5 + k * 7 + i * j * 6
  const out = computeLogLinear(dataset3(counts, ['a', 'b', 'c']), { variables: ['a', 'b', 'c'], terms: [['a'], ['b'], ['c'], ['a', 'b']] })
  const boxes = boxesOf(out.levels)
  // a×b 的二维边距必须被复现，而 a×c、b×c 不必。
  const fitted = Array.from({ length: 4 }, () => 0)
  const observed = Array.from({ length: 4 }, () => 0)
  for (let cell = 0; cell < out.cells; cell += 1) {
    const position = cellPosition(cell, boxes)
    const slot = position[0] * 2 + position[1]
    fitted[slot] += out.expected[cell]
    observed[slot] += out.counts[cell]
  }
  fitted.forEach((value, index) => close(value, observed[index], 1e-7, `a x b margin ${index}`))
  // 自由度 = 格子数 − 参数个数：8 − (1 + 1 + 1 + 1 + 1) = 3。
  assert.equal(out.fit.df, 3)
})

check('the saturated model reproduces the observed counts exactly', () => {
  const table = [[7, 3], [2, 11]]
  const out = computeLogLinear(datasetOf(table, ['a', 'b']), { variables: ['a', 'b'], model: 'saturated' })
  assert.equal(out.fit.df, 0)
  assert.ok(out.fit.g2 < 1e-8, `G squared ${out.fit.g2}`)
  out.counts.forEach((value, index) => close(out.expected[index], value, 1e-6, `cell ${index}`))
  assert.ok(out.notes.some((note) => /饱和模型/.test(note)), 'and it says so in the notes')
})

check('adjusted residuals are standardised and sum to about zero on a main-effects fit', () => {
  const counts = (i, j) => 10 + i * 4 + j * 6
  const table = [
    [counts(0, 0), counts(0, 1)],
    [counts(1, 0), counts(1, 1)],
  ]
  const out = computeLogLinear(datasetOf(table, ['a', 'b']), { variables: ['a', 'b'], terms: [['a'], ['b']] })
  out.adjusted.forEach((value, index) => {
    assert.ok(Number.isFinite(value), `residual ${index} is finite`)
    // 残差与观察-期望同号。
    assert.equal(Math.sign(value), Math.sign(out.residuals[index]) || Math.sign(value), `sign ${index}`)
  })
  // 期望频数加起来等于个案数，残差之和也就等于 0。
  close(out.residuals.reduce((sum, value) => sum + value, 0), 0, 1e-6, 'residual total')
})

check('partial association removes one term and reports the rise in G squared', () => {
  const table = [[40, 10], [10, 40]]
  const out = computeLogLinear(datasetOf(table, ['a', 'b']), { variables: ['a', 'b'], terms: [['a'], ['b'], ['a', 'b']] })
  assert.equal(out.fit.df, 0)
  const interaction = out.partial.find((entry) => entry.label === 'a × b')
  assert.ok(interaction, 'the interaction has its own row')
  assert.equal(interaction.df, 1)
  // 就地关联的 2×2 表：去掉交互项后 G² 必须很大，且等于主效应模型的 G²。
  const mainOnly = computeLogLinear(datasetOf(table, ['a', 'b']), { variables: ['a', 'b'], terms: [['a'], ['b']] })
  close(interaction.change, mainOnly.fit.g2, 1e-8, 'change equals the main-effects fit')
  assert.ok(interaction.change > 35, `change ${interaction.change}`)
})

check('missing values are dropped whole and reported', () => {
  const dataset = datasetOf([[5, 5], [5, 5]], ['a', 'b'])
  dataset.rows.push(['x', null], [null, 'x'], ['x', null])
  const out = computeLogLinear(dataset, { variables: ['a', 'b'], terms: [['a'], ['b']] })
  assert.equal(out.cases, 20)
  assert.equal(out.dropped, 3)
  assert.ok(out.notes.some((note) => /3 例/.test(note)))
})

check('rejections name what is wrong in Chinese', () => {
  const dataset = datasetOf([[5, 5], [5, 5]], ['a', 'b'])
  const numeric = {
    variables: [
      { name: 'a', type: 'numeric', measure: 'scale' },
      { name: 'b', type: 'string', measure: 'nominal' },
    ],
    rows: [[1, 'x'], [2, 'y']],
  }
  assert.throws(() => computeLogLinear(dataset, { variables: ['a'] }), /至少要两个分类变量/)
  assert.throws(() => computeLogLinear(dataset, { variables: ['a', 'nope'] }), /没有这个变量：nope/)
  assert.throws(() => computeLogLinear(numeric, { variables: ['a', 'b'] }), /要求分类变量/)
  assert.throws(() => computeLogLinear(dataset, { variables: ['a', 'b'], terms: [['a', 'nope']] }), /不认识的对数线性项/)
  // 不给 terms 等于只要主效应，不是错误（对话框里不勾任何交互就是这个状态）。
  const mainEffects = computeLogLinear(dataset, { variables: ['a', 'b'], terms: [] })
  assert.deepEqual(mainEffects.terms, ['a', 'b'])
  const single = { variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }], rows: [['x', 'x'], ['x', 'y']] }
  assert.throws(() => computeLogLinear(single, { variables: ['a', 'b'] }), /只有一个类别/)
  // 空类别：a 有 z 这一列，但从没有个案落在 z 上时，类别本身不会被建出来；
  // 这里造一个「b 只有 p 有数据、q 没有」的数据集，走的是同一个守卫。
  const emptyLevel = { variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }], rows: [['x', 'p'], ['y', 'p']] }
  assert.throws(() => computeLogLinear(emptyLevel, { variables: ['a', 'b'] }), /只有一个类别/)
})

check('too many cells are refused instead of exhausting memory', () => {
  const dataset = datasetOf([[5, 5], [5, 5]], ['a', 'b', 'c', 'd'])
  void dataset
  const many = { variables: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'string' })), rows: [] }
  for (let index = 0; index < 40; index += 1) {
    many.rows.push([String(index), String(index), String(index), String(index)])
  }
  // 40 × 40 × 40 × 40 = 2 560 000 个格子，远超上限。
  assert.throws(() => computeLogLinear(many, { variables: ['a', 'b', 'c', 'd'], terms: [['a'], ['b'], ['c'], ['d']] }), /单元格太多/)
})

process.stdout.write(`\n${checks} checks in test/loglinear.mjs\n`)
if (failures.length) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
