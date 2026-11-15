/**
 * The preset-scoped half: the `pspp_*` tools.
 *
 * Every tool definition costs context in every request of the session that
 * carries it, and analytics is a deliberate activity — nobody wants 23
 * statistics tools in a session about CSS. So the Host half (`dsh-analytics`)
 * owns the engine, the workspace registry and the HTTP API, and this separate
 * plugin mounts the tools. A session only sees them when it runs the
 * `analytics` agent preset, which is declared in the same bundle patch and can
 * be deselected like any other preset.
 *
 * The registry is not created here: it is published by the Host half as the
 * `analytics` service, so the panel and the tools always work on the same
 * dataset. Building a second registry would give the panel and the conversation
 * two different datasets that look alike.
 */
export const name = 'dsh-analytics:tools'

export const inject = ['tools', 'analytics']

export function apply(ctx, config = {}) {
  const service = ctx.get('analytics')
  if (!service || !service.registry) {
    throw new Error('dsh-analytics 的工具需要宿主半（dsh-analytics）先加载：`analytics` 服务不存在')
  }

  // The Host half's own settings (engine timeout, defaults) travel with the
  // service, so the preset row does not have to repeat them and cannot drift.
  const settings = config && typeof config === 'object' && Object.keys(config).length > 0
    ? { ...service.config, ...config }
    : (service.config ?? {})

  ctx.effect(() => {
    // Imported lazily: a session that never selects this preset should not even
    // pay the parse cost of the tool definitions.
    let disposed = false
    const disposers = []
    const load = async () => {
      const { createTools } = await import('./lib/tools.js')
      if (disposed) return
      for (const definition of createTools({ registry: service.registry, config: settings })) {
        disposers.push(ctx.tools.register(definition))
      }
    }
    load().catch((error) => {
      console.error(`[dsh-analytics] 工具注册失败：${error.message}`)
    })
    return () => {
      disposed = true
      for (const dispose of disposers) {
        try { dispose() } catch { /* already disposed */ }
      }
    }
  })

  return () => {
    /* Registrations are bound to this fiber's effects. */
  }
}
