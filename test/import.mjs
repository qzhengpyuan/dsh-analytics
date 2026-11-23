// The import wizard asks `previewImport` what a file would become; the answer
// has to be the same thing `open` would build, or the preview is a lie. These
// checks run without the engine: importing a delimited file or a worksheet is
// pure string work, which is exactly why it is worth pinning down.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTable, importDelimited, decodeText } from '../lib/dataset.js'
import { Workspace } from '../lib/workspace.js'
import { zip } from './zip.mjs'

let checks = 0
const check = async (name, fn) => {
  try {
    await fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

await check('skipping counts the lines the user sees, blank lines included', async () => {
  // A file exported from a statistics package often starts with a title, a
  // blank line and a note. The number the user types is the line number in
  // their editor, so blank lines have to count.
  const text = '年度报表\n\n单位：万元\n年龄,收入\n21,3000\n34,5200\n'
  const imported = await importDelimited(text, { skipRows: 3 })
  assert.deepEqual(imported.variables.map((variable) => variable.name), ['V1', 'V2'])
  assert.equal(imported.rows.length, 2)
  assert.deepEqual(imported.rows[0], [21, 3000])
})

await check('a hand-picked variable name and type win over the guess', async () => {
  const imported = await importDelimited('年龄,编号\n21,甲\n34,乙\n', {
    names: ['age', 'code'],
    types: ['numeric', 'string'],
  })
  assert.deepEqual(imported.variables.map((variable) => `${variable.name}:${variable.type}`), ['age:numeric', 'code:string'])
  // The heading the user typed is still not a legal name, so it stays visible
  // as the label instead of vanishing.
  assert.equal(imported.variables[0].label, '年龄', 'the original heading follows the renamed column')
  assert.equal(imported.rows[0][1], '甲')
  const forced = await importDelimited('年龄,编号\n21,甲\n', { names: ['年龄', 'code'] })
  assert.equal(forced.variables[0].name, 'V1', 'a name that cannot be stored is still made safe')
  assert.ok(forced.notes.some((note) => note.includes('年龄')), 'and the rename is reported')
})

await check('a declared missing marker is stored as a user-missing value, not as data', async () => {
  const imported = await importDelimited('年龄,性别\n-9,男\n34,女\n,男\n', { missing: ['-9', 'NA'] })
  assert.equal(imported.variables[0].type, 'numeric', 'the marker does not turn the column into text')
  assert.deepEqual(imported.variables[0].missing, [-9])
  assert.equal(imported.rows[0][0], null, 'the marker cell is missing')
  assert.equal(imported.rows[1][0], 34)
  assert.ok(imported.notes.some((note) => note.includes('-9')), 'declaring it is reported')
})

await check('a marker in a text column is stored as a string missing value', async () => {
  const imported = await importDelimited('姓名\nNA\n张三\n', { missing: ['NA'] })
  assert.equal(imported.variables[0].type, 'string')
  assert.deepEqual(imported.variables[0].missing, ['NA'])
  assert.equal(imported.rows[0][0], null)
})

await check('a worksheet can skip its title rows too', async () => {
  const table = buildTable([['报表'], ['年龄', '收入'], [21, 3000]], { skipRows: 1 })
  assert.deepEqual(table.variables.map((variable) => variable.name), ['V1', 'V2'])
  assert.deepEqual(table.rows, [[21, 3000]])
  assert.throws(() => buildTable([['x']], { skipRows: 5 }), /跳过的行数/)
})

const workbook = () => zip([
  { name: 'xl/workbook.xml', text: '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" r:id="rId2"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>' },
  { name: 'xl/worksheets/sheet1.xml', text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="str"><v>年龄</v></c><c r="B1" t="str"><v>收入</v></c></row><row r="2"><c r="A2"><v>21</v></c><c r="B2"><v>3000</v></c></row></sheetData></worksheet>' },
  { name: 'xl/worksheets/sheet2.xml', text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="str"><v>备注</v></c></row></sheetData></worksheet>' },
])

const withWorkspace = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-analytics-import-'))
  const workspace = new Workspace({ id: 'import-check', engine: { bin: '/nonexistent' }, root, config: {} })
  await workspace.init()
  try {
    await fn(workspace, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await check('the preview describes the file without importing it', async () => {
  await withWorkspace(async (workspace, root) => {
    const path = join(root, 'raw.csv')
    writeFileSync(path, '标题\n年龄,性别\n21,男\n34,女\n')
    const preview = await workspace.previewImport(path, { skipRows: 1 })
    assert.equal(preview.kind, 'delimited')
    assert.equal(preview.totalRows, 2)
    assert.deepEqual(preview.columns.map((column) => column.name), ['V1', 'V2'])
    assert.equal(preview.rows.length, 2)
    assert.equal(preview.skipRows, 1)
    // Nothing was imported: the workspace still has no dataset.
    assert.equal(workspace.dataset, null)
  })
})

await check('the preview honours the same options the import will use', async () => {
  await withWorkspace(async (workspace, root) => {
    const path = join(root, 'gbk.csv')
    // "年龄" in GBK, which a UTF-8 read turns into replacement characters.
    writeFileSync(path, Buffer.from([0xc4, 0xea, 0xc1, 0xe4, 0x2c, 0x61, 0x0a, 0x32, 0x31, 0x2c, 0x78, 0x0a]))
    const asGbk = await workspace.previewImport(path, { encoding: 'gbk', names: ['age', 'tag'], types: ['numeric', 'string'] })
    assert.equal(asGbk.encoding, 'gbk')
    // The Chinese heading became V1 under UTF-8; under GBK it is a real word
    // that still cannot be a variable name, so the user's name wins.
    assert.deepEqual(asGbk.columns.map((column) => column.name), ['age', 'tag'])
    assert.deepEqual(asGbk.columns.map((column) => column.type), ['numeric', 'string'])
    const utf8 = decodeText(Buffer.from([0xc4, 0xea]), 'utf-8')
    assert.ok(utf8.length > 0)
  })
})

await check('an .xlsx preview names its sheets and reads the chosen one', async () => {
  await withWorkspace(async (workspace, root) => {
    const path = join(root, 'book.xlsx')
    writeFileSync(path, workbook())
    const first = await workspace.previewImport(path, {})
    assert.equal(first.kind, 'sheet')
    assert.deepEqual(first.sheets, ['数据', '备注'])
    assert.equal(first.sheet, '数据')
    assert.equal(first.totalRows, 1)
    const second = await workspace.previewImport(path, { sheet: '备注' })
    assert.equal(second.sheet, '备注')
    assert.deepEqual(second.columns.map((column) => column.name), ['V1'])
  })
})

await check('a format the wizard cannot read says which ones it can', async () => {
  await withWorkspace(async (workspace, root) => {
    const path = join(root, 'data.sav')
    writeFileSync(path, 'not a real sav')
    await assert.rejects(() => workspace.previewImport(path, {}), /csv.*xlsx|向导支持/)
  })
})


await check('a CSV skipped past its end says how many rows it skipped', async () => {
  // The worksheet path has always said this; the CSV path used to fall through
  // to buildTable and report the English "the file has no rows".
  await assert.rejects(
    () => importDelimited('a,b\n1,2\n3,4\n', { skipRows: 99 }),
    /跳过的行数（99）/,
  )
})

await check('a marker only clears a column of its own kind', async () => {
  // "-9" is a declared marker, but it is a number: a text column keeps it as
  // text instead of losing the cell without recording why.
  const table = await importDelimited('units\nA\n-9\nB\n', { missing: ['-9'] })
  const units = table.variables.find((variable) => variable.name === 'units')
  assert.equal(units.type, 'string')
  assert.deepEqual(units.missing ?? [], [])
  assert.deepEqual(table.rows.map((row) => row[0]), ['A', '-9', 'B'])
  // A numeric column still treats it as missing, and says so.
  const numbers = await importDelimited('n\n1\n-9\n3\n', { missing: ['-9'] })
  const n = numbers.variables.find((variable) => variable.name === 'n')
  assert.deepEqual(n.missing, [-9])
  assert.deepEqual(numbers.rows.map((row) => row[0]), [1, null, 3])
})

console.log(`${checks} checks passed`)
