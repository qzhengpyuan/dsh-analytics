/**
 * Panel settings that survive a reload.
 *
 * Until now every knob lived in the profile's `cordis.patch.yml`, so changing
 * the row limit meant editing a YAML patch and restarting the plugin. The few
 * things a user actually wants to turn while working — how many cases the data
 * view loads, how long a run may take, whether the engine runs `--safer` — are
 * kept here instead, in `~/.dsh/analytics/settings.json`.
 *
 * What stays in the patch: `registerTools`. That one decides whether 23 tools
 * leak into every session, so it is a deployment decision, not a preference.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SETTINGS_FILE = 'settings.json'

export const SETTINGS_DEFAULTS = Object.freeze({
  maxRows: 200000,
  timeoutMs: 120000,
  safer: false,
  tableStyle: 'three-line',
})

const TABLE_STYLES = new Set(['three-line', 'grid'])

function integer(name, value, low, high) {
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${name} 必须是整数，收到的是 ${JSON.stringify(value)}`)
  if (number < low || number > high) throw new Error(`${name} 必须在 ${low} 到 ${high} 之间，收到 ${number}`)
  return number
}

/**
 * Coerce one field. Throws a message a panel user can act on: the panel shows
 * it verbatim, so it names the field, the expected range and what it got.
 */
export function normalizeSetting(name, value) {
  switch (name) {
    case 'maxRows':
      return integer('maxRows', value, 1000, 5_000_000)
    case 'timeoutMs':
      return integer('timeoutMs', value, 5000, 1_800_000)
    case 'safer':
      if (typeof value !== 'boolean') throw new Error(`safer 只能是 true 或 false，收到 ${JSON.stringify(value)}`)
      return value
    case 'tableStyle':
      if (!TABLE_STYLES.has(value)) throw new Error(`tableStyle 只能是 three-line 或 grid，收到 ${JSON.stringify(value)}`)
      return value
    default:
      throw new Error(`未知的设置项 ${JSON.stringify(name)}（可用：${Object.keys(SETTINGS_DEFAULTS).join(' ')}）`)
  }
}

/** Validate a patch and merge it over `current`. Unknown keys are an error, not a shrug. */
export function mergeSettings(current, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('设置补丁必须是一个对象，例如 {"maxRows": 5000}')
  }
  const next = { ...current }
  for (const [name, value] of Object.entries(patch)) next[name] = normalizeSetting(name, value)
  return next
}

export function settingsPath(root) {
  return join(root, SETTINGS_FILE)
}

/**
 * Read the file, tolerating both "not created yet" and "hand edited into
 * nonsense": a broken knob must not keep the panel from opening, so each bad
 * field falls back to its default and the reason is reported.
 */
export function readSettings(root) {
  const path = settingsPath(root)
  const problems = []
  let stored = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
      else problems.push('settings.json 不是一个对象，已忽略')
    } catch (error) {
      problems.push(`settings.json 读不出来（${error.message}），已用默认值`)
    }
  }
  const settings = { ...SETTINGS_DEFAULTS }
  for (const [name, value] of Object.entries(stored)) {
    try {
      settings[name] = normalizeSetting(name, value)
    } catch (error) {
      problems.push(error.message)
    }
  }
  return { settings, problems, path, exists: existsSync(path) }
}

/** Write atomically: a half written settings file would reset every knob. */
export function writeSettings(root, settings) {
  const path = settingsPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`)
  renameSync(temp, path)
  return path
}

/**
 * A live view of the settings file for the workspace registry.
 *
 * Workspaces read their config through getters, but they are built once per
 * session; the registry asks this store at creation time so a change reaches the
 * next workspace without a restart. `version` lets a caller skip the read when
 * nothing changed.
 */
export class SettingsStore {
  constructor(root, fallback = {}) {
    this.root = root
    this.fallback = fallback
    this.cached = null
    this.cachedAt = 0
  }

  current() {
    const now = Date.now()
    // The file is tiny; re-stat at most once a second so a hand edit is picked
    // up without a reload, while a burst of requests stays cheap.
    if (this.cached && now - this.cachedAt < 1000) return this.cached
    const { settings } = readSettings(this.root)
    this.cached = settings
    this.cachedAt = now
    return settings
  }

  /** `cordis.patch.yml` wins for deployment switches; settings fill in the rest. */
  merged() {
    return { ...this.fallback, ...this.current() }
  }

  update(patch) {
    const { settings } = readSettings(this.root)
    const next = mergeSettings(settings, patch)
    writeSettings(this.root, next)
    this.cached = next
    this.cachedAt = Date.now()
    return next
  }

  describe() {
    const { settings, problems, path, exists } = readSettings(this.root)
    return {
      settings,
      defaults: { ...SETTINGS_DEFAULTS },
      path,
      exists,
      problems,
      // Named in the panel so nobody hunts for a knob that is not here.
      deploymentOnly: {
        registerTools: {
          value: this.fallback.registerTools === true,
          note: '这个开关决定 pspp_* 工具是否进每个会话，属于部署决定：改 cordis.patch.yml 后停→启插件。',
        },
      },
    }
  }
}
