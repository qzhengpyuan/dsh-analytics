import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { resolveEngine } from '../lib/engine.js'
import { Workspace, WorkspaceRegistry } from '../lib/workspace.js'

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
console.log('variables:', back.variables.map((variable) => `${variable.name}:${variable.type}:${variable.label}:${JSON.stringify(variable.valueLabels)}`))

// 值标签往返：更新 -> 存盘 -> 重开，标签必须原样回来
workspace.updateVariable('gender', { valueLabels: { F: '女', M: '男' } })
await workspace.save(join(root, 'demo.sav'))
const relabeled = await workspace.open(join(root, 'demo.sav'))
const genderVar = relabeled.variables.find((variable) => variable.name === 'gender')
if (genderVar?.valueLabels?.F !== '女' || genderVar?.valueLabels?.M !== '男') {
  throw new Error(`value labels did not round-trip: ${JSON.stringify(genderVar?.valueLabels)}`)
}
console.log('value labels ok:', JSON.stringify(genderVar.valueLabels))

// A quoted string may contain a line break (a multi-line address, an open
// answer pasted into a cell). The save path goes through CSV, and PSPP's TXT
// reader cannot carry an embedded newline: three cases came back as four, with
// the value split across rows.
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
console.log('restored dataset:', again.dataset.rows.length, again.dataset.sourcePath, again.dataset.openedAt)

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

await rm(root, { recursive: true, force: true })
