import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { resolveEngine, runProcess } from '../lib/engine.js'
import { Workspace, WorkspaceRegistry, describeFailure } from '../lib/workspace.js'
import { quoteSyntaxPath } from '../lib/dataset.js'

const engine = resolveEngine()
console.log('engine:', engine)

const root = await mkdtemp(join(tmpdir(), 'ap-smoke-'))
const workspace = new Workspace({ id: 'smoke', engine, root, config: { timeoutMs: 60000 } })
await workspace.init()

const created = await workspace.createDataset()
console.log('created:', created.variables.map((variable) => variable.name))

const values = [
  ['M', 23, 78.5],
  ['F', 31, 88],
  ['M', 45, 65.5],
  ['F', 29, 92],
]
workspace.dataset.variables[0].name = 'gender'
workspace.dataset.variables[0].type = 'string'
workspace.dataset.variables[0].format = 'A1'
workspace.dataset.variables[0].width = 1
workspace.dataset.variables[0].label = '性别'
workspace.dataset.variables[0].valueLabels = { M: '男', F: '女' }
workspace.dataset.variables[1].name = 'age'
workspace.dataset.variables[1].label = '年龄'

// The default dataset has two variables; rebuild it with three.
await workspace.createDataset({
  variables: [
    { name: 'gender', type: 'string', width: 1, label: '性别' },
    { name: 'age', type: 'numeric', width: 3, decimals: 0, label: '年龄' },
    { name: 'score', type: 'numeric', width: 5, decimals: 1, label: '得分' },
  ],
})
for (const row of values) workspace.appendCase({ gender: row[0], age: row[1], score: row[2] })

const saved = await workspace.save(join(root, 'demo.sav'))
console.log('saved:', saved)

// A save stages a CSV beside the target for the engine to read; it must not
// survive the save, or every save litters the user's folder.
const leftovers = (await readdir(root)).filter((name) => name.includes('.tmp-') || name.endsWith('.source.csv'))
if (leftovers.length > 0) throw new Error(`save left staging files behind: ${leftovers.join(', ')}`)
console.log('save leaves no staging files: true')

// 缺失值往返：PSPP 把 SYSMIS 写成单个空格，读回来必须先 trim 再判空，
// 否则 Number('') === 0 会把每个缺失值变成真正的 0（面板、数据页、分析全错）。
const gap = new Workspace({ id: 'smoke-gap', engine, root: join(root, 'gap'), config: { timeoutMs: 60000 } })
await gap.init()
await gap.createDataset({
  variables: [
    { name: 'm', type: 'numeric', width: 8, decimals: 2 },
    { name: 'n', type: 'numeric', width: 8, decimals: 2 },
  ],
})
await gap.appendCase({ m: 1, n: null })
await gap.appendCase({ m: 2, n: 3 })
await gap.appendCase({ m: null, n: 5 })
await gap.save(join(root, 'gap.sav'))
const gapBack = await gap.open(join(root, 'gap.sav'))
const gapRows = gapBack ? gap.page(0, 3).rows : []
if (JSON.stringify(gapRows) !== JSON.stringify([[1, null], [2, 3], [null, 5]])) {
  throw new Error(`missing values must stay missing: ${JSON.stringify(gapRows)}`)
}
await gap.runSyntax('DESCRIPTIVES m n.', { persist: true })
const gapAfter = gap.page(0, 3).rows
if (JSON.stringify(gapAfter) !== JSON.stringify([[1, null], [2, 3], [null, 5]])) {
  throw new Error(`persist turned missing into a number: ${JSON.stringify(gapAfter)}`)
}
console.log('missing values round-trip:', JSON.stringify(gapAfter))

const back = await workspace.open(join(root, 'demo.sav'))
console.log('reopened cases:', back.caseCount)
// Where the numbers came from: a file the user opened, and the identity of that
// file (size + mtime) so a replaced file with the same name is distinguishable.
const fileStamp = workspace.provenance()
assert.equal(fileStamp.origin, 'file', 'an opened path is a file origin')
assert.ok(fileStamp.sourceSize > 0, `opened file should report its size, got ${fileStamp.sourceSize}`)
assert.ok(typeof fileStamp.sourceMtime === 'number' && fileStamp.sourceMtime > 0, 'opened file should report its mtime')
assert.equal(fileStamp.sourcePath, join(root, 'demo.sav'), 'the stamp names the file')
console.log('variables:', back.variables.map((variable) => `${variable.name}:${variable.type}:${variable.label}:${JSON.stringify(variable.valueLabels)}`))

// 值标签往返：更新 -> 存盘 -> 重开，标签必须原样回来
// PSPP 打印字典时按 locale 编码输出，Windows 上是 ANSI 代码页：英文 Windows 的
// cp1252 表示不了汉字，标签回来会变成 '?'（引擎的限制，不是写盘的问题），所以
// Windows 上用能表示的英文标签，别的平台仍然用中文，两边都验得到往返。
const labelPair = process.platform === 'win32' ? { F: 'Female', M: 'Male' } : { F: '女', M: '男' }
workspace.updateVariable('gender', { valueLabels: labelPair })
await workspace.save(join(root, 'demo.sav'))
const relabeled = await workspace.open(join(root, 'demo.sav'))
const genderVar = relabeled.variables.find((variable) => variable.name === 'gender')
if (genderVar?.valueLabels?.F !== labelPair.F || genderVar?.valueLabels?.M !== labelPair.M) {
  throw new Error(`value labels did not round-trip: ${JSON.stringify(genderVar?.valueLabels)}`)
}
console.log('value labels ok:', JSON.stringify(genderVar.valueLabels))

// A quoted string may contain a line break (a multi-line address, an open
// answer pasted into a cell). The save path goes through CSV, and PSPP's TXT
// reader cannot carry an embedded newline: three cases came back as four, with
// the value split across rows.
// MEANS prints `NaN` in a column with nothing to compute from. That is the engine's
// own text, but a reader still needs to be told the column is empty.
{
  const empty = new Workspace({ id: 'smoke-emptymean', engine, root: join(root, 'emptymean'), config: { timeoutMs: 60000 } })
  await empty.init()
  await empty.createDataset({
    variables: [
      { name: 'y', type: 'numeric', width: 2, decimals: 0 },
      { name: 'x', type: 'numeric', width: 4, decimals: 1 },
    ],
  })
  for (const y of [1, 2, 1, 2]) empty.appendCase({ y, x: null })
  const emptyRun = await empty.runSyntax('MEANS TABLES=x BY y.')
  const report = emptyRun.items.find((item) => /^Report/i.test(item.table?.caption ?? ''))
  assert.ok(report, 'the engine draws the means report')
  const explained = (report.notes ?? []).join(' ')
  assert.match(explained, /有效个案是 0/, `an all-missing means table explains itself: ${explained}`)
  console.log('ok  a means table with nothing to average says why')
}

