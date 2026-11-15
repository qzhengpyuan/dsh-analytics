// Pure-function tests: syntax builders and chart models (no engine needed).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildAnalysis, buildTransform, buildChart, analysisExtras, itemsForAgent } from '../lib/tools.js'
import { computeBar, computeHistogram, computeScatter, computeBox, computeLine, computePie, computeDualLine, renderSvg, buildChartModel, tCritical95, studentTwoSidedP, welchTest, significanceLabel } from '../lib/charts.js'
import { decodeText, guessDelimiter, importDelimited } from '../lib/dataset.js'
import { stringifyCsv } from '../lib/csv.js'
import { describeFsError } from '../lib/fserr.js'
import { sanitizeTableHtml } from '../lib/html.js'
import { rasterizeSvg } from '../lib/raster.js'

let checks = 0
// The callers below do not await, so every run is collected and the summary
// waits for all of them: without that the tail printed "N checks passed"
// before the last few had even started.
const pending = []
const check = (name, fn) => {
  const run = (async () => {
    try {
      await fn()
      checks += 1
      console.log(`ok   ${name}`)
    } catch (error) {
      console.error(`FAIL ${name}: ${error.message}`)
      process.exitCode = 1
    }
  })()
  pending.push(run)
  return run
}

// ---- syntax builders -------------------------------------------------------
check('ttest_one_sample uses TESTVAL', () => {
  const syntax = buildAnalysis('ttest_one_sample', { variables: ['score'], testValue: 60 })
  assert.equal(syntax, 'T-TEST /TESTVAL=60 /VARIABLES=score.')
})

check('non-parametric tests quote string group codes too', () => {
  assert.equal(
    buildAnalysis('npar_mannwhitney', { variables: ['score'], by: 'grp', groupValues: ['A', 'B'], groupString: true }),
    `NPAR TESTS /MANN-WHITNEY=score BY grp('A' 'B').`,
  )
  assert.equal(
    buildAnalysis('npar_kruskal', { variables: ['score'], by: 'grp', groupValues: ['A', 'B', 'C'], groupString: true }),
    `NPAR TESTS /KRUSKAL-WALLIS=score BY grp('A' 'B' 'C').`,
  )
  // A numeric grouping variable keeps the bare "(1 3)" span.
  assert.equal(
    buildAnalysis('npar_kruskal', { variables: ['score'], by: 'group', groupValues: [1, 3], groupString: false }),
    'NPAR TESTS /KRUSKAL-WALLIS=score BY group(1 3).',
  )
})

check('a string grouping variable gets quoted codes', () => {
  // Without the quotes PSPP stops at "Syntax error expecting string" and never
  // says a quote is the problem.
  assert.equal(
    buildAnalysis('ttest_independent', { variables: ['score'], by: 'grp', groupValues: ['A', 'B'], groupString: true }),
    `T-TEST GROUPS=grp('A' 'B') /VARIABLES=score.`,
  )
  assert.equal(
    buildAnalysis('ttest_independent', { variables: ['score'], by: 'male', groupValues: ['0', '1'], groupString: false }),
    'T-TEST GROUPS=male(0 1) /VARIABLES=score.',
  )
  // A quote inside a code is doubled so the syntax stays balanced.
  assert.match(
    buildAnalysis('ttest_independent', { variables: ['score'], by: 'grp', groupValues: ["O'Neil", 'B'], groupString: true }),
    /GROUPS=grp\('O''Neil' 'B'\)/,
  )
})

check('ttest_one_sample defaults to 0', () => {
  assert.match(buildAnalysis('ttest_one_sample', { variables: ['score'] }), /\/TESTVAL=0 /)
})

check('logistic regression asks for the odds-ratio interval', () => {
  const syntax = buildAnalysis('logistic', { dependent: 'y', independents: ['age', 'sex'] })
  // /METHOD=ENTER is not PSPP syntax; the print request is what carries Exp(B).
  assert.equal(syntax, 'LOGISTIC REGRESSION y WITH age sex /PRINT=CI(95) SUMMARY.')
})

check('logistic regression takes another confidence level', () => {
  assert.match(buildAnalysis('logistic', { dependent: 'y', independents: ['age'], ci: 90 }), /\/PRINT=CI\(90\) SUMMARY\.$/)
  assert.match(buildAnalysis('logistic', { dependent: 'y', independents: ['age'], ci: 0 }), /\/PRINT=CI\(95\) SUMMARY\.$/)
})

check('roc prints the coordinate table', () => {
  const syntax = buildAnalysis('roc', { variables: ['marker'], by: 'group', value: 1 })
  assert.equal(syntax, 'ROC marker BY group(1) /PLOT=CURVE /PRINT=COORDINATES.')
})

check('sample transform takes a percentage', () => {
  assert.equal(buildTransform('sample', { percent: 50 }), 'SAMPLE 0.5.')
  assert.equal(buildTransform('sample', { percent: 25 }), 'SAMPLE 0.25.')
  assert.throws(() => buildTransform('sample', { percent: 0 }), /between 1 and 100/)
})

check('count transform', () => {
  assert.equal(buildTransform('count', { variables: ['age', 'score'], target: 'n', value: 0 }), 'COUNT n = age score (0).')
})

check('rank transform', () => {
  assert.equal(buildTransform('rank', { variable: 'score', target: 'r' }), 'RANK VARIABLES=score /RANK INTO r /TIES=MEAN.')
  assert.equal(buildTransform('rank', { variable: 'score' }), 'RANK VARIABLES=score /RANK INTO r_score /TIES=MEAN.')
})

check('ctables without scale column', () => {
  const syntax = buildAnalysis('ctables', { row: 'score', column: 'gender', statistics: ['COUNT', 'MEAN'] })
  assert.ok(syntax.startsWith('CTABLES /TABLE=score [COUNT, MEAN] BY gender'))
  assert.ok(syntax.includes("/TITLES TITLE='score 按 gender 统计'"))
  assert.ok(!syntax.includes('VARIABLE LEVEL'))
})

check('ctables demotes scale column to nominal', () => {
  const syntax = buildAnalysis('ctables', { row: 'score', column: 'group', columnMeasure: 'scale', statistics: ['COUNT'] })
  assert.equal(syntax.split('\n')[0], 'VARIABLE LEVEL group (NOMINAL).')
  assert.match(syntax, /\/CRITERIA CILEVEL 95\.$/)
})

check('ctables drops unsupported summary functions', () => {
  const syntax = buildAnalysis('ctables', { row: 'score', column: 'gender', statistics: ['MIN', 'MAX', 'count'] })
  assert.ok(syntax.startsWith('CTABLES /TABLE=score [COUNT] BY gender'), syntax)
})

