// Exercises the HTTP handler without the host's browser-auth fence.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceRegistry } from '../lib/workspace.js'
import { resolveEngine } from '../lib/engine.js'
import { createHandler } from '../lib/routes.js'
import { SettingsStore } from '../lib/settings.js'

const home = await mkdtemp(join(tmpdir(), 'ap-routes-'))
const settingsStore = new SettingsStore(join(home, 'analytics'), { registerTools: false })
const registry = new WorkspaceRegistry({ root: join(home, 'analytics'), config: {}, engine: resolveEngine({}), settingsStore })
const handler = createHandler({
  registry,
  connection: { requestRejection: () => undefined },
  config: {},
  settings: settingsStore,
})

class Res {
  constructor() { this.code = 0; this.headers = {}; this.chunks = [] }
  writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers ?? {}) }
  write(chunk) { this.chunks.push(Buffer.from(chunk)) }
  end(chunk) { if (chunk) this.write(chunk); this.done = true }
  get body() { return Buffer.concat(this.chunks) }
  get text() { return this.body.toString('utf8') }
}

// The panel's Help menu asks this one; without a check wired in it must say so
// instead of pretending everything is current.
{
  const blind = createHandler({
    registry,
    connection: { requestRejection: () => undefined },
    config: {},
    settings: settingsStore,
  })
  const answer = new Res()
  await blind({ method: 'GET', url: '/analytics/api/update', headers: { host: '127.0.0.1:3080' } }, answer)
  if (answer.code !== 503) throw new Error(`an unwired update check must answer 503, got ${answer.code}`)
  if (!/没有接上/.test(answer.text)) throw new Error(`the reason must be stated: ${answer.text}`)

  const wired = createHandler({
    registry,
    connection: { requestRejection: () => undefined },
    config: {},
    settings: settingsStore,
    updateCheck: async (current) => ({ current, latest: '0.99.0', newer: true, url: 'https://example/rel' }),
  })
  const fresh = new Res()
  await wired({ method: 'GET', url: '/analytics/api/update', headers: { host: '127.0.0.1:3080' } }, fresh)
  if (fresh.code !== 200) throw new Error(`a wired update check must answer 200, got ${fresh.code}`)
  const payload = JSON.parse(fresh.text)
  if (payload.latest !== '0.99.0' || payload.newer !== true) throw new Error(`the answer is not forwarded: ${fresh.text}`)
  if (!payload.current) throw new Error('the answer names the version it compared against')

  // A release number is not data: the check answers without a session, exactly
  // like api/version, so an installer or a doctor script can ask it. Everything
  // that touches a dataset still gets the 401.
  const gated = createHandler({
    registry,
    connection: { requestRejection: () => 401 },
    config: {},
    settings: settingsStore,
    updateCheck: async (current) => ({ current, latest: '0.99.0', newer: true }),
  })
  const open = new Res()
  await gated({ method: 'GET', url: '/analytics/api/update', headers: { host: '127.0.0.1:3080' } }, open)
  if (open.code !== 200) throw new Error(`the update check stays outside the session gate, got ${open.code}`)
  const shut = new Res()
  await gated({ method: 'GET', url: '/analytics/api/state?sessionId=x', headers: { host: '127.0.0.1:3080' } }, shut)
  if (shut.code !== 401) throw new Error(`a dataset route still needs a session, got ${shut.code}`)
}

// The web server can come up before the connection service. A handler that
// captured the empty slot at mount time answers 401 to every request for the
// rest of the process, which is exactly what a panel sees as "cannot reach the
// host". The lookup has to happen per request.
{
  let link
  const late = createHandler({
    registry,
    getConnection: () => link,
    config: {},
    settings: settingsStore,
  })
  const request = {
    method: 'GET',
    url: '/analytics/api/heartbeat',
    headers: { host: '127.0.0.1:3080' },
  }
  const before = new Res()
  await late(request, before)
  if (before.code !== 401) throw new Error(`without a connection the handler must fail closed, got ${before.code}`)
  link = { requestRejection: () => undefined }
  const after = new Res()
  await late(request, after)
  if (after.code !== 200) throw new Error(`a connection that arrived later must be used, got ${after.code}`)
}

// The version probe is the one route that answers without a session cookie:
// an installer or a user typing the address otherwise only ever sees 401.
{
  const blind = createHandler({
    registry,
    getConnection: () => ({ requestRejection: () => 401 }),
    config: { pluginVersion: '9.9.9' },
    settings: settingsStore,
  })
  const probe = new Res()
  await blind({ method: 'GET', url: '/analytics/api/version', headers: { host: '127.0.0.1:3080' } }, probe)
  if (probe.code !== 200) throw new Error(`api/version must answer without a cookie, got ${probe.code}`)
  const body = JSON.parse(probe.text)
  // The route reads the manifest at request time, not the copy captured when the
  // handler was built: after a hot reload the captured one is the previous
  // build, and this is the endpoint people use to ask "which build is running".
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (body.version !== manifest.version) throw new Error(`api/version must report the manifest version ${manifest.version}, got ${probe.text}`)
  if (JSON.stringify(body) !== JSON.stringify({ ok: true, plugin: 'dsh-analytics-pspp', version: manifest.version })) {
    throw new Error(`api/version must not leak anything else, got ${probe.text}`)
  }
  const heart = new Res()
  await blind({ method: 'GET', url: '/analytics/api/heartbeat', headers: { host: '127.0.0.1:3080' } }, heart)
  if (heart.code !== 401) throw new Error(`every other route must still fail closed, got ${heart.code}`)
  console.log('ok   the version probe answers without a cookie and leaks nothing else')
}

const call = async (method, url, body) => {
  const payload = body ? JSON.stringify(body) : null
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', 'content-length': payload ? String(Buffer.byteLength(payload)) : '0' },
    [Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload) },
    on() {}, once() {}, removeListener() {},
  }
  const res = new Res()
  await handler(req, res)
  return { code: res.code, headers: res.headers, body: res.body, text: res.text, json: () => JSON.parse(res.text) }
}

const sid = 'test-session'
const base = '/analytics'
let r = await call('POST', `${base}/api/new`, { sessionId: sid, cwd: home, variables: [
  { name: 'gender', type: 'string', label: '性别' },
  { name: 'age', type: 'numeric', label: '年龄' },
  { name: 'score', type: 'numeric', label: '得分' },
  { name: 'cohort', type: 'numeric', label: '批次' },
] })
console.log('new', r.code, r.text.slice(0, 120))
for (const values of [{ gender: 'M', age: 23, score: 78.5, cohort: 1 }, { gender: 'F', age: 31, score: 88, cohort: 2 }, { gender: 'M', age: 45, score: 65.5, cohort: 1 }, { gender: 'F', age: 27, score: 71, cohort: 2 }]) {
  r = await call('POST', `${base}/api/case`, { sessionId: sid, values })
}
r = await call('POST', `${base}/api/save`, { sessionId: sid, path: join(home, 'demo.sav') })
console.log('save', r.code, JSON.stringify(r.json().result))

r = await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'GRAPH /BAR(SIMPLE)=MEAN(score) BY gender.\nFREQUENCIES /VARIABLES=gender.' })
const out = r.json().result
console.log('run', r.code, 'items', out.items?.length, 'diag', JSON.stringify(out.diagnostics))
console.log('image', JSON.stringify(out.items?.find((i) => i.kind === 'image')?.artifactUrl))

// 语法文件：返回 kind=syntax，不动当前数据集
const spsPath = join(home, 'analysis.sps')
await writeFile(spsPath, 'DESCRIPTIVES /VARIABLES=score.\n', 'utf8')
const openedSps = await call('POST', `${base}/api/open`, { sessionId: sid, path: spsPath })
const spsJson = openedSps.json()
console.log('open sps', openedSps.code, spsJson.result?.kind, String(spsJson.result?.text ?? '').includes('DESCRIPTIVES'), spsJson.state?.dataset?.sourcePath?.endsWith('.sps'))
if (spsJson.result?.kind !== 'syntax') throw new Error('api/open must report a syntax file')
if (spsJson.state?.dataset?.sourcePath?.endsWith('.sps')) throw new Error('a syntax file must not become the dataset')

// 导入向导：预览一个还没导入的文件（列名、类型、前几行），并且不动数据集
// A session of its own: this block imports a file, and the checks below still
// need the dataset the later cases were written against.
const wizardSid = `${sid}-wizard`
const wizardCsv = join(home, 'wizard.csv')
await writeFile(wizardCsv, '年度报表\n年龄,性别\n21,男\n34,女\n')
const previewed = await call('POST', `${base}/api/previewImport`, { sessionId: wizardSid, path: wizardCsv, options: { skipRows: 1 } })
const previewJson = previewed.json()
console.log('preview import', previewed.code, previewJson.result?.totalRows, (previewJson.result?.columns ?? []).map((column) => column.type).join(','))
if (previewed.code !== 200) throw new Error(`api/previewImport failed: ${previewJson.error}`)
if (previewJson.result?.totalRows !== 2) throw new Error('the preview must count the rows after the skipped ones')
if ((previewJson.result?.columns ?? []).length !== 2) throw new Error('the preview must list the columns')
if (previewJson.state?.dataset?.sourcePath?.endsWith('wizard.csv')) throw new Error('a preview must not import anything')
const wizardImport = await call('POST', `${base}/api/open`, {
  sessionId: wizardSid,
  path: wizardCsv,
  options: { skipRows: 1, names: ['age', 'sex'], types: ['numeric', 'string'], missing: ['-9'] },
})
const wizardState = wizardImport.json().state
if (wizardImport.code !== 200) throw new Error(`importing with the wizard options failed: ${wizardImport.json().error}`)
if (wizardState?.dataset?.variables?.[0]?.name !== 'age') throw new Error('the name from the wizard must be used')
if (wizardState?.dataset?.variables?.[0]?.type !== 'numeric') throw new Error('the type from the wizard must be used')

// 图表拼版：两张图合成一张，按给定顺序放进格子
const chartOne = await call('POST', `${base}/api/chart`, { sessionId: wizardSid, kind: 'bar', variable: 'age' })
const chartTwo = await call('POST', `${base}/api/chart`, { sessionId: wizardSid, kind: 'histogram', variable: 'age' })
const chartIds = [chartOne.json().state?.items, chartTwo.json().state?.items]
  .map((items) => (items ?? []).filter((item) => item.kind === 'image').at(-1)?.id)
  .filter(Boolean)
const grid = await call('POST', `${base}/api/chartGrid`, { sessionId: wizardSid, items: chartIds, layout: '1x2' })
const gridState = grid.json().state
const gridItem = (gridState?.items ?? []).filter((item) => item.kind === 'image').at(-1)
console.log('chart grid', grid.code, chartIds.length, grid.json().result?.layout, gridItem?.title)
if (grid.code !== 200) throw new Error(`api/chartGrid failed: ${grid.json().error}`)
if (chartIds.length !== 2) throw new Error('both charts must exist before binding them')
if (grid.json().result?.charts !== 2) throw new Error('the grid must count both charts')
if (!/拼版/.test(String(gridItem?.title ?? ''))) throw new Error('the grid becomes an output of its own')
const gridRefused = await call('POST', `${base}/api/chartGrid`, { sessionId: wizardSid, items: chartIds, layout: '2x1' })
if (gridRefused.code !== 200) throw new Error('2x1 holds two charts and must succeed')
const tooMany = await call('POST', `${base}/api/chartGrid`, { sessionId: wizardSid, items: [chartIds[0], chartIds[1], chartIds[0]], layout: '1x2' })
if (tooMany.code !== 400) throw new Error('three charts in a two-cell layout must be refused')
// A two-column numeric file of its own: a residual plot needs a fit that is not
// perfect, and the wizard fixture has one numeric column only.
const fitCsv = join(home, 'fit.csv')
const fitRows = Array.from({ length: 20 }, (_, index) => `${2 + 3 * (index + 1) + ((index % 3) - 1) * 0.4},${index + 1}`)
await writeFile(fitCsv, `y,x\n${fitRows.join('\n')}\n`)
const fitSid = `${sid}-fit`
const fitOpen = await call('POST', `${base}/api/open`, { sessionId: fitSid, path: fitCsv })
if (fitOpen.code !== 200) throw new Error(`opening the fit fixture failed: ${fitOpen.json().error}`)
const residualPlot = await call('POST', `${base}/api/regressionPlot`, { sessionId: fitSid, kind: 'residual', regression: { dependent: 'y', independents: ['x'] } })
console.log('regression plot', residualPlot.code, residualPlot.json().result?.chart?.kind)
if (residualPlot.code !== 200) throw new Error(`api/regressionPlot failed: ${residualPlot.json().error}`)
if (residualPlot.json().result?.chart?.zeroLine !== true) throw new Error('the residual plot must read against zero')
const ppPlot = await call('POST', `${base}/api/regressionPlot`, { sessionId: fitSid, kind: 'pp', regression: { dependent: 'y', independents: ['x'] } })
if (ppPlot.code !== 200 || ppPlot.json().result?.chart?.diagonal !== true) throw new Error('the P-P plot must read against the diagonal')
const plotRefused = await call('POST', `${base}/api/regressionPlot`, { sessionId: fitSid, kind: 'residual', regression: { dependent: 'y', independents: [] } })
if (plotRefused.code !== 400) throw new Error('a model without predictors must be refused')

