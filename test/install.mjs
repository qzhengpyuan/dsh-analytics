import assert from 'node:assert/strict'
import { pickTarball } from '../scripts/install.mjs'

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const asset = (name) => ({ name })

check('the tarball for this platform wins', () => {
  const picked = pickTarball([asset('dsh-analytics-pspp-0.33.1-linux-x64.tgz'), asset('dsh-analytics-pspp-0.33.1-win32-x64.tgz')], 'win32', 'x64')
  assert.equal(picked.name, 'dsh-analytics-pspp-0.33.1-win32-x64.tgz')
})

check('a release without a build for this platform is refused, not guessed', () => {
  assert.throws(
    () => pickTarball([asset('dsh-analytics-pspp-0.33.1-linux-x64.tgz')], 'win32', 'x64'),
    /没有 win32-x64 的包，只有 linux-x64/,
  )
})

check('pre-0.32 plain tarballs are still accepted anywhere', () => {
  assert.equal(pickTarball([asset('dsh-analytics-pspp-0.31.0.tgz')], 'win32', 'x64').name, 'dsh-analytics-pspp-0.31.0.tgz')
})

check('an arm build does not pass for an x64 machine', () => {
  assert.throws(() => pickTarball([asset('dsh-analytics-pspp-0.33.1-linux-arm64.tgz')], 'linux', 'x64'), /只有 linux-arm64/)
})

console.log(`${passed} passed, ${failed} failed`)