// The sample-size warning hangs on the Model Summary of a real regression, and it
// needs the caller to say which variables were predictors -- the engine's tables
// never spell that out.
{
  const fewCases = new Workspace({ id: 'smoke-fewcases', engine, root: join(root, 'fewcases'), config: { timeoutMs: 60000 } })
  await fewCases.init()
  await fewCases.createDataset({
    variables: [
      { name: 'y', type: 'numeric', width: 2, decimals: 0 },
      { name: 'x', type: 'numeric', width: 2, decimals: 0 },
    ],
  })
  for (const [y, x] of [[1, 2], [2, 3], [3, 5], [4, 6]]) fewCases.appendCase({ y, x })
  const fewRun = await fewCases.runSyntax('REGRESSION /DEPENDENT=y /METHOD=ENTER x.', {
    regression: { independents: ['x'] },
  })
  const summary = fewRun.items.find((item) => /Model Summary/i.test(item.table?.caption ?? ''))
  assert.ok(summary, 'the engine draws the model summary')
  const warned = (summary.notes ?? []).join(' ')
  assert.match(warned, /样本量 4 对 1 个预测变量偏少/, `the small-sample warning reaches the panel: ${warned}`)
  console.log('ok  a real regression warns when four cases are asked about one predictor')

  // A script typed into the syntax editor carries no predictor list, so the
  // workspace has to read it off the command.
  const typedRun = await fewCases.runSyntax('REGRESSION /DEPENDENT=y /METHOD=ENTER x.')
  const typedSummary = typedRun.items.find((item) => /Model Summary/i.test(item.table?.caption ?? ''))
  const typedNotes = (typedSummary?.notes ?? []).join(' ')
  assert.match(typedNotes, /样本量 4 对 1 个预测变量偏少/, `a typed regression reads its own predictors: ${typedNotes}`)
  console.log('ok  a typed regression is warned about without a predictor list')

  // PSPP 2.1.3 has no /ENTER= or /TEST= subcommand: the only form it accepts is
  // /METHOD=ENTER with the predictors. SPSS scripts that use the other spelling must
  // fail loudly rather than be quietly guessed at, so this pins the engine's wording.
  let rejected = null
  try {
    await fewCases.runSyntax('REGRESSION /DEPENDENT=y /ENTER=x.')
  } catch (error) {
    rejected = String(error.message)
  }
  assert.ok(rejected, 'a /ENTER= subcommand is rejected by the engine, not silently accepted')
  assert.match(rejected, /不被接受|Syntax error/, `the rejection is explained in Chinese: ${rejected}`)
  console.log('ok  /ENTER= is refused by the engine while /METHOD=ENTER works')
}

// The pairwise-comparison note has to survive a real ONEWAY: the caption it hangs
// on is "Multiple Comparisons (score)", not the bare words the fixture used.
{
  const posthoc = new Workspace({ id: 'smoke-posthoc', engine, root: join(root, 'posthoc'), config: { timeoutMs: 60000 } })
  await posthoc.init()
  await posthoc.createDataset({
    variables: [
      { name: 'g', type: 'numeric', width: 2, decimals: 0 },
      { name: 'score', type: 'numeric', width: 5, decimals: 1 },
    ],
  })
  for (const group of [1, 2, 3]) {
    for (const offset of [10, 12, 14]) posthoc.appendCase({ g: group, score: offset + group * 3 })
  }
  const posthocRun = await posthoc.runSyntax('ONEWAY score BY g /POSTHOC=LSD /STATISTICS=DESCRIPTIVES.')
  const comparisons = posthocRun.items.find((item) => /Multiple Comparisons/i.test(item.table?.caption ?? ''))
  assert.ok(comparisons, 'the engine draws the pairwise comparisons table')
  const said = (comparisons.notes ?? []).join(' ')
  assert.match(said, /3 次两两比较/, `the comparisons count reaches the panel: ${said}`)
  assert.match(said, /14%/, `the note says what three tries cost: ${said}`)
  console.log('ok  a real ONEWAY says how many pairwise comparisons it made')
}

const newlineWorkspace = new Workspace({ id: 'smoke-newline', engine, root, config: { timeoutMs: 60000 } })
await newlineWorkspace.init()
await newlineWorkspace.createDataset({
  variables: [{ name: 'id', type: 'numeric' }, { name: 'text', type: 'string', width: 40 }],
  rows: [[1, 'first line\nsecond line'], [2, 'plain'], [3, 'third']],
})
const newlinePath = join(root, 'newline.sav')
await newlineWorkspace.save(newlinePath)
await newlineWorkspace.open(newlinePath)
const newlineRows = newlineWorkspace.dataset.rows
if (newlineRows.length !== 3) throw new Error(`a newline inside a string changed the case count: ${newlineRows.length}`)
if (newlineRows[0][1] !== 'first line second line') throw new Error(`the newline was not folded: ${JSON.stringify(newlineRows[0][1])}`)
console.log('newline in string ok:', JSON.stringify(newlineRows[0][1]))

const run1 = await workspace.runSyntax('FREQUENCIES gender /BARCHART.\nDESCRIPTIVES age score /STATISTICS=MEAN STDDEV MIN MAX.')
console.log('items:', run1.items.map((item) => `${item.kind}:${item.title}`))
console.log('diagnostics:', run1.diagnostics)
if (run1.items[0]?.table) console.log('matrix:', run1.items[0].table.matrix)

const persist = await workspace.runSyntax('COMPUTE age2 = age + 1.\nEXECUTE.', { persist: true })
console.log('after persist variables:', persist.variables.map((variable) => variable.name))
console.log('row sample:', workspace.page(0, 3).rows)

await workspace.exportCsv(join(root, 'out.csv'))
console.log('csv exported')

// A restarted host must find the data and the file it belongs to, instead of
// re-opening the seed path (which for a dropped file is only a copy).
const again = new Workspace({ id: 'smoke', engine, root, config: { timeoutMs: 60000 } })
await again.init()
// This used to only print: a broken restore() (a shell passed to
// reloadFromWork, which called workSav and threw) left the panel empty after a
// host restart and the suite still exited 0.
assert.equal(again.dataset?.rows?.length, 4, 'a new Workspace restores the rows from work.sav')
assert.equal(again.dataset?.sourcePath, workspace.dataset.sourcePath, 'the restored workspace keeps its source path')
// openedAt is what "this table came from the file I opened at 18:40" means; a
// restored workspace used to report null here while still naming the file.
assert.equal(
  again.dataset?.openedAt,
  workspace.dataset.openedAt,
  'the restored workspace keeps the moment its file was read',
)
// The size/mtime travel with it: a table restored from work.sav still says which
// version of the file it was computed from.
assert.equal(again.dataset?.sourceSize, workspace.dataset.sourceSize, 'the restored workspace keeps the source size')
assert.equal(again.dataset?.sourceMtime, workspace.dataset.sourceMtime, 'the restored workspace keeps the source mtime')
assert.equal(again.dataset?.origin, 'file', 'the restored workspace keeps its origin')
console.log('restored dataset:', again.dataset.rows.length, again.dataset.sourcePath, again.dataset.openedAt)

// A dataset built in the panel (pspp_new) has no file. Its name is a label, not
// a path: provenance used to report  sourcePath: "prov-probe"  for it, so the
// panel drew a chip that read like a file name.
await workspace.createDataset({
  name: 'built-in-panel',
  variables: [{ name: 'score', type: 'numeric' }],
  rows: [[1], [2], [3]],
})
const builtStamp = workspace.provenance()
assert.equal(builtStamp.origin, 'new', 'a dataset built from nothing is origin new')
assert.equal(builtStamp.sourcePath, null, 'a built dataset must not claim a source path')
assert.equal(builtStamp.sourceSize, null, 'a built dataset has no source size')
assert.equal(builtStamp.name, 'built-in-panel', 'the name is kept as a label')
assert.ok(typeof builtStamp.openedAt === 'number', 'a built dataset still records when it was created')
// P21: createDataset() wrote work.sav but left dataset.json describing the file
// that had been open before, so a restart stamped the new rows with the old
// file (and its size). The sidecar must follow the data.
const savedMeta = JSON.parse(await readFile(join(workspace.dir, 'dataset.json'), 'utf8'))
assert.equal(savedMeta.origin, 'new', 'the sidecar records a built dataset as built')
assert.equal(savedMeta.sourcePath, null, 'the sidecar must not carry the previous file')
const restarted = new Workspace({ id: workspace.id, engine, root, config: { timeoutMs: 60000 } })
const restoredBuilt = await restarted.restore()
assert.equal(restoredBuilt?.rows?.length, 3, 'a built dataset comes back from work.sav')
assert.equal(restarted.provenance().origin, 'new', 'and it still calls itself built, not a file')
assert.equal(restarted.provenance().sourcePath, null, 'with no file path')
await workspace.open(join(root, 'demo.sav'))

