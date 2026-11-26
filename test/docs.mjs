import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
const check = (name, body) => {
  try {
    body()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}`)
    throw error
  }
}

const DOCS = ['README.md', 'docs/FEATURES.md', 'docs/PLAN.md', 'docs/SCOPE.md', 'docs/HANDOFF.md', 'docs/ROADMAP.md', 'docs/CHANGELOG.md']
const read = (name) => readFileSync(join(root, name), 'utf8')

// 文档反复出现的漂移是「版本戳过期」与「链接指到不存在的文件」两类：前者
// 复验已经抓到过三次（1283/571/1292 那组数字），后者只会在别人点开时才发现。
check('every relative link in the shipped docs points at a file that exists', () => {
  const missing = []
  for (const name of DOCS) {
    const text = read(name)
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      // 只查仓内相对路径：http(s)、锚点、mailto 一律跳过。
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
      const clean = target.split('#')[0]
      if (!clean) continue
      const path = resolve(root, dirname(name), clean)
      if (!existsSync(path)) missing.push(`${name} -> ${target}`)
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'))
})

check('the version stamp in FEATURES matches package.json', () => {
  const version = JSON.parse(read('package.json')).version
  const stamp = read('docs/FEATURES.md').match(/>\s*版本\s*([0-9]+\.[0-9]+\.[0-9]+)/)
  assert.ok(stamp, 'FEATURES.md must carry a 版本 stamp')
  assert.equal(stamp[1], version, `FEATURES says ${stamp[1]}, package.json says ${version}`)
})

check('the changelog opens with the version that is being shipped', () => {
  const version = JSON.parse(read('package.json')).version
  const first = read('docs/CHANGELOG.md').match(/^##\s*([0-9]+\.[0-9]+\.[0-9]+)/)
  assert.ok(first, 'CHANGELOG.md must start with a version heading')
  assert.equal(first[1], version, `CHANGELOG starts at ${first[1]}, package.json says ${version}`)
})

check('PLAN keeps its five sections in order', () => {
  const text = read('docs/PLAN.md')
  const heads = [...text.matchAll(/^##\s+(\d)\./gm)].map((match) => Number(match[1]))
  assert.deepEqual(heads, [0, 1, 2, 3, 4, 5], `PLAN sections: ${heads.join(',')}`)
})

check('SCOPE names the three things a reader asks first', () => {
  const text = read('docs/SCOPE.md')
  for (const topic of ['怎么装', '不能干什么', '怎么验']) {
    assert.ok(text.includes(topic), `SCOPE.md never answers "${topic}"`)
  }
  // 「数据不出本机」是隐私承诺，必须写明，不能只说「本地引擎」。
  assert.match(text, /不发任何数据到外部/)
})

console.log(`\n${checks} checks passed in test/docs.mjs`)
