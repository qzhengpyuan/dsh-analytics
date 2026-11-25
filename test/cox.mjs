// Cox regression: the partial likelihood is maximised in lib/cox.js, and the
// score statistic is cross-checked against the log-rank test from lib/survival.js
// (they are the same quantity for a single binary covariate).
import assert from 'node:assert/strict'

import { computeCox } from '../lib/cox.js'
import { computeKaplanMeier } from '../lib/survival.js'

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

const dataset = (rows) => ({
  variables: [
    { name: 't', type: 'numeric' },
    { name: 'e', type: 'numeric' },
    { name: 'g', type: 'numeric' },
  ],
  rows,
})

// Distinct event times on purpose: with ties the log-rank variance uses the
// hypergeometric form and the Cox score test uses Breslow, so they only have to
// agree when every event time is unique.
const distinct = [
  [1, 1, 0], [2, 1, 1], [3, 1, 0], [4, 1, 1], [5, 1, 0], [6, 1, 1], [7, 1, 0],
  [9, 0, 1], [10, 0, 1], [11, 0, 0], [12, 0, 0],
]

check('the score test equals the log-rank statistic for one binary covariate', () => {
  const cox = computeCox(dataset(distinct), { time: 't', event: 'e', covariates: ['g'] })
  const km = computeKaplanMeier(
    {
      variables: [
        { name: 't', type: 'numeric' },
        { name: 'e', type: 'numeric' },
        { name: 'grp', type: 'string' },
      ],
      rows: distinct.map((row) => [row[0], row[1], row[2] === 1 ? 'B' : 'A']),
    },
    { time: 't', event: 'e', group: 'grp' },
  )
  assert.ok(
    Math.abs(cox.model.score - km.logRank.chiSquare) < 1e-3,
    `score ${cox.model.score} should match log-rank ${km.logRank.chiSquare}`,
  )
})

check('a worse group gets a hazard ratio above one', () => {
  // Group 1 collects the early events while group 0 keeps going, but both
  // groups still have events at several times: enough signal for a finite
  // estimate, not so much that the likelihood runs off to infinity.
  // Group 1 collects its events earlier, but the two groups overlap in time:
  // separation would drive the coefficient to infinity and leave no interval.
  const rows = [
    [2, 1, 1], [3, 1, 1], [4, 1, 1], [5, 1, 1], [6, 1, 1], [7, 0, 1],
    [4, 1, 0], [5, 1, 0], [6, 1, 0], [7, 1, 0], [8, 1, 0], [9, 1, 0], [10, 0, 0], [11, 0, 0],
  ]
  const cox = computeCox(dataset(rows), { time: 't', event: 'e', covariates: ['g'] })
  const coefficient = cox.model.coefficients[0]
  assert.ok(coefficient.hazardRatio > 1, `expected HR > 1, got ${coefficient.hazardRatio}`)
  assert.ok(coefficient.p < 0.2, `expected a smallish P, got ${coefficient.p}`)
  assert.ok(coefficient.ciLow < coefficient.hazardRatio && coefficient.hazardRatio < coefficient.ciHigh, 'HR sits inside its interval')
  assert.ok(cox.model.likelihoodRatio > 0, 'the model explains something')
  assert.equal(cox.model.converged, true, 'this model converges')
})

