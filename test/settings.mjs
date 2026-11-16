#!/usr/bin/env node
/**
 * Settings store: defaults, validation, atomic write, and the "a broken file must
 * not keep the panel from opening" rule.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SETTINGS_DEFAULTS, SettingsStore, mergeSettings, readSettings, settingsPath, writeSettings } from '../lib/settings.js'

let checks = 0
let failed = 0
// Awaited one at a time: an async check that is not awaited reports after the
// summary has already printed, which once let a broken assertion exit 0.
async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

async function main() {
const root = mkdtempSync(join(tmpdir(), 'aps-settings-'))

await check('an absent file means defaults, and says the file is not there', () => {
  const seen = readSettings(root)
  assert.deepEqual(seen.settings, { ...SETTINGS_DEFAULTS })
  assert.equal(seen.exists, false)
  assert.deepEqual(seen.problems, [])
})

await check('a saved patch round-trips and reports the file path', () => {
  const saved = writeSettings(root, mergeSettings({ ...SETTINGS_DEFAULTS }, { maxRows: 5000, tableStyle: 'grid' }))
  assert.equal(saved, settingsPath(root))
  const seen = readSettings(root)
  assert.equal(seen.exists, true)
  assert.equal(seen.settings.maxRows, 5000)
  assert.equal(seen.settings.tableStyle, 'grid')
  assert.equal(seen.settings.timeoutMs, SETTINGS_DEFAULTS.timeoutMs)
})

await check('validation names the field and the range', () => {
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, { maxRows: 10 }), /maxRows 必须在 1000 到 5000000 之间/)
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, { timeoutMs: 1.5 }), /timeoutMs 必须是整数/)
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, { decimals: 3 }), /未知的设置项 "decimals"/)
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, { safer: 'yes' }), /safer 只能是 true 或 false/)
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, { tableStyle: 'fancy' }), /tableStyle 只能是/)
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, { nope: 1 }), /未知的设置项 "nope"/)
  assert.throws(() => mergeSettings({ ...SETTINGS_DEFAULTS }, [1]), /必须是一个对象/)
})

await check('a hand-edited file with one bad field keeps the others and explains itself', () => {
  writeFileSync(settingsPath(root), JSON.stringify({ maxRows: 4000, tableStyle: 'nope', safer: true }))
  const seen = readSettings(root)
  assert.equal(seen.settings.maxRows, 4000)
  assert.equal(seen.settings.safer, true)
  assert.equal(seen.settings.tableStyle, SETTINGS_DEFAULTS.tableStyle)
  assert.equal(seen.problems.length, 1)
  assert.match(seen.problems[0], /tableStyle 只能是/)
})

await check('a file that is not JSON falls back to defaults instead of throwing', () => {
  writeFileSync(settingsPath(root), '{maxRows: ')
  const seen = readSettings(root)
  assert.deepEqual(seen.settings, { ...SETTINGS_DEFAULTS })
  assert.match(seen.problems[0], /settings\.json 读不出来/)
})

await check('the store caches for a second and sees a hand edit after that', async () => {
  writeSettings(root, { ...SETTINGS_DEFAULTS, maxRows: 12345 })
  const store = new SettingsStore(root, { registerTools: false })
  assert.equal(store.current().maxRows, 12345)
  writeSettings(root, { ...SETTINGS_DEFAULTS, maxRows: 23456 })
  assert.equal(store.current().maxRows, 12345, 'cached within the same second')
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(store.current().maxRows, 23456)
})

await check('merged() splits the two sources: patch owns the switch, the file owns the knobs', () => {
  const store = new SettingsStore(root, { registerTools: false, maxRows: 1 })
  const merged = store.merged()
  assert.equal(merged.registerTools, false, 'a patch-only key survives')
  assert.equal(merged.maxRows, 23456, 'a stale maxRows in the patch does not beat the file the panel writes')
})

await check('update() writes through and describe() names registerTools as deployment-only', () => {
  const store = new SettingsStore(root, { registerTools: true })
  const saved = store.update({ tableStyle: 'three-line' })
  assert.equal(saved.tableStyle, 'three-line')
  assert.equal(readSettings(root).settings.tableStyle, 'three-line')
  const described = store.describe()
  assert.equal(described.deploymentOnly.registerTools.value, true)
  assert.match(described.deploymentOnly.registerTools.note, /cordis\.patch\.yml/)
  assert.ok(Array.isArray(described.problems))
  assert.equal(described.exists, true)
})

await check('writing leaves no .tmp file behind', () => {
  writeSettings(root, { ...SETTINGS_DEFAULTS })
  assert.equal(existsSync(`${settingsPath(root)}.tmp`), false)
  assert.match(readFileSync(settingsPath(root), 'utf8'), /"maxRows": 200000/)
})

rmSync(root, { recursive: true, force: true })

console.log(`\n${checks - failed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
}

await main()
