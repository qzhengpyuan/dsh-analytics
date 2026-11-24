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

// 0.26.3 shipped a tarball whose bundle patch carried `registerTools: true`,
// which mounts the pspp_* tools in every session instead of only the
// 「统计分析」 preset. Nothing in the unit tests can catch that, because they
// read the working tree, so the pack step checks the bytes it is about to ship.
const shipped = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!/registerTools:\s*false/.test(shipped) || /registerTools:\s*true/.test(shipped)) {
  console.error('cordis.patch.yml must mount the pspp_* tools from the preset only: expected `registerTools: false`')
  process.exit(1)
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
  // Same check on the packaged artefact: the staging copy is what npm packs,
  // but assert on the tarball itself so a stale staging file cannot slip past.
  const packed = execFileSync('tar', ['-xzOf', tgz, 'package/cordis.patch.yml'], { encoding: 'utf8' })
  if (!/registerTools:\s*false/.test(packed) || /registerTools:\s*true/.test(packed)) {
    console.error(`${name} carries a bundle patch that mounts the tools in every session: refusing to call it done`)
    process.exit(1)
  }
  // 校验和是发布产物，不是源码：工作树根写一份就会被 `git add -A` 带进 tag
  // 树，复验时三方比对多出无关差异（Win10 0820 的 P3-1）。
  const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const stray = listing.filter((entry) => /(^|\/)SHA256SUMS/.test(entry))
  if (stray.length > 0) {
    console.error(`${name} carries release artefacts: ${stray.join(', ')} — delete them and repack`)
    process.exit(1)
  }
  const sha = execFileSync('sha256sum', [tgz], { encoding: 'utf8' }).trim().split(/\s+/)[0]
  console.log(`${name}  ${(size / 1024 / 1024).toFixed(1)} MB${withEngine ? ` (engine: ${platformDir})` : ' (portable: needs npm run engine:fetch)'}`)
  console.log(`sha256  ${sha}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
