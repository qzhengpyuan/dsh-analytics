// Kaplan–Meier and the log-rank test. Pure: the curve is estimated in
// lib/survival.js and drawn by lib/charts.js, so nothing here needs the engine.
import assert from 'node:assert/strict'

import { computeKaplanMeier } from '../lib/survival.js'
import { renderSvg } from '../lib/charts.js'

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

const dataset = (rows, group = false) => ({
  variables: [
    { name: 't', type: 'numeric' },
    { name: 'e', type: 'numeric' },
    ...(group ? [{ name: 'g', type: 'string' }] : []),
  ],
  rows,
})

check('the product-limit estimate drops only at event times', () => {
  // Ten cases, events at 1,2,3 then a censor at 4, events at 5,6, a censor at 8.
  const rows = [
    [1, 1], [2, 1], [3, 1], [4, 0], [5, 1], [6, 1], [7, 1], [8, 0], [9, 1], [10, 1],
  ]
  const model = computeKaplanMeier(dataset(rows), { time: 't', event: 'e' })
  assert.equal(model.groups.length, 1)
  const curve = model.groups[0].curve
  assert.deepEqual(curve.map((point) => point.time), [1, 2, 3, 5, 6, 7, 9, 10], 'censored times are not drops')
  assert.deepEqual(
    curve.map((point) => point.survival),
    [0.9, 0.8, 0.7, 0.5833, 0.4667, 0.35, 0.175, 0],
    'each step multiplies by 1 − d/n',
  )
  assert.equal(curve[0].atRisk, 10)
  assert.equal(curve[3].atRisk, 6, 'the censored case at 4 leaves the risk set before 5')
  assert.equal(model.groups[0].median, 6, 'the first time the curve is at or below 50%')
  assert.equal(model.groups[0].n, 10)
  assert.equal(model.groups[0].events, 8)
  assert.equal(model.groups[0].censored, 2)
})

check('censor marks ride on the curve at the height they left', () => {
  const rows = [[1, 1], [2, 1], [3, 0], [4, 1], [5, 0]]
  const model = computeKaplanMeier(dataset(rows), { time: 't', event: 'e' })
  assert.deepEqual(model.groups[0].censoredTicks, [
    { time: 3, survival: 0.6 },
    { time: 5, survival: 0.3 },
  ])
})

check('a median is reported as null when the curve never reaches 50%', () => {
  const rows = [[1, 0], [2, 0], [3, 0]]
  const model = computeKaplanMeier(dataset(rows), { time: 't', event: 'e' })
  assert.equal(model.groups[0].curve.length, 0, 'no event means no step')
  assert.equal(model.groups[0].median, null)
})

check('the log-rank test matches a hand-computed two-group example', () => {
  // A: 1, 2 (both events). B: 1, 3 (both events).
  // t=1: risk 2/2, deaths 1/1 → E_A = 1, variance 0.3333
  // t=2: risk 1/1, deaths 1/0 → E_A = 0.5, variance 0.25
  // O_A = 2, E_A = 1.5, V = 0.5833 → χ² = 0.4286 with df 1.
  const rows = [[1, 1, 'A'], [2, 1, 'A'], [1, 1, 'B'], [3, 1, 'B']]
  const model = computeKaplanMeier(dataset(rows, true), { time: 't', event: 'e', group: 'g' })
  assert.equal(model.groups.length, 2)
  assert.equal(model.logRank.chiSquare, 0.4286)
  assert.equal(model.logRank.df, 1)
  assert.ok(Math.abs(model.logRank.p - 0.5127) < 0.001, `expected p ≈ 0.5127, got ${model.logRank.p}`)
})

check('a grouped curve reports every group and the test, an ungrouped one has no test', () => {
  const rows = [[1, 1, 'A'], [2, 1, 'A'], [1, 1, 'B'], [3, 1, 'B']]
  const grouped = computeKaplanMeier(dataset(rows, true), { time: 't', event: 'e', group: 'g' })
  assert.deepEqual(grouped.groups.map((group) => group.label), ['A', 'B'])
  assert.equal(grouped.logRank.df, 1)
  const flat = computeKaplanMeier(dataset(rows.map((row) => row.slice(0, 2))), { time: 't', event: 'e' })
  assert.equal(flat.logRank, null, 'one curve cannot be compared with itself')
})

check('missing times and missing flags drop out instead of becoming zeros', () => {
  const rows = [[1, 1], [null, 1], [2, null], [3, 1], ['', 1]]
  const model = computeKaplanMeier(dataset(rows), { time: 't', event: 'e' })
  assert.equal(model.groups[0].n, 2, 'only the two complete cases count')
  assert.deepEqual(model.groups[0].curve.map((point) => point.time), [1, 3])
})

check('a text time or text event variable is refused by name', () => {
  const text = {
    variables: [{ name: 't', type: 'string' }, { name: 'e', type: 'numeric' }],
    rows: [['a', 1]],
  }
  assert.throws(() => computeKaplanMeier(text, { time: 't', event: 'e' }), /生存时间要求数值变量/, 'a text time is named')
  const textEvent = {
    variables: [{ name: 't', type: 'numeric' }, { name: 'e', type: 'string' }],
    rows: [[1, 'yes']],
  }
  assert.throws(() => computeKaplanMeier(textEvent, { time: 't', event: 'e' }), /事件指示变量要求数值/, 'a text flag is named')
  assert.throws(() => computeKaplanMeier(text, { time: 'nope', event: 'e' }), /没有这个变量：nope/, 'an unknown variable is named')
})

check('the survival figure draws a step curve, the legend and the log-rank line', () => {
  const rows = [[1, 1, 'A'], [2, 1, 'A'], [1, 1, 'B'], [3, 1, 'B']]
  const svg = renderSvg(computeKaplanMeier(dataset(rows, true), { time: 't', event: 'e', group: 'g' }))
  assert.match(svg, /log-rank χ² = 0\.429/, 'the test result is printed inside the figure')
  assert.match(svg, /50%/, 'the y axis is in survival percentages')
  assert.match(svg, /A \(n=2, 事件 2\)/, 'the legend carries the group size')
  assert.match(svg, /随访时间（t）/, 'the x axis says which variable it is')
  // The median survival is what a paper quotes next to the curve; a group that
  // never reaches 50% has to say so instead of printing a zero.
  assert.match(svg, /中位生存期：A = 1，B = 1/, 'the medians are printed under the axis')
})

check('a group that never falls to 50% prints a dash as its median', () => {
  // Five cases, one event: S bottoms out at 0.8, so no median exists.
  const rows = [[1, 1], [2, 0], [3, 0], [4, 0], [5, 0]]
  const model = computeKaplanMeier(dataset(rows, false), { time: 't', event: 'e' })
  assert.equal(model.groups[0].median, null, 'the model says the median is unknown')
  const svg = renderSvg(model)
  assert.match(svg, /中位生存期 = —/, 'and the figure says so with a dash')
  assert.match(svg, /height="378"/, 'the extra text line gets its own room')
})

console.log(`${checks} checks passed`)
