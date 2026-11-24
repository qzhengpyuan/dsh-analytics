// Chart models, the subtitle that goes under the title, and the grid that binds
// several charts into one picture. Pure: no engine, no browser.
import assert from 'node:assert/strict'

import { buildChartModel, composeChartGrid, renderSvg } from '../lib/charts.js'
import { rasterizeSvg, svgToPng } from '../lib/raster.js'
import { pngSize } from '../lib/office.js'

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

const dataset = (values) => ({
  variables: [
    { name: 'score', type: 'numeric', label: '', width: 12, decimals: 2, format: 'F12.2', measure: 'scale', role: 'input', missing: [], valueLabels: {} },
    { name: 'gender', type: 'string', label: '', width: 8, decimals: 0, format: 'A8', measure: 'nominal', role: 'input', missing: [], valueLabels: {} },
  ],
  rows: values.map((value, index) => [value, index % 2 === 0 ? '男' : '女']),
})

const bar = (extra = {}) => buildChartModel(dataset([3, 5, 8, 2, 6, 7, 4, 9]), 'bar', { variable: 'score', ...extra })

check('a subtitle rides under the title, and an empty one removes it', () => {
  const withSub = buildChartModel(dataset([1, 2, 3, 4]), 'bar', { variable: 'score', subtitle: 'N = 4，M = 2.50' })
  assert.equal(withSub.subtitle, 'N = 4，M = 2.50')
  const svg = renderSvg(withSub)
  assert.match(svg, /N = 4，M = 2\.50/, 'the subtitle is drawn')
  // Above the plot area, below the title: y=22 is the title, y=36 the subtitle.
  assert.ok(svg.indexOf('y="36"') > svg.indexOf('y="22"'), 'and it sits under the title')
  const cleared = buildChartModel(dataset([1, 2, 3]), 'bar', { variable: 'score', subtitle: '' })
  assert.equal(cleared.subtitle, undefined, 'an empty subtitle is a request to remove one')
  assert.doesNotMatch(renderSvg(cleared), /y="36" text-anchor="middle" font-size="10"/, 'and nothing is drawn for it')
})

check('the grid is one document with a cell per chart, in the order given', () => {
  const first = renderSvg(bar({ title: '第一张' }))
  const second = renderSvg(bar({ title: '第二张' }))
  const third = renderSvg(bar({ title: '第三张' }))
  const grid = composeChartGrid([first, second, third], '2x2')
  assert.equal((grid.match(/<svg /g) ?? []).length, 1, 'nested viewports are not used — the rasteriser cannot read them')
  assert.equal((grid.match(/<g transform="translate\(/g) ?? []).length, 3, 'each chart is one group')
  const order = ['第一张', '第二张', '第三张'].map((title) => grid.indexOf(title))
  assert.ok(order[0] < order[1] && order[1] < order[2], 'the order is the one the caller gave')
  // Two columns: the third chart starts a new row.
  const translates = [...grid.matchAll(/<g transform="translate\((\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\)"/g)].map((match) => [Number(match[1]), Number(match[2])])
  assert.equal(translates[2][1], translates[0][1] + 360 + 12, 'the second row starts below the first cell')
  assert.equal(translates[1][0], translates[0][0] + 560 + 12, 'the second column starts beside the first')
})

check('a layout that cannot hold the charts says so instead of dropping one', () => {
  const svg = renderSvg(bar())
  assert.throws(() => composeChartGrid([svg, svg, svg], '1x2'), /只有 2 格/)
  assert.throws(() => composeChartGrid([], '2x2'), /至少要有一张图/)
})

check('the grid rasterises to a picture whose every cell has ink', () => {
  const one = renderSvg(bar({ title: 'A' }))
  const two = renderSvg(bar({ title: 'B' }))
  const grid = composeChartGrid([one, two], '1x2')
  const { width, height, rgba } = rasterizeSvg(grid, 1)
  // 8 + 560 + 12 + 560 + 8 = 1148 wide, 8 + 360 + 8 = 376 tall.
  assert.equal(width, 1148)
  assert.equal(height, 376)
  const inkIn = (x0, y0, x1, y1) => {
    let ink = 0
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * width + x) * 4
        if (rgba[offset] < 200 || rgba[offset + 1] < 200 || rgba[offset + 2] < 200) ink += 1
      }
    }
    return ink
  }
  assert.ok(inkIn(0, 0, 570, 376) > 500, 'the left cell is drawn')
  assert.ok(inkIn(578, 0, 1148, 376) > 500, 'the right cell is drawn')
  assert.equal(inkIn(560, 0, 576, 376), 0, 'the gap between cells stays empty')
})


