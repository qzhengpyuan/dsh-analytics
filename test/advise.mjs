// 方法选择：判据是「数据长这样 ⇒ 必须推荐这个过程、且不许推荐那个」，所以断言
// 落在建议的过程名与注意事项上，而不是表字数。
import assert from 'node:assert/strict'

import { adviceInvocation, adviseDataset, adviseTable } from '../lib/advise.js'
import { runAdvice } from '../lib/adviseRun.js'
import { createTools } from '../lib/tools.js'

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
// 列名 → 值数组，行按索引拼起来：写用例时比手写 rows 矩阵清楚。
const makeDataset = (columns) => {
  const names = Object.keys(columns)
  const cases = columns[names[0]].length
  return {
    variables: names.map((name) => ({ name, type: 'numeric' })),
    rows: Array.from({ length: cases }, (_, index) => names.map((name) => columns[name][index])),
  }
}

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

check('every suggestion can actually be handed to the tool it names', () => {
  // 复验抓到过：advise 给出的 how.params 用了 schema 里不存在的键（factor /
  // rows / columns / group / procedure），或者漏掉必填（cox 缺 covariates），
  // 照抄就报错。这条用例把「建议必须能用」钉成不变量。
  const tools = createTools({ registry: {}, config: {} })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const datasets = [
    makeDataset({ g: ['a', 'a', 'b', 'b'], y: [1, 2, 3, 4] }),
    makeDataset({ g: ['a', 'a', 'a', 'b', 'b', 'b'], y: [1, 2, 3, 9, 8, 7], x: [1, 2, 3, 4, 5, 6] }),
    makeDataset({ arm: ['c', 'c', 't', 't'], event: [0, 0, 1, 1] }),
    makeDataset({ followup_time: [3, 5, 8, 12], event: [0, 1, 1, 0], age: [40, 51, 62, 33] }),
    makeDataset({ g: ['a', 'b', 'c', 'a', 'b', 'c'], y: [1, 5, 9, 2, 6, 10], z: [2, 3, 4, 5, 6, 7] }),
  ]
  for (const data of datasets) {
    const result = adviseDataset(data, {})
    for (const entry of result.recommendations) {
      const tool = byName.get(entry.how.tool)
      assert.ok(tool, `建议 ${entry.analysis} 指到不存在的工具 ${entry.how.tool}`)
      const schema = tool.parameters ?? {}
      const properties = schema.properties ?? {}
      const params = entry.how.params ?? {}
      for (const key of Object.keys(params)) {
        assert.ok(key in properties, `${entry.analysis} 的 ${entry.how.tool} 没有参数 ${key}`)
      }
      for (const key of schema.required ?? []) {
        assert.ok(params[key] !== undefined, `${entry.analysis} 的 ${entry.how.tool} 缺必填 ${key}`)
      }
      // 只有 procedure 一个键的调用等于没给变量：工具会报「requires at least one variable」。
      const valueKeys = Object.keys(params).filter((key) => key !== 'procedure')
      assert.ok(valueKeys.length > 0, `${entry.analysis} 的调用没有任何变量`)
    }
  }
})

check('a binary outcome does not get mean-based suggestions', () => {
  const result = adviseDataset(makeDataset({ arm: ['c', 'c', 't', 't', 'c', 't'], event: [0, 0, 1, 1, 0, 1] }), {})
  const analyses = result.recommendations.map((entry) => entry.analysis).join(' | ')
  assert.ok(/Logistic|卡方/.test(analyses), analyses)
  assert.ok(!/GLM|一般线性模型/.test(analyses), `二分结局不该推 GLM：${analyses}`)
  assert.ok(!/Mann-Whitney|Kruskal/.test(analyses), `二分结局不该推秩检验：${analyses}`)
  assert.ok(!/t 检验|方差分析/.test(analyses), `二分结局不该推均值检验：${analyses}`)
})

check('an ID column is never chosen as the outcome', () => {
  const rows = []
  for (let index = 0; index < 20; index += 1) rows.push([index + 1, index % 2 === 0 ? 'a' : 'b', 10 + index])
  const data = { variables: [
    { name: 'id', type: 'numeric' },
    { name: 'grp', type: 'numeric' },
    { name: 'score', type: 'numeric' },
  ], rows }
  const result = adviseDataset(data, {})
  assert.notEqual(result.outcome, 'id', '结局不该是 ID 列')
  const analyses = result.recommendations.map((entry) => entry.analysis).join(' | ')
  assert.ok(!/id/.test(analyses), analyses)
})

