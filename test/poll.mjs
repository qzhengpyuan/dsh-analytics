// Polling signature and table provenance: the panel polls a heartbeat while it
// is open, so the signal has to move for every change the panel would draw and
// stay put when nothing happened, and every table has to say which data it came
// from.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveEngine } from '../lib/engine.js'
import { Workspace, WorkspaceRegistry } from '../lib/workspace.js'
import { createHandler } from '../lib/routes.js'

let checks = 0
const pending = []
const check = (name, fn) => {
  const run = (async () => {
    try {
      await fn()
      checks += 1
      console.log(`ok   ${name}`)
    } catch (error) {
      console.error(`FAIL ${name}: ${error.message}`)
      process.exitCode = 1
    }
  })()
  pending.push(run)
  return run
}

const root = await mkdtemp(join(tmpdir(), 'ap-poll-'))
const engine = resolveEngine()
const workspace = new Workspace({ id: 'poll', engine, root, config: { timeoutMs: 60000 } })
await workspace.init()
await workspace.createDataset({
  variables: [
    { name: 'age', type: 'numeric', label: '年龄' },
    { name: 'score', type: 'numeric', label: '得分' },
  ],
})
workspace.appendCase({ age: 23, score: 78.5 })
workspace.appendCase({ age: 31, score: 88 })

const signature = () => JSON.stringify(workspace.signature())

check('the signature stays still while nothing happens', () => {
  const first = workspace.signature()
  const second = workspace.signature()
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

check('the signature carries no matrices and no dictionary', () => {
  const signal = workspace.signature()
  assert.equal(signal.items, 0)
  assert.equal(JSON.stringify(signal).includes('matrix'), false)
  // A dictionary is what made the old poll expensive; only a digest travels.
  assert.equal(typeof signal.dataset.vars, 'string')
  assert.ok(JSON.stringify(signal).length < 1200, `signature is ${JSON.stringify(signal).length} bytes`)
})

check('the signature moves when a cell changes', async () => {
  const before = signature()
  await workspace.setCell(0, 'score', 90)
  assert.notEqual(signature(), before)
})

check('the signature moves when a variable label changes', async () => {
  const before = signature()
  await workspace.updateVariable('score', { label: '总分' })
  assert.notEqual(signature(), before)
})

check('the signature moves when an output item appears', async () => {
  const before = signature()
  workspace.appendItems([{ kind: 'table', title: 'x', table: { caption: 'x', matrix: [] } }])
  assert.notEqual(signature(), before)
})

check('the signature moves when a transform is switched on', async () => {
  const before = signature()
  workspace.splitBy = ['age']
  assert.notEqual(signature(), before)
  workspace.splitBy = null
})

check('every item is stamped with the dataset it came from', () => {
  const [item] = workspace.appendItems([{ kind: 'table', title: 'y', table: { caption: 'y', matrix: [] } }])
  assert.equal(item.provenance.sessionId, 'poll')
  assert.equal(item.provenance.caseCount, 2)
  assert.equal(item.provenance.openedAt, workspace.dataset.openedAt ?? null)
  // A dataset created in the panel has no file on disk; the stamp must say so
  // rather than invent a path.
  assert.equal(item.provenance.sourcePath, null)
})

check('the state carries the signature of the moment it was built', () => {
  const state = workspace.state()
  assert.equal(JSON.stringify(state.signal), JSON.stringify(workspace.signature()))
  assert.deepEqual(state.importNotes, [])
})

// The HTTP half: the heartbeat must not ship the output matrices that made the
// old one-second poll expensive, and must answer 200 with a signal.
const registry = new WorkspaceRegistry({ root: join(root, 'http'), config: {}, engine })
const handler = createHandler({ registry, connection: { requestRejection: () => undefined }, config: {} })

class Res {
  constructor() { this.code = 0; this.headers = {}; this.chunks = [] }
  writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers ?? {}) }
  write(chunk) { this.chunks.push(Buffer.from(chunk)) }
  end(chunk) { if (chunk) this.write(chunk) }
  get body() { return Buffer.concat(this.chunks) }
  get text() { return this.body.toString('utf8') }
}

const call = async (method, url, body) => {
  const payload = body ? JSON.stringify(body) : null
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', 'content-length': payload ? String(Buffer.byteLength(payload)) : '0' },
    [Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload) },
    on() {}, once() {}, removeListener() {},
  }
  const res = new Res()
  await handler(req, res)
  return { code: res.code, text: res.text, json: () => JSON.parse(res.text) }
}

check('api/heartbeat answers with only the signal', async () => {
  const created = await call('POST', '/analytics/api/new', {
    sessionId: 'http-poll',
    cwd: root,
    variables: [{ name: 'age', type: 'numeric', label: '年龄' }],
  })
  assert.equal(created.code, 200)
  const beat = await call('GET', '/analytics/api/heartbeat?sessionId=http-poll')
  assert.equal(beat.code, 200)
  const body = beat.json()
  assert.equal(body.ok, true)
  assert.equal(body.items, undefined)
  assert.equal(body.state, undefined)
  assert.equal(typeof body.signal.dataset.vars, 'string')
  // The full state does carry the items — the panel needs them — so the
  // heartbeat is the only endpoint small enough to poll.
  const full = await call('GET', '/analytics/api/state?sessionId=http-poll')
  assert.equal(full.json().state.items.length, 0)
  assert.equal(typeof full.json().state.signal, 'object')
})

check('a client mutation makes the next heartbeat differ', async () => {
  const before = (await call('GET', '/analytics/api/heartbeat?sessionId=http-poll')).json().signal
  const edited = await call('POST', '/analytics/api/case', { sessionId: 'http-poll', values: { age: 40 } })
  assert.equal(edited.code, 200)
  const after = (await call('GET', '/analytics/api/heartbeat?sessionId=http-poll')).json().signal
  assert.notEqual(JSON.stringify(before), JSON.stringify(after))
  assert.equal(after.dataset.caseCount, 1)
})

check('the import notes travel to the panel', async () => {
  const registry2 = new WorkspaceRegistry({ root: join(root, 'http2'), config: {}, engine })
  const handler2 = createHandler({ registry: registry2, connection: { requestRejection: () => undefined }, config: {} })
  const get2 = async (url) => {
    const req = {
      method: 'GET',
      url,
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () {},
      on() {}, once() {}, removeListener() {},
    }
    const res = new Res()
    await handler2(req, res)
    return { code: res.code, json: () => JSON.parse(res.text) }
  }
  const post = async (url, body) => {
    const payload = JSON.stringify(body)
    const req = {
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload) },
      on() {}, once() {}, removeListener() {},
    }
    const res = new Res()
    await handler2(req, res)
    return { code: res.code, json: () => JSON.parse(res.text) }
  }
  const csvPath = join(root, '中文表头.csv')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(csvPath, '年龄,性别\n23,男\n31,女\n', 'utf8')
  const opened = await post('/analytics/api/open', { sessionId: 'http-poll2', cwd: root, path: csvPath })
  assert.equal(opened.code, 200)
  const state = await get2('/analytics/api/state?sessionId=http-poll2')
  const notes = state.json().state.importNotes
  assert.ok(Array.isArray(notes) && notes.length === 2, `expected two rename notes, got ${JSON.stringify(notes)}`)
  assert.ok(notes.every((note) => /原表头保留为标签/.test(note)))
})

await Promise.all(pending)
console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
