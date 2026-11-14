// Variable reordering: the host reorders variables and every row's cells
// together, so a column can never end up attached to the wrong variable.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../lib/workspace.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`not ok  ${name}\n    ${error.message}`)
  }
}

const make = () => {
  const workspace = new Workspace({ id: 'order', root: mkdtempSync(join(tmpdir(), 'order-')) })
  workspace.dataset = {
    variables: ['ID', 'Before', 'After', 'Diff'].map((name, index) => ({ name, position: index + 1 })),
    rows: [[1, 10, 12, 2], [2, 20, 18, -2], [3, 30, 33, 3]],
  }
  return workspace
}

check('moving a variable to the front carries its column', () => {
  const workspace = make()
  const result = workspace.moveVariable('Diff', 1)
  assert.deepEqual(result.order, ['Diff', 'ID', 'Before', 'After'])
  assert.deepEqual(workspace.dataset.rows[0], [2, 1, 10, 12])
  assert.deepEqual(workspace.dataset.rows[2], [3, 3, 30, 33])
})

check('moving to the end keeps every row aligned', () => {
  const workspace = make()
  workspace.moveVariable('ID', 4)
  assert.deepEqual(workspace.dataset.variables.map((entry) => entry.name), ['Before', 'After', 'Diff', 'ID'])
  assert.deepEqual(workspace.dataset.rows[1], [20, 18, -2, 2])
})

check('positions are rewritten to 1..n after the move', () => {
  const workspace = make()
  workspace.moveVariable('After', 2)
  assert.deepEqual(workspace.dataset.variables.map((entry) => entry.position), [1, 2, 3, 4])
})

check('a move is one undo entry and undo puts the order back', () => {
  const workspace = make()
  workspace.moveVariable('Diff', 1)
  assert.equal(workspace.undoStack.at(-1).label, '调整变量顺序')
  workspace.undo()
  assert.deepEqual(workspace.dataset.variables.map((entry) => entry.name), ['ID', 'Before', 'After', 'Diff'])
  assert.deepEqual(workspace.dataset.rows[0], [1, 10, 12, 2])
})

check('an out-of-range position is clamped instead of throwing', () => {
  const workspace = make()
  workspace.moveVariable('After', 99)
  assert.deepEqual(workspace.dataset.variables.map((entry) => entry.name), ['ID', 'Before', 'Diff', 'After'])
})

check('an unknown variable is refused', () => {
  const workspace = make()
  assert.throws(() => workspace.moveVariable('Nope', 1), /unknown variable: Nope/)
})

check('a paste past the last case grows the table', () => {
  const workspace = make()
  const cells = []
  for (let row = 0; row < 5; row += 1) {
    for (const [column, name] of ['ID', 'Before', 'After', 'Diff'].entries()) {
      cells.push({ row, variable: name, value: row * 10 + column })
    }
  }
  const result = workspace.setCells(cells, { extend: true })
  assert.equal(workspace.dataset.rows.length, 5, 'two new cases')
  assert.equal(result.addedCases, 2)
  assert.equal(workspace.dataset.variables.length, 4)
  assert.deepEqual(workspace.dataset.rows[4], ['40', '41', '42', '43'], 'every pasted value landed in its own column')
})

check('an extending paste grows cases but never duplicates a variable', () => {
  const workspace = make()
  const cells = [{ row: 3, variable: 'ID', value: 4 }, { row: 4, variable: 'Diff', value: 7 }]
  const result = workspace.setCells(cells, { extend: true })
  assert.equal(workspace.dataset.rows.length, 5)
  assert.equal(result.addedCases, 2)
  assert.equal(result.addedVariables, 0)
  assert.equal(workspace.dataset.rows[4][3], '7', 'a string variable keeps the pasted text')
})

// A block copied from a spreadsheet past the last column carries V<n>
// placeholders; they must create real variables, not fail the paste.
check('an extending paste past the last variable creates the columns', () => {
  const workspace = make()
  const result = workspace.setCells([
    { row: 0, variable: 'V5', value: 5 },
    { row: 0, variable: 'V6', value: 6 },
  ], { extend: true })
  assert.equal(result.addedVariables, 2)
  assert.deepEqual(workspace.dataset.variables.map((entry) => entry.name).slice(-2), ['V5', 'V6'])
  assert.equal(workspace.dataset.rows[0][5], 6, 'the pasted value landed in the new column')
})

if (failed) process.exitCode = 1

check('renaming a variable keeps its column and can be undone', () => {
  const workspace = make()
  assert.equal(workspace.updateVariable('Before', { name: 'pre' }).name, 'pre')
  assert.deepEqual(workspace.dataset.variables.map((variable) => variable.name), ['ID', 'pre', 'After', 'Diff'])
  assert.deepEqual(workspace.dataset.rows[0], [1, 10, 12, 2])
  workspace.undo()
  assert.deepEqual(workspace.dataset.variables.map((variable) => variable.name), ['ID', 'Before', 'After', 'Diff'])
})

check('a rename is refused when the name is taken or illegal', () => {
  const workspace = make()
  assert.throws(() => workspace.updateVariable('ID', { name: 'after' }), /已经有同名变量/)
  assert.throws(() => workspace.updateVariable('ID', { name: '2nd' }), /变量名不合法/)
  assert.throws(() => workspace.updateVariable('ID', { name: '  ' }), /变量名不能为空/)
  assert.deepEqual(workspace.dataset.variables.map((variable) => variable.name), ['ID', 'Before', 'After', 'Diff'])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
