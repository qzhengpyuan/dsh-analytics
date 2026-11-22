// The whole user journey over the HTTP handler: import a csv, look at the
// variables, run a test, draw a chart, export a document, save, reopen.
//
// test/routes.mjs already covers the endpoints one by one; what kept breaking
// in the field was the seam between them (an export that only works right after
// a run, a reopened file that forgets where it came from). This walks the path a
// person actually takes and asserts at every stop.
import { mkdtemp, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../lib/workspace.js'
import { resolveEngine } from '../lib/engine.js'
import { createHandler } from '../lib/routes.js'
import { SettingsStore } from '../lib/settings.js'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}

const home = await mkdtemp(join(tmpdir(), 'ap-flow-'))
const settingsStore = new SettingsStore(join(home, 'analytics'), { registerTools: false })
const registry = new WorkspaceRegistry({
  root: join(home, 'analytics'),
  config: {},
  engine: resolveEngine({}),
  settingsStore,
})
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

const call = async (method, url, body) => {
  const payload = body ? JSON.stringify(body) : null
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      'content-length': payload ? String(Buffer.byteLength(payload)) : '0',
    },
    [Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload) },
    on() {}, once() {}, removeListener() {},
  }
  const res = new Res()
  await handler(req, res)
  return { code: res.code, headers: res.headers, body: res.body, text: res.text, json: () => JSON.parse(res.text) }
}

const sid = 'flow-session'
const base = '/analytics'
const post = (path, body) => call('POST', `${base}/api/${path}`, { sessionId: sid, ...body })

// A 60 case file with a string group, a numeric group, a score and two user
// missing codes -- the shape most real exports have.
const header = 'id,group,cohort,score,age'
const rows = []
for (let i = 1; i <= 60; i += 1) {
  const group = i % 2 === 0 ? 'female' : 'male'
  const cohort = i <= 30 ? 1 : 2
  const score = i % 17 === 0 ? '' : String(50 + (i * 7) % 40 + (group === 'female' ? 3 : 0))
  rows.push([i, group, cohort, score, String(20 + (i * 3) % 25)].join(','))
}
const csvPath = join(home, 'flow.csv')
await writeFile(csvPath, [header, ...rows].join('\n'), 'utf8')

let opened = null

await check('opening a csv imports it and reports the shape', async () => {
  const r = await post('open', { path: csvPath })
  if (r.code !== 200) throw new Error(`open ${r.code}: ${r.text.slice(0, 200)}`)
  const state = r.json().state
  opened = r.json().result
  const dataset = state.dataset
  if (dataset.caseCount !== 60) throw new Error(`caseCount ${dataset.caseCount}`)
  if (dataset.variables.length !== 5) throw new Error(`variables ${dataset.variables.map((v) => v.name).join(',')}`)
  if (!dataset.variables.some((v) => v.type === 'string')) throw new Error('no string variable survived the import')
})

await check('the fingerprint says which file the numbers came from', async () => {
  const r = await call('GET', `${base}/api/state?sessionId=${sid}&cwd=${encodeURIComponent(home)}`)
  const signal = r.json().state.signal
  if (!signal?.dataset?.sourcePath?.endsWith('flow.csv')) throw new Error(`sourcePath ${signal?.dataset?.sourcePath}`)
  if (signal.dataset.caseCount !== 60) throw new Error(`signal caseCount ${signal.dataset.caseCount}`)
  if (!signal.dataset.name) throw new Error('the signature has no display name for the file')
})

await check('the grid pages through the cases', async () => {
  const r = await post('rows', { offset: 10, limit: 5 })
  const page = r.json().page
  if (page.rows.length !== 5) throw new Error(`rows ${page.rows.length}`)
  if (page.total !== 60) throw new Error(`total ${page.total}`)
  if (!page.columns.length) throw new Error('no columns')
})

await check('a t test runs and produces a table with a p value', async () => {
  const r = await post('run', { syntax: 'T-TEST /GROUPS=cohort(1 2) /VARIABLES=score /CRITERIA=CI(.95).' })
  if (r.code !== 200) throw new Error(`run ${r.code}: ${r.text.slice(0, 300)}`)
  const items = r.json().result.items
  const table = items.find((item) => item.kind === 'table' && /t test|independent|独立样本/i.test(String(item.table?.caption ?? '') + String(item.title ?? '')))
  if (!table) throw new Error(`no t table in ${items.map((i) => i.title).join(' | ')}`)
  if (!/<td/.test(table.table.html)) throw new Error('table html has no cells')
  if (!/\d/.test(table.table.html)) throw new Error('table html has no numbers')
})

await check('a crosstab brings the plugin computed notes with it', async () => {
  const r = await post('run', {
    syntax: 'CROSSTABS /TABLES=group BY cohort /STATISTICS=CHISQ RISK /CELLS=COUNT.',
    exact: true,
    exactChi: true,
  })
  if (r.code !== 200) throw new Error(`run ${r.code}: ${r.text.slice(0, 300)}`)
  const items = r.json().result.items
  const notes = items.flatMap((item) => [...(item.table?.notes ?? []), ...(item.notes ?? [])]).join('\n')
  if (!/精确检验/.test(notes)) throw new Error(`no exact note: ${notes.slice(0, 200)}`)
  if (!/风险差/.test(notes)) throw new Error(`no risk difference note: ${notes.slice(0, 200)}`)
})

