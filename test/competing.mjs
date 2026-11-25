// 竞争风险：没有引擎答案（PSPP 2.1.3 连生存分析都没有），所以断言落在恒等式与
// 可独立算的边界上：
//   ① Σ_k CIF_k(t) = 1 − S(t)（Aalen–Johansen 的直接结果）
//   ② 没有删失时 CIF_k(最后) = n_k / n
//   ③ 单个事件时间点的方差 = F(1−F)/n（二项方差）
//   ④ 只有一类原因时，原因别 log-rank 与 Kaplan–Meier 的 log-rank 逐位相同
//   ⑤ 另一条路线算 CIF：Σ [S(t_{i−1}) − S(t_i)] · d_ki/d_i
import assert from 'node:assert/strict'

import { computeCompetingRisks } from '../lib/competing.js'
import { computeKaplanMeier } from '../lib/survival.js'

let checks = 0
const failures = []
const check = (name, body) => {
  try {
    body()
    checks += 1
    console.log(`ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

const close = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)
}

function datasetOf(rows, names = ['t', 's']) {
  return {
    variables: names.map((name) => ({ name, type: 'numeric' })),
    rows,
  }
}

const table = (out, caption) => out.tables.find((entry) => entry.caption === caption)
const incidenceRows = (out) => table(out, '累积发生率').matrix.slice(1)
// 列下标按表头取：带分组时会多一列，写死下标会在两种形状之间错位。
const columnIndex = (out, name) => table(out, '累积发生率').matrix[0].indexOf(name)
const cell = (out, row, name) => row[columnIndex(out, name)]

check('a cause-specific log-rank treats the other causes as censored', () => {
  // 变异复验抓到过：把别的病因也算成本原因的事件，χ² 从 0.2123 变成 3.8171。
  // 不变量：全原因模型里原因 1 的检验，必须等于「把原因 2 改写成删失、只留原因 1」。
  const rows = []
  for (let index = 0; index < 6; index += 1) rows.push([index + 1, 1, index < 3 ? 'A' : 'B'])
  for (let index = 0; index < 6; index += 1) rows.push([index + 1, 2, index < 3 ? 'B' : 'A'])
  for (let index = 0; index < 4; index += 1) rows.push([index + 2, 0, index < 2 ? 'A' : 'B'])
  const grouped = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 's', type: 'numeric' },
      { name: 'g', type: 'string' },
    ],
    rows,
  }
  const both = computeCompetingRisks(grouped, { time: 't', status: 's', group: 'g' })
  const left = both.logRank.find((entry) => entry.cause === 1)
  const censored = { ...grouped, rows: rows.map(([time, status, group]) => [time, status === 2 ? 0 : status, group]) }
  const only = computeCompetingRisks(censored, { time: 't', status: 's', group: 'g', causes: [1] })
  close(left.chiSquare, only.logRank[0].chiSquare, 1e-9, '别的病因必须按删失处理')
  close(left.p, only.logRank[0].p, 1e-9, 'P 也要一致')
})

check('the Aalen variance keeps the (n − d) factor in its first term', () => {
  // 变异复验抓到过：第一项分母去掉 (n−d)，逐点 SE 最大差 0.0062（CI 宽度差 0.024）。
  // 单事件时间点上第一项恒为 0，所以用例必须有多于一个事件时间点才碰得到它。
  // 这里按定义把两条方差项独立累加一遍（不读模块的中间量）。
  // 剔薄的数据集第一项太小，两种分母在四位小数上看不出差别；这里堆到 25 例、
  // 多个事件时间点，实测原件与变异件在第四位小数上就分开（最大差 0.0038）。
  const pattern = [1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0]
  const rows = []
  for (let index = 0; index < 25; index += 1) rows.push([1 + (index % 12), pattern[index % pattern.length]])
  for (let index = 0; index < 3; index += 1) rows.push([13 + index, 0])
  const out = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's' })
  assert.ok(out.causes.length >= 2, '两条原因')
  const eventTimes = [...new Set(rows.filter(([, status]) => status !== 0).map(([time]) => time))].sort((a, b) => a - b)
  const atRisk = (time) => rows.filter(([other]) => other >= time).length
  const deathsAll = (time) => rows.filter(([other, status]) => other === time && status !== 0).length
  const deathsOf = (time, cause) => rows.filter(([other, status]) => other === time && status === cause).length
  let compared = 0
  for (const entry of out.causes) {
    // causes 是对象（code/label），不是数字码。
    const cause = typeof entry === 'object' && entry !== null ? entry.code : entry
    // 先按定义把 F_k(t_i) 与 S(t_{i−1}) 全算出来。
    const incidences = []
    const survivals = []
    let incidence = 0
    let survival = 1
    for (const time of eventTimes) {
      const n = atRisk(time)
      const d = deathsAll(time)
      survivals.push({ time, before: survival })
      incidence += (survival * deathsOf(time, cause)) / n
      incidences.push({ time, value: incidence })
      survival *= 1 - d / n
    }
    for (const row of incidenceRows(out)) {
      const time = Number(row[columnIndex(out, '时间')])
      // 原因列是「1（状态码 1）」这种带标签的串，直接 Number() 会得到 NaN，
      // 于是整个循环被 continue 跳过、断言变成空转（第一版就是这么写的）。
      const rowCause = Number(String(row[columnIndex(out, '原因')]).match(/^-?\d+/)?.[0])
      if (!Number.isFinite(rowCause) || rowCause !== cause) continue
      const upTo = incidences.filter((entry) => entry.time <= time)
      const current = upTo[upTo.length - 1].value
      let variance = 0
      for (const entry of upTo) {
        const n = atRisk(entry.time)
        const d = deathsAll(entry.time)
        const dk = deathsOf(entry.time, cause)
        const before = survivals.find((item) => item.time === entry.time).before
        if (n > d) variance += ((current - entry.value) ** 2 * d) / (n * (n - d))
        variance += before ** 2 * ((n - dk) / n) * (dk / (n * n))
      }
      compared += 1
      close(Number(cell(out, row, '标准误')), Math.sqrt(variance), 5e-5, `t=${time} 原因 ${cause} 的 SE`)
    }
  }
  assert.ok(compared >= 10, `要真的比过若干行（比了 ${compared} 行），否则断言等于没写`)
})

check('cumulative incidence sums to the complement of the all-cause survival', () => {
  // 12 例：t 1..6 里的 6 个原因 1、t 2..4 的 3 个原因 2、t 3..5 的 3 个删失。
  const rows = []
  for (let index = 0; index < 6; index += 1) rows.push([index + 1, 1])
  for (let index = 0; index < 3; index += 1) rows.push([index + 2, 2])
  for (let index = 0; index < 3; index += 1) rows.push([index + 3, 0])
  const out = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's' })
  // 逐时间点：两类原因在同一时间点上的和必须等于 1 − S。
  const byTime = new Map()
  for (const row of incidenceRows(out)) {
    const time = Number(row[0])
    const value = Number(cell(out, row, '累积发生率'))
    byTime.set(time, (byTime.get(time) ?? 0) + value)
  }
  for (const [time, total] of byTime) {
    const curve = out.groups[0]
    const points = curve.curve[0].points
    // 用模块自己的最后一点反推：1 − S 只能从 KM 得到，所以这里重算一遍全因 KM。
    const subjects = rows.map(([t, s]) => ({ time: t, cause: s || null }))
    let survival = 1
    for (const at of [...new Set(subjects.filter((subject) => subject.cause !== null).map((subject) => subject.time))]
      .filter((value) => value <= time).sort((left, right) => left - right)) {
      const risk = subjects.filter((subject) => subject.time >= at).length
      const deaths = subjects.filter((subject) => subject.cause !== null && subject.time === at).length
      survival *= 1 - deaths / risk
    }
    close(total, 1 - survival, 5e-4, `Σ CIF at t=${time} equals 1 − S`)
    assert.ok(points.length > 0)
  }
})

check('without censoring each cumulative incidence ends at its own share of cases', () => {
  const rows = []
  for (let index = 0; index < 6; index += 1) rows.push([index + 1, 1])
  for (let index = 0; index < 3; index += 1) rows.push([index + 2, 2])
  const out = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's' })
  const last = incidenceRows(out).filter((row) => Number(row[0]) === 6)
  const cause1 = last.find((row) => cell(out, row, '原因').startsWith('1（'))
  const cause2 = last.find((row) => cell(out, row, '原因').startsWith('2（'))
  close(Number(cell(out, cause1, '累积发生率')), 6 / 9, 1e-4, 'cause 1 ends at 6/9')
  close(Number(cell(out, cause2, '累积发生率')), 3 / 9, 1e-4, 'cause 2 ends at 3/9')
  close(Number(cell(out, cause1, '累积发生率')) + Number(cell(out, cause2, '累积发生率')), 1, 1e-4,
    'the two share everything')
})

check('a single event time has the binomial standard error', () => {
  // 一个时间点、n = 8、4 个事件：CIF = 0.5，SE = sqrt(F(1−F)/n) = sqrt(0.25/8)。
  const rows = []
  for (let index = 0; index < 4; index += 1) rows.push([5, 1])
  for (let index = 0; index < 4; index += 1) rows.push([5, 0])
  const out = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's' })
  const row = incidenceRows(out)[0]
  close(Number(cell(out, row, '累积发生率')), 0.5, 1e-4, 'incidence is 0.5')
  close(Number(cell(out, row, '标准误')), Math.sqrt(0.25 / 8), 1e-3, 'standard error is the binomial one')
  // 置信区间截在 [0, 1]：0.5 + 1.96·0.1768 = 0.8466，下限 0.1534。
  close(Number(cell(out, row, '95% CI 下限')), 0.5 - 1.96 * Math.sqrt(0.25 / 8), 1e-3, 'lower bound')
  close(Number(cell(out, row, '95% CI 上限')), 0.5 + 1.96 * Math.sqrt(0.25 / 8), 1e-3, 'upper bound')
})

check('the cumulative incidence can be rebuilt from the survival drops', () => {
  // 另一条路线：CIF_k(t) = Σ [S(t_{i−1}) − S(t_i)] · d_ki / d_i。代数上与
  // Σ S(t_{i−1})·d_ki/n_i 相同，但走的是「生存率掉了多少 × 该原因占比」，
  // 实现里若把 n_i 与 d_i 弄反，这条会红。
  const rows = [
    [1, 1], [2, 1], [2, 2], [3, 0], [4, 2], [4, 1], [5, 0], [6, 1], [6, 2], [7, 0],
  ]
  const out = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's' })
  const subjects = rows.map(([time, cause]) => ({ time, cause }))
  const times = [...new Set(subjects.filter((subject) => subject.cause !== 0).map((subject) => subject.time))]
    .sort((left, right) => left - right)
  let survival = 1
  const cumulative = { 1: 0, 2: 0 }
  const expected = []
  for (const time of times) {
    const risk = subjects.filter((subject) => subject.time >= time).length
    const deaths = subjects.filter((subject) => subject.cause !== 0 && subject.time === time).length
    const perCause = {
      1: subjects.filter((subject) => subject.cause === 1 && subject.time === time).length,
      2: subjects.filter((subject) => subject.cause === 2 && subject.time === time).length,
    }
    const next = survival * (1 - deaths / risk)
    for (const cause of [1, 2]) {
      cumulative[cause] += perCause[cause] === 0 ? 0 : (survival - next) * (perCause[cause] / deaths)
      expected.push({ time, cause, value: cumulative[cause] })
    }
    survival = next
  }
  for (const want of expected) {
    const row = incidenceRows(out).find((entry) => Number(cell(out, entry, '时间')) === want.time
      && cell(out, entry, '原因').startsWith(`${want.cause}（`))
    assert.ok(row, `a row for t=${want.time} cause ${want.cause}`)
    close(Number(cell(out, row, '累积发生率')), want.value, 1e-4, `CIF t=${want.time} cause ${want.cause}`)
  }
})

check('with one cause the cause-specific log-rank equals the Kaplan–Meier log-rank', () => {
  const rows = []
  // 两组，事件时间交错，含删失。
  for (let index = 0; index < 8; index += 1) rows.push([index + 1, 1, 'a'])
  for (let index = 0; index < 8; index += 1) rows.push([index * 2 + 1, 1, 'b'])
  rows.push([9, 0, 'a'], [11, 0, 'b'])
  const dataset = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 's', type: 'numeric' },
      { name: 'g', type: 'string', measure: 'nominal' },
    ],
    rows,
  }
  const competing = computeCompetingRisks(dataset, { time: 't', status: 's', group: 'g' })
  const km = computeKaplanMeier(dataset, { time: 't', event: 's', group: 'g' })
  // KM 需要 1 = 事件、0 = 删失；这份数据满足。
  assert.ok(km.logRank, 'the KM model carries a log-rank test')
  const ours = competing.logRank[0]
  close(ours.chiSquare, km.logRank.chiSquare, 1e-6, 'same chi-square')
  assert.equal(ours.df, km.logRank.df)
  close(ours.p, km.logRank.p, 1e-6, 'same p')
})

check('the test table reports one row per cause and per-group counts', () => {
  const rows = []
  for (let index = 0; index < 6; index += 1) rows.push([index + 1, index % 2 === 0 ? 1 : 2, 'a'])
  for (let index = 0; index < 6; index += 1) rows.push([index + 2, index % 2 === 0 ? 2 : 1, 'b'])
  const dataset = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 's', type: 'numeric' },
      { name: 'g', type: 'string', measure: 'nominal' },
    ],
    rows,
  }
  const out = computeCompetingRisks(dataset, { time: 't', status: 's', group: 'g' })
  const test = table(out, '组间检验（原因别 log-rank）')
  assert.ok(test, 'the group comparison table exists')
  assert.equal(test.matrix.length - 1, 2, 'one row per cause')
  assert.equal(test.matrix[1][2], '1', 'df is groups − 1')
  assert.equal(out.groups.length, 2, 'two groups')
  // 计数表：每类原因一行 + 合计行。
  assert.equal(table(out, '事件计数').matrix.length - 1, 3)
  // 每个分组的估算点都带分组列。
  assert.ok(incidenceRows(out).every((row) => cell(out, row, '分组') === 'a' || cell(out, row, '分组') === 'b'))
})

check('rows with a missing time, status or group are dropped as a whole case', () => {
  const rows = [
    [1, 1, 'a'], [2, 2, 'a'], [3, 0, 'a'], [null, 1, 'a'], [4, null, 'a'], [5, 1, null],
    [1, 1, 'b'], [2, 2, 'b'], [3, 0, 'b'],
  ]
  const dataset = {
    variables: [
      { name: 't', type: 'numeric' },
      { name: 's', type: 'numeric' },
      { name: 'g', type: 'string', measure: 'nominal' },
    ],
    rows,
  }
  const out = computeCompetingRisks(dataset, { time: 't', status: 's', group: 'g' })
  assert.equal(out.cases, 6)
  assert.equal(out.dropped, 3)
  assert.match(out.notes[0], /3 例/)
})

check('status codes outside the chosen causes are treated as censored and said so', () => {
  const rows = [[1, 1], [2, 4], [3, 2], [4, 4], [5, 0]]
  const out = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's', causes: [1, 2] })
  assert.deepEqual(out.causes.map((entry) => entry.code), [1, 2])
  assert.match(out.notes[2], /状态码 4 不在所选原因里，按删失处理/)
  // 只选一类原因时它是唯一一条曲线。
  const only = computeCompetingRisks(datasetOf(rows), { time: 't', status: 's', causes: [2] })
  assert.deepEqual(only.causes.map((entry) => entry.code), [2])
})

check('bad input is refused with a sentence that says what to fix', () => {
  const good = datasetOf([[1, 1], [2, 2], [3, 0]])
  assert.throws(() => computeCompetingRisks(null, { time: 't', status: 's' }), /还没有打开数据集/)
  assert.throws(() => computeCompetingRisks(good, { status: 's' }), /要指定生存时间变量/)
  assert.throws(() => computeCompetingRisks(good, { time: 't' }), /要指定状态变量/)
  assert.throws(() => computeCompetingRisks(good, { time: 'nope', status: 's' }), /没有这个变量：nope/)
  assert.throws(() => computeCompetingRisks(good, { time: 't', status: 'nope' }), /没有这个变量：nope/)
  const censoredOnly = datasetOf([[1, 0], [2, 0]])
  assert.throws(() => computeCompetingRisks(censoredOnly, { time: 't', status: 's' }), /所有个案都是 0/)
  assert.throws(() => computeCompetingRisks(datasetOf([[1, 1]]), { time: 't', status: 's' }), /可用的个案太少/)
  const many = datasetOf(Array.from({ length: 20 }, (_, index) => [index + 1, (index % 7) + 1]))
  assert.throws(() => computeCompetingRisks(many, { time: 't', status: 's' }), /原因太多了/)
  assert.throws(() => computeCompetingRisks(good, { time: 't', status: 's', causes: [9] }), /没有这些原因码/)
  const text = {
    variables: [{ name: 't', type: 'string' }, { name: 's', type: 'numeric' }],
    rows: [['a', 1], ['b', 2]],
  }
  assert.throws(() => computeCompetingRisks(text, { time: 't', status: 's' }), /生存时间要是数值变量/)
  assert.throws(() => computeCompetingRisks(datasetOf([[1, 1], [2, 2]]),
    { time: 't', status: 's', group: 't' }), /不能与生存时间或状态变量是同一个变量/)
})

process.stdout.write(`\n${checks} checks in test/competing.mjs\n`)
if (failures.length) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