check('ctables include missing and CI level', () => {
  const syntax = buildAnalysis('ctables', { row: 'score', column: 'gender', includeMissing: true, ciLevel: 99 })
  assert.ok(syntax.includes('/CATEGORIES VARIABLES=gender ORDER=A MISSING=INCLUDE'))
  assert.ok(syntax.endsWith('/CRITERIA CILEVEL 99.'), syntax)
})

check('npar subcommands', () => {
  assert.match(buildAnalysis('npar_binomial', { variable: 'flag', testValue: 0.5 }), /\/BINOMIAL\(0\.5\)/)
  assert.match(buildAnalysis('npar_ks', { variables: ['score'] }), /\/K-S\(NORMAL\)/)
  assert.match(buildAnalysis('npar_runs', { variables: ['score'] }), /\/RUNS\(MEDIAN\)/)
  assert.match(buildAnalysis('npar_wilcoxon', { variables: ['a', 'b'] }), /\/WILCOXON/)
  assert.match(buildAnalysis('npar_sign', { variables: ['a', 'b'] }), /\/SIGN/)
  assert.match(buildAnalysis('npar_mannwhitney', { variables: ['score'], by: 'gender', groups: [1, 2] }), /\/MANN-WHITNEY=score BY gender\(1 2\)/)
  assert.match(buildAnalysis('npar_kruskal', { variables: ['score'], by: 'group', groups: [1, 3] }), /\/KRUSKAL-WALLIS=score BY group\(1 3\)/)
  assert.match(buildAnalysis('npar_friedman', { variables: ['a', 'b', 'c'] }), /\/FRIEDMAN=a b c/)
})

// ---- chart models ----------------------------------------------------------
const dataset = {
  variables: [
    { name: 'gender', label: '性别', type: 'string' },
    { name: 'age', label: '年龄', type: 'numeric' },
    { name: 'score', label: '得分', type: 'numeric' },
    { name: 'group', label: '组别', type: 'numeric', valueLabels: { '1': '低', '2': '高' } },
  ],
  rows: [
    ['女', 20, 50, 1],
    ['女', 24, 70, 2],
    ['男', 30, 60, 1],
    ['男', 36, 90, 2],
    ['女', 40, 80, 2],
  ],
}

check('bar groups by string variable', () => {
  const model = computeBar(dataset, { variable: 'score', by: 'gender', statistic: 'MEAN' })
  const female = model.categories.find((entry) => entry.label === '女')
  assert.equal(female.count, 3)
  assert.ok(Math.abs(female.value - 66.67) < 0.01, String(female.value))
})

check('bar uses value labels', () => {
  const model = computeBar(dataset, { variable: 'score', by: 'group', statistic: 'COUNT' })
  assert.deepEqual(model.categories.map((entry) => entry.label).sort(), ['低', '高'])
})

check('bar clusters by a second variable', () => {
  const model = computeBar(dataset, { variable: 'score', by: 'gender', cluster: 'group', statistic: 'MEAN' })
  assert.equal(model.shape, 'clustered')
  assert.deepEqual(model.series.map((entry) => entry.key), ['1', '2'])
  const maleLow = model.categories.find((entry) => entry.label === '男' && entry.clusterKey === '1')
  assert.equal(maleLow.value, 60)
  assert.equal(maleLow.cluster, '低', 'the cluster name uses the value label')
})

check('bar stacks by a second variable', () => {
  const model = computeBar(dataset, { variable: 'age', by: 'gender', stack: 'group', statistic: 'SUM' })
  assert.equal(model.shape, 'stacked')
  assert.equal(model.series.length, 2)
  const femaleLow = model.categories.find((entry) => entry.label === '女' && entry.stackKey === '1')
  assert.equal(femaleLow.value, 20)
})

check('bar refuses two grouping dimensions at once', () => {
  assert.throws(
    () => computeBar(dataset, { variable: 'score', by: 'gender', cluster: 'group', stack: 'group' }),
    /一次只能有一个分组维度/,
  )
  assert.throws(() => computeBar(dataset, { variable: 'score', cluster: 'nope' }), /unknown variable: nope/)
  assert.throws(
    () => computeBar(dataset, { variable: 'score', by: 'gender', stack: 'gender' }),
    /类别变量不能同时用作分组或堆叠变量/,
  )
})

check('bar carries a standard deviation for the error bars', () => {
  const model = computeBar(dataset, { variable: 'score', by: 'gender', errorBars: true })
  // `true` is shorthand for one standard deviation; the model reports which
  // whisker it drew so the legend and the exports can name it.
  assert.equal(model.errorBars, 'sd')
  const female = model.categories.find((entry) => entry.label === '女')
  // 50, 70, 80: mean 66.67, sample sd 15.28
  assert.ok(Math.abs(female.sd - 15.28) < 0.02, String(female.sd))
  assert.ok(Math.abs(female.se - 8.82) < 0.02, String(female.se))
  assert.deepEqual([female.errorLow, female.errorHigh], [51.39, 81.94])
  const male = model.categories.find((entry) => entry.label === '男')
  // two cases still give an sd; a single case would get none
  assert.ok(male.sd > 0)
})

check('error bars are only drawn when there is spread to show', () => {
  const one = { variables: dataset.variables, rows: [['女', 20, 50, 1]] }
  const model = computeBar(one, { variable: 'score', by: 'gender', errorBars: true })
  assert.equal(model.errorBars, false)
  assert.equal(model.categories[0].sd, undefined)
})

check('renderSvg draws whiskers and a legend for a clustered bar', () => {
  const model = computeBar(dataset, { variable: 'score', by: 'gender', cluster: 'group', errorBars: true })
  const svg = renderSvg(model)
  assert.ok(svg.includes('stroke="#24405f"'), 'whisker strokes are present')
  assert.ok((svg.match(/<rect/g) ?? []).length >= 6, 'bars plus legend swatches')
  const labels = svg.match(/>([^<]+)<\/text>/g) ?? []
  assert.ok(labels.some((entry) => entry.includes('低')), 'legend shows the value label')
})