await check('a chart is written as a file the panel can show', async () => {
  const r = await post('chart', { kind: 'bar', variable: 'score', by: 'group', statistic: 'MEAN' })
  if (r.code !== 200) throw new Error(`chart ${r.code}: ${r.text.slice(0, 300)}`)
  const item = r.json().result.item ?? r.json().result
  const url = item.artifactUrl
  if (!url) throw new Error(`no artifactUrl in ${JSON.stringify(item).slice(0, 200)}`)
  // Read it back through the route the panel uses, not off the disk: a path
  // that only works because the test knows the layout is not a working panel.
  const served = await call('GET', url.replace(base, base))
  if (served.code !== 200) throw new Error(`artifact ${served.code}: ${served.text.slice(0, 150)}`)
  if (!/<svg/.test(served.text)) throw new Error('artifact is not an svg')
})

await check('the word export carries a table and the chart image', async () => {
  const docx = join(home, 'out.docx')
  const r = await post('exportOffice', { path: docx })
  if (r.code !== 200) throw new Error(`exportOffice ${r.code}: ${r.text.slice(0, 300)}`)
  const bytes = await readFile(docx)
  if (bytes.length < 5000) throw new Error(`docx ${bytes.length} bytes`)
  const { readZipEntries } = await import('../lib/xlsx.js')
  const entries = readZipEntries(bytes)
  const names = [...entries.keys()]
  if (!names.includes('word/document.xml')) throw new Error(`document.xml missing: ${names.slice(0, 5)}`)
  if (!names.some((name) => /^word\/media\//.test(name))) throw new Error(`no embedded image: ${names.filter((n) => /media/.test(n))}`)
  const xml = (await import('../lib/xlsx.js')).readZipText(bytes, entries, 'word/document.xml')
  if (!/<w:tbl>/.test(xml)) throw new Error('docx has no table')
})

await check('the pdf export is a real pdf', async () => {
  const pdf = join(home, 'out.pdf')
  const r = await post('exportDoc', { path: pdf, format: 'pdf' })
  if (r.code !== 200) throw new Error(`exportDoc ${r.code}: ${r.text.slice(0, 400)}`)
  const bytes = await readFile(pdf)
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a pdf')
  if (bytes.length < 5000) throw new Error(`pdf ${bytes.length} bytes`)
})

await check('saving writes a sav and reopening it keeps the shape and the provenance', async () => {
  const sav = join(home, 'flow.sav')
  const saved = await post('save', { path: sav })
  if (saved.code !== 200) throw new Error(`save ${saved.code}: ${saved.text.slice(0, 200)}`)
  const closed = await post('close', {})
  if (closed.code !== 200) throw new Error(`close ${closed.code}: ${closed.text.slice(0, 200)}`)
  const reopened = await post('open', { path: sav })
  if (reopened.code !== 200) throw new Error(`reopen ${reopened.code}: ${reopened.text.slice(0, 200)}`)
  const state = reopened.json().state
  if (state.dataset.caseCount !== 60) throw new Error(`reopened caseCount ${state.dataset.caseCount}`)
  if (!/flow\.sav$/.test(state.dataset.sourcePath)) throw new Error(`reopened sourcePath ${state.dataset.sourcePath}`)
  if (!state.signal.dataset?.openedAt) throw new Error('reopened dataset has no openedAt')
})

await check('csv export writes every case back out', async () => {
  const out = join(home, 'back.csv')
  const r = await post('export', { path: out })
  if (r.code !== 200) throw new Error(`export ${r.code}: ${r.text.slice(0, 200)}`)
  const text = await readFile(out, 'utf8')
  // SAVE TRANSLATE writes one line per case and no header row.
  const lines = text.trim().split('\n')
  if (lines.length !== 60) throw new Error(`csv lines ${lines.length}`)
  if (!/\d/.test(lines[0])) throw new Error(`first csv line looks empty: ${JSON.stringify(lines[0])}`)
})

await check('handing over a second file merges the cases', async () => {
  // Merge only takes system files (it hands the path to ADD FILES), so the
  // second file goes through the importer first -- which is also what a person
  // does when they hand over a csv.
  const extra = join(home, 'extra.csv')
  await writeFile(extra, ['id,group,cohort,score,age', '101,male,1,66,30', '102,female,2,77,31'].join('\n'), 'utf8')
  // Merge hands the path to ADD FILES, which only reads system files. The
  // second file therefore goes through a second workspace of its own and comes
  // back out as a sav -- which is what a person does too.
  const other = 'flow-second'
  const second = (path, body) => call('POST', `${base}/api/${path}`, { sessionId: other, ...body })
  const imported = await second('open', { path: extra })
  if (imported.code !== 200) throw new Error(`second open ${imported.code}: ${imported.text.slice(0, 200)}`)
  const savedExtra = join(home, 'extra.sav')
  const saved = await second('save', { path: savedExtra })
  if (saved.code !== 200) throw new Error(`second save ${saved.code}: ${saved.text.slice(0, 200)}`)
  await second('close', {})
  const r = await post('merge', { path: savedExtra, mode: 'add' })
  if (r.code !== 200) throw new Error(`merge ${r.code}: ${r.text.slice(0, 300)}`)
  const state = r.json().state
  if (state.dataset.caseCount !== 62) throw new Error(`after merge caseCount ${state.dataset.caseCount}`)
})

await check('the output list keeps every run in order', async () => {
  const r = await call('GET', `${base}/api/state?sessionId=${sid}&cwd=${encodeURIComponent(home)}`)
  const items = r.json().state.items
  if (!items.length) throw new Error('no items')
  const runs = [...new Set(items.map((item) => item.runId).filter(Boolean))]
  if (runs.length < 2) throw new Error(`runs ${runs.join(',')}`)
})

console.log('')
console.log(`${passed} passed, ${failed} failed in test/flow.mjs`)
if (failed > 0) process.exitCode = 1