check('the table has one row per covariate and names the ties method', () => {
  const cox = computeCox(dataset(distinct), { time: 't', event: 'e', covariates: ['g'] })
  assert.equal(cox.matrix.length, 2, 'a header plus one row')
  assert.deepEqual(cox.matrix[0], ['变量', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)', '95% CI 下限', '95% CI 上限'])
  assert.equal(cox.matrix[1][0], 'g')
  assert.match(cox.notes[0], /个案 11 例，事件 7 例/, 'the note counts the cases and events')
  assert.match(cox.notes[1], /-2 对数似然/, 'and reports the fit')
  assert.match(cox.notes[3], /Breslow/, 'the ties method is stated')
})

check('two covariates are fitted at once', () => {
  const rows = [
    [1, 1, 1], [2, 1, 0], [3, 1, 1], [4, 1, 0], [5, 1, 1], [6, 1, 0],
    [7, 0, 1], [8, 1, 0], [9, 0, 1], [10, 0, 0], [11, 0, 1], [12, 0, 0],
  ]
  const cox = computeCox(
    {
      variables: [
        { name: 't', type: 'numeric' },
        { name: 'e', type: 'numeric' },
        { name: 'g', type: 'numeric' },
        { name: 'h', type: 'numeric' },
      ],
      rows: rows.map((row, index) => [...row, index % 3]),
    },
    { time: 't', event: 'e', covariates: ['g', 'h'] },
  )
  assert.equal(cox.matrix.length, 3, 'one row per covariate')
  assert.deepEqual(cox.model.coefficients.map((entry) => entry.name), ['g', 'h'])
})

check('cases with a missing covariate are dropped whole, not filled with zero', () => {
  const rows = [[1, 1, 1], [2, 1, null], [3, 1, 0], [4, 1, 1], [5, 1, 0], [6, 1, 1], [8, 0, 1], [9, 0, 0]]
  const cox = computeCox(dataset(rows), { time: 't', event: 'e', covariates: ['g'] })
  assert.equal(cox.model.n, 7, 'the incomplete case is gone')
})

check('a text covariate, a missing event and a collinear model are refused', () => {
  const text = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 'e', type: 'numeric' },
      { name: 'g', type: 'string' },
    ],
    rows: [[1, 1, 'a'], [2, 1, 'b'], [3, 1, 'a'], [4, 1, 'b'], [5, 1, 'a'], [6, 1, 'b']],
  }
  assert.throws(() => computeCox(text, { time: 't', event: 'e', covariates: ['g'] }), /只收数值协变量/, 'a text covariate is named')
  const noEvents = dataset([[1, 0, 1], [2, 0, 0], [3, 0, 1], [4, 0, 0], [5, 0, 1], [6, 0, 0]])
  assert.throws(() => computeCox(noEvents, { time: 't', event: 'e', covariates: ['g'] }), /一次事件都没有发生/, 'no events is refused')
  const collinear = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 'e', type: 'numeric' },
      { name: 'g', type: 'numeric' },
      { name: 'h', type: 'numeric' },
    ],
    rows: [[1, 1, 1, 2], [2, 1, 0, 0], [3, 1, 1, 2], [4, 1, 0, 0], [5, 1, 1, 2], [6, 1, 0, 0], [7, 1, 1, 2], [8, 0, 0, 0]],
  }
  assert.throws(() => computeCox(collinear, { time: 't', event: 'e', covariates: ['g', 'h'] }), /奇异|共线/, 'a collinear pair is refused')
  assert.throws(() => computeCox(dataset(distinct), { time: 't', event: 'e', covariates: [] }), /至少要一个协变量/, 'no covariates is refused')
})

console.log(`${checks} checks passed`)

// 分层（COXREG /STRATA）：风险集只在层内累加，B 在层间共享。没有引擎答案，所以
// 独立实现一遍偏似然再黄金分割求最大值，逐位对账；顺带验两条守卫。
const stratifiedRows = (() => {
  let seed = 11
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const rows = []
  for (let group = 0; group < 2; group += 1) {
    for (let index = 0; index < 50; index += 1) {
      rows.push([1 + group * 5 + Math.floor(random() * 10), random() < 0.65 ? 1 : 0, index % 2, group === 0 ? 'A' : 'B'])
    }
  }
  return rows
})()
const strataDataset = (rows) => ({
  variables: [
    { name: 't', type: 'numeric' },
    { name: 'e', type: 'numeric' },
    { name: 'x', type: 'numeric' },
    { name: 's', type: 'string' },
  ],
  rows,
})

