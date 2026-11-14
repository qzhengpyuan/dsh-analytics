/**
 * The engine speaks English; the panel is Chinese. These tests pin the part
 * that is easy to get wrong silently: a pattern that stops matching after a
 * PSPP upgrade would leave students with "is not a variable name" and no hint.
 */
import assert from 'node:assert/strict'

import { explainMessage } from '../lib/messages.js'
import { parseDiagnostics } from '../lib/html.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
  } catch (error) {
    console.error(`not ok - ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

check('a command without a dataset gets an actionable hint', () => {
  const hint = explainMessage('FREQUENCIES is allowed only after the active dataset has been defined.')
  assert.ok(hint && hint.includes('先打开'))
})

check('an unknown variable is explained', () => {
  assert.ok(explainMessage('SELECT IF: group is not a variable name.').includes('变量名'))
})

check('windows file errors are explained', () => {
  assert.ok(explainMessage("An error occurred while opening 'x.sav': No such file or directory.").includes('路径'))
})

check('an unrecognised message yields no hint', () => {
  assert.equal(explainMessage('the moon is made of cheese'), null)
})

check('an empty message yields no hint', () => {
  assert.equal(explainMessage(''), null)
})

check('diagnostics carry the hint but keep the engine text', () => {
  const { diagnostics } = parseDiagnostics(
    'run.sps:3.1-3.9: error: FREQUENCIES is allowed only after the active dataset has been defined.\n'
    + 'run.sps:4.1-4.4: error: the moon is made of cheese.',
  )
  assert.equal(diagnostics.length, 2)
  assert.match(diagnostics[0].message, /FREQUENCIES is allowed only after/)
  assert.ok(diagnostics[0].hint.includes('先打开'))
  assert.equal(diagnostics[1].hint, null, 'an unknown message keeps hint null instead of guessing')
  assert.equal(diagnostics[0].severity, 'error')
})

console.log(`messages: ${checks} checks passed`)
