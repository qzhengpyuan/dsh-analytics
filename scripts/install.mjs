#!/usr/bin/env node
/**
 * Install the latest dsh-analytics release into a DSH profile.
 *
 *   node scripts/install.mjs                # 下载 + 校验 + 打印接下来要执行的两步
 *   node scripts/install.mjs --apply        # 真的装（会装包并改 profile 的 bundles）
 *   node scripts/install.mjs --apply web    # 目标 profile，默认 web
 *   node scripts/install.mjs --offline <tgz>  # 用本地 tgz，不联网
 *
 * 为什么不用 npm：`dsh-analytics` 这个名字在 npm 上已被别的包占用（0.4.0，
 * 2026-08-14 创建），换名字只会把文档拆成两份。分发渠道 = GitHub Release 的 .tgz。
 *
 * 仓库是私有的，所以 API 与资产下载都带 token：先看 GITHUB_TOKEN / GH_TOKEN，
 * 再退到 ~/.dsh/.credentials.yaml 的 refs.GITHUB_TOKEN（与 fetch-engine.mjs 同源）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const REPO = 'qzhengpyuan/dsh-analytics'
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const offlineIndex = argv.indexOf('--offline')
const offline = offlineIndex >= 0 ? argv[offlineIndex + 1] : null
// `--offline <tgz>` takes a value, so that one positional must not be read as
// the profile name. With no --offline there is nothing to skip (index 0 used to
// be dropped unconditionally, which silently ignored `install.mjs web`).
const positional = argv.filter((arg, index) => !arg.startsWith('--') && !(offlineIndex >= 0 && index === offlineIndex + 1))
/**
 * Which profile to install into.
 *
 * It used to be hard-coded to `web`, which is this machine's name for it and
 * not everyone's (the Windows desktop app calls its only profile `desktop`, so
 * the script wrote into a profile that did not exist). An explicit argument
 * still wins; otherwise a lone profile is used, and only when there is exactly
 * one — guessing among several is how you install into the wrong place.
 */
function pickProfile() {
  if (positional[0]) return positional[0]
  const profilesDir = join(homedir(), '.dsh', 'profiles')
  const found = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : []
  if (found.length === 1) return found[0]
  if (found.length === 0) return 'web'
  throw new Error(`这个机器上有多个 profile（${found.join('、')}），请指明要装进哪一个：node scripts/install.mjs <profile> --apply`)
}

const PROFILE = pickProfile()

