/**
 * Table 1 / table 2 tests. The numbers asserted here are hand-computed from the
 * tiny fixture, so a change to the summarising or the test choice shows up as a
 * concrete mismatch instead of "the table looks different".
 */
import assert from 'node:assert/strict'

import {
  buildBaselineTable,
  buildCompareTable,
  buildPairwiseTable,
  buildPartialMatrix,
  buildPartialTable,
  buildSignificanceMatrix,
  chiSquareFromTable,
  chiSquareP,
  cramersVFromChiSquare,
  crosstabCounts,
  fP,
  fQuantile,
  iccTable,
  pearsonChiSquare,
  studentP,
  welch,
} from '../lib/tables.js'

let checks = 0
let failures = 0
function check(name, run) {
  checks += 1
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

const dataset = {
  variables: [
    { name: 'arm', type: 'numeric', label: '组别', valueLabels: { 1: '试验组', 2: '对照组' } },
    { name: 'age', type: 'numeric', label: '年龄' },
    { name: 'sex', type: 'string', label: '性别' },
    { name: 'sbp', type: 'numeric', label: '收缩压' },
  ],
  rows: [
    [1, 50, '男', 120],
    [1, 55, '女', 128],
    [1, 61, '男', 133],
    [1, 58, '女', 126],
    [2, 62, '男', 141],
    [2, 66, '女', 147],
    [2, 70, '男', 150],
    [2, 64, '女', 144],
  ],
}

check('t / F / chi-square tails match published values', () => {
  assert.equal(studentP(2, 10).toFixed(4), '0.0734')
  assert.equal(studentP(2.228, 10).toFixed(3), '0.050')
  assert.equal(fP(4.26, 2, 21).toFixed(3), '0.028')
  assert.equal(chiSquareP(3.84, 1).toFixed(3), '0.050')
  assert.equal(chiSquareP(11.87, 1).toFixed(4), '0.0006')
  assert.equal(chiSquareP(17.5, 4).toFixed(3), '0.002')
})

check('welch t uses unequal variances', () => {
  const result = welch([50, 55, 61, 58], [62, 66, 70, 64])
  assert.ok(result.t < 0, 'the second group is higher')
  assert.ok(result.p > 0.01 && result.p < 0.03, String(result.p))
  // 4 vs 4 with these values: Welch t = -3.13, df ≈ 5.76, p = .0193
  assert.ok(Math.abs(result.p - 0.0193) < 0.0005, `p=${result.p}`)
})

check('pearson chi-square reports the cells below five', () => {
  const result = pearsonChiSquare([[2, 2], [2, 2]])
  assert.equal(result.statistic, 0)
  assert.equal(result.df, 1)
  assert.equal(result.smallCells, 4, 'every expected count is 2')
  assert.equal(result.minExpected, 2)
})

check('table 1 lists overall, per-group and P per variable', () => {
  const table = buildBaselineTable(dataset, { group: 'arm', variables: ['age', 'sex', 'sbp'] })
  assert.equal(table.matrix[0].length, 6, '变量 / 总体 / 两组 / P / 效应量')
  assert.equal(table.matrix[0][0], '变量')
  assert.equal(table.matrix[0][1], '总体（n=8）')
  assert.equal(table.matrix[0][2], '试验组（n=4）')
  assert.equal(table.matrix[0][4], 'P')
  assert.equal(table.matrix[1][0], '年龄，均数±标准差')
  assert.equal(table.matrix[1][1], '60.75 ± 6.34')
  assert.equal(table.matrix[1][2], '56.00 ± 4.69')
  assert.equal(table.matrix[1][3], '65.50 ± 3.42')
  assert.equal(table.matrix[1][4], '0.019', 'Welch t on age')
  assert.equal(table.matrix[0][5], '效应量')
  assert.equal(table.matrix[1][5], 'd=-2.32', "Cohen's d on age")
  // The categorical block: a header row plus one row per level.
  assert.equal(table.matrix[2][0], '性别，n（%）')
  assert.equal(table.matrix[3][0], '　男')
  assert.equal(table.matrix[3][1], '4（50.0）')
  assert.equal(table.matrix[3][2], '2（50.0）')
  assert.equal(table.matrix[3][4], '1.000', 'chi-square p on the 2×2 block')
  assert.equal(table.matrix[2][5], 'V=0.00', "Cramér's V on the 2×2 block")
  assert.equal(table.matrix[3][5], '', 'the level rows leave the effect column empty')
  assert.ok(table.notes.some((note) => note.includes('期望频数')), 'small expected counts are called out')
})

check('table 1 can summarise with medians instead', () => {
  const table = buildBaselineTable(dataset, { group: 'arm', variables: ['age'], continuous: 'median' })
  assert.equal(table.matrix[1][0], '年龄，中位数（四分位数间距）')
  assert.equal(table.matrix[1][1], '61.50（57.25–64.50）')
})

check('three groups switch the numeric test to ANOVA', () => {
  const three = {
    variables: [
      { name: 'grp', type: 'numeric', valueLabels: { 1: '甲', 2: '乙', 3: '丙' } },
      { name: 'x', type: 'numeric' },
    ],
    rows: [[1, 10], [1, 12], [1, 14], [2, 20], [2, 22], [2, 24], [3, 30], [3, 32], [3, 34]],
  }
  const table = buildBaselineTable(three, { group: 'grp', variables: ['x'] })
  assert.equal(table.matrix[0].length, 7, '变量 / 总体 / 三个组 / P / 效应量')
  assert.equal(table.matrix[1].at(-2), '<0.001', 'F test on three widely separated groups')
  assert.equal(table.matrix[1].at(-1), 'η²=0.96', 'three groups report eta squared')
})

check('table 2 drops the overall column and keeps the P values', () => {
  const table = buildCompareTable(dataset, { group: 'arm', variables: ['age', 'sbp'] })
  assert.equal(table.matrix[0][1], '试验组（n=4）')
  assert.equal(table.matrix[0].at(-2), 'P')
  assert.equal(table.matrix[0].at(-1), '效应量')
  assert.equal(table.matrix[1].at(-2), '0.019')
  assert.equal(table.matrix[1].at(-1), 'd=-2.32')
  assert.equal(table.title.includes('表 2'), true)
})

check('the group variable has to have at least two values', () => {
  const single = { variables: [{ name: 'g', type: 'numeric' }, { name: 'x', type: 'numeric' }], rows: [[1, 5], [1, 6]] }
  assert.throws(() => buildBaselineTable(single, { group: 'g', variables: ['x'] }), /至少要有两个取值/)
  assert.throws(() => buildBaselineTable(dataset, {}), /需要一个分组变量/)
  assert.throws(() => buildBaselineTable(dataset, { group: 'arm', variables: ['nope'] }), /unknown variable: nope/)
})


const threeArm = {
  variables: [
    { name: 'arm', type: 'numeric', label: '组别', valueLabels: { 1: '试验组', 2: '对照组', 3: '安慰剂组' } },
    { name: 'sbp', type: 'numeric', label: '收缩压' },
    { name: 'site', type: 'string', label: '中心' },
  ],
  rows: [
    [1, 120, 'A'], [1, 128, 'A'],
    [2, 141, 'B'], [2, 147, 'B'],
    [3, 131, 'A'], [3, 139, 'B'],
  ],
}

check('pairwise table tests every pair with Welch and Bonferroni', () => {
  const built = buildPairwiseTable(threeArm, { group: 'arm', adjust: 'bonferroni' })
  assert.equal(built.matrix.length, 4) // header + 3 pairs
  assert.deepEqual(built.matrix[0].slice(0, 3), ['变量', '比较', '均数差'])
  assert.equal(built.matrix[0][6], 'P')
  assert.equal(built.matrix[0][7], 'P（Bonferroni）')
  assert.equal(built.matrix[0][5], 'df')
  assert.equal(built.matrix[0].at(-4), '95% CI（差）')
  assert.equal(built.matrix[0].at(-3), "Cohen's d")
  assert.equal(built.matrix[0].at(-2), "d 的 95% CI")
  assert.deepEqual(built.matrix[1].slice(0, 8), ['收缩压', '试验组 vs 对照组', '-20.000', '5.000', '-4.000', '1.855', '0.065', '0.194'])
  // The interval is the difference ± t(0.975, df)·SE with this pair's own df.
  // Two cases per group leave df ≈ 1.86; inverting the p-value gives
  // t(0.975, 1.855) = 10.51, where rounding the df to 1 would have given 12.71
  // and an interval half again as wide.
  assert.equal(built.matrix[1][8], '-43.213 ~ 3.213')
  assert.equal(built.matrix[1][9], '-4.00')
  // Hedges & Olkin: SE(d) = sqrt((n1+n2)/(n1 n2) + d²/(2(n1+n2))).
  assert.equal(built.matrix[1][10], '-7.395 ~ -0.605')
  assert.equal(built.matrix[1][11], 'ns')
  assert.ok(built.matrix.every((row, index) => index === 0 || row[0] === '收缩压'))
  assert.ok(built.notes.some((note) => note.includes('Bonferroni')))
})

check('pairwise table adjusts by default and says so in the header', () => {
  const built = buildPairwiseTable(threeArm, { group: 'arm' })
  assert.equal(built.matrix[0][7], 'P（Bonferroni）')
  assert.equal(built.matrix[1][7], '0.194')
  assert.notEqual(built.matrix[1][6], built.matrix[1][7])
  assert.ok(built.notes.join(' ').includes('Bonferroni'))
})

check('pairwise table leaves P alone when adjustment is switched off', () => {
  const built = buildPairwiseTable(threeArm, { group: 'arm', adjust: 'none' })
  assert.equal(built.matrix[0][7], 'P（未校正）')
  assert.equal(built.matrix[1][6], built.matrix[1][7])
  assert.ok(!built.notes.join(' ').includes('Bonferroni'))
  assert.ok(built.matrix.every((row) => row.every((cell) => !String(cell).includes('Bonferroni'))))
})

check('pairwise table says a variable has no data instead of blaming group size', () => {
  const withEmpty = {
    variables: [
      ...threeArm.variables,
      { name: 'empty', type: 'numeric', label: '空变量' },
    ],
    rows: threeArm.rows.map((row) => [...row, null]),
  }
  const built = buildPairwiseTable(withEmpty, { group: 'arm' })
  const text = built.notes.join(' ')
  assert.ok(text.includes('空变量：没有有效数据'))
  assert.ok(!/空变量：至少有一组不足/.test(text))
})

check('significance matrix puts starred differences in a variables × pairs grid', () => {
  const spread = {
    variables: [
      { name: 'arm', type: 'numeric', label: '组别', valueLabels: { 1: '甲', 2: '乙', 3: '丙' } },
      { name: 'sbp', type: 'numeric', label: '收缩压' },
    ],
    rows: [[1, 1], [1, 2], [2, 10], [2, 11], [3, 20], [3, 21]],
  }
  const built = buildSignificanceMatrix(spread, { group: 'arm' })
  assert.deepEqual(built.matrix[0], ['变量', '甲 vs 乙', '甲 vs 丙', '乙 vs 丙'])
  assert.equal(built.matrix[1][0], '收缩压')
  // Two cases per group: the Welch P is small but the Bonferroni-corrected one
  // lands between 0.01 and 0.05, so the star drops to a single asterisk.
  assert.equal(built.matrix[1][1], '-9.000 *')
  assert.equal(built.matrix[1][2], '-19.000 **')
  assert.ok(built.notes.join(' ').includes('Bonferroni'))
})

check('partial correlation residualises both variables on the controls', () => {
  const dataset = {
    variables: [
      { name: 'x', type: 'numeric', label: 'X' },
      { name: 'y', type: 'numeric', label: 'Y' },
      { name: 'z', type: 'numeric', label: 'Z' },
    ],
    rows: [[1, 2, 3], [2, 4, 2], [3, 6, 5], [4, 9, 4], [5, 10, 7], [6, 13, 6], [7, 14, 9], [8, 17, 8]],
  }
  const built = buildPartialTable(dataset, { variables: ['x', 'y'], controls: ['z'] })
  // The closed form r = (rxy - rxz·ryz)/√((1-rxz²)(1-ryz²)) is 0.994 on this
  // fixture; the residual method has to agree.
  assert.equal(built.matrix[1][2], '0.994')
  assert.equal(built.matrix[1][3], '5', 'df = N - controls - 2')
  assert.equal(built.matrix[1][5], '8')
  assert.equal(built.matrix[1][6], '***')
  assert.ok(built.notes.join(' ').includes('列表删除'))
  assert.match(built.title, /控制：Z/)
})

check('a partial correlation without controls is a plain Pearson correlation', () => {
  const dataset = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
    rows: [[1, 2], [2, 4], [3, 5], [4, 9], [5, 10]],
  }
  const built = buildPartialTable(dataset, { variables: ['x', 'y'] })
  assert.equal(built.title, '相关（未控制其他变量）')
  // r = 21/√(10·46) = 0.979 with df = 5 - 2 = 3.
  assert.equal(built.matrix[1][2], '0.979')
  assert.equal(built.matrix[1][3], '3')
})

check('partial correlation deletes cases listwise and refuses too few', () => {
  const dataset = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }, { name: 'z', type: 'numeric' }],
    // One case lacks x, so N drops to 3; with one control that leaves df = 0.
  rows: [[1, 2, 1], [2, 4, 2], [null, 5, 3], [4, 8, 4]],
  }
  const built = buildPartialTable(dataset, { variables: ['x', 'y'], controls: ['z'] })
  assert.equal(built.matrix[1][5], '3', 'the incomplete case is dropped from N')
  assert.equal(built.matrix[1][2], '—', 'no df left, so no correlation is printed')
  assert.ok(built.notes.some((note) => /自由度不足/.test(note)))
})

check('partial correlation refuses a control that is also an analysis variable', () => {
  const dataset = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
    rows: [[1, 2], [2, 4], [3, 5]],
  }
  assert.throws(() => buildPartialTable(dataset, { variables: ['x', 'y'], controls: ['x'] }), /不能同时/)
  assert.throws(() => buildPartialTable(dataset, { variables: ['x', 'nope'] }), /不在数据集里/)
  assert.throws(() => buildPartialTable(dataset, { variables: ['x'] }), /至少需要两个/)
})

check('collinear controls are reported as collinear, not as flat residuals', () => {
  // d = 9 - c makes the design matrix singular. The old code divided by a zero
  // pivot, got all-zero residuals, and told the reader the controls explained
  // the variables away — a wrong conclusion that looked like "cannot compute".
  const dataset = {
    variables: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'numeric' })),
    rows: [[2, 3, 1, 8], [5, 4, 2, 7], [3, 9, 3, 6], [8, 2, 4, 5], [7, 6, 5, 4], [9, 1, 6, 3], [4, 8, 7, 2], [6, 5, 8, 1]],
  }
  assert.throws(
    () => buildPartialTable(dataset, { variables: ['a', 'b'], controls: ['c', 'd'] }),
    /完全共线/,
    'collinear controls have to be named as such',
  )
})