check('survival data is not offered a mean test or a plain regression', () => {
  const result = adviseDataset(makeDataset({
    followup_time: [3, 5, 8, 12, 18, 21],
    event: [0, 1, 1, 0, 1, 1],
    age: [40, 51, 62, 33, 47, 58],
  }), {})
  const analyses = result.recommendations.map((entry) => entry.analysis).join(' | ')
  assert.ok(/生存/.test(analyses), analyses)
  assert.ok(!/t 检验|方差分析|多元线性回归|简单线性回归/.test(analyses), `带删失的数据不该推均值检验/线性回归：${analyses}`)
  assert.ok(result.notes.some((note) => /删失/.test(note)), result.notes.join(' | '))
})

check('a binary outcome never gets GLM, even with a numeric nominal factor', () => {
  const data = makeDataset({
    event: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    trt: [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2],
    age: [40, 44, 51, 55, 60, 63, 47, 49, 66, 70, 52, 58],
  })
  const result = adviseDataset(data, { outcome: 'event' })
  const analyses = analysesOf(result).join(' | ')
  assert.ok(!/GLM/.test(analyses), `二分结局不该推 GLM：${analyses}`)
})

check('a multi-level outcome only offers a multinomial fit with numeric predictors', () => {
  const data = makeDataset({
    dx: ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c'],
    trt: ['x', 'y', 'x', 'y', 'x', 'y', 'x', 'y', 'x', 'y', 'x', 'y'],
    age: [40, 44, 51, 55, 60, 63, 47, 49, 66, 70, 52, 58],
  })
  const result = adviseDataset(data, { outcome: 'dx' })
  for (const entry of result.recommendations) {
    if (entry.how.tool !== 'pspp_multinomial') continue
    for (const name of entry.how.params.independents) {
      const column = result.variables.find((item) => item.name === name)
      assert.ok(column && column.kind === 'numeric', `多项 Logistic 的自变量必须是数值：${name}`)
    }
  }
})

check('a skewed censored outcome is not offered a rank test on the event column', () => {
  const cases = []
  for (let index = 0; index < 40; index += 1) cases.push(3 ** (index % 6), index % 3 === 0 ? 1 : 0, 40 + index)
  const data = {
    variables: [
      { name: 'followup_time', type: 'numeric' },
      { name: 'event', type: 'numeric' },
      { name: 'arm', type: 'numeric' },
    ],
    rows: Array.from({ length: 40 }, (_, index) => [cases[index * 3], cases[index * 3 + 1], cases[index * 3 + 2] % 2 + 1]),
  }
  const result = adviseDataset(data, {})
  const analyses = analysesOf(result).join(' | ')
  assert.ok(!/Mann-Whitney|Kruskal/.test(analyses), `带删失不该推秩检验：${analyses}`)
  const cox = result.recommendations.find((entry) => entry.how.tool === 'pspp_cox')
  if (cox) {
    assert.ok(!cox.how.params.covariates.includes('event'), `Cox 的协变量不能是事件列自己：${cox.how.params.covariates}`)
    assert.ok(!cox.how.params.covariates.includes('followup_time'), `Cox 的协变量不能是时间列自己：${cox.how.params.covariates}`)
  }
})

check('an ID column is never handed to a regression as a predictor', () => {
  const rowsById = []
  for (let index = 0; index < 20; index += 1) rowsById.push([index + 1, 10 + (index % 5), index % 2 === 0 ? 1 : 0])
  const data = {
    variables: [
      { name: 'id', type: 'numeric' },
      { name: 'score', type: 'numeric' },
      { name: 'grp', type: 'numeric' },
    ],
    rows: rowsById,
  }
  const result = adviseDataset(data, {})
  for (const entry of result.recommendations) {
    const listed = [...(entry.how.params.independents ?? []), ...(entry.how.params.covariates ?? []), ...(entry.how.params.variables ?? [])]
    assert.ok(!listed.includes('id'), `${entry.analysis} 把 ID 列当成了变量：${JSON.stringify(entry.how.params)}`)
  }
})

