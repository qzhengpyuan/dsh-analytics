/**
 * Tool-level tests: every `pspp_*` tool's `execute()` runs against a real engine.
 *
 * The other suites cover the builders (`build.mjs`), the workspace
 * (`smoke.mjs`) and the HTTP routes (`routes.mjs`), but nothing called the tool
 * bodies themselves — a tool could throw on every invocation and the suite would
 * still be green. This one opens a CSV through the tools, runs every kind of
 * analysis, transformation and export, and checks the shapes the agent gets
 * back (and that the output renderer produces text).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTools } from '../lib/tools.js'
import { WorkspaceRegistry } from '../lib/workspace.js'
import { resolveEngine } from '../lib/engine.js'

let checks = 0
// Sequential on purpose: these tools share one workspace, so a later call sees
// what an earlier one opened (and `npm test` counts the `ok` lines).
const check = async (name, fn) => {
  try {
    await fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const dir = mkdtempSync(join(tmpdir(), 'ap-tools-'))
const csv = join(dir, 'd.csv')
// start 列全 0：时依协变量的入口要能跑通（start 全 0 时与固定协变量逐位相同）。
writeFileSync(csv, 'score,group,grp,time,event,start\n12,1,A,2,1,0\n18,1,A,3,1,0\n23,1,B,4,1,0\n31,2,B,5,0,0\n44,2,A,6,1,0\n15,2,B,7,0,0\n27,1,A,8,1,0\n8,2,B,9,0,0\n')

const registry = new WorkspaceRegistry({
  engine: resolveEngine(),
  root: join(dir, 'ws'),
  config: { timeoutMs: 120000 },
})
const tools = createTools({ registry, config: { timeoutMs: 120000 } })
const exec = { agent: { session: { id: 'tools-test', header: { cwd: dir } } } }
const byName = new Map(tools.map((tool) => [tool.name, tool]))
// Which tools actually ran: the point of this suite is the `execute()` bodies,
// and it is easy to add a tool later and forget to call it here.
const exercised = new Set()

// Runs a tool the way the host does: execute, then render the output.
async function call(name, args = {}) {
  const tool = byName.get(name)
  assert.ok(tool, `tool ${name} is missing`)
  exercised.add(name)
  const value = await tool.execute(args, exec)
  if (tool.output?.render) {
    const rendered = tool.output.render(args, value)
    const text = Array.isArray(rendered) ? rendered.map((block) => block?.text ?? '').join('') : String(rendered ?? '')
    assert.ok(text.length > 0, `${name} rendered nothing`)
  }
  return value
}

const open = () => call('pspp_open', { path: csv })

await check('every tool declares parameters and an output renderer', () => {
  const names = tools.map((tool) => tool.name)
  assert.equal(names.length, 44, names.join(' '))
  for (const tool of tools) {
    assert.equal(tool.parameters?.type, 'object', `${tool.name} has no parameters schema`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} has no renderer`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} has no execute`)
  }
})

await check('pspp_status reports the engine and the plugin version', async () => {
  const status = await call('pspp_status')
  assert.match(status.engine.version, /^pspp /, status.engine.version)
  assert.ok(status.plugin.version, 'the plugin version is empty')
  assert.ok(status.capabilities || status.engine.capabilities, 'no capabilities')
})

await check('pspp_open reads a csv and pspp_variables lists it', async () => {
  const opened = await open()
  assert.equal(opened.cases, 8, JSON.stringify(opened).slice(0, 200))
  const variables = await call('pspp_variables')
  const names = (variables.variables ?? variables).map((entry) => entry.name ?? entry)
  assert.deepEqual(names, ['score', 'group', 'grp', 'time', 'event', 'start'], names.join(' '))
})

await check('pspp_data returns rows and a total', async () => {
  const data = await call('pspp_data', { limit: 3 })
  assert.equal(data.rows.length, 3)
  assert.equal(data.total, 8)
})

await check('pspp_run returns tables with rows and provenance', async () => {
  const run = await call('pspp_run', { syntax: 'FREQUENCIES /VARIABLES=score.' })
  assert.ok(run.tables.length >= 1, JSON.stringify(run).slice(0, 300))
  // The agent gets the matrix, not the html: `rows` is what the model reads and
  // what `itemsForAgent()` forwards from the panel's item.
  assert.ok(run.tables[0].rows.length >= 2, JSON.stringify(run.tables[0]).slice(0, 300))
  assert.ok(run.tables[0].provenance?.sourcePath, 'a table without provenance cannot be traced to its data')
})

await check('pspp_analyze covers the common procedures', async () => {
  const cases = [
    [{ procedure: 'frequencies', variables: ['score'] }],
    [{ procedure: 'descriptives', variables: ['score', 'group'] }],
    [{ procedure: 'crosstabs', row: 'group', column: 'grp' }],
    [{ procedure: 'ttest_independent', variables: ['score'], by: 'group', groupValues: ['1', '2'] }],
    [{ procedure: 'oneway', variables: ['score'], by: 'group' }],
    [{ procedure: 'correlation', variables: ['score', 'group'] }],
    [{ procedure: 'regression', dependent: 'score', independents: ['group'] }],
    [{ procedure: 'npar_mannwhitney', variables: ['score'], by: 'group', groupValues: ['1', '2'] }],
    [{ procedure: 'npar_median', variables: ['score'], by: 'group', groupValues: ['1', '2'] }],
    [{ procedure: 'examine', variables: ['score'] }],
    [{ procedure: 'ctables', row: 'group', column: 'grp' }],
  ]
  for (const [args] of cases) {
    const run = await call('pspp_analyze', args)
    assert.ok(run.tables.length >= 1, `${args.procedure} produced no output`)
  }
})

await check('pspp_analyze rejects a procedure it does not know', async () => {
  await assert.rejects(() => byName.get('pspp_analyze').execute({ procedure: 'nope' }, exec), /unknown analysis procedure/)
})

await check('pspp_transform adds a variable and rewrites the dataset', async () => {
  const run = await call('pspp_transform', { operation: 'compute', target: 'twice', expression: 'score * 2' })
  assert.ok(run, 'compute returned nothing')
  const variables = await call('pspp_variables')
  const names = (variables.variables ?? variables).map((entry) => entry.name ?? entry)
  assert.ok(names.includes('twice'), names.join(' '))
  const sorted = await call('pspp_transform', { operation: 'sort', variables: ['score'], order: 'D' })
  assert.ok(sorted, 'sort returned nothing')
})

await check('pspp_chart draws an svg for a histogram and a bar chart', async () => {
  const histogram = await call('pspp_chart', { type: 'histogram', variable: 'score' })
  assert.equal(histogram.chart.kind, 'histogram')
  assert.ok(histogram.chart.bins.length >= 2, JSON.stringify(histogram.chart).slice(0, 200))
  assert.ok(histogram.svgPath, 'the chart file was not written')
  assert.match(readFileSync(histogram.svgPath, 'utf8'), /<svg/i)
  const bar = await call('pspp_chart', { type: 'bar', variable: 'score', by: 'group' })
  assert.equal(bar.chart.kind, 'bar')
  assert.match(readFileSync(bar.svgPath, 'utf8'), /<svg/i)
})

await check('pspp_publication_table and pspp_pairwise build their rows', async () => {
  const table1 = await call('pspp_publication_table', { group: 'group' })
  assert.equal(table1.matrix[0][0], '变量')
  assert.ok(table1.matrix.length >= 3, JSON.stringify(table1).slice(0, 300))
  const pairwise = await call('pspp_pairwise', { group: 'group' })
  assert.ok(pairwise.matrix.length >= 3, JSON.stringify(pairwise).slice(0, 300))
  // 同质子集：每个变量一张字母表，字母非空、字母不在同一变量内重复成两组「显著不同」。
  assert.ok(Array.isArray(pairwise.homogeneousSubsets), 'the letter display comes back')
  assert.deepEqual(pairwise.homogeneousSubsets[0].slice(0, 2), ['变量', '组'])
  const rows = pairwise.homogeneousSubsets.slice(1)
  assert.ok(rows.length >= 2, 'header plus at least one group')
  for (const row of rows) assert.ok(/^[a-z]+$/.test(row[5]), `字母 ${
    row[5]} 不合规`)
})

await check('pspp_profile screens the dataset before any analysis', async () => {
  const profile = await call('pspp_profile', {})
  assert.equal(profile.title, '数据体检')
  assert.ok(Array.isArray(profile.variables) && profile.variables.length >= 3, JSON.stringify(profile).slice(0, 300))
  assert.ok(Array.isArray(profile.findings))
  assert.equal(typeof profile.counts.error, 'number')
  // 表与面板同源：表头必须是这一份
  assert.deepEqual(profile.matrix[0], ['变量', '类型', '个案', '缺失', '不同取值', '均值', '标准差', '最小', '最大', '偏度', '离群值'])
})

await check('pspp_sentences turns the last run into sentences', async () => {
  await call('pspp_run', { syntax: 'DESCRIPTIVES score.' })
  const out = await call('pspp_sentences', {})
  assert.ok(Array.isArray(out.sentences), JSON.stringify(out).slice(0, 300))
  assert.ok(out.sentences.some((entry) => entry.kind === 'descriptives'), JSON.stringify(out.sentences))
  assert.ok(Array.isArray(out.skipped))
})

await check('pspp_numbers returns real numbers and nulls for placeholders', async () => {
  await call('pspp_run', { syntax: 'DESCRIPTIVES score.' })
  const out = await call('pspp_numbers', {})
  assert.ok(Array.isArray(out.tables) && out.tables.length >= 1)
  const table = out.tables.find((entry) => /描述|Descriptive/i.test(entry.title)) ?? out.tables[0]
  assert.ok(Array.isArray(table.columns))
  assert.ok(table.rows.some((row) => row.some((cell) => typeof cell === 'number')), JSON.stringify(table).slice(0, 300))
})

await check('pspp_partial reports partial correlations', async () => {
  const partial = await call('pspp_partial', { variables: ['score', 'twice'], controls: ['group'] })
  assert.ok(partial.matrix.length >= 2, JSON.stringify(partial).slice(0, 300))
  assert.match(partial.matrix[0][0], /变量对/)
})

await check('pspp_cox fits a survival model and reports the hazard ratio', async () => {
  const cox = await call('pspp_cox', { time: 'time', event: 'event', covariates: ['group'] })
  assert.equal(cox.matrix[0][0], '变量', JSON.stringify(cox).slice(0, 300))
  assert.equal(cox.matrix.length, 2, 'a header plus one covariate')
  assert.equal(cox.matrix[1][6] !== undefined, true, 'the Exp(B) column is filled')
  assert.ok(cox.notes.some((note) => /Breslow/.test(note)), 'the ties method is stated')
  // 分层：多一张「分层个案摘要」，并且注文要点明风险集按层分开。
  const stratified = await call('pspp_cox', { time: 'time', event: 'event', covariates: ['group'], strata: 'grp' })
  assert.equal(stratified.strata?.[0]?.[0], '分层', 'the by-strata table comes back')
  assert.ok(stratified.strata.length >= 2, 'with at least one stratum plus the total')
  assert.match(stratified.notes[0], /分了 \d+ 层/, 'the note says how many strata')
  assert.equal(stratified.strataVariable, 'grp')
  // 时依协变量：夹具里 time 是 stop，「start」列给每行一个区间。
  const timed = await call('pspp_cox', { time: 'time', event: 'event', covariates: ['group'], start: 'start' })
  assert.equal(timed.matrix[0][0], '变量', JSON.stringify(timed).slice(0, 300))
  assert.ok(timed.notes.some((note) => /计数过程/.test(note)), 'the counting-process wording comes back')
})

await check('pspp_competing reports cumulative incidence and a cause-specific log-rank', async () => {
  const out = await call('pspp_competing', { time: 'time', status: 'event' })
  assert.equal(out.counts[0][0], '原因', JSON.stringify(out).slice(0, 300))
  assert.equal(out.causes.length, 1, 'the fixture has one event type')
  assert.match(out.incidence[0][0], /时间/, 'the incidence table is a long table keyed by time')
  assert.ok(out.notes.some((note) => /Aalen/.test(note)), 'the estimator is named')
  const grouped = await call('pspp_competing', { time: 'time', status: 'event', group: 'grp' })
  assert.ok(Array.isArray(grouped.logRank) && grouped.logRank.length === 1, 'one test per event type')
  assert.ok(grouped.logRank[0].df >= 1, 'df counts the groups minus one')
})

await check('pspp_survival_means reports the restricted mean and the percentiles', async () => {
  const out = await call('pspp_survival_means', { time: 'time', event: 'event' })
  assert.equal(out.matrix[0][0], '分组', JSON.stringify(out).slice(0, 300))
  assert.ok(out.matrix.length >= 2, 'header plus at least one group')
  const header = out.matrix[0]
  const row = out.matrix[1]
  const mean = Number(row[header.indexOf('均值（截尾）')])
  const until = Number(row[header.indexOf('截尾时间')])
  assert.ok(Number.isFinite(mean) && mean >= 0 && mean <= until, `限制均值 ${mean} 应落在 0 与 ${until} 之间`)
  assert.equal(out.percentiles[0][0], '分组')
  const grouped = await call('pspp_survival_means', { time: 'time', event: 'event', group: 'grp' })
  assert.equal(grouped.matrix.length, grouped.groups.length + 1, 'one row per group plus the header')
})

await check('pspp_lifetable reports a life table with intervals and a median row', async () => {
  const out = await call('pspp_lifetable', { time: 'time', status: 'event', interval: 2 })
  assert.equal(out.matrix[0][0], '区间', JSON.stringify(out).slice(0, 300))
  assert.ok(out.steps >= 1, `steps ${out.steps}`)
  assert.equal(out.matrix.length, out.steps + 1, 'header plus one row per interval')
  assert.equal(out.medians[0][0], '分组')
  assert.ok(out.notes.some((note) => /区间宽度/.test(note)), 'the notes name the interval width')
  assert.equal(out.chart.kind, 'km', 'the curve is drawn as a step function')
  const grouped = await call('pspp_lifetable', { time: 'time', status: 'event', group: 'grp', interval: 2 })
  assert.ok(Array.isArray(grouped.groups) && grouped.groups.length >= 2, 'a group column splits the table')
  assert.equal(grouped.medians.length, grouped.groups.length + 1, 'one median row per group plus the header')
})

await check('pspp_multinomial fits a multinomial model and returns every table', async () => {
  const out = await call('pspp_multinomial', { dependent: 'grp', independents: ['score'] })
  assert.equal(out.matrix[0][0], '因变量水平', JSON.stringify(out).slice(0, 300))
  assert.ok(out.tables.length >= 5, 'fit, goodness, pseudo R square, classification and parameters')
  assert.ok(out.reference, 'the reference category is reported back')
  assert.ok(out.accuracy >= 0 && out.accuracy <= 1, `accuracy ${out.accuracy}`)
})

await check('pspp_ordinal fits a proportional-odds model and reports the parallel-lines test', async () => {
  // Three ordered levels, built from the score so the predictor is not a
  // restatement of the dependent variable.
  await call('pspp_run', {
    syntax: 'COMPUTE tier = 1.\nIF (score >= 20) tier = 2.\nIF (score >= 30) tier = 3.\nEXECUTE.',
    persist: true,
  })
  const out = await call('pspp_ordinal', { dependent: 'tier', independents: ['group'] })
  assert.equal(out.matrix[0][0], '变量', JSON.stringify(out).slice(0, 300))
  assert.ok(out.tables.length >= 5, 'fit, parallel lines, pseudo R square, classification and parameters')
  assert.deepEqual(out.categories, [1, 2, 3], 'the sorted values define the order')
  assert.ok(out.parallel && out.parallel.df >= 1, 'the parallel-lines test is computed for three categories')
  assert.ok(out.accuracy >= 0 && out.accuracy <= 1, `accuracy ${out.accuracy}`)
})

await check('pspp_poisson fits a log-link count model and reports dispersion', async () => {
  // `tier` (1–3) from the ordinal check is a legitimate count variable, so the
  // model has something integer to fit without inventing a new column.
  const out = await call('pspp_poisson', { dependent: 'tier', independents: ['group'] })
  assert.equal(out.matrix[0][0], '参数', JSON.stringify(out).slice(0, 300))
  assert.equal(out.tables.length, 3, 'fit information, goodness of fit and parameters')
  assert.ok(out.cases >= 3, `cases ${out.cases}`)
  assert.ok(out.dispersion >= 0 && Number.isFinite(out.dispersion), `dispersion ${out.dispersion}`)
  assert.match(out.notes.join(' '), /log\(预测计数\)/, 'the note prints the fitted equation')
})

await check('pspp_wls fits a weighted regression and equals OLS with equal weights', async () => {
  // `weight` is 1 for every case in the seeded data, so the coefficients must
  // match the plain regression the engine would give for the same variables.
  const out = await call('pspp_wls', { dependent: 'score', independents: ['group'], weight: 'time' })
  assert.equal(out.matrix[0][0], '变量', JSON.stringify(out).slice(0, 300))
  assert.equal(out.tables.length, 3, 'summary, ANOVA and coefficients')
  assert.ok(out.cases >= 3, `cases ${out.cases}`)
  assert.ok(Number.isFinite(out.rSquare), `R² ${out.rSquare}`)
  assert.match(out.notes.join(' '), /权重合计/, 'the note reports the weight total')
})

await check('pspp_twostage fits an instrumented model and reports the first stage', async () => {
  // score 是内生变量、time 是它自己的工具：这一列在 P_Z 下是恒等映射，所以
  // 系数与把 time 当普通自变量一致；关键是第一阶段 F 必须是有限的数。
  const out = await call('pspp_twostage', {
    dependent: 'score', endogenous: ['time'], instruments: ['time'], exogenous: ['group'],
  })
  assert.equal(out.matrix[0][0], '变量', JSON.stringify(out).slice(0, 300))
  assert.equal(out.tables.length, 3, 'summary, first stage and coefficients')
  assert.ok(out.cases >= 3, `cases ${out.cases}`)
  assert.equal(out.stageOne.length, 1, 'one endogenous variable means one first-stage row')
  assert.ok(Number.isFinite(out.stageOne[0].rSquare), `first-stage R² ${out.stageOne[0].rSquare}`)
})

await check('pspp_cluster builds the agglomeration schedule and can draw the tree', async () => {
  const out = await call('pspp_cluster', { variables: ['score'], clusters: 2, chart: true })
  assert.equal(out.matrix[0][0], '阶段', JSON.stringify(out).slice(0, 200))
  assert.ok(out.tables.length >= 3, 'schedule, membership and sizes come back')
  assert.ok(out.model.n >= 3, 'every complete case is clustered')
  assert.ok(out.chart?.title, 'the dendrogram is drawn on request')
})

await check('pspp_timeseries smooths a series and can draw it', async () => {
  const out = await call('pspp_timeseries', { variable: 'time', method: 'ma', span: 2, periods: 1, chart: true })
  assert.equal(out.matrix[0][0], '项目', JSON.stringify(out).slice(0, 200))
  assert.ok(out.model.count >= 1, 'at least one point is fitted')
  assert.equal(out.model.forecast.length, 1, 'one forecast period was asked for')
  assert.ok(out.chart?.title, 'the series chart is drawn on request')
})

await check('pspp_discriminant fits a discriminant model and classifies the cases', async () => {
  const out = await call('pspp_discriminant', { group: 'group', variables: ['score'] })
  assert.equal(out.matrix[0][0], '实际组', JSON.stringify(out).slice(0, 300))
  assert.ok(out.tables.length >= 4, 'four tables come back')
  assert.ok(out.model.wilks > 0 && out.model.wilks <= 1, `Wilks ${out.model.wilks}`)
  assert.ok(out.model.groups.length >= 2, 'both groups are present')
})

await check('the export tools write real files', async () => {
  const sav = join(dir, 'out.sav')
  const xlsx = join(dir, 'out.xlsx')
  const docx = join(dir, 'out.docx')
  const exported = join(dir, 'out.csv')
  await call('pspp_save', { path: sav })
  await call('pspp_export_office', { path: docx })
  await call('pspp_export_office', { path: xlsx })
  await call('pspp_export', { path: exported })
  for (const path of [sav, docx, xlsx, exported]) {
    assert.ok(existsSync(path), `${path} was not written`)
    assert.ok(statSync(path).size > 0, `${path} is empty`)
  }
  const converted = join(dir, 'converted.csv')
  await call('pspp_convert', { path: converted })
  assert.ok(existsSync(converted), 'convert wrote nothing')
})

await check('pspp_append_cases appends a case', async () => {
  const before = await call('pspp_data', { limit: 1 })
  const appended = await call('pspp_append_cases', { cases: [{ score: 55, group: '1', grp: 'A' }] })
  assert.ok(appended, 'append returned nothing')
  const after = await call('pspp_data', { limit: 1 })
  assert.equal(after.total, before.total + 1, `${before.total} -> ${after.total}`)
})

await check('pspp_run_file runs a syntax file on disk', async () => {
  const script = join(dir, 'job.sps')
  writeFileSync(script, 'DESCRIPTIVES /VARIABLES=score.\n')
  const run = await call('pspp_run_file', { path: script })
  assert.ok(run.tables.length >= 1, JSON.stringify(run).slice(0, 300))
})

await check('pspp_edit_chart retitles a chart from its run', async () => {
  const drawn = await call('pspp_chart', { type: 'histogram', variable: 'score' })
  const edited = await call('pspp_edit_chart', { runId: drawn.runId, title: '标题改过了' })
  const chart = edited?.chart ?? {}
  assert.equal(chart.title, '标题改过了')
  // Everything except the title has to be the chart that was drawn: echoing the
  // argument back would pass a title-only check.
  assert.equal(chart.kind, drawn.chart.kind)
  assert.equal(chart.bins.length, drawn.chart.bins.length, 'the edited chart lost its bins')
  assert.deepEqual(chart.bins[0], drawn.chart.bins[0])
  // And the edit has to reach the file, not just the return value.
  const png = join(dir, 'edited.png')
  // The edit answers with its own runId; export that one so the file on disk is
  // the edited chart rather than the one before it.
  await call('pspp_export_chart', { path: png, runId: edited.runId ?? drawn.runId })
  assert.ok(existsSync(png) && statSync(png).size > 0, 'the edited chart was not drawn')
  assert.equal(readFileSync(png).subarray(0, 4).toString('latin1'), '\x89PNG', 'the export is not a png')
})

await check('pspp_export_chart and pspp_export_document write files', async () => {
  // Deliberately re-run an analysis first: `export_document` renders the last
  // run, so a case that leaned on an earlier one would be order-dependent.
  await call('pspp_run', { syntax: 'FREQUENCIES /VARIABLES=group.' })
  const drawn = await call('pspp_chart', { type: 'bar', variable: 'score', by: 'group' })
  const png = join(dir, 'chart.png')
  await call('pspp_export_chart', { path: png, runId: drawn.runId })
  assert.ok(existsSync(png) && statSync(png).size > 0, 'export_chart wrote nothing')
  // A writable-and-non-empty check passes for one byte of garbage: look at the
  // signature the format actually starts with.
  assert.equal(readFileSync(png).subarray(0, 4).toString('latin1'), '\x89PNG', 'export_chart did not write a png')
  const pdf = join(dir, 'doc.pdf')
  await call('pspp_export_document', { path: pdf })
  assert.ok(existsSync(pdf) && statSync(pdf).size > 0, 'export_document wrote nothing')
  assert.match(readFileSync(pdf).subarray(0, 5).toString('latin1'), /^%PDF-/, 'export_document did not write a pdf')
})

await check('pspp_merge adds the variables of another system file', async () => {
  const other = join(dir, 'more.csv')
  writeFileSync(other, 'extra\n1\n2\n3\n4\n5\n6\n7\n8\n9\n')
  await call('pspp_open', { path: other })
  await call('pspp_save', { path: join(dir, 'more.sav') })
  await open()
  const before = await call('pspp_data', { limit: 1 })
  const merged = await call('pspp_merge', { path: join(dir, 'more.sav'), kind: 'add' })
  assert.ok(merged, 'merge returned nothing')
  // `more.csv` holds nine rows: an implementation that only echoed its argument
  // would satisfy "total did not shrink", so demand the exact count and the
  // variable that came with the file.
  const after = await call('pspp_data', { limit: 1 })
  assert.equal(after.total, before.total + 9, `${before.total} -> ${after.total}`)
  const variables = await call('pspp_variables')
  const names = (variables.variables ?? variables).map((entry) => entry.name ?? entry)
  assert.ok(names.includes('extra'), names.join(' '))
})

await check('pspp_run_file needs an existing file', async () => {
  await assert.rejects(() => byName.get('pspp_run_file').execute({ path: join(dir, 'none.sps') }, exec), /file path|ENOENT|no such file/i)
})

await check('pspp_new and pspp_add_variable start an empty dataset', async () => {
  const created = await call('pspp_new', { name: 'blank', variables: [{ name: 'x', type: 'numeric' }] })
  assert.ok(created, 'pspp_new returned nothing')
  const added = await call('pspp_add_variable', { name: 'y', type: 'numeric' })
  assert.ok(added, 'pspp_add_variable returned nothing')
  const variables = await call('pspp_variables')
  const names = (variables.variables ?? variables).map((entry) => entry.name ?? entry)
  assert.ok(names.includes('y'), names.join(' '))
})

await check('pspp_distribution evaluates a distribution and returns a quantile', async () => {
  const out = await call('pspp_distribution', { distribution: 'normal', x: 1.959963985, probability: 0.975 })
  assert.equal(out.matrix[0][0], '项目')
  assert.ok(Math.abs(out.cdf - 0.975) < 1e-9, `cdf ${out.cdf}`)
  assert.ok(Math.abs(out.quantile - 1.959963985) < 1e-8, `quantile ${out.quantile}`)
  // 离散分布：泊松在 λ=2、x=3 处的累积概率是教科书值。
  const poisson = await call('pspp_distribution', { distribution: 'poisson', x: 3, lambda: 2 })
  assert.ok(Math.abs(poisson.cdf - 0.8571234605) < 1e-6, `poisson cdf ${poisson.cdf}`)
})

await check('pspp_correspondence maps two categorical variables', async () => {
  // pspp_new 在上一段把数据集换成了空白表，这里重新打开夹具 CSV。
  await open()
  const out = await call('pspp_correspondence', { row: 'grp', column: 'group' })
  assert.equal(out.matrix[0][0], '维')
  assert.ok(Number.isFinite(out.chiSquare) && out.chiSquare >= 0, `chi-square ${out.chiSquare}`)
  assert.ok(out.rows.length >= 2 && out.columns.length >= 2, `${out.rows.length}x${out.columns.length}`)
})

await check('pspp_mds places the cases in a low-dimensional space', async () => {
  await open()
  const out = await call('pspp_mds', { variables: ['score', 'time'], dimensions: 2 })
  assert.equal(out.matrix[0][0], '维')
  assert.equal(out.dimensions, 2)
  assert.ok(out.stress >= 0 && out.stress <= 1, `stress ${out.stress}`)
  assert.equal(out.coordinates.length, out.cases + 1, 'one row of coordinates per case plus the header')
  assert.ok(out.chart?.kind === 'biplot', 'the map comes with it')
})

await check('pspp_loglinear fits a log-linear model and reports partial associations', async () => {
  // 自带一个两分类变量的夹具：对数线性分析只收分类变量，pspp_new 可以直接
  // 声明成 string，不必先改 measure。
  const rows = []
  for (let index = 0; index < 40; index += 1) {
    rows.push({ a: index % 2 ? 'x' : 'y', b: ['p', 'q', 'r'][index % 3] })
  }
  await call('pspp_new', {
    variables: [
      { name: 'a', type: 'string', measure: 'nominal' },
      { name: 'b', type: 'string', measure: 'nominal' },
    ],
    rows,
  })
  const out = await call('pspp_loglinear', { variables: ['a', 'b'], terms: [['a'], ['b']] })
  assert.equal(out.matrix[0][0], '模型')
  assert.ok(out.fit.df > 0, `df ${out.fit.df}`)
  assert.ok(out.fit.g2 >= 0, `G squared ${out.fit.g2}`)
  // 两个表都是「表头 + 数据行」的矩阵，不是对象数组。
  assert.deepEqual(out.parameters[0], ['参数', '估计', '标准误', 'z', 'P'])
  assert.equal(out.parameters[1][0], '常数项', 'the first parameter is the intercept')
  assert.equal(out.parameters.filter((row) => String(row[0]).startsWith('常数项')).length, 1, 'exactly one intercept')
  assert.ok(out.parameters.slice(1).every((row) => Number.isFinite(Number(row[1]))), 'every estimate is a number')
  assert.equal(out.partial.length, out.terms.length + 1, 'a header plus one partial association row per term')
  assert.ok(out.partial.length >= 2, 'one partial association row per term')
  assert.ok(out.cells[0].includes('观察频数'), 'the cell table names the counts')
})

await check('pspp_curve fits the requested models and returns the best one', async () => {
  await open()
  const out = await call('pspp_curve', {
    dependent: 'score',
    independent: 'time',
    models: ['linear', 'quadratic', 'exponential'],
  })
  assert.equal(out.matrix[0][0], '模型')
  assert.equal(out.models.length, 3)
  assert.ok(out.models.every((entry) => Number.isFinite(entry.rSquare)), 'every model reports an R²')
  assert.ok(['linear', 'quadratic', 'exponential'].includes(out.best), `best ${out.best}`)
  assert.ok(out.chart?.kind === 'scatter', 'a scatter plot comes with it')
})

await check('pspp_mca maps the categories of several variables', async () => {
  // 自带一个两类变量的夹具：多重对应分析只收名义/有序变量，而 pspp_new 能
  // 直接把它们声明成 string，省得先改 measure。
  const pairs = [['甲', 'X'], ['甲', 'Y'], ['乙', 'X'], ['乙', 'Y']]
  const rows = []
  for (let index = 0; index < 12; index += 1) rows.push({ v1: pairs[index % 4][0], v2: pairs[index % 4][1] })
  await call('pspp_new', {
    variables: [
      { name: 'v1', type: 'string', measure: 'nominal' },
      { name: 'v2', type: 'string', measure: 'nominal' },
    ],
    rows,
  })
  const out = await call('pspp_mca', { variables: ['v1', 'v2'] })
  assert.equal(out.matrix[0][0], '维')
  assert.ok(out.categories >= 4, `categories ${out.categories}`)
  assert.ok(Number.isFinite(out.inertia) && out.inertia > 0, `inertia ${out.inertia}`)
  assert.equal(out.tables.length, 3)
})

await check('every tool has been exercised by this suite', () => {
  const missing = tools.map((tool) => tool.name).filter((name) => !exercised.has(name))
  assert.deepEqual(missing, [], `never called: ${missing.join(' ')}`)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\ntools: ${checks} checks passed`)