check('a string variable is refused instead of silently counting zero cases', () => {
  const dataset = {
    variables: [{ name: 'a', type: 'numeric' }, { name: 's', type: 'string' }],
    rows: [[1, 'x'], [2, 'y'], [3, 'z']],
  }
  assert.throws(() => buildPartialTable(dataset, { variables: ['a', 's'] }), /只能用于数值变量/)
  const controlled = {
    variables: [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }, { name: 's', type: 'string' }],
    rows: [[1, 2, 'x'], [2, 4, 'y'], [3, 5, 'z']],
  }
  assert.throws(() => buildPartialTable(controlled, { variables: ['a', 'b'], controls: ['s'] }), /只能用于数值变量/)
})

check('without controls the note says it is a plain Pearson correlation', () => {
  const dataset = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
    rows: [[1, 2], [2, 4], [3, 5], [4, 9], [5, 10]],
  }
  const built = buildPartialTable(dataset, { variables: ['x', 'y'] })
  assert.match(built.notes[0], /普通的 Pearson 相关/)
  assert.match(built.notes[0], /df = 有效个案数 − 2/)
  const withControl = buildPartialTable({
    variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }, { name: 'z', type: 'numeric' }],
    rows: [[1, 2, 3], [2, 4, 2], [3, 5, 5], [4, 9, 4], [5, 10, 7]],
  }, { variables: ['x', 'y'], controls: ['z'] })
  assert.match(withControl.notes[0], /控制变量个数 − 2/)
})