const redrawn = await call('POST', `${base}/api/chart/redraw`, { sessionId: wizardSid, runId: Number(String(chartIds[0]).replace(/^chart-/, '').split('-')[0]), type: 'boxplot' })
const redrawResult = redrawn.json().result
const redrawState = redrawn.json().state
console.log('chart redraw', redrawn.code, redrawResult?.chart?.kind, redrawResult?.redrawnFrom)
if (redrawn.code !== 200) throw new Error(`api/chart/redraw failed: ${redrawn.json().error}`)
if (redrawResult?.chart?.kind !== 'boxplot') throw new Error('the redrawn model must be the requested kind')
const stillThere = (redrawState?.items ?? []).filter((item) => item.kind === 'image')
if (stillThere.length < 3) throw new Error('the original chart must stay in the output tree')
if (redrawResult?.item?.chartSpec?.redrawnFrom !== redrawResult?.redrawnFrom) throw new Error('the new chart records where it came from')
// 重绘要留住决定图形样子的选项，否则 P-P 重绘回来变成 Q-Q、带拟合线的散点丢线
// （Win10 0740 的 P2-4）。
const probChart = await call('POST', `${base}/api/chart`, { sessionId: fitSid, kind: 'ppplot', variable: 'x', plot: 'qq' })
if (probChart.code !== 200) throw new Error(`api/chart ppplot failed: ${probChart.json().error}`)
const probId = (probChart.json().state?.items ?? []).filter((item) => item.kind === 'image').at(-1)?.id
const probRun = Number(String(probId ?? '').replace(/^chart-/, '').split('-')[0])
const probRedraw = await call('POST', `${base}/api/chart/redraw`, { sessionId: fitSid, runId: probRun, type: 'ppplot' })
const probSpec = (probRedraw.json().state?.items ?? []).filter((item) => item.kind === 'image').at(-1)?.chartSpec
console.log('pplot redraw keeps plot ->', probRedraw.code, probSpec?.plot, probRedraw.json().result?.chart?.plot)
if (probRedraw.code !== 200) throw new Error(`api/chart/redraw ppplot failed: ${probRedraw.json().error}`)
if (probSpec?.plot !== 'qq') throw new Error('the redrawn chart must keep the P-P/Q-Q choice')
if (!/Q-Q/.test(String(probRedraw.json().result?.chart?.title ?? ''))) throw new Error('and the model must still be the Q-Q one')

const redrawBad = await call('POST', `${base}/api/chart/redraw`, { sessionId: wizardSid, runId: redrawResult.runId, type: 'nonsense' })
if (redrawBad.code !== 400) throw new Error('an unknown chart type must be refused')

const tableAsChart = await call('POST', `${base}/api/chartGrid`, { sessionId: wizardSid, items: ['nope'], layout: '2x2' })
if (tableAsChart.code !== 400) throw new Error('an unknown id must be refused')

// 批量粘贴：一次请求写入一个矩形块
const paste = await call('POST', `${base}/api/paste`, {
  sessionId: sid,
  cells: [
    { row: 0, variable: 'score', value: '42' },
    { row: 0, variable: 'gender', value: 'X' },
  ],
})
console.log('paste', paste.code, JSON.stringify(paste.json().result))
if (paste.code !== 200) throw new Error('api/paste failed')
const pastedRow = (await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 1 })).json().page.rows[0]
console.log('pasted row', JSON.stringify(pastedRow))
if (pastedRow[pastedRow.length - 2] !== 42 && !pastedRow.includes(42)) throw new Error(`api/paste did not write: ${JSON.stringify(pastedRow)}`)

// 单条输出删除：只掉一项，数据和其它输出不动
const stateBefore = (await call('GET', `${base}/api/state?sessionId=${encodeURIComponent(sid)}`)).json().state
const lastId = stateBefore.items[stateBefore.items.length - 1].id
const removed = await call('POST', `${base}/api/output`, { sessionId: sid, action: 'remove', id: lastId })
const stateAfter = removed.json().state
console.log('remove output', removed.code, stateBefore.items.length, '->', stateAfter.items.length, stateAfter.items.some((item) => item.id === lastId))
if (stateAfter.items.length !== stateBefore.items.length - 1) throw new Error('api/output did not remove exactly one item')
if (stateAfter.items.some((item) => item.id === lastId)) throw new Error('api/output kept the removed item')
if (!stateAfter.dataset) throw new Error('api/output must not touch the dataset')

// 自定义表（CTABLES）：统计量跟随行变量，MIN/MAX 在 PSPP 里必须写 MINIMUM/MAXIMUM
const ctab = await call('POST', `${base}/api/run`, {
  sessionId: sid,
  syntax: [
    'VARIABLE LEVEL cohort (NOMINAL).',
    'CTABLES /TABLE=score [COUNT, MEAN, STDDEV, MINIMUM, MAXIMUM] BY cohort',
    "/TITLES TITLE='按组统计'",
    '/CATEGORIES VARIABLES=cohort ORDER=A MISSING=INCLUDE',
    '/CRITERIA CILEVEL 95.',
  ].join('\n'),
})
const ctabOut = ctab.json().result
console.log('ctables', ctab.code, 'items', ctabOut.items?.length, 'tables', ctabOut.items?.filter((i) => i.kind === 'table').length)
console.log('ctables title', JSON.stringify(ctabOut.items?.find((i) => i.kind === 'table')?.title))
console.log('ctables diag', JSON.stringify(ctabOut.diagnostics?.map((d) => `${d.severity}: ${d.message}`)))
if ((ctabOut.items ?? []).filter((item) => item.kind === 'table').length !== 1) {
  throw new Error(`ctables produced no table: ${JSON.stringify(ctabOut.diagnostics)}`)
}

const image = out.items.find((i) => i.kind === 'image')
if (image) {
  const art = await call('GET', image.artifactUrl.replace(/^analytics/, base))
  console.log('artifact', art.code, art.headers['content-type'], art.body.length, 'bytes')
}

r = await call('GET', `${base}/api/state?sessionId=${sid}`)
console.log('state', r.code, r.json().state.dataset.variables.map((v) => `${v.name}:${v.label ?? ''}`).join(', '))

r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 5 })
console.log('rows', r.code, JSON.stringify(r.json().page.rows))

r = await call('POST', `${base}/api/cell`, { sessionId: sid, row: 1, variable: 'score', value: '99.5' })
r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 2 })
console.log('cell edit ->', JSON.stringify(r.json().page.rows))

r = await call('GET', `${base}/api/artifact?sessionId=${sid}&runId=999&name=nope.png`)
console.log('missing artifact', r.code, r.text)

r = await call('POST', `${base}/api/case`, { sessionId: sid, action: 'insert', row: 1, values: { gender: 'F', age: 20, score: 60 } })
r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 10 })
console.log('inserted ->', JSON.stringify(r.json().page.rows.map((row) => row[1])))

r = await call('POST', `${base}/api/sort`, { sessionId: sid, keys: [{ name: 'age', order: 'd' }] })
r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 10 })
console.log('sorted ages ->', JSON.stringify(r.json().page.rows.map((row) => row[1])))

r = await call('POST', `${base}/api/chart`, { sessionId: sid, options: { kind: 'bar', variable: 'score', by: 'gender' } })
const barResult = r.json().result
console.log('chart bar', r.code, JSON.stringify(barResult.chart.categories))
const svg = await call('GET', barResult.item.artifactUrl.replace(/^\/analytics/, base))
console.log('chart svg', svg.code, svg.headers['content-type'], svg.body.length, 'bytes', String(svg.text).startsWith('<svg'))

r = await call('POST', `${base}/api/chart/update`, {
  sessionId: sid,
  runId: barResult.runId,
  title: '性别与得分',
  accent: '#b4453a',
  sortCategories: 'desc',
})
const edited = r.json().result
console.log('chart edited', r.code, edited.chart.title === '性别与得分', edited.chart.accent === '#b4453a')
console.log('chart edit bumped url', /v=\d+/.test(String(edited.item?.artifactUrl)))
const editedSvg = await call('GET', `${base}/api/artifact?sessionId=${encodeURIComponent(sid)}&runId=${barResult.runId}&name=chart.svg`)
console.log('edited svg has accent', String(editedSvg.text).includes('#b4453a'))
// 编辑器要回填当前外观：读回的就是当初存下去的那几项，缺省项给空串。
r = await call('POST', `${base}/api/chart/options`, { sessionId: sid, runId: barResult.runId })
const optionsBack = r.json().result
console.log('chart options read back', r.code,
  optionsBack.title === '性别与得分',
  optionsBack.accent === '#b4453a',
  optionsBack.sortCategories === 'desc',
  optionsBack.subtitle === '')
// 只发改动的键：副标题写进去，先前设的 accent 与 sortCategories 不能被清掉。
r = await call('POST', `${base}/api/chart/update`, { sessionId: sid, runId: barResult.runId, subtitle: 'N = 12' })
const patched = r.json().result
console.log('partial edit keeps the rest', patched.chart.subtitle === 'N = 12', patched.chart.accent === '#b4453a', patched.options.sortCategories === 'desc')
r = await call('POST', `${base}/api/chart/options`, { sessionId: sid, runId: 9999 })
console.log('chart options of unknown run refused', r.code, /没有图表/.test(String(r.json().error)))

r = await call('POST', `${base}/api/chart/update`, { sessionId: sid, runId: 9999, title: 'x' })
console.log('chart edit of unknown run refused', r.code, /没有图表/.test(String(r.json().error)))

r = await call('POST', `${base}/api/chart`, { sessionId: sid, options: { kind: 'histogram', variable: 'score', bins: 4 } })
console.log('chart histogram', r.code, r.json().result.chart.bins.length, 'bins, total', r.json().result.chart.total)

r = await call('POST', `${base}/api/chart`, { sessionId: sid, options: { kind: 'scatterplot', x: 'age', y: 'score' } })
console.log('chart scatter', r.code, r.json().result.chart.points.length, 'points')

for (const [kind, options] of [
  ['boxplot', { variable: 'score', by: 'gender' }],
  ['line', { variable: 'score', by: 'gender' }],
  ['pie', { variable: 'gender' }],
]) {
  r = await call('POST', `${base}/api/chart`, { sessionId: sid, options: { kind, ...options } })
  const chart = r.json().result?.chart
  const shape = kind === 'boxplot' ? `${chart?.groups?.length ?? 0} groups`
    : kind === 'line' ? `${chart?.points?.length ?? 0} points`
      : `${chart?.slices?.length ?? 0} slices`
  console.log(`chart ${kind}`, r.code, shape)
  const svg2 = await call('GET', `${base}/api/artifact?sessionId=${sid}&runId=${r.json().result.runId}&name=chart.svg`)
  console.log(`chart ${kind} svg`, svg2.code, String(svg2.text).startsWith('<svg'))
}

r = await call('POST', `${base}/api/chart`, { sessionId: sid, options: { kind: 'bar', variable: 'gender', by: 'gender' } })
console.log('chart bad variable', r.code, r.json().error)

// table 1 / table 2 come from the loaded dataset, not from an engine run
r = await call('POST', `${base}/api/publication`, { sessionId: sid, kind: 'baseline', options: { group: 'gender', variables: ['score'] } })
const pub = r.json().result
console.log('publication baseline', r.code, pub?.matrix?.[0]?.length, pub?.matrix?.length, pub?.item?.title?.includes('表 1'))
r = await call('POST', `${base}/api/publication`, { sessionId: sid, kind: 'compare', options: { group: 'gender', variables: ['score'] } })
console.log('publication compare', r.code, r.json().result?.matrix?.[0]?.[1]?.includes('（n='), r.json().result?.item?.title?.includes('表 2'))
r = await call('POST', `${base}/api/publication`, { sessionId: sid, kind: 'baseline', options: {} })
console.log('publication without a group', r.code, /分组变量/.test(String(r.json().error)))
r = await call('POST', `${base}/api/pairwise`, { sessionId: sid, options: { group: 'cohort', variables: ['age'], adjust: 'bonferroni' } })
console.log('pairwise', r.code, r.json().result?.matrix?.length, r.json().result?.matrix?.[1]?.[1], r.json().result?.matrix?.[0]?.at(-2))
// The default branch matters as much as the explicit one: adjusting is the
// default now, and a regression there silently publishes raw P values.
r = await call('POST', `${base}/api/pairwise`, { sessionId: sid, options: { group: 'cohort', variables: ['age'] } })
console.log('pairwise default', r.code, r.json().result?.matrix?.[0]?.[7])
r = await call('POST', `${base}/api/pairwise`, { sessionId: sid, options: { group: 'cohort', variables: ['age'], adjust: 'none' } })
console.log('pairwise unadjusted', r.code, r.json().result?.matrix?.[0]?.[7])
r = await call('POST', `${base}/api/pairwise`, { sessionId: sid, options: { group: 'cohort', variables: ['age'], layout: 'matrix' } })
console.log('pairwise matrix', r.code, (r.json().result?.matrix?.[0] ?? []).join('|'))
// PSPP has no PARTIAL CORR; the plugin computes the table itself, so the route
// has to work without touching the engine.
r = await call('POST', `${base}/api/partial`, { sessionId: sid, options: { variables: ['age', 'score'] } })
console.log('partial', r.code, r.json().result?.matrix?.[0]?.length, r.json().result?.matrix?.[1]?.[3])
r = await call('POST', `${base}/api/partial`, { sessionId: sid, options: { variables: ['age', 'score'], controls: ['cohort'] } })
const partial = r.json().result
console.log('partial with a control', r.code, partial?.item?.title?.includes('控制'), partial?.matrix?.[1]?.[2] !== '—')
r = await call('POST', `${base}/api/partial`, { sessionId: sid, options: { variables: ['age'] } })
console.log('partial needs two variables', r.code, /至少需要两个/.test(String(r.json().error)))
// The matrix form shares one listwise deletion across all cells, so its
// diagonal is 1 and the grid stays symmetric.
r = await call('POST', `${base}/api/partial`, { sessionId: sid, options: { variables: ['age', 'score'], layout: 'matrix' } })
const partialGrid = r.json().result?.matrix ?? []
console.log('partial matrix', r.code, partialGrid[0]?.length === 3, partialGrid[1]?.[1], partialGrid[1]?.[2] === partialGrid[2]?.[1])
// gender is a string variable: the table must refuse it instead of reporting
// "0 valid cases", which reads like an empty dataset.
r = await call('POST', `${base}/api/partial`, { sessionId: sid, options: { variables: ['age', 'gender'] } })
console.log('partial refuses a string variable', r.code, /只能用于数值变量/.test(String(r.json().error)))

