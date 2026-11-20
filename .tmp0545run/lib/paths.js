/**
 * Which directories the plugin may read from and write to.
 *
 * The panel is a web page served by the host, and every path it takes (open,
 * save, export, merge, convert, the small text readers) used to be accepted as
 * given. That made one mistyped path — or one dataset whose text talks the
 * model into a clever path — enough to read `~/.dsh/.credentials.yaml` (the
 * browser cookie secret and your GitHub token live there) or overwrite any file
 * the user can write. The verifier on the Windows side proved the panel's HTTP
 * surface is reachable with a self-signed cookie, so "only the user types
 * paths" is not a boundary.
 *
 * The rule here is a whitelist with two parts:
 *
 * - defaults: the home directory, the session working directory, the temporary
 *   directory, and (on Linux) `/mnt` and `/tmp`, where data actually lives;
 * - `allowedDirs` in the settings file, for anything else the user wants.
 *
 * Credential directories are refused even if they are inside an allowed root,
 * because `~` is allowed and `~/.dsh` must never be.
 */
import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Directories under the home directory that the plugin never touches. */
export const HARD_DENY_HOME = ['.dsh', '.ssh', '.gnupg']

export function expandHome(raw, home = homedir()) {
  const text = String(raw ?? '').trim()
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(home, text.slice(2))
  return text
}

/** Compare as the platform compares: case-insensitive on Windows. */
function fold(path) {
  const text = String(path)
  return process.platform === 'win32' ? text.toLowerCase() : text
}

function isInside(child, parent) {
  const left = fold(child)
  const right = fold(parent).replace(new RegExp(`\\${sep}+$`), '')
  if (right === '') return true
  return left === right || left.startsWith(`${right}${sep}`)
}

/**
 * Resolve symlinks for the part of the path that exists.
 *
 * A write target usually does not exist yet, so `realpath` would throw; walking
 * up to the nearest existing ancestor still catches the case that matters
 * (`/tmp/link-to-home/.ssh/id_rsa`).
 */
export function realPathOf(target) {
  let current = target
  const rest = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return rest.length > 0 ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return target
      rest.push(basename(current))
      current = parent
    }
  }
}

/** The roots a workspace accepts without any configuration. */
export function defaultRoots(options = {}) {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const roots = [home, cwd, tmpdir()]
  if (process.platform === 'win32') {
    // C:\Temp is where the Windows-side checks and most one-off exports land;
    // %TEMP% is already covered by tmpdir().
    if (existsSync('C:\\Temp')) roots.push('C:\\Temp')
  } else {
    roots.push('/mnt', '/tmp')
  }
  return [...new Set(roots.map((root) => resolve(expandHome(root, home))))]
}

export function rootsFrom(allowedDirs, options = {}) {
  const home = options.home ?? homedir()
  const extra = Array.isArray(allowedDirs) ? allowedDirs : []
  const expanded = extra
    .map((entry) => expandHome(entry, home))
    .filter((entry) => entry !== '')
    .map((entry) => resolve(entry))
  return [...new Set([...defaultRoots(options), ...expanded])]
}

function denyMessage(target, home) {
  const relative = HARD_DENY_HOME.find((name) => isInside(target, join(home, name)))
  if (!relative) return null
  return `${target} 在 ${join(home, relative)} 里面，本插件不读写这个目录`
    + '（里面放的是登录凭据和密钥）。要备份或查看它，请用文件管理器。'
}

/**
 * Check one path and return it resolved (absolute, `~` expanded).
 *
 * Throws a sentence the user can act on: it names the path, the roots that were
 * accepted, and the exact folder to add to the settings page.
 */
export function checkPath(raw, options = {}) {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const label = options.label ?? '路径'
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error(`${label}不能为空`)

  const expanded = expandHome(text, home)
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  const real = realPathOf(target)

  const denied = denyMessage(real, home) ?? denyMessage(target, home)
  if (denied) throw new Error(denied)

  const roots = options.roots ?? rootsFrom(options.allowedDirs, { home, cwd })
  const allowed = roots.some((root) => {
    const realRoot = realPathOf(root)
    return isInside(real, realRoot) || isInside(target, realRoot)
  })
  if (allowed) return target

  const suggestion = dirname(target)
  const shown = roots.slice(0, 6).map((root) => `${root}${sep === '/' ? '/' : '\\'}`).join('、')
  throw new Error(`${label}不在允许的目录里：${target}\n`
    + `现在允许：${shown}\n`
    + `要放开就把它的上级目录加到「设置 → 统计分析 → 允许的目录」，比如 ${suggestion}。`)
}

/** Settings-page shape: keep only absolute, non-credential directories. */
export function normalizeAllowedDirs(value, home = homedir()) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\r\n,;]+/)
      : null
  if (list === null) throw new Error('允许的目录必须是一个字符串数组，或者一行一个目录的文本')
  const out = []
  for (const entry of list) {
    const text = String(entry ?? '').trim()
    if (text === '') continue
    const expanded = expandHome(text, home)
    if (!isAbsolute(expanded)) throw new Error(`允许的目录必须是绝对路径（或以 ~ 开头）：${text}`)
    const target = resolve(expanded)
    const denied = denyMessage(realPathOf(target), home) ?? denyMessage(target, home)
    if (denied) throw new Error(`不能把 ${target} 加进允许的目录：${denied}`)
    if (!out.includes(target)) out.push(target)
  }
  return out
}
