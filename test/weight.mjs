// The two annotations that explain "why are these numbers zero" have to see the
// script the engine actually ran, not the text the user typed. A WEIGHT BY from
// an earlier run is replayed into that script, so a reader who weighed the data
// and then asked for descriptives must be told about the weight.
//
// This needs the engine: the distinction only shows up across two runs.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../lib/workspace.js'
import { resolveEngine } from '../lib/engine.js'
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
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}

const home = await mkdtemp(join(tmpdir(), 'ap-weight-'))
const settingsStore = new SettingsStore(join(home, 'analytics'), { registerTools: false })
const registry = new WorkspaceRegistry({
  root: join(home, 'analytics'),
  config: {},
  engine: resolveEngine({}),
  settingsStore,
})
const workspace = await registry.ensure('weight')

const csv = join(home, 'w.csv')
await writeFile(csv, 'score,w\n12,0\n18,0\n23,0\n31,0\n')
await workspace.open(csv)

const notesOf = (run) => (run.items ?? []).flatMap((item) => item.notes ?? []).join('\n')

await check('a weight set in an earlier run is named when it zeroes the counts', async () => {
  await workspace.runSyntax('WEIGHT BY w.')
  const run = await workspace.runSyntax('DESCRIPTIVES score.')
  const notes = notesOf(run)
  if (!/加权后有效个案是 0/.test(notes)) {
    throw new Error(`the note does not mention the weight: ${notes || '(no notes)'}`)
  }
  if (/不是权重的问题/.test(notes)) {
    throw new Error(`the note still blames missing values: ${notes}`)
  }
})

console.log(`\nweight: ${passed} checks passed`)
if (failed > 0) process.exit(1)
