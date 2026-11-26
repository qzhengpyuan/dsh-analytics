import assert from 'node:assert/strict'

import { GUIDE_STEPS, findGuideStep, guideList } from '../lib/guide.js'

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

check('every step has an id, a title, a reason and a thing to look at', () => {
  assert.ok(GUIDE_STEPS.length >= 6, `only ${GUIDE_STEPS.length} steps`)
  const ids = new Set()
  for (const step of GUIDE_STEPS) {
    assert.match(step.id, /^[a-z][a-z0-9-]*$/, step.id)
    assert.equal(ids.has(step.id), false, `duplicate id: ${step.id}`)
    ids.add(step.id)
    for (const field of ['title', 'why', 'look']) {
      assert.equal(typeof step[field], 'string', `${step.id}.${field}`)
      assert.ok(step[field].trim().length >= 6, `${step.id}.${field} is too short`)
    }
    assert.ok(['sample', 'syntax', 'compute'].includes(step.kind), `${step.id}: ${step.kind}`)
  }
})

check('a syntax step carries one command that ends with a period', () => {
  const syntaxSteps = GUIDE_STEPS.filter((step) => step.kind === 'syntax')
  assert.equal(syntaxSteps.length, 6, `expected six syntax steps, got ${syntaxSteps.length}`)
  for (const step of syntaxSteps) {
    assert.equal(typeof step.syntax, 'string', step.id)
    assert.match(step.syntax.trim(), /\.$/, `${step.id}: ${step.syntax}`)
    // 一条命令一行：PSPP 不会把两条命令写在同一行里跑。
    assert.equal(step.syntax.trim().includes('\n'), false, `${step.id} packs two commands into one line`)
  }
})

check('steps that do not go through the engine do not pretend to have syntax', () => {
  for (const step of GUIDE_STEPS.filter((entry) => entry.kind !== 'syntax')) {
    assert.equal(step.syntax, undefined, `${step.id} has a syntax it never runs`)
  }
})

check('the plan opens with the sample data and ends with a check-up', () => {
  const list = guideList()
  assert.equal(list[0].id, 'open-sample', 'the first step must make data available')
  assert.equal(list[list.length - 1].id, 'profile', 'the walkthrough ends on the data check-up')
  // 语法步骤必须排在示例数据之后：没有数据集时引擎会报「还没有打开数据集」。
  const sampleIndex = list.findIndex((step) => step.kind === 'sample')
  const firstSyntax = list.findIndex((step) => step.kind === 'syntax')
  assert.ok(sampleIndex >= 0 && sampleIndex < firstSyntax, 'syntax before data')
})

check('the public list is a copy and keeps the syntax for copying', () => {
  const list = guideList()
  assert.equal(list.length, GUIDE_STEPS.length)
  const describe = list.find((step) => step.id === 'describe')
  assert.equal(describe.syntax, 'DESCRIPTIVES salary performance tenure.')
  assert.equal(typeof describe.look, 'string')
  // 改返回值不能改到原始定义。
  describe.syntax = 'BROKEN.'
  assert.equal(findGuideStep('describe').syntax, 'DESCRIPTIVES salary performance tenure.')
})

check('an unknown step names the ones that exist', () => {
  assert.throws(() => findGuideStep('nope'), /没有这一步：nope（可用 open-sample、describe/)
  assert.throws(() => findGuideStep(''), /没有这一步/)
  assert.throws(() => findGuideStep(), /没有这一步/)
})

console.log(`\n${checks} checks passed in test/guide.mjs`)
