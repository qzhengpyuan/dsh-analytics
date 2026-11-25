// 经典多维标度：用「本来就活在某几维欧氏空间里」的点验坐标还原，用闭式解
// 验特征值，用归一化残差验 Stress。没有引擎答案可比（PSPP 2.1.3 无 ALSCAL）。
import assert from 'node:assert/strict'

import { computeMds } from '../lib/mds.js'

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

const datasetOf = (points, names = ['x', 'y']) => ({
  variables: names.map((name) => ({ name, type: 'numeric' })),
  rows: points.map((point) => [...point]),
})

const distance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]))

check('points that live in two dimensions are recovered with zero stress', () => {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1], [3, 2], [2, 4]]
  const out = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 2 })
  assert.equal(out.dimensions, 2)
  assert.equal(out.cases, 6)
  assert.ok(out.stress < 1e-10, `stress ${out.stress}`)
  // 距离必须原样还原：坐标可以旋转、翻转，但两两距离是唯一的判据。
  for (let row = 0; row < points.length; row += 1) {
    for (let column = row + 1; column < points.length; column += 1) {
      const fitted = distance(out.coordinates[row], out.coordinates[column])
      assert.ok(Math.abs(fitted - distance(points[row], points[column])) < 1e-9,
        `distance ${row}-${column}: ${fitted} vs ${distance(points[row], points[column])}`)
    }
  }
})

check('explained proportions sum to one and follow the eigenvalues', () => {
  const points = [[0, 0], [2, 0], [0, 2], [2, 2], [4, 0], [0, 4], [4, 4]]
  const out = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 2 })
  const sum = out.explained.reduce((total, value) => total + value, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12, `sum ${sum}`)
  const total = out.eigenvalues.reduce((acc, value) => acc + value, 0)
  out.explained.forEach((value, index) => {
    assert.ok(Math.abs(value - out.eigenvalues[index] / total) < 1e-12, `proportion ${index}`)
  })
  // 特征值必须降序，否则坐标与解释比例的次序会对不上。
  for (let index = 1; index < out.eigenvalues.length; index += 1) {
    assert.ok(out.eigenvalues[index] <= out.eigenvalues[index - 1] + 1e-12, `eigenvalue ${index} is ordered`)
  }
})

check('keeping fewer dimensions raises the stress, never lowers it', () => {
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [2, 1, 0]]
  const dataset = datasetOf(points, ['a', 'b', 'c'])
  const two = computeMds(dataset, { variables: ['a', 'b', 'c'], dimensions: 2 })
  const three = computeMds(dataset, { variables: ['a', 'b', 'c'], dimensions: 3 })
  assert.ok(two.stress > three.stress + 1e-9, `2d ${two.stress} should exceed 3d ${three.stress}`)
  assert.ok(three.stress < 1e-10, `three dimensions recover exactly: ${three.stress}`)
})

check('squared euclidean and city-block measures are applied as named', () => {
  // 一维里排得下的三个点（y 恒为 0），这样三种测度的 Stress 都该是 0。
  const points = [[0, 0], [2, 0], [5, 0]]
  const euclidean = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 1 })
  const squared = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 1, distance: 'sqeuclidean' })
  const block = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 1, distance: 'cityblock' })
  // 三个点排在一条直线上：欧氏与曼哈顿距离一维能完美还原；平方欧氏距离
  // 本身不是一个可嵌入的距离（2²、3²、5² 不满足三角等式），Stress 必然大于 0。
  assert.ok(euclidean.stress < 1e-10, `euclidean ${euclidean.stress}`)
  assert.ok(block.stress < 1e-10, `cityblock ${block.stress}`)
  assert.ok(squared.stress > 0.1 && squared.stress < 1, `sqeuclidean ${squared.stress}`)
  assert.equal(block.distanceLabel, '曼哈顿距离')
  assert.equal(squared.distanceLabel, '平方欧氏距离')
  assert.equal(euclidean.distanceLabel, '欧氏距离')
})

check('standardizing changes the distances when the scales differ', () => {
  const points = [[0, 5], [1, 6], [2, 7], [3, 8], [4, 9], [5, 10]]
  const raw = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 1 })
  const z = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 1, standardize: true })
  assert.equal(raw.standardized, false)
  assert.equal(z.standardized, true)
  // 标准化之后两个变量各自 z 分数为 −1.46…+1.46（n−1 口径），一维里仍能排下，
  // 但坐标的尺度必须不同：不标准化时 y 的量级是 x 的十倍。
  const rawSpan = Math.max(...raw.coordinates.map((point) => Math.abs(point[0])))
  const zSpan = Math.max(...z.coordinates.map((point) => Math.abs(point[0])))
  assert.ok(rawSpan > zSpan, `raw span ${rawSpan} vs standardized ${zSpan}`)
})

check('missing values drop the whole case and the note names the count', () => {
  const points = [[0, 0], [1, 1], [2, 2], [null, 3], [4, null]]
  const out = computeMds(datasetOf(points), { variables: ['x', 'y'], dimensions: 2 })
  assert.equal(out.cases, 3)
  assert.equal(out.dropped, 2)
  assert.ok(out.notes.some((note) => /2 个案的选中变量含缺失值/.test(note)))
})

check('degenerate input is refused with a reason', () => {
  const flat = [[2, 2], [2, 2], [2, 2], [2, 2]]
  assert.throws(() => computeMds(datasetOf(flat), { variables: ['x', 'y'] }), /距离矩阵退化/)
})

check('rejections say what is wrong in Chinese', () => {
  const points = [[0, 0], [1, 1], [2, 2]]
  const dataset = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }, { name: 'tag', type: 'string' }],
    rows: points.map(([x, y]) => [x, y, 'A']),
  }
  const run = (options) => () => computeMds(dataset, options)
  assert.throws(run({ variables: [] }), /要至少选一个数值变量/)
  assert.throws(run({ variables: ['nope'] }), /没有这个变量：nope/)
  assert.throws(run({ variables: ['tag'] }), /要求数值变量/)
  assert.throws(run({ variables: ['x'], distance: 'cosine' }), /不认识的距离测度/)
  assert.throws(run({ variables: ['x'], dimensions: 4 }), /维数要在 1 到 3 之间/)
  const few = { variables: dataset.variables.slice(0, 2), rows: [[0, 0], [1, 1]] }
  assert.throws(() => computeMds(few, { variables: ['x', 'y'] }), /可用个案太少/)
})

check('too many objects are refused rather than silently truncated', () => {
  const rows = []
  for (let index = 0; index < 130; index += 1) rows.push([index, index % 7])
  const dataset = datasetOf(rows)
  assert.throws(() => computeMds(dataset, { variables: ['x', 'y'] }), /个案太多：130 个/)
})

process.stdout.write(`\n${checks} checks in test/mds.mjs\n`)
if (failures.length > 0) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