// PSPP 2.1.3 exits non-zero on a regression with /STATISTICS=TOL and writes
// "No valid data found. This command was skipped." even though every table is
// there; that must come back as a note, not an error.
r = await call('POST', `${base}/api/run`, {
  sessionId: sid,
  syntax: 'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=COEFF R ANOVA CI TOL.',
})
const reg = r.json().result
const regErrors = (reg?.diagnostics ?? []).filter((entry) => entry.severity === 'error')
console.log('regression TOL is not an error', r.code, (reg?.items ?? []).filter((i) => i.kind === 'table').length, regErrors.length, (reg?.diagnostics ?? []).some((entry) => entry.severity === 'note'))

// D7: when the caller asks for TOL and the engine crashes, runSyntax retries
// without TOL — and the retry must still deliver what the log promises. Either
// the engine printed its own Tolerance column or the plugin table is there.
r = await call('POST', `${base}/api/run`, {
  sessionId: sid,
  syntax: 'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=COEFF R ANOVA CI TOL.',
  regression: { dependent: 'score', independents: ['age'] },
})
{
  const items = r.json().result?.items ?? []
  const tables = items.filter((item) => item.kind === 'table')
  const engineTol = tables.some((item) => (item.table?.matrix?.[0] ?? []).some((cell) => /Tolerance|容忍度/i.test(String(cell))))
  const pluginTol = tables.some((item) => /共线性诊断/.test(String(item.title)))
  // PSPP fills the column with .00 / +Infinit on this tiny sample; those cells
  // are blanked so nobody reads the wrong number first.
  const coeff = tables.find((item) => /Coefficients/.test(String(item.title)))
  const cells = (coeff?.table?.matrix ?? []).flat().map((cell) => String(cell ?? ''))
  const blanked = cells.includes('—') && !cells.some((cell) => /Infinit|NaN/.test(cell))
  console.log('explicit TOL keeps a collinearity table', r.code, tables.length, engineTol, pluginTol, engineTol || pluginTol, blanked)
}

// D8: /STATISTICS=ALL carries TOL, so an ALL run that crashes has to be retried
// with ALL removed too — stripping the word TOL alone leaves ALL behind and the
// retry fails exactly like the run it was rescuing. Five ALL runs, five sets of
// tables; the table list never comes back empty.
let allShort = 0
for (let attempt = 0; attempt < 5; attempt += 1) {
  const run = await call('POST', `${base}/api/run`, {
    sessionId: sid,
    syntax: 'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=ALL.',
  })
  const tables = (run.json().result?.items ?? []).filter((item) => item.kind === 'table')
  if (tables.length < 3) allShort += 1
}
console.log('regression ALL always has tables', 5, allShort)

// A logistic run tells the output which ROC it could offer; the hint has to ride
// on the items or the panel has nothing to pre-fill the dialog with.
r = await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'COMPUTE y = score > 70.\nEXECUTE.', persist: true })
r = await call('POST', `${base}/api/run`, {
  sessionId: sid,
  syntax: 'LOGISTIC REGRESSION y WITH score /PRINT=SUMMARY.',
  roc: { by: 'y', variables: ['score'] },
})
{
  const items = (r.json().result?.items ?? []).filter((item) => item.kind === 'table')
  const hinted = items.filter((item) => item.roc && item.roc.by === 'y' && item.roc.variables?.[0] === 'score')
  console.log('logistic result carries a ROC hint', r.code, items.length, hinted.length)
  // Four cases where the outcome is just "score > 70" separate perfectly: the
  // standard error explodes and the table has to say why, or the number reads as
  // a bug. (A merely large intercept must not trigger this — see test/regression.mjs.)
  const equation = items.find((item) => /Variables in the Equation/i.test(String(item.title)))
  const separationNotes = (equation?.notes ?? []).filter((note) => /分离/.test(String(note)))
  console.log('separation is explained in the table notes', separationNotes.length === 1, JSON.stringify(equation?.notes ?? []))
}

// The engine crashes about one run in six when asked for TOL, so the panel and
// the agent never send it: tolerance/VIF come back as a table the plugin
// computes. Ten consecutive default runs must all produce output.
let regressRuns = 0
let regressShort = 0
let collinearityOk = 0
for (let attempt = 0; attempt < 10; attempt += 1) {
  const run = await call('POST', `${base}/api/run`, {
    sessionId: sid,
    syntax: 'REGRESSION /DEPENDENT=score /METHOD=ENTER age /STATISTICS=COEFF R ANOVA CI.',
    regression: { dependent: 'score', independents: ['age'] },
  })
  const items = run.json().result?.items ?? []
  regressRuns += 1
  if (items.filter((item) => item.kind === 'table').length < 3) regressShort += 1
  const table = items.find((item) => /共线性/.test(item.title))
  if (table?.table?.matrix?.[1]?.[1] === '1.000') collinearityOk += 1
}
console.log('regression without TOL always has tables', regressRuns, regressShort, collinearityOk)
r = await call('POST', `${base}/api/run`, {
  sessionId: sid,
  syntax: 'REGRESSION /DEPENDENT=nosuchvar /METHOD=ENTER age.',
})
console.log('regression on a missing variable fails loudly', r.code, /没有产出任何表|nosuchvar/.test(String(r.json().error ?? '')))

// "Export the last output" has to find the tables that never came from an
// engine run: table 1 and the pairwise table carry a batchId, not a runId.
r = await call('GET', `${base}/api/state?sessionId=${sid}&cwd=${encodeURIComponent(home)}`)
const allItems = r.json().result?.items ?? r.json().state?.items ?? []
const newestBatch = Math.max(...allItems.map((item) => Number(item.batchId) || 0))
const inBatch = allItems.filter((item) => Number(item.batchId) === newestBatch)
console.log('batch stamping', allItems.length > 0, newestBatch > 0, inBatch.length, inBatch[0]?.title?.includes('两两比较') || inBatch[0]?.title?.includes('表'))
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'batch.xlsx'), scope: 'last' })
console.log('export last keeps the batch', r.code, r.json().result?.tables === inBatch.filter((item) => item.kind === 'table').length)

// merge: the file saved above is a second copy of the same shape
r = await call('POST', `${base}/api/save`, { sessionId: sid, path: join(home, 'extra.sav') })
r = await call('POST', `${base}/api/merge`, { sessionId: sid, kind: 'add', path: join(home, 'extra.sav') })
console.log('merge add', r.code, 'cases', r.json().result?.cases, 'vars', r.json().result?.variables)
r = await call('POST', `${base}/api/merge`, { sessionId: sid, kind: 'add', path: join(home, 'missing.sav') })
console.log('merge missing file', r.code, /no such file|ENOENT/i.test(String(r.json().error)))
// A persist run right after a merge used to look like it added the cases twice:
// the CSV the writer stages for SAVE OUTFILE must be truncated, not appended to.
const mergedCases = (await call('GET', `${base}/api/state?sessionId=${sid}`)).json().state.dataset.caseCount
r = await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'COMPUTE merged_flag = 1.\nEXECUTE.', persist: true })
const afterPersist = (await call('GET', `${base}/api/state?sessionId=${sid}`)).json().state.dataset.caseCount
console.log('merge then persist keeps the case count', afterPersist === mergedCases, mergedCases, afterPersist)

// printable output follows the most recent run
r = await call('POST', `${base}/api/exportDoc`, { sessionId: sid, path: join(home, 'report.pdf'), format: 'pdf' })
const doc = r.json().result
const docHead = await readFile(join(home, 'report.pdf'))
console.log('export pdf', r.code, docHead.subarray(0, 5).toString(), doc?.bytes > 500, doc?.path?.endsWith('.pdf'))
// .spv is an SPSS output archive: a zip, so the first bytes are PK\x03\x04.
// The export replays the last run, and only a run that produced a table gives
// the archive anything to hold, so run one first.
await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'FREQUENCIES /VARIABLES=score.' })
r = await call('POST', `${base}/api/exportDoc`, { sessionId: sid, path: join(home, 'report.spv') })
const spv = r.json().result
const spvHead = await readFile(join(home, 'report.spv'))
console.log('export spv', r.code, spvHead.subarray(0, 2).toString(), spvHead.subarray(0, 4).toString('hex'), spvHead.includes('lightTableData.bin'), spv?.format === 'spv', spv?.bytes > 500, spv?.path?.endsWith('.spv'))
// A run without a table would export a shell SPSS opens as empty: refuse it.
await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'COMPUTE rowid = 1.\nEXECUTE.' })
r = await call('POST', `${base}/api/exportDoc`, { sessionId: sid, path: join(home, 'shell.spv') })
console.log('export spv without tables', r.code, /空的 \.spv/.test(String(r.json().error)))
r = await call('POST', `${base}/api/exportDoc`, { sessionId: sid, path: join(home, 'report.zzz'), format: 'pdf' })
console.log('export bad ext', r.code, /只能是/.test(String(r.json().error)))
// one table written straight to a chosen path
r = await call('POST', `${base}/api/writeText`, { sessionId: sid, path: join(home, 'one-table.csv'), text: 'a,b\n1,2\n' })
const oneTable = r.json().result
console.log('write table csv', r.code, oneTable?.bytes === 8, oneTable?.path?.endsWith('one-table.csv'))

// undo/redo: a cell edit and a structural change both have to come back
r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 3 })
const firstScore = r.json().page.rows[0][r.json().page.columns.indexOf('score')]
r = await call('POST', `${base}/api/cell`, { sessionId: sid, row: 0, variable: 'score', value: 11 })
console.log('undo after cell', r.code, r.json().state.history.undo > 0, r.json().state.history.undoLabel)
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'undo' })
const afterUndo = r.json().state
r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 3 })
console.log('undo restores cell', r.json().page.rows[0][r.json().page.columns.indexOf('score')] === firstScore, 'redo available', afterUndo.history.redo === 1)
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'redo' })
r = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 3 })
console.log('redo reapplies cell', r.json().page.rows[0][r.json().page.columns.indexOf('score')] === 11)

const before = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 200 })
const beforeCount = before.json().page.total
r = await call('POST', `${base}/api/case`, { sessionId: sid, action: 'append', values: {} })
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'undo' })
const undone = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 200 })
console.log('undo removes case', undone.json().page.total === beforeCount, r.json().state.history.undoLabel ?? '')
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'redo' })
const redone = await call('POST', `${base}/api/rows`, { sessionId: sid, offset: 0, limit: 200 })
console.log('redo restores case', redone.json().page.total === beforeCount + 1)
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'undo' })

// find / replace
r = await call('POST', `${base}/api/find`, { sessionId: sid, query: 'F', options: { column: 'gender' } })
console.log('find', r.code, r.json().result?.total)
r = await call('POST', `${base}/api/replace`, { sessionId: sid, find: 'F', replace: '女', options: { column: 'gender', whole: true } })
console.log('replace', r.code, 'replaced', r.json().result?.replaced)
r = await call('POST', `${base}/api/find`, { sessionId: sid, query: '女', options: { column: 'gender' } })
console.log('find after replace', r.code, r.json().result?.total)
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'undo' })
console.log('undo replace', r.code, r.json().state.history.redo === 1)

