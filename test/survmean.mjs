import assert from 'node:assert/strict'
import { computeKaplanMeier } from '../lib/survival.js'

// 均值与百分位都在插件里算（PSPP 没有生存过程），所以用例一律按定义重算：
// 限制均值 = 阶梯曲线下的面积（左端点取值），方差用 Klein–Moeschberger，
// 百分位 = 第一个 S(t) ≤ p 的事件时间。
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
  { name: 'e', type: 'numeric' },
  { name: 'g', type: 'string' },
]

function dataset(rows) {
  return { variables, rows }
}

// 十个体，时间 1..10，全部事件：S(t) = 1 − t/10。
const tenEvents = dataset(Array.from({ length: 10 }, (_, index) => [index + 1, 1, index % 2 ? 'B' : 'A']))

/** 按定义重算：面积用左端点，方差按 Klein–Moeschberger。 */
function recompute(curve, subjects, until) {
  const points = curve.filter((point) => point.time <= until)
  let area = 0
  let previous = 0
  let level = 1
  for (const point of points) {
    area += level * (point.time - previous)
    level = point.survival
    previous = point.time
  }
  area += level * Math.max(0, until - previous)
  let variance = 0
  for (const point of points) {
    if (!(point.atRisk > point.deaths)) continue
    let tail = 0
    let from = point.time
    let height = point.survival
    for (const later of points.filter((entry) => entry.time > point.time)) {
      tail += height * (later.time - from)
      height = later.survival
      from = later.time
    }
    tail += height * Math.max(0, until - from)
    variance += (tail * tail * point.deaths) / (point.atRisk * (point.atRisk - point.deaths))
  }
  return { area, se: Math.sqrt(variance) }
}

await check('the restricted mean is the area under the step curve', () => {
  const km = computeKaplanMeier(tenEvents, { time: 't', event: 'e' })
  const group = km.groups[0]
  // [0,1) 高度 1，之后每段高度 0.9、0.8 …… 0.1 ⇒ 1 + 4.5 = 5.5
  assert.ok(Math.abs(group.mean - 5.5) < 1e-6, `限制均值应为 5.5，实测 ${group.mean}`)
  assert.equal(group.followedUntil, 10, '截到尾随终点')
  const expected = recompute(group.curve, group.subjects, group.followedUntil)
  assert.ok(Math.abs(group.meanSe - expected.se) < 5e-4, `Klein–Moeschberger 标准误：${group.meanSe} vs ${expected.se}`)
  assert.ok(Math.abs(group.meanLow - Math.max(0, group.mean - 1.96 * expected.se)) < 1e-3)
  assert.ok(Math.abs(group.meanHigh - (group.mean + 1.96 * expected.se)) < 1e-3)
})

await check('the variance terms match the closed form on ten evenly spaced events', () => {
  const km = computeKaplanMeier(tenEvents, { time: 't', event: 'e' })
  const group = km.groups[0]
  // 手算：Σ tail_i² · 1 / (Y_i (Y_i − 1)) 中 tail_i 是 t_i 到 10 的面积
  const tails = []
  for (let index = 1; index <= 9; index += 1) {
    let tail = 0
    for (let step = index; step <= 9; step += 1) tail += (10 - step) / 10
    tails.push({ tail, atRisk: 11 - index })
  }
  const variance = tails.reduce((sum, item) => sum + (item.tail * item.tail) / (item.atRisk * (item.atRisk - 1)), 0)
  assert.ok(Math.abs(group.meanSe - Math.sqrt(variance)) < 5e-4, `标准误 ${group.meanSe} vs 手算 ${Math.sqrt(variance)}`)
})

await check('percentiles are the first event time reaching the percentile', () => {
  const km = computeKaplanMeier(tenEvents, { time: 't', event: 'e' })
  const group = km.groups[0]
  assert.deepEqual(group.percentiles, { p25: 8, p50: 5, p75: 3 })
  assert.equal(group.median, 5, 'median and p50 are the same point')
})

await check('a censored tail keeps the truncation at the last follow-up', () => {
  // 五例在 10 处删失，五例在 1..5 事件：随访终点 10，均值包含 5 之后那段平的曲线。
  const rows = [
    [1, 1, 'A'], [2, 1, 'A'], [3, 1, 'A'], [4, 1, 'A'], [5, 1, 'A'],
    [10, 0, 'A'], [10, 0, 'A'], [10, 0, 'A'], [10, 0, 'A'], [10, 0, 'A'],
  ]
  const km = computeKaplanMeier(dataset(rows), { time: 't', event: 'e' })
  const group = km.groups[0]
  assert.equal(group.followedUntil, 10)
  const expected = recompute(group.curve, group.subjects, group.followedUntil)
  assert.ok(Math.abs(group.mean - expected.area) < 5e-4, `面积 ${group.mean} vs ${expected.area}`)
  assert.ok(group.mean > 5, '最后 5 个单位时间曲线是平的，面积超过 5')
  assert.equal(group.percentiles.p75, 3, '百分位只看事件时间')
})

await check('a group that never reaches a percentile reports null', () => {
  // 十例里三例事件（1、2、3）、七例删失 ⇒ S 只降到 0.7，50% 与 25% 都到不了。
  // 注意 S 恰好等于 0.5 时算「达到」—— 判据是 ≤ 而不是 <。
  const rows = [
    [1, 1, 'A'], [2, 1, 'A'], [3, 1, 'A'],
    [4, 0, 'A'], [5, 0, 'A'], [6, 0, 'A'], [7, 0, 'A'], [8, 0, 'A'], [9, 0, 'A'], [10, 0, 'A'],
  ]
  const km = computeKaplanMeier(dataset(rows), { time: 't', event: 'e' })
  const group = km.groups[0]
  assert.equal(group.median, null, 'S 没降到 0.5 ⇒ 中位数未达到')
  assert.equal(group.percentiles.p25, null)
  assert.equal(group.percentiles.p75, 3, '75% 在第一个事件时间就到了')
})

await check('groups are estimated separately', () => {
  const km = computeKaplanMeier(tenEvents, { time: 't', event: 'e', group: 'g' })
  assert.equal(km.groups.length, 2)
  for (const group of km.groups) {
    const expected = recompute(group.curve, group.subjects, group.followedUntil)
    assert.ok(Math.abs(group.mean - expected.area) < 5e-4, `${group.label} 面积 ${group.mean} vs ${expected.area}`)
    assert.ok(group.meanSe > 0, `${group.label} 标准误应为正`)
  }
})

await check('the mean never exceeds the follow-up and is never negative', () => {
  const km = computeKaplanMeier(tenEvents, { time: 't', event: 'e' })
  const group = km.groups[0]
  assert.ok(group.mean >= 0)
  assert.ok(group.mean <= group.followedUntil, '限制均值不能超过截尾时间')
  assert.ok(group.meanLow <= group.mean && group.mean <= group.meanHigh, '区间要包住估计值')
})

process.stdout.write(`\n${checks} checks in test/survmean.mjs\n`)
if (failures.length) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