check('partial matrix grids the same r values as the row table', () => {
  const dataset = {
    variables: ['x', 'y', 'z', 'w'].map((name) => ({ name, type: 'numeric', label: name.toUpperCase() })),
    rows: [
      [1, 2, 3, 2], [2, 4, 2, 5], [3, 6, 5, 1], [4, 9, 4, 6], [5, 10, 7, 3],
      [6, 13, 6, 8], [7, 14, 9, 4], [8, 17, 8, 9], [9, 19, 10, 5], [10, 22, 11, 7],
    ],
  }
  const matrix = buildPartialMatrix(dataset, { variables: ['x', 'y', 'w'], controls: ['z'] })
  assert.deepEqual(matrix.matrix[0], ['', 'X', 'Y', 'W'])
  assert.equal(matrix.matrix[1][0], 'X')
  assert.equal(matrix.matrix[1][1], '1', 'the diagonal is 1')
  assert.match(matrix.matrix[1][2], /^0\.986\*\*\*$/)
  // Cells must agree with the per-pair table, which recomputes each pair.
  const rows = buildPartialTable(dataset, { variables: ['x', 'y'], controls: ['z'] })
  assert.equal(rows.matrix[1][2], '0.986')
  assert.equal(matrix.matrix[2][1], matrix.matrix[1][2], 'the grid is symmetric')
  assert.match(matrix.notes[0], /df = 10 − 1 − 2 = 7/)
})

