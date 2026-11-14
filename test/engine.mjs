/**
 * Engine resolution: does the plugin pick the right directory for this
 * platform, and does it fall back the way the docs claim?
 *
 * These checks build throw-away directory trees instead of touching the real
 * `engine/`, so they run on a machine without PSPP installed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineEnv, platformDir, resolveEngine } from '../lib/engine.js'

let checks = 0
function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`ok ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const launcher = process.platform === 'win32' ? 'pspp.exe' : 'pspp'
const scratch = mkdtempSync(join(tmpdir(), 'apspp-engine-'))

function makeEngine(root, { platform = null, lib = true } = {}) {
  const base = platform ? join(root, platform) : root
  mkdirSync(join(base, 'bin'), { recursive: true })
  writeFileSync(join(base, 'bin', launcher), '')
  if (lib) mkdirSync(join(base, 'lib'), { recursive: true })
  return base
}

try {
  check('platform directory wins over a flat tree', () => {
    const root = join(scratch, 'both')
    makeEngine(root)
    const platformBase = makeEngine(root, { platform: platformDir })
    const engine = resolveEngine({ engineDir: root })
    if (engine.bin !== join(platformBase, 'bin', launcher)) {
      throw new Error(`picked ${engine.bin}`)
    }
    if (engine.platform !== platformDir) throw new Error(`platform ${engine.platform}`)
    if (engine.source !== 'configured') throw new Error(`source ${engine.source}`)
  })

  check('flat tree still resolves (hand-built prefix)', () => {
    const root = join(scratch, 'flat')
    const base = makeEngine(root)
    const engine = resolveEngine({ engineDir: root })
    if (engine.bin !== join(base, 'bin', launcher)) throw new Error(`picked ${engine.bin}`)
  })

  check('engine directories are reported per tool', () => {
    const root = join(scratch, 'tools')
    const base = makeEngine(root, { platform: platformDir })
    writeFileSync(join(base, 'bin', process.platform === 'win32' ? 'pspp-convert.exe' : 'pspp-convert'), '')
    const engine = resolveEngine({ engineDir: root })
    if (!engine.tools.pspp) throw new Error('missing pspp tool')
    if (!engine.tools['pspp-convert']) throw new Error('missing convert tool')
    if (engine.tools['pspp-output']) throw new Error('invented a missing tool')
  })

  check('a directory without bin/pspp is skipped', () => {
    const empty = join(scratch, 'empty')
    mkdirSync(empty, { recursive: true })
    // A configured directory that holds nothing usable must fall through to the
    // bundled engine, a system install, or "missing" — never to itself.
    const engine = resolveEngine({ engineDir: empty })
    if (engine.bin && engine.bin.startsWith(empty)) throw new Error('used an empty directory')
    if (!['bundled', 'system', 'missing'].includes(engine.source)) {
      throw new Error(`source ${engine.source}`)
    }
  })

  check('library directory is only claimed when it exists', () => {
    const root = join(scratch, 'nolib')
    makeEngine(root, { lib: false })
    const engine = resolveEngine({ engineDir: root })
    if (engine.lib !== null) throw new Error(`lib ${engine.lib}`)
  })

  check('engineEnv puts the library directory on the loader path', () => {
    const separator = process.platform === 'win32' ? ';' : ':'
    const env = engineEnv({ lib: '/opt/pspp/lib' }, { LD_LIBRARY_PATH: '/usr/lib' })
    if (!env.LD_LIBRARY_PATH.startsWith(`/opt/pspp/lib${separator}`)) {
      throw new Error(`LD_LIBRARY_PATH ${env.LD_LIBRARY_PATH}`)
    }
    if (!env.LD_LIBRARY_PATH.includes('/usr/lib')) throw new Error('dropped the inherited path')
    if (env.DYLD_LIBRARY_PATH !== '/opt/pspp/lib') throw new Error(`DYLD_LIBRARY_PATH ${env.DYLD_LIBRARY_PATH}`)
  })

  check('engineEnv leaves the environment alone without libraries', () => {
    const env = engineEnv({ lib: null }, { PATH: '/usr/bin' })
    if (env.LD_LIBRARY_PATH !== undefined) throw new Error('set LD_LIBRARY_PATH anyway')
    if (env.PATH !== '/usr/bin') throw new Error('dropped extra variables')
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`${checks} engine checks passed`)
if (process.exitCode) console.log('(with failures)')