// pspp-convert through the bundled tool
r = await call('POST', `${base}/api/convert`, { sessionId: sid, path: join(home, 'converted.csv') })
const converted = r.json().result
console.log('convert csv', r.code, converted?.bytes > 0, converted?.format)
const convertedText = await readFile(join(home, 'converted.csv'), 'utf8')
console.log('convert csv header', convertedText.split('\n')[0].includes('gender'))
r = await call('POST', `${base}/api/convert`, { sessionId: sid, path: join(home, 'converted.zzz') })
console.log('convert bad ext', r.code, /转换失败/.test(String(r.json().error)))

// a dropped file is stored in the workspace and then opened normally
const dropped = Buffer.from('name,age\nA,1\nB,2\n')
r = await call('POST', `${base}/api/upload`, { sessionId: sid, name: 'dropped.csv', data: dropped.toString('base64') })
const stored = r.json().result
console.log('upload', r.code, stored?.bytes === dropped.length)
r = await call('POST', `${base}/api/upload`, { sessionId: sid, name: 'bad.exe', data: dropped.toString('base64') })
console.log('upload bad ext', r.code, /不支持/.test(String(r.json().error)))
r = await call('POST', `${base}/api/open`, { sessionId: sid, path: stored?.path })
console.log('open dropped', r.code, r.json().result?.caseCount)
// The copy keeps its own name (no timestamp prefix) and is flagged temporary,
// so "save" cannot silently overwrite the workspace copy.
console.log('upload kept name', String(stored?.path).endsWith('/uploads/dropped.csv') === true)
console.log('dropped is temporary', r.json().state?.dataset?.temporary === true)
r = await call('POST', `${base}/api/save`, { sessionId: sid })
console.log('save copy refused', r.code, /拖入的文件副本/.test(String(r.json().error)))

// value labels imported in bulk: one call, stored on the variable, engine wins
// The dropped CSV is the dataset on screen here, so label one of its variables.
r = await call('POST', `${base}/api/valuelabels`, { sessionId: sid, name: 'name', labels: { A: '甲', B: '乙' } })
const labelled = (r.json().state?.dataset?.variables ?? []).find((variable) => variable.name === 'name')
console.log('value labels assigned', r.code, labelled?.valueLabels?.A === '甲' && labelled?.valueLabels?.B === '乙')

// and the file reader the importer uses
const labelFile = join(home, 'labels.csv')
await writeFile(labelFile, '1,男\n2,女', 'utf8')
r = await call('POST', `${base}/api/readFile`, { path: labelFile })
console.log('label file read', r.code, r.json().result?.text === '1,男\n2,女')

// two documents side by side: `<session>~<n>` is an independent workspace
const sid2 = `${sid}~2`
r = await call('POST', `${base}/api/open`, { sessionId: sid2, path: join(home, 'demo.sav') })
console.log('doc2 open', r.code, r.json().result?.caseCount > 0)
const doc2 = await call('GET', `${base}/api/state?sessionId=${encodeURIComponent(sid2)}`)
const doc1 = await call('GET', `${base}/api/state?sessionId=${encodeURIComponent(sid)}`)
console.log('doc2 has data', doc2.code, doc2.json().state.dataset?.caseCount > 0)
// A temporary copy reports no sourcePath by design, so check name + flag.
console.log('doc1 kept its own', doc1.code, doc1.json().state.dataset?.name === 'dropped.csv' && doc1.json().state.dataset?.temporary === true)
// the panel reports the tab on screen; tools follow it
r = await call('POST', `${base}/api/active`, { sessionId: sid, docId: sid2 })
console.log('active tab', r.code, r.json().result?.active === sid2)
r = await call('POST', `${base}/api/active`, { sessionId: sid, docId: sid })
console.log('active back', r.code, r.json().result?.active === sid)

// The left column's global panel inherits no Session: it asks what is open and
// adopts the most recently used one, so it shows the data the conversation
// beside it is working on instead of an empty document.
r = await call('GET', `${base}/api/workspaces`)
const workspaces = r.json().result?.workspaces ?? []
const ordered = workspaces.every((row, index) => index === 0 || workspaces[index - 1].lastUsedAt >= row.lastUsedAt)
console.log('workspaces listed', r.code, workspaces.length >= 2)
console.log('   newest first', ordered, workspaces.every((row) => typeof row.name === 'string' && row.caseCount > 0))
// The registry sanitises the tab id (`~` becomes `_`), so compare prefixes.
const peers = workspaces.filter((row) => String(row.docId).startsWith(sid)).length >= 2
console.log('   peers listed', peers)
// The panel adopts workspaces[0], so an empty or wrongly ordered list is a
// silent return to the empty document it was fixed for.
if (workspaces.length < 2 || !ordered || !peers) throw new Error('api/workspaces must list the open datasets, newest first')

// `?limit=` is what keeps days-old machines honest: twenty rows by default, and
// the answer has to say whether it cut something.
r = await call('GET', `${base}/api/workspaces?limit=1`)
const one = r.json().result ?? {}
console.log('workspaces limited', r.code, (one.workspaces ?? []).length === 1, one.total >= 2, one.truncated === true)
if ((one.workspaces ?? []).length !== 1 || one.truncated !== true || !(one.total >= 2)) throw new Error('api/workspaces?limit=1 must return one row and say it was cut')
r = await call('GET', `${base}/api/workspaces?limit=abc`)
console.log('   a bad limit falls back to the default', r.code, (r.json().result?.workspaces ?? []).length >= 2, r.json().result?.limit === 20)

// A dataset whose rows were released (idle sweep) still lives on disk, and the
// launcher has to keep offering it: listing only resident workspaces made
// datasets vanish from the panel after a quiet half hour.
const otherId = workspaces.map((row) => row.docId).find((id) => id !== sid)
await registry.get(otherId).release()
const released = (await registry.recent()).find((row) => row.docId === otherId)
console.log('released still listed', Boolean(released), released?.released === true, released?.caseCount > 0)

// Two windows can hold one workspace (the left launcher and a Session's tab name
// the same docId). Each writes under its own name so the other can be told its
// grid is stale instead of silently overwriting it.
const writerA = 'panel-aaa'
const writerB = 'panel-bbb'
const wsid = 'writer-session'
await call('POST', `${base}/api/new`, { sessionId: wsid, cwd: home, writer: writerA, variables: [{ name: 'x', type: 'numeric' }] })
await call('POST', `${base}/api/case`, { sessionId: wsid, writer: writerA, values: { x: 1 } })
r = await call('POST', `${base}/api/cell`, { sessionId: wsid, writer: writerA, row: 0, variable: 'x', value: 7 })
const afterA = r.json().state
r = await call('POST', `${base}/api/cell`, { sessionId: wsid, writer: writerB, row: 0, variable: 'x', value: 9 })
const afterB = r.json().state
console.log('writer recorded', afterA.lastWriter === writerA, afterA.revision > 0)
console.log('writer switches', afterB.lastWriter === writerB, afterB.revision > afterA.revision)
if (afterA.lastWriter !== writerA || afterB.lastWriter !== writerB || !(afterB.revision > afterA.revision)) {
  throw new Error('state must name the writer of the last change')
}

// A write from a client that does not name itself is a tool call, not "the
// previous panel": the panel must be able to tell those apart.
r = await call('POST', `${base}/api/cell`, { sessionId: wsid, row: 0, variable: 'x', value: 11 })
const toolWrite = r.json().state
console.log('tool write has no owner', toolWrite.lastWriter === null, toolWrite.revision > afterB.revision)
if (toolWrite.lastWriter !== null) throw new Error('a write with no writer must not inherit the previous one')

// Optimistic concurrency: the panel sends the revision it was looking at, so a
// stale write is refused instead of quietly replacing somebody else's numbers.
const staleRevision = toolWrite.revision
await call('POST', `${base}/api/cell`, { sessionId: wsid, writer: writerB, row: 0, variable: 'x', value: 13 })
r = await call('POST', `${base}/api/cell`, { sessionId: wsid, writer: writerA, row: 0, variable: 'x', value: 99, baseRevision: staleRevision })
const refused = r.json()
console.log('stale write refused', r.code, refused.ok === false, refused.conflict?.actual === staleRevision + 1)
console.log('   winner kept', refused.state?.dataset?.caseCount >= 1)
if (r.code !== 409 || refused.conflict?.expected !== staleRevision || refused.conflict?.actual !== staleRevision + 1) {
  throw new Error('a write on top of an unread revision must come back as 409 with both revisions')
}
const kept = refused.state
r = await call('POST', `${base}/api/rows`, { sessionId: wsid, start: 0, count: 5 })
// The refused write is not just announced: it is kept, so hours later the
// question "did anything try to overwrite my data?" still has an answer.
console.log('   conflict kept', refused.state?.conflictCount === 1, refused.state?.lastConflict?.route === 'api/cell')
if (refused.state?.conflictCount !== 1) throw new Error('a refused write must be recorded on the workspace')
if (refused.state?.lastConflict?.expected !== staleRevision) throw new Error('the record must keep both revisions')
if (refused.state?.lastConflict?.route !== 'api/cell') throw new Error('the record must say which route was refused')
// Kept on disk, not only in memory: the panel is closed by the time anyone
// asks, and a restart must not erase the fact that a write was refused.
{
  const meta = JSON.parse(await readFile(join(home, 'analytics', wsid, 'dataset.json'), 'utf8'))
  const kept1 = Array.isArray(meta.conflicts) && meta.conflicts.length === 1
  console.log('   conflict survived to dataset.json', kept1, meta.conflicts?.[0]?.route)
  if (!kept1) throw new Error('a refused write must be written to dataset.json')
}
console.log('   value not overwritten', r.json().page.rows[0]?.[0] === 13, kept?.lastWriter === writerB)
if (r.json().page.rows[0]?.[0] !== 13) throw new Error('the refused write must not reach the data')
// The same write with the current revision goes through, and an explicit force
// is still allowed for a panel that has already asked the user.
r = await call('POST', `${base}/api/cell`, { sessionId: wsid, writer: writerA, row: 0, variable: 'x', value: 21, baseRevision: staleRevision + 1 })
console.log('fresh write accepted', r.code, r.json().state?.lastWriter === writerA)
if (r.code !== 200) throw new Error('a write carrying the current revision must be accepted')
r = await call('POST', `${base}/api/cell`, { sessionId: wsid, writer: writerA, row: 0, variable: 'x', value: 22, baseRevision: 0, force: true })
console.log('forced write accepted', r.code, r.json().state?.lastWriter === writerA)
if (r.code !== 200) throw new Error('force must bypass the revision check')
console.log('ok  a write on top of a revision this window has not read is refused, and force still bypasses it')

r = await call('POST', `${base}/api/close`, { sessionId: sid2 })
console.log('doc2 closed', r.code, r.json().state.dataset === null)

// Word/Excel export goes through the same handler the panel uses
// The session has no dataset at this point (the document switch above), so the
// export runs on the table output produced here.
r = await call('POST', `${base}/api/open`, { sessionId: sid, path: join(home, 'demo.sav') })
r = await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'DESCRIPTIVES /VARIABLES=score.\nCORRELATIONS /VARIABLES=score age.' })
console.log('   run items', r.code, r.json().result?.items?.length)
const docxPath = join(home, 'report.docx')
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: docxPath })
const docx = r.json().result
console.log('export docx', r.code, docx?.format === 'docx' && docx.tables >= 2 && docx.bytes > 1000)
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'report.xlsx') })
console.log('export xlsx', r.code, r.json().result?.format === 'xlsx')
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'report.pdf') })
console.log('export office bad ext', r.code, /docx 或 .xlsx/.test(String(r.json().error)))
// scope "last" is what a user means by "export this output"; "session" is the
// default and keeps exporting everything, so both must stay reachable.
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'last.xlsx'), scope: 'last' })
console.log('export office last scope', r.code, r.json().result?.format === 'xlsx', r.json().result?.tables >= 1)

