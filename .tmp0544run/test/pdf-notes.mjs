// A table note has to reach the PDF, not just the script that produced it.
//
// The PDF path replays the analysis with an appended ECHO so PSPP prints the
// notes itself; nothing in JavaScript verifies the result, which is why this
// check reads the PDF back. It needs a PSPP engine and poppler's pdftotext, so
// it runs where both exist (the CI job installs poppler and downloads the
// engine) and skips with a loud line anywhere else.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import assert from 'node:assert'

import { resolveEngine } from '../lib/engine.js'
import { Workspace } from '../lib/workspace.js'

const run = promisify(execFile)

async function hasPdftotext() {
  try {
    await run('pdftotext', ['-v'])
    return true
  } catch {
    return false
  }
}

if (!(await hasPdftotext())) {
  console.log('skip pdf-notes: pdftotext is not installed (apt-get install poppler-utils)')
  process.exit(0)
}

let engine
try {
  engine = resolveEngine()
} catch (error) {
  console.log(`skip pdf-notes: no PSPP engine (${error.message})`)
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'ap-pdf-notes-'))
try {
  const workspace = new Workspace({ id: 'pdf-notes', engine, root, config: { timeoutMs: 120000 } })
  await workspace.init()

  // Six cases where the outcome is predicted perfectly: logistic reports a huge
  // standard error, and annotateSeparation attaches the table note.
  // The cases go in through `createDataset`: assigning `dataset.rows` by hand
  // leaves `dirty` false, so the working file keeps the empty dictionary and
  // the analysis then fails with "the active dataset has not been defined".
  await workspace.createDataset({
    variables: [
      { name: 'y', type: 'numeric', width: 8, decimals: 2 },
      { name: 'score', type: 'numeric', width: 8, decimals: 2 },
    ],
    rows: [[0, 10], [0, 11], [0, 12], [1, 90], [1, 91], [1, 92]],
  })
  await workspace.save(join(root, 'data.sav'))

  const analysis = await workspace.runSyntax('LOGISTIC REGRESSION y WITH score /PRINT=CI(95) SUMMARY.')
  const noted = analysis.items.filter((item) => Array.isArray(item.notes) && item.notes.some((note) => note.includes('分离')))
  assert.ok(noted.length > 0, 'the separation note is attached to the coefficient table')

  const pdf = join(root, 'notes.pdf')
  await workspace.exportDocument(pdf, 'pdf')
  const text = (await run('pdftotext', [pdf, '-'])).stdout
  assert.match(text, /注：/, 'the note survives into the PDF')
  assert.match(text, /Firth/, 'the note keeps its advice')
  assert.match(text, /分离/, 'the note names the reason')

  console.log(`ok  the table note reaches the PDF (${text.length} chars of text)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
