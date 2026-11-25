import assert from 'node:assert/strict'
import { computeLifeTable, MAX_INTERVALS } from '../lib/lifetable.js'

// 生命表是插件自算的（PSPP 2.1.3 的 SURVIVAL 报 not yet implemented），所以用例
// 一律用「按定义重算」而不是抄一份实现的输出：同一张表先用闭式解手算，再逐格比。
let checks = 0
const failures = []
async function check(name, body) {
  try {
    await body()
    checks += 1
    console.log(`ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}`)
    console.log(String(error.stack ?? error.message).split('\n').slice(0, 4).join('\n'))
  }
}

const variables = [
  { name: 't', type: 'numeric' },
  { name: 's', type: 'numeric' },
  { name: 'g', type: 'string' },
]

function dataset(rows, extra = []) {
  return { variables: [...variables, ...extra], rows }
}

const rows = [
  [1, 1, 'A'], [2, 0, 'A'], [3, 1, 'A'], [4, 1, 'A'], [5, 0, 'A'],
  [1, 1, 'B'], [2, 1, 'B'], [3, 0, 'B'], [6, 1, 'B'],
]

const cell = (out, from, name) => {
  const header = out.matrix[0]
  const column = header.indexOf(name)
  assert.ok(column >= 0, `表里没有「${name}」这一列：${header.join('|')}`)
  const row = out.matrix.slice(1).find((line) => Number(line[header.indexOf('区间起点')]) === from)
  assert.ok(row, `表里没有起点为 ${from} 的区间`)
  return row[column]
}

await check('the first interval uses half of its censored as exposed', () => {
  const out = computeLifeTable(dataset(rows), { time: 't', status: 's', interval: 2 })
  assert.equal(out.steps, 3, 'nine cases from 1 to 6 with width 2 need three intervals')
  assert.equal(out.matrix.length, 4, 'header plus three intervals')
  // 期初在险 9，期内删失 1（t=2 A），期内事件 3（t=1 A、t=1 B、t=2 B）。
  assert.equal(cell(out, 1, '期初在险数'), '9')
  assert.equal(cell(out, 1, '期内删失'), '1')
  assert.equal(cell(out, 1, '期内事件数'), '3')
  assert.equal(cell(out, 1, '有效样本数'), '8.5', 'effective = 9 - 1/2')
  assert.equal(cell(out, 1, '期内死亡比例'), '0.3529', 'q = 3 / 8.5')
  assert.equal(cell(out, 1, '期内生存比例'), '0.6471')
  assert.equal(cell(out, 1, '累积生存率'), '0.6471', 'nothing was multiplied before the first interval')
})

await check('survival is the running product and the hazard follows the actuarial formula', () => {
  const out = computeLifeTable(dataset(rows), { time: 't', status: 's', interval: 2 })
  const second = Number(cell(out, 3, '累积生存率'))
  const first = Number(cell(out, 1, '累积生存率'))
  const q2 = Number(cell(out, 3, '期内死亡比例'))
  assert.ok(Math.abs(second - first * (1 - q2)) < 5e-5, `S2 = S1 * p2: ${second} vs ${first * (1 - q2)}`)
  const p = 1 - q2
  const expected = (2 * q2) / (out.interval * (1 + p))
  assert.ok(Math.abs(Number(cell(out, 3, '风险率')) - expected) < 5e-5, `h = 2q/(b(1+p)): ${cell(out, 3, '风险率')} vs ${expected}`)
  // Greenwood，生命表形式：SE(S_i) = S_i * sqrt(Σ d/(n'(n'-d)))
  const greenwood = (def) => def.reduce((sum, item) => sum + item.events / (item.effective * (item.effective - item.events)), 0)
  const built = out.intervals.map((line) => ({
    events: Number(line[out.matrix[0].indexOf('期内事件数')]),
    effective: Number(line[out.matrix[0].indexOf('有效样本数')]),
  }))
  const lastRow = out.matrix[out.matrix.length - 1]
  const survival = Number(lastRow[out.matrix[0].indexOf('累积生存率')])
  const se = Number(lastRow[out.matrix[0].indexOf('标准误')])
  assert.ok(Math.abs(se - survival * Math.sqrt(greenwood(built))) < 5e-5, `SE uses Greenwood: ${se}`)
})