function token() {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  const store = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(store)) return null
  const text = readFileSync(store, 'utf8')
  const match = text.match(/^\s*GITHUB_TOKEN:\s*(\S+)\s*$/m)
  return match ? match[1].replace(/^['"]|['"]$/g, '') : null
}

const auth = token()
const headers = auth ? { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' }

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (response.status === 404) {
    throw new Error(auth
      ? `GitHub 上取不到 ${path}：仓库私有或 token 没有访问权（检查 refs.GITHUB_TOKEN）`
      : `GitHub 上取不到 ${path}：仓库是私有的，需要 GITHUB_TOKEN（或 ~/.dsh/.credentials.yaml 的 refs.GITHUB_TOKEN）`)
  }
  if (!response.ok) throw new Error(`GitHub API ${path} 返回 ${response.status}`)
  return response.json()
}

async function download(asset, target) {
  const url = `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`
  const response = await fetch(url, { headers: { ...headers, Accept: 'application/octet-stream' } })
  if (!response.ok) throw new Error(`下载 ${asset.name} 失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, buffer)
  return buffer
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

let workDir = null

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-analytics-install-'))
  workDir = work
  let tgz
  let version

  if (offline) {
    tgz = resolve(offline)
    if (!existsSync(tgz)) throw new Error(`找不到 ${tgz}`)
    version = (basename(tgz).match(/dsh-analytics-(\d+\.\d+\.\d+)(?:-[a-z0-9-]+)?\.tgz/) ?? [])[1] ?? 'unknown'
    console.log(`本地包：${tgz}（版本 ${version}）`)
    const digest = sha256(readFileSync(tgz))
    console.log(`sha256：${digest}`)
  } else {
    const release = await api(`/repos/${REPO}/releases/latest`)
    version = release.tag_name.replace(/^v/, '')
    console.log(`最新发布：${release.tag_name}`)
    // Releases carry one tarball per platform (`-linux-x64`, `-win32-x64`, …) and
    // the older ones carried a single plain name: take this machine's build when
    // it is there, and fall back to whatever the release does have.
    const candidates = release.assets.filter((asset) => new RegExp(`^dsh-analytics-${version.replace(/\./g, '\\.')}(?:-[a-z0-9-]+)?\\.tgz$`).test(asset.name))
    if (candidates.length === 0) throw new Error(`${release.tag_name} 没有挂 dsh-analytics-${version}*.tgz（资产：${release.assets.map(a => a.name).join(', ') || '无'}）`)
    const platformSuffix = `-${process.platform}-${process.arch}`
    const tarball = candidates.find((asset) => asset.name.endsWith(`${platformSuffix}.tgz`)) ?? candidates[0]
    tgz = join(work, tarball.name)
    const buffer = await download(tarball, tgz)
    const digest = sha256(buffer)
    const sums = release.assets.find(asset => asset.name === 'SHA256SUMS')
    if (sums) {
      const text = Buffer.from(await download(sums, join(work, 'SHA256SUMS'))).toString('utf8')
      const line = text.split('\n').find(row => row.trim().endsWith(` ${tarball.name}`))
      if (!line) throw new Error(`SHA256SUMS 里没有 ${tarball.name}`)
      const expected = line.split(/\s+/)[0]
      if (expected !== digest) throw new Error(`${tarball.name} 校验和不符：期望 ${expected}，实际 ${digest}`)
      console.log(`sha256：${digest}（与 SHA256SUMS 一致）`)
    } else {
      console.log(`sha256：${digest}（该发布没有 SHA256SUMS 资产，未能自动比对）`)
    }
  }

  const profileJson = join(homedir(), '.dsh', 'profiles', PROFILE, 'package.json')
  console.log()
  console.log(`接下来，对 profile「${PROFILE}」：`)
  console.log(`  dsh plugin --profile ${PROFILE} add file:${tgz}`)
  console.log(`  并把 "dsh-analytics" 加进 ${profileJson} 的 dsh.profile.bundles`)

  if (!APPLY) {
    console.log()
    console.log('（干跑：什么都没改；加 --apply 才会执行上面两步）')
    return
  }

  execFileSync('dsh', ['plugin', '--profile', PROFILE, 'add', `file:${tgz}`], { stdio: 'inherit' })

  if (!existsSync(profileJson)) throw new Error(`找不到 ${profileJson}`)
  const pkg = JSON.parse(readFileSync(profileJson, 'utf8'))
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []
  if (!pkg.dsh.profile.bundles.includes('dsh-analytics')) {
    copyFileSync(profileJson, `${profileJson}.before-dsh-analytics`)
    pkg.dsh.profile.bundles.push('dsh-analytics')
    writeFileSync(profileJson, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log('已把 dsh-analytics 加进 dsh.profile.bundles')
  } else {
    console.log('dsh.profile.bundles 里已经有 dsh-analytics')
  }
  console.log()
  console.log('重载：设置 → 插件 → dsh-analytics 关一次再开（面板里已打开的数据集会清空）')
  console.log('检查：新建会话时预设选择器里应出现「数据分析」')
}

main()
  .catch((error) => {
    console.error(`install failed: ${error.message}`)
    if (/fetch failed|ETIMEDOUT|ENOTFOUND|ECONNRESET/i.test(error.message)) {
      console.error('网络：访问 GitHub 需要代理时，先设 https_proxy 并加 NODE_USE_ENV_PROXY=1（Node 的 fetch 默认不读代理变量）')
    }
    process.exitCode = 1
  })
  .finally(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })
