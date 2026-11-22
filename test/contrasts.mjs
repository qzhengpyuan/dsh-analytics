// Custom contrasts on a multi-factor design (lib/contrasts.js).
//
// PSPP 2.1.3's GLM has no /CONTRAST and no /POSTHOC, so a two-factor model with
// interactions can only be tested here — there is no engine table to compare
// against. The reference numbers therefore come from R 4.4.3 run on this box:
// `lm(y ~ a*b)` followed by `car::linearHypothesis`. The R script and its full
// output are kept with the report at
// /mnt/E/临时文件/glm-r-check.R and /mnt/E/临时文件/glm-r-out.txt; each check
// below quotes the line it asserts against.
import assert from 'node:assert'
import { describeContrasts, designColumns, generalLinearTest } from '../lib/contrasts.js'

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
        console.log(`FAIL  ${name}: ${error.message}`)
      }))
      return
    }
    checks += 1
    console.log(`ok   ${checks} - ${name}`)
  } catch (error) {
    checks += 1
    process.exitCode = 1
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Number.isFinite(actual), `不是有限数：${actual}`)
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} 与参考值 ${expected} 相差超过 ${tolerance}`)
}

/**
 * L vector by column name, so a check reads as the hypothesis a user would type.
 * Columns that are not mentioned stay 0.
 */
function vector(model, entries) {
  const out = new Array(model.names.length).fill(0)
  for (const [name, value] of Object.entries(entries)) {
    const at = model.names.indexOf(name)
    assert.ok(at >= 0, `设计矩阵里没有 ${name}（现有 ${model.names.join('、')}）`)
    out[at] = value
  }
  return out
}

const numeric = (name, extra = {}) => ({ name, type: 'numeric', missing: [], ...extra })
const string = (name, extra = {}) => ({ name, type: 'string', missing: [], ...extra })

// ---- fixture 1: the R data set, a in {1,2,3}, b in {1,2}, unequal cells ----
// R: cells c(1,1,4) c(1,2,3) c(2,1,3) c(2,2,5) c(3,1,3) c(3,2,4), n = 22
const A = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3]
const B = [1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2]
const Y = [
  9.9792917074, 10.1428364972, 8.7876734994, 10.2433874925, 10.9427412470, 13.2898759796,
  13.2439484180, 9.5367490048, 10.9525091799, 13.0226233279, 16.5721582231, 15.7026120260,
  16.0552459566, 15.9856949162, 18.0016823035, 14.4837045305, 13.1129009218, 13.8625898971,
  13.7163615137, 14.0284416744, 12.7951754986, 13.6791246190,
]
const dataset = {
  variables: [numeric('a'), numeric('b'), numeric('y')],
  rows: A.map((value, index) => [value, B[index], Y[index]]),
}
const model = designColumns(dataset, { dependent: 'y', factors: ['a', 'b'], interactions: true })
assert.ok(model, '设计矩阵必须能建起来')

// R: lm(y ~ a*b) gives rank 6 on 22 cases, df.residual = 16,
// sigma^2 = 1.016047010326
const RANK = 6
const R_DF2 = 16
const R_MSE = 1.016047010326

check('the design matrix is treatment coded, first level as reference', () => {
  assert.deepEqual(model.names, ['(截距)', 'a[2]', 'a[3]', 'b[2]', 'a[2]*b[2]', 'a[3]*b[2]'])
  assert.equal(model.n, 22)
  assert.equal(model.rank, RANK)
  assert.equal(model.dropped, 0)
  assert.deepEqual(model.levels, { a: [1, 2, 3], b: [1, 2] })
  // Column order and coding, not just the fit: R's model.matrix(~a*b) on the
  // same factors has exactly these columns in this order.
  assert.deepEqual(model.columns[0], new Array(22).fill(1))
  assert.deepEqual(model.columns[1], A.map((value) => (value === 2 ? 1 : 0)))
  assert.deepEqual(model.columns[2], A.map((value) => (value === 3 ? 1 : 0)))
  assert.deepEqual(model.columns[3], B.map((value) => (value === 2 ? 1 : 0)))
  // The interaction column is the product of the two dummies, cell by cell.
  assert.deepEqual(model.columns[4], A.map((value, index) => (value === 2 && B[index] === 2 ? 1 : 0)))
  // 4 + 3 + 3 + 5 + 3 + 4 cases in the six cells.
  assert.equal(model.columns[1].reduce((sum, value) => sum + value, 0), 8)
  assert.equal(model.columns[3].reduce((sum, value) => sum + value, 0), 12)
})

check('a two-factor design ranks every cell, and df2 = n - rank', () => {
  const results = generalLinearTest(model, [{ label: 'b2', coefficients: vector(model, { 'b[2]': 1 }) }])
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, true)
  // R: df.residual = 16, n = 22, rank = 6.
  assert.equal(results[0].df2, R_DF2)
  assert.equal(results[0].df2, model.n - model.rank)
})

check('a b[2] contrast matches car::linearHypothesis', () => {
  // R: linearHypothesis(m, "b2 = 0")
  //   estimate = 2.703891249067  se = 0.769866280179  t = 3.512157005290
  //   F        = 12.335246829804  p = 0.002888420469   df = 16
  const [result] = generalLinearTest(model, [{ label: 'b 的第 2 水平 vs 第 1 水平', coefficients: vector(model, { 'b[2]': 1 }) }])
  assert.equal(result.ok, true)
  near(result.estimate, 2.703891249067)
  near(result.se, 0.769866280179)
  near(result.t, 3.512157005290)
  near(result.f, 12.335246829804)
  near(result.p, 0.002888420469)
  assert.equal(result.df1, 1)
  near(result.f, result.t * result.t, 1e-9)
})

check('an interaction contrast matches car::linearHypothesis', () => {
  // R: linearHypothesis(m, "a2:b2 = 0")
  //   estimate = 2.588960265165  se = 1.065169389439  t = 2.430562022186
  //   F        = 5.907631743692   p = 0.027209857796
  const [result] = generalLinearTest(model, [{ label: 'a[2]*b[2]', coefficients: vector(model, { 'a[2]*b[2]': 1 }) }])
  assert.equal(result.ok, true)
  near(result.estimate, 2.588960265165)
  near(result.se, 1.065169389439)
  near(result.t, 2.430562022186)
  near(result.f, 5.907631743692)
  near(result.p, 0.027209857796)
})

check('a composite contrast (simple effect of b within a = 2) matches car', () => {
  // R: linearHypothesis(m, "b2 + a2:b2 = 0")   (E[y|a=2,b=2] - E[y|a=2,b=1])
  //   estimate = 5.292851514232  se = 0.736132962746  t = 7.190075410414
  //   p        = 0.000002152004
  const [result] = generalLinearTest(model, [{
    label: 'a = 2 内 b 的第 2 水平 vs 第 1 水平',
    coefficients: vector(model, { 'b[2]': 1, 'a[2]*b[2]': 1 }),
  }])
  assert.equal(result.ok, true)
  near(result.estimate, 5.292851514232)
  near(result.se, 0.736132962746)
  near(result.t, 7.190075410414)
  near(result.p, 0.000002152004)
  // The other direction, R: linearHypothesis(m, "b2 - a2:b2 = 0")
  //   estimate = 0.114930983903  se = 1.706654064615  t = 0.067342870641
  //   p        = 0.947143110842
  const [mirror] = generalLinearTest(model, [{
    label: 'b2 - a2:b2',
    coefficients: vector(model, { 'b[2]': 1, 'a[2]*b[2]': -1 }),
  }])
  near(mirror.estimate, 0.114930983903)
  near(mirror.se, 1.706654064615)
  near(mirror.t, 0.067342870641)
  near(mirror.p, 0.947143110842)
})

check('a joint hypothesis over two rows gets df1 = 2 and car\'s F', () => {
  // R: linearHypothesis(m, rbind(c(0,1,0,0,0,0), c(0,0,1,0,0,0)))
  //   F = 13.833975831748  df1 = 2  df2 = 16  p = 0.000324830869
  const [joint] = generalLinearTest(model, [{
    label: 'a 的两个主效应同时为 0',
    coefficients: [vector(model, { 'a[2]': 1 }), vector(model, { 'a[3]': 1 })],
  }])
  assert.equal(joint.ok, true)
  assert.equal(joint.df1, 2)
  assert.equal(joint.df2, 16)
  near(joint.f, 13.833975831748)
  near(joint.p, 0.000324830869)
  assert.deepEqual(joint.estimate.map((value) => Number(value.toFixed(9))), [1.382329872, 4.031434484])
  // R: linearHypothesis(m, rbind(c(0,0,0,0,1,0), c(0,0,0,0,0,1)))
  //   F = 13.615005487466  df1 = 2  df2 = 16  p = 0.000352108975
  const [interactions] = generalLinearTest(model, [{
    label: '两个交互项同时为 0',
    coefficients: [vector(model, { 'a[2]*b[2]': 1 }), vector(model, { 'a[3]*b[2]': 1 })],
  }])
  near(interactions.f, 13.615005487466)
  assert.equal(interactions.df1, 2)
  near(interactions.p, 0.000352108975)
})

check('a null inside coefficients means a zero coefficient', () => {
  const withNulls = [null, 0, 0, 1, null, undefined]
  const [result] = generalLinearTest(model, [{ label: 'b2', coefficients: withNulls }])
  const [plain] = generalLinearTest(model, [{ label: 'b2', coefficients: vector(model, { 'b[2]': 1 }) }])
  assert.equal(result.ok, true)
  near(result.estimate, plain.estimate, 1e-12)
  near(result.p, plain.p, 1e-12)
})

check('one factor with two levels reproduces the pooled two-sample t', () => {
  // R: summary(lm(y ~ g)) on y = 12.4 10.1 13.8 11.2 | 16.5 18.1 15.4 17.2
  //    14.9 16.0  gives g2 estimate 4.475000000000, se 0.869701217852,
  //    t 5.145445249637, p 0.000879228461, MSE 1.815312500000, df 8.
  //    t.test(var.equal = TRUE) prints the same statistic as -5.14544525
  //    (its group order is the other way round).
  const one = {
    variables: [numeric('g'), numeric('y')],
    rows: [[1, 12.4], [1, 10.1], [1, 13.8], [1, 11.2],
      [2, 16.5], [2, 18.1], [2, 15.4], [2, 17.2], [2, 14.9], [2, 16.0]],
  }
  const single = designColumns(one, { dependent: 'y', factors: ['g'] })
  assert.deepEqual(single.names, ['(截距)', 'g[2]'])
  const [result] = generalLinearTest(single, [{ label: 'g 的第 2 水平 vs 第 1 水平', coefficients: [0, 1] }])
  assert.equal(result.ok, true)
  near(result.estimate, 4.475000000000)
  near(result.se, 0.869701217852)
  near(result.t, 5.145445249637)
  near(result.p, 0.000879228461)
  assert.equal(result.df2, 8)

  // Second derivation, computed here without the module: pooled variance and
  // the two-sample t. Both routes must agree with the module and with R.
  const first = [12.4, 10.1, 13.8, 11.2]
  const second = [16.5, 18.1, 15.4, 17.2, 14.9, 16.0]
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = (values) => values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1)
  const pooled = ((first.length - 1) * variance(first) + (second.length - 1) * variance(second))
    / (first.length + second.length - 2)
  const se = Math.sqrt(pooled * (1 / first.length + 1 / second.length))
  const t = (mean(second) - mean(first)) / se
  near(result.estimate, mean(second) - mean(first), 1e-12)
  near(result.se, se, 1e-12)
  near(result.t, t, 1e-12)
  assert.equal(result.df2, first.length + second.length - 2)
  near(pooled, 1.815312500000)
})

check('a covariate enters as its own column, before the factor dummies', () => {
  // R: summary(lm(y ~ x + a2f)) on 12 cases
  //   x    estimate = 0.701469431997  se = 0.073451333237  t = 9.550125247342
  //        p = 0.000005241785
  //   a2f2 estimate = 2.898252847860  se = 0.461147257896  t = 6.284874946642
  //        p = 0.000143541860,  MSE = 0.475667838236, df = 9
  const x = [3, 5, 8, 11, 4, 6, 9, 12, 5, 7, 10, 13]
  const group = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]
  const y = [
    6.1670691465, 8.9013241944, 9.5092938193, 12.3934222720, 8.0973391874, 9.8331810149,
    13.6753040879, 16.3393968816, 10.5329521893, 13.5856177365, 14.5035445686, 16.9822504658,
  ]
  const ancova = {
    variables: [numeric('x'), numeric('grp'), numeric('y')],
    rows: x.map((value, index) => [value, group[index], y[index]]),
  }
  const design = designColumns(ancova, { dependent: 'y', factors: ['grp'], covariates: ['x'] })
  assert.deepEqual(design.names, ['(截距)', 'x', 'grp[2]'])
  assert.deepEqual(design.columns[1], x)
  const [slope, effect] = generalLinearTest(design, [
    { label: 'x 的斜率', coefficients: [0, 1, 0] },
    { label: 'grp 的第 2 水平 vs 第 1 水平', coefficients: [0, 0, 1] },
  ])
  near(slope.estimate, 0.701469431997)
  near(slope.se, 0.073451333237)
  near(slope.t, 9.550125247342)
  near(slope.p, 0.000005241785)
  near(effect.estimate, 2.898252847860)
  near(effect.se, 0.461147257896)
  near(effect.t, 6.284874946642)
  near(effect.p, 0.000143541860)
  assert.equal(effect.df2, 9)
})

check('levels sort numerically, not as strings, and strings lexicographically', () => {
  const numericLevels = {
    variables: [numeric('g'), numeric('y')],
    rows: [[10, 1], [2, 2], [1, 3], [10, 4], [2, 5]],
  }
  const d1 = designColumns(numericLevels, { dependent: 'y', factors: ['g'] })
  // 1 is the reference, then 2, then 10 — string order would have been 1, 10, 2.
  assert.deepEqual(d1.levels.g, [1, 2, 10])
  assert.deepEqual(d1.names, ['(截距)', 'g[2]', 'g[10]'])

  const stringLevels = {
    variables: [string('grp'), numeric('y')],
    rows: [['beta', 1], ['alpha', 2], ['beta', 3], ['alpha', 4], ['gamma', 5], ['gamma', 6]],
  }
  const d2 = designColumns(stringLevels, { dependent: 'y', factors: ['grp'] })
  assert.deepEqual(d2.levels.grp, ['alpha', 'beta', 'gamma'])
  assert.deepEqual(d2.names, ['(截距)', 'grp[beta]', 'grp[gamma]'])
})

check('cases are dropped listwise on blanks, declared missing codes and junk', () => {
  const messy = {
    variables: [numeric('a', { missing: [9] }), numeric('y', { missing: [999] })],
    rows: [
      [1, 10],      // kept
      [2, 12],      // kept
      [9, 13],      // a is a declared missing code
      [1, 999],     // y is a declared missing code
      [2, 14],      // kept
      [1, null],    // blank y
      [2, 15],      // kept
      ['', 16],     // blank a
      [1, 'abc'],   // unparsable y
    ],
  }
  const design = designColumns(messy, { dependent: 'y', factors: ['a'] })
  assert.equal(design.n, 4)
  assert.equal(design.dropped, 5)
  assert.deepEqual(design.cases, [10, 12, 14, 15])
  assert.deepEqual(design.rows, [0, 1, 4, 6])
  // 9 is a declared missing code, so it never becomes a level.
  assert.deepEqual(design.levels.a, [1, 2])
  assert.equal(design.columns[1].length, design.n)
})

check('an unestimable contrast is refused instead of given a fake number', () => {
  // The (2,2) cell has no observation, so a[2]*b[2] is all zeros and its
  // coefficient cannot be separated from 0: R would drop the column (NA).
  const rows = []
  for (const [first, second, count] of [[1, 1, 3], [1, 2, 3], [2, 1, 3], [2, 2, 0]]) {
    for (let index = 0; index < count; index += 1) {
      rows.push([first, second, 1 + 0.3 * index + 0.2 * first + 0.1 * second])
    }
  }
  const empty = {
    variables: [numeric('a'), numeric('b'), numeric('y')],
    rows,
  }
  const design = designColumns(empty, { dependent: 'y', factors: ['a', 'b'] })
  assert.deepEqual(design.names, ['(截距)', 'a[2]', 'b[2]', 'a[2]*b[2]'])
  assert.equal(design.rank, 3)
  assert.deepEqual(design.aliased, ['a[2]*b[2]'])
  assert.match(design.notes.join('\n'), /共线被剔除的列：a\[2\]\*b\[2\]/)

  const [missing, mainEffect, realCell] = generalLinearTest(design, [
    { label: '交互项 a[2]*b[2]', coefficients: [0, 0, 0, 1] },
    { label: 'b 的主效应', coefficients: [0, 0, 1, 0] },
    { label: 'a 的主效应', coefficients: [0, 1, 0, 0] },
  ])
  assert.equal(missing.ok, false)
  assert.equal(missing.estimate, undefined)
  assert.match(missing.reason, /没有对应的自由度/)
  // The columns that *are* identified still get their numbers.
  assert.equal(mainEffect.ok, true)
  assert.equal(realCell.ok, true)
  // E[y|a=2,b=1] - E[y|a=1,b=1] is the difference of two cell means here.
  const cell11 = rows.filter((row) => row[0] === 1 && row[1] === 1).map((row) => row[2])
  const cell21 = rows.filter((row) => row[0] === 2 && row[1] === 1).map((row) => row[2])
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  near(realCell.estimate, average(cell21) - average(cell11), 1e-12)
})

check('a saturated design reports no residual degrees of freedom, not a fake F', () => {
  // Four cases, four columns: every coefficient is determined, sigma² has no
  // degrees of freedom left, and any F here would be a division by zero.
  const saturated = {
    variables: [numeric('a'), numeric('b'), numeric('y')],
    rows: [[1, 1, 5], [1, 2, 6], [2, 1, 7], [2, 2, 9]],
  }
  const design = designColumns(saturated, { dependent: 'y', factors: ['a', 'b'] })
  assert.equal(design.n, 4)
  assert.equal(design.rank, 4)
  assert.equal(design.n - design.rank, 0)
  const [result] = generalLinearTest(design, [{ label: 'b 的主效应', coefficients: [0, 0, 1, 0] }])
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有残差自由度/)
  assert.equal(result.p, undefined)
})

check('malformed hypotheses are refused with a reason', () => {
  const [short] = generalLinearTest(model, [{ label: '长度不对', coefficients: [0, 1] }])
  assert.equal(short.ok, false)
  assert.match(short.reason, /长度必须等于设计列数（6）/)

  const [zero] = generalLinearTest(model, [{ label: '全 0', coefficients: new Array(6).fill(0) }])
  assert.equal(zero.ok, false)
  assert.match(zero.reason, /系数全为 0/)

  const [noModel] = generalLinearTest(null, [{ label: '没有模型', coefficients: [1] }])
  assert.equal(noModel.ok, false)
  assert.match(noModel.reason, /设计矩阵为空/)

  assert.deepEqual(generalLinearTest(model, []), [])
  // A single hypothesis object is accepted and still comes back as a list.
  const single = generalLinearTest(model, { label: 'b2', coefficients: vector(model, { 'b[2]': 1 }) })
  assert.equal(Array.isArray(single), true)
  assert.equal(single.length, 1)
  assert.equal(single[0].ok, true)
})

check('describeContrasts writes the note in the expected form', () => {
  const [main] = generalLinearTest(model, [{
    label: 'b 的第 2 水平 vs 第 1 水平',
    coefficients: vector(model, { 'b[2]': 1 }),
  }])
  assert.equal(describeContrasts(main),
    '自定义对比（插件计算）：「b 的第 2 水平 vs 第 1 水平」 估计 = 2.704，标准误 = 0.770，t = 3.512，df = 16，p = 0.003')
  // The same text when the caller passes the whole result array.
  assert.equal(describeContrasts([main]), describeContrasts(main))
  assert.equal(describeContrasts(null), '')
  assert.equal(describeContrasts([]), '')
})

check('describeContrasts puts one line per hypothesis and handles p < 0.001 and df1 > 1', () => {
  const results = generalLinearTest(model, [
    { label: 'b 的主效应', coefficients: vector(model, { 'b[2]': 1 }) },
    { label: 'a = 2 内 b 的简单效应', coefficients: vector(model, { 'b[2]': 1, 'a[2]*b[2]': 1 }) },
    { label: '两个交互项同时为 0', coefficients: [vector(model, { 'a[2]*b[2]': 1 }), vector(model, { 'a[3]*b[2]': 1 })] },
  ])
  const lines = describeContrasts(results).split('\n')
  assert.equal(lines.length, 3)
  assert.ok(lines.every((line) => line.startsWith('自定义对比（插件计算）：「')))
  assert.match(lines[0], /p = 0\.003$/)
  // p = 2.15e-6 must not print as "p = 0.000".
  assert.match(lines[1], /p < 0\.001$/)
  assert.doesNotMatch(describeContrasts(results), /p = 0\.000/)
  // df1 = 2 is an F test, so t and the single df are not printed.
  assert.match(lines[2], /F = 13\.615，df1 = 2，df2 = 16，p < 0\.001$/)
  assert.doesNotMatch(lines[2], /t =/)
  // Three decimals everywhere, one integer df.
  assert.match(lines[0], /估计 = -?\d+\.\d{3}，标准误 = \d+\.\d{3}，t = -?\d+\.\d{3}，df = 16，/)
})

check('an unestimable hypothesis says so in words, not with numbers', () => {
  // All four cells present: the interaction column exists and is estimable.
  const populated = {
    variables: [numeric('a'), numeric('b'), numeric('y')],
    rows: [[1, 1, 1], [1, 1, 2], [2, 1, 4], [2, 1, 5], [1, 2, 3], [1, 2, 4], [2, 2, 6], [2, 2, 7]],
  }
  const [fine] = generalLinearTest(designColumns(populated, { dependent: 'y', factors: ['a', 'b'] }),
    [{ label: '交互项 a[2]*b[2]', coefficients: [0, 0, 0, 1] }])
  assert.equal(fine.ok, true)

  // The (2,2) cell is empty, so that column is all zeros and the same
  // hypothesis can no longer be estimated from this data.
  const gapped = {
    variables: [numeric('a'), numeric('b'), numeric('y')],
    rows: [[1, 1, 1], [1, 1, 2], [1, 2, 3], [1, 2, 4], [2, 1, 5], [2, 1, 6]],
  }
  const [refused] = generalLinearTest(designColumns(gapped, { dependent: 'y', factors: ['a', 'b'] }),
    [{ label: '不存在的交互项', coefficients: [0, 0, 0, 1] }])
  assert.equal(refused.ok, false)
  assert.equal(describeContrasts(refused),
    '自定义对比（插件计算）：「不存在的交互项」：不可估（该对比在数据里没有对应的自由度，通常是某一格没有观测）')
})

check('without an intercept the factor columns are unchanged', () => {
  const design = designColumns(dataset, { dependent: 'y', factors: ['a', 'b'], intercept: false, interactions: true })
  assert.deepEqual(design.names, ['a[2]', 'a[3]', 'b[2]', 'a[2]*b[2]', 'a[3]*b[2]'])
  assert.equal(design.columns.length, 5)
  assert.equal(design.n, 22)
  // A factor with a single level contributes no dummy column and is explained.
  const single = designColumns({
    variables: [numeric('a'), numeric('b'), numeric('y')],
    rows: [[1, 1, 1], [1, 2, 2], [1, 1, 3]],
  }, { dependent: 'y', factors: ['a', 'b'] })
  assert.deepEqual(single.names, ['(截距)', 'b[2]'])
  assert.deepEqual(Object.keys(single.levels), ['b'])
  assert.match(single.notes.join('\n'), /因子 a 只有 1 个水平/)
})

check('an exactly collinear covariate is aliased, and only the estimable combination is tested', () => {
  // R: summary(lm(y ~ x1 + x2)) with x2 = 2*x1 prints xc2 as NA and gives
  //   xc1 estimate = 1.9976190476, se = 0.0278004443, t = 71.85565,
  //   p = 4.8889e-10, MSE = 0.032460317460, df = 6.
  // Nothing separates b1 from b2, but b1 + 2b2 is estimable and equals the
  // slope of the reduced model y ~ x1, which R reports as
  //   1.997619047619 / 0.027800444267 / 71.855651961599 / 4.89e-10.
  const x1 = [1, 2, 3, 4, 5, 6, 7, 8]
  const design = designColumns({
    variables: [numeric('x1'), numeric('x2'), numeric('y')],
    rows: x1.map((value, index) => [value, value * 2,
      [2.1, 4.3, 5.8, 8.2, 9.9, 12.1, 14.0, 16.2][index]]),
  }, { dependent: 'y', covariates: ['x1', 'x2'] })
  assert.deepEqual(design.aliased, ['x2'])
  assert.equal(design.rank, 2)
  assert.equal(design.n - design.rank, 6)

  const [combined, alone, other] = generalLinearTest(design, [
    { label: 'b1 + 2b2', coefficients: [0, 1, 2] },
    { label: 'b1', coefficients: [0, 1, 0] },
    { label: 'b2', coefficients: [0, 0, 1] },
  ])
  assert.equal(combined.ok, true)
  near(combined.estimate, 1.997619047619)
  near(combined.se, 0.027800444267)
  near(combined.t, 71.855651961599)
  near(combined.p, 4.888933612555e-10, 1e-15)
  // R: NA for xc2, and b1 alone is just as unidentifiable.
  assert.equal(alone.ok, false)
  assert.equal(other.ok, false)
})

check('a badly scaled design still matches R (residuals, not the difference of two norms)', () => {
  // R: summary(lm(y ~ x + g)) with x around 1e6, residual sd 0.01
  //   x  estimate = 0.700100632032  se = 0.001180513088729  t = 593.047750776174
  //   g2 estimate = 2.49608474749675  se = 0.00815038638793229
  // Computing the residual sum of squares as ||y||² - ||Q'y||² would lose every
  // significant digit at this offset; the check is here to keep that shortcut
  // out of the module.
  const x = [1000001, 1000002, 1000003, 1000004, 1000005, 1000006,
    1000007, 1000008, 1000009, 1000010, 1000011, 1000012]
  const group = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]
  const y = [
    1000003.7048978622, 1000004.3960145862, 1000005.1051083632, 1000005.7960118795,
    1000006.5163868606, 1000007.2062127397, 1000010.4020270430, 1000011.1110893778,
    1000011.7979377524, 1000012.4962103496, 1000013.1969573833, 1000013.9005416232,
  ]
  const design = designColumns({
    variables: [numeric('x'), numeric('grp'), numeric('y')],
    rows: x.map((value, index) => [value, group[index], y[index]]),
  }, { dependent: 'y', factors: ['grp'], covariates: ['x'] })
  const [slope, effect] = generalLinearTest(design, [
    { label: 'x 的斜率', coefficients: [0, 1, 0] },
    { label: 'grp 的第 2 水平 vs 第 1 水平', coefficients: [0, 0, 1] },
  ])
  near(slope.estimate, 0.700100632032, 1e-9)
  near(slope.se, 0.001180513088729, 1e-12)
  near(slope.t, 593.047750776174, 1e-6)
  near(effect.estimate, 2.49608474749675, 1e-9)
  near(effect.se, 0.00815038638793229, 1e-9)
})

check('equal-weight contrasts reproduce the engine GLM Type III rows', () => {
  // PSPP 2.1.3, same data: GLM y BY a b /DESIGN=a b a*b.
  //   Error   df = 16, mean square = 1.02
  //   a x b   Type III SS = 27.67, df = 2, F = 13.62
  //   a       Type III SS = 31.79, df = 2, F = 15.64
  //   b       Type III SS = 35.17, df = 1, F = 34.61
  // The a and b rows are equal-cell-weight (Type III) tests — the effect averaged
  // over the other factor — not the reference-cell coefficient. Reproducing them
  // with L built as that average is what lets the panel show a contrast next to
  // the engine's ANOVA table without the two disagreeing.
  const averagedB = vector(model, { 'b[2]': 1, 'a[2]*b[2]': 1 / 3, 'a[3]*b[2]': 1 / 3 })
  const averagedA = [
    vector(model, { 'a[2]': 1, 'a[2]*b[2]': 0.5 }),
    vector(model, { 'a[3]': 1, 'a[3]*b[2]': 0.5 }),
  ]
  const [bRow, aRow, interaction, cell] = generalLinearTest(model, [
    { label: 'b（等权平均）', coefficients: averagedB },
    { label: 'a（等权平均）', coefficients: averagedA },
    { label: 'a x b', coefficients: [vector(model, { 'a[2]*b[2]': 1 }), vector(model, { 'a[3]*b[2]': 1 })] },
    { label: 'b 在 a = 1 格', coefficients: vector(model, { 'b[2]': 1 }) },
  ])
  assert.equal(bRow.df1, 1)
  near(bRow.f, 34.61, 0.005)
  assert.equal(aRow.df1, 2)
  near(aRow.f, 15.64, 0.005)
  assert.equal(interaction.df1, 2)
  near(interaction.f, 13.62, 0.005)
  // The plain reference-cell coefficient is a different number (12.335), which is
  // why the panel must not label it "b 的主效应" next to PSPP's 34.61.
  near(cell.f, 12.335246829804)
})

Promise.all(pending).then(() => {
  console.log(`\n${checks} checks passed in test/contrasts.mjs`)
  if (checks < 15) process.exitCode = 1
})