check('renderSvg stacks segments without gaps', () => {
  const model = computeBar(dataset, { variable: 'age', by: 'gender', stack: 'group', statistic: 'SUM' })
  const svg = renderSvg(model)
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  // Female slot: 20 (group 1) and 50 (group 2) stack into one 70-high column.
  // Labels sort by locale, so the male slot comes first; the female slot holds
  // group 1 (age 20) under group 2 (age 70), both at one x position.
  // Skip the plot background, which starts at x=0 and spans the whole canvas.
  const byX = new Map()
  for (const match of rects) {
    const x = Number(match[1])
    if (x <= 0 || Number(match[3]) > 100) continue
    byX.set(x, (byX.get(x) ?? 0) + 1)
  }
  const stacked = [...byX.values()].filter((count) => count === 2)
  assert.equal(stacked.length, 2, 'both category slots carry two segments')
  // Segment geometry: the higher segment is drawn from a smaller y (closer to
  // the top) and must end exactly where the lower one begins.
  const slot = rects
    .filter((match) => Number(match[1]) === [...byX.keys()][0] && Number(match[3]) < 100)
    .sort((left, right) => Number(left[2]) - Number(right[2]))
  // Ascending y means the upper segment comes first.
  const upper = slot[0]
  const lower = slot[1]
  const upperBottom = Number(upper[2]) + Number(upper[4])
  assert.ok(Math.abs(upperBottom - Number(lower[2])) < 0.5, `gap between segments: ${upperBottom} vs ${lower[2]}`)
  assert.ok(Math.abs(Number(lower[2]) + Number(lower[4]) - 312) < 0.5, 'the lower segment sits on the baseline')
})

check('line splits into one series per value of the grouping variable', () => {
  const model = computeLine(dataset, { variable: 'score', by: 'group', cluster: 'gender' })
  assert.equal(model.series.length, 2)
  assert.deepEqual(model.series.map((entry) => entry.key).sort(), ['女', '男'])
  const female = model.series.find((entry) => entry.key === '女')
  assert.equal(female.points.length, 2, 'one point per category, with gaps kept as null')
  assert.equal(female.points.find((point) => point.label === '低' || point.label === '高').value !== undefined, true)
})

check('a plain line keeps the single-series shape', () => {
  const model = computeLine(dataset, { variable: 'score', by: 'group' })
  assert.equal(model.series, null)
  assert.equal(model.points.length, 2)
})

check('renderSvg draws one polyline and a legend per line series', () => {
  const model = computeLine(dataset, { variable: 'score', by: 'group', cluster: 'gender' })
  const svg = renderSvg(model)
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2)
  const texts = svg.match(/>([^<]+)<\/text>/g) ?? []
  assert.ok(texts.some((entry) => entry.includes('女')) && texts.some((entry) => entry.includes('男')), 'legend carries both labels')
})

check('line with error bars carries sd and draws whiskers', () => {
  // Whiskers are an interval, not "±1 SD": SE and the 95% CI are what a paper
  // reports, and t(0.975, n-1) makes the CI visibly taller than the SE.
  {
    const whisk = { variables: [{ name: 'g', type: 'numeric' }, { name: 'x', type: 'numeric' }],
      rows: [[1, 10], [1, 12], [1, 14], [2, 20], [2, 22], [2, 26]] }
    const sd = computeBar(whisk, { variable: 'x', by: 'g', errorBars: 'sd' })
    assert.equal(sd.errorBarLabel, '误差线 ±1 SD')
    assert.deepEqual(sd.categories.map((entry) => [entry.errorLow, entry.errorHigh]), [[10, 14], [19.61, 25.72]])
    const se = computeBar(whisk, { variable: 'x', by: 'g', errorBars: 'se' })
    assert.deepEqual(se.categories.map((entry) => [entry.errorLow, entry.errorHigh]), [[10.85, 13.15], [20.9, 24.43]])
    const ci = computeBar(whisk, { variable: 'x', by: 'g', errorBars: 'ci95' })
    assert.equal(ci.errorBarLabel, '误差线 95% CI')
    // n = 3 → t(0.975, 2) = 4.303, so ±2 * 1.155 * 4.303 = ±4.97
    assert.deepEqual(ci.categories.map((entry) => [entry.errorLow, entry.errorHigh]), [[7.03, 16.97], [15.08, 30.26]])
    // The quantile is inverted from the p-value, so it is exact for a
    // fractional Welch df instead of snapping down to the integer table row.
    assert.ok(Math.abs(tCritical95(2) - 4.30265) < 0.0005)
    assert.ok(Math.abs(tCritical95(30) - 2.04227) < 0.0005)
    assert.ok(Math.abs(tCritical95(2.881) - 3.25812) < 0.001)
    assert.ok(tCritical95(200) < 1.98 && tCritical95(200) > 1.96)
    const svg = renderSvg(ci)
    assert.ok(svg.includes('<line'), 'the whisker is drawn')
    const line = computeLine(whisk, { variable: 'x', by: 'g', errorBars: 'ci95' })
    assert.equal(line.points[0].errorLow, 7.03, 'a line point carries the same interval')
  }

  const model = computeLine(dataset, { variable: 'score', by: 'group', errorBars: true })
  assert.equal(model.errorBars, true)
  assert.equal(model.errorBarLabel, '误差线 ±1 SD')
  assert.ok(model.points.every((point) => typeof point.sd === 'number'), 'every point has a spread')
  const svg = renderSvg(model)
  assert.equal((svg.match(/stroke="#24405f"/g) ?? []).length, model.points.length * 3, 'one vertical plus two caps per point')
})

check('a line with a single case per category drops the whiskers', () => {
  const one = { variables: dataset.variables, rows: [['女', 20, 50, 1], ['男', 30, 60, 2]] }
  const model = computeLine(one, { variable: 'score', by: 'gender', errorBars: true })
  assert.equal(model.errorBars, false)
  assert.equal(renderSvg(model).includes('stroke="#24405f"'), false)
})

check('significance brackets come from a Welch t test on the raw cases', () => {
  // Significance brackets: the asterisks come from a Welch t test on the raw
  // cases, so the chart does not need a separate analysis run to annotate.
  {
    const groups = { variables: [{ name: 'g', type: 'string' }, { name: 'x', type: 'numeric' }],
      rows: [['甲', 10], ['甲', 12], ['甲', 14], ['乙', 20], ['乙', 22], ['乙', 26]] }
    assert.equal(studentTwoSidedP(2, 10).toFixed(4), '0.0734')
    assert.equal(studentTwoSidedP(2.228, 10).toFixed(4), '0.0500')
    assert.equal(significanceLabel(0.0005), '***')
    assert.equal(significanceLabel(0.2), 'ns')
    const test = welchTest([10, 12, 14], [20, 22, 26])
    assert.ok(Math.abs(test.p - 0.0106) < 0.0005, String(test.p))
    const model = computeBar(groups, { variable: 'x', by: 'g', significance: 'auto' })
    assert.equal(model.significance.length, 1)
    assert.equal(model.significance[0].label, '*')
    assert.equal(model.significance[0].from, '甲')
    assert.ok(renderSvg(model).includes('<path'), 'the bracket is drawn')
    const named = computeBar(groups, { variable: 'x', by: 'g', significance: [{ from: '甲', to: '乙', label: 'P=0.011' }] })
    assert.equal(named.significance[0].label, 'P=0.011')
  }
})

