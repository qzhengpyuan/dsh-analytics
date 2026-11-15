// Reads a real .xlsx container that this test writes itself: an .xlsx is a ZIP
// of XML parts, so building one by hand keeps the test free of fixtures and of
// any dependency beyond node:zlib (which the reader uses).
import assert from 'node:assert/strict'
import { columnIndex, readXlsx } from '../lib/xlsx.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

import { zip } from './zip.mjs'

const workbookXml = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" r:id="rId2"/></sheets></workbook>`
const relsXml = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`
const sharedXml = `<?xml version="1.0"?><sst><si><t>学号</t></si><si><t>姓名</t></si><si><t>报名时间</t></si><si><r><t>张</t></r><r><t>三</t></r></si></sst>`
const stylesXml = `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`
const sheet1 = `<?xml version="1.0"?><worksheet><sheetData>`
  + `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>`
  + `<row r="2"><c r="A2"><v>1001</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" s="1"><v>45000</v></c></row>`
  + `<row r="3"><c r="A3"><v>1002</v></c><c r="B3" t="inlineStr"><is><t>李四</t></is></c></row>`
  + `<row r="4"/>`
  + `</sheetData></worksheet>`
const sheet2 = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="str"><v>备注</v></c></row></sheetData></worksheet>`

const book = readXlsx(zip([
  { name: 'xl/workbook.xml', text: workbookXml },
  { name: 'xl/_rels/workbook.xml.rels', text: relsXml },
  { name: 'xl/sharedStrings.xml', text: sharedXml },
  { name: 'xl/styles.xml', text: stylesXml },
  { name: 'xl/worksheets/sheet1.xml', text: sheet1 },
  { name: 'xl/worksheets/sheet2.xml', text: sheet2 },
]))

check('sheet names follow the workbook relationships', () => {
  assert.deepEqual(book.sheetNames, ['数据', '备注'])
})

check('cells resolve shared strings, inline strings and numbers', () => {
  assert.deepEqual(book.sheets[0].rows[0], ['学号', '姓名', '报名时间'])
  assert.deepEqual(book.sheets[0].rows[1], [1001, '张三', '2023-03-15'])
  assert.deepEqual(book.sheets[0].rows[2], [1002, '李四'])
})

check('a date cell becomes an ISO day, a bare number stays a number', () => {
  const [, row] = book.sheets[0].rows
  assert.equal(row[2], '2023-03-15')
  assert.equal(typeof row[0], 'number')
})

check('column references map to zero-based indexes', () => {
  assert.equal(columnIndex('A1'), 0)
  assert.equal(columnIndex('AB12'), 27)
  assert.equal(columnIndex(''), 0)
})

check('a file that is not a zip is rejected with a readable message', () => {
  assert.throws(() => readXlsx(Buffer.from('not a workbook')), /不是一个有效的 \.xlsx/)
})

// Some writers quote attributes with single quotes, and the spec allows a cell
// to omit r= entirely (it then follows the previous cell). Both used to break
// the reader: the first was invisible to the regex, the second put every value
// of the row into column A.
const sheetLoose = `<?xml version="1.0"?><worksheet><sheetData>`
  + `<row r='1'><c r='A1' t='inlineStr'><is><t>甲</t></is></c><c t='inlineStr'><is><t>乙</t></is></c><c t='inlineStr'><is><t>丙</t></is></c></row>`
  + `</sheetData></worksheet>`
const loose = readXlsx(zip([
  { name: 'xl/workbook.xml', text: workbookXml },
  { name: 'xl/_rels/workbook.xml.rels', text: relsXml },
  { name: 'xl/worksheets/sheet1.xml', text: sheetLoose },
]))
check('single-quoted attributes and cells without r= still land in the right column', () => {
  assert.deepEqual(loose.sheets[0].rows[0], ['甲', '乙', '丙'])
})


// The guard reads the decompressed size from the local header. It used to read
// the compressed one, so a 71 KB workbook that inflates to 70 MB sailed through
// and filled memory.
let capped = null
try {
  readXlsx(zip([{ name: 'xl/workbook.xml', text: 'A'.repeat(65 * 1024 * 1024) }]))
} catch (error) {
  capped = error
}
assert.ok(capped, 'the oversized workbook is refused')
assert.match(capped.message, /超过上限 64 MB/)
checks += 1
console.log('ok   a workbook that decompresses past the cap is refused, not read')

console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
