// 方法选择：判据是「数据长这样 ⇒ 必须推荐这个过程、且不许推荐那个」，所以断言
// 落在建议的过程名与注意事项上，而不是表字数。
import assert from 'node:assert/strict'

import { adviseDataset, adviseTable } from '../lib/advise.js'

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

// 60 个个案：三组、连续得分、0/1 性别、剂量。
const rows = []
for (let index = 0; index < 60; index += 1) rows.push([(index % 3) + 1, 20 + (index % 7), index % 2, index % 5])
const dataset = {
  variables: [
    { name: 'arm', type: 'numeric', label: '分组' },
    { name: 'score', type: 'numeric', label: '得分' },
    { name: 'sex', type: 'numeric' },
    { name: 'dose', type: 'numeric' },
  ],
  rows,
}
const analysesOf = (result) => result.recommendations.map((entry) => entry.analysis)

check('the grouping column is not mistaken for the outcome', () => {
  const result = adviseDataset(dataset)
  // arm 只取 1/2/3 三个整数：它是分组，把「连续变量」当结局。
  assert.equal(result.outcome, 'score')
  assert.equal(result.group, 'arm')
})

check('three groups get one-way ANOVA, not a t test', () => {
  const result = adviseDataset(dataset)
  assert.ok(analysesOf(result).some((text) => /方差分析/.test(text)))
  assert.ok(!analysesOf(result).some((text) => /独立样本 t 检验/.test(text)))
})

check('two groups get a t test and a Levene caveat', () => {
  const twoGroup = {
    variables: dataset.variables,
    rows: rows.filter((row) => row[0] !== 3),
  }
  const result = adviseDataset(twoGroup)
  const entry = result.recommendations.find((item) => /t 检验/.test(item.analysis))
  assert.ok(entry, '2 组必须推荐 t 检验')
  assert.ok(entry.caveats.some((text) => /Levene/.test(text)))
  assert.equal(entry.how.tool, 'pspp_analyze')
  assert.deepEqual(entry.how.params.variables, ['score'])
})

check('a 0/1 outcome is called a binary outcome, not a measurement', () => {
  const result = adviseDataset(dataset, { outcome: 'sex' })
  assert.ok(analysesOf(result).some((text) => /Logistic/.test(text)))
  assert.ok(result.notes.some((text) => /只取 0\/1/.test(text)))
  // 0/1 结局的组间差异是比例之差：不该再推荐 t 检验 / 方差分析 / 线性回归。
  assert.ok(!analysesOf(result).some((text) => /t 检验|方差分析|线性回归/.test(text)))
  assert.ok(analysesOf(result).some((text) => /卡方/.test(text)))
})

check('survival is suggested only when the outcome looks like follow-up time', () => {
  const plain = adviseDataset(dataset)
  assert.ok(!analysesOf(plain).some((text) => /生存/.test(text)), '带 0/1 列不等于生存数据')
  const timed = {
    variables: [
      { name: 'time', type: 'numeric', label: '随访时间' },
      { name: 'event', type: 'numeric' },
    ],
    rows: Array.from({ length: 30 }, (_, index) => [10 + index, index % 7 === 0 ? 1 : 0]),
  }
  assert.ok(analysesOf(adviseDataset(timed)).some((text) => /生存/.test(text)))
})

check('a text column holding numbers is called out before any regression', () => {
  const result = adviseDataset({
    variables: [{ name: 'code', type: 'string' }, { name: 'score', type: 'numeric' }],
    rows: Array.from({ length: 20 }, (_, index) => [String(1000 + index), 20 + index]),
  })
  assert.ok(result.notes.some((text) => /重新编码成不同变量/.test(text)))
})

check('too few cases per predictor is reported', () => {
  const result = adviseDataset({
    variables: [{ name: 'y', type: 'numeric' }, { name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }, { name: 'c', type: 'numeric' }],
    rows: Array.from({ length: 20 }, (_, index) => [20 + index, index % 3, index % 4, index % 5]),
  })
  assert.ok(result.notes.some((text) => /每个自变量 15 个个案/.test(text)))
})

check('the question only reorders, it does not change the list', () => {
  const before = analysesOf(adviseDataset(dataset))
  const after = analysesOf(adviseDataset(dataset, { question: '两组的得分有没有差异' }))
  assert.deepEqual([...after].sort(), [...before].sort())
  assert.equal(adviseDataset(dataset, { question: '两组的得分有没有差异' }).intent, 'difference')
})

check('an unknown outcome or group name is refused by name', () => {
  assert.throws(() => adviseDataset(dataset, { outcome: 'nope' }), /没有这个变量：nope/)
  assert.throws(() => adviseDataset(dataset, { group: 'nope' }), /没有这个变量：nope/)
})

check('an empty dataset is refused with what to do', () => {
  assert.throws(() => adviseDataset({ variables: [{ name: 'x', type: 'numeric' }], rows: [] }), /一个个案都没有/)
  assert.throws(() => adviseDataset({ variables: [], rows: [] }), /还没有打开数据集/)
})

check('the table has one row per suggestion and the caveats as notes', () => {
  const result = adviseDataset(dataset)
  const table = adviseTable(result)
  assert.equal(table.caption, '方法建议')
  assert.deepEqual(table.matrix[0], ['顺序', '建议用的过程', '为什么', '怎么做'])
  assert.equal(table.matrix.length, result.recommendations.length + 1)
  assert.ok(table.notes.some((text) => /^要注意：/.test(text) || /^数据：/.test(text)))
})

console.log(`\nadvise: ${checks} checks passed`)
