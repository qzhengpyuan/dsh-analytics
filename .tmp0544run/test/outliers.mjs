// Identify unusual cases, straight off lib/outliers.js. The percentile band
// and the "is this value outside it" decision are the plugin's own arithmetic,
// so they belong in a unit test — PSPP has no command to compare against.
import assert from 'node:assert/strict'
import { outlierReport } from '../lib/outliers.js'

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
const detailRows = (report) => report.details.matrix.slice(1)

check('the band comes from each variable own percentiles, and both tails flag', () => {
  const data = dataset([variable('x', 1, { label: '得分' })], [[1], [2], [3], [4], [5], [6], [7], [8], [9], [100]])
  const report = outlierReport(data, { percentiles: [10, 90] })
  assert.equal(report.variables, 1)
  assert.equal(report.flagged, 2)
  assert.equal(report.hits, 2)
  assert.deepEqual(report.flagCount, [1, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  const [header, low, high] = report.details.matrix
  assert.deepEqual(header, ['个案号', '变量', '值', '判定', '下界 / 上界'])
  assert.deepEqual(low.slice(0, 4), ['1', '得分', '1', '低于下界'])
  assert.deepEqual(high.slice(0, 4), ['10', '得分', '100', '高于上界'])
  assert.equal(low[4], '1.9 / 18.1')
  assert.equal(report.summary.matrix[1][4], '1')
  assert.equal(report.summary.matrix[1][5], '1')
})

check('no variables means every numeric variable, strings stay out', () => {
  const data = dataset(
    [variable('a', 1), { ...variable('b', 2), type: 'string', format: 'A8' }],
    [[1, 'x'], [2, 'y'], [3, 'z'], [4, 'w'], [5, 'v'], [100, 'u']],
  )
  const report = outlierReport(data, { percentiles: [10, 90] })
  assert.equal(report.variables, 1, 'the string variable is not measured against a percentile band')
  assert.equal(report.summary.matrix[1][0], 'a')
  assert.equal(report.hits, 2, 'the smallest value and the 100 are outside the band')
  assert.deepEqual(detailRows(report).map((row) => row[2]), ['1', '100'])
})

check('a declared missing code is absent, not extreme', () => {
  const data = dataset([variable('x', 1, { missing: [999] })], [[1], [2], [3], [4], [5], [6], [7], [8], [9], [999]])
  const report = outlierReport(data, { percentiles: [10, 90] })
  assert.equal(report.summary.matrix[1][1], '9', 'the 999 never enters the percentile computation')
  // 1 and 9 sit outside the 10/90 band of the nine real values; the 999 does not count at all.
  assert.equal(report.hits, 2)
  assert.equal(report.flagCount[9], 0)
})

check('the default band is 5 to 95 percent', () => {
  const data = dataset([variable('x', 1)], [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]])
  const report = outlierReport(data, {})
  assert.equal(report.lowPercent, 5)
  assert.equal(report.highPercent, 95)
  assert.equal(report.summary.matrix[0][2], '下界（5%）')
  assert.equal(report.summary.matrix[1][2], '1.45')
})

check('a nonsensical band falls back to 5 and 95 instead of throwing', () => {
  const data = dataset([variable('x', 1)], [[1], [2], [3], [4]])
  for (const percentiles of [[90, 10], [0, 100], [50, 50], ['a', 'b'], undefined]) {
    const report = outlierReport(data, { percentiles })
    assert.equal(report.lowPercent, 5, JSON.stringify(percentiles))
    assert.equal(report.highPercent, 95, JSON.stringify(percentiles))
  }
})

check('a case can be an outlier on several variables and the count says how many', () => {
  const data = dataset(
    [variable('x', 1), variable('y', 2)],
    [[5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [100, 100], [5, 5]],
  )
  const report = outlierReport(data, { percentiles: [10, 90] })
  // Row 7 is high on x and y both, so it counts once as a case but twice as a hit.
  assert.equal(report.flagged, 1)
  assert.equal(report.hits, 2)
  assert.equal(report.flagCount[6], 2, 'the case-level count is the number of variables it is out on')
})

check('nothing outside the band: one note says so and no rows are listed', () => {
  // All five values are identical, so both bounds sit on the value itself and
  // the comparison is strict: equal to the bound is not outside it.
  const data = dataset([variable('x', 1)], [[5], [5], [5], [5], [5]])
  const report = outlierReport(data, { percentiles: [10, 90] })
  assert.equal(report.hits, 0)
  assert.equal(detailRows(report).length, 0)
  assert.ok(report.details.notes[0].includes('没有个案越界'))
})

check('a variable with fewer than two values gets no bounds instead of NaN', () => {
  const data = dataset([variable('x', 1)], [[5]])
  const report = outlierReport(data, { percentiles: [5, 95] })
  assert.equal(report.summary.matrix[1][2], '·')
  assert.equal(report.summary.matrix[1][3], '·')
  assert.equal(report.hits, 0)
})

check('an empty dataset or a non-numeric one reports nothing', () => {
  assert.equal(outlierReport(null, {}), null)
  assert.equal(outlierReport(dataset([], []), {}), null)
  const strings = dataset([{ ...variable('s', 1), type: 'string', format: 'A8' }], [['a'], ['b']])
  const named = outlierReport(strings, { variables: ['s'] })
  assert.equal(named.hits, 0)
  assert.equal(named.summary.matrix[1][2], '·', 'a string variable gets no bounds')
  assert.ok(named.summary.notes.some((note) => note.includes('没有计算界值')), 'and the note names it')
})

check('only the first two hundred hits are listed, and a note says how many are hidden', () => {
  const rows = []
  for (let index = 0; index < 3000; index += 1) rows.push([index])
  const report = outlierReport(dataset([variable('x', 1)], rows), { percentiles: [10, 90] })
  assert.equal(detailRows(report).length, 200, 'the detail table stops at two hundred rows')
  assert.equal(report.hits, 600, 'the 10% and 90% tails of 3000 rows')
  assert.ok(report.details.notes.some((note) => note.includes('共 600 处')), 'and a note says how many were hidden')
})

console.log(`\n${passed} checks passed in test/outliers.mjs`)
