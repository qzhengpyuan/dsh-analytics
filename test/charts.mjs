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

console.log(`${checks} checks passed`)