check('a dual-axis line reads each series against its own scale', () => {
  const dual = { variables: [{ name: 't', type: 'numeric' }, { name: 'n', type: 'numeric' }, { name: 'c', type: 'numeric' }],
    rows: [[1, 10, 1.2], [1, 12, 1.4], [2, 30, 2.1], [2, 28, 2.3], [3, 18, 3.4], [3, 20, 3.1]] }
  const model = computeDualLine(dual, { variable: 'n', by: 't', y2: 'c' })
  assert.equal(model.kind, 'line2')
  assert.deepEqual(model.labels, ['1', '2', '3'])
  assert.deepEqual(model.axes[0].series.values, [11, 29, 19])
  assert.deepEqual(model.axes[1].series.values, [1.3, 2.2, 3.25])
  const svg = renderSvg(model)
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2, 'one line per axis')
  assert.ok(svg.includes('（左轴）') && svg.includes('（右轴）'))
  assert.throws(() => computeDualLine(dual, { variable: 'n', by: 't' }), /需要第二个变量/)
  assert.throws(() => computeDualLine(dual, { variable: 'n', by: 't', y2: 'nope' }), /unknown variable: nope/)
})

check('percentage stack fills every bar to exactly 100', () => {
  const model = computeBar(dataset, { variable: 'age', by: 'gender', stack: 'group', statistic: 'SUM', shape: 'stacked100' })
  assert.equal(model.shape, 'stacked100')
  const svg = renderSvg(model)
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]) }))
    // Skip the legend swatches: a bar always starts at the plot top (y=40) or
    // below, while the legend sits above it at y=26.
    .filter((rect) => rect.w < 100 && rect.y >= 40)
  const slots = new Map()
  for (const rect of rects) {
    const entry = slots.get(rect.x) ?? { height: 0, top: Infinity, bottom: -Infinity }
    entry.height += rect.h
    entry.top = Math.min(entry.top, rect.y)
    entry.bottom = Math.max(entry.bottom, rect.y + rect.h)
    slots.set(rect.x, entry)
  }
  assert.equal(slots.size, 2, 'one bar per category')
  // The plot runs y=40 to y=312 for every shape, so a full bar is 272 tall.
  for (const [, slot] of slots) {
    assert.ok(Math.abs(slot.height - 272) < 1.5, `bar height ${slot.height}`)
    assert.ok(Math.abs(slot.top - 40) < 1.5 && Math.abs(slot.bottom - 312) < 1.5, 'top and bottom are pinned')
  }
})

check('a percentage stack needs its stack variable', () => {
  const model = computeBar(dataset, { variable: 'age', by: 'gender', shape: 'stacked100' })
  assert.equal(model.shape, 'simple', 'without a stack there is nothing to normalise')
})

check('area chart stacks one polygon per series', () => {
  const model = buildChartModel(dataset, 'area', { variable: 'age', by: 'gender', cluster: 'group' })
  assert.equal(model.kind, 'area')
  assert.equal(model.series.length, 2)
  assert.equal((renderSvg(model).match(/<polygon/g) ?? []).length, 2)
})

check('an area chart without a split is a single filled trend', () => {
  const model = buildChartModel(dataset, 'area', { variable: 'age', by: 'gender' })
  assert.equal(model.series.length, 1)
  assert.equal((renderSvg(model).match(/<polygon/g) ?? []).length, 1)
})

check('donut is part of the model, not a render-time option', () => {
  const donut = buildChartModel(dataset, 'pie', { variable: 'gender', donut: true })
  assert.equal(donut.donut, true)
  assert.ok(donut.title.includes('环形'))
  const disc = buildChartModel(dataset, 'pie', { variable: 'gender' })
  assert.equal(disc.donut, false)
  const ring = renderSvg(donut)
  assert.equal((ring.match(/<path/g) ?? []).length, 2, 'one ring segment per slice')
})

check('histogram bins stay within range', () => {
  const model = computeHistogram(dataset, { variable: 'score', bins: 4 })
  assert.equal(model.bins.length, 4)
  assert.equal(model.bins.reduce((sum, bin) => sum + bin.count, 0), 5)
})

check('histogram carries a normal overlay', () => {
  const model = computeHistogram(dataset, { variable: 'score', bins: 4 })
  assert.equal(model.normal.points.length, 4)
  assert.ok(model.normal.sd > 0, String(model.normal.sd))
  // Expected counts peak at the mean and stay non-negative.
  assert.ok(model.normal.points.every((point) => point.expected >= 0))
  const svg = renderSvg(model)
  assert.ok(svg.includes('<polyline'), 'normal curve missing')
})

check('scatter keeps numeric pairs', () => {
  const model = computeScatter(dataset, { x: 'age', y: 'score' })
  assert.equal(model.points.length, 5)
  assert.deepEqual(model.points[0], [20, 50])
})

check('box summary uses five numbers', () => {
  const model = computeBox(dataset, { variable: 'score' })
  const [group] = model.groups
  assert.equal(group.count, 5)
  assert.equal(group.min, 50)
  assert.equal(group.max, 90)
  assert.equal(group.median, 70)
})

check('line sorts numeric categories', () => {
  const model = computeLine(dataset, { variable: 'score', by: 'age' })
  const ages = model.points.map((point) => Number(point.label))
  assert.deepEqual(ages, [...ages].sort((a, b) => a - b))
})

check('pie slices keep counts and labels', () => {
  const model = computePie(dataset, { variable: 'gender' })
  assert.equal(model.slices.reduce((sum, slice) => sum + slice.value, 0), 5)
  assert.deepEqual(model.slices.map((slice) => slice.label).sort(), ['女', '男'])
})

check('renderSvg produces one branch per chart kind', () => {
  const kinds = {
    bar: () => computeBar(dataset, { variable: 'score', by: 'gender' }),
    histogram: () => computeHistogram(dataset, { variable: 'score' }),
    scatterplot: () => computeScatter(dataset, { x: 'age', y: 'score' }),
    boxplot: () => computeBox(dataset, { variable: 'score', by: 'gender' }),
    line: () => computeLine(dataset, { variable: 'score', by: 'age' }),
    pie: () => computePie(dataset, { variable: 'gender' }),
  }
  for (const [kind, build] of Object.entries(kinds)) {
    const svg = renderSvg(build())
    assert.ok(svg.startsWith('<svg'), kind)
    assert.ok(svg.includes('</svg>'), kind)
  }
})