// A dropped file is only a copy: its workspace must come back empty instead of
// silently opening a file the user did not ask for.
const savBytes = (await readFile(join(root, 'demo.sav'))).toString('base64')
const dropped = await workspace.saveUpload('drop.sav', savBytes)
const droppedAgain = await workspace.saveUpload('drop.sav', savBytes)
if (dropped.path === droppedAgain.path) throw new Error('two drops of one name must not share a file')
if (!/^\d{10,}-drop\.sav$/.test(basename(dropped.path))) throw new Error(`upload needs a unique prefix: ${dropped.path}`)
await workspace.open(dropped.path)
if (workspace.dataset.name !== 'drop.sav') throw new Error(`status must show the real name: ${workspace.dataset.name}`)
console.log('upload naming ok:', basename(dropped.path), '->', workspace.dataset.name)
const afterDrop = new Workspace({ id: 'smoke', engine, root, config: { timeoutMs: 60000 } })
await afterDrop.init()
console.log('dropped copy not restored:', afterDrop.dataset === null)

// A syntax file fills the editor and leaves the dataset alone: it must not be
// recorded as the open "file" of this workspace.
const spsPath = join(root, '七题分析语法.sps')
await writeFile(spsPath, 'FREQUENCIES /VARIABLES=gender.\n', 'utf8')
const syntaxResult = await workspace.open(spsPath)
if (syntaxResult?.kind !== 'syntax') throw new Error(`a .sps must open as syntax, got ${JSON.stringify(syntaxResult)}`)
if (!String(syntaxResult.text).includes('FREQUENCIES')) throw new Error('syntax text was not returned')
if (!workspace.dataset) throw new Error('opening syntax must keep the current dataset')
const spsState = workspace.state()
if (spsState.dataset?.sourcePath?.endsWith('.sps')) throw new Error('the syntax file must not become the dataset source')
console.log('sps opens as syntax, dataset kept:', spsState.dataset?.sourcePath?.endsWith('demo.sav'))

// Block paste: everything is validated before anything is written, and the
// whole paste is one undo step.
const beforePaste = workspace.page(0, 2).rows.map((row) => [...row])
workspace.setCells([
  { row: 0, variable: 'score', value: '11' },
  { row: 0, variable: 'age', value: '22' },
  { row: 1, variable: 'score', value: '33' },
])
const afterPaste = workspace.page(0, 2).rows
if (afterPaste[0][workspace.dataset.variables.findIndex((v) => v.name === 'score')] !== 11) throw new Error('paste did not write score')
if (afterPaste[0][workspace.dataset.variables.findIndex((v) => v.name === 'age')] !== 22) throw new Error('paste did not write age')
const blocked = (() => {
  try { workspace.setCells([{ row: 0, variable: 'score', value: '1' }, { row: 0, variable: 'age', value: 'not-a-number' }]) } catch { return true }
  return false
})()
if (!blocked) throw new Error('paste must reject a bad number before writing anything')
const keptScore = workspace.page(0, 1).rows[0][workspace.dataset.variables.findIndex((v) => v.name === 'score')]
if (keptScore !== 11) throw new Error('a rejected paste must not write the valid cells it carried')
workspace.undo()
const undone = workspace.page(0, 2).rows
if (undone[0][workspace.dataset.variables.findIndex((v) => v.name === 'score')] === 11) throw new Error('paste must be one undo step')
console.log('paste block ok:', JSON.stringify(beforePaste[0]), '->', JSON.stringify(afterPaste[0]), 'undo restored')

// Per-item delete: the panel removes one output without touching the data
// or the rest of the log.
const before = workspace.items.length
const doomed = workspace.items[workspace.items.length - 1].id
const removal = workspace.removeOutput(doomed)
if (removal.removed !== 1) throw new Error(`expected one item removed, got ${removal.removed}`)
if (workspace.items.length !== before - 1) throw new Error('removeOutput changed the wrong count')
if (workspace.items.some((item) => item.id === doomed)) throw new Error('removeOutput kept the item')
if (!workspace.dataset) throw new Error('removeOutput must not touch the dataset')
console.log('remove one output ok:', before, '->', workspace.items.length)

// Column alignment and print formats must come back byte-identical after a
// save, otherwise a left-aligned text column turns right on the second open.
await workspace.updateVariable('gender', { alignment: 'left', width: 3 })
await workspace.updateVariable('age', { alignment: 'center' })
const roundTripPath = join(root, 'alignment.sav')
await workspace.save(roundTripPath)
const reread = new Workspace({ id: 'smoke-align', engine, root, config: { timeoutMs: 60000 } })
await reread.open(roundTripPath)
const rereadMap = new Map(reread.dataset.variables.map((variable) => [variable.name, variable]))
for (const [name, alignment] of [['gender', 'left'], ['age', 'center'], ['score', 'right']]) {
  const variable = rereadMap.get(name)
  if (!variable) throw new Error(`save dropped ${name}`)
  if (variable.alignment !== alignment) throw new Error(`${name} alignment became ${variable.alignment}`)
}
if (rereadMap.get('gender').width !== 3) throw new Error(`gender width became ${rereadMap.get('gender').width}`)
if (rereadMap.get('score').decimals !== 1) throw new Error(`score decimals became ${rereadMap.get('score').decimals}`)
console.log('alignment survives save:', reread.dataset.variables.map((variable) => `${variable.name}:${variable.alignment}`).join(' '))

// Idle workspaces drop their dataset so a long-lived dsh does not keep every
// past analysis in memory; the files on disk stay, so the next call reopens.
{
  const registry = new WorkspaceRegistry({ engine, root, config: { timeoutMs: 60000 } })
  const first = await registry.ensure('idle-a')
  await first.createDataset({ variables: [{ name: 'x', type: 'numeric' }], rows: [[1], [2]] })
  const second = await registry.ensure('idle-b')
  await second.createDataset({ variables: [{ name: 'y', type: 'numeric' }], rows: [[3]] })
  registry.active = new Map([['idle-a', 'idle-a']])
  // Pretend nothing was touched for an hour; the active one must survive.
  for (const workspace of registry.list()) workspace.lastUsedAt = Date.now() - 60 * 60 * 1000
  const dropped = await registry.evictIdle({ maxIdleMs: 30 * 60 * 1000 })
  if (!dropped.includes('idle-b')) throw new Error(`evictIdle kept an idle workspace: ${dropped}`)
  if (dropped.includes('idle-a')) throw new Error('evictIdle dropped the workspace on screen')
  if (!registry.get('idle-a').dataset) throw new Error('evictIdle cleared the active dataset')
  const evicted = registry.get('idle-b').dataset
  if (!evicted) throw new Error('evictIdle must keep the session, only the rows go')
  if (evicted.evicted !== true) throw new Error('evictIdle must mark the dataset as released')
  if (evicted.rows.length !== 0) throw new Error('evictIdle must free the case rows')
  if (evicted.variables.length !== 1) throw new Error('evictIdle must keep the variables')
  // The next request has to bring the rows back from work.sav, not just report
  // an empty dataset: that was the bug behind "自动重开不成立".
  const revived = await registry.ensure('idle-b')
  if (revived.dataset.evicted === true) throw new Error('ensure must hydrate a released dataset')
  if (revived.dataset.rows.length !== 1) throw new Error(`hydrate restored ${revived.dataset.rows.length} rows, expected 1`)
  const stats = await revived.runSyntax('DESCRIPTIVES y.', {})
  if (!stats.items?.length) throw new Error('hydrated dataset must still run analysis')
  console.log('idle workspaces release their dataset and hydrate on demand:', dropped.join(','))

  // ensure() must not release the session that is asking for the data: that
  // costs a write of work.sav plus a read back, for nothing.
  const third = await registry.ensure('idle-c')
  await third.createDataset({ variables: [{ name: 'z', type: 'numeric' }], rows: [[7]] })
  for (const workspace of registry.list()) workspace.lastUsedAt = Date.now() - 60 * 60 * 1000
  const kept = await registry.ensure('idle-c')
  if (kept.dataset.rows.length !== 1) throw new Error('ensure must not release the workspace it returns')
  const skipped = await registry.evictIdle({ maxIdleMs: 30 * 60 * 1000, skip: 'idle-c' })
  if (skipped.includes('idle-c')) throw new Error('evictIdle must honour skip')
  if (registry.get('idle-c').dataset.rows.length !== 1) throw new Error('skip must leave the rows alone')
  console.log('ensure and evictIdle skip the session being served')
}

