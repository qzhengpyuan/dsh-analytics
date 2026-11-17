// Identify Duplicate Cases, straight off lib/dupes.js. PSPP has no duplicate
// command at all, so the grouping, the sequence numbers and the last-of-group
// flag are the plugin's own arithmetic and belong in a unit test.
import assert from 'node:assert/strict'
import { duplicateReport } from '../lib/dupes.js'

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

const flat = (report) => report.matrix.slice(1).map((row) => row.join('|'))

check('a repeated key becomes one group, with sequence numbers and a last flag', () => {
  const data = dataset(
    [variable('id', 1), variable('score', 2)],
    [[1, 10], [2, 20], [1, 10], [3, 30], [1, 10]],
  )
  const report = duplicateReport(data, { variables: ['id', 'score'] })
  assert.equal(report.groups, 1)
  assert.equal(report.duplicates, 3)
  assert.deepEqual(report.sequence, [1, 0, 2, 0, 3])
  assert.deepEqual(report.lastOfGroup, [0, 0, 0, 0, 1])
  // 个案号 is 1-based and refers to the row, not the group.
  assert.deepEqual(flat(report), ['1|1|10|1|1|', '1|1|10|3|2|', '1|1|10|5|3|是'])
})

check('two different groups stay separate, and unique rows carry sequence 0', () => {
  const data = dataset(
    [variable('id', 1)],
    [[7], [8], [7], [8], [9]],
  )
  const report = duplicateReport(data, { variables: ['id'] })
  assert.equal(report.groups, 2)
  assert.equal(report.duplicates, 4)
  assert.deepEqual(report.sequence, [1, 1, 2, 2, 0])
  assert.deepEqual(report.lastOfGroup, [0, 0, 1, 1, 0])
  assert.equal(report.matrix[0].join('|'), '组|id|个案号|组内序号|是否末条')
  assert.equal(report.notes[0], '按键变量 id 分组：共 5 个个案，其中 4 个落在 2 组重复里')
})

check('a declared missing code keeps the row out of the comparison', () => {
  const data = dataset(
    [variable('id', 1, { missing: [999] })],
    [[999], [999], [5], [5]],
  )
  const report = duplicateReport(data, { variables: ['id'] })
  // The two 999s are each their own key, so only the 5/5 pair repeats.
  assert.equal(report.groups, 1)
  assert.equal(report.duplicates, 2)
  assert.deepEqual(report.sequence, [0, 0, 1, 2])
  assert.ok(report.notes.at(-1).includes('声明为缺失的码不参与比对'))
})

check('no key variables means every variable together', () => {
  const data = dataset(
    [variable('a', 1), variable('b', 2)],
    [['x', 1], ['x', 1], ['x', 2]],
  )
  const report = duplicateReport(data, {})
  assert.equal(report.groups, 1)
  assert.equal(report.duplicates, 2)
  assert.deepEqual(report.sequence, [1, 2, 0])
})

check('an empty key part still matches an empty key part', () => {
  const data = dataset(
    [variable('a', 1), { ...variable('b', 2), type: 'string', format: 'A8' }],
    [[1, null], [1, ''], [1, 'x']],
  )
  const report = duplicateReport(data, { variables: ['a', 'b'] })
  assert.equal(report.groups, 1)
  assert.equal(report.duplicates, 2)
  assert.deepEqual(report.sequence, [1, 2, 0])
})

check('nothing repeats: one note says so and nothing is listed', () => {
  const data = dataset([variable('id', 1)], [[1], [2], [3]])
  const report = duplicateReport(data, { variables: ['id'] })
  assert.equal(report.groups, 0)
  assert.equal(report.duplicates, 0)
  assert.equal(report.matrix.length, 1)
  assert.ok(report.notes.some((note) => note.includes('没有发现重复个案')))
})

check('unknown variable names fall back to every variable', () => {
  const data = dataset([variable('id', 1)], [[1], [1]])
  const report = duplicateReport(data, { variables: ['nope'] })
  assert.equal(report.groups, 1)
  assert.deepEqual(report.sequence, [1, 2])
})

check('an empty dataset reports nothing instead of throwing', () => {
  assert.equal(duplicateReport(null, {}), null)
  assert.equal(duplicateReport(dataset([], []), {}), null)
  const report = duplicateReport(dataset([variable('id', 1)], []), { variables: ['id'] })
  assert.equal(report.groups, 0)
  assert.equal(report.matrix.length, 1)
})

check('only the first fifty groups are listed, and a note says how many are hidden', () => {
  const rows = []
  for (let group = 0; group < 55; group += 1) {
    rows.push([group], [group])
  }
  const report = duplicateReport(dataset([variable('id', 1)], rows), { variables: ['id'] })
  assert.equal(report.groups, 55)
  assert.equal(report.duplicates, 110)
  assert.equal(report.matrix.length, 1 + 50 * 2)
  assert.ok(report.notes.some((note) => note.includes('表里只列出前 50 组（共 55 组）')))
})

console.log(`\n${passed} checks passed in test/dupes.mjs`)