check('buildChartModel dispatches every kind', () => {
  assert.equal(buildChartModel(dataset, 'boxplot', { variable: 'score' }).kind, 'boxplot')
  assert.equal(buildChartModel(dataset, 'line', { variable: 'score', by: 'age' }).kind, 'line')
  assert.equal(buildChartModel(dataset, 'pie', { variable: 'gender' }).kind, 'pie')
})

check('chart rejects unknown variable', () => {
  assert.throws(() => computeBar(dataset, { variable: 'nope' }), /unknown variable/)
})

check('factor uses NOROTATE and prints KMO by default', () => {
  assert.equal(
    buildAnalysis('factor', { variables: ['a', 'b', 'c'] }),
    'FACTOR /VARIABLES=a b c /PRINT=INITIAL KMO EXTRACTION ROTATION /ROTATION=VARIMAX.')
  assert.equal(
    buildAnalysis('factor', { variables: ['a', 'b'], rotation: 'NONE' }),
    'FACTOR /VARIABLES=a b /PRINT=INITIAL KMO EXTRACTION /ROTATION=NOROTATE.')
  assert.equal(
    buildAnalysis('factor', { variables: ['a', 'b'], rotation: 'PROMAX' }),
    'FACTOR /VARIABLES=a b /PRINT=INITIAL KMO EXTRACTION ROTATION /ROTATION=PROMAX.')
})

check('engine chart builder keeps what PSPP can draw', () => {
  assert.equal(buildChart('bar', { variable: 'score', by: 'gender' }), 'GRAPH /BAR(SIMPLE)=MEAN(score) BY gender.')
  assert.throws(() => buildChart('boxplot', { variable: 'score' }), /not supported by the engine/)
})

check('regression can save predictions and residuals', () => {
  // TOL is not requested: with it PSPP dies inside gsl_blas_dsymm on about one
  // run in six. Tolerance and VIF come from the plugin instead.
  assert.equal(
    buildAnalysis('regression', { dependent: 'score', independents: ['age'], save: ['pred', 'resid'] }),
    'REGRESSION /DEPENDENT=score /METHOD=ENTER age /SAVE=PRED RESID /STATISTICS=COEFF R ANOVA CI.')
  assert.equal(
    buildAnalysis('regression', { dependent: 'score', independents: ['age'] }),
    'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=COEFF R ANOVA CI.')
  assert.deepEqual(
    analysisExtras('regression', { dependent: 'score', independents: ['age', 'weight'] }),
    { regression: { dependent: 'score', independents: ['age', 'weight'] } })
  // Asking for TOL explicitly still reaches the engine, and the hint travels too:
  // A logistic result hands the outcome and the predictors to the ROC dialog:
  // asking for both variables again is the step users forget.
  assert.deepEqual(
    analysisExtras('logistic', { dependent: 'y', independents: ['score', 'age'] }),
    { roc: { by: 'y', variables: ['score', 'age'] } })
  assert.deepEqual(analysisExtras('logistic', { dependent: 'y' }), {})
  // if the engine crashes and the retry drops TOL, the retry has to deliver the
  // collinearity table the log promised. runSyntax skips it when the engine
  // printed Tolerance itself, so passing the hint never duplicates a table.
  assert.deepEqual(
    analysisExtras('regression', { dependent: 'score', independents: ['age'], statistics: ['TOL'] }),
    { regression: { dependent: 'score', independents: ['age'] } })
  assert.deepEqual(
    analysisExtras('regression', { dependent: 'score', independents: ['age'], statistics: ['ALL'] }),
    { regression: { dependent: 'score', independents: ['age'] } })
  assert.deepEqual(analysisExtras('regression', { dependent: 'score', independents: ['age'], collinearity: false }), {})
  // An explicit list wins, and unknown keywords are dropped rather than sent.
  assert.equal(
    buildAnalysis('regression', { dependent: 'score', independents: ['age'], statistics: ['BCOV', 'DURBIN'] }),
    'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=BCOV.')
  assert.equal(
    buildAnalysis('regression', { dependent: 'score', independents: ['age'], confidence: false, collinearity: false }),
    'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=COEFF R ANOVA.')
})

check('agent-facing tables keep the hints the output shows', () => {
  // A logistic result is useless to the agent without knowing which variable was
  // the outcome: that is exactly what the ROC follow-up needs.
  const workspace = { artifactPath: (runId, name) => `/runs/${runId}/${name}` }
  const items = itemsForAgent(workspace, [
    { kind: 'table', id: 'a', title: 'Variables in the Equation', table: { matrix: [['x']] }, roc: { by: 'y', variables: ['fpg'] } },
    { kind: 'table', id: 'b', title: 'ANOVA', table: { matrix: [['x']] }, pairwise: { group: 'g', variables: ['x'] } },
    { kind: 'table', id: 'c', title: 'Descriptives', table: { matrix: [['x']] } },
    { kind: 'table', id: 'd', title: 'Variables in the Equation', table: { matrix: [['x']] }, notes: ['分离现象'] },
  ])
  assert.deepEqual(items[0].roc, { by: 'y', variables: ['fpg'] })
  assert.deepEqual(items[1].pairwise, { group: 'g', variables: ['x'] })
  assert.equal(items[2].roc, undefined)
  assert.deepEqual(items[3].notes, ['分离现象'], 'caveats travel with the table')
  assert.deepEqual(items[0].rows, [['x']], 'the numbers still travel as rows')
})

check('a table too long for the agent is truncated, not dumped', () => {
  // A frequency table on a continuous variable runs to thousands of rows; the
  // model gets the head and a note, never the whole thing.
  const matrix = Array.from({ length: 300 }, (_, row) => [`v${row}`, String(row)])
  const [item] = itemsForAgent({}, [{ kind: 'table', id: 'big', title: 'score', table: { matrix } }])
  assert.equal(item.rows.length, 200, 'only the first 200 rows travel')
  assert.equal(item.truncated.rows, 300)
  assert.equal(item.truncated.shown, 200)
  assert.match(item.truncated.hint, /共 300 行/)
  const [small] = itemsForAgent({}, [{ kind: 'table', id: 's', title: 'x', table: { matrix: [['a'], ['b']] } }])
  assert.equal(small.truncated, undefined, 'a short table is not annotated')
})

check('autorecode and Jonckheere build the expected syntax', () => {
  assert.equal(buildTransform('autorecode', { variable: 'gender', target: 'g_num' }), 'AUTORECODE VARIABLES=gender /INTO g_num.\nEXECUTE.')
  assert.equal(
    buildAnalysis('npar_jonckheere', { variable: 'score', by: 'group', groupValues: [1, 2, 3] }),
    'NPAR TESTS /JONCKHEERE-TERPSTRA=score BY group(1 3).')
  assert.throws(() => buildAnalysis('npar_jonckheere', { variable: 'score', by: 'group' }), /group codes/)
})

