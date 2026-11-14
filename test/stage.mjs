import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isPlainPath, stageFile, stageInput, stageOutput } from '../lib/stage.js'

/**
 * lib/stage.js exists because the Windows engine cannot open a path that is not
 * plain ASCII: it hands the name to the C runtime in the ANSI code page while
 * the rest of PSPP works in UTF-8, so "No such file or directory" comes back for
 * a file that is right there. The tests below pin the staging contract only —
 * they cannot reproduce the Windows failure itself.
 */

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push(true)
  } catch (error) {
    results.push(false)
    console.error(`not ok - ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const root = join(tmpdir(), `dsh-stage-${process.pid}`)
const cjkDir = join(root, '中文 目录')
const ioDir = join(root, 'io')
await mkdir(cjkDir, { recursive: true })
await writeFile(join(cjkDir, '数据.sav'), 'SAV-BYTES', 'utf8')

await check('ascii paths need no staging', () => {
  assert.equal(isPlainPath('/tmp/a.sav'), true)
  assert.equal(isPlainPath('C:\\psppdata\\a.sav'), true)
})

await check('non-ascii paths are detected', () => {
  assert.equal(isPlainPath('/tmp/数据/表.sav'), false)
  assert.equal(isPlainPath('C:\\psppdata\\中文\\a.sav'), false)
})

const input = await stageInput(join(cjkDir, '数据.sav'), ioDir)
await check('stageInput copies into an ascii path', async () => {
  assert.equal(input.staged, true)
  assert.equal(isPlainPath(input.path), true)
  assert.equal(existsSync(input.path), true)
  assert.equal(await readFile(input.path, 'utf8'), 'SAV-BYTES')
})
await input.dispose()
await check('stageInput cleans its copy up', () => {
  assert.equal(existsSync(input.path), false)
})

const ascii = await stageInput(join(root, 'plain.sav'), ioDir)
await check('ascii input is passed through untouched', () => {
  assert.equal(ascii.staged, false)
  assert.equal(ascii.path, join(root, 'plain.sav'))
})

const output = await stageOutput(join(cjkDir, '结果 数据.sav'), ioDir)
await check('stageOutput writes beside the engine, not in the user folder', () => {
  assert.equal(output.staged, true)
  assert.equal(isPlainPath(output.path), true)
  assert.equal(existsSync(join(cjkDir, '结果 数据.sav')), false)
})
await writeFile(output.path, 'NEW-BYTES', 'utf8')
await output.commit()
await check('commit lands the file at the chinese target and cleans up', async () => {
  assert.equal(await readFile(join(cjkDir, '结果 数据.sav'), 'utf8'), 'NEW-BYTES')
  assert.equal(existsSync(output.path), false)
})

const readWrite = await stageFile(join(cjkDir, '结果 数据.sav'), ioDir)
await writeFile(readWrite.path, 'EDITED', 'utf8')
await readWrite.commit()
await check('stageFile copies edits back over the original', async () => {
  assert.equal(await readFile(join(cjkDir, '结果 数据.sav'), 'utf8'), 'EDITED')
  assert.equal(existsSync(readWrite.path), false)
})

const plainOut = await stageOutput(join(root, 'plain-out.csv'), ioDir)
await check('ascii output is written in place', () => {
  assert.equal(plainOut.staged, false)
  assert.equal(plainOut.path, join(root, 'plain-out.csv'))
})

await rm(root, { recursive: true, force: true })
console.log(`stage: ${results.filter(Boolean).length} checks passed`)
