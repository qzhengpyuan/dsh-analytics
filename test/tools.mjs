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
writeFileSync(csv, 'score,group,grp\n12,1,A\n18,1,A\n23,1,B\n31,2,B\n44,2,A\n15,2,B\n27,1,A\n8,2,B\n')

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
  assert.equal(names.length, 23, names.join(' '))
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
  assert.deepEqual(names, ['score', 'group', 'grp'], names.join(' '))
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
})

await check('pspp_partial reports partial correlations', async () => {
  const partial = await call('pspp_partial', { variables: ['score', 'twice'], controls: ['group'] })
  assert.ok(partial.matrix.length >= 2, JSON.stringify(partial).slice(0, 300))
  assert.match(partial.matrix[0][0], /变量对/)
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
  await call('pspp_export_chart', { path: png, runId: drawn.runId })
  assert.ok(existsSync(png) && statSync(png).size > 0, 'the edited chart was not drawn')
})

await check('pspp_export_chart and pspp_export_document write files', async () => {
  // Deliberately re-run an analysis first: `export_document` renders the last
  // run, so a case that leaned on an earlier one would be order-dependent.
  await call('pspp_run', { syntax: 'FREQUENCIES /VARIABLES=group.' })
  const drawn = await call('pspp_chart', { type: 'bar', variable: 'score', by: 'group' })
  const png = join(dir, 'chart.png')
  await call('pspp_export_chart', { path: png, runId: drawn.runId })
  assert.ok(existsSync(png) && statSync(png).size > 0, 'export_chart wrote nothing')
  const pdf = join(dir, 'doc.pdf')
  await call('pspp_export_document', { path: pdf })
  assert.ok(existsSync(pdf) && statSync(pdf).size > 0, 'export_document wrote nothing')
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

await check('every tool has been exercised by this suite', () => {
  const missing = tools.map((tool) => tool.name).filter((name) => !exercised.has(name))
  assert.deepEqual(missing, [], `never called: ${missing.join(' ')}`)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\ntools: ${checks} checks passed`)
