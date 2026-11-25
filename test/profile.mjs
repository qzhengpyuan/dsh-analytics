// 数据体检：判断本身是这份工具的重点（ID 列、常量列、数字存成文本、日期存成文本、
// 重复列、离群、量纲），所以每条都按「数据长这样 ⇒ 必须报出这句话」来断言。
import assert from 'node:assert/strict'

import { profileDataset, profileTable } from '../lib/profile.js'

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

const datasetOf = (variables, rows) => ({ variables, rows })
const names = (profile) => profile.variables.map((entry) => entry.name)
const findingFor = (profile, variable) => profile.findings.filter((entry) => entry.variable === variable)

check('an empty dataset is reported as an error, not as a healthy one', () => {
  const profile = profileDataset(datasetOf([{ name: 'x', type: 'numeric' }], []))
  assert.equal(profile.cases, 0)
  // 空数据集：一条总体的「一个个案都没有」，外加每个变量的「一个值都没有」。
  assert.ok(profile.counts.error >= 1)
  assert.match(profile.findings[0].text, /一个个案都没有/)
})

check('a constant variable is called out', () => {
  const profile = profileDataset(datasetOf([{ name: 'k', type: 'numeric' }], [[7], [7], [7], [7]]))
  assert.equal(profile.counts.warn, 1)
  assert.match(findingFor(profile, 'k')[0].text, /只有一个取值/)
})

check('an ID-like column is flagged only with enough cases', () => {
  const small = profileDataset(datasetOf([{ name: 'id', type: 'numeric' }], [[1], [2], [3], [4], [5]]))
  assert.equal(small.variables[0].idLike, undefined, '5 个个案不足以下结论')
  const rows = Array.from({ length: 12 }, (_, index) => [index + 1])
  const big = profileDataset(datasetOf([{ name: 'id', type: 'numeric' }], rows))
  assert.equal(big.variables[0].idLike, true)
  assert.match(findingFor(big, 'id')[0].text, /像编号/)
})

check('numbers stored as text are flagged, because PSPP cannot average them', () => {
  const profile = profileDataset(datasetOf([{ name: 'code', type: 'string' }], [['101'], ['102'], ['103']]))
  assert.equal(profile.variables[0].kind, 'numeric-as-text')
  assert.match(findingFor(profile, 'code')[0].text, /重新编码/)
})

check('dates stored as text are recognised', () => {
  const profile = profileDataset(datasetOf([{ name: 'dt', type: 'string' }], [['2024-01-02'], ['2024-02-03'], ['2024-03-04']]))
  assert.equal(profile.variables[0].kind, 'date-as-text')
  assert.match(findingFor(profile, 'dt')[0].text, /日期/)
})

check('a genuinely text variable is left alone', () => {
  const profile = profileDataset(datasetOf([{ name: 'sex', type: 'string' }], [['M'], ['F'], ['M']]))
  assert.equal(profile.variables[0].kind, 'text')
  assert.deepEqual(findingFor(profile, 'sex'), [])
  assert.deepEqual(profile.variables[0].sample, ['M', 'F'])
})

check('duplicate columns are reported once with both names', () => {
  const rows = [[1, 1, 5], [2, 2, 6], [3, 3, 7]]
  const profile = profileDataset(datasetOf([
    { name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }, { name: 'c', type: 'numeric' },
  ], rows))
  assert.deepEqual(profile.duplicates, [['a', 'b']])
  assert.match(profile.findings.find((entry) => /完全一样/.test(entry.text)).text, /a 与 b/)
})

check('missing over half is a warning, and the rate is reported', () => {
  const profile = profileDataset(datasetOf([{ name: 'x', type: 'numeric' }], [[1], [null], [null], [null]]))
  assert.equal(profile.variables[0].missingRate, 0.75)
  assert.ok(profile.variables[0].missingRate > 0.5)
  // 这一列同时「只有一个取值」（其余是缺失），两条都要在，别只认第一条。
  assert.ok(findingFor(profile, 'x').some((entry) => /缺失 3 \/ 4/.test(entry.text)), JSON.stringify(findingFor(profile, 'x')))
})

check('numeric summaries match a hand calculation', () => {
  const profile = profileDataset(datasetOf([{ name: 'x', type: 'numeric' }], [[1], [2], [3], [4]]))
  const entry = profile.variables[0]
  assert.equal(entry.mean, 2.5)
  assert.equal(entry.median, 2.5)
  assert.equal(entry.min, 1)
  assert.equal(entry.max, 4)
  // 样本标准差（n−1）：√(5/3) = 1.2910
  assert.equal(entry.sd, 1.291)
  assert.equal(entry.skewness, 0)
})

check('an IQR outlier is counted', () => {
  const rows = [[1], [2], [3], [4], [5], [100]]
  const profile = profileDataset(datasetOf([{ name: 'x', type: 'numeric' }], rows))
  assert.ok(profile.variables[0].outliers >= 1)
  assert.match(profile.findings.find((entry) => /1\.5×IQR/.test(entry.text)).text, /落在 1\.5×IQR 之外/)
})

check('a suspicious mean-to-SD ratio is mentioned', () => {
  const rows = Array.from({ length: 20 }, (_, index) => [100000 + (index % 2)])
  const profile = profileDataset(datasetOf([{ name: 'x', type: 'numeric' }], rows))
  assert.ok(profile.variables[0].sd < 1)
  assert.match(profile.findings.find((entry) => /量纲/.test(entry.text)).text, /量纲/)
})

check('the panel table has one row per variable and the findings as notes', () => {
  const profile = profileDataset(datasetOf(
    [{ name: 'k', type: 'numeric', label: '常量' }, { name: 'x', type: 'numeric' }],
    [[1, 2], [1, 3], [1, 4]],
  ))
  const table = profileTable(profile)
  assert.equal(table.caption, '数据体检')
  assert.deepEqual(table.matrix[0], ['变量', '类型', '个案', '缺失', '不同取值', '均值', '标准差', '最小', '最大', '偏度', '离群值'])
  assert.equal(table.matrix.length, 3, '表头 + 两行变量')
  assert.equal(table.matrix[1][0], 'k（常量）')
  assert.ok(table.notes.some((note) => note.startsWith('要注意：')))
  assert.deepEqual(names(profile), ['k', 'x'])
})

check('a clean dataset says so instead of inventing problems', () => {
  const rows = Array.from({ length: 12 }, (_, index) => [index % 3, 10 + (index % 5)])
  const profile = profileDataset(datasetOf([
    { name: 'g', type: 'numeric' }, { name: 'y', type: 'numeric' },
  ], rows))
  assert.equal(profile.counts.error, 0)
  const table = profileTable(profile)
  assert.ok(table.notes.length >= 1)
  assert.equal(table.notes[0], '没有发现需要处理的问题')
})

console.log(`\nprofile: ${checks} checks passed`)
