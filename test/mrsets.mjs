// Multiple response sets are counted here, not by PSPP: these cases pin the
// three shapes SPSS tabulates (dichotomy, categorical, counted per respondent).
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeSet,
  parseMrSetAttribute,
  mrsetsSyntax,
  tabulate,
  frequencyMatrix,
  crosstab,
} from '../lib/mrsets.js'
import { readMrSetsFromFile } from '../lib/workspace.js'

let checks = 0
const check = (name, fn) => {
  checks += 1
  try {
    fn()
    console.log(`ok ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const variables = [
  { name: 'q1a', type: 'numeric', label: '认同 A', valueLabels: { '0': '否', '1': '是' }, missing: [] },
  { name: 'q1b', type: 'numeric', label: '认同 B', valueLabels: { '0': '否', '1': '是' }, missing: [] },
  { name: 'q1c', type: 'numeric', label: '认同 C', valueLabels: { '0': '否', '1': '是' }, missing: [] },
  {
    name: 'brand',
    type: 'numeric',
    label: '品牌',
    valueLabels: { '1': '甲', '2': '乙', '3': '丙' },
    missing: [9],
  },
  { name: 'gender', type: 'numeric', label: '性别', valueLabels: { '1': '女', '2': '男' }, missing: [] },
  { name: 'name', type: 'string', width: 8, valueLabels: {}, missing: [] },
]

// q1a..q1c: 1 = 打过勾；brand 是「最多选三」的三列；gender 一分组
const rows = [
  [1, 1, 0, 1, 1, 1],
  [1, 0, 1, 2, 9, 1],
  [0, 1, 1, 3, 2, 2],
  [1, 1, 1, 0, 3, 2],
  [0, 0, 0, 1, 1, 1],
]

const dichotomy = { kind: 'mcgroup', name: '$q1', label: '认同', variables: ['q1a', 'q1b', 'q1c'] }

check('a dichotomy set counts the checked variables, once per case', () => {
  const set = normalizeSet(dichotomy, variables)
  const result = tabulate(set, variables, rows)
  // q1a: 行 1,2,4 → 3；q1b: 1,3,4 → 3；q1c: 2,3,4 → 3
  assert.deepEqual(result.categories.map((entry) => entry.count), [3, 3, 3])
  assert.equal(result.responses, 9)
  assert.equal(result.respondents, 4, '第 5 行一个都没打勾')
  assert.equal(result.cases, 5)
})

check('percentages use responses as the base and cases for the last column', () => {
  const matrix = frequencyMatrix(tabulate(normalizeSet(dichotomy, variables), variables, rows))
  assert.deepEqual(matrix[0], ['', '响应数', '百分比', '个案百分比'])
  assert.deepEqual(matrix[1], ['认同 A', '3', '33.3%', '60.0%'])
  assert.equal(matrix.at(-1)[0], '总计')
  assert.equal(matrix.at(-1)[1], '9')
})

check('a categorical set counts the chosen values and labels them', () => {
  const set = normalizeSet(
    { kind: 'mdgroup', name: '$brand', variables: ['brand'], value: [1, 2, 3] },
    variables,
  )
  const result = tabulate(set, variables, rows)
  assert.deepEqual(result.categories.map((entry) => entry.label), ['甲', '乙', '丙'])
  // 行1=甲 行2=乙 行3=丙 行4=0（不计）行5=甲
  assert.deepEqual(result.categories.map((entry) => entry.count), [2, 1, 1])
  assert.equal(result.responses, 4)
  assert.equal(result.respondents, 4)
  assert.equal(result.categories[0].cases, 2)
})

check('a value outside /VALUE is not counted, and declared missing values are skipped', () => {
  const set = normalizeSet({ kind: 'mdgroup', name: '$b2', variables: ['brand'], value: [9] }, variables)
  const result = tabulate(set, variables, rows)
  assert.equal(result.responses, 0, '9 是缺失值，即使写进 VALUE 也不算')
  const set2 = normalizeSet({ kind: 'mdgroup', name: '$b3', variables: ['brand'], value: [1] }, variables)
  assert.equal(tabulate(set2, variables, rows).responses, 2, '行1 与行5 都选了甲')
})

check('counted per respondent counts one answer from each case', () => {
  const set = normalizeSet(
    { kind: 'mdgroup', name: '$b4', variables: ['brand'], value: [1, 2, 3], counted: 'respondents' },
    variables,
  )
  const result = tabulate(set, variables, rows)
  // 每行只记第一列：行1=甲 行2=乙 行3=丙 行4=(0 不计) 行5=甲
  assert.equal(result.responses, 4)
  assert.equal(result.respondents, 4)
  assert.deepEqual(result.categories.map((entry) => entry.count), [2, 1, 1])
})

check('cross tabulation splits the set by a grouping variable', () => {
  const matrix = crosstab(normalizeSet(dichotomy, variables), 'gender', variables, rows)
  assert.deepEqual(matrix[0], ['', '女', '男', '总计'])
  // 行2 与行4 的 gender=9 没有值标签，不算一个分组；因此只剩女、男两列
  const q1a = matrix.find((row) => row[0] === '认同 A')
  assert.deepEqual(q1a, ['认同 A', '1', '0', '1'])
  const q1b = matrix.find((row) => row[0] === '认同 B')
  assert.deepEqual(q1b, ['认同 B', '1', '1', '2'])
})

check('definitions refuse what PSPP would refuse', () => {
  assert.throws(() => normalizeSet({ kind: 'mcgroup', name: '$q1', variables: ['nope'] }, variables), /没有变量/)
  assert.throws(() => normalizeSet({ kind: 'mcgroup', name: '$q1', variables: ['name'] }, variables), /字符串/)
  assert.throws(() => normalizeSet({ kind: 'mcgroup', name: '$q1', variables: [] }, variables), /至少要选/)
  assert.throws(() => normalizeSet({ kind: 'mdgroup', name: '$q1', variables: ['brand'] }, variables), /计数哪些值/)
  assert.throws(() => normalizeSet({ kind: 'mcgroup', name: 'bad name', variables: ['q1a'] }, variables), /合法的 SPSS 变量名/)
  // PSPP rejects a set name without '$', so a plain one is prefixed rather than
  // rejected; SPSS displays the same '$'-prefixed name.
  assert.equal(normalizeSet({ kind: 'mcgroup', name: 'q1', variables: ['q1a'] }, variables).name, '$q1')
})

check('definitions are recovered from the attribute PSPP writes', () => {
  // These five strings are copied verbatim out of .sav files written by PSPP
  // 2.1.3; the parser is best-effort by design, so pin what it must recover.
  const vars = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'id' }, { name: 'tg' }]
  assert.deepEqual(
    parseMrSetAttribute('$m1=C 6 组一 a b', vars),
    { name: '$m1', label: '组一', kind: 'mcgroup', variables: ['a', 'b'], value: null },
  )
  assert.deepEqual(
    parseMrSetAttribute('$m2=D1 1 6 组二 a b c', vars),
    { name: '$m2', label: '组二', kind: 'mdgroup', variables: ['a', 'b', 'c'], value: [1] },
  )
  // Labels keep their inner spaces; an empty label stays empty.
  assert.equal(parseMrSetAttribute('$lab=C 11 组 一 甲 a c', vars).label, '组 一 甲')
  assert.equal(parseMrSetAttribute('$two=D1 2 0  b c', vars).label, '')
  // Anything the dictionary does not confirm is dropped instead of guessed.
  assert.equal(parseMrSetAttribute('$x=C 6 组一 a unknownvar', vars), null, 'fewer than two known variables')
  assert.equal(parseMrSetAttribute('plain text', vars), null)
})

check('the saved syntax is the form PSPP accepts', () => {
  assert.equal(
    mrsetsSyntax(normalizeSet(dichotomy, variables)),
    "MRSETS /MCGROUP NAME=$q1 LABEL='认同' VARIABLES=q1a q1b q1c.",
  )
  // PSPP 2.1.3 rejects /VARIABLES=… /VALUE=…; it wants them without slashes.
  assert.equal(
    mrsetsSyntax(normalizeSet({ kind: 'mdgroup', name: '$b', variables: ['brand'], value: [1, 2] }, variables)),
    // PSPP takes one value per subcommand and a repeat under the same name
    // replaces the first, so the saved form records the first value only and
    // says which ones the panel counted in the label.
    "MRSETS /MDGROUP NAME=$b LABEL='（值 1/2，PSPP 只记 1）' VARIABLES=brand VALUE=1.",
  )
})

check('an empty category list can add the labelled values at zero', () => {
  const set = normalizeSet(
    { kind: 'mdgroup', name: '$b5', variables: ['brand'], value: [1, 2, 3], empty: 'include' },
    variables,
  )
  const few = rows.map((row) => [row[0], row[1], row[2], 1, row[4], row[5]])
  const result = tabulate(set, variables, few)
  assert.ok(result.categories.some((entry) => entry.label === '乙' && entry.count === 0))
})

// A .sav is a binary container, but the MRSETS definition sits in it as a NUL
// terminated text attribute. PSPP writes that text in the platform ANSI code
// page on Windows (cp936 on a Chinese install) and in UTF-8 on Linux, so the
// reader has to tell the two apart — a GBK label read as UTF-8 is mojibake.
const gbkLabel = Buffer.from([0xb6, 0xe0, 0xd1, 0xa1, 0xcc, 0xe2, 0xb2, 0xe2, 0xca, 0xd4]) // 多选题测试
const utf8Label = Buffer.from('多选题测试', 'utf8')
const mrsetsVariables = [{ name: 'x' }, { name: 'y' }]

await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrsets-'))
  try {
    for (const [name, label, expected] of [
      ['gbk.sav', gbkLabel, '多选题测试'],
      ['utf8.sav', utf8Label, '多选题测试'],
    ]) {
      const file = join(dir, name)
      await writeFile(file, Buffer.concat([
        Buffer.from('$g=C 10 ', 'latin1'),
        label,
        Buffer.from(' x y\n', 'latin1'),
      ]))
      const found = await readMrSetsFromFile(file, mrsetsVariables)
      check(`the ${name === 'gbk.sav' ? 'ANSI' : 'UTF-8'} attribute text decodes to a real label`, () => {
        assert.equal(found.length, 1)
        assert.equal(found[0].name, '$g')
        assert.equal(found[0].label, expected)
        assert.deepEqual(found[0].variables, ['x', 'y'])
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})()

// process.exitCode is set inside check(); a stale value must not leak in.
console.log(`\n${checks} checks passed`)
if (process.exitCode) console.error(`${checks} checks with failures`)