check('a PNG exported at 3x has three times the pixels', () => {
  const svg = renderSvg(bar())
  const one = pngSize(svgToPng(svg, 1))
  const three = pngSize(svgToPng(svg, 3))
  assert.deepEqual([one.width * 3, one.height * 3], [three.width, three.height], 'scale is exact, not rounded')
})

// 散点图按类别着色：每类一个系列、颜色不同、图例在图上。
check('a grouped scatter draws one colour per category and a legend', () => {
  const grouped = {
    variables: [
      { name: 'x', type: 'numeric', label: '', width: 8, decimals: 1, format: 'F8.1', measure: 'scale', role: 'input', missing: [], valueLabels: {} },
      { name: 'y', type: 'numeric', label: '', width: 8, decimals: 1, format: 'F8.1', measure: 'scale', role: 'input', missing: [], valueLabels: {} },
      { name: 'g', type: 'string', label: '组', width: 8, decimals: 0, format: 'A8', measure: 'nominal', role: 'input', missing: [], valueLabels: {} },
    ],
    rows: [[1, 3, 'A'], [2, 5, 'A'], [4, 7, 'B'], [6, 9, 'B'], [3, 4, '']],
  }
  const model = buildChartModel(grouped, 'scatterplot', { x: 'x', y: 'y', group: 'g' })
  assert.deepEqual([...model.series.map((entry) => entry.label)].sort(), ['A', 'B', '（缺失）'].sort(), 'one series per label, empty bucket included')
  assert.equal(model.points.length, 5, 'the axis still covers every case')
  const svg = renderSvg(model)
  assert.match(svg, /#2f6fbb/, 'the first colour is used')
  assert.match(svg, /#d98f3a/, 'and the second')
  assert.match(svg, /fill-opacity="0\.88"/, 'the legend has a plate so it stays readable')
  const single = renderSvg(buildChartModel(grouped, 'scatterplot', { x: 'x', y: 'y' }))
  assert.doesNotMatch(single, /fill-opacity="0\.88"/, 'without a group there is no legend')
  assert.throws(() => buildChartModel(grouped, 'scatterplot', { x: 'x', y: 'y', group: 'nope' }), /unknown variable/, 'an unknown group variable is refused')
})

// 分类变量的条形图：柱高是计次，勾百分比就换成占比（SPSS 的「条形图：分类变量」）。
check('a text variable is counted, and percent turns the counts into shares', () => {
  const text = {
    variables: [
      { name: 'g', type: 'string', label: '组别', width: 8, decimals: 0, format: 'A8', measure: 'nominal', role: 'input', missing: [], valueLabels: {} },
    ],
    rows: [['甲'], ['甲'], ['乙'], ['丙'], ['丙'], [''], ['丙']],
  }
  const counted = buildChartModel(text, 'bar', { variable: 'g', statistic: 'COUNT' })
  assert.equal(counted.yLabel, '个案数', 'the axis says cases')
  assert.deepEqual(counted.categories.map((entry) => [entry.label, entry.value]), [['丙', 3], ['甲', 2], ['乙', 1]], 'counted per category, empty cells left out')
  assert.match(counted.title, /个案数/, 'the title says what is counted')
  const percent = buildChartModel(text, 'bar', { variable: 'g', statistic: 'COUNT', percent: true })
  assert.equal(percent.yLabel, '百分比（%）', 'the axis switches to percent')
  const shares = percent.categories.reduce((sum, entry) => sum + entry.value, 0)
  assert.ok(Math.abs(shares - 100) < 0.2, 'the shares add up to 100')
  assert.equal(percent.categories.find((entry) => entry.label === '丙').value, 50, 'three of six valid cases is half')
  assert.throws(() => buildChartModel(text, 'bar', { variable: 'g' }), /文本变量/, 'a text variable cannot be averaged')
})

// P-P / Q-Q：PSPP 的 NPPLOT 只出检验表，图由插件按同一批个案算。
check('the probability plots stick to the diagonal and stay inside 0..1', () => {
  const ds = {
    variables: [{ name: 'x', label: '得分', type: 'numeric', width: 8, decimals: 1 }],
    rows: Array.from({ length: 12 }, (_, index) => [index * 2 + (index % 4 === 0 ? 1 : 0)]),
  }
  const pp = buildChartModel(ds, 'ppplot', { variable: 'x' })
  assert.equal(pp.kind, 'scatter', 'it reuses the scatter renderer')
  assert.equal(pp.diagonal, true, 'and asks for the reference line')
  assert.equal(pp.points.length, 12, 'one point per case')
  for (const [observed, expected] of pp.points) {
    assert.ok(observed > 0 && observed < 1, `observed cumulative probability stays inside (0,1): ${observed}`)
    assert.ok(expected >= 0 && expected <= 1, `expected cumulative probability is a probability: ${expected}`)
  }
  assert.match(pp.title, /P-P/, 'the title names the plot')
  const qq = buildChartModel(ds, 'ppplot', { variable: 'x', plot: 'qq' })
  assert.match(qq.title, /Q-Q/)
  assert.deepEqual(qq.points.map((point) => point[0]).sort((a, b) => a - b), [1, 2, 4, 6, 9, 10, 12, 14, 17, 18, 20, 22], 'the x axis is the observed value itself')
  // 中位秩对称：第一点与最后一点的期望分位数关于均值对称。
  const first = qq.points[0][1]
  const last = qq.points.at(-1)[1]
  const mean = ds.rows.reduce((sum, row) => sum + row[0], 0) / ds.rows.length
  assert.ok(Math.abs((first + last) / 2 - mean) < 0.01, `the expected quantiles are symmetric: ${first} ${last} ${mean}`)
  const svg = renderSvg(pp)
  assert.match(svg, /stroke-dasharray="4 3"/, 'the diagonal is drawn dashed')
})

check('the probability plots refuse what they cannot draw', () => {
  const ds = {
    variables: [
      { name: 'x', type: 'numeric', width: 8, decimals: 1 },
      { name: 'g', type: 'string', width: 8, format: 'A8' },
    ],
    rows: [[1, 'a'], [2, 'a'], [3, 'b']],
  }
  assert.throws(() => buildChartModel(ds, 'ppplot', { variable: 'nope' }), /unknown variable/)
  assert.throws(() => buildChartModel(ds, 'ppplot', { variable: 'g' }), /不是数值变量/)
  assert.throws(() => buildChartModel({ variables: ds.variables, rows: [[1, 'a'], [2, 'a']] }, 'ppplot', { variable: 'x' }), /不足 3 个/)
  assert.throws(
    () => buildChartModel({ variables: ds.variables, rows: [[5, 'a'], [5, 'a'], [5, 'a']] }, 'ppplot', { variable: 'x' }),
    /全都一样/,
  )
})

// 拟合线：SPSS 的图表编辑器能加，PSPP 不画，所以插件自己最小二乘。
check('the scatter fit line is the least-squares line, with R²', () => {
  const ds = {
    variables: [
      { name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }, { name: 'g', type: 'numeric' },
    ],
    rows: [[1, 3, 1], [2, 5, 1], [3, 7, 1], [1, 2.9, 2], [2, 5.1, 2], [3, 7.05, 2]],
  }
  // 完美直线只取第一组：两组拼起来是「两条平行线 + 截距差」，不是一条直线。
  const exact = { variables: ds.variables, rows: ds.rows.filter((row) => row[2] === 1) }
  const plain = buildChartModel(exact, 'scatterplot', { x: 'x', y: 'y', fit: 'linear' })
  assert.equal(plain.fits.length, 1, 'one line for the whole cloud')
  assert.equal(plain.fits[0].slope, 2, 'the slope is exact on a perfect line')
  assert.equal(plain.fits[0].intercept, 1, 'and so is the intercept')
  assert.equal(plain.fits[0].r2, 1, 'R² is 1 when every point sits on the line')
  assert.match(renderSvg(plain), /R² = 1/, 'the R² is written on the chart')
  const grouped = buildChartModel(ds, 'scatterplot', { x: 'x', y: 'y', group: 'g', fit: true })
  assert.equal(grouped.fits.length, 2, 'one line per series when the points are coloured by a variable')
  assert.deepEqual(grouped.fits.map((fit) => fit.label), ['1', '2'], 'each line is labelled with its category')
  assert.ok(grouped.fits.every((fit) => fit.r2 > 0.98), `each series is very nearly a line: ${JSON.stringify(grouped.fits)}`)
  const none = buildChartModel(ds, 'scatterplot', { x: 'x', y: 'y' })
  assert.equal(none.fits, undefined, 'no line unless it is asked for')
})

check('a fit line that cannot be drawn is dropped, not faked', () => {
  const flat = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
    rows: [[5, 1], [5, 2], [5, 3]],
  }
  assert.equal(buildChartModel(flat, 'scatterplot', { x: 'x', y: 'y', fit: 'linear' }).fits, undefined, 'x never changes, so there is no slope')
  // 斜率很陡时线会被裁到绘图区里（直接连两端点会画到框外）。
  const steep = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
    rows: [[0, 0], [1, 1000], [2, 2000]],
  }
  const svg = renderSvg(buildChartModel(steep, 'scatterplot', { x: 'x', y: 'y', fit: 'linear' }))
  const line = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#b4453a" stroke-width="1.6"\/>/.exec(svg)
  assert.ok(line, 'the steep line is drawn')
  assert.ok(Number(line[2]) >= 0 && Number(line[2]) <= 360, `the start stays inside the viewport: ${line[2]}`)
  assert.ok(Number(line[4]) >= 0 && Number(line[4]) <= 360, `and so does the end: ${line[4]}`)
})

