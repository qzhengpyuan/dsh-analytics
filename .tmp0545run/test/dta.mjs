// Builds a Stata 118 .dta this test owns, then reads it back: the format is
// tagged, so a hand-made file exercises the same paths a Stata export would.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readDta } from '../lib/dta.js'

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

const pad = (value, length) => {
  const buffer = Buffer.alloc(length)
  buffer.write(String(value), 0, 'utf8')
  return buffer
}

const tag = (name, body) => Buffer.concat([Buffer.from(`<${name}>`, 'utf8'), body, Buffer.from(`</${name}>`, 'utf8')])
const u16 = (value) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }

const names = ['id', 'age', 'name', 'pass']
const types = [65526, 65529, 12, 65530] // double, int, str12, byte
const formats = ['%9.0g', '%8.0g', '%12s', '%8.0g']
const labelNames = ['', '', '', 'yesno']
const variableLabels = ['编号', '年龄', '姓名', '是否通过']

// K is a 16-bit word and N a 64-bit one; the label is an 81-byte field.
const header = tag('header', Buffer.concat([
  tag('release', Buffer.from('118')),
  tag('byteorder', Buffer.from('LSF')),
  tag('K', u16(names.length)),
  tag('N', u64(2)),
  tag('label', pad('测试数据', 81)),
  tag('timestamp', Buffer.from('05 Nov 2026 10:00')),
]))

// The reader locates sections by tag, so a blank map is enough here.
const map = tag('map', Buffer.alloc(14 * 8))

const data = Buffer.concat([
  Buffer.from([0, 0, 0, 0, 0, 0, 0xf8, 0x3f]), // 1.5 as a double
  u16(30),
  pad('张三', 12),
  Buffer.from([1]),
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x40]), // 2.0
  u16(32767), // missing int
  pad('', 12),
  Buffer.from([0]),
])

// Real layout: a small header, the padded name, n, txtlen, two words, the
// values as int32, then the label texts separated by NUL.
const labelText = Buffer.from('是\0否\0', 'utf8')
const valueLabels = tag('value_labels', Buffer.concat([
  Buffer.from('<lbl>'),
  u32(0),
  pad('yesno', 12),
  u32(2),
  u32(labelText.length),
  u32(0),
  u32(3),
  Buffer.concat([u32(1), u32(0)]),
  labelText,
  Buffer.from('</lbl>'),
]))

const file = Buffer.concat([
  Buffer.from('<stata_dta>'),
  header,
  map,
  tag('variable_types', Buffer.concat(types.map(u16))),
  tag('varnames', Buffer.concat(names.map((name) => pad(name, 33)))),
  tag('sortlist', Buffer.concat(Array.from({ length: names.length + 1 }, () => u16(0)))),
  tag('formats', Buffer.concat(formats.map((format) => pad(format, 57)))),
  tag('value_label_names', Buffer.concat(labelNames.map((name) => pad(name, 33)))),
  tag('variable_labels', Buffer.concat(variableLabels.map((label) => pad(label, 81)))),
  tag('characteristics', Buffer.alloc(0)),
  tag('data', data),
  tag('strls', Buffer.alloc(0)),
  valueLabels,
  Buffer.from('</stata_dta>'),
])

const book = readDta(file)

check('变量名、标签和类型来自文件本身', () => {
  assert.deepEqual(book.variables.map((variable) => variable.name), names)
  assert.deepEqual(book.variables.map((variable) => variable.label), variableLabels)
  assert.deepEqual(book.variables.map((variable) => variable.type), ['numeric', 'numeric', 'string', 'numeric'])
})

check('格式串转成 PSPP 的宽度与小数位', () => {
  assert.equal(book.variables[1].format, 'F8.0')
  assert.equal(book.variables[2].format, 'A12')
})

check('数值、字符串与缺失值都读对了', () => {
  assert.equal(book.rows[0][0], 1.5)
  assert.equal(book.rows[0][1], 30)
  assert.equal(book.rows[0][2], '张三')
  assert.equal(book.rows[0][3], 1)
  assert.equal(book.rows[1][0], 2)
  assert.equal(book.rows[1][1], null, '缺失的 int 必须是 null')
  assert.equal(book.rows[1][2], null, '空字符串必须是 null')
})

check('值标签挂回对应变量', () => {
  assert.deepEqual(book.variables[3].valueLabels, { 1: '是', 0: '否' })
})

check('旧版 dta 给出可读提示', () => {
  const legacy = Buffer.alloc(32)
  legacy[0] = 114
  assert.throws(() => readDta(legacy), /Stata 12 及更早/)
})

check('截断的文件不会被当成有效数据', () => {
  assert.throws(() => readDta(file.subarray(0, file.length - 10)), /数据段不完整|缺少/)
})

// A file written by R's haven (release 118, wider name fields) is the closest
// thing to a real Stata export: it covers the widening of varnames, labels and
// the binary value-label block.
check('由 haven 写出的真实 118 文件也能读', () => {
  const path = fileURLToPath(new URL('./fixtures/haven-118.dta', import.meta.url))
  const real = readDta(readFileSync(path))
  assert.deepEqual(real.variables.map((variable) => variable.name), ['id', 'age', 'name', 'pass'])
  assert.deepEqual(real.variables.map((variable) => variable.label), ['', '年龄', '', '是否通过'])
  assert.equal(real.rows.length, 3)
  assert.equal(real.rows[0][2], '张三')
  assert.equal(real.rows[1][1], null)
  assert.deepEqual(real.variables[3].valueLabels, { 1: '是', 0: '否' })
})

console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
