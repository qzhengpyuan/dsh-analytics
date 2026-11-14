import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveEngine } from './lib/engine.js'
import { pluginInfo } from './lib/version.js'
import { createHandler } from './lib/routes.js'
import { createTools } from './lib/tools.js'
import { WorkspaceRegistry } from './lib/workspace.js'

export const name = 'dsh-analytics'

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

/** The Host half needs the tool registry; the web carrier is optional. */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {}
  const engine = resolveEngine(settings)
  const dshHome = typeof settings.dataDir === 'string' && settings.dataDir.trim() !== ''
    ? settings.dataDir
    : process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = workspaceRoot(dshHome)

  const registry = new WorkspaceRegistry({
    engine,
    root,
    config: { ...settings, pluginVersion: pluginInfo().version },
    cwdResolver: () => process.cwd(),
  })

  ctx.effect(() => {
    const disposers = createTools({ registry, config: settings }).map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already disposed */ }
      }
    }
  })

  // The web carrier may come up after this plugin: wait for the service instead
  // of silently skipping the routes when `ctx.get('webServer')` is still empty.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    const connection = scoped.get('connection')
    const handler = createHandler({ registry, connection, config: settings })
    console.log(`[dsh-analytics] ${pluginInfo().version} routes ready`)
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