check('a pareto chart sorts the bars and accumulates the share', () => {
  const dataset = {
    variables: [{ name: 'defect', type: 'string' }],
    rows: [['A'], ['A'], ['A'], ['B'], ['B'], ['C'], ['C'], ['D']],
  }
  const model = buildChartModel(dataset, 'pareto', { variable: 'defect' })
  assert.equal(model.kind, 'pareto')
  assert.deepEqual(model.bars.map((bar) => bar.label), ['A', 'B', 'C', 'D'], 'most frequent first, ties by code')
  assert.deepEqual(model.bars.map((bar) => bar.count), [3, 2, 2, 1])
  assert.deepEqual(model.bars.map((bar) => bar.cumulative), [37.5, 62.5, 87.5, 100], 'the last point is always 100%')
  assert.equal(model.reference, 80, 'the default reference line sits at 80%')
  assert.equal(model.total, 8)
  const svg = renderSvg(model)
  assert.match(svg, /参考线 80%/, 'the reference line is labelled')
  assert.match(svg, /87\.5/, 'the cumulative points are drawn')
})

check('a pareto chart can fold the tail, and refuses a bad reference', () => {
  const dataset = {
    variables: [{ name: 'defect', type: 'string' }],
    rows: [['A'], ['A'], ['A'], ['B'], ['B'], ['C'], ['C'], ['D']],
  }
  const folded = buildChartModel(dataset, 'pareto', { variable: 'defect', maxCategories: 2, reference: 70 })
  assert.deepEqual(folded.bars.map((bar) => bar.label), ['A', 'B', '其他'], 'the tail becomes one bar')
  assert.equal(folded.bars[2].count, 3)
  assert.equal(folded.bars[2].folded, 2, 'and it remembers how many categories it swallowed')
  assert.equal(folded.bars[2].cumulative, 100, 'the folded bar closes the curve')
  assert.throws(() => buildChartModel(dataset, 'pareto', { variable: 'defect', reference: 100 }), /参考线/, 'a reference of 100% is refused')
  assert.throws(() => buildChartModel(dataset, 'pareto', { variable: 'nope' }), /unknown variable/, 'an unknown variable is named')
})