check('McNemar, Cochran Q and Kendall W build the expected syntax', () => {
  assert.equal(
    buildAnalysis('npar_mcnemar', { var1: 'before', var2: 'after' }),
    'NPAR TESTS /MCNEMAR=before WITH after (PAIRED).')
  assert.throws(() => buildAnalysis('npar_mcnemar', { var1: 'a', var2: 'a' }), /two different variables/)
  assert.equal(
    buildAnalysis('npar_cochran', { variables: ['a', 'b', 'c'] }),
    'NPAR TESTS /COCHRAN=a b c.')
  assert.throws(() => buildAnalysis('npar_cochran', { variables: ['a', 'b'] }), /at least three/)
  assert.equal(
    buildAnalysis('npar_kendall', { variables: ['a', 'b', 'c', 'd'] }),
    'NPAR TESTS /KENDALL=a b c d.')
  assert.throws(() => buildAnalysis('npar_kendall', { variables: ['a'] }), /at least three/)
})

check('chart overrides change titles, colour and order without touching values', () => {
  const model = buildChartModel(dataset, 'bar', {
    variable: 'score',
    by: 'gender',
    title: '我自己写的标题',
    xLabel: '性别',
    yLabel: '平均得分',
    accent: '#b4453a',
    sortCategories: 'desc',
  })
  assert.equal(model.title, '我自己写的标题')
  assert.equal(model.xLabel, '性别')
  assert.equal(model.yLabel, '平均得分')
  assert.equal(model.accent, '#b4453a')
  const values = model.categories.map((entry) => entry.value)
  assert.deepEqual(values, [...values].sort((left, right) => right - left))
  const svg = renderSvg(model)
  assert.ok(svg.includes('#b4453a'), 'accent colour reaches the SVG')
  assert.ok(svg.includes('我自己写的标题'))
})

check('a bad accent colour is ignored instead of breaking the chart', () => {
  const model = buildChartModel(dataset, 'bar', { variable: 'score', by: 'gender', accent: 'red' })
  assert.equal(model.accent, undefined)
})

check('crosstabs passes the statistics the caller asked for', () => {
  assert.equal(
    buildAnalysis('crosstabs', { row: 'a', column: 'b', statistics: ['chisq', 'kappa'] }),
    'CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ KAPPA.')
  assert.equal(
    buildAnalysis('crosstabs', { row: 'a', column: 'b', statistics: ['CHISQ'], cells: ['count', 'row'] }),
    'CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ /CELLS=COUNT ROW.')
  assert.equal(buildAnalysis('crosstabs', { row: 'a', column: 'b', statistics: false }), 'CROSSTABS /TABLES=a BY b.')
  assert.equal(buildAnalysis('crosstabs', { row: 'a', column: 'b' }), 'CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ PHI.')
})

check('crosstabs passes the residual cell options through', () => {
  assert.equal(
    buildAnalysis('crosstabs', {
      row: 'a',
      column: 'b',
      statistics: ['CHISQ'],
      cells: ['count', 'expected', 'resid', 'sresid', 'asresid', 'total'],
    }),
    'CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ /CELLS=COUNT EXPECTED RESID SRESID ASRESID TOTAL.')
})

check('crosstabs takes a third variable as a layer', () => {
  assert.equal(
    buildAnalysis('crosstabs', { row: 'hosp', column: 'outcome', layer: 'sev', statistics: false, cells: ['count', 'row'] }),
    'CROSSTABS /TABLES=hosp BY outcome BY sev /CELLS=COUNT ROW.')
})

check('frequencies keeps the statistics list and the percentiles', () => {
  const plain = buildAnalysis('frequencies', { variables: ['tg'] })
  assert.equal(plain, 'FREQUENCIES /VARIABLES=tg.')
  const chosen = buildAnalysis('frequencies', {
    variables: ['tg'],
    statistics: ['mean', 'median', 'skewness'],
    percentiles: [25, 50, 75, 95],
  })
  assert.equal(
    chosen,
    'FREQUENCIES /VARIABLES=tg /STATISTICS=MEAN MEDIAN SKEWNESS /PERCENTILES=25 50 75 95 /FORMAT=NOTABLE.')
  // A bad statistic name must be reported, not silently dropped.
  assert.throws(
    () => buildAnalysis('frequencies', { variables: ['tg'], statistics: ['MEAN', 'NOPE'] }),
    /NOPE/)
})

check('examine asks for the descriptives table and the plots it can draw', () => {
  assert.equal(
    buildAnalysis('examine', { variables: ['tg'] }),
    'EXAMINE VARIABLES=tg /PLOT=BOXPLOT /STATISTICS=DESCRIPTIVES /NOTOTAL.')
  assert.equal(
    buildAnalysis('examine', { variables: ['v'], by: 'grp', normalPlot: true }),
    'EXAMINE VARIABLES=v BY grp /PLOT=BOXPLOT NPPLOT /STATISTICS=DESCRIPTIVES /NOTOTAL.')
  assert.equal(
    buildAnalysis('examine', { variables: ['v'], noPlot: true }),
    'EXAMINE VARIABLES=v /STATISTICS=DESCRIPTIVES /NOTOTAL.')
})

check('glm accepts a randomized block design with an explicit design list', () => {
  assert.equal(buildAnalysis('glm', { variables: ['drop'], by: 'trt' }), 'GLM drop BY trt /DESIGN=trt.')
  assert.equal(
    buildAnalysis('glm', { variables: ['drop'], factors: ['trt', 'block'] }),
    'GLM drop BY trt block /DESIGN=trt block.')
  assert.equal(
    buildAnalysis('glm', { variables: ['drop'], by: 'trt', design: 'trt block trt*block' }),
    'GLM drop BY trt /DESIGN=trt block trt*block.')
  // PSPP 2.1.3 rejects the WITH clause outright, so a covariate has to be a
  // refusal with an explanation instead of syntax the engine cannot run.
  assert.throws(
    () => buildAnalysis('glm', { variables: ['y'], factors: ['g'], covariates: ['x'] }),
    /不接受协变量/)
})

check('split accepts the break arguments the tool documents', () => {
  assert.equal(buildTransform('split', { break: ['grp'] }), 'SPLIT FILE BY grp.\nEXECUTE.')
  assert.equal(buildTransform('split', { variables: ['a', 'b'] }), 'SPLIT FILE BY a b.\nEXECUTE.')
  assert.equal(buildTransform('split', { off: true }), 'SPLIT FILE OFF.\nEXECUTE.')
})

