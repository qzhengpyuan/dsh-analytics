#!/usr/bin/env node
/**
 * The path whitelist.
 *
 * These are the cases that decide whether a mistyped path — or a same-origin
 * page that can sign its own cookie — can read `~/.dsh/.credentials.yaml` or
 * write somewhere the user never named. Nothing here needs the engine, so a
 * failure points straight at lib/paths.js.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HARD_DENY_HOME,
  checkPath,
  defaultRoots,
  expandHome,
  normalizeAllowedDirs,
  rootsFrom,
} from '../lib/paths.js'

let checks = 0
let failed = 0
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
  const home = homedir()
  const cwd = mkdtempSync(join(tmpdir(), 'aps-paths-'))

  await check('~ expands to the home directory', () => {
    assert.equal(expandHome('~'), home)
    assert.equal(expandHome('~/数据'), join(home, '数据'))
    assert.equal(expandHome('~x'), '~x', 'only a bare ~ or a ~/ prefix is a home reference')
  })

  await check('the defaults cover home, the session directory and the temp directory', () => {
    const roots = defaultRoots({ home, cwd })
    assert.ok(roots.includes(home))
    assert.ok(roots.includes(cwd))
    assert.ok(roots.includes(tmpdir()))
  })

  await check('data under the allowed roots passes and comes back absolute', () => {
    const inside = join(cwd, 'a.csv')
    assert.equal(checkPath(inside, { home, cwd }), inside)
    assert.equal(checkPath('a.csv', { home, cwd }), inside, 'a relative path resolves against the session directory')
    assert.equal(checkPath(join(home, 'data', 'b.sav'), { home, cwd }), join(home, 'data', 'b.sav'))
  })

  await check('a path outside every root is refused with the folder to whitelist', () => {
    assert.throws(() => checkPath('/etc/passwd', { home, cwd }), (error) => {
      assert.match(error.message, /不在允许的目录里/)
      assert.match(error.message, /\/etc\/passwd/)
      assert.match(error.message, /设置/, 'the message says where to fix it')
      return true
    })
  })

  await check('the credential directories are refused even though home is allowed', () => {
    for (const name of HARD_DENY_HOME) {
      assert.throws(() => checkPath(join(home, name, 'secret'), { home, cwd }), /不读写这个目录/, `${name} must be refused`)
    }
    assert.throws(() => checkPath(join(home, '.dsh', '.credentials.yaml'), { home, cwd }), /不读写这个目录/)
  })

  await check('a symlink into a credential directory is caught', () => {
    const link = join(cwd, 'innocent')
    try {
      symlinkSync(join(home, '.ssh'), link)
    } catch {
      return // no symlink permission on this platform: nothing to prove
    }
    try {
      assert.throws(() => checkPath(join(link, 'id_rsa'), { home, cwd }), /不读写这个目录/)
    } finally {
      rmSync(link, { force: true })
    }
  })

  await check('a ~-style path in allowedDirs is expanded and accepted', () => {
    const extra = join(cwd, 'shared')
    mkdirSync(extra, { recursive: true })
    const roots = rootsFrom(['~/shared-not-here', extra], { home, cwd })
    assert.ok(roots.includes(extra))
    assert.equal(checkPath(join(extra, 'a.csv'), { home, cwd, allowedDirs: [extra] }), join(extra, 'a.csv'))
  })

  await check('allowedDirs cannot buy access to a credential directory', () => {
    assert.throws(() => normalizeAllowedDirs([join(home, '.ssh')], home), /不能把/)
    assert.throws(() => normalizeAllowedDirs([join(home, '.dsh', 'analytics')], home), /不能把/)
  })

  await check('allowedDirs accepts lines or an array, and rejects relative entries', () => {
    assert.deepEqual(normalizeAllowedDirs('', home), [])
    assert.deepEqual(normalizeAllowedDirs('/mnt/F/a\n/mnt/F/b', home), ['/mnt/F/a', '/mnt/F/b'])
    assert.deepEqual(normalizeAllowedDirs(['/mnt/F/a', '', ' ', '/mnt/F/a'], home), ['/mnt/F/a'], 'duplicates collapse')
    assert.throws(() => normalizeAllowedDirs(['relative/dir'], home), /绝对路径/)
    assert.throws(() => normalizeAllowedDirs(42, home), /字符串数组/)
  })

  await check('an empty path is refused rather than treated as the session directory', () => {
    assert.throws(() => checkPath('', { home, cwd }), /不能为空/)
    assert.throws(() => checkPath('   ', { home, cwd }), /不能为空/)
  })

  rmSync(cwd, { recursive: true, force: true })
  console.log(`\n${checks - failed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