await check('the median is the first interval end whose survival is at or below one half', () => {
  const out = computeLifeTable(dataset(rows), { time: 't', status: 's', interval: 2 })
  // 累积生存率 0.6471 → 0.3595：第一次 ≤ 0.5 落在第二段，终点 5。
  assert.equal(out.medians[1][1], '5')
  assert.match(out.medians[1][2], /区间终点/)
})

await check('a group column splits the table and the medians', () => {
  const out = computeLifeTable(dataset(rows), { time: 't', status: 's', group: 'g', interval: 2 })
  assert.deepEqual(out.groups, ['A', 'B'])
  assert.equal(out.matrix[0][1], '分组', 'the group column sits right after the interval label')
  assert.deepEqual(out.medians.slice(1).map((line) => line[0]), ['A', 'B'])
  // A 层：1 事件、2 删失、3 事件、4 事件、5 删失；第一段（1–3）在险 5、删失 1、事件 1。
  const head = out.matrix[0]
  const first = out.matrix.slice(1).find((line) => line[head.indexOf('分组')] === 'A' && Number(line[head.indexOf('区间起点')]) === 1)
  assert.ok(first, 'A 层的第一段应该在表里')
  assert.equal(first[head.indexOf('期初在险数')], '5', `A 层期初在险数：${first.join('|')}`)
  assert.equal(first[head.indexOf('期内事件数')], '1', `A 层期内事件数：${first.join('|')}`)
  assert.equal(first[head.indexOf('期内删失')], '1', `A 层期内删失：${first.join('|')}`)
  // 单独算 A 层：第一段必须与分组表里那一块逐格相同。后面几段**不能**比 —— 生命表
  // 的格子取决于整张表的区间网格（单独算 A 时 5 落在最后一段 [3,5]，分组时 5 落在
  // [5,7)），这是生命表法的固有性质，不是分组算法的差别。
  const alone = computeLifeTable(dataset(rows.filter((row) => row[2] === 'A')), { time: 't', status: 's', interval: 2 })
  const aloneHead = alone.matrix[0]
  for (const name of ['期内事件数', '有效样本数', '期内死亡比例', '累积生存率']) {
    assert.equal(first[head.indexOf(name)], alone.matrix[1][aloneHead.indexOf(name)],
      `A 层第一段的 ${name} 应与单独算的一致：${first.join('|')} vs ${alone.matrix[1].join('|')}`)
  }
  assert.ok(alone.steps < out.steps, 'A 层自己的网格更短：范围只到 5')
  // 每组的累积生存率都是期内生存比例的连乘（分组没有打乱顺序）。
  for (const name of ['A', 'B']) {
    let product = 1
    for (const line of out.matrix.slice(1).filter((row) => row[head.indexOf('分组')] === name)) {
      product *= Number(line[head.indexOf('期内生存比例')])
      // 显示值是四舍五入过的，连乘会累积到 1e-4 量级（0.7778 × 0.3333 = 0.25924，
      // 表里印 0.2593），所以这里只要求同量级，不比 5e-5。
      assert.ok(Math.abs(Number(line[head.indexOf('累积生存率')]) - product) < 2e-4,
        `${name} 的累积生存率不是连乘：${line.join('|')}`)
    }
  }
})

await check('a width that covers everything gives one interval and a survival-free-of-pruning answer', () => {
  // 整段一个区间：期初 9、删失 2（t=2 A、t=5 A）、事件 5 ⇒ 有效 8、q=0.625、S=0.375。
  const out = computeLifeTable(dataset(rows), { time: 't', status: 's', interval: 100 })
  assert.equal(out.steps, 1)
  assert.equal(cell(out, 1, '期内事件数'), '6', 'A 有 3 个事件（1、3、4），B 有 3 个（1、2、6）')
  assert.equal(cell(out, 1, '期内删失'), '3', 'A 的 2 与 5、B 的 3')
  assert.equal(cell(out, 1, '有效样本数'), '7.5', '9 - 3/2')
  assert.equal(cell(out, 1, '累积生存率'), '0.2000', '1 - 6/7.5')
})