// Saving into a folder the user has not created yet is a normal thing to type
// ("D:\新文件夹\a.sav"). The chart and Office exporters always created the
// missing parents; save/exportCsv/convert did not, and the ENOENT came back as
// "the path is wrong" — a Windows-side self-check hit it on its first day.
{
  const nest = join(root, 'nodir', 'deep')
  await rm(join(root, 'nodir'), { recursive: true, force: true })
  const fresh = new Workspace({ id: 'nodir', engine, root, config: { timeoutMs: 60000 } })
  await fresh.init()
  await fresh.createDataset({ variables: [{ name: 'x', type: 'numeric' }], rows: [[1], [2]] })
  const saved = await fresh.save(join(nest, 'a.sav'))
  if (!(await stat(saved.path)).size) throw new Error('save must write into the folder it just created')
  const csv = await fresh.exportCsv(join(root, 'nodir', 'csv', 'b.csv'))
  if (!(await stat(csv.path)).size) throw new Error('exportCsv must create its parent folder')
  console.log('save and export create the folders they need')
}

// Every read and write goes through resolvePath(), so one guarded test proves
// the whole class: a destination the user never named is refused, and the
// credential directory stays refused even though it sits inside the home
// directory that is allowed by default.
{
  const guarded = new Workspace({ id: 'guard', engine, root, config: { timeoutMs: 60000 } })
  await guarded.init()
  await guarded.createDataset({ variables: [{ name: 'x', type: 'numeric' }], rows: [[1]] })
  const rejected = ['/etc/should-not-be-written.sav', join(homedir(), '.ssh', 'x.sav')]
  for (const target of rejected) {
    let refused = null
    try {
      await guarded.save(target)
    } catch (error) {
      refused = error.message
    }
    if (!refused) throw new Error(`save must refuse ${target}`)
    if (!/允许的目录|不读写这个目录/.test(refused)) throw new Error(`the refusal must explain itself: ${refused}`)
  }
  const allowedTarget = join(root, 'guarded.sav')
  const written = await guarded.save(allowedTarget)
  if (!(await stat(written.path)).size) throw new Error('a path inside the allowed roots still saves')
  console.log('paths outside the whitelist are refused, inside it still work')
}

// Two workspaces count their runs from 1, and the panel session and the tool
// session are different workspaces. They used to write runs/1, runs/2 side by
// side in the same shape, so the second chart overwrote the first one's file.
{
  const panel = new Workspace({ id: 'panel-run', engine, root, config: { timeoutMs: 60000 } })
  const agent = new Workspace({ id: 'agent-run', engine, root, config: { timeoutMs: 60000 } })
  const chartIds = []
  for (const workspace of [panel, agent]) {
    await workspace.init()
    await workspace.createDataset({ variables: [{ name: 'x', type: 'numeric' }], rows: [[1], [2], [3]] })
    await workspace.runSyntax('DESCRIPTIVES /VARIABLES=x.')
    const chart = await workspace.addChart('bar', { variable: 'x', title: workspace.id })
    chartIds.push(chart.runId)
  }
  // Both counters are at the same number on purpose: that is the collision.
  if (chartIds[0] !== chartIds[1]) throw new Error('both workspaces must reach the same run number')
  const first = await panel.artifact(chartIds[0], 'chart.svg')
  const second = await agent.artifact(chartIds[1], 'chart.svg')
  if (!first || !second) throw new Error('each workspace must find its own chart')
  if (first.equals(second)) throw new Error('run 1 of two workspaces must not resolve to the same file')
  if (panel.runDir(chartIds[0]) === agent.runDir(chartIds[1])) throw new Error('the run directories must differ')
  if (!/^\d+-[0-9a-f]{6}$/.test(basename(panel.runDir(chartIds[0])))) throw new Error(`unexpected run directory name ${basename(panel.runDir(chartIds[0]))}`)
  console.log('run directories are unique per workspace:', basename(panel.runDir(chartIds[0])), basename(agent.runDir(chartIds[1])))

  // A run directory written by an older version (no suffix) still resolves.
  const legacy = join(panel.dir, 'runs', '99')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'chart.svg'), '<svg/>')
  const old = await panel.artifact(99, 'chart.svg')
  if (!old || old.toString() !== '<svg/>') throw new Error('a legacy run directory must still be readable')

  // Eviction must leave a workspace alone while a read is in flight.
  panel.inflight = 1
  if (await panel.release()) throw new Error('release must refuse while a request is in flight')
  panel.inflight = 0
  console.log('in-flight work blocks eviction')
}

// Restructuring is plugin-side matrix work, but the result still has to survive
// the trip through work.sav: a generated column name PSPP rejects, or a row
// count that disagrees with the engine, only shows up on the next analysis.
{
  const pivot = new Workspace({ id: 'pivot', engine, root, config: { timeoutMs: 60000 } })
  await pivot.init()
  await pivot.createDataset({ variables: [
    { name: 'g', type: 'string', width: 1, label: '组' },
    { name: 'phase', type: 'string', width: 8, label: '阶段' },
    { name: 'score', type: 'numeric', width: 5, decimals: 1, label: '得分' },
  ] })
  for (const row of [['M', '前测', 70], ['M', '后测', 80], ['F', '前测', 60], ['F', '后测', 90], ['M', '前测', 75]]) {
    pivot.appendCase({ g: row[0], phase: row[1], score: row[2] })
  }
  const wide = pivot.restructureCasesToVars({ id: ['g'], index: 'phase', variables: ['score'] })
  const names = pivot.dataset.variables.map((variable) => variable.name)
  assert.equal(wide.cases, 2)
  assert.equal(wide.created, 2)
  assert.equal(wide.duplicates, 1, 'a repeated identifier+index is counted')
  // '前测'/'后测' cannot appear in a PSPP variable name, so the columns fall
  // back to their position rather than producing a name the engine refuses.
  assert.deepEqual(names, ['g', 'score_v1', 'score_v2'])
  const first = await pivot.runSyntax('DESCRIPTIVES /VARIABLES=score_v1 score_v2.', { persist: true })
  const failed = (first.diagnostics ?? []).find((entry) => entry.severity === 'error')
  if (failed) throw new Error(`the pivoted columns did not survive work.sav: ${failed.message}`)
  assert.equal(pivot.dataset.rows.length, 2)

  const long = pivot.restructureVarsToCases({
    variables: ['score_v1', 'score_v2'],
    id: ['g'],
    target: 'score',
    indexName: 'wave',
    indexValues: 'numbers',
  })
  assert.equal(long.cases, 4)
  assert.deepEqual(pivot.dataset.variables.map((variable) => variable.name), ['g', 'score', 'wave'])
  const second = await pivot.runSyntax('FREQUENCIES /VARIABLES=wave.', { persist: true })
  const secondFailed = (second.diagnostics ?? []).find((entry) => entry.severity === 'error')
  if (secondFailed) throw new Error(`the stacked rows did not survive work.sav: ${secondFailed.message}`)
  assert.equal(pivot.dataset.rows.length, 4)
  console.log('restructuring survives work.sav in both directions:', names.join(','), '->', pivot.dataset.variables.map((variable) => variable.name).join(','))
}

