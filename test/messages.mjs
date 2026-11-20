/**
 * The engine speaks English; the panel is Chinese. These tests pin the part
 * that is easy to get wrong silently: a pattern that stops matching after a
 * PSPP upgrade would leave students with "is not a variable name" and no hint.
 */
import assert from 'node:assert/strict'

import { explainMessage } from '../lib/messages.js'
import { parseDiagnostics } from '../lib/html.js'
import { stripEngineLocation } from '../lib/fserr.js'

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

check('a syntax complaint and a missing file both get a hint', () => {
  assert.ok(explainMessage('T-TEST: Syntax error expecting TESTVAL, GROUPS, PAIRS, VARIABLES, MISSING, or CRITERIA.').includes('语法错误'))
  assert.ok(explainMessage("Could not open `/nonexistent/file.csv' for reading as a data file: 没有那个文件或目录.").includes('文件打不开'))
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

// Windows puts a drive letter and backslashes in front of the file name, and a
// non-greedy prefix used to stop at the drive colon: the whole line fell through
// to `log` and reached the user with the plugin's own temp path in front of it.
check('a Windows path still yields a diagnostic, not a raw log line', () => {
  const { diagnostics, log } = parseDiagnostics(
    'C:\\Users\\me\\.dsh\\analytics\\session-x\\runs\\3\\run.sps:1.1-1.11: error: Syntax error at end of line.\n'
    + 'C:\\Users\\me\\.dsh\\analytics\\session-x\\runs\\3\\run.sps:2: error: Stopping syntax file processing here.',
  )
  assert.equal(diagnostics.length, 1, 'one diagnostic, got ' + diagnostics.length)
  assert.equal(diagnostics[0].message, 'Syntax error at end of line.', 'the message has no path in it')
  assert.equal(log.length, 0, 'and no unparsed line leaks into the log')
})

// The path the engine names is the plugin's own temp file. `message` was fixed
// by parsing, but the "no tables produced" 400 and the free-form fallback went
// out with it, which is the text a user actually reads.
check('the engine location is stripped from any message that leaves the host', () => {
  assert.equal(
    stripEngineLocation('C:\\Users\\q\\.dsh\\analytics\\c2\\runs\\6-8529db\\run.sps:2.1-2.10: error: Unknown command `FREQUENCIS\'.'),
    'Unknown command `FREQUENCIS\'.',
  )
  assert.equal(stripEngineLocation('/home/q/.dsh/analytics/s/runs/3/run.sps:1.1-1.4: error: bad'), 'bad')
  assert.equal(stripEngineLocation('error: the moon is made of cheese'), 'the moon is made of cheese')
  assert.equal(stripEngineLocation('run.sps:1: 警告: 未知命令'), '警告: 未知命令', 'a warning keeps its own label')
})

check('an SPSS command PSPP does not have names the replacement', () => {
  // A student pasting an SPSS tutorial hits these first; "unknown command,
  // check the spelling" sends them looking for a typo that is not there.
  assert.match(explainMessage("error: Unknown command `CODEBOOK'."), /代码本|CODEBOOK/)
  assert.match(explainMessage("error: Unknown command `CODEBOOK'."), /频率/)
  assert.match(explainMessage("error: Unknown command `TABLES'."), /交叉表/)
  assert.match(explainMessage("error: Unknown command `UNIANOVA'."), /单因子/)
  assert.match(explainMessage("error: Unknown command `COXREG'."), /2\.1\.3/)
  // A genuinely misspelled command must keep the generic advice.
  assert.match(explainMessage("error: Unknown command `FREQUENCIS'."), /拼写/)
})

console.log(`messages: ${checks} checks passed`)