// Excel formulas are on by default and can be turned off; a REGRESSION export
// links the Coefficients sheet to the residual df that lives in ANOVA, so both
// sheets have to come out of one export.
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'plain.xlsx'), formulas: false })
const plainBytes = await readFile(join(home, 'plain.xlsx'), 'latin1')
console.log('export office without formulas', r.code, !plainBytes.includes('<f>'))
r = await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'REGRESSION /DEPENDENT=score /METHOD=ENTER age cohort.' })
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'sw.xlsx'), scope: 'last' })
const linkedBytes = await readFile(join(home, 'sw.xlsx'), 'latin1')
console.log('export office cross-sheet formula', r.code, linkedBytes.includes('_xlfn.F.DIST.RT'), linkedBytes.includes("'ANOVA ("))
// The hidden data sheet is opt-in: the same export gets one extra hidden sheet
// only when asked, so a report with sensitive cases stays clean by default.
r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'data.xlsx'), data: true })
const dataBytes = await readFile(join(home, 'data.xlsx'), 'latin1')
const defaultBytes = await readFile(join(home, 'sw.xlsx'), 'latin1')
console.log('export office data sheet', r.code, dataBytes.includes('state="hidden"'), !defaultBytes.includes('state="hidden"'))
// The panel's "export this table" button sends an id, not the entry itself.
const stateItems = (await call('GET', `${base}/api/state?sessionId=${sid}`)).json().state?.items ?? []
const exportTarget = stateItems.find((entry) => entry.kind === 'table')
if (exportTarget) {
  r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'one.xlsx'), items: [exportTarget.id] })
  const oneBytes = await readFile(join(home, 'one.xlsx'), 'latin1')
  console.log('export office one table by id', r.code, r.json().result?.tables === 1, oneBytes.length > 1000)
  r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'gone.xlsx'), items: ['run-999-0'] })
  console.log('export office unknown id fails loudly', r.code === 400, /已经不在了/.test(String(r.json().error)))
  // A path that runs *through* an existing file: the message has to name the
  // file, otherwise the user has no idea which segment to change.
  await writeFile(join(home, 'blocker.csv'), 'a,b\n1,2\n')
  r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'blocker.csv', 'deep', 'out.xlsx') })
  const blockerMessage = String(r.json().error)
  console.log('export office names the blocking file', r.code === 400, /blocker\.csv 是一个文件/.test(blockerMessage))
}
// A chart is an output entry too: exporting only it must not drag a table in.
const imageTarget = stateItems.find((entry) => entry.kind === 'image')
if (imageTarget) {
  r = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'only-chart.docx'), items: [imageTarget.id] })
  const chartDoc = await readFile(join(home, 'only-chart.docx'), 'latin1')
  const unpacked = await call('POST', `${base}/api/exportOffice`, { sessionId: sid, path: join(home, 'only-chart.xlsx'), items: [imageTarget.id] })
  const chartSheet = await readFile(join(home, 'only-chart.xlsx'), 'latin1')
  console.log('export office one chart by id',
    r.code, r.json().result?.tables === 0, r.json().result?.images === 1,
    chartDoc.includes('<wp:inline') && !chartDoc.includes('<wp:anchor'),
    unpacked.code, chartSheet.includes('oneCellAnchor'))
}

// The report card replays the syntax of the ticked results.
r = await call('GET', `${base}/api/report?sessionId=${sid}`)
const entries = r.json().entries ?? []
console.log('report entries', r.code, entries.length >= 2 && entries.every((entry) => typeof entry.title === 'string'))
const replay = await call('POST', `${base}/api/run`, { sessionId: sid, syntax: 'FREQUENCIES /VARIABLES=score.' })
const replayItem = (replay.json().result?.items ?? [])[0]
console.log('report script skips save', replayItem?.script?.includes('FREQUENCIES /VARIABLES=score')
  && !/^\s*SAVE\b/m.test(replayItem.script))
r = await call('POST', `${base}/api/exportReport`, { sessionId: sid, path: join(home, 'card.pdf'), format: 'pdf', script: replayItem?.script })
console.log('export report', r.code, r.json().result?.format === 'pdf' && r.json().result?.bytes > 1000)
r = await call('POST', `${base}/api/exportReport`, { sessionId: sid, path: join(home, 'card.pdf'), format: 'pdf', script: '   ' })
console.log('export report refuses an empty card', r.code, /勾选/.test(String(r.json().error)))

// The bound report assembles the tables that already exist; nothing is replayed.
const bookItem = (replay.json().result?.items ?? [])[0]
r = await call('POST', `${base}/api/reportBook`, {
  sessionId: sid, path: join(home, 'book.docx'), items: [bookItem.id], title: '结果', subtitle: '第 4 章',
})
const book = r.json().result ?? {}
console.log('report book docx', r.code, book.tables, book.figures, book.bytes > 4000)
const bookBuffer = await readFile(join(home, 'book.docx'))
console.log('report book is a docx package', bookBuffer.length > 4000, bookBuffer.slice(0, 2).toString('latin1') === 'PK')
r = await call('POST', `${base}/api/reportBook`, { sessionId: sid, path: join(home, 'book.html'), items: [bookItem.id] })
const bookHtml = await readFile(join(home, 'book.html'), 'utf8')
console.log('report book html', r.code, /目录/.test(bookHtml) && /表 1/.test(bookHtml))
r = await call('POST', `${base}/api/reportBook`, { sessionId: sid, path: join(home, 'book.pdf'), items: [bookItem.id] })
console.log('report book refuses pdf', r.code, /docx|html/.test(String(r.json().error)))
r = await call('POST', `${base}/api/reportBook`, { sessionId: sid, path: join(home, 'book.docx'), items: ['nope'] })
console.log('report book refuses a stale id', r.code, /不在输出树|刷新面板/.test(String(r.json().error)))
r = await call('POST', `${base}/api/reportBook`, { sessionId: sid, path: join(home, 'book.docx'), items: [] })
console.log('report book refuses an empty selection', r.code, /勾选/.test(String(r.json().error)))

// syntax files come back byte for byte
const spsOut = join(home, 'saved', 'work.sps')
r = await call('POST', `${base}/api/saveSyntax`, { sessionId: sid, path: spsOut, text: 'FREQUENCIES /VARIABLES=score.' })
const written = await readFile(spsOut, 'utf8')
console.log('save syntax', r.code, written === 'FREQUENCIES /VARIABLES=score.\n')
r = await call('POST', `${base}/api/saveSyntax`, { sessionId: sid, path: join(home, 'x.txt'), text: 'x' })
console.log('save syntax bad ext', r.code, /\.sps/.test(String(r.json().error)))

// Text writes and reads from the browser half are limited to document
// extensions: a same-origin page must not be able to overwrite ~/.bashrc or
// read a credentials file through this plugin's endpoints.
r = await call('POST', `${base}/api/writeText`, { sessionId: sid, path: join(home, 'evil.sh'), text: '#!/bin/sh\n' })
console.log('writeText refuses a script', r.code, r.code === 400 && /\.sh/.test(String(r.json().error)))
const hiddenTarget = join(home, '.bashrc')
r = await call('POST', `${base}/api/writeText`, { sessionId: sid, path: hiddenTarget, text: 'x' })
console.log('writeText refuses a dotfile', r.code, r.code === 400)
r = await call('POST', `${base}/api/readFile`, { sessionId: sid, path: join(home, 'not-text.sav') })
console.log('readFile refuses a binary extension', r.code, r.code === 400)
r = await call('POST', `${base}/api/readFile`, { sessionId: sid, path: home })
console.log('readFile refuses a directory', r.code, r.code === 400 && /普通文件/.test(String(r.json().error)))

// Path whitelist (lib/paths.js): the panel is reachable over HTTP, so "the user
// typed this path" is not a boundary. Every reader and writer must answer the
// same way, and the credential directory must be refused even though home is an
// allowed root.
r = await call('POST', `${base}/api/readFile`, { sessionId: sid, path: join(homedir(), '.ssh', 'id_rsa') })
console.log('readFile refuses the credential directory', r.code, r.code === 400 && /不读写这个目录/.test(String(r.json().error)))
r = await call('POST', `${base}/api/readFile`, { sessionId: sid, path: join(homedir(), '.dsh', '.credentials.yaml') })
console.log('readFile refuses the dsh credential store', r.code, r.code === 400 && /不读写这个目录/.test(String(r.json().error)))
r = await call('POST', `${base}/api/readFile`, { sessionId: sid, path: '/etc/passwd' })
console.log('readFile refuses a path outside the roots', r.code, r.code === 400 && /允许的目录/.test(String(r.json().error)))
r = await call('POST', `${base}/api/writeText`, { sessionId: sid, path: join(homedir(), '.dsh', 'x.csv'), text: 'a' })
console.log('writeText refuses the dsh directory', r.code, r.code === 400 && /不读写这个目录/.test(String(r.json().error)))
r = await call('GET', `${base}/api/dir?sessionId=${sid}&path=${encodeURIComponent('/etc')}`)
console.log('api/dir refuses a directory outside the roots', r.code, r.code === 400 && /允许的目录/.test(String(r.json().error)))
r = await call('GET', `${base}/api/dir?sessionId=${sid}&path=${encodeURIComponent(join(homedir(), '.ssh'))}`)
console.log('api/dir refuses the credential directory', r.code, r.code === 400 && /不读写这个目录/.test(String(r.json().error)))
r = await call('GET', `${base}/api/dir?sessionId=${sid}&path=${encodeURIComponent(home)}`)
console.log('api/dir still lists an allowed directory', r.code, r.code === 200)

// Settings: a file the panel can read and write, with `registerTools` marked as
// the one knob that stays in the profile patch.
r = await call('GET', `${base}/api/settings`)
let settingsBody = r.json()
console.log('settings default', r.code, settingsBody.settings.maxRows === 200000, settingsBody.deploymentOnly.registerTools.value === false, settingsBody.exists === false)
r = await call('POST', `${base}/api/settings`, { patch: { maxRows: 5000, tableStyle: 'grid' } })
settingsBody = r.json()
console.log('settings saved', r.code, settingsBody.settings.maxRows === 5000, settingsBody.settings.tableStyle === 'grid')
const reread = JSON.parse(await readFile(join(home, 'analytics', 'settings.json'), 'utf8'))
console.log('settings on disk', reread.maxRows === 5000)
// The panel draws every output table from the style it reads back with the
// state; if the setting never reaches api/state the knob is dead weight.
r = await call('GET', `${base}/api/state?sessionId=style01&cwd=${encodeURIComponent(home)}`)
console.log('state carries the table style', r.code, r.json().state.tableStyle === 'grid')
// The HTML export runs in the browser, so the cap has to travel with the state
// too — otherwise that one file ignores a knob the other two honour.
console.log('state carries the export cap', r.code, r.json().state.maxExportRows === 2000)
r = await call('POST', `${base}/api/settings`, { patch: { maxRows: 10 } })
console.log('settings refuses a bad value', r.code, /maxRows 必须在/.test(String(r.json().error)))
r = await call('POST', `${base}/api/settings`, { patch: { tableStyle: 'fancy' } })
console.log('settings refuses an unknown style', r.code === 400)

// The English panel needs the dictionary from the host, and the failure text it
// shows has to be in the same language as the rest of the panel.
r = await call('GET', `${base}/api/locale?lang=en`)
let localeBody = r.json()
console.log('api/locale serves the english dictionary', r.code, localeBody.locale === 'en', Object.keys(localeBody.strings ?? {}).length > 500)
r = await call('GET', `${base}/api/locale`)
console.log('api/locale defaults to chinese with an empty dictionary', r.code, r.json().locale === 'zh', Object.keys(r.json().strings ?? {}).length === 0)
r = await call('POST', `${base}/api/settings`, { patch: { uiLanguage: 'en' } })
console.log('settings accepts the language', r.code, r.json().settings.uiLanguage === 'en')
r = await call('GET', `${base}/api/state?sessionId=locale01&cwd=${encodeURIComponent(home)}`)
console.log('state carries the language', r.code, r.json().state.locale === 'en')
r = await call('POST', `${base}/api/settings`, { patch: { maxRows: 10 } })
const englishError = String(r.json().error ?? '')
console.log('the error text follows the language', r.code === 400, !/[\u4e00-\u9fff]/.test(englishError), englishError.length > 0)
r = await call('POST', `${base}/api/settings`, { patch: { uiLanguage: 'zh' } })
console.log('settings accepts the language back', r.code, r.json().settings.uiLanguage === 'zh')

// Data > Restructure runs inside the plugin: PSPP 2.1.3 has neither
// CASESTOVARS nor VARSTOCASES, so both directions are matrix work on the host.
const seed = async (id, rows) => {
  let res = await call('POST', `${base}/api/new`, { sessionId: id, cwd: home, variables: [
    { name: 'g', type: 'string', label: '组' },
    { name: 'wave', type: 'numeric', label: '轮次' },
    { name: 'score', type: 'numeric', label: '得分' },
  ] })
  for (const values of rows) res = await call('POST', `${base}/api/case`, { sessionId: id, values })
  return res
}
const base4 = [
  { g: 'M', wave: 1, score: 70 }, { g: 'M', wave: 2, score: 80 },
  { g: 'F', wave: 1, score: 60 }, { g: 'F', wave: 2, score: 90 },
]
await seed('pivot01', base4)
r = await call('POST', `${base}/api/restructure`, { sessionId: 'pivot01', kind: 'casesToVars', id: ['g'], index: 'wave', variables: ['score'] })
let pivot = r.json()
let pivotNames = (pivot.state?.dataset?.variables ?? []).map((variable) => variable.name)
console.log('casesToVars pivots the index into columns', r.code === 200,
  pivot.result?.cases === 2, pivot.result?.created === 2,
  pivotNames.includes('score_1') && pivotNames.includes('score_2'),
  pivot.state?.dataset?.caseCount === 2)

r = await call('POST', `${base}/api/restructure`, { sessionId: 'pivot01', kind: 'varsToCases', variables: ['score_1', 'score_2'], id: ['g'], target: 'score', indexName: 'wave', indexValues: 'numbers' })
pivot = r.json()
pivotNames = (pivot.state?.dataset?.variables ?? []).map((variable) => variable.name)
console.log('varsToCases stacks the wide columns back to long', r.code === 200,
  pivot.result?.cases === 4, pivotNames.join(',') === 'g,score,wave',
  pivot.state?.dataset?.caseCount === 4)

