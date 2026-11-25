// 复现包：判据是「照这个包能不能重跑」—— 数据字典在不在、每次运行的真语法在不在、
// 版本号有没有、日志有没有，以及默认读数不读到刚追加的插件表上。
// 这条套件会 spawn 引擎（建数据集要落 work.sav），所以 CI 里它属于 engine job，
// 不能放进 engine-free 的 pure tests 列表（0.107.0 曾放错，unit 三条腿全红）。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveEngine } from '../lib/engine.js'
import { Workspace } from '../lib/workspace.js'

let checks = 0
const check = async (name, fn) => {
  try {
    await fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const engine = resolveEngine()
const root = await mkdtemp(join(tmpdir(), 'ap-repro-'))
const workspace = new Workspace({ id: 'repro', engine, root, config: { timeoutMs: 60000 } })
await workspace.init()
const rows = Array.from({ length: 20 }, (_, index) => [index % 2 + 1, 10 + index, index])
await workspace.createDataset({
  variables: [
    { name: 'g', type: 'numeric', label: '分组' },
    { name: 'y', type: 'numeric', label: '得分' },
    { name: 'x', type: 'numeric' },
  ],
  rows,
})
const run = await workspace.runSyntax('DESCRIPTIVES y.', { persist: false })
const runId = run.runId ?? workspace.lastRunId

await check('a bundle writes the dictionary, syntax, log and README', async () => {
  const target = join(root, 'bundle')
  const result = await workspace.reproBundle({ path: target })
  assert.equal(result.cases, 20)
  assert.ok(result.runs >= 1)
  for (const name of ['README.md', 'dataset.json', 'log.txt']) {
    assert.ok(existsSync(join(target, name)), `${name} 应该写出来`)
  }
  const dictionary = JSON.parse(readFileSync(join(target, 'dataset.json'), 'utf8'))
  assert.equal(dictionary.cases, 20)
  assert.deepEqual(dictionary.variables.map((entry) => entry.name), ['g', 'y', 'x'])
  assert.equal(dictionary.variables[0].label, '分组')
  assert.match(dictionary.engine ?? '', /PSPP/)
  assert.match(dictionary.plugin ?? '', /^\d+\.\d+\.\d+$/)
  assert.ok(dictionary.runs.some((entry) => entry.runId === runId))
})

await check('the syntax files are the scripts the engine actually got', async () => {
  const target = join(root, 'bundle')
  const files = (await readdir(join(target, 'syntax'))).sort()
  assert.ok(files.length >= 1)
  const script = readFileSync(join(target, 'syntax', files[files.length - 1]), 'utf8')
  // 每次运行都以 GET FILE 打开工作文件开头。
  assert.match(script, /GET FILE=/)
  assert.match(script, /DESCRIPTIVES y\./)
})

await check('the README says how to rerun it', async () => {
  const text = readFileSync(join(root, 'bundle', 'README.md'), 'utf8')
  assert.match(text, /GET FILE/)
  assert.match(text, /按编号顺序/)
  assert.match(text, /dataset\.json/)
})

await check('includeData copies the working file', async () => {
  const target = join(root, 'bundle-data')
  const result = await workspace.reproBundle({ path: target, includeData: true })
  assert.equal(result.datasetFile, 'data.sav')
  assert.ok(existsSync(join(target, 'data.sav')))
  const dictionary = JSON.parse(readFileSync(join(target, 'dataset.json'), 'utf8'))
  assert.equal(dictionary.dataFile, 'data.sav')
})

await check('a missing or empty path is refused', async () => {
  await assert.rejects(() => workspace.reproBundle({}), /给一个目录/)
  await assert.rejects(() => workspace.reproBundle({ path: '   ' }), /给一个目录/)
})

await check('reading the last run does not pick up a plugin table added afterwards', async () => {
  // 体检/建议这类插件表是运行之后追加的，自成一批且 runId 是 null；
  // 默认读数必须仍落在最近一次运行上。
  await workspace.profileData()
  const numbers = workspace.numberReport()
  assert.equal(numbers.runId, runId)
  assert.ok(numbers.tables.some((table) => /Descriptive/.test(table.title ?? '')))
  const sentences = workspace.sentenceReport()
  assert.ok(sentences.sentences.length >= 1)
})

console.log(`\nrepro: ${checks} checks passed`)