check('partial matrix refuses the same inputs as the row table', () => {
  const dataset = {
    variables: ['x', 'y', 'c', 's'].map((name) => ({ name, type: name === 's' ? 'string' : 'numeric' })),
    // Three cases with one control leaves df = 0, so every cell has to be "—".
    rows: [[1, 2, 1, 'a'], [2, 4, 2, 'b'], [3, 5, 3, 'c']],
  }
  assert.throws(() => buildPartialMatrix(dataset, { variables: ['x'] }), /至少需要两个/)
  assert.throws(() => buildPartialMatrix(dataset, { variables: ['x', 's'] }), /只能用于数值变量/)
  assert.throws(() => buildPartialMatrix(dataset, { variables: ['x', 'y'], controls: ['x'] }), /不能同时/)
  const tooFew = buildPartialMatrix(dataset, { variables: ['x', 'y'], controls: ['c'] })
  assert.equal(tooFew.matrix[1][1], '—')
  assert.ok(tooFew.notes.some((note) => /自由度不足/.test(note)))
})

check('a perfect correlation still gets its stars', () => {
  // |r| = 1 makes t infinite; treating that as "no p value" printed a bare
  // 1.000 with no marker, which reads like a non-significant result.
  const dataset = {
    variables: [
      { name: 'a', label: 'A', type: 'numeric' },
      { name: 'b', label: 'B', type: 'numeric' },
      { name: 'c', label: 'C', type: 'numeric' },
    ],
    rows: Array.from({ length: 8 }, (_, index) => [index + 1, (index + 1) * 3, 9 - (index + 1)]),
  }
  const matrix = buildPartialMatrix(dataset, { variables: ['a', 'b'] })
  assert.equal(matrix.matrix[1][2], '1.000***', 'a duplicated variable is significant, not blank')
  assert.equal(matrix.matrix[1][1], '1', 'the diagonal stays a plain 1')
  const negative = buildPartialMatrix(dataset, { variables: ['a', 'c'] })
  assert.equal(negative.matrix[1][2], '-1.000***', 'a mirrored variable gets stars too')
  const rows = buildPartialTable(dataset, { variables: ['a', 'b'] })
  assert.equal(rows.matrix[1][6], '***', 'the row layout keeps the same convention')
})

check('user missing values are excluded from means, SD and the test', () => {
  // 999 is declared missing on age. Keeping it as data moved the mean to 281
  // and the P value to .99; PSPP itself drops it and gets 45.
  const dataset = {
    variables: [
      { name: 'grp', type: 'numeric', measure: 'nominal', valueLabels: { 1: '试验组', 2: '对照组' } },
      { name: 'age', type: 'numeric', measure: 'scale', missing: [999] },
    ],
    rows: [[1, 40], [1, 42], [1, 999], [1, 44], [2, 46], [2, 48], [2, 999], [2, 50]],
  }
  const table = buildBaselineTable(dataset, { group: 'grp', variables: ['age'] })
  assert.equal(table.matrix[1][1], '45.00 ± 3.74')
  assert.equal(table.matrix[1][4], '0.021')
  assert.ok(table.notes.some((note) => note.includes('MISSING VALUES') && note.includes('2 例')))
})

check('a THRU range of missing codes is honoured too', () => {
  const dataset = {
    variables: [
      { name: 'grp', type: 'numeric', measure: 'nominal', valueLabels: { 1: '甲', 2: '乙' } },
      { name: 'score', type: 'numeric', measure: 'scale', missing: [{ lo: 97, hi: 99 }] },
    ],
    rows: [[1, 10], [1, 98], [1, 12], [2, 20], [2, 99], [2, 22]],
  }
  const table = buildBaselineTable(dataset, { group: 'grp', variables: ['score'] })
  assert.equal(table.matrix[1][1], '16.00 ± 5.89')
})