check('a pareto chart ignores missing values instead of counting them', () => {
  const dataset = {
    variables: [{ name: 'defect', type: 'string' }],
    rows: [['A'], [null], ['B'], [null], ['A']],
  }
  const model = buildChartModel(dataset, 'pareto', { variable: 'defect' })
  assert.equal(model.total, 3, 'blanks are not a category')
  assert.deepEqual(model.bars.map((bar) => bar.label), ['A', 'B'])
})

check('an X̄–R chart uses the average range for both sets of limits', () => {
  const rows = []
  // Two tidy subgroups: means 12 and 22, both with a range of 4.
  for (const value of [10, 11, 12, 13, 14]) rows.push([1, value])
  for (const value of [20, 21, 22, 23, 24]) rows.push([2, value])
  const dataset = {
    variables: [{ name: 'g', type: 'numeric' }, { name: 'w', type: 'numeric' }],
    rows,
  }
  const model = buildChartModel(dataset, 'control', { variable: 'w', subgroup: 'g' })
  assert.equal(model.size, 5, 'the subgroup size comes from the data')
  assert.deepEqual(model.points.map((point) => point.mean), [12, 22])
  assert.deepEqual(model.points.map((point) => point.range), [4, 4])
  // A2 = 0.577 for n = 5: 17 ± 0.577 × 4 = 19.308 / 14.692.
  assert.equal(model.meanChart.cl, 17)
  assert.equal(model.meanChart.ucl, 19.31)
  assert.equal(model.meanChart.lcl, 14.69)
  // D4 = 2.114, D3 = 0 for n = 5.
  assert.equal(model.rangeChart.cl, 4)
  assert.equal(model.rangeChart.ucl, 8.46)
  assert.equal(model.rangeChart.lcl, 0)
  assert.deepEqual(model.violations.mean, [0, 1], 'the first mean is below LCL and the second above UCL')
  assert.deepEqual(model.violations.range, [], 'both ranges sit inside the limits')
  const svg = renderSvg(model)
  assert.match(svg, /height="480"/, 'the two panels need a taller canvas')
  assert.match(svg, /UCL 19\.31/, 'the limits are printed next to their lines')
  assert.match(svg, /LCL/, 'and the lower one too')
})