check('a stratified fit matches an independent partial-likelihood maximisation', () => {
  // 独立实现：层内风险集 + Breslow，写成 PL(β) 的纯函数，再黄金分割找极值点。
  const cases = stratifiedRows.map((row) => ({ t: row[0], e: row[1], x: row[2], s: row[3] }))
  const partial = (beta) => {
    let total = 0
    for (const label of ['A', 'B']) {
      const group = cases.filter((entry) => entry.s === label)
      const times = [...new Set(group.map((entry) => entry.t))].sort((left, right) => right - left)
      for (const time of times) {
        const events = group.filter((entry) => entry.e === 1 && entry.t === time)
        if (events.length === 0) continue
        const risk = group.filter((entry) => entry.t >= time)
        const s0 = risk.reduce((sum, entry) => sum + Math.exp(beta * entry.x), 0)
        total += events.reduce((sum, entry) => sum + beta * entry.x, 0) - events.length * Math.log(s0)
      }
    }
    return total
  }
  const golden = (Math.sqrt(5) - 1) / 2
  let low = -3
  let high = 3
  for (let step = 0; step < 200; step += 1) {
    const left = high - golden * (high - low)
    const right = low + golden * (high - low)
    if (partial(left) > partial(right)) high = right
    else low = left
  }
  const expected = (low + high) / 2
  const out = computeCox(strataDataset(stratifiedRows), { time: 't', event: 'e', covariates: ['x'], strata: 's' })
  const estimate = Number(out.matrix[1][1])
  assert.ok(Math.abs(estimate - expected) < 1e-3, `beta ${estimate} vs ${expected}`)
  // 解处一阶导数为 0：说明模块收敛到的是同一个驻点，不是碰巧接近。
  const step = 1e-5
  const slope = (partial(expected + step) - partial(expected - step)) / (2 * step)
  assert.ok(Math.abs(slope) < 1e-3, `slope ${slope}`)
})

check('the strata table counts every level and the notes say who owns the risk sets', () => {
  const out = computeCox(strataDataset(stratifiedRows), { time: 't', event: 'e', covariates: ['x'], strata: 's' })
  assert.deepEqual(out.strataTable[0], ['分层', '个案', '事件', '删失'])
  assert.equal(out.strataTable.length, 4, 'header, two strata, total')
  assert.deepEqual(out.strataTable[1].slice(0, 2), ['A', '50'])
  assert.deepEqual(out.strataTable[3], ['合计', '100', String(out.model.events), String(100 - out.model.events)])
  assert.match(out.notes[0], /按 s 分了 2 层/)
  assert.ok(out.notes.some((note) => /把分层变量当协变量/.test(note)), 'it explains what stratifying buys you')
  assert.equal(out.model.strata.length, 2)
})

check('the partial likelihood of a distinct-time fit matches the closed form', () => {
  // 变异复验抓到过：把 logLikelihood 里的 deaths 因子丢掉，-2LL 从 319.7 变成 113.7，
  // 而用例只对注文做文本匹配，数值从没被钉住。事件时间互不相同时 Breslow 就是标准
  // PL：LL = Σ_事件 [β·x_i − log Σ_{t_j ≥ t_i} exp(β·x_j)]。
  const out = computeCox(dataset(distinct), { time: 't', event: 'e', covariates: ['g'] })
  const beta = Number(out.matrix[1][1])
  let expected = 0
  for (const [time, event, value] of distinct) {
    if (event !== 1) continue
    const risk = distinct.filter(([other]) => other >= time)
    expected += beta * value - Math.log(risk.reduce((sum, [, , x]) => sum + Math.exp(beta * x), 0))
  }
  assert.ok(
    Math.abs(out.model.logLikelihood - expected) < 5e-4,
    `对数似然应等于偏似然：${out.model.logLikelihood} vs ${expected}`,
  )
  assert.ok(out.model.likelihoodRatio >= 0, `似然比 χ² 不能是负的（实测 ${out.model.likelihoodRatio}）`)
})

check('tied event times count every death in the Breslow log-likelihood', () => {
  // 上面那条用互不相同的事件时间 —— 那样每个时间点只有一例，deaths 因子乘 1，
  // 把因子丢掉也看不出来（变异复验正是这样漏掉的）。这里刻意造并列事件时间：
  // 同一时刻 d 例事件时 LL 贡献 = Σ_事件 βx − d·log(Σ_风险 exp(βx))。
  const rows = []
  for (let time = 1; time <= 5; time += 1) {
    for (let index = 0; index < 4; index += 1) {
      rows.push([time, index < 2 ? 1 : 0, (time * 3 + index * 2) % 7])
    }
  }
  const out = computeCox(dataset(rows), { time: 't', event: 'e', covariates: ['g'] })
  const beta = Number(out.matrix[1][1])
  let expected = 0
  for (const time of [...new Set(rows.filter(([, event]) => event === 1).map(([t]) => t))]) {
    const events = rows.filter(([t, event]) => t === time && event === 1)
    const risk = rows.filter(([t]) => t >= time)
    const s0 = risk.reduce((sum, [, , value]) => sum + Math.exp(beta * value), 0)
    expected += events.reduce((sum, [, , value]) => sum + beta * value, 0) - events.length * Math.log(s0)
  }
  assert.ok(
    Math.abs(out.model.logLikelihood - expected) < 5e-4,
    `并列事件时间的对数似然：${out.model.logLikelihood} vs ${expected}`,
  )
})

