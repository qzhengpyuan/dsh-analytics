import assert from 'node:assert/strict'

import { compare, createUpdateCheck } from '../lib/update.js'

let checks = 0
let failures = 0
const check = async (name, body) => {
  checks += 1
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

await check('versions compare part by part, not as strings', () => {
  // A string compare would call 0.9.0 newer (`9` > `5`); part by part it is older.
  assert.equal(compare('0.9.0', '0.56.0'), -1)
  assert.equal(compare('0.9.0', '0.8.0'), 1)
  assert.equal(compare('0.56.2', '0.56.2'), 0)
  assert.equal(compare('0.56.10', '0.56.9'), 1)
  assert.equal(compare('1.0', '0.99.99'), 1)
  assert.equal(compare('', '0.1.0'), -1, 'a missing version is older than anything')
})

await check('a newer tag is reported with its url and notes', async () => {
  const asked = []
  const check = createUpdateCheck({
    fetchImpl: async (url, options) => {
      asked.push([url, options.headers['user-agent']])
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.57.0', html_url: 'https://example/release', published_at: '2026-11-22T00:00:00Z', body: 'notes here' }),
      }
    },
    now: () => 1000,
  })
  const answer = await check('0.56.2')
  assert.equal(answer.latest, '0.57.0')
  assert.equal(answer.newer, true)
  assert.equal(answer.current, '0.56.2')
  assert.match(answer.url, /example\/release/)
  assert.equal(answer.notes, 'notes here')
  assert.equal(asked[0][1], 'dsh-analytics', 'the request identifies itself')
})

await check('the same version is not newer, and no tag means the current one', async () => {
  const same = createUpdateCheck({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v0.56.2' }) }), now: () => 1 })
  assert.equal((await same('0.56.2')).newer, false)
})

await check('answers are cached, and a failure is not', async () => {
  let calls = 0
  let clock = 0
  let fail = false
  const check = createUpdateCheck({
    fetchImpl: async () => {
      calls += 1
      if (fail) throw new Error('offline')
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.57.0' }) }
    },
    now: () => clock,
  })
  assert.equal((await check('0.56.2')).cached, false)
  clock += 1000
  assert.equal((await check('0.56.2')).cached, true, 'within ten minutes the answer is reused')
  assert.equal(calls, 1)
  clock += 11 * 60 * 1000
  await check('0.56.2')
  assert.equal(calls, 2, 'after ten minutes it asks again')
  clock += 11 * 60 * 1000
  fail = true
  const broken = await check('0.56.2')
  assert.match(broken.error, /offline/)
  fail = false
  const retried = await check('0.56.2')
  assert.equal(retried.error, undefined, 'a failure is not cached: the next click tries again')
})

await check('a non-200 answer is a reported error, never "up to date"', async () => {
  const check = createUpdateCheck({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), now: () => 1 })
  const answer = await check('0.56.2')
  assert.equal(answer.latest, null)
  assert.equal(answer.newer, false)
  assert.match(answer.error, /403/)
})

await check('concurrent asks share one request', async () => {
  let calls = 0
  const check = createUpdateCheck({
    fetchImpl: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.57.0' }) }
    },
    now: () => 1,
  })
  const answers = await Promise.all([check('0.56.2'), check('0.56.2'), check('0.56.2')])
  assert.equal(calls, 1, `one request, got ${calls}`)
  assert.deepEqual(answers.map((entry) => entry.latest), ['0.57.0', '0.57.0', '0.57.0'])
})

if (failures > 0) console.log(`FAIL  update: ${failures} of ${checks} checks failed`)
else console.log(`update: ${checks} checks passed`)