check('an X̄–R chart refuses what it cannot compute', () => {
  const dataset = {
    variables: [{ name: 'w', type: 'numeric' }, { name: 't', type: 'string' }],
    rows: [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e'], [6, 'f']],
  }
  assert.throws(() => buildChartModel(dataset, 'control', { variable: 't' }), /数值变量/, 'a text variable is named')
  assert.throws(() => buildChartModel(dataset, 'control', { variable: 'w', size: 11 }), /2 到 10/, 'the constant table stops at ten')
  // Six cases with size 4 leaves one full subgroup plus a dropped tail, and one
  // subgroup cannot carry a range chart.
  assert.throws(() => buildChartModel(dataset, 'control', { variable: 'w', size: 4 }), /至少要两个子组/, 'a single subgroup is not a chart')
})

check('an X̄–R chart splits the cases in order when no subgroup variable is given', () => {
  const rows = []
  for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99]) rows.push([value])
  const dataset = { variables: [{ name: 'w', type: 'numeric' }], rows }
  const model = buildChartModel(dataset, 'control', { variable: 'w', size: 5 })
  assert.equal(model.points.length, 2, 'the trailing 99 is dropped rather than making a one-case subgroup')
  assert.deepEqual(model.points.map((point) => point.mean), [3, 8])
  assert.deepEqual(model.points.map((point) => point.range), [4, 4])
})

console.log(`${checks} checks passed`)