{
  // The crosstab dialog now asks the engine for the whole statistic list it
  // accepts (BTAU, CTAU, D, ETA, UC, RISK, CORR); this proves the keywords are
  // real and that our "you asked but the engine skipped it" note stays quiet
  // when the table is there.
  const xtab = new Workspace({ id: 'xtab', engine, root, config: { timeoutMs: 60000 } })
  await xtab.init()
  await xtab.createDataset({ variables: [
    { name: 'a', type: 'numeric', width: 2, decimals: 0 },
    { name: 'b', type: 'numeric', width: 2, decimals: 0 },
  ] })
  for (const row of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3], [1, 1], [2, 2], [3, 3],
    [1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 1]]) {
    xtab.appendCase({ a: row[0], b: row[1] })
  }
  const run = await xtab.runSyntax('CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ PHI CC LAMBDA UC BTAU CTAU GAMMA D KAPPA ETA CORR /CELLS=COUNT.')
  const errors = (run.diagnostics ?? []).filter((entry) => entry.severity === 'error')
  if (errors.length > 0) throw new Error(`the crosstab statistics were rejected: ${errors[0].message}`)
  const flat = run.items
    .flatMap((item) => (item.table?.matrix ?? []).flat().map((cell) => String(cell ?? '')))
    .join(' | ')
  for (const label of ["Kendall's tau-b", "Kendall's tau-c", "Somers' d", 'Eta', 'Uncertainty Coefficient', 'Lambda', 'Spearman Correlation']) {
    assert.ok(flat.includes(label), `the engine printed ${label}`)
  }
  const complaint = run.items.find((item) => (item.notes ?? []).some((text) => text.includes('引擎没有输出')))
  assert.equal(complaint, undefined, 'nothing is missing when the engine has the table')
  const riskAsked = await xtab.runSyntax('CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ RISK /CELLS=COUNT.')
  const riskNote = riskAsked.items
    .flatMap((item) => item.notes ?? [])
    .find((text) => text.includes('引擎没有输出'))
  assert.ok(riskNote, 'asking for RISK on a 3x3 table is explained, not silently dropped')
  assert.match(riskNote, /RISK/)
  assert.equal(/ETA|BTAU|TAU-C|SOMERS/.test(riskNote), false, 'only the statistic that is really missing is named')
  console.log('crosstab statistics run on the engine:', 'BTAU CTAU D ETA UC RISK CORR'.split(' ').join(','))
}