// A repeated (identifier, index) pair keeps the first value and says how many
// it dropped; silently overwriting would lose a case nobody could find again.
await seed('pivot02', [...base4, { g: 'M', wave: 1, score: 999 }])
r = await call('POST', `${base}/api/restructure`, { sessionId: 'pivot02', kind: 'casesToVars', id: ['g'], index: 'wave', variables: ['score'] })
console.log('a duplicated identifier+index is counted, not silently overwritten', r.code === 200, r.json().result?.duplicates === 1, r.json().result?.cases === 2)

// Mixed types cannot be stacked without deciding what the column means, so the
// host has to refuse and name the variable that does not fit.
r = await call('POST', `${base}/api/restructure`, { sessionId: 'pivot02', kind: 'varsToCases', variables: ['score_1', 'g'], id: [], target: 'v', indexName: 'idx' })
console.log('varsToCases refuses mixed types with a readable error', r.code === 400, /类型一致/.test(String(r.json().error)))

// An unknown variable in a box is a typo, not a crash.
r = await call('POST', `${base}/api/restructure`, { sessionId: 'pivot02', kind: 'casesToVars', id: ['g'], index: 'nope', variables: ['score_1'] })
console.log('casesToVars names the variable it cannot find', r.code === 400, /没有这个变量/.test(String(r.json().error)))

// Missing-value analysis: PSPP has no MVA, so the host computes both tables
// from the same rows every other table uses. The declared code 999 must count
// as missing here exactly as it does in DESCRIPTIVES.
await seed('mva01', [
  { g: 'M', wave: 1, score: 70 }, { g: 'M', wave: 2, score: null },
  { g: 'F', wave: 1, score: 90 }, { g: 'F', wave: 2, score: 999 },
])
r = await call('POST', `${base}/api/missing`, { sessionId: 'mva01', variables: ['score'] })
let mva = r.json()
console.log('missing analysis returns both tables', r.code === 200, mva.result?.tables === 2, mva.result?.cases === 4)
let mvaTitles = (mva.state?.items ?? []).map((item) => item.title ?? item.table?.caption)
console.log('the tables reach the output panel', mvaTitles.includes('单变量统计量') && mvaTitles.includes('缺失模式'))
let univariate = (mva.state?.items ?? []).find((item) => (item.title ?? '') === '单变量统计量')
let univariateRow = (univariate?.table?.matrix ?? []).find((row) => row[0] === 'score') ?? []
console.log('a blank cell counts as missing, like every other table', univariateRow[6] === '1', univariateRow[1] === '3', JSON.stringify(univariateRow))

// Only one of the two tables can be asked for, and an unknown variable is named.
r = await call('POST', `${base}/api/missing`, { sessionId: 'mva01', variables: ['score'], patterns: false, univariate: true })
console.log('the table set can be narrowed', r.code === 200, r.json().result?.tables === 1)
r = await call('POST', `${base}/api/missing`, { sessionId: 'mva01', variables: ['nope'] })
console.log('an unknown variable is named, not crashed on', r.code === 400, /没有这些变量/.test(String(r.json().error)))

// Identify duplicate cases: the grouping is the plugin's own arithmetic, and
// the two indicator variables have to land in the grid as real columns.
await seed('dup01', [
  { id: 1, score: 10 }, { id: 2, score: 20 }, { id: 1, score: 10 }, { id: 1, score: 10 }, { id: 3, score: 30 },
])
r = await call('POST', `${base}/api/duplicates`, { sessionId: 'dup01', variables: ['id', 'score'], indicators: true })
let dup = r.json()
console.log('identify duplicates groups and counts them', r.code === 200, dup.result?.groups === 1, dup.result?.duplicates === 3)
let dupTitles = (dup.state?.items ?? []).map((item) => item.title ?? '')
console.log('the table reaches the output panel', dupTitles.includes('标识重复个案（插件计算）'))
let dupNames = (dup.state?.dataset?.variables ?? []).map((variable) => variable.name)
console.log('the indicator variables become real columns', dup.result?.created?.length === 2,
  dupNames.includes('dupSeq') && dupNames.includes('dupLast'), JSON.stringify(dupNames))
// The grid gets its rows from api/rows, so read them back the same way the panel does.
let dupPage = r.code === 200 ? (await call('POST', `${base}/api/rows`, { sessionId: 'dup01', offset: 0, limit: 500 })).json().page : { rows: [] }
let seqColumn = dupNames.indexOf('dupSeq')
let lastColumn = dupNames.indexOf('dupLast')
let seqValues = (dupPage.rows ?? []).slice(0, 5).map((row) => row[seqColumn])
let lastValues = (dupPage.rows ?? []).slice(0, 5).map((row) => row[lastColumn])
console.log('the sequence numbers match the groups', JSON.stringify(seqValues) === '[1,0,2,3,0]', JSON.stringify(seqValues))
console.log('exactly one row of the group is flagged as the last', lastValues.filter((value) => value === 1).length === 1, JSON.stringify(lastValues))
console.log('adding the indicators leaves the dataset dirty for saving', dup.state?.dataset?.dirty === true)

// Without the indicators it is a read-only report: no new columns, no undo step.
r = await call('POST', `${base}/api/duplicates`, { sessionId: 'dup01', variables: ['id'] })
let reportOnly = r.json()
console.log('a report-only run adds no columns', r.code === 200, (reportOnly.result?.created ?? []).length === 0,
  (reportOnly.state?.dataset?.variables ?? []).length === dupNames.length)

// Identify unusual cases: percentile bands, and the two indicator columns.
await seed('out01', [
  { g: 'M', wave: 1, score: 5 }, { g: 'M', wave: 2, score: 5 },
  { g: 'F', wave: 1, score: 5 }, { g: 'F', wave: 2, score: 5 },
  { g: 'M', wave: 1, score: 5 }, { g: 'M', wave: 2, score: 5 },
  { g: 'F', wave: 1, score: 100 }, { g: 'F', wave: 2, score: 5 },
])
r = await call('POST', `${base}/api/outliers`, { sessionId: 'out01', variables: ['score'], percentiles: [10, 90], indicators: true })
let outRes = r.json()
console.log('identify outliers flags the tail and reports the band', r.code === 200, outRes.result?.flagged === 1,
  outRes.result?.hits === 1, outRes.result?.lowPercent === 10)
let outTitles = (outRes.state?.items ?? []).map((item) => item.title ?? '')
console.log('both tables reach the output panel', outTitles.includes('标识异常个案：变量界值（插件计算）'),
  outTitles.includes('标识异常个案：越界的个案（插件计算）'))
let outNames = (outRes.state?.dataset?.variables ?? []).map((variable) => variable.name)
console.log('the indicator variables become real columns', (outRes.result?.created ?? []).length === 2,
  outNames.includes('outlier') && outNames.includes('outlierN'), JSON.stringify(outNames))
let outPage = r.code === 200 ? (await call('POST', `${base}/api/rows`, { sessionId: 'out01', offset: 0, limit: 500 })).json().page : { rows: [] }
let anyColumn = outNames.indexOf('outlier')
let countColumn = outNames.indexOf('outlierN')
let anyValues = (outPage.rows ?? []).map((row) => row[anyColumn])
let countValues = (outPage.rows ?? []).map((row) => row[countColumn])
console.log('exactly the seventh case is flagged', JSON.stringify(anyValues) === '[0,0,0,0,0,0,1,0]', JSON.stringify(anyValues))
console.log('its count column says how many variables it is out on', countValues[6] === 1, JSON.stringify(countValues))

// Report only: no columns, and the dataset stays as clean as it was.
r = await call('POST', `${base}/api/outliers`, { sessionId: 'out01', variables: ['score'] })
let outReport = r.json()
console.log('a report-only run adds no columns', r.code === 200, (outReport.result?.created ?? []).length === 0,
  (outReport.state?.dataset?.variables ?? []).length === outNames.length)
// A string variable has no percentile band; the table says so instead of printing NaN.
r = await call('POST', `${base}/api/outliers`, { sessionId: 'out01', variables: ['g'] })
let outString = r.json()
// The session already holds earlier runs, so read the table this call appended.
let outSummary = (outString.state?.items ?? []).filter((item) => (item.title ?? '') === '标识异常个案：变量界值（插件计算）').at(-1)
let outBoundRow = (outSummary?.table?.matrix ?? []).find((row) => row[0] === '组') ?? []
console.log('a string variable is reported as unbounded, not as NaN', r.code === 200, outBoundRow[2] === '·',
  (outSummary?.table?.notes ?? []).some((note) => note.includes('没有计算界值')), JSON.stringify(outBoundRow))

// Replacing: the fill is one undo step and it reaches the grid's rows.
r = await call('POST', `${base}/api/missing`, { sessionId: 'mva01', mode: 'replace', variables: ['score'], method: 'linear' })
let fill = r.json()
let filledRow = (fill.state?.dataset?.variables ?? []).find((variable) => variable.name === 'score')
// 999 was never declared a missing code here, so it is data: only the blank goes.
console.log('replace missing values fills and reports the count', r.code === 200, fill.result?.filled === 1,
  fill.state?.dataset?.dirty === true, filledRow?.name === 'score')

// The nearby methods take a span from the request and report the method back.
await seed('rmv02', [
  { g: 'M', wave: 1, score: null }, { g: 'M', wave: 1, score: 1 },
  { g: 'M', wave: 1, score: null }, { g: 'M', wave: 1, score: 2 },
  { g: 'M', wave: 1, score: null }, { g: 'M', wave: 1, score: 100 },
  { g: 'M', wave: 1, score: null },
])
r = await call('POST', `${base}/api/missing`, { sessionId: 'rmv02', mode: 'replace', variables: ['score'], method: 'nearbyMedian', span: 2 })
fill = r.json()
const rmvPage = (await call('POST', `${base}/api/rows`, { sessionId: 'rmv02', offset: 0, limit: 10 })).json().page
const rmvVals = (rmvPage.rows ?? []).map((row) => row[2])
console.log('nearby median travels with its span', r.code === 200, fill.result?.method === 'nearbyMedian',
  fill.result?.filled === 4, JSON.stringify(rmvVals))
await call('POST', `${base}/api/close`, { sessionId: 'rmv02' })

for (const id of ['mva01']) await call('POST', `${base}/api/close`, { sessionId: id })

// 精确检验：交叉表勾上以后，注文由宿主侧枚举算出（PSPP 只给 2×2 的 Fisher）
await seed('ex01', [
  { g: 'M', wave: 1, score: 1 }, { g: 'M', wave: 1, score: 1 }, { g: 'M', wave: 1, score: 1 },
  { g: 'M', wave: 2, score: 1 }, { g: 'F', wave: 1, score: 1 }, { g: 'F', wave: 2, score: 1 },
  { g: 'F', wave: 2, score: 1 }, { g: 'F', wave: 2, score: 1 },
])
r = await call('POST', `${base}/api/run`, {
  sessionId: 'ex01',
  syntax: 'CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ /CELLS=COUNT.',
  exact: true,
})
let exactItems = r.json().result?.items ?? []
let exactNotes = exactItems.flatMap((item) => item.table?.notes ?? item.notes ?? [])
console.log('the exact test reaches the crosstab note', r.code === 200,
  exactNotes.some((note) => note.includes('精确检验（插件计算）')), JSON.stringify(exactNotes.slice(-1)))
// Without the flag the same run carries no exact note: it is opt-in.
r = await call('POST', `${base}/api/run`, {
  sessionId: 'ex01',
  syntax: 'CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ /CELLS=COUNT.',
})
let plainNotes = (r.json().result?.items ?? []).flatMap((item) => item.table?.notes ?? item.notes ?? [])
console.log('without the flag there is no exact note', r.code === 200,
  !plainNotes.some((note) => note.includes('精确检验（插件计算）')))

// 风险差：PSPP 的 Risk Estimate 只给 OR 与 RR，差值与区间由插件算（Newcombe 混合得分）
r = await call('POST', `${base}/api/run`, {
  sessionId: 'ex01',
  syntax: 'CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ RISK /CELLS=COUNT.',
})
let riskNotes = (r.json().result?.items ?? []).flatMap((item) => [...(item.table?.notes ?? []), ...(item.notes ?? [])])
console.log('the risk difference and its interval reach the risk table', r.code === 200,
  riskNotes.some((note) => note.includes('风险差（插件计算）') && note.includes('Newcombe')),
  JSON.stringify(riskNotes.filter((note) => note.includes('风险差')).slice(-1)))

// 精确卡方：同一个枚举器，换个统计量（Pearson 与似然比各一行注文）
r = await call('POST', `${base}/api/run`, {
  sessionId: 'ex01',
  syntax: 'CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ /CELLS=COUNT.',
  exactChi: true,
})
let chiNotes = (r.json().result?.items ?? []).flatMap((item) => item.table?.notes ?? item.notes ?? [])
console.log('the exact chi-square p reaches the crosstab note', r.code === 200,
  chiNotes.some((note) => note.includes('Pearson 卡方精确检验') && note.includes('似然比卡方精确检验')),
  JSON.stringify(chiNotes.slice(-1)))