check('a numeric code with a nominal level prints as n(%) with a chi-square', () => {
  // Gender coded 1/2 is the classic case: a mean of 1.50 ± 0.53 is wrong, the
  // table has to count levels and run chi-square.
  const dataset = {
    variables: [
      { name: 'arm', type: 'numeric', measure: 'nominal', valueLabels: { 1: '试验组', 2: '对照组' } },
      { name: 'sex', type: 'numeric', measure: 'nominal', valueLabels: { 1: '男', 2: '女' } },
    ],
    rows: [[1, 1], [1, 1], [1, 2], [1, 2], [2, 1], [2, 1], [2, 1], [2, 2]],
  }
  const table = buildBaselineTable(dataset, { group: 'arm', variables: ['sex'] })
  assert.ok(table.matrix[1][0].includes('n（%）'), 'the row is a count row')
  assert.equal(table.matrix[1][1], '8（100.0）')
  assert.ok(table.matrix[1].at(-1).startsWith('V='), "Cramér's V is reported")
})

check('two constant groups with different means have no t test', () => {
  // Zero variance in both groups: se is 0 and the difference is infinite.
  // The old code returned t = 0, p = 1 — "no difference" for complete separation.
  assert.equal(welch([5, 5, 5], [9, 9, 9]), null)
  const same = welch([5, 5], [5, 5])
  assert.equal(same.p, 1)
})


/* ------------------------------------------------------------------ *
 * 交叉表的效应量与 ICC：数字都是手算或对照已发表的算例钉住的。      *
 * ------------------------------------------------------------------ */

check("Cramér's V follows chi-square, N and the smaller dimension", () => {
  // 2×2：min(r,c)−1 = 1，V 就是 φ = sqrt(χ²/N)。PSPP 那张表里 χ²=7.59、N=20。
  assert.equal(cramersVFromChiSquare(7.59, 20, 2, 2).toFixed(4), '0.6160')
  // 3×3：V = sqrt(12 / (60×2)) = sqrt(0.1) = 0.3162。
  assert.equal(cramersVFromChiSquare(12, 60, 3, 3).toFixed(4), '0.3162')
  // 单行（r = 1）没有可解释的 V，N = 0 也没有。
  assert.equal(cramersVFromChiSquare(12, 60, 1, 3), null)
  assert.equal(cramersVFromChiSquare(12, 0, 2, 2), null)
})

check('the F quantile inverts the tail fP reports', () => {
  // df1 = 1 时 F = t²，所以 F(0.95, 1, ν) 必须等于 t(0.975, ν)²：4.9646 / 18.5128 / 6.6079。
  assert.equal(fQuantile(0.95, 1, 10).toFixed(4), '4.9646')
  assert.equal(fQuantile(0.95, 1, 2).toFixed(4), '18.5128')
  assert.equal(fQuantile(0.95, 1, 5).toFixed(4), '6.6079')
  // 教科书 F 表：F(0.975; 3, 12) = 4.47，F(0.99; 1, 1) = 4052.18。
  assert.equal(fQuantile(0.975, 3, 12).toFixed(2), '4.47')
  assert.equal(fQuantile(0.99, 1, 1).toFixed(2), '4052.18')
  // 往返：反解出来的值代回 fP 必须回到原来的上尾概率。
  for (const [p, df1, df2] of [[0.975, 5, 15], [0.025, 15, 5], [0.5, 6, 15]]) {
    assert.ok(Math.abs(fP(fQuantile(p, df1, df2), df1, df2) - (1 - p)) < 1e-9)
  }
})

// 两张矩阵都是从真实引擎输出里抄下来的（英文与中文各一份），
// 所以这里的解析器对着 PSPP 2.1.3 的实际排版，而不是我以为的排版。
const CROSSTAB_EN = [
  ['', '', '', 'b', '', 'Total'],
  ['', '', '', '1.00', '2.00', ''],
  ['a', '1.00', 'Count', '8', '1', '9'],
  ['', '', 'Expected', '4.95', '4.05', '9.00'],
  ['', '2.00', 'Count', '3', '8', '11'],
  ['', '', 'Expected', '6.05', '4.95', '11.00'],
  ['Total', '', 'Count', '11', '9', '20'],
  ['', '', 'Expected', '11.00', '9.00', '20.00'],
]
const CROSSTAB_ZH = [
  ['', '', '', 'r1', '', '', '', '', '总计'],
  ['', '', '', '6.00', '7.00', '8.00', '9.00', '10.00', ''],
  ['sexgrp', '1.00', '计数', '1', '0', '1', '1', '0', '3'],
  ['', '', '期望值', '1.00', '.50', '.50', '.50', '.50', '3.00'],
  ['', '2.00', '计数', '1', '1', '0', '0', '1', '3'],
  ['', '', '期望值', '1.00', '.50', '.50', '.50', '.50', '3.00'],
  ['总计', '', '计数', '2', '1', '1', '1', '1', '6'],
  ['', '', '期望值', '2.00', '1.00', '1.00', '1.00', '1.00', '6.00'],
]

