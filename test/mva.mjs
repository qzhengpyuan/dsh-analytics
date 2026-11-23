// Missing-value analysis and replacement, straight off lib/mva.js: PSPP has no
// MVA and no RMV, so these tables are the plugin's own arithmetic and the only
// place the numbers can be checked without the engine.
import assert from 'node:assert/strict'
import { isMissing, univariateTable, patternTable, mvaTables, replaceMissing, formatNumber } from '../lib/mva.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`ok  ${name}`)
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const variable = (name, position, extra = {}) => ({
  name, position, type: 'numeric', width: 8, decimals: 2, format: 'F8.2', measure: 'scale', alignment: 'right', missing: [], valueLabels: {}, ...extra,
})
const dataset = (variables, rows) => ({ variables, rows })

check('a blank, a declared code and a non-number all count as missing', () => {
  const age = variable('age', 1, { missing: [999, { lo: -1, hi: -1 }] })
  assert.equal(isMissing(age, null), true)
  assert.equal(isMissing(age, ''), true)
  assert.equal(isMissing(age, 999), true)
  assert.equal(isMissing(age, -1), true)
  assert.equal(isMissing(age, 'abc'), true)
  assert.equal(isMissing(age, 0), false)
  assert.equal(isMissing(age, 999.5), false)
  const text = { name: 's', position: 2, type: 'string', missing: ['NA'] }
  assert.equal(isMissing(text, 'NA'), true)
  assert.equal(isMissing(text, '  '), true)
  assert.equal(isMissing(text, 'N/A'), false)
})

check('numbers print without a trailing zero tail, and nothing prints as a dot', () => {
  assert.equal(formatNumber(2), '2')
  assert.equal(formatNumber(2.5), '2.5')
  assert.equal(formatNumber(2.25), '2.25')
  assert.equal(formatNumber(-1.50), '-1.5')
  assert.equal(formatNumber(null), '.')
  assert.equal(formatNumber(Number.NaN), '.')
})

check('univariate statistics count the cases the other tables count', () => {
  const data = dataset([variable('a', 1, { missing: [999] }), variable('b', 2)], [
    [1, 2], [2, null], [999, 4], [4, 5], [null, 6],
  ])
  const built = univariateTable(data, ['a', 'b'])
  assert.deepEqual(built.matrix[0], ['变量', 'N', '平均值', '标准差', '最小值', '最大值', '缺失', '缺失 %'])
  const a = built.matrix[1]
  assert.equal(a[0], 'a')
  assert.equal(a[1], '3', 'the declared 999 and the blank are both out')
  assert.equal(a[2], '2.33')
  assert.equal(a[6], '2')
  assert.equal(a[7], '40.0%')
  const b = built.matrix[2]
  assert.equal(b[1], '4')
  assert.equal(b[6], '1')
  assert.equal(b[7], '20.0%')
})

check('a string variable gets counts only, and says so', () => {
  const data = dataset([variable('s', 1, { type: 'string', format: 'A8' })], [['x'], [null], ['y']])
  const built = univariateTable(data, ['s'])
  assert.equal(built.matrix[1][1], '2')
  assert.equal(built.matrix[1][2], '.')
  assert.ok(built.notes.some((note) => note.includes('字符串变量')))
})

check('patterns are listed most common first, with a running total', () => {
  const data = dataset([variable('a', 1), variable('b', 2)], [
    [1, 2], [2, null], [3, 4], [null, 5], [null, null],
  ])
  const built = patternTable(data, ['a', 'b'])
  assert.deepEqual(built.matrix[0], ['缺失模式（a）', '缺失模式（b）', '个案数', '百分比', '累计百分比'])
  assert.deepEqual(built.matrix[1], ['X', 'X', '2', '40.0%', '40.0%'])
  assert.equal(built.matrix.at(-1)[4], '100.0%')
  assert.ok(built.notes.some((note) => note.includes('完全没有缺失的个案 2 个')))
})

