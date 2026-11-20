import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from './lib/workspace.js'
import { resolveEngine } from './lib/engine.js'

const root = await mkdtemp(join(tmpdir(), 'apempty-'))
const reg = new WorkspaceRegistry({ engine: resolveEngine(), root, config: {} })
const ws = await reg.ensure('empty', root)
await ws.createDataset({
  name: 'empty',
  variables: [{ name: 'score', type: 'numeric', measure: 'scale' }],
  rows: [],
})
for (const syntax of ['DESCRIPTIVES score.', 'FREQUENCIES score.', 'T-TEST GROUPS=g(1 2) /VARIABLES=score.']) {
  try {
    const r = await ws.runSyntax(syntax)
    console.log('OK  ', syntax, 'items', r.items.length, 'diag', (r.diagnostics ?? []).length)
  } catch (error) {
    console.log('FAIL', syntax, '->', error.message.slice(0, 120))
  }
}