check('crosstab counts are read back in both output languages', () => {
  const en = crosstabCounts(CROSSTAB_EN)
  assert.deepEqual(en.counts, [[8, 1], [3, 8]])
  assert.equal(en.rows, 2)
  assert.equal(en.columns, 2)
  assert.equal(en.total, 20)
  // 期望频数 4.95 / 4.05 / 4.95 三个格子 < 5。
  assert.equal(en.smallCells, 3)
  assert.equal(en.minExpected.toFixed(2), '4.05')

  const zh = crosstabCounts(CROSSTAB_ZH)
  assert.deepEqual(zh.counts, [[1, 0, 1, 1, 0], [1, 1, 0, 0, 1]])
  assert.equal(zh.rows, 2)
  assert.equal(zh.columns, 5)
  assert.equal(zh.total, 6)
  // 每个格子的期望频数都是 0.5，10 个格子全 < 5。
  assert.equal(zh.smallCells, 10)
  assert.equal(zh.minExpected.toFixed(2), '0.50')

  // 一行或一列不是交叉表：这里没有可用的行列数。
  assert.equal(crosstabCounts([['', 'Value', 'df'], ['Pearson Chi-Square', '4.00', '4']]), null)

  // 带层变量（grp BY sex BY site）的表每一层各有一套行合计，整体不是一张方表：
  // 前缀多两列、总计行只在层内出现。这里必须返回 null，否则会把 6 行当成行数
  // 算出一个和引擎不一致的 V（实测 0.183 vs 0.330）。
  const layered = [
    ['', '', '', '', '', 'sex', '', 'Total'],
    ['', '', '', '', '', '1.00', '2.00', ''],
    ['site', '1.00', 'grp', '1.00', 'Count', '2', '1', '3'],
    ['', '', '', '2.00', 'Count', '1', '2', '3'],
    ['', '', 'Total', '', 'Count', '3', '3', '6'],
    ['', '2.00', 'grp', '1.00', 'Count', '1', '1', '2'],
    ['', '', '', '2.00', 'Count', '1', '1', '2'],
    ['', '', 'Total', '', 'Count', '2', '2', '4'],
  ]
  assert.equal(crosstabCounts(layered), null)
})

check('a chi-square table without a Pearson row still gives N and the Fisher flag', () => {
  // PSPP 在 Pearson χ² 恰好为 0 时会把那一行整个省掉 —— 2×2 小样本里常见。
  const matrix = [
    ['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)', 'Exact Sig. (2-tailed)', 'Exact Sig. (1-tailed)'],
    ["Fisher's Exact Test", '', '', '', '1.000', '.800'],
    ['Continuity Correction', '.00', '1', '1.000', '', ''],
    ['Linear-by-Linear Association', '.00', '1', '1.000', '', ''],
    ['N of Valid Cases', '6', '', '', '', ''],
  ]
  assert.equal(chiSquareFromTable(matrix), null, 'no Pearson row means no chi-square value')
  // A blank Value cell is not a chi-square of zero.
  assert.equal(
    chiSquareFromTable([
      ['', 'Value', 'df'],
      ['Pearson Chi-Square', '', '1'],
      ['N of Valid Cases', '20', ''],
    ]),
    null,
    'a blank Pearson value is not read as zero',
  )


  const withPearson = [
    ['', '值', 'df', 'Asymptotic Sig. (2-tailed)'],
    ['Pearson卡方', '7.59', '1', '.006'],
    ['Fisher精确检验', '', '', '.010'],
    ['有效个案N', '20', '', ''],
  ]
  const parsed = chiSquareFromTable(withPearson)
  assert.equal(parsed.chiSquare, 7.59)
  assert.equal(parsed.df, 1)
  assert.equal(parsed.total, 20)
  assert.equal(parsed.hasFisher, true)
})

/*
 * Shrout & Fleiss (1979) 的经典算例：6 个目标 × 4 位评分者。四个系数在原文里
 * 分别是 .29 / .62 / .71 / .91，所以这张表同时钉住了公式、口径与 F 检验。
 */
const SHROUT_FLEISS = {
  variables: ['j1', 'j2', 'j3', 'j4'].map((name) => ({ name, type: 'numeric' })),
  rows: [
    [9, 2, 5, 8],
    [6, 1, 3, 2],
    [8, 4, 6, 8],
    [7, 1, 2, 6],
    [10, 5, 6, 9],
    [6, 2, 4, 7],
  ],
}