// ---- standardized values and the full rank vocabulary -----------------------
{
  const ws = new Workspace({ id: 'smoke37', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({
    variables: [{ name: 'x', type: 'numeric', width: 8, decimals: 1 }],
    rows: [[3], [1], [4], [1], [5], [9]],
  })
  await ws.runSyntax('EXECUTE.')
  const saved = await ws.runSyntax('DESCRIPTIVES /VARIABLES=x /STATISTICS=MEAN STDDEV /SAVE.', { persist: true })
  assert.equal(saved.diagnostics.filter((entry) => entry.severity === 'error').length, 0, 'DESCRIPTIVES /SAVE runs')
  const zed = saved.variables.map((variable) => variable.name)
  assert.ok(zed.includes('Zx'), `the standardized value becomes a variable: ${zed.join(',')}`)
  const ranked = await ws.runSyntax(
    'RANK VARIABLES=x /RANK INTO rx /PERCENT INTO p_x /NORMAL INTO z_x /SAVAGE INTO sv_x /NTILES(2) INTO q_x /TIES=MEAN.',
    { persist: true },
  )
  assert.equal(ranked.diagnostics.filter((entry) => entry.severity === 'error').length, 0, 'every rank type runs on the engine')
  const names = ranked.variables.map((variable) => variable.name)
  for (const name of ['rx', 'p_x', 'z_x', 'sv_x', 'q_x']) assert.ok(names.includes(name), `${name} exists`)
  console.log('standardized values and rank types land as variables:', names.filter((name) => /^(Zx|rx|p_x|z_x|sv_x|q_x)$/.test(name)).join(','))
}

// ---- GLM plus the ONEWAY statement that carries the post-hoc tables --------
{
  const ws = new Workspace({ id: 'smoke38', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({
    variables: [
      { name: 'score', type: 'numeric', width: 8, decimals: 1 },
      { name: 'g', type: 'numeric', width: 2, decimals: 0, measure: 'nominal' },
    ],
    rows: [[10, 1], [12, 1], [11, 1], [20, 2], [22, 2], [21, 2], [30, 3], [33, 3], [31, 3]],
  })
  await ws.runSyntax('EXECUTE.')
  const ran = await ws.runSyntax('GLM score BY g /DESIGN=g.\nONEWAY score BY g /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=TUKEY ALPHA(0.05).')
  assert.equal(ran.diagnostics.filter((entry) => entry.severity === 'error').length, 0, 'both statements run')
  const flat = JSON.stringify(ran.items)
  assert.ok(/Tests of Between-Subjects Effects|ANOVA/.test(flat), 'the GLM table is there')
  assert.ok(/Tukey|Multiple Comparisons/.test(flat), 'the post-hoc table comes from ONEWAY')
  console.log('glm post-hoc rides on oneway:', ran.items.map((item) => item.title).join(' | ').slice(0, 120))
}

// ---- the Durbin-Watson table that PSPP never prints ------------------------
{
  const ws = new Workspace({ id: 'smoke39', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  const rows = []
  for (let i = 1; i <= 20; i += 1) rows.push([i + (i % 3 === 0 ? 0.6 : -0.3), i])
  await ws.createDataset({
    variables: [
      { name: 'y', type: 'numeric', width: 8, decimals: 2 },
      { name: 'x', type: 'numeric', width: 8, decimals: 1 },
    ],
    rows,
  })
  await ws.runSyntax('EXECUTE.')
  const ran = await ws.runSyntax('REGRESSION /DEPENDENT=y /METHOD=ENTER x /STATISTICS=COEFF R ANOVA CI(95).', {
    regression: { dependent: 'y', independents: ['x'] },
  })
  assert.equal(ran.diagnostics.filter((entry) => entry.severity === 'error').length, 0, 'the regression runs')
  const dw = ran.items.find((item) => item.title === 'Durbin-Watson（插件计算）')
  assert.ok(dw, 'the DW table is appended even though PSPP prints none')
  const value = Number(dw.table.matrix[1][1])
  assert.ok(value >= 0 && value <= 4, `DW stays in range, got ${value}`)
  assert.ok(dw.table.notes.some((note) => note.includes('5% 界限')), 'with n = 20 the bounds verdict is printed')
  assert.equal(ran.items.some((item) => item.title === '共线性诊断（插件计算）'), true, 'the collinearity table is still there')
  console.log('durbin-watson table, n = 20:', dw.table.matrix[1][1])
}

// ---- duplicate indicators have to survive the trip through work.sav -------
{
  const ws = new Workspace({ id: 'smoke40', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({
    variables: [
      { name: 'id', type: 'numeric', width: 8, decimals: 0 },
      { name: 'score', type: 'numeric', width: 8, decimals: 1 },
    ],
    rows: [[1, 10], [2, 20], [1, 10], [1, 10], [3, 30]],
  })
  await ws.runSyntax('EXECUTE.')
  const report = ws.identifyDuplicates({ variables: ['id', 'score'], indicators: true })
  assert.equal(report.groups, 1, 'one key repeats')
  assert.equal(report.duplicates, 3, 'three rows land in it')
  assert.deepEqual(report.created, ['dupSeq', 'dupLast'])
  // The engine only sees work.sav, so a DESCRIPTIVES that names the new
  // columns proves the host wrote them back in the same shape it drew them.
  const ran = await ws.runSyntax('DESCRIPTIVES /VARIABLES=dupSeq dupLast.')
  assert.equal(ran.diagnostics.filter((entry) => entry.severity === 'error').length, 0, 'the indicator columns reach the engine')
  const flat = JSON.stringify(ran.items)
  assert.ok(/dupSeq/.test(flat) && /dupLast/.test(flat), 'and the descriptives table lists both')
  console.log('duplicate indicators survive work.sav:', report.created.join(', '))
}

// ---- outlier indicators have to survive the trip through work.sav ---------
{
  const ws = new Workspace({ id: 'smoke41', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({
    variables: [
      { name: 'score', type: 'numeric', width: 8, decimals: 1 },
      { name: 'grp', type: 'string', width: 4 },
    ],
    rows: [[5, 'a'], [5, 'a'], [5, 'b'], [5, 'b'], [5, 'a'], [5, 'b'], [100, 'a'], [5, 'b']],
  })
  await ws.runSyntax('EXECUTE.')
  const report = ws.identifyOutliers({ variables: ['score'], percentiles: [10, 90], indicators: true })
  assert.equal(report.flagged, 1, 'one case sits outside the band')
  assert.equal(report.hits, 1)
  assert.deepEqual(report.created, ['outlier', 'outlierN'])
  const ran = await ws.runSyntax('DESCRIPTIVES /VARIABLES=outlier outlierN.')
  assert.equal(ran.diagnostics.filter((entry) => entry.severity === 'error').length, 0, 'the indicator columns reach the engine')
  assert.ok(/outlierN/.test(JSON.stringify(ran.items)), 'and the descriptives table lists them')
  console.log('outlier indicators survive work.sav:', report.created.join(', '))
}

// ---- Influence diagnostics, computed in the plugin ------------------------
{
  const ws = new Workspace({ id: 'smoke0440', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  const rows = []
  for (let i = 1; i <= 12; i += 1) rows.push([2 * i + 1 + (i === 12 ? 25 : 0), i])
  await ws.createDataset({
    variables: [
      { name: 'y', type: 'numeric', width: 8, decimals: 2 },
      { name: 'x', type: 'numeric', width: 4, decimals: 0 },
    ],
    rows,
  })
  await ws.runSyntax('EXECUTE.')
  const ran = await ws.runSyntax('REGRESSION /DEPENDENT=y /METHOD=ENTER x /STATISTICS=COEFF R ANOVA CI(95).', {
    regression: { dependent: 'y', independents: ['x'], influence: true },
  })
  const titles = ran.items.map((item) => item.title)
  assert.ok(titles.some((title) => /影响诊断/.test(title)), `the influence table is appended: ${titles.join(' | ')}`)
  const table = ran.items.find((item) => /影响诊断/.test(item.title))
  assert.equal(table.table.matrix[0][0], '个案号')
  const first = table.table.matrix[1]
  assert.equal(first[0], '12', 'the pulled-away case tops the list')
  assert.ok(Number(first[1]) > 0.15, `its leverage is the largest: ${first[1]}`)
  assert.ok(table.notes.some((note) => /Cook's D > 4\/n/.test(note)), 'the criterion is spelled out')
  console.log('influence diagnostics:', table.table.matrix[1].join(' | '))
}

// ---- the RISK statistic that crashes the engine on a string variable --------
{
  const ws = new Workspace({ id: 'smoke46', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({ variables: [
    { name: 'g', type: 'string', width: 1 },
    { name: 'wave', type: 'numeric', width: 2, decimals: 0 },
  ] })
  for (const [g, wave] of [['M', 1], ['M', 1], ['M', 1], ['M', 2], ['F', 1], ['F', 2], ['F', 2], ['F', 2]]) {
    ws.appendCase({ g, wave })
  }
  // Probed: this exact syntax exits 139 (segfault) and writes no output at all,
  // so the plugin has to keep RISK away from the engine and do the difference
  // itself. A crash here would surface as a thrown "no tables" error.
  const ran = await ws.runSyntax('CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ RISK /CELLS=COUNT.')
  const notes = ran.items.flatMap((item) => [...(item.table?.notes ?? []), ...(item.notes ?? [])])
  assert.ok(notes.some((text) => text.includes('风险差（插件计算）')), 'the difference is computed in the plugin')
  assert.ok(notes.some((text) => text.includes('没有发给引擎')), 'and the dropped statistic is explained')
  const riskNote = notes.find((text) => text.includes('风险差（插件计算）'))
  assert.ok(/0\.500|0\.250|0\.750/.test(riskNote), riskNote)
  console.log('risk on a string grouping variable:', riskNote.slice(0, 60))
}

// ---- GLM contrasts, which ONEWAY carries as well ---------------------------
{
  const ws = new Workspace({ id: 'smoke0430', engine, root, config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({
    variables: [
      { name: 'score', type: 'numeric', width: 8, decimals: 2 },
      { name: 'g', type: 'string', width: 4 },
    ],
    rows: [[10, '1'], [12, '1'], [11, '1'], [13, '1'], [20, '2'], [21, '2'], [19, '2'], [22, '2'], [30, '3'], [29, '3'], [31, '3'], [28, '3']],
  })
  await ws.runSyntax('EXECUTE.')
  const ran = await ws.runSyntax('GLM score BY g /DESIGN=g.\nONEWAY score BY g /CONTRAST=2 -1 -1 /CONTRAST=0 1 -1.')
  const errors = ran.diagnostics.filter((entry) => entry.severity === 'error')
  assert.equal(errors.length, 0, `the contrast syntax has to run: ${JSON.stringify(errors)}`)
  const flat = ran.items.map((item) => item.table?.html ?? JSON.stringify(item.table?.matrix ?? '')).join('\n')
  assert.ok(/Contrast Tests/.test(flat), 'ONEWAY writes a Contrast Tests table')
  assert.ok(/-27\.00/.test(flat), 'the first contrast is -27.00 for this fixture')
  assert.ok(/-9\.00/.test(flat), 'and the second is -9.00')
  console.log('glm contrasts ride on oneway:', ran.items.map((item) => item.title).join(' | ').slice(0, 140))

  // A contrast whose length misses the level count is dropped by the engine;
  // the workspace has to say so instead of returning a clean-looking run.
  const dropped = await ws.runSyntax('ONEWAY score BY g /CONTRAST=1 -1.')
  const notes = dropped.items.flatMap((item) => item.notes ?? [])
  assert.ok(notes.some((note) => /对比被引擎忽略了/.test(note)), `the dropped contrast is named: ${JSON.stringify(notes).slice(0, 200)}`)
  console.log('a dropped contrast is named in the notes')
}

// A PSPP bug banner goes to fd 2 while the `-e` file stays empty, so reading
// only the file used to throw away the one sentence that said "the engine
// crashed". This is the real crash: CROSSTABS RISK on a string grouping
// variable (SIGSEGV on 2.1.3), run through exec on purpose to skip the guard.
{
  const ws = new Workspace({ id: 'smoke-crash', engine, root: join(root, 'crash'), config: { timeoutMs: 60000 } })
  await ws.init()
  await ws.createDataset({
    variables: [
      { name: 'g', type: 'string', width: 4 },
      { name: 'wave', type: 'numeric', width: 2, decimals: 0 },
    ],
    rows: [['A', 1], ['A', 1], ['A', 1], ['A', 2], ['B', 1], ['B', 2], ['B', 2], ['B', 2]],
  })
  await ws.runSyntax('EXECUTE.')
  const crashed = await ws.exec(`GET FILE=${quoteSyntaxPath(ws.dataset.workPath)}.\nCROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ RISK /CELLS=COUNT.`)
  assert.ok(crashed.code !== 0 || crashed.signal, `the engine has to die: code=${crashed.code} signal=${crashed.signal}`)
  assert.match(String(crashed.stderr), /You have discovered a bug in PSPP/i,
    `the banner has to survive exec, got: ${String(crashed.stderr).slice(0, 120)}`)
  const said = describeFailure(crashed)
  assert.match(said, /引擎崩溃/, `the crash has to be named, got: ${said}`)
  assert.match(said, /缺陷/)
  assert.doesNotMatch(said, /build_system|run\.sps/)
  console.log('crash banner survives exec:', said.slice(0, 60))
}

// An empty dataset makes DESCRIPTIVES print nothing, exit 0, no diagnostics.
// The panel used to show an empty run, which reads as "nothing significant".
{
  const blank = new Workspace({ id: 'smoke-empty', engine, root, config: { timeoutMs: 60000 } })
  await blank.init()
  await blank.createDataset({
    name: 'empty',
    variables: [{ name: 'score', type: 'numeric', measure: 'scale' }],
    rows: [],
  })
  let said = ''
  try {
    await blank.runSyntax('DESCRIPTIVES score.')
  } catch (error) {
    said = error.message
  }
  assert.match(said, /0 行/, `empty dataset said: ${said}`)
  console.log('a run on an empty dataset says why nothing came back')

  // Anything reading item.notes (the panel, a tool result, another plugin)
  // should get a list even when a table carries no hints.
  const plainState = workspace.state()
  assert.ok(plainState.items.length > 0, 'the run produced tables')
  assert.ok(plainState.items.every((item) => Array.isArray(item.notes)), 'every table has a notes list')
  console.log('every table in the state carries a notes list')

  // The run response has to agree with the state: a caller that only sees the
  // response should not have to guard for a missing key either.
  assert.ok(run1.items.every((item) => Array.isArray(item.notes)), 'the run response carries notes lists')
  console.log('the run response carries notes lists too')

  // dataset.json is read by the launcher, another panel and restore(): a
  // half-written file does not just fail to parse, it forgets where the numbers
  // came from. It is written to a staging name and renamed.
  {
    const metaPath = join(root, 'smoke', 'dataset.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    assert.ok(typeof meta.caseCount === 'number', 'dataset.json is whole JSON')
    assert.ok(!existsSync(`${metaPath}.tmp`), 'the staging copy does not survive the rename')
    console.log('dataset.json is written whole, without leaving a staging copy')
  }

  // Importing through syntax on an empty dataset is a legitimate data step: it
  // must not be reported as "no cases".
  const csv = join(root, 'import-empty.csv')
  await writeFile(csv, '7\n8\n9\n')
  const imported = await blank.runSyntax(`GET DATA /TYPE=TXT /FILE='${csv}' /VARIABLES=x F8.1.`)
  assert.equal(imported.items.length, 0, 'a data step has no table')
  console.log('a data step on an empty dataset is not called an empty run')

  // The other half of the same rule: when a script both loads data and asks for
  // results, "this dataset has no cases" is the wrong sentence — the engine read
  // a file, not the dataset in memory. Either it produced a table (fine) or it
  // threw the import-specific message, never the dataset one.
  const emptyCsv = join(root, 'import-zero.csv')
  await writeFile(emptyCsv, '')
  let loadSaid = ''
  try {
    const loaded = await blank.runSyntax(`GET DATA /TYPE=TXT /FILE='${emptyCsv}' /VARIABLES=x F8.1.\nDESCRIPTIVES /VARIABLES=x.`)
    assert.ok(Array.isArray(loaded.items), 'a load plus an analysis either returns tables or throws')
  } catch (error) {
    loadSaid = error.message
  }
  assert.doesNotMatch(loadSaid, /这份数据集还没有个案/, `a load must not be blamed on the in-memory dataset, got: ${loadSaid}`)
  assert.doesNotMatch(loadSaid, /筛/, `an empty import must not be blamed on filtering, got: ${loadSaid}`)
  console.log('a load followed by an analysis never blames the in-memory dataset')

  // A data step followed by an analysis on an empty dataset: COMPUTE is legal on
  // zero rows and the engine says nothing, so the branch has to (the output tree
  // would otherwise just be blank).
  let changedSaid = ''
  try {
    await blank.runSyntax('COMPUTE x = score + 1.\nEXECUTE.\nDESCRIPTIVES /VARIABLES=x.')
  } catch (error) {
    changedSaid = error.message
  }
  assert.match(changedSaid, /0 行/, `a data step before an analysis said: ${changedSaid}`)
  assert.doesNotMatch(changedSaid, /筛/, `a data step must not be blamed on filtering: ${changedSaid}`)
  console.log('a data step before an analysis still says the dataset is empty')

  // An import followed by a filter that removes everything is a filtering
  // problem, not an empty file: blaming the file sends the user looking in the
  // wrong place.
  {
    const sav = join(root, 'full.sav')
    {
      // A real .sav with three cases, written through the same path the panel
      // uses, so GET FILE has something non-empty to read.
      const importer = new Workspace({ id: 'smoke-import-filter', engine, root: join(root, 'import-filter'), config: { timeoutMs: 60000 } })
      await importer.init()
      await importer.createDataset({ name: 'full', variables: [{ name: 'score', type: 'numeric', measure: 'scale' }], rows: [[1], [2], [3]] })
      await importer.save(sav)
    }
    const mixed = new Workspace({ id: 'smoke-import-filter2', engine, root: join(root, 'import-filter2'), config: { timeoutMs: 60000 } })
    await mixed.init()
    await mixed.createDataset({ name: 'full', variables: [{ name: 'score', type: 'numeric', measure: 'scale' }], rows: [[1], [2], [3]] })
    let mixedSaid = ''
    try {
      await mixed.runSyntax(`GET FILE='${sav}'.\nSELECT IF score > 999.\nEXECUTE.\nDESCRIPTIVES score.`)
    } catch (error) {
      mixedSaid = error.message
    }
    assert.match(mixedSaid, /筛/, `an import plus a filter must blame the filter: ${mixedSaid}`)
    assert.doesNotMatch(mixedSaid, /导入的那份数据是空的/, `the file is not empty: ${mixedSaid}`)
    console.log('an import followed by a filter is blamed on the filter, not the file')

    // The mirror case: an empty file plus a data step that is not a filter.
    // Blaming "the filter" here sends the user to a script he never wrote.
    const emptySource = join(root, 'empty-import.txt')
    await writeFile(emptySource, '')
    let dataStepSaid = ''
    try {
      await mixed.runSyntax(`GET DATA /TYPE=TXT /FILE='${emptySource}' /VARIABLES=x F8.1.\nCOMPUTE z = 1.\nDESCRIPTIVES /VARIABLES=z.`)
    } catch (error) {
      dataStepSaid = error.message
    }
    assert.match(dataStepSaid, /导入的那份数据是空的/, `an empty file is an empty file: ${dataStepSaid}`)
    assert.doesNotMatch(dataStepSaid, /筛/, `no filter was written: ${dataStepSaid}`)
    console.log('an empty import plus a plain data step is still blamed on the file')
  }

  // Pure data steps on an empty dataset are legitimate and must stay quiet:
  // COMPUTE and SORT are things a user does before there is data.
  for (const dataStep of ['COMPUTE z = 1.', 'SORT CASES BY score (A).']) {
    const quiet = await blank.runSyntax(dataStep)
    assert.equal(quiet.items.length, 0, `${dataStep} produces no table`)
  }
  console.log('compute and sort on an empty dataset are not errors')

  // The rows in memory are not always the rows the engine used: a filter in the
  // same script can leave the engine with nothing while this object still holds
  // three cases. That must not look like "no significant result".
  const filtered = new Workspace({ id: 'smoke-filter', engine, root, config: { timeoutMs: 60000 } })
  await filtered.init()
  await filtered.createDataset({
    name: 'filtered',
    variables: [{ name: 'score', type: 'numeric', measure: 'scale' }],
    rows: [[1], [2], [3]],
  })
  let filterSaid = ''
  try {
    await filtered.runSyntax('SELECT IF score > 999.\nEXECUTE.\nDESCRIPTIVES score.')
  } catch (error) {
    filterSaid = error.message
  }
  assert.match(filterSaid, /筛掉了/, `filtered run said: ${filterSaid}`)
  console.log('a run whose filter removed every case says so')
}

// Two commands on one line: PSPP reads the second as a variable name and
// answers "`a.` is not a variable name" — say what actually happened.
{
  const lines = new Workspace({ id: 'smoke-oneline', engine, root, config: { timeoutMs: 60000 } })
  await lines.init()
  await lines.createDataset({
    name: 'oneline',
    variables: [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }],
    rows: [[1, 2], [3, 5], [4, 7]],
  })
  let said = ''
  try {
    await lines.runSyntax('DESCRIPTIVES a. DESCRIPTIVES b.')
  } catch (error) {
    said = error.message
  }
  assert.match(said, /另起一行/, `one-line run said: ${said}`)
  assert.doesNotMatch(said, /is not a variable name/, `one-line run kept the engine wording: ${said}`)
  const split = await lines.runSyntax('DESCRIPTIVES a.\nDESCRIPTIVES b.')
  assert.equal(split.items.filter((item) => item.kind === 'table').length, 2, 'two lines run as two commands')
  console.log('two commands on one line are explained, and two lines still work')
}

// `END DATA` with a command after it on the same line stops the engine with
// "Missing END DATA while reading inline data" — an English sentence about the
// wrong thing. The check that says "END DATA 必须独占一行" used to sit after the
// branch that reports the engine's own failure, so it never ran.
{
  const tail = new Workspace({ id: 'smoke-tail', engine, root, config: { timeoutMs: 60000 } })
  await tail.init()
  await tail.createDataset({
    name: 'tail',
    variables: [{ name: 'v', type: 'numeric' }],
    rows: [[1], [2], [3]],
  })
  let tailSaid = ''
  try {
    await tail.runSyntax('DATA LIST FREE /v.\nBEGIN DATA\n1\n2\nEND DATA. DESCRIPTIVES VARIABLES=v.')
  } catch (error) {
    tailSaid = error.message
  }
  assert.match(tailSaid, /END DATA 必须独占一行/, `tail said: ${tailSaid}`)
  assert.doesNotMatch(tailSaid, /Missing END DATA/, `tail kept the engine wording: ${tailSaid}`)
  console.log('a command after END DATA is explained in Chinese, not as an inline-data error')
}

// A run can return tables and still have rejected part of the syntax. The panel
// does not show `diagnostics`, so without a note on the first table the result
// reads as a clean run of everything that was pasted.
{
  const banner = new Workspace({ id: 'banner', root: join(root, 'banner'), engine })
  await banner.init()
  await banner.createDataset({
    variables: [{ name: 'a', type: 'numeric', measure: 'scale' }],
    rows: [{ a: 1 }, { a: 2 }, { a: 3 }],
  })
  const run = await banner.runSyntax('DESCRIPTIVES a.\nSORT CASES BY nosuch.')
  assert.ok(run.items.length > 0, 'expected at least one table')
  const notes = run.items.flatMap((item) => item.notes ?? [])
  assert.ok(notes.some((note) => /处错误/.test(note)), `notes: ${JSON.stringify(notes)}`)
  assert.ok(!notes.some((note) => /处错误/.test(note) && /0 处/.test(note)), 'count must not be zero')
  console.log('a partial run says on its first table that part of the syntax was rejected')
}

// Crashes are reported through the exit code and stderr; the core file PSPP
// would otherwise drop into /var/lib/systemd/coredump is noise. The wrapper that
// sets the limit must not touch argv either (spaces and non-ASCII survive).
// Windows has no core-dump mechanism at all, so this assertion can only run
// where `ulimit` exists — say so instead of leaving a log line that never
// appears and has to be explained on every Windows verification.
if (process.platform === 'win32') {
  console.log('Windows has no core dumps: the ulimit and argv checks are skipped there')
}
if (process.platform !== 'win32') {
  const limit = await runProcess('/bin/sh', ['-c', 'ulimit -c'])
  assert.equal(limit.stdout.trim(), '0', `core limit is ${limit.stdout.trim()}`)
  const echo = await runProcess('/bin/sh', ['-c', 'printf "%s|" "$@"', 'x', 'two words', 'ü'])
  assert.equal(echo.stdout, 'two words|ü|', `args came through as ${echo.stdout}`)
  console.log('engine children run without core dumps, argv unchanged')
}

// The four notes below only exist because the plugin reads the engine's tables
// after the fact. A pure-function test can build those tables by hand, but only
// the engine decides what the captions actually look like - `Tests of Normality`,
// `Multiple Comparisons (score)`, `Reliability Statistics` - so each of these
// runs the real thing and then looks for the note.
{
  const notes = await new Workspace({ id: 'smoke-notes', engine, root: join(root, 'notes'), config: { timeoutMs: 60000 } })
  await notes.init()
  await notes.createDataset({
    variables: [
      { name: 'g', type: 'numeric' },
      { name: 'w', type: 'numeric' },
      { name: 'skewed', type: 'numeric' },
      { name: 'flat', type: 'numeric' },
      { name: 'rater1', type: 'numeric' },
      { name: 'rater2', type: 'numeric' },
    ],
  })
  const skewed = [1, 1, 1, 1, 1, 1, 1, 1, 1, 40]
  for (let index = 0; index < skewed.length; index += 1) {
    await notes.appendCase({
      g: index % 2,
      w: index < 5 ? 1 : 0,
      skewed: skewed[index],
      flat: 7,
      rater1: skewed[index],
      rater2: skewed[index] + (index % 3),
    })
  }

  const normality = await notes.runSyntax('EXAMINE VARIABLES=skewed /PLOT=NPPLOT.')
  const normalityNotes = normality.items.flatMap((item) => item.notes ?? []).join('\n')
  assert.match(normalityNotes, /正态性检验：/, `a skewed variable gets a normality note: ${normalityNotes.slice(0, 200)}`)
  console.log('real engine: the normality note lands on the engine caption')

  const crosstab = await notes.runSyntax('CROSSTABS /TABLES=g BY w /STATISTICS=CHISQ.')
  const crosstabNotes = crosstab.items.flatMap((item) => item.notes ?? []).join('\n')
  assert.match(crosstabNotes, /连续性校正/, `a 2x2 table mentions the continuity correction: ${crosstabNotes.slice(0, 200)}`)
  console.log('real engine: the continuity note lands on the chi-square table')

  const regression = await notes.runSyntax('REGRESSION /DEPENDENT=skewed /METHOD=ENTER flat.', {
    regression: { dependent: 'skewed', independents: ['flat'] },
  })
  const coefficientNotes = regression.items.flatMap((item) => item.notes ?? []).join('\n')
  assert.match(coefficientNotes, /系数里有 NaN/, `a constant predictor is reported: ${coefficientNotes.slice(0, 200)}`)
  console.log('real engine: the non-finite coefficient note lands on Coefficients')

  // PSPP computes the ordinal measures itself when asked (tau-b, tau-c, gamma,
  // Somers' d, eta); nothing in the plugin has to reimplement them, but nothing
  // proved they come back either, so the panel's checkboxes rode on faith.
  const ordinal = await notes.runSyntax('CROSSTABS /TABLES=g BY w /STATISTICS=CHISQ GAMMA BTAU CTAU D ETA.')
  const symmetric = ordinal.items.find((item) => /Symmetric Measures/i.test(String(item.table?.caption ?? '')))
  assert.ok(symmetric, 'the ordinal measures table comes back')
  const symmetricText = JSON.stringify(symmetric.table.matrix)
  assert.match(symmetricText, /Kendall's tau-b/, 'tau-b is printed')
  assert.match(symmetricText, /Kendall's tau-c/, 'tau-c is printed')
  assert.match(symmetricText, /Gamma/, 'gamma is printed')
  const directional = ordinal.items.find((item) => /Directional Measures/i.test(String(item.table?.caption ?? '')))
  assert.ok(directional, "Somers' d arrives in its own table")
  assert.match(JSON.stringify(directional.table.matrix), /Somers' d/, "Somers' d is printed")
  assert.match(JSON.stringify(directional.table.matrix), /Eta/, 'eta is printed')
  console.log('real engine: the ordinal measures (tau-b/tau-c/gamma/d/eta) come back')

  const reliability = await notes.runSyntax('RELIABILITY /VARIABLES=rater1 rater2.')
  const icc = reliability.items.find((item) => /组内相关系数/.test(String(item.title ?? '')))
  assert.ok(icc, 'a reliability run appends the ICC block')
  const iccNotes = (icc.notes ?? []).join('\n')
  assert.match(iccNotes, /ICC\(2,1\)/, `the ICC block explains its convention: ${iccNotes.slice(0, 200)}`)
  assert.ok(icc.table.matrix.some((row) => /ICC\(2,1\)/.test(String(row[0]))), 'the ICC table carries the ICC(2,1) row')
  console.log('real engine: reliability gets an ICC block (the GET FILE header no longer blocks it)')
}

// Teardown must not be able to fail the run on its own: on Windows a workspace
// file can still be held for a moment, and an EBUSY here used to exit(1) with
// every assertion already passed — the report showed rc=1 and no failing line.
await rm(root, { recursive: true, force: true }).catch((error) => {
  console.log('teardown warning:', error?.code ?? error?.message ?? error)
})
console.log('smoke finished')
