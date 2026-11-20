#!/usr/bin/env node
/**
 * Install the prebuilt engine for this machine from a GitHub release.
 *
 * The repository ships `engine/linux-x64/` only; the other platforms are built
 * by `.github/workflows/build-engine.yml` and attached to a release tagged
 * `engine-v*` as `engine-<platform>.tgz`. This script downloads the archive that
 * matches the current machine and unpacks it into `engine/<platform>/`, which is
 * the directory `lib/engine.js` looks for first.
 *
 *   node scripts/fetch-engine.mjs                 # this machine's platform
 *   node scripts/fetch-engine.mjs --platform darwin-arm64
 *   node scripts/fetch-engine.mjs --tag engine-v1 --force
 *
 * A private repository needs a token: either `GITHUB_TOKEN` / `GH_TOKEN` in the
 * environment, or `refs.GITHUB_TOKEN` in `~/.dsh/.credentials.yaml`. Public
 * downloads work without one.
 *
 * Options:
 *   --platform <name>  directory name to install (default: this machine's)
 *   --tag <tag>        release tag (default: `engine-v1`)
 *   --repo <owner/name> defaults to the `repository` field of package.json
 *   --out <dir>        engine root (default `<package>/engine`)
 *   --force            replace an engine that is already present
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`--${name} needs a value`)
    process.exit(1)
  }
  return value
}

const platform = option('platform', `${process.platform}-${process.arch}`)
const tag = option('tag', 'engine-v1')
const engineRoot = resolve(option('out', join(packageRoot, 'engine')))
const target = join(engineRoot, platform)
const force = argv.includes('--force')

/** `https://github.com/owner/name.git` -> `owner/name`. */
function repoFromPackage() {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const match = url && /github\.com[/:]([^/]+\/[^/.#]+)/.exec(url)
  if (!match) return null
  return match[1]
}

const repo = option('repo', repoFromPackage())
if (!repo) {
  console.error('no repository: pass --repo owner/name or add a "repository" field to package.json')
  process.exit(1)
}

/** Token from the environment, else from the harness credential store. */
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  const credentials = join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')
  if (!existsSync(credentials)) return null
  const text = readFileSync(credentials, 'utf8')
  const match = /^\s*GITHUB_TOKEN:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(text)
  return match ? match[1] : null
}

const token = githubToken()
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-analytics-fetch-engine',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

const installed = existsSync(join(target, 'bin', 'pspp')) || existsSync(join(target, 'bin', 'pspp.cmd'))
if (installed && !force) {
  console.log(`engine already present: ${target} (use --force to replace it)`)
  process.exit(0)
}

const assetName = `engine-${platform}.tgz`
console.log(`fetching ${assetName} from ${repo}@${tag}`)

const releaseResponse = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers })
if (!releaseResponse.ok) {
  console.error(`release ${tag} not found (${releaseResponse.status})`)
  console.error('Push a tag matching engine-v* to let the build workflow publish the archives:')
  console.error('  git tag engine-v1 && git push origin engine-v1')
  process.exit(1)
}
const release = await releaseResponse.json()
const asset = (release.assets ?? []).find((entry) => entry.name === assetName)
if (!asset) {
  const names = (release.assets ?? []).map((entry) => entry.name).join(', ') || '(none)'
  console.error(`no ${assetName} in release ${tag}; assets: ${names}`)
  process.exit(1)
}

// The asset API returns a redirect to storage for public repositories and the
// bytes directly when a token is supplied; both are handled by one fetch.
const download = await fetch(asset.url, {
  headers: { ...headers, Accept: 'application/octet-stream' },
  redirect: 'follow',
})
if (!download.ok) {
  console.error(`download failed (${download.status}) — the archive is probably private and no token was found`)
  process.exit(1)
}
const bytes = Buffer.from(await download.arrayBuffer())
console.log(`downloaded ${(bytes.length / 1024 / 1024).toFixed(1)} MB`)

const work = mkdtempSync(join(tmpdir(), 'pspp-engine-'))
const archive = join(work, assetName)
writeFileSync(archive, bytes)

// The archive holds `<platform>/…` at its root. Unpack beside the target and
// only replace the installed engine once the new one is known to be complete,
// so a failed download never leaves the plugin without an engine.
const staged = join(work, 'staged')
mkdirSync(staged, { recursive: true })
execFileSync('tar', ['-xzf', archive, '-C', staged], { stdio: 'inherit' })

const unpacked = join(staged, platform)
const binary = join(unpacked, 'bin', 'pspp')
const windowsBinary = join(unpacked, 'bin', 'pspp.cmd')
if (!existsSync(binary) && !existsSync(windowsBinary)) {
  console.error(`unpacked ${archive} but ${platform}/bin/pspp is missing`)
  process.exit(1)
}
for (const entry of ['lib', 'libexec']) {
  if (!existsSync(join(unpacked, entry))) console.warn(`warning: ${platform}/${entry}/ is missing`)
}

mkdirSync(engineRoot, { recursive: true })
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
cpSync(unpacked, target, { recursive: true, verbatimSymlinks: true })
rmSync(work, { recursive: true, force: true })

console.log(`engine ready: ${target}`)
console.log('restart the plugin (or `pspp_status`) to pick it up.')