// CMH：引擎不收这个关键字（整份语法会报错），所以宿主先剥掉它，再用每层的
// 2×2 计数自己算 —— 这条用例盯的就是「剥离之后还知道用户要它」。
await call('POST', `${base}/api/new`, { sessionId: 'cmh01', cwd: home, variables: [
  { name: 'g', type: 'string', label: '组' },
  { name: 'wave', type: 'numeric', label: '轮次' },
  { name: 'layer', type: 'numeric', label: '层' },
] })
for (const values of [
  { g: 'M', wave: 1, layer: 1 }, { g: 'M', wave: 1, layer: 1 }, { g: 'M', wave: 2, layer: 1 },
  { g: 'F', wave: 1, layer: 1 }, { g: 'F', wave: 2, layer: 1 }, { g: 'F', wave: 2, layer: 1 },
  { g: 'M', wave: 1, layer: 2 }, { g: 'M', wave: 1, layer: 2 }, { g: 'M', wave: 2, layer: 2 },
  { g: 'F', wave: 1, layer: 2 }, { g: 'F', wave: 2, layer: 2 }, { g: 'F', wave: 2, layer: 2 },
]) await call('POST', `${base}/api/case`, { sessionId: 'cmh01', values })
r = await call('POST', `${base}/api/run`, {
  sessionId: 'cmh01',
  syntax: 'CROSSTABS /TABLES=g BY wave BY layer /STATISTICS=CHISQ CMH /CELLS=COUNT.',
})
const cmhItems = r.json().result?.items ?? []
const cmhNotes = cmhItems.flatMap((item) => [...(item.table?.notes ?? []), ...(item.notes ?? [])])
console.log('the layered crosstab carries a CMH note, and the engine never saw the keyword', r.code === 200,
  cmhNotes.some((note) => note.includes('分层卡方（插件计算）') && note.includes('Cochran–Mantel–Haenszel')),
  !String(r.json().result?.syntax ?? '').includes('CMH'),
  JSON.stringify(cmhNotes.filter((note) => note.includes('分层卡方')).slice(-1)))

// 双因子 GLM 的对比：引擎没有 /CONTRAST，宿主在自己的设计矩阵上做 Lβ。
await call('POST', `${base}/api/new`, { sessionId: 'glmc01', cwd: home, variables: [
  { name: 'y', type: 'numeric', label: '因变量' },
  { name: 'fa', type: 'numeric', label: '因子一' },
  { name: 'fb', type: 'numeric', label: '因子二' },
] })
for (const [y, fa, fb] of [
  [3.1, 1, 1], [3.4, 1, 1], [4.2, 1, 2], [5.0, 1, 2], [4.4, 1, 3], [5.6, 1, 3],
  [2.2, 2, 1], [2.9, 2, 1], [3.8, 2, 2], [4.1, 2, 2], [5.2, 2, 3], [6.0, 2, 3],
  [2.5, 3, 1], [3.0, 3, 1], [4.6, 3, 2], [4.9, 3, 2], [5.5, 3, 3], [6.4, 3, 3],
]) await call('POST', `${base}/api/case`, { sessionId: 'glmc01', values: { y, fa, fb } })
r = await call('POST', `${base}/api/run`, {
  sessionId: 'glmc01',
  syntax: 'GLM y BY fa fb /DESIGN=fa fb fa*fb.',
  contrasts: {
    dependent: 'y',
    factors: ['fa', 'fb'],
    covariates: [],
    hypotheses: [{ label: 'fb 第 3 水平 vs 第 1', term: { factor: 'fb', coefficients: [0, 0, 1] } }],
  },
})
const contrastTable = (r.json().result?.items ?? []).find((item) => item.kind === 'table' && /自定义对比/.test(String(item.title ?? '')))
console.log('a two-factor GLM contrast is fitted in the plugin', r.code === 200, Boolean(contrastTable),
  contrastTable?.table?.matrix?.[1]?.[1], contrastTable?.table?.matrix?.[1]?.[5],
  JSON.stringify(contrastTable?.table?.matrix?.[1] ?? null))

// Batch variable edit: one request, one undo step. The panel selects rows in the
// variable view and sends them all at once.
r = await call('POST', `${base}/api/variable`, {
  sessionId: sid,
  action: 'updateMany',
  names: ['gender', 'score'],
  patch: { decimals: 3, measure: 'nominal' },
})
const batched = ['gender', 'score'].map((name) => r.json().state.dataset.variables.find((variable) => variable.name === name))
console.log('updateMany ->', r.code, batched.map((variable) => `${variable.name}:${variable.decimals}:${variable.measure}`).join(' '),
  r.json().result?.variables?.length)
r = await call('POST', `${base}/api/history`, { sessionId: sid, action: 'undo' })
const batchAfterUndo = ['gender', 'score'].map((name) => r.json().state.dataset.variables.find((variable) => variable.name === name))
console.log('one undo restores both ->', r.code, batchAfterUndo.map((variable) => `${variable.name}:${variable.decimals}:${variable.measure}`).join(' '))
r = await call('POST', `${base}/api/variable`, { sessionId: sid, action: 'updateMany', names: ['nope'], patch: { decimals: 1 } })
console.log('updateMany with an unknown name ->', r.code, r.json().error ?? r.json().message)

// Hierarchical clustering: PSPP only ships k-means, so the tree is built here.
const clustered = await call('POST', `${base}/api/cluster`, { sessionId: sid, options: { variables: ['score'], clusters: 2 } })
const clusterResult = clustered.json()
console.log('cluster ->', clustered.code, clusterResult.result?.matrix?.[0]?.[0], clusterResult.result?.items?.length, clusterResult.result?.model?.k)
if (clustered.code !== 200) throw new Error(`api/cluster failed: ${clusterResult.error}`)
if (clusterResult.result?.items?.length !== 3) throw new Error('three tables come back')
const wardRefused = await call('POST', `${base}/api/cluster`, { sessionId: sid, options: { variables: ['score'], linkage: 'ward' } })
if (wardRefused.code !== 400 || !/欧氏距离平方/.test(String(wardRefused.json().error))) throw new Error('ward without squared distance must be refused')

// Time-series smoothing lives in the plugin too: PSPP has no TSLINE and no
// exponential smoothing, so the route has to hand back a summary and a series.
const smoothed = await call('POST', `${base}/api/timeseries`, { sessionId: sid, options: { variable: 'score', method: 'ma', span: 2, periods: 1 } })
const smoothing = smoothed.json()
console.log('timeseries ->', smoothed.code, smoothing.result?.matrix?.[0]?.[0], smoothing.result?.items?.length,
  smoothing.result?.model?.forecast?.length)
if (smoothed.code !== 200) throw new Error(`api/timeseries failed: ${smoothing.error}`)
if (smoothing.result?.items?.length !== 2) throw new Error('the summary and the series table come back')
for (const method of ['ses', 'des']) {
  const fitted = await call('POST', `${base}/api/timeseries`, { sessionId: sid, options: { variable: 'score', method, alpha: 0.4, beta: 0.3, periods: 1 } })
  const label = { ses: '简单指数平滑', des: '双指数平滑' }[method]
  console.log(`api/timeseries ${method} ->`, fitted.code, fitted.json().result?.items?.length,
    JSON.stringify(fitted.json().result?.notes ?? []).includes(label))
}
const badSeries = await call('POST', `${base}/api/timeseries`, { sessionId: sid, options: { variable: 'gender' } })
if (badSeries.code !== 400 || !/要求数值变量/.test(String(badSeries.json().error))) throw new Error('a text series must be refused by name')

// A Kaplan–Meier figure has to be editable like any other chart, which means the
// factory that draws it must be the same one updateChart asks for. It was not:
// the figure drew fine and every edit answered "unknown chart type: km".
await seed('km01', [
  { g: 'M', wave: 1, score: 1 }, { g: 'M', wave: 2, score: 1 },
  { g: 'F', wave: 1, score: 1 }, { g: 'F', wave: 3, score: 1 },
])
const survival = await call('POST', `${base}/api/chart`, { sessionId: 'km01', kind: 'km', options: { time: 'wave', event: 'score', group: 'g' } })
const survivalChart = survival.json()
console.log('km chart ->', survival.code, survivalChart.result?.chart?.kind, survivalChart.result?.chart?.groups?.length)
if (survival.code !== 200) throw new Error(`api/chart km failed: ${survivalChart.error}`)
const kmEdited = await call('POST', `${base}/api/chart/update`, { sessionId: 'km01', runId: survivalChart.result.runId, title: '甲乙两组的生存曲线' })
const kmEditedChart = kmEdited.json()
console.log('km chart is editable ->', kmEdited.code, kmEditedChart.result?.chart?.title)
if (kmEdited.code !== 200) throw new Error(`a km chart must be editable: ${kmEditedChart.error}`)
if (kmEditedChart.result?.chart?.title !== '甲乙两组的生存曲线') throw new Error('the new title did not stick')

// Discriminant analysis is fitted in the plugin as well (PSPP has no
// DISCRIMINANT), so the route has to build four tables from the open rows.
r = await call('POST', `${base}/api/discriminant`, { sessionId: sid, options: { group: 'gender', variables: ['score'] } })
const discrimination = r.json()
console.log('discriminant ->', r.code, discrimination.result?.matrix?.[0]?.[0],
  discrimination.result?.items?.length, discrimination.result?.model?.groups?.length,
  discrimination.state?.items?.length > 0)
r = await call('POST', `${base}/api/discriminant`, { sessionId: sid, options: { group: 'gender', variables: [] } })
console.log('discriminant without variables ->', r.code, /至少需要一个判别变量/.test(String(r.json().error)))

// Cox regression runs inside the plugin (PSPP 2.1.3 has no COXREG), so the
// route has to work without an engine run: it builds the table from the rows
// that are already open.
let coxRes = await call('POST', `${base}/api/new`, { sessionId: 'cox01', cwd: home, variables: [
  { name: 't', type: 'numeric' },
  { name: 'e', type: 'numeric' },
  { name: 'g', type: 'numeric' },
] })
for (const values of [[2, 1, 1], [3, 1, 1], [4, 1, 1], [5, 1, 1], [6, 1, 1], [7, 0, 1],
  [4, 1, 0], [5, 1, 0], [6, 1, 0], [7, 1, 0], [8, 1, 0], [9, 1, 0], [10, 0, 0], [11, 0, 0]]) {
  coxRes = await call('POST', `${base}/api/case`, { sessionId: 'cox01', values })
}
r = await call('POST', `${base}/api/cox`, { sessionId: 'cox01', options: { time: 't', event: 'e', covariates: ['g'] } })
const cox = r.json()
console.log('cox ->', r.code, cox.result?.matrix?.[0]?.[0], cox.result?.matrix?.[1]?.[0],
  Number(cox.result?.matrix?.[1]?.[6]) > 1, cox.result?.notes?.some((note) => /Breslow/.test(note)),
  cox.state?.items?.length > 0)
r = await call('POST', `${base}/api/cox`, { sessionId: 'cox01', options: { time: 't', event: 'e', covariates: [] } })
console.log('cox without covariates ->', r.code, /至少要一个协变量/.test(String(r.json().error)))
// Stratified Cox: the route has to return the by-strata case table as a second
// item, because that table is what tells the reader whose risk sets are whose.
let stratifiedRes = await call('POST', `${base}/api/new`, { sessionId: 'cox02', cwd: home, variables: [
  { name: 't', type: 'numeric' },
  { name: 'e', type: 'numeric' },
  { name: 'x', type: 'numeric' },
  { name: 's', type: 'string' },
] })
for (let index = 0; index < 40; index += 1) {
  stratifiedRes = await call('POST', `${base}/api/case`, {
    sessionId: 'cox02',
    values: { t: 1 + (index % 2) * 5 + (index % 7), e: index % 10 === 0 ? 0 : 1, x: index % 2, s: index < 20 ? 'A' : 'B' },
  })
}
r = await call('POST', `${base}/api/cox`, { sessionId: 'cox02', options: { time: 't', event: 'e', covariates: ['x'], strata: 's' } })
const stratified = r.json()
console.log('stratified cox ->', r.code, stratified.result?.items?.length, stratified.result?.strata?.length,
  stratified.result?.model?.strata?.length, stratified.result?.model?.strataVariable)
assert.equal(r.code, 200, 'api/cox answers with strata')
assert.equal(stratified.result?.items?.length, 2, 'the by-strata table comes with the coefficients')
assert.equal(stratified.result?.strata?.[0]?.[0], '分层', 'and it is labelled')
assert.equal(stratified.result?.model?.strataVariable, 's')
r = await call('POST', `${base}/api/cox`, { sessionId: 'cox02', options: { time: 't', event: 'e', covariates: ['x'], strata: 'nope' } })
assert.equal(r.code, 400, 'an unknown strata variable is refused')
// Competing risks: three tables without a grouping variable (counts, incidence,
// and no group test), one more with it. The engine is not involved at all.
let competingRes = await call('POST', `${base}/api/new`, { sessionId: 'cr01', cwd: home, variables: [
  { name: 't', type: 'numeric' },
  { name: 's', type: 'numeric' },
  { name: 'g', type: 'string' },
] })
for (let index = 0; index < 36; index += 1) {
  competingRes = await call('POST', `${base}/api/case`, {
    sessionId: 'cr01',
    values: { t: 1 + (index % 9), s: index % 6 === 0 ? 0 : (index % 2 === 0 ? 1 : 2), g: index < 18 ? 'A' : 'B' },
  })
}
r = await call('POST', `${base}/api/competing`, { sessionId: 'cr01', options: { time: 't', status: 's' } })
const competing = r.json()
console.log('competing ->', r.code, competing.result?.tables?.length, competing.result?.causes?.length,
  competing.result?.logRank?.length, competing.result?.model?.cases)