// ---- delimited import ------------------------------------------------------
check('decodeText reads GBK exports', () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x31]) // 你好,1
  assert.equal(decodeText(gbk, 'gbk'), '你好,1')
  assert.equal(decodeText(Buffer.from('你好,1', 'utf8')), '你好,1')
  assert.throws(() => decodeText(gbk, 'not-a-charset'), /不认识的编码/)
})

check('guessDelimiter picks the field separator', () => {
  assert.equal(guessDelimiter('a;b;c\n1;2;3'), ';')
  assert.equal(guessDelimiter('a\tb\n1\t2'), '\t')
  assert.equal(guessDelimiter('a,b\n1,2'), ',')
  assert.equal(guessDelimiter('onlyonecolumn'), ',')
})

await check('filesystem errors are explained in words a user can act on', async () => {
  const make = (code, path) => Object.assign(new Error(`${code}: raw node text`), { code, path })
  assert.match(describeFsError(make('EACCES', '/ro/out.sav'), '/ro/out.sav'), /没有权限访问 \/ro\/out\.sav/)
  assert.match(describeFsError(make('ENOENT', '/x/y.csv'), '/x/y.csv'), /找不到这个路径：\/x\/y\.csv/)
  assert.match(describeFsError(make('ENOSPC', '/x')), /磁盘空间不足/)
  assert.match(describeFsError(make('EROFS', '/mnt/ro/f')), /只读文件系统/)
  assert.match(describeFsError(make('ENOTDIR', '/tmp/a.txt/out.sav'), '/tmp/a.txt/out.sav'), /的上一级不是目录/)
  assert.match(describeFsError(make('EEXIST', '/tmp/x'), '/tmp/x'), /已经存在/)
  // The raw Node message must not leak when we know nothing about the code.
  assert.equal(describeFsError(new Error('strange failure')), 'strange failure')
})

await check('a header-only file imports as zero cases', async () => {
  const imported = await importDelimited('a,b\n', {})
  assert.equal(imported.variables.length, 2)
  assert.equal(imported.rows.length, 0)
  // The staging CSV must be empty: a lone newline reads back as one blank
  // record and turns into a phantom case in the saved dataset.
  assert.equal(stringifyCsv([]), '')
  assert.equal(stringifyCsv([['a', 'b']]), 'a,b\n')
})

await check('imported headings that PSPP cannot use are renamed and reported', async () => {
  const imported = await importDelimited(`${'a'.repeat(70)},名称,名称\n1,2,3\n`, {})
  assert.deepEqual(imported.variables.map((variable) => variable.name), ['a'.repeat(64), 'V2', 'V3'])
  assert.equal(imported.variables[1].label, '名称')
  assert.equal(imported.notes.length, 3)
  assert.match(imported.notes[0], /超过 64 个字符/)
  assert.match(imported.notes[1], /没有可用的 ASCII 字符/)
  // ASCII duplicates that survive sanitising get a numeric suffix instead.
  const duplicated = await importDelimited('name,age,name\n甲,20,乙\n', {})
  assert.deepEqual(duplicated.variables.map((variable) => variable.name), ['name', 'age', 'name_2'])
  assert.match(duplicated.notes[0], /重名/)
})

await check('importDelimited honours encoding, delimiter and header', async () => {
  const text = '编号;得分\n1;90\n2;85'
  const imported = await importDelimited(text, { delimiter: ';' })
  assert.deepEqual(imported.variables.map((variable) => variable.name), ['V1', 'V2'])
  assert.deepEqual(imported.variables.map((variable) => variable.label), ['编号', '得分'])
  assert.deepEqual(imported.rows, [[1, 90], [2, 85]])
  const headerless = await importDelimited('1;2\n3;4', { delimiter: ';', hasHeader: false })
  assert.deepEqual(headerless.variables.map((variable) => variable.name), ['V1', 'V2'])
})

check('oneway carries the post-hoc methods PSPP implements and refuses the rest', () => {
  const plain = buildAnalysis('oneway', { variables: ['iod'], by: 'group' })
  assert.equal(plain, 'ONEWAY iod BY group /STATISTICS=DESCRIPTIVES HOMOGENEITY.')
  const chosen = buildAnalysis('oneway', { variables: ['iod'], by: 'group', postHoc: ['lsd', 'tukey'] })
  assert.equal(chosen, 'ONEWAY iod BY group /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=LSD TUKEY.')
  // Silently dropping a requested method meant the output looked complete
  // while the comparison the user asked for was never run.
  assert.throws(
    () => buildAnalysis('oneway', { variables: ['iod'], by: 'group', postHoc: ['lsd', 'Duncan'] }),
    /没有这些事后比较方法/)
  assert.equal(buildAnalysis('oneway', { variables: ['iod'], by: 'group', statistics: false }), 'ONEWAY iod by group.'.replace(' by', ' BY'))
})

check('correlation exposes the options PSPP accepts', () => {
  const plain = buildAnalysis('correlation', { variables: ['a', 'b'] })
  assert.equal(plain, 'CORRELATIONS /VARIABLES=a b /PRINT=TWOTAIL SIG /STATISTICS=DESCRIPTIVES /MISSING=LISTWISE.')
  const lean = buildAnalysis('correlation', { variables: ['a', 'b'], statistics: false, missing: 'pairwise', oneTailed: true })
  assert.equal(lean, 'CORRELATIONS /VARIABLES=a b /PRINT=ONETAIL SIG /MISSING=PAIRWISE.')
  assert.ok(!/MATRIX/.test(plain), 'PSPP has no /MATRIX=OUT')
})

check('descriptives uses the spellings PSPP accepts and switches to FREQUENCIES for median/mode/percentiles', () => {
  // PSPP rejects MEDIAN and wants SESKEWNESS/SEKURTOSIS/MINIMUM/MAXIMUM.
  assert.equal(
    buildAnalysis('descriptives', { variables: ['x'], statistics: ['mean', 'skewness', 'seskew', 'kurtosis', 'sekurt'] }),
    'DESCRIPTIVES /VARIABLES=x /STATISTICS=MEAN SKEWNESS SESKEWNESS KURTOSIS SEKURTOSIS.')
  assert.equal(
    buildAnalysis('descriptives', { variables: ['x'], statistics: ['mean', 'min', 'max', 'median'] }),
    'FREQUENCIES /VARIABLES=x /FORMAT=NOTABLE /STATISTICS=MEAN MINIMUM MAXIMUM MEDIAN.')
  assert.equal(
    buildAnalysis('descriptives', { variables: ['x', 'y'], statistics: ['mean', 'stddev'], percentiles: [25, 75] }),
    'FREQUENCIES /VARIABLES=x y /FORMAT=NOTABLE /STATISTICS=MEAN STDDEV MEDIAN /PERCENTILES=25 75.')
})