check('the table set can be narrowed, and unknown variables are named', () => {
  const data = dataset([variable('a', 1)], [[1], [null]])
  assert.equal(mvaTables(data, ['a'], { patterns: false }).length, 1)
  assert.equal(mvaTables(data, ['a'], { univariate: false })[0].title, '缺失模式')
  assert.throws(() => mvaTables(data, ['nope']), /没有这些变量：nope/)
  assert.throws(() => mvaTables(data, []), /at least one variable/)
})

check('series mean fills every blank with the same number', () => {
  const data = dataset([variable('a', 1)], [[2], [null], [4]])
  const changes = replaceMissing(data, ['a'], 'mean')
  assert.deepEqual(changes, [{ row: 1, variable: 'a', value: 3 }])
})

check('linear interpolation runs between neighbours and pads the ends', () => {
  const data = dataset([variable('a', 1)], [[null], [2], [null], [6], [null], [10], [null]])
  const changes = replaceMissing(data, ['a'], 'linear')
  assert.deepEqual(changes.map((entry) => entry.value), [2, 4, 8, 10])
  assert.deepEqual(changes.map((entry) => entry.row), [0, 2, 4, 6])
})

check('nearby copies the closest present value, looking back first', () => {
  const data = dataset([variable('a', 1)], [[null], [5], [null], [null], [9]])
  const changes = replaceMissing(data, ['a'], 'nearby')
  assert.deepEqual(changes, [
    { row: 0, variable: 'a', value: 5 },
    { row: 2, variable: 'a', value: 5 },
    { row: 3, variable: 'a', value: 5 },
  ])
})

check('a declared missing code is replaced, a string variable is refused', () => {
  const code = dataset([variable('a', 1, { missing: [999] })], [[1], [999], [3]])
  assert.deepEqual(replaceMissing(code, ['a'], 'mean').map((entry) => entry.value), [2])
  const text = dataset([variable('s', 1, { type: 'string' })], [['a'], [null]])
  assert.throws(() => replaceMissing(text, ['s'], 'mean'), /只处理数值变量/)
  const empty = dataset([variable('a', 1)], [[null], [null]])
  assert.throws(() => replaceMissing(empty, ['a'], 'mean'), /整列都是缺失值/)
  assert.throws(() => replaceMissing(code, ['a'], 'median'), /不认识的替换方法/)
})

check('nearby mean and median differ when the neighbourhood is skewed', () => {
  const data = dataset([variable('a', 1)], [[null], [1], [null], [2], [null], [100], [null]])
  const means = replaceMissing(data, ['a'], 'nearbyMean', { span: 2 })
  assert.deepEqual(means.map((entry) => entry.row), [0, 2, 4, 6])
  assert.deepEqual(means.map((entry) => entry.value), [1.5, 34.333333333333336, 34.333333333333336, 51])
  const medians = replaceMissing(data, ['a'], 'nearbyMedian', { span: 2 })
  assert.deepEqual(medians.map((entry) => entry.value), [1.5, 2, 2, 51])
})

check('the trend method evaluates the least-squares line at the blank', () => {
  const data = dataset([variable('a', 1)], [[null], [2], [null], [4], [null]])
  const changes = replaceMissing(data, ['a'], 'trend')
  assert.deepEqual(changes.map((entry) => entry.row), [0, 2, 4])
  assert.deepEqual(changes.map((entry) => entry.value), [1, 3, 5])
})

check('a span of zero falls back to one point, and the method list is named in the error', () => {
  const data = dataset([variable('a', 1)], [[null], [3], [null]])
  const changes = replaceMissing(data, ['a'], 'nearbyMean', { span: 0 })
  assert.deepEqual(changes.map((entry) => entry.value), [3, 3])
  assert.throws(() => replaceMissing(data, ['a'], 'mode'), /nearbyMedian/)
})

console.log(`mva: ${passed} checks passed`)