check('ICC reproduces the Shrout & Fleiss two-way example', () => {
  const table = iccTable(SHROUT_FLEISS, ['j1', 'j2', 'j3', 'j4'])
  assert.deepEqual(table.matrix[0], ['模型', 'ICC', '95% CI 下限', '95% CI 上限', 'F', 'df1', 'df2', 'Sig.'])
  assert.equal(table.cases, 6)
  assert.equal(table.items, 4)
  // 单次测量的绝对一致（2,1）= .29 与一致性（3,1）= .71 是原文给的数。
  assert.equal(table.matrix[1][1], '0.290')
  assert.equal(table.matrix[3][1], '0.715')
  // 平均测量（2,4）= .62、（3,4）= .91。
  assert.equal(table.matrix[2][1], '0.620')
  assert.equal(table.matrix[4][1], '0.909')
  // 区间：下限随口径变宽，上限不超过 1；McGraw & Wong 的区间本来就是不对称的。
  assert.equal(table.matrix[1][2], '0.019')
  assert.equal(table.matrix[1][3], '0.761')
  // F = BMS/EMS = 11.242/1.019 = 11.027，df = (n−1, (n−1)(k−1)) = (5, 15)。
  assert.equal(table.matrix[1][4], '11.027')
  assert.equal(table.matrix[1][5], '5')
  assert.equal(table.matrix[1][6], '15')
  assert.equal(table.matrix[1][7], '<0.001')
  // 四个口径共用同一个 F 检验（原假设都是 ICC = 0）。
  for (const index of [1, 2, 3, 4]) assert.equal(table.matrix[index][4], '11.027')
  assert.ok(table.notes.some((note) => note.includes('McGraw & Wong')))
  assert.ok(table.notes.some((note) => note.includes('ICC(3,1)') && note.includes('ICC(2,1)')))
})

check('ICC on three raters matches the hand-computed mean squares', () => {
  // 3 个评分者 × 3 个个案，手算：BMS = JMS = 4.111111，EMS = 0.111111。
  // 于是 ICC(2,1) = 4/(4.111111+0.222222+4) = 0.48，ICC(3,1) = 4/4.333333 = 0.9231，
  // ICC(2,3) = 4/(4.111111+4/3) = 0.7347，ICC(3,3) = 4/4.111111 = 0.9730，F = 37。
  const dataset = {
    variables: ['r1', 'r2', 'r3'].map((name) => ({ name, type: 'numeric' })),
    rows: [[1, 2, 3], [2, 3, 4], [3, 4, 6]],
  }
  const table = iccTable(dataset, ['r1', 'r2', 'r3'])
  assert.equal(table.matrix[1][1], '0.480')
  assert.equal(table.matrix[2][1], '0.735')
  assert.equal(table.matrix[3][1], '0.923')
  assert.equal(table.matrix[4][1], '0.973')
  assert.equal(table.matrix[1][4], '37.000')
  assert.equal(table.matrix[1][5], '2')
  assert.equal(table.matrix[1][6], '4')
  // F(37; 2, 4) 的上尾概率约 0.0026。
  assert.equal(table.matrix[1][7], '0.003')
  // 平均测量的行标题要写出实际评分者数，否则读者分不清 ICC(2,3) 与 ICC(2,4)。
  assert.equal(table.matrix[2][0], 'ICC(2,3) 双向随机 绝对一致 平均测量（k=3）')
})

check('ICC refuses data where it has no meaning', () => {
  const identical = {
    variables: ['a', 'b', 'c'].map((name) => ({ name, type: 'numeric' })),
    rows: [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]],
  }
  const flat = iccTable(identical, ['a', 'b', 'c'])
  assert.equal(flat.matrix.length, 0)
  assert.match(flat.notes.at(-1), /误差均方为 0/)

  const one = iccTable(identical, ['a'])
  assert.equal(one.matrix.length, 0)
  assert.match(one.notes.at(-1), /至少需要两个评分者/)

  const missing = iccTable(identical, ['a', 'nope'])
  assert.match(missing.notes.at(-1), /不存在/)

  const tooFew = iccTable({ variables: identical.variables, rows: [[1, 2, 3], [2, 3, 4]] }, ['a', 'b', 'c'])
  assert.equal(tooFew.matrix.length, 0)
  assert.match(tooFew.notes.at(-1), /少于 3 例/)
})

console.log(`\n${checks} checks passed${failures ? ` (with ${failures} failures)` : ''}`)
if (failures > 0) process.exitCode = 1