check('every strata row adds up and a stratum without events stays out of the likelihood', () => {
  // 两条不变量：① 每层的「个案 = 事件 + 删失」（变异曾让删失列用全局数）；
  // ② 0 事件的层不能进似然 —— 那里 s0/s1/s2 全为 0，log(0) 会把 -2LL 变成 Infinity。
  const out = computeCox(strataDataset(stratifiedRows), { time: 't', event: 'e', covariates: ['x'], strata: 's' })
  for (const line of out.strataTable.slice(1, -1)) {
    assert.equal(Number(line[1]), Number(line[2]) + Number(line[3]), `分层表每行都要自洽：${line.join('|')}`)
  }
  const rows = []
  for (let index = 0; index < 30; index += 1) {
    rows.push([index + 1, index % 5 === 0 ? 1 : 0, index % 3, 'A'])
    rows.push([index + 1, index % 4 === 0 ? 1 : 0, index % 5, 'B'])
    // C 层全是删失：进不了似然，但不该让拟合出 NaN。
    rows.push([index + 1, 0, index % 7, 'C'])
  }
  const sparse = computeCox(strataDataset(rows), { time: 't', event: 'e', covariates: ['x'], strata: 's' })
  assert.equal(sparse.model.strata.length, 3, '三层都在摘要里')
  assert.equal(sparse.model.emptyStrata.length, 1, '零事件的那一层要被点名')
  assert.match(sparse.notes[0], /分了 3 层（其中 1 层没有事件、不进似然）/, sparse.notes[0])
  assert.ok(sparse.notes.some((note) => /1 层一次事件都没有/.test(note)), '第二条注文也要点名')
  assert.ok(Number.isFinite(sparse.model.logLikelihood), `零事件层不该把似然变成无穷：${sparse.model.logLikelihood}`)
  assert.ok(Number.isFinite(Number(sparse.matrix[1][1])), '系数要有限')
})

check('stratifying is not the same model as putting the variable in as a covariate', () => {
  // 协变量必须是数值：把分层变量做成 0/1 哑变量再当协变量放进去，和「按它分层」
  // 是两个不同的假设（前者假设它的效应是比例风险），结果不该逐位相同。
  const asCovariate = computeCox({
    variables: [
      { name: 't', type: 'numeric' },
      { name: 'e', type: 'numeric' },
      { name: 'x', type: 'numeric' },
      { name: 'dummy', type: 'numeric' },
    ],
    rows: stratifiedRows.map((row) => [row[0], row[1], row[2], row[3] === 'A' ? 0 : 1]),
  }, { time: 't', event: 'e', covariates: ['x', 'dummy'] })
  const stratified = computeCox(strataDataset(stratifiedRows), { time: 't', event: 'e', covariates: ['x'], strata: 's' })
  // 两个模型都在估 x 的效应，但一个是「层内比较」、一个是「层间也算进去」，不该逐位相同。
  assert.notEqual(stratified.matrix[1][1], asCovariate.matrix[1][1])
})

check('strata refusals name what is wrong in Chinese', () => {
  const single = stratifiedRows.map((row) => [...row.slice(0, 3), 'A'])
  assert.throws(() => computeCox(strataDataset(single), { time: 't', event: 'e', covariates: ['x'], strata: 's' }), /只有一个取值/)
  assert.throws(() => computeCox(strataDataset(stratifiedRows), { time: 't', event: 'e', covariates: ['x'], strata: 'nope' }), /没有这个变量：nope/)
  // 有很多取值又只有一两个个案的层，事件全无 → 要么报「每层都没有事件」，要么剔掉并点名。
  const sparse = []
  for (let index = 0; index < 30; index += 1) sparse.push([index + 1, index % 3 === 0 ? 1 : 0, index % 2, `L${index}`])
  assert.throws(() => computeCox(strataDataset(sparse), { time: 't', event: 'e', covariates: ['x'], strata: 's' }), /分层太多了/)
})


process.stdout.write(`\n${checks} checks in test/cox.mjs\n`)
