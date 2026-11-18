import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveEngine } from './lib/engine.js'
import { pluginInfo } from './lib/version.js'
import { createHandler } from './lib/routes.js'
import { SettingsStore } from './lib/settings.js'
import { createTools } from './lib/tools.js'
import { WorkspaceRegistry } from './lib/workspace.js'

export const name = 'dsh-analytics-pspp'

// The panel and pspp_status both report the version actually loaded, which is
// the only way to tell "the code changed" from "the process is still running
// the old build" without restarting DSH to find out. lib/version.js reads the
// manifest from disk (keyed by mtime), because the JSON module stays in the
// require cache for the life of the dsh process.

/**
 * The plugin used to be `dsh-analytics-pspp` and kept its workspaces under
 * ~/.dsh/analytics-pspp. Rename that directory once so the existing datasets,
 * uploads and run history stay reachable; if the rename is not possible (read
 * only home, another process using it), keep using the old path instead of
 * losing the data.
 */
function workspaceRoot(dshHome) {
  const current = join(dshHome, 'analytics')
  const legacy = join(dshHome, 'analytics-pspp')
  if (existsSync(current) || !existsSync(legacy)) return current
  try {
    renameSync(legacy, current)
    return current
  } catch {
    return legacy
  }
}

/**
 * The Host half publishes the workspace registry and serves the panel; it does
 * not need the tool registry any more, because the `pspp_*` tools live in the
 * preset-scoped half (`dsh-analytics/tools`).
 */
export const inject = []

export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {}
  const engine = resolveEngine(settings)
  const dshHome = typeof settings.dataDir === 'string' && settings.dataDir.trim() !== ''
    ? settings.dataDir
    : process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = workspaceRoot(dshHome)

  // Panel settings (`maxRows`, `timeoutMs`, `safer`, …) live in a file under the
  // plugin's own root so they survive a reload without touching the profile
  // patch. `registerTools` deliberately stays a patch-only switch.
  const settingsStore = new SettingsStore(root, { registerTools: settings.registerTools === true })

  const registry = new WorkspaceRegistry({
    engine,
    root,
    config: { ...settings, pluginVersion: pluginInfo().version },
    cwdResolver: () => process.cwd(),
    settingsStore,
  })

  /**
   * The tools are mounted by a separate, preset-scoped plugin (`dsh-analytics/tools`)
   * so that a session which never asked for statistics does not pay for 23 tool
   * definitions. The registry has to come from here anyway: the panel and the
   * conversation must edit the same dataset, and two registries would give them
   * two datasets that look identical.
   */
  ctx.provide('analytics', {
    registry,
    engine,
    config: { ...settings, pluginVersion: pluginInfo().version },
    settings: settingsStore,
    version: pluginInfo().version,
  })

  // Escape hatch for installations that predate the preset (or that mount the
  // package without bundle patches): `registerTools: true` keeps the old
  // behaviour of mounting the tools in every session.
  if (settings.registerTools === true) {
    ctx.inject(['tools'], (scoped) => {
      scoped.effect(() => {
        const disposers = createTools({ registry, config: settings }).map((definition) => scoped.tools.register(definition))
        return () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* already disposed */ }
          }
        }
      })
    })
  }

  // The web carrier may come up after this plugin: wait for the service instead
  // of silently skipping the routes when `ctx.get('webServer')` is still empty.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    // Looked up per request: `connection` can arrive after `webServer`, and a
    // handler that captured an empty slot would answer 401 to every call.
    const handler = createHandler({
      registry,
      getConnection: () => scoped.get('connection'),
      config: settings,
      settings: settingsStore,
    })
    console.log(`[dsh-analytics] ${pluginInfo().version} routes ready (registerTools=${settings.registerTools === true})`)
    // Register the current prefix plus the pre-rename one.
    scoped.effect(() => {
      const disposers = ['/analytics', '/analytics-pspp'].map((path) => webServer.register({
        kind: 'prefix',
        path,
        handler: (req, res) => handler(req, res),
      }))
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* already disposed */ }
        }
      }
    })
  })

  return () => {
    /* Registrations are bound to this fiber's effects. */
  }
}