check('a small sequential id is never the outcome, and never a test variable', () => {
  // 复验反例：n < 10 时旧的 idLike 带 n>=10 门槛，1..8 的 id 被当成结局。
  const rowsSmall = []
  for (let index = 0; index < 8; index += 1) rowsSmall.push([index + 1, 50 + index, index % 2 === 0 ? 'a' : 'b'])
  const data = {
    variables: [
      { name: 'id', type: 'numeric' },
      { name: 'score', type: 'numeric' },
      { name: 'grp', type: 'string' },
    ],
    rows: rowsSmall,
  }
  const result = adviseDataset(data, {})
  assert.equal(result.outcome, 'score', `8 例时结局不该是 id：${result.outcome}`)
  for (const entry of result.recommendations) {
    const listed = [...(entry.how.params.independents ?? []), ...(entry.how.params.variables ?? [])]
    assert.ok(!listed.includes('id'), `${entry.analysis} 仍在用 id：${JSON.stringify(entry.how.params)}`)
  }
})

check('a table of nothing but ids gets no recommendation at all', () => {
  const result = adviseDataset({ variables: [{ name: 'id', type: 'numeric' }], rows: [[1], [2], [3], [4], [5], [6]] }, {})
  assert.equal(result.recommendations.length, 0, JSON.stringify(result.recommendations))
  assert.ok(result.notes.some((note) => /编号/.test(note)), result.notes.join(' | '))
})

check('a Kaplan-Meier suggestion groups with `group`, not `by`', () => {
  // km 图只认 options.group；写成 by 会画成一条总曲线、也没有 log-rank（复验 N1）。
  const dataset = {
    variables: [
      { name: 'time', type: 'numeric', label: '随访时间' },
      { name: 'event', type: 'numeric' },
      { name: 'arm', type: 'string' },
    ],
    rows: Array.from({ length: 20 }, (_, index) => [10 + index, index % 3 === 0 ? 1 : 0, index % 2 === 0 ? 'a' : 'b']),
  }
  const result = adviseDataset(dataset, {})
  const entry = result.recommendations.find((item) => item.how.tool === 'pspp_chart' && item.how.params.type === 'km')
  assert.ok(entry, 'the survival data suggests a KM chart')
  assert.equal(entry.how.params.group, 'arm', JSON.stringify(entry.how.params))
  assert.equal(entry.how.params.by, undefined, 'by 不是 km 的分组参数')
})

check('a numeric column starting from 1 is only an id when there are enough cases', () => {
  // 8 个个案的 score=1..8 是真实测量，不该被判成编号（复验 P2-3 的副作用）。
  const rows = Array.from({ length: 8 }, (_, index) => [index + 1, 50 + index, index % 2 === 0 ? 'a' : 'b'])
  const result = adviseDataset({
    variables: [{ name: 'score', type: 'numeric' }, { name: 'pid', type: 'numeric' }, { name: 'arm', type: 'string' }],
    rows,
  }, {})
  assert.equal(result.outcome, 'score', 'score 是测量值，不是编号')
})

check('ids that do not start at 1, text ids and repeated ids stay out of the analysis', () => {
  const cases = []
  // pid = 101..120：连号但起点不是 1。
  cases.push({
    name: 'offset ids',
    dataset: {
      variables: [{ name: 'pid', type: 'numeric' }, { name: 'score', type: 'numeric' }],
      rows: Array.from({ length: 20 }, (_, index) => [101 + index, 50 + (index % 5)]),
    },
    forbidden: 'pid',
  })
  // 文本编号 case001…：全不同、全都像编号。
  cases.push({
    name: 'text ids',
    dataset: {
      variables: [{ name: 'sample', type: 'string' }, { name: 'score', type: 'numeric' }],
      rows: Array.from({ length: 12 }, (_, index) => [`case${String(index + 1).padStart(3, '0')}`, 50 + (index % 4)]),
    },
    forbidden: 'sample',
  })
  // 名字叫 id 但有重复值：照样是编号。
  cases.push({
    name: 'repeated ids',
    dataset: {
      variables: [{ name: 'id', type: 'numeric' }, { name: 'score', type: 'numeric' }],
      rows: Array.from({ length: 20 }, (_, index) => [1 + (index % 4), 50 + (index % 6)]),
    },
    forbidden: 'id',
  })
  for (const item of cases) {
    const result = adviseDataset(item.dataset, {})
    assert.notEqual(result.outcome, item.forbidden, `${item.name}: ${item.forbidden} 不该当结局`)
    for (const entry of result.recommendations) {
      const values = JSON.stringify(entry.how.params)
      assert.ok(!values.includes(`"${item.forbidden}"`), `${item.name}: ${entry.analysis} 里不该出现 ${item.forbidden}（${values}）`)
    }
  }
})

