// 结构化数值：把「表格里印的数字」变成「能直接算的数字」，占位符一律 null。
import assert from 'node:assert/strict'

import { numbersOf, parseCell, toNumbers } from '../lib/numbers.js'

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

check('a printed number becomes a number', () => {
  assert.equal(parseCell('2'), 2)
  assert.equal(parseCell('7.500'), 7.5)
  assert.equal(parseCell('-.50'), -0.5)
  assert.equal(parseCell('1,234.5'), 1234.5)
  assert.equal(parseCell('+1.5e3'), 1500)
})

check('placeholders are not numbers', () => {
  // 空、破折号、点、N/A、`<0.001`、`+Infinit`、组名都不是数字 ——
  // 静默当 0 会让后面的计算悄悄算错。
  for (const value of ['', '—', '-', '.', '..', '/', 'N/A', 'n/a', '<0.001', '+Infinit', 'NaN', 'Valid', '男']) {
    assert.equal(parseCell(value), null, `${JSON.stringify(value)} 不该被当成数字`)
  }
  assert.equal(parseCell(null), null)
  assert.equal(parseCell(undefined), null)
})

check('a finite number passes straight through', () => {
  assert.equal(parseCell(3.25), 3.25)
  assert.equal(parseCell(Infinity), null)
  assert.equal(parseCell(NaN), null)
})

check('toNumbers keeps the header and flags a fully numeric table', () => {
  const table = toNumbers([['变量', 'N', '均值'], ['y', '6', '7.500'], ['x', '6', '4.500']])
  assert.deepEqual(table.columns, ['变量', 'N', '均值'])
  assert.deepEqual(table.rows, [['y', 6, 7.5], ['x', 6, 4.5]])
  assert.equal(table.numeric, false, '第一列是变量名，整表不算全数字')
  const numeric = toNumbers([['a', 'b'], ['1', '2'], ['3', '4']])
  assert.equal(numeric.numeric, true)
  assert.deepEqual(numeric.rows, [[1, 2], [3, 4]])
})

check('blank cells become null, other text stays text', () => {
  const table = toNumbers([['a', 'b'], ['y', ''], ['—', '<0.001']])
  assert.deepEqual(table.rows, [['y', null], [null, '<0.001']])
})

check('an empty matrix is reported, not crashed on', () => {
  const table = toNumbers([])
  assert.deepEqual(table.rows, [])
  assert.equal(table.numeric, false)
  assert.match(table.note, /空的/)
})

check('numbersOf carries the title, the run and the notes', () => {
  const items = [
    { kind: 'table', title: '描述统计', plugin: true, provenance: { runId: 7 }, table: { matrix: [['变量', 'N'], ['y', '6']] }, notes: ['注：缺失 1 例'] },
    { kind: 'image', title: '图' },
  ]
  const tables = numbersOf(items)
  assert.equal(tables.length, 1)
  assert.equal(tables[0].title, '描述统计')
  assert.equal(tables[0].runId, 7)
  assert.equal(tables[0].pluginComputed, true)
  assert.deepEqual(tables[0].notes, ['注：缺失 1 例'])
  assert.deepEqual(tables[0].rows, [['y', 6]])
})

console.log(`\nnumbers: ${checks} checks passed`)
