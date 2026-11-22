import assert from 'node:assert'
import { breslowDay, describeHomogeneity, describeMantelHaenszel, mantelHaenszel } from '../lib/cmh.js'
import { pearsonChiSquare } from '../lib/tables.js'

let checks = 0
function check(name, body) {
  try {
    body()
    checks += 1
    console.log(`ok   ${checks} - ${name}`)
  } catch (error) {
    checks += 1
    process.exitCode = 1
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

/** Assert to `digits` decimal places, so a difference in the 10th digit is not a failure. */
function near(actual, expected, digits = 6, label = '') {
  assert.ok(Number.isFinite(actual), `${label} is not finite: ${actual}`)
  assert.equal(actual.toFixed(digits), Number(expected).toFixed(digits), `${label}: ${actual} vs ${expected}`)
}

/* ------------------------------------------------------------------ *
 * Fixtures                                                           *
 * ------------------------------------------------------------------ */

// R: UCBAdmissions (Admit × Gender | Dept), the textbook CMH example.
// Each stratum is [[Admitted, Rejected] Male, [Admitted, Rejected] Female],
// i.e. rows = outcome, columns = gender; the transpose is equivalent here.
const UCB = [
  [[512, 89], [313, 19]],
  [[353, 17], [207, 8]],
  [[120, 202], [205, 391]],
  [[138, 131], [279, 244]],
  [[53, 94], [138, 299]],
  [[22, 24], [351, 317]],
]

// A hand-checkable 3-stratum table, used for both CMH and Breslow–Day.
const L3 = [
  [[10, 20], [30, 40]],
  [[5, 15], [25, 35]],
  [[8, 12], [18, 22]],
]

// Two strata that both have OR = 4 exactly: a common OR is the truth here.
const CONST = [[[20, 10], [10, 20]], [[40, 20], [20, 40]]]

// Every stratum has bc = 0, so the Mantel–Haenszel denominator vanishes.
const UNDEF = [[[5, 0], [0, 5]], [[3, 0], [0, 3]]]

const transpose = (strata) => strata.map(([[a, b], [c, d]]) => [[a, c], [b, d]])

/* ------------------------------------------------------------------ *
 * CMH against R                                                      *
 * ------------------------------------------------------------------ */

check('UCBAdmissions reproduces R mantelhaen.test(correct = FALSE)', () => {
  // Rscript:
  //   mantelhaen.test(UCBAdmissions, correct = FALSE)
  //   X-squared = 1.524606660443, df = 1, p-value = 0.2169236970555
  //   common odds ratio = 0.904696828259, 95% CI 0.771907361759 1.060329764437
  const result = mantelHaenszel(UCB)
  near(result.statistic, 1.524606660443, 9, 'statistic')
  near(result.p, 0.2169236970555, 9, 'p')
  near(result.oddsRatio, 0.904696828259, 9, 'odds ratio')
  near(result.low, 0.771907361759, 6, 'interval low')
  near(result.high, 1.060329764437, 6, 'interval high')
  assert.equal(result.df, 1)
  assert.equal(result.level, 0.95)
  assert.equal(result.correction, false)
  assert.equal(result.strata, 6)
  assert.equal(result.used, 6)
  assert.equal(result.empty, 0)
  assert.equal(result.note, null)
})

check('UCBAdmissions reproduces R mantelhaen.test(correct = TRUE)', () => {
  // Rscript: mantelhaen.test(UCBAdmissions, correct = TRUE)
  //   X-squared = 1.426946228587, p-value = 0.2322634628170
  const result = mantelHaenszel(UCB, { correction: true })
  near(result.statistic, 1.426946228587, 9, 'statistic')
  near(result.p, 0.2322634628170, 9, 'p')
  assert.equal(result.correction, true)
  // The correction only moves the statistic; the pooled OR and its interval
  // are the same numbers R prints for both variants.
  near(result.oddsRatio, 0.904696828259, 9, 'odds ratio')
  near(result.low, 0.771907361759, 6, 'interval low')
})

check('a 3-stratum table reproduces R on the statistic, the OR and the interval', () => {
  // Rscript:
  //   L3 <- list(c(10,20,30,40), c(5,15,25,35), c(8,12,18,22))
  //   mantelhaen.test(array built from those, correct = FALSE)
  //   X-squared = 2.228138725215, df = 1, p-value = 0.1355170110166
  //   common odds ratio = 0.638378536016, 95% CI 0.354797172174 1.148620077069
  const result = mantelHaenszel(L3)
  near(result.statistic, 2.228138725215, 9, 'statistic')
  near(result.p, 0.1355170110166, 9, 'p')
  near(result.oddsRatio, 0.638378536016, 9, 'odds ratio')
  near(result.low, 0.354797172174, 6, 'interval low')
  near(result.high, 1.148620077069, 6, 'interval high')
  assert.equal(result.used, 3)
})

check('the interval widens with the level and never inverts', () => {
  const ninety = mantelHaenszel(L3, { level: 0.9 })
  const ninetyNine = mantelHaenszel(L3, { level: 0.99 })
  assert.ok(ninety.low > 0.3548 && ninety.high < 1.1487, '90% is narrower')
  assert.ok(ninetyNine.low < 0.3548 && ninetyNine.high > 1.1487, '99% is wider')
  // A level outside (0, 1) falls back to 95% instead of returning NaN bounds.
  const fallback = mantelHaenszel(L3, { level: 1.5 })
  near(fallback.low, 0.354797, 6, 'fallback low')
  near(fallback.high, 1.148620, 6, 'fallback high')
})

/* ------------------------------------------------------------------ *
 * Identities                                                         *
 * ------------------------------------------------------------------ */

check('one stratum: CMH is Pearson times (T-1)/T, and tends to Pearson as T grows', () => {
  // This is the exact identity. The two are *not* equal for a finite table:
  // CMH divides by the hypergeometric variance, which carries the (T-1) in
  // R1·R2·C1·C2/(T²(T-1)), so X²_CMH = X²_Pearson · (T-1)/T. R cannot run
  // mantelhaen.test on a single stratum (each dimension must be >= 2), so the
  // check is against chisq.test plus this algebraic factor.
  const table = [[10, 20], [30, 40]]
  const cmh = mantelHaenszel([table])
  // R: chisq.test(matrix(c(10,20,30,40), 2, 2, byrow=TRUE), correct=FALSE)
  //   X-squared = 0.793650793651, df = 1, p-value = 0.3729984836135
  const pearson = pearsonChiSquare(table)
  near(pearson.statistic, 0.793650793651, 9, 'pearson')
  near(cmh.statistic, pearson.statistic * 99 / 100, 12, 'CMH = Pearson·(T-1)/T')
  near(cmh.oddsRatio, 10 * 40 / (20 * 30), 12, 'single-stratum OR = ad/bc')

  // With a big T the factor is negligible: the two agree to three decimals.
  const wide = mantelHaenszel([[[5000, 5000], [5000, 4950]]])
  const widePearson = pearsonChiSquare([[5000, 5000], [5000, 4950]])
  assert.ok(Math.abs(wide.statistic / widePearson.statistic - 1) < 1e-3,
    `factor ${wide.statistic / widePearson.statistic}`)
})

check('transposing every stratum changes nothing', () => {
  for (const strata of [UCB, L3]) {
    const direct = mantelHaenszel(strata)
    const mirrored = mantelHaenszel(transpose(strata))
    near(mirrored.statistic, direct.statistic, 12, 'statistic')
    near(mirrored.p, direct.p, 12, 'p')
    near(mirrored.oddsRatio, direct.oddsRatio, 12, 'odds ratio')
    near(mirrored.low, direct.low, 12, 'low')
    near(mirrored.high, direct.high, 12, 'high')
  }
})

check('strata with an identical OR keep exactly that OR', () => {
  // R: mantelhaen.test on these two strata
  //   X-squared = 19.777464788732, estimate = 4, 95% CI 2.152218840508 7.434188242781
  const result = mantelHaenszel(CONST)
  assert.equal(result.oddsRatio, 4, 'the pooled OR is 4, not 4.0000001')
  near(result.statistic, 19.777464788732, 9, 'statistic')
  near(result.low, 2.152218840508, 6, 'interval low')
  near(result.high, 7.434188242781, 6, 'interval high')
})

/* ------------------------------------------------------------------ *
 * Empty layers and undefined ratios                                  *
 * ------------------------------------------------------------------ */

check('an empty stratum is counted but contributes nothing', () => {
  const withEmpty = mantelHaenszel([L3[0], [[0, 0], [0, 0]], L3[2]])
  const without = mantelHaenszel([L3[0], L3[2]])
  const result = withEmpty
  assert.equal(result.strata, 3)
  assert.equal(result.used, 2)
  assert.equal(result.empty, 1)
  // Identical statistic and OR to the same analysis with the layer removed.
  near(result.statistic, without.statistic, 12, 'statistic')
  near(result.oddsRatio, without.oddsRatio, 12, 'odds ratio')
  near(result.low, without.low, 12, 'low')
  // A row that is empty while the table total is not is still an empty layer.
  const degenerate = mantelHaenszel([L3[0], [[5, 5], [0, 0]], L3[2]])
  assert.equal(degenerate.empty, 1)
  assert.equal(degenerate.used, 2)
  near(degenerate.statistic, without.statistic, 12, 'degenerate row')
  // And the sentence says so instead of quietly reporting two layers.
  assert.match(describeMantelHaenszel(result), /共 3 层、有效 2 层（1 层未参与：1 层有空行或空列）/)
})

check('a vanished denominator leaves the OR undefined but the chi-square intact', () => {
  // R prints X-squared = 13.98058252 here, with estimate Inf and a NaN interval;
  // the χ² does not need the ratio, so it is still reported.
  const result = mantelHaenszel(UNDEF)
  near(result.statistic, 13.980582524272, 9, 'statistic')
  near(result.p, 0.0001847083798645, 9, 'p')
  assert.equal(result.oddsRatio, null)
  assert.equal(result.low, null)
  assert.equal(result.high, null)
  assert.ok(result.note && result.note.includes('分母不存在'), result.note)
  const text = describeMantelHaenszel(result)
  assert.match(text, /共同 OR 无定义（各层 b·c 权重之和为 0/)
  assert.match(text, /χ² = 13\.981（1 df，p < 0\.001）/)
  // The same table with an explicit ψ still supports a homogeneity test.
  const bd = breslowDay(UNDEF, { oddsRatio: 1 })
  assert.ok(bd.statistic !== null, 'an explicit odds ratio unblocks Breslow-Day')
})

check('nothing usable at all degrades instead of throwing', () => {
  const nothing = mantelHaenszel([])
  assert.equal(nothing.statistic, null)
  assert.equal(nothing.p, null)
  assert.equal(nothing.oddsRatio, null)
  assert.equal(nothing.strata, 0)
  assert.ok(nothing.note.includes('无从计算'), nothing.note)
  assert.match(describeMantelHaenszel(nothing), /χ² 无法计算/)
  // A table of zeroes is "one empty layer", not a crash.
  const zeros = mantelHaenszel([[[0, 0], [0, 0]]])
  assert.equal(zeros.empty, 1)
  assert.equal(zeros.used, 0)
  assert.equal(zeros.statistic, null)
  // Not an array at all is treated as no strata.
  assert.equal(mantelHaenszel(undefined).strata, 0)
})

/* ------------------------------------------------------------------ *
 * Breslow–Day                                                        *
 * ------------------------------------------------------------------ */

check('Breslow–Day reproduces the published formula on both fixtures', () => {
  // Base R has no Breslow–Day, so the reference numbers come from transcribing
  // Breslow & Day (1980) p.142 into R, with ψ fixed at R's mantelhaen.test
  // estimate:
  //   L3  psi = 0.638378536016 -> BD = 0.496083496096, df 2, p = 0.7803273654537
  //   UCB psi = 0.904696828259 -> BD = 18.825513705237, df 5, p = 0.002071390350
  const l3 = breslowDay(L3)
  near(l3.statistic, 0.496083496096, 9, 'L3 statistic')
  assert.equal(l3.df, 2)
  near(l3.p, 0.7803273654537, 9, 'L3 p')
  assert.equal(l3.note, null)

  const ucb = breslowDay(UCB)
  near(ucb.statistic, 18.825513705237, 9, 'UCB statistic')
  assert.equal(ucb.df, 5)
  near(ucb.p, 0.002071390350, 9, 'UCB p')
})

check('Breslow–Day agrees with the log-linear test of a three-way interaction', () => {
  // A structurally different route to the same question: compare the
  // homogeneous-association Poisson model with the saturated one. The two
  // statistics are asymptotically equivalent, not identical, so this asserts
  // agreement in size and in the verdict rather than equality.
  //   R: deviance(glm(Freq ~ G*O + G*S + O*S)) gives
  //      L3  0.501970318766, df 2, p 0.778033917977
  //      UCB 20.204275327242, df 5, p 0.001144078451
  const pairs = [
    { result: breslowDay(L3), reference: 0.501970318766, significant: false },
    { result: breslowDay(UCB), reference: 20.204275327242, significant: true },
  ]
  for (const { result, reference, significant } of pairs) {
    assert.ok(Math.abs(result.statistic / reference - 1) < 0.1,
      `${result.statistic} vs ${reference}`)
    assert.equal(result.p < 0.05, significant, `verdict at ${result.p}`)
  }
})

check('perfectly homogeneous strata give a zero statistic and p = 1', () => {
  const result = breslowDay(CONST)
  assert.equal(result.statistic, 0)
  assert.equal(result.df, 1)
  assert.equal(result.p, 1)
  assert.match(describeHomogeneity(result), /^同质性检验（Breslow–Day）：χ² = 0\.000，df = 1，p = 1\.000$/)
})

check('a single layer cannot test homogeneity', () => {
  const one = breslowDay([L3[0]])
  assert.deepEqual(one, { statistic: null, df: 0, p: null, note: '只有一层，同质性无从检验' })
  assert.match(describeHomogeneity(one), /只有一层，同质性无从检验/)
  // No usable layer at all is a different sentence, and df stays 0.
  const none = breslowDay([[[0, 0], [0, 0]]])
  assert.equal(none.statistic, null)
  assert.equal(none.df, 0)
  assert.ok(none.note.includes('没有可用于同质性检验的层'), none.note)
  // An undefined common OR cannot be substituted for, so Breslow–Day says why.
  const noPsi = breslowDay(UNDEF)
  assert.equal(noPsi.statistic, null)
  assert.ok(noPsi.note.includes('options.oddsRatio'), noPsi.note)
  assert.equal(breslowDay(null).statistic, null)
})

/* ------------------------------------------------------------------ *
 * The sentences                                                      *
 * ------------------------------------------------------------------ */

check('the CMH sentence matches the agreed wording exactly', () => {
  const sample = {
    statistic: 9.283,
    df: 1,
    p: 0.0019,
    oddsRatio: 3.154,
    low: 1.520,
    high: 6.545,
    level: 0.95,
    correction: false,
    strata: 3,
    used: 3,
    empty: 0,
    note: null,
  }
  assert.equal(describeMantelHaenszel(sample),
    '分层卡方（插件计算）：Cochran–Mantel–Haenszel χ² = 9.283（1 df，p = 0.002），'
    + '共同优势比 OR = 3.154，95% 置信区间 1.520 ~ 6.545（Mantel–Haenszel 估计，'
    + 'Robins–Breslow–Greenland 区间）；共 3 层、有效 3 层')
  assert.equal(describeMantelHaenszel(null), null)
  assert.equal(describeHomogeneity(null), null)
})

check('p below one in a thousand is written as an inequality', () => {
  const text = describeMantelHaenszel({
    statistic: 92.2, df: 1, p: 1e-20, oddsRatio: 3.154, low: 1.52, high: 6.545,
    level: 0.95, correction: false, strata: 3, used: 3, empty: 0, note: null,
  })
  assert.match(text, /p < 0\.001/)
  assert.doesNotMatch(text, /p = 0\.000/)
  // Exactly on the boundary it is still an equality.
  assert.match(describeHomogeneity({ statistic: 30.1, df: 1, p: 0.001 }), /p = 0\.001/)
  // The 99% level is labelled with its own percentage.
  assert.match(describeMantelHaenszel({ ...sampleLike(), level: 0.99 }), /99% 置信区间/)
})

check('the note keeps three decimals and no stray precision', () => {
  const text = describeMantelHaenszel(mantelHaenszel(UCB))
  assert.match(text, /χ² = 1\.525（1 df，p = 0\.217）/)
  assert.match(text, /OR = 0\.905，95% 置信区间 0\.772 ~ 1\.060/)
  assert.match(text, /共 6 层、有效 6 层$/)
  assert.doesNotMatch(text, /\d\.\d{4,}/)
})

/** A minimal result used only to vary one field at a time. */
function sampleLike() {
  return {
    statistic: 9.283, df: 1, p: 0.002, oddsRatio: 3.154, low: 1.52, high: 6.545,
    level: 0.95, correction: false, strata: 3, used: 3, empty: 0, note: null,
  }
}

console.log(`\n${checks} checks passed in test/cmh.mjs`)
if (checks < 8) process.exitCode = 1