assert.equal(r.code, 200, 'api/competing answers')
assert.equal(competing.result?.tables?.length, 2, 'two tables without a grouping variable')
assert.equal(competing.result?.causes?.length, 2, 'both event types are reported')
assert.equal(competing.result?.logRank?.length, 0, 'and no group test is attempted')
r = await call('POST', `${base}/api/competing`, { sessionId: 'cr01', options: { time: 't', status: 's', group: 'g' } })
const competingGrouped = r.json()
assert.equal(r.code, 200, 'api/competing answers with a group')
assert.equal(competingGrouped.result?.tables?.length, 3, 'the group test table comes with it')
assert.equal(competingGrouped.result?.logRank?.length, 2, 'one test per event type')
assert.equal(competingGrouped.result?.tables?.[1]?.matrix?.[0]?.[1], '分组', 'the incidence table names the group column')
r = await call('POST', `${base}/api/competing`, { sessionId: 'cr01', options: { time: 't', status: 'nope' } })
assert.equal(r.code, 400, 'an unknown status variable is refused')
await call('POST', `${base}/api/close`, { sessionId: 'cr01' })

await call('POST', `${base}/api/close`, { sessionId: 'cox02' })
await call('POST', `${base}/api/close`, { sessionId: 'cox01' })

// Multinomial logistic regression is fitted in the plugin too (PSPP only fits
// two categories), so the route must build five tables without an engine run.
let mlrRes = await call('POST', `${base}/api/new`, { sessionId: 'mlr01', cwd: home, variables: [
  { name: 'arm', type: 'string' },
  { name: 'dose', type: 'numeric' },
  { name: 'counts', type: 'numeric' },
] })
for (let index = 0; index < 60; index += 1) {
  const arm = ['low', 'mid', 'high'][index % 3]
  mlrRes = await call('POST', `${base}/api/case`, { sessionId: 'mlr01', values: { arm, dose: index / 10 + ((index * 37) % 11) / 10, counts: 1 + (index % 5) } })
}
r = await call('POST', `${base}/api/multinomial`, { sessionId: 'mlr01', options: { dependent: 'arm', independents: ['dose'] } })
const mlr = r.json()
console.log('multinomial ->', r.code, mlr.result?.matrix?.[0]?.[0], mlr.result?.items?.length,
  mlr.result?.model?.reference, mlr.result?.model?.categories?.length,
  mlr.state?.items?.length > 0)
r = await call('POST', `${base}/api/multinomial`, { sessionId: 'mlr01', options: { dependent: 'arm', independents: ['dose'], reference: 'mid' } })
console.log('multinomial with a reference ->', r.code, r.json().result?.model?.reference,
  r.json().result?.model?.categories?.join(','))
// Two-stage least squares: instruments that are no weaker than the endogenous set.
// Multidimensional scaling: distances from the chosen variables, classical solution.
r = await call('POST', `${base}/api/mds`, { sessionId: 'mlr01', options: { variables: ['dose', 'counts'], dimensions: 2 } })
const mds = await r.json()
console.log('mds ->', r.code, mds.result?.matrices?.length, mds.result?.model?.dimensions,
  Number(mds.result?.model?.stress ?? 1).toFixed(4), mds.result?.chart?.rows?.length)
assert.equal(r.code, 200, 'api/mds answers')
assert.equal(mds.result?.matrices?.length, 2, 'summary plus coordinates')
assert.equal(mds.result?.model?.cases, 60, 'every case used')
assert.ok((mds.result?.model?.explained ?? []).reduce((sum, value) => sum + value, 0) > 0.99, 'proportions sum to one')
assert.ok(mds.result?.chart?.rows?.length === 60, 'the map carries one point per object')
r = await call('POST', `${base}/api/mds`, { sessionId: 'mlr01', options: { variables: ['arm'] } })
assert.equal(r.code, 400, 'a text variable is refused')

// Log-linear analysis: four tables. A 2×3 table with main effects only has
// 6 cells and 4 parameters, so the fit must have exactly 2 degrees of freedom.
await call('POST', `${base}/api/new`, { sessionId: 'll01', cwd: home, variables: [
  { name: 'g', type: 'string' },
  { name: 'h', type: 'string' },
] })
for (let index = 0; index < 60; index += 1) {
  await call('POST', `${base}/api/case`, { sessionId: 'll01', values: { g: index % 2 ? 'x' : 'y', h: ['a', 'b', 'c'][index % 3] } })
}
r = await call('POST', `${base}/api/loglinear`, { sessionId: 'll01', options: { variables: ['g', 'h'], terms: [['g'], ['h']] } })
const loglin = await r.json()
console.log('loglinear ->', r.code, loglin.result?.matrices?.map((matrix) => matrix.length).join(','),
  Number(loglin.result?.model?.fit?.g2 ?? -1).toFixed(4), loglin.result?.model?.fit?.df)
assert.equal(r.code, 200, 'api/loglinear answers')
assert.equal(loglin.result?.matrices?.length, 4, 'counts, fit, parameters, partial association')
assert.equal(loglin.result?.matrices?.[0]?.length, 7, 'header plus six cells')
assert.equal(loglin.result?.model?.fit?.df, 2, 'six cells minus four parameters')
r = await call('POST', `${base}/api/loglinear`, { sessionId: 'll01', options: { variables: ['g'] } })
assert.equal(r.code, 400, 'one factor is refused')

// Curve estimation: a model summary plus a scatter plot carrying the best curve.
r = await call('POST', `${base}/api/curve`, { sessionId: 'mlr01', options: { dependent: 'dose', independent: 'counts', models: ['linear', 'quadratic', 'exponential'] } })
const curve = await r.json()
console.log('curve ->', r.code, curve.result?.matrices?.[0]?.[0]?.join('|'), curve.result?.model?.best,
  curve.result?.chart?.curve?.length)
assert.equal(r.code, 200, 'api/curve answers')
assert.equal(curve.result?.matrices?.length, 1, 'one summary table')
assert.equal(curve.result?.model?.parameters?.length, 3, 'three models requested')
assert.ok(['linear', 'quadratic', 'exponential'].includes(curve.result?.model?.best), 'the best is one of them')
assert.ok((curve.result?.chart?.curve ?? []).length > 2, 'the chart carries a curve')
assert.ok(curve.state?.items?.some((item) => item.kind === 'image'), 'and the chart is in the tree')
r = await call('POST', `${base}/api/curve`, { sessionId: 'mlr01', options: { dependent: 'dose', independent: 'arm' } })
assert.equal(r.code, 400, 'a text independent variable is refused')
// Multiple correspondence analysis: an indicator matrix on top of the same core.
// counts 是数值变量：按 SPSS 的规矩（只有名义/有序变量能进多重对应分析）先在
// 变量视图里改成名义变量。
await call('POST', `${base}/api/variable`, { sessionId: 'mlr01', action: 'updateMany', names: ['counts'], patch: { measure: 'nominal' } })
r = await call('POST', `${base}/api/mca`, { sessionId: 'mlr01', options: { variables: ['arm', 'counts'] } })
const mca = r.json()
console.log('mca ->', r.code, mca.result?.matrices?.length, mca.result?.model?.categories,
  Number(mca.result?.model?.inertia ?? 0).toFixed(4), Boolean(mca.state?.items?.some((item) => item.kind === 'image')))
// 总惯量必须等于 (类别数 − 变量数) / 变量数：8 个类别、2 个变量 ⇒ 3。
const mcaCategories = mca.result?.model?.categories ?? 0
assert.ok(Math.abs((mca.result?.model?.inertia ?? 0) - (mcaCategories - 2) / 2) < 1e-6,
  `inertia ${mca.result?.model?.inertia} should be (${mcaCategories} - 2) / 2`)
assert.equal(mca.result?.matrices?.length, 3, 'three tables')
assert.ok(mca.state?.items?.some((item) => item.kind === 'image'), 'and a category map')
r = await call('POST', `${base}/api/mca`, { sessionId: 'mlr01', options: { variables: ['arm'] } })
console.log('mca with one variable ->', r.code, /至少要两个分类变量/.test(String(r.json().error)))

// Correspondence analysis: chi-square decomposition plus a biplot.
r = await call('POST', `${base}/api/correspondence`, { sessionId: 'mlr01', options: { row: 'arm', column: 'counts' } })
const ca = r.json()
console.log('correspondence ->', r.code, ca.result?.tables?.length, Number(ca.result?.model?.chiSquare).toFixed(2),
  ca.result?.model?.rows?.length, ca.result?.model?.columns?.length, Boolean(ca.state?.items?.some((item) => item.kind === 'image')))
r = await call('POST', `${base}/api/correspondence`, { sessionId: 'mlr01', options: { row: 'arm', column: 'arm' } })
console.log('correspondence same variable ->', r.code, /不能是同一个变量/.test(String(r.json().error)))

// The distribution calculator needs no dataset at all.
r = await call('POST', `${base}/api/distribution`, { sessionId: 'mlr01', options: { distribution: 'chiSquare', x: 7.814727903, df1: 3, probability: 0.95 } })
const dist = r.json()
console.log('distribution ->', r.code, dist.result?.matrix?.[0]?.[0], Number(dist.result?.result?.cdf).toFixed(4),
  Number(dist.result?.result?.quantile).toFixed(4), dist.result?.items?.length)
r = await call('POST', `${base}/api/distribution`, { sessionId: 'mlr01', options: { distribution: 'cauchy', x: 1 } })
console.log('distribution unknown ->', r.code, /不认识的分布/.test(String(r.json().error)))

r = await call('POST', `${base}/api/twostage`, { sessionId: 'mlr01', options: { dependent: 'dose', endogenous: ['counts'], instruments: ['counts'] } })
const tsls = r.json()
console.log('twostage ->', r.code, tsls.result?.matrix?.[0]?.[0], tsls.result?.items?.length,
  Number.isFinite(tsls.result?.model?.rSquare), tsls.result?.model?.stageOne?.length)
r = await call('POST', `${base}/api/twostage`, { sessionId: 'mlr01', options: { dependent: 'dose', endogenous: ['counts', 'arm'], instruments: ['counts'] } })
console.log('twostage under-identified ->', r.code, /工具变量不足/.test(String(r.json().error)))

// Weighted least squares: same normal equations, one weight column.
r = await call('POST', `${base}/api/wls`, { sessionId: 'mlr01', options: { dependent: 'dose', independents: ['counts'], weight: 'counts' } })
const wls = r.json()
console.log('wls ->', r.code, wls.result?.matrix?.[0]?.[0], wls.result?.items?.length,
  Number.isFinite(wls.result?.model?.rSquare), wls.state?.items?.length > 0)
r = await call('POST', `${base}/api/wls`, { sessionId: 'mlr01', options: { dependent: 'dose', independents: ['counts'], weight: 'arm' } })
console.log('wls with a text weight ->', r.code, /权重变量要求数值变量/.test(String(r.json().error)))

// Poisson regression: the count model is fitted in the plugin, so the route
// must produce the three tables without an engine run.
r = await call('POST', `${base}/api/poisson`, { sessionId: 'mlr01', options: { dependent: 'counts', independents: ['dose'] } })
const poi = r.json()
console.log('poisson ->', r.code, poi.result?.matrix?.[0]?.[0], poi.result?.items?.length,
  Number.isFinite(poi.result?.model?.dispersion), poi.result?.model?.cases > 0,
  poi.state?.items?.length > 0)
r = await call('POST', `${base}/api/poisson`, { sessionId: 'mlr01', options: { dependent: 'counts', independents: ['arm'] } })
console.log('poisson with a text predictor ->', r.code, /文本变量/.test(String(r.json().error)))
// Ordinal logistic: three ordered levels of the same data, so the
// parallel-lines test has a degree of freedom.
r = await call('POST', `${base}/api/ordinal`, { sessionId: 'mlr01', options: { dependent: 'arm', independents: ['dose'] } })
const ord = r.json()
console.log('ordinal ->', r.code, ord.result?.matrix?.[0]?.[0], ord.result?.items?.length,
  ord.result?.model?.categories?.join(','), ord.result?.model?.parallel?.df,
  ord.state?.items?.length > 0)
await call('POST', `${base}/api/close`, { sessionId: 'mlr01' })

for (const id of ['pivot01', 'pivot02', 'dup01', 'out01', 'ex01', 'cmh01', 'glmc01']) await call('POST', `${base}/api/close`, { sessionId: id })

r = await call('POST', `${base}/api/close`, { sessionId: 'pivot01' })

r = await call('POST', `${base}/api/close`, { sessionId: sid })
console.log('closed ->', r.code, r.json().state.dataset)
