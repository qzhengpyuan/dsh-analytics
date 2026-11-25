// 功效与样本量：判据只用「外部能核对的数」——G*Power / 教科书表上的样本量与
// 临界值，外加单调性与「搜出来的例数再算一次把握度必须真的达标」这类不变量。
import assert from 'node:assert/strict'

import {
  chiSquareCritical, computePower, fCriticalValue, noncentralChiSquareUpper, noncentralFupper,
  powerTable, tCritical,
} from '../lib/power.js'
import { normalCdf, normalQuantile } from '../lib/dist.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const close = (actual, expected, tolerance, what) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} 与 ${expected} 差超过 ${tolerance}`)
}

check('the normal helpers agree with the table', () => {
  close(normalCdf(1.959963984540054), 0.975, 1e-6, 'Φ(1.96)')
  close(normalCdf(-1), 0.158655, 1e-5, 'Φ(-1)')
  close(normalQuantile(0.975), 1.959964, 1e-5, 'z(0.975)')
  close(normalQuantile(0.8), 0.841621, 1e-5, 'z(0.8)')
})

check('critical values match the printed tables', () => {
  close(tCritical(62, 0.05), 1.99897, 1e-4, 't(0.975; 62)')
  close(fCriticalValue(2, 50, 0.05), 3.1826, 1e-3, 'F(0.05; 2, 50)')
  close(chiSquareCritical(1, 0.05), 3.84146, 1e-4, 'χ²(0.95; 1)')
  close(chiSquareCritical(4, 0.05), 9.48773, 1e-3, 'χ²(0.95; 4)')
})

check('with no noncentrality the noncentral distributions are the central ones', () => {
  close(noncentralChiSquareUpper(3.84146, 1, 0), 0.05, 1e-4, 'P(χ²₁ ≥ 3.84)')
  close(noncentralFupper(3.1826, 2, 50, 0), 0.05, 1e-3, 'P(F₂,₅₀ ≥ 3.18)')
})

check('two-sample t with d = 0.5 needs 64 per group', () => {
  // G*Power 给的是 63.77 → 64；课本上常写「每组 64 例」。
  const result = computePower({ method: 'ttest-two', effect: 0.5, mode: 'sample' })
  assert.equal(result.nPerGroup, 64)
  assert.equal(result.total, 128)
  close(result.power, 0.8015, 5e-4, '把握度')
})

check('paired and one-sample t with d = 0.5 need 34', () => {
  // 33.37 → 34。
  assert.equal(computePower({ method: 'ttest-paired', effect: 0.5, mode: 'sample' }).nPerGroup, 34)
  assert.equal(computePower({ method: 'ttest-one', effect: 0.5, mode: 'sample' }).nPerGroup, 34)
})

check('a correlation of 0.3 needs 85 cases', () => {
  // Fisher z：n = ((1.96 + 0.8416) / atanh(0.3))² + 3 = 84.9 → 85。
  const result = computePower({ method: 'correlation', effect: 0.3, mode: 'sample' })
  assert.equal(result.nPerGroup, 85)
  assert.equal(result.total, 85)
})

check('one-way ANOVA with f = 0.25 and three groups needs 53 per group', () => {
  // G*Power：每组 53，合计 159。
  const result = computePower({ method: 'anova', effect: 0.25, groups: 3, mode: 'sample' })
  assert.equal(result.nPerGroup, 53)
  assert.equal(result.total, 159)
})

check('two proportions 0.3 versus 0.5 need about 93 per group', () => {
  const result = computePower({ method: 'proportions', p1: 0.3, p2: 0.5, mode: 'sample' })
  assert.ok(result.nPerGroup >= 88 && result.nPerGroup <= 100, `每组 ${result.nPerGroup}`)
  // 把算出来的例数代回去，把握度必须真的 ≥ 0.80（不能只是「算了个数」）。
  const back = computePower({ method: 'proportions', p1: 0.3, p2: 0.5, mode: 'power', n: result.nPerGroup })
  assert.ok(back.power >= 0.8, `回代把握度 ${back.power}`)
})

check('chi-square with w = 0.3 needs 88 cases', () => {
  const result = computePower({ method: 'chisquare', effect: 0.3, df: 1, mode: 'sample' })
  assert.equal(result.nPerGroup, 88)
  assert.equal(result.total, 88)
})

check('the searched n is the smallest one that reaches the target power', () => {
  for (const plan of [
    { method: 'ttest-two', effect: 0.4 },
    { method: 'anova', effect: 0.3, groups: 4 },
    { method: 'correlation', effect: 0.25 },
  ]) {
    const result = computePower({ ...plan, mode: 'sample' })
    const atN = computePower({ ...plan, mode: 'power', n: result.nPerGroup })
    assert.ok(atN.power >= 0.8, `${plan.method} 在 n=${result.nPerGroup} 只有 ${atN.power}`)
    if (result.nPerGroup > 2) {
      const below = computePower({ ...plan, mode: 'power', n: result.nPerGroup - 1 })
      assert.ok(below.power < 0.8, `${plan.method} 在 n=${result.nPerGroup - 1} 已经 ${below.power}，不是最小值`)
    }
  }
})

check('power rises with n and falls with a smaller effect', () => {
  const small = computePower({ method: 'ttest-two', effect: 0.5, mode: 'power', n: 20 }).power
  const large = computePower({ method: 'ttest-two', effect: 0.5, mode: 'power', n: 80 }).power
  assert.ok(large > small)
  const weak = computePower({ method: 'ttest-two', effect: 0.2, mode: 'sample' }).nPerGroup
  const strong = computePower({ method: 'ttest-two', effect: 0.8, mode: 'sample' }).nPerGroup
  assert.ok(weak > strong, '效应量越小需要的例数越多')
})

check('bad input is refused with what is wrong', () => {
  assert.throws(() => computePower({ method: 'ttest-two', mode: 'sample' }), /效应量/)
  assert.throws(() => computePower({ method: 'ttest-two', effect: 0.5, mode: 'power' }), /每组例数/)
  assert.throws(() => computePower({ method: 'ttest-two', effect: 0.5, alpha: 1.5 }), /α 要在/)
  assert.throws(() => computePower({ method: 'ttest-two', effect: 0.5, power: 0 }), /把握度要在/)
  assert.throws(() => computePower({ method: 'nope', effect: 0.5 }), /没有这个方法/)
  assert.throws(() => computePower({ method: 'proportions', p1: 1.2, p2: 0.5 }), /0 到 1/)
})

check('the panel table carries the numbers and how they were obtained', () => {
  const result = computePower({ method: 'ttest-two', effect: 0.5, mode: 'sample' })
  const table = powerTable(result)
  assert.equal(table.caption, '功效与样本量')
  const byLabel = new Map(table.matrix.map((row) => [row[0], row[1]]))
  assert.equal(byLabel.get('方法'), '独立样本 t 检验（每组相同）')
  assert.equal(byLabel.get('每组例数'), '64')
  assert.equal(byLabel.get('合计例数'), '128')
  assert.equal(byLabel.get('把握度'), '0.801')
  assert.ok(table.notes.some((note) => /α = 0.05/.test(note)))
})

console.log(`\npower: ${checks} checks passed`)
