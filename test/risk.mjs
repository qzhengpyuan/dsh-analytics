import assert from 'node:assert'
import { describeRiskDifference, normalQuantile, riskDifferenceCi, wilsonInterval } from '../lib/risk.js'
import { dropRiskOnStrings } from '../lib/workspace.js'

let checks = 0
const pending = []
function check(name, body) {
  try {
    const result = body()
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => {
        checks += 1
        console.log(`ok   ${checks} - ${name}`)
      }, (error) => {
        checks += 1
        process.exitCode = 1
        console.log(`FAIL ${checks} - ${name}: ${error.message}`)
      }))
      return
    }
    checks += 1
    console.log(`ok   ${checks} - ${name}`)
  } catch (error) {
    checks += 1
    process.exitCode = 1
    console.log(`FAIL ${checks} - ${name}: ${error.message}`)
  }
}

check('the normal quantile matches the textbook value', () => {
  assert.equal(normalQuantile(0.975).toFixed(6), '1.959964')
  assert.equal(normalQuantile(0.95).toFixed(4), '1.6449')
  assert.equal(normalQuantile(0.995).toFixed(3), '2.576')
  assert.equal(normalQuantile(0), null)
  assert.equal(normalQuantile(1), null)
})

check('the Wilson interval matches the score interval for one proportion', () => {
  // R: prop.test(56, 70)$conf.int -> 0.6918 0.8770
  const interval = wilsonInterval(56, 70, normalQuantile(0.975))
  assert.equal(interval.low.toFixed(4), '0.6918')
  assert.equal(interval.high.toFixed(4), '0.8770')
  assert.equal(wilsonInterval(0, 10, 1.96).low, 0)
  assert.ok(wilsonInterval(0, 10, 1.96).high > 0, 'a zero cell still gets an upper bound')
  assert.equal(wilsonInterval(0, 0, 1.96), null)
})

check('the risk difference interval reproduces Newcombe (1998) method 10', () => {
  // Newcombe's worked example: 56/70 versus 48/80 -> 0.200 (0.0524, 0.3339).
  const result = riskDifferenceCi(56, 70, 48, 80, 0.95)
  assert.equal(result.difference.toFixed(3), '0.200')
  assert.equal(result.low.toFixed(4), '0.0524')
  assert.equal(result.high.toFixed(4), '0.3339')

  // An interval for the same difference from the other direction is the mirror.
  const mirrored = riskDifferenceCi(48, 80, 56, 70, 0.95)
  assert.equal(mirrored.difference.toFixed(3), '-0.200')
  assert.equal(mirrored.low.toFixed(4), (-0.3339).toFixed(4))
  assert.equal(mirrored.high.toFixed(4), (-0.0524).toFixed(4))

  // A wider level gives a wider interval.
  const ninety = riskDifferenceCi(56, 70, 48, 80, 0.90)
  const ninetyNine = riskDifferenceCi(56, 70, 48, 80, 0.99)
  assert.ok(ninety.low > result.low && ninety.high < result.high, '90% is narrower than 95%')
  assert.ok(ninetyNine.low < result.low && ninetyNine.high > result.high, '99% is wider than 95%')
})

check('the interval survives the cases where a Wald interval collapses', () => {
  // Both groups at 0%: the difference is 0 and the interval is one-sided-ish but real.
  const zero = riskDifferenceCi(0, 10, 0, 10, 0.95)
  assert.equal(zero.difference, 0)
  // No successes in either group is not "certainly no difference": the interval
  // still spans both sides of zero, which is the point of using a score method.
  assert.ok(zero.low < 0 && zero.low > -0.5, `lower bound ${zero.low}`)
  assert.ok(zero.high > 0.2 && zero.high < 0.5, `upper bound ${zero.high}`)
  // Perfect separation stays inside [-1, 1].
  const split = riskDifferenceCi(10, 10, 0, 10, 0.95)
  assert.equal(split.difference, 1)
  assert.ok(split.low > 0.5 && split.low <= 1)
  assert.equal(split.high, 1)
  assert.equal(riskDifferenceCi(1, 0, 2, 5), null)
  assert.equal(riskDifferenceCi(1, 5, 2, 0), null)
})

check('the sentence says which method and both proportions', () => {
  const text = describeRiskDifference(riskDifferenceCi(56, 70, 48, 80, 0.95), { label: '第 1 行 − 第 2 行' })
  assert.ok(text.includes('风险差（插件计算）'), text)
  assert.ok(text.includes('第 1 行 − 第 2 行 = 0.200（0.800 − 0.600）'), text)
  assert.ok(text.includes('95% 置信区间 0.052 ~ 0.334'), text)
  assert.ok(text.includes('Newcombe'), text)
  assert.equal(describeRiskDifference(null), null)
})

check('RISK is kept away from a string grouping variable, which crashes PSPP', () => {
  // Probed against the bundled engine: CROSSTABS with RISK on an A1 variable
  // exits 139 and writes nothing at all, so the statistic has to be dropped
  // before the run rather than reported as "the engine printed nothing".
  const dataset = {
    variables: [{ name: 'g', type: 'string' }, { name: 'wave', type: 'numeric' }],
  }
  const guarded = dropRiskOnStrings('CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ RISK /CELLS=COUNT.', dataset)
  assert.ok(guarded, 'the guard fires')
  assert.deepEqual(guarded.variables, ['G'])
  assert.ok(!/RISK/i.test(guarded.syntax), 'RISK is gone from the syntax')
  assert.match(guarded.syntax, /\/STATISTICS=CHISQ \/CELLS=COUNT\./)

  // Only RISK asked: the empty /STATISTICS= is removed instead of left dangling.
  const only = dropRiskOnStrings('CROSSTABS /TABLES=wave BY g /STATISTICS=RISK.', dataset)
  assert.ok(only)
  assert.ok(!/STATISTICS/i.test(only.syntax), only.syntax)
  assert.match(only.syntax, /^CROSSTABS \/TABLES=wave BY g \s*\.$/)

  // Numeric groupings keep RISK: the engine handles those fine.
  assert.equal(dropRiskOnStrings('CROSSTABS /TABLES=wave BY wave /STATISTICS=RISK.', dataset), null)
  // No RISK asked at all, so nothing to guard.
  assert.equal(dropRiskOnStrings('CROSSTABS /TABLES=g BY wave /STATISTICS=CHISQ.', dataset), null)
  // No dataset to inspect, so leave the syntax alone.
  assert.equal(dropRiskOnStrings('CROSSTABS /TABLES=g BY wave /STATISTICS=RISK.', null), null)
})

Promise.all(pending).then(() => {
  console.log(`\n${checks} checks passed in test/risk.mjs`)
  if (checks < 6) process.exitCode = 1
})