await check('the reported version comes from the manifest on disk, not a cached JSON module', async () => {
  const { pluginInfo } = await import('../lib/version.js')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pluginInfo().version, manifest.version)
  assert.equal(pluginInfo().name, manifest.name)
  // Two calls must agree: the mtime cache is not allowed to drift.
  assert.deepEqual(pluginInfo(), pluginInfo())
})

await check('apply() registers both route prefixes once webServer arrives', async () => {
  // Regression guard: 0.23.22 dropped the `pkg` binding but left one reference
  // inside the webServer callback, so tools still worked while every /analytics
  // route silently 404'd. Nothing else in the suite imports the host entry.
  const { apply } = await import('../index.js')
  const registered = []
  const ctx = {
    effect: (fn) => { fn() },
    tools: { register: () => () => {} },
    inject: (deps, cb) => cb({
      get: (name) => {
        if (name === 'webServer') {
          return { register: (route) => { registered.push(route.path); return () => {} } }
        }
        return null
      },
      effect: (fn) => { fn() },
    }),
  }
  apply(ctx, { dataDir: '/tmp/dsh-analytics-apply-test' })
  assert.deepEqual(registered.sort(), ['/analytics', '/analytics-pspp'])
})

// Quartiles use the (n-1)p interpolation, which is what PSPP's own
// PERCENTILES does: for 1..8 it prints 2.8 / 4.5 / 6.3, i.e. 2.75 / 4.5 / 6.25.
// A report claimed PSPP gives 3 / 5 / 6; the engine says otherwise, so this
// pins the behaviour we do share with it.
check('box quartiles use Tukey hinges, like SPSS and EXAMINE', () => {
  // FREQUENCIES /PERCENTILES on 1..8 prints 2.75 / 4.5 / 6.25 (verified against
  // the bundled engine), but a box plot in SPSS and EXAMINE's boxplot summary
  // use Tukey's hinges: 2.5 / 4.5 / 6.5. The box has to match the box.
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((value) => [value])
  const model = computeBox({ variables: [{ name: 'x', type: 'numeric', measure: 'scale' }], rows }, { variable: 'x' })
  const [group] = model.groups
  assert.equal(group.q1, 2.5)
  assert.equal(group.median, 4.5)
  assert.equal(group.q3, 6.5)
  // Odd counts: the median belongs to BOTH halves. Checked against the bundled
  // engine's EXAMINE /PLOT=BOXPLOT, which prints 2.00/3.00/4.00 for 1..5 and
  // 2.50/4.00/5.50 for 1..7.
  const box = (count) => computeBox({
    variables: [{ name: 'x', type: 'numeric', measure: 'scale' }],
    rows: Array.from({ length: count }, (_, index) => [index + 1]),
  }, { variable: 'x' }).groups[0]
  assert.deepEqual([box(5).q1, box(5).median, box(5).q3], [2, 3, 4])
  assert.deepEqual([box(7).q1, box(7).median, box(7).q3], [2.5, 4, 5.5])
  assert.deepEqual([box(9).q1, box(9).median, box(9).q3], [3, 5, 7])
})

check('the chart-side t test agrees with the table-side one', () => {
  // The relative zero-variance tolerance landed in lib/tables.js first and was
  // not carried over: the chart reported t=1.41/p=.29 for identical constants
  // and "no difference" for two different ones.
  assert.deepEqual(welchTest([0.1, 0.1, 0.1], [0.1, 0.1]), { t: 0, df: 3, p: 1 })
  assert.equal(welchTest([5, 5, 5], [9, 9, 9]), null)
  assert.equal(welchTest([1e6, 1e6, 1e6], [2e6, 2e6, 2e6]), null)
  const normal = welchTest([1, 2, 3, 4], [10, 11, 12, 13])
  assert.ok(normal.p < 0.001, `a real difference is still tested: p=${normal.p}`)
})

await Promise.all(pending)

check('a chart ignores the missing-value codes the table already drops', () => {
  const dataset = {
    variables: [{ name: 'x', type: 'numeric', measure: 'scale', missing: [999] }],
    rows: [[1], [2], [999], [3]],
  }
  const model = computeBar(dataset, { variable: 'x' })
  // 999 kept would have drawn a mean of 251; the table printed 2.
  assert.equal(model.categories[0].value, 2)
  assert.equal(model.categories[0].count, 3)
})

check('the table sanitiser decodes entities before looking at a scheme', () => {
  // A browser parses all four of these as javascript:; a raw-text check did not.
  for (const href of ['javascript&#58;alert(1)', 'javas&#99;ript:alert(1)', 'java&#9;script:alert(1)']) {
    const cleaned = sanitizeTableHtml(`<table><tr><td><a href="${href}">x</a></td></tr></table>`)
    assert.doesNotMatch(cleaned, /javascript|&#58|&#99/i, href)
    assert.doesNotMatch(cleaned, /href/i, href)
  }
  // HTML5 named entities, not just numeric ones: a browser decodes
  // `javascript&colon;` and `java&Tab;script:` into the same scheme.
  for (const href of ['javascript&colon;alert(1)', 'java&Tab;script:alert(1)', 'java&NewLine;script:alert(1)']) {
    assert.doesNotMatch(sanitizeTableHtml(`<table><tr><td><a href="${href}">x</a></td></tr></table>`), /href/i, href)
  }
  // The allow-list must not eat the links a table legitimately holds.
  for (const href of ['https://example.com/a', '/mnt/E/x.csv', '#top', './a.html', '../b', '?q=1', 'mailto:a@b.c']) {
    assert.match(sanitizeTableHtml(`<table><tr><td><a href="${href}">x</a></td></tr></table>`), /href/, href)
  }
  // An unquoted handler after a self-closing slash used to survive too.
  assert.doesNotMatch(sanitizeTableHtml('<table><tr><td><span/onclick=1>x</span></td></tr></table>'), /onclick/i)
})

check('raster draws an ellipse, not an empty canvas', () => {
  const { rgba, width, height } = rasterizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><ellipse cx="60" cy="40" rx="40" ry="20" fill="#93c47d"/></svg>',
    1,
  )
  const at = (x, y) => { const i = (y * width + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]].join(',') }
  assert.equal(at(60, 40), '147,196,125', 'the centre is filled')
  assert.equal(at(60, 25), '147,196,125', 'the vertical extent is filled')
  assert.equal(at(5, 5), '255,255,255', 'the corner stays background')
  assert.equal(at(10, 40), '255,255,255', 'outside the ellipse stays background')
})

await Promise.all(pending)

console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
