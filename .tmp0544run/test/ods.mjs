// Reads an .ods container this test writes itself: an ODS is a ZIP whose
// content.xml describes the sheets, so no fixture files are needed.
import assert from 'node:assert/strict'
import { readOds } from '../lib/ods.js'
import { zip } from './zip.mjs'

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

const namespace = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
  + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
  + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'

const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${namespace}><office:body><office:spreadsheet>
  <table:table table:name="问卷">
    <table:table-row>
      <table:table-cell office:value-type="string"><text:p>编号</text:p></table:table-cell>
      <table:table-cell office:value-type="string"><text:p>姓名</text:p></table:table-cell>
      <table:table-cell office:value-type="string"><text:p>得分</text:p></table:table-cell>
    </table:table-row>
    <table:table-row>
      <table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>
      <table:table-cell office:value-type="string"><text:p>张三</text:p></table:table-cell>
      <table:table-cell office:value-type="float" office:value="88.5"><text:p>88.5</text:p></table:table-cell>
    </table:table-row>
    <table:table-row>
      <table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="2"/>
      <table:table-cell office:value-type="string"><text:p>李<text:s text:c="2"/>四</text:p></table:table-cell>
    </table:table-row>
    <table:table-row>
      <table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>
      <table:covered-table-cell/>
      <table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>
    </table:table-row>
    <table:table-row table:number-rows-repeated="5000"/>
  </table:table>
  <table:table table:name="备注">
    <table:table-row>
      <table:table-cell office:value-type="string"><text:p>说明</text:p></table:table-cell>
    </table:table-row>
  </table:table>
</office:spreadsheet></office:body></office:document-content>`

const book = readOds(zip([{ name: 'content.xml', text: content }]))

check('sheet names come from table:name', () => {
  assert.deepEqual(book.sheetNames, ['问卷', '备注'])
})

check('typed cells keep their values (numbers stay numbers)', () => {
  assert.deepEqual(book.sheets[0].rows[0], ['编号', '姓名', '得分'])
  assert.deepEqual(book.sheets[0].rows[1], [1, '张三', 88.5])
  assert.equal(typeof book.sheets[0].rows[1][2], 'number')
})

check('repeated columns expand and text:s keeps its spaces', () => {
  assert.deepEqual(book.sheets[0].rows[2], [2, 2, '李  四'])
})

check('covered cells become empty, booleans become 1/0', () => {
  assert.deepEqual(book.sheets[0].rows[3], [3, null, 1])
})

check('a long run of empty repeated rows is not materialised', () => {
  // 5000 empty rows would bloat the import; the reader stops at the data.
  assert.ok(book.sheets[0].rows.length < 100, String(book.sheets[0].rows.length))
})

check('a file that is not a zip is rejected with a readable message', () => {
  assert.throws(() => readOds(Buffer.from('not a spreadsheet')), /不是一个有效的 \.ods/)
})

console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
