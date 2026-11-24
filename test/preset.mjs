import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply as applyTools, inject as toolsInject, name as toolsName } from '../tools-entry.js'

let passed = 0
let failed = 0

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}`)
    console.log(`     ${error.message}`)
    process.exitCode = 1
  }
}

/** A stand-in for the cordis context: effect() runs now, register() records. */
function fakeContext(services) {
  const registered = []
  const disposers = []
  return {
    registered,
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {
          registered.splice(registered.indexOf(definition), 1)
        }
      },
    },
    disposeAll: () => disposers.forEach((dispose) => dispose()),
  }
}

const service = {
  registry: { name: 'shared-registry' },
  config: { timeoutMs: 60000, dataDir: '/tmp/analytics' },
  version: '0.0.0-test',
}

await check('the preset-scoped plugin declares the inject list it needs', () => {
  assert.deepEqual([...toolsInject].sort(), ['analytics', 'tools'])
  assert.equal(toolsName, 'dsh-analytics-pspp:tools')
})

await check('the tools mount on the analytics service and reuse its registry', async () => {
  const ctx = fakeContext({ analytics: service })
  applyTools(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(ctx.registered.length, 24, `registered ${ctx.registered.length} tools`)
  assert.ok(ctx.registered.every((definition) => definition.name.startsWith('pspp_')))
  // Every tool closes over the registry the Host half published: the panel and
  // the conversation must edit one dataset, never two that look alike.
  const names = ctx.registered.map((definition) => definition.name)
  assert.ok(names.includes('pspp_status') && names.includes('pspp_analyze'))
})

await check('a missing Host half fails loudly instead of registering nothing', () => {
  const ctx = fakeContext({})
  assert.throws(() => applyTools(ctx, {}), /宿主半/)
})

await check('unmounting removes every tool it registered', async () => {
  const ctx = fakeContext({ analytics: service })
  applyTools(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(ctx.registered.length, 24)
  ctx.disposeAll()
  assert.equal(ctx.registered.length, 0)
})

await check('the bundle patch ships the preset and mounts the scoped tools', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: preset-analytics/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(patch, /id: analytics\b[\s\S]*?registerTools: false/)
  assert.match(patch, /name: 'dsh-analytics-pspp\/tools'/)
  assert.match(patch, /name: 统计分析/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
