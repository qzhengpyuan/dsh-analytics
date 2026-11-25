// 「能画不能改」的守护：每个分析画出来的图型都必须能重绘，而且重绘回来的还是
// 同一个模型（换图型的自由留给条形图那一类）。0.90–0.99 陆续加了双标图、类别点
// 图、时间序列拟合图、累积发生率，白名单没跟上，点「重绘」只换来「目标类型不认识」。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveEngine } from '../lib/engine.js'
import { Workspace } from '../lib/workspace.js'

let checks = 0
const failures = []
const check = async (name, body) => {
  try {
    await body()
    checks += 1
    console.log(`ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'ap-redraw-'))
// 图的几何不需要引擎，但新建数据集会落一份 work.sav，所以还是给真引擎。
const engine = resolveEngine()
const workspace = new Workspace({ id: 'redraw', engine, root, config: { timeoutMs: 60000 } })
await workspace.init()
await workspace.createDataset({
  variables: [
    { name: 't', type: 'numeric' },
    { name: 's', type: 'numeric' },
    { name: 'g', type: 'string', measure: 'nominal' },
  ],
})
for (let index = 0; index < 24; index += 1) {
  workspace.appendCase({
    t: 1 + (index % 8),
    s: index % 5 === 0 ? 0 : (index % 2 === 0 ? 1 : 2),
    g: index < 12 ? 'A' : 'B',
  })
}

// 记下请求名：模型种类（chart.kind）与请求名不一定同（散点图两者都是 scatter，
// P-P 图模型也是 scatter），重绘要按请求名走。
const add = async (kind, options) => {
  const drawn = await workspace.addChart(kind, options)
  return { ...drawn, requested: kind }
}

await check('every plugin-drawn chart kind can be redrawn as itself', async () => {
  const drawn = []
  drawn.push(await add('bar', { variable: 't' }))
  drawn.push(await add('histogram', { variable: 't' }))
  drawn.push(await add('boxplot', { variable: 't', by: 'g' }))
  drawn.push(await add('line', { variable: 't' }))
  drawn.push(await add('pie', { variable: 'g' }))
  drawn.push(await add('area', { variable: 't' }))
  drawn.push(await add('scatterplot', { x: 't', y: 's' }))
  drawn.push(await add('ppplot', { variable: 't', plot: 'qq' }))
  drawn.push(await add('pareto', { variable: 'g' }))
  drawn.push(await add('control', { variable: 't', size: 4 }))
  drawn.push(await add('timeseries', { variable: 't', method: 'ma', span: 3 }))
  drawn.push(await add('biplot', {
    rows: [{ label: 'A', x: -0.4, y: 0.2 }, { label: 'B', x: 0.5, y: -0.1 }],
    columns: [{ label: 'c1', x: 0.6, y: 0.3 }],
    rowName: 'g',
    columnName: 's',
  }))
  drawn.push(await add('category', {
    points: [{ label: 'A', x: -0.3, y: 0.1, group: 'g' }, { label: 'B', x: 0.2, y: -0.2, group: 'g' }],
    groups: ['g'],
  }))
  drawn.push(await add('cif', {
    time: 't',
    event: 's',
    maxTime: 8,
    groups: [
      { label: '1（状态码 1）', n: 24, events: 0.4, curve: [{ time: 1, survival: 0.2 }, { time: 3, survival: 0.35 }], censoredTicks: [], median: null },
    ],
  }))
  for (const entry of drawn) {
    // 每一种都要能按原类型重绘：白名单漏一种，这里就红一种。请求名用的是面板
    // 传的那一个（散点图的模型种类叫 scatter，请求名是 scatterplot）。
    const again = await workspace.redrawChart(entry.runId, entry.requested)
    assert.equal(again.chart.kind, entry.chart.kind, `redrawing ${entry.chart.kind} keeps the kind`)
    assert.ok(again.svgPath, `${entry.chart.kind} produced an svg`)
    // 重绘出来的图与原来的模型同形：同样的点数、同样的坐标。
    if (entry.chart.kind === 'biplot') assert.equal(again.chart.rows.length, 2, 'row points survive')
    if (entry.chart.kind === 'category') assert.equal(again.chart.points.length, 2, 'category points survive')
    if (entry.chart.kind === 'cif') {
      assert.equal(again.chart.showMedian, false, 'the CIF stays a CIF, not a survival curve')
      assert.equal(again.chart.groups.length, 1)
      assert.equal(again.chart.groups[0].curve.length, 2)
    }
    if (entry.chart.kind === 'km') assert.equal(again.chart.showMedian, false)
  }
})

await check('a redrawn chart records where it came from and keeps its options', async () => {
  const made = await workspace.addChart('ppplot', { variable: 't', plot: 'qq' })
  const again = await workspace.redrawChart(made.runId, 'ppplot')
  assert.equal(again.redrawnFrom, made.runId, 'the source run is recorded')
  assert.equal(again.item.chartSpec.plot, 'qq', 'P-P/Q-Q is not silently reset')
  assert.equal(again.item.chartSpec.time ?? null, null, 'no invented fields')
  const cif = await workspace.addChart('cif', {
    time: 't', event: 's', maxTime: 8,
    groups: [{ label: '1', n: 24, events: 0.4, curve: [{ time: 1, survival: 0.2 }], censoredTicks: [], median: null }],
  })
  const cifAgain = await workspace.redrawChart(cif.runId, 'cif')
  assert.equal(cifAgain.item.chartSpec.time, 't', 'the variables a CIF needs are recorded')
  assert.equal(cifAgain.item.chartSpec.event, 's')
  const stored = JSON.parse(readFileSync(join(workspace.runDir(cifAgain.runId), 'chart.json'), 'utf8'))
  assert.equal(stored.kind, 'cif', 'chart.json says which kind this file is')
  assert.equal(stored.options.time, 't')
})

await check('geometry-bound charts refuse to turn into another kind', async () => {
  const biplot = await workspace.addChart('biplot', {
    rows: [{ label: 'A', x: 0, y: 0 }], columns: [], rowName: 'g',
  })
  // 双标图的坐标不来自「变量」：换成别的类型只会画出一张空图，所以拒绝并说清
  // 该回哪里重画。
  await assert.rejects(() => workspace.redrawChart(biplot.runId, 'bar'), /坐标存在它自己的记录里/)
  await assert.rejects(() => workspace.redrawChart(biplot.runId, 'cif'), /坐标存在它自己的记录里/)
  const category = await workspace.addChart('category', { points: [{ label: 'A', x: 0, y: 0 }], groups: ['g'] })
  await assert.rejects(() => workspace.redrawChart(category.runId, 'scatterplot'), /坐标存在它自己的记录里/)
  const cif = await workspace.addChart('cif', {
    time: 't', event: 's', maxTime: 1,
    groups: [{ label: '1', n: 2, events: 0.5, curve: [{ time: 1, survival: 0.5 }], censoredTicks: [], median: null }],
  })
  await assert.rejects(() => workspace.redrawChart(cif.runId, 'km'), /坐标存在它自己的记录里/)
})

await check('a grid still refuses to be redrawn, and an unknown kind is named', async () => {
  const first = await workspace.addChart('bar', { variable: 't' })
  const grid = await workspace.addChartGrid([first.item.id], '1x2')
  await assert.rejects(() => workspace.redrawChart(grid.runId, 'bar'), /拼版不能重绘/)
  await assert.rejects(() => workspace.redrawChart(first.runId, 'nonsense'), /不认识/)
  await assert.rejects(() => workspace.redrawChart(9999, 'bar'), /没有图表可以重绘/)
})

process.stdout.write(`\n${checks} checks in test/redraw.mjs\n`)
if (failures.length) {
  process.stdout.write(`${failures.length} failures above\n`)
  process.exitCode = 1
}