await check('censoring beyond the last event still counts at the start of its interval', () => {
  const out = computeLifeTable(dataset([
    [1, 1, 'A'], [2, 1, 'A'], [9, 0, 'A'],
  ]), { time: 't', status: 's', interval: 2 })
  const lastInterval = out.matrix[out.matrix.length - 1]
  const head = out.matrix[0]
  // 宽度 2、范围 1–9 ⇒ 四段（1、3、5、7），删失在 9 落进最后一段 [7, 9]。
  assert.equal(out.steps, 4)
  assert.equal(Number(lastInterval[head.indexOf('区间起点')]), 7, 'the censored case at 9 lands in the last interval')
  assert.equal(lastInterval[head.indexOf('期初在险数')], '1')
  assert.equal(lastInterval[head.indexOf('期内删失')], '1')
  assert.equal(lastInterval[head.indexOf('期内事件数')], '0')
  assert.equal(lastInterval[head.indexOf('期内死亡比例')], '0.0000', 'no event means nothing dies in that interval')
})

await check('missing values, negative times and blank codes are dropped, and the note says how many', () => {
  const out = computeLifeTable(dataset([
    [1, 1, 'A'], [2, 1, 'A'], [3, 0, 'A'], [null, 1, 'A'], [4, null, 'A'], [-2, 1, 'A'], [5, 1, ''],
  ]), { time: 't', status: 's', group: 'g', interval: 2 })
  assert.equal(out.cases, 3)
  assert.equal(out.dropped, 4)
  assert.match(out.notes.join('\n'), /4 个个案因为时间\/状态\/分组缺失/)
})

await check('a declared missing code is not a time value', () => {
  const custom = dataset([[1, 1, 'A'], [2, 1, 'A'], [999, 1, 'A']])
  custom.variables[0] = { ...custom.variables[0], missing: [999] }
  const out = computeLifeTable(custom, { time: 't', status: 's', interval: 2 })
  assert.equal(out.cases, 2, 'the 999 case is user-missing, not a 999-unit follow-up')
  assert.equal(out.last, 2)
})

await check('the interval width is chosen when it is left empty', () => {
  const out = computeLifeTable(dataset(rows), { time: 't', status: 's' })
  assert.ok(out.interval > 0, `the width must be positive: ${out.interval}`)
  assert.ok(out.steps >= 2 && out.steps <= 12, `an automatic width gives a readable table: ${out.steps} intervals`)
  assert.match(out.notes.join('\n'), /宽度是自动取的/)
})

await check('rejections name what to fix', async () => {
  const table = dataset(rows)
  assert.throws(() => computeLifeTable(null, { time: 't', status: 's' }), /还没有打开数据集/)
  assert.throws(() => computeLifeTable(table, { status: 's' }), /生命表要指定随访时间变量/)
  assert.throws(() => computeLifeTable(table, { time: 't' }), /生命表要指定状态变量/)
  assert.throws(() => computeLifeTable(table, { time: 'nope', status: 's' }), /没有这个变量：nope/)
  assert.throws(() => computeLifeTable(table, { time: 't', status: 'nope' }), /没有这个变量：nope/)
  const text = { ...table, variables: [{ name: 't', type: 'string' }, ...table.variables.slice(1)] }
  assert.throws(() => computeLifeTable(text, { time: 't', status: 's' }), /随访时间要是数值变量/)
  const textStatus = { ...table, variables: [table.variables[0], { name: 's', type: 'string' }, table.variables[2]] }
  assert.throws(() => computeLifeTable(textStatus, { time: 't', status: 's' }), /状态变量要是数值变量/)
  assert.throws(() => computeLifeTable(dataset([[1, 1, 'A']]), { time: 't', status: 's' }), /可用的个案太少/)
  assert.throws(() => computeLifeTable(dataset([[1, 0, 'A'], [2, 0, 'A']]), { time: 't', status: 's' }), /状态变量里没有事件/)
  assert.throws(() => computeLifeTable(dataset(rows), { time: 't', status: 's', interval: 0.05 }), new RegExp(`最多 ${MAX_INTERVALS} 段`))
  const many = { ...table, rows: Array.from({ length: 12 }, (_, index) => [index + 1, 1, `G${index}`]) }
  assert.throws(() => computeLifeTable(many, { time: 't', status: 's', group: 'g' }), /分组太多/)
})

process.stdout.write(`\n${checks} checks in test/lifetable.mjs\n`)
if (failures.length) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