check('a survival table with only categorical covariates suggests KM, not a broken Cox', () => {
  // 文本 arm 不能进 Cox 的 covariates：真工具会报「只收数值协变量」（复验 P1）。
  const dataset = {
    variables: [
      { name: 'id', type: 'numeric' },
      { name: 'time', type: 'numeric' },
      { name: 'event', type: 'numeric' },
      { name: 'arm', type: 'string' },
    ],
    rows: Array.from({ length: 20 }, (_, index) => [index + 1, index + 2, index % 3 === 0 ? 1 : 0, index % 2 === 0 ? 'a' : 'b']),
  }
  const result = adviseDataset(dataset, {})
  const cox = result.recommendations.find((entry) => entry.how.tool === 'pspp_cox')
  if (cox) {
    assert.ok(cox.how.params.covariates.length > 0, 'Cox 建议不能带空 covariates')
    for (const name of cox.how.params.covariates) {
      const column = dataset.variables.find((variable) => variable.name === name)
      assert.notEqual(column.type, 'string', `Cox 的协变量不能是文本列：${name}`)
    }
  } else {
    const km = result.recommendations.find((entry) => entry.how.params.type === 'km')
    assert.ok(km, '没有数值协变量时应该改推 KM 曲线')
    assert.equal(km.how.tool, 'pspp_chart', 'KM 走 pspp_chart')
  }
})

check('a count outcome with no numeric predictor is not sent to poisson', () => {
  const rows = Array.from({ length: 20 }, (_, index) => [100 + index, index % 4 === 0 ? 'x' : 'y'])
  const result = adviseDataset({
    variables: [{ name: 'pid', type: 'numeric' }, { name: 'visits', type: 'numeric' }, { name: 'arm', type: 'string' }],
    rows,
  }, {})
  for (const entry of result.recommendations) {
    if (entry.how.tool !== 'pspp_poisson') continue
    assert.ok(entry.how.params.independents.length > 0, '泊松回归不能带空 independents')
  }
})

check('no recommendation is emitted with an empty variable list', () => {
  // id + 纯文本分组：没有自变量可放，Logistic 该退成一句注文而不是空 independents。
  const result = adviseDataset({
    variables: [{ name: 'id', type: 'numeric' }, { name: 'grp', type: 'string' }],
    rows: Array.from({ length: 20 }, (_, index) => [index + 1, index % 2 === 0 ? 'a' : 'b']),
  }, {})
  for (const entry of result.recommendations) {
    const params = entry.how.params
    const named = Object.entries(params).filter(([key]) => !['procedure', 'groupValues', 'statistics', 'postHoc'].includes(key))
    assert.ok(named.some(([, value]) => (Array.isArray(value) ? value.length > 0 : value)), `${entry.analysis} 的参数里一个变量都没有：${JSON.stringify(params)}`)
  }
})

