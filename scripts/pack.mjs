#!/usr/bin/env node
// Build an installable .tgz without dragging the 23 MB engine along by default.
//
//   node scripts/pack.mjs              portable package: the plugin code only,
//                                      fetches its engine on first run
//   node scripts/pack.mjs --with-engine  self-contained package for this
//                                      machine's platform (what most people want
//                                      on Linux x64)
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const withEngine = process.argv.includes('--with-engine')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const keep = (entry) => entry !== 'engine'
const files = withEngine ? pkg.files : pkg.files.filter(keep)
const platformDir = `${process.platform}-${process.arch}`

if (withEngine) {
  try {
    statSync(join(root, 'engine', platformDir, 'bin'))
  } catch {
    console.error(`no engine/${platformDir} here: run npm run engine:fetch (or bundle-engine) first`)
    process.exit(1)
  }
}

const staging = mkdtempSync(join(tmpdir(), 'analytics-pack-'))
try {
  for (const entry of files) {
    cpSync(join(root, entry), join(staging, entry), { recursive: true, verbatimSymlinks: true })
  }
  // The staged package must not carry the other platforms along: only this
  // machine's engine directory is useful, and it is the only one present.
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ ...pkg, files }, null, 2)}\n`)

  const output = execFileSync('npm', ['pack', '--pack-destination', root, '--silent'], {
    cwd: staging,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim().split('\n').pop()

  // Both flavours share the version, so give the file a suffix that says
  // which one it is instead of letting the second build overwrite the first.
  const suffix = withEngine ? platformDir : 'portable'
  const name = output.replace(/\.tgz$/, `-${suffix}.tgz`)
  const tgz = join(root, name)
  renameSync(join(root, output), tgz)
  const size = statSync(tgz).size
  console.log(`${name}  ${(size / 1024 / 1024).toFixed(1)} MB${withEngine ? ` (engine: ${platformDir})` : ' (portable: needs npm run engine:fetch)'}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