// ── 一键运行：建议 → 面板真跑一次 ────────────────────────────────────────────
// 这里用一个假工作区记下被调用的方法：断言「第几条建议变成了什么调用」，
// 不碰引擎（引擎路径由 tools/smoke 各自的套件负责）。
const acheck = async (name, fn) => {
  try {
    await fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const fakeWorkspace = (dataset = { variables: [{ name: 'y', type: 'numeric' }], rows: [[1]] }) => ({
  dataset,
  calls: [],
  async runSyntax(syntax, options = {}) {
    this.calls.push({ method: 'runSyntax', syntax, options })
    return { runId: 7, items: [{ id: 't1', kind: 'table', title: 'Descriptive Statistics' }] }
  },
  async addChart(kind, options = {}) {
    this.calls.push({ method: 'addChart', kind, options })
    return { runId: 8, item: { id: 'c1', title: 'chart: y' }, chart: { kind } }
  },
  coxTable(params) {
    this.calls.push({ method: 'coxTable', params })
    return { items: [{ id: 'x1', title: 'Cox 回归' }] }
  },
  poissonTable(params) {
    this.calls.push({ method: 'poissonTable', params })
    return { items: [{ id: 'p1', title: '泊松回归' }] }
  },
  multinomialTable(params) {
    this.calls.push({ method: 'multinomialTable', params })
    return { items: [{ id: 'm1', title: '多项 Logistic 回归' }] }
  },
})

await acheck('adviceInvocation hands back the stored params and rejects bad indexes', () => {
  const result = { recommendations: [{ analysis: '描述', how: { tool: 'pspp_analyze', params: { procedure: 'descriptives', variables: ['y'] } } }] }
  assert.deepEqual(adviceInvocation(result, 0).params, { procedure: 'descriptives', variables: ['y'] })
  assert.throws(() => adviceInvocation(result, 1), /建议序号/)
  assert.throws(() => adviceInvocation({ recommendations: [{ analysis: '描述' }] }, 0), /没有可直接执行的参数/)
})

await acheck('the first pspp_analyze recommendation runs as real syntax with its pairwise hint', async () => {
  const dataset = {
    variables: [
      { name: 'arm', type: 'numeric' },
      { name: 'score', type: 'numeric' },
    ],
    rows: Array.from({ length: 40 }, (_, index) => [(index % 2) + 1, 10 + (index % 5)]),
  }
  const workspace = fakeWorkspace(dataset)
  const advise = adviseDataset(dataset, {})
  const index = advise.recommendations.findIndex((entry) => entry.how.tool === 'pspp_analyze' && entry.how.params.by)
  assert.ok(index >= 0, '两组连续结局应该给出一条带 by 的 pspp_analyze 建议')
  const outcome = await runAdvice(workspace, advise, index)
  const call = workspace.calls.find((entry) => entry.method === 'runSyntax')
  assert.ok(call, 'runAdvice 必须真的跑一次语法')
  assert.match(call.syntax, /T-TEST|ONEWAY/i)
  assert.equal(call.options.pairwise.group, 'arm')
  assert.equal(outcome.runId, 7)
})

await acheck('a chart recommendation is drawn by addChart, not run as syntax', async () => {
  const workspace = fakeWorkspace()
  const advise = { recommendations: [{ analysis: '生存曲线', how: { tool: 'pspp_chart', params: { type: 'km', time: 'time', event: 'event' } } }] }
  await runAdvice(workspace, advise, 0)
  assert.deepEqual(workspace.calls.map((entry) => entry.method), ['addChart'])
  assert.equal(workspace.calls[0].kind, 'km')
})

await acheck('plugin procedures reach their own workspace method', async () => {
  const workspace = fakeWorkspace()
  await runAdvice(workspace, { recommendations: [{ analysis: 'Cox', how: { tool: 'pspp_cox', params: { time: 'time', event: 'event', covariates: ['x'] } } }] }, 0)
  await runAdvice(workspace, { recommendations: [{ analysis: '泊松', how: { tool: 'pspp_poisson', params: { dependent: 'n', independents: ['x'] } } }] }, 0)
  assert.deepEqual(workspace.calls.map((entry) => entry.method), ['coxTable', 'poissonTable'])
  assert.deepEqual(workspace.calls[0].params.covariates, ['x'])
})

await acheck('a tool the panel cannot run is refused instead of half-executed', async () => {
  const workspace = fakeWorkspace()
  await assert.rejects(
    () => runAdvice(workspace, { recommendations: [{ analysis: '导出成册', how: { tool: 'pspp_report_book', params: { path: '/tmp/x.docx' } } }] }, 0),
    /没有这一类结果视图/,
  )
  assert.equal(workspace.calls.length, 0, '被拒的建议不能先跑一半')
})

console.log(`\nadvise: ${checks} checks passed`)
