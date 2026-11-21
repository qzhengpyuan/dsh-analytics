// Collinearity diagnostics, computed in Node because the engine crashes on TOL.
import assert from 'node:assert/strict'
import { collinearityTable, durbinWatsonTable, influenceTable } from '../lib/regression.js'
import { classifyScript, nearestVariableName, splitStatements, annotateSeparation, annotateNonFiniteCoefficients, annotateOversizedTables, annotateCrosstabs, annotateAssumptions, annotateComparisons, annotateNormality, annotateSampleSize, annotateReliabilityIcc, annotateWeightedEmpty, annotateZeroCases, inlineDataTailProblem, degradeStatistics, describeFailure, requestedCrosstabStatistics } from '../lib/workspace.js'

let checks = 0
const failures = []
const check = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

// Reference values from R on exactly this table (1 / car::vif(lm(score ~ age + id))):
// both predictors come out at 0.9113718, i.e. VIF 1.097.
const demo = {
  variables: [
    { name: 'score', type: 'numeric', label: '得分' },
    { name: 'age', type: 'numeric', label: '年龄' },
    { name: 'id', type: 'numeric', label: '编号' },
  ],
  rows: [
    [73, 53, 1], [68, 45, 2], [66, 61, 3], [60, 38, 4], [58, 49, 5],
    [72, 55, 6], [64, 42, 7], [69, 58, 8], [61, 47, 9], [57, 36, 10],
  ],
}

check('collinearity matches the R reference on a two-predictor model', () => {
  const table = collinearityTable(demo, { dependent: 'score', independents: ['age', 'id'] })
  assert.deepEqual(table.matrix[0], ['变量', '容忍度', 'VIF'])
  assert.equal(table.matrix[1][0], '年龄')
  // Rounded to three decimals either way; R prints 0.9929 / 1.0072.
  assert.equal(table.matrix[1][1], '0.911')
  assert.equal(table.matrix[1][2], '1.097')
  assert.equal(table.matrix[2][1], '0.911')
  assert.ok(table.notes.some((note) => note.includes('容忍度 = 1 − R²')))
})

check('a single predictor has tolerance and VIF of exactly one', () => {
  const table = collinearityTable(demo, { dependent: 'score', independents: ['age'] })
  assert.deepEqual(table.matrix[1], ['年龄', '1.000', '1.000'])
  assert.ok(table.notes.some((note) => note.includes('+Infinit')))
})

check('perfectly collinear predictors report a tolerance of zero', () => {
  const doubled = {
    variables: [
      { name: 'y', type: 'numeric' },
      { name: 'a', type: 'numeric', label: 'A' },
      { name: 'b', type: 'numeric', label: 'B' },
    ],
    rows: [[1, 2, 4], [2, 4, 8], [3, 6, 12], [4, 8, 16], [5, 10, 20]],
  }
  const table = collinearityTable(doubled, { dependent: 'y', independents: ['a', 'b'] })
  assert.equal(table.matrix[1][1], '0.000')
  assert.equal(table.matrix[1][2], '∞')
})

check('a variable outside a collinear block keeps its own tolerance', () => {
  // a and b are exact duplicates, so the design is singular; c is still
  // estimable and its tolerance must be 1 - R²(c ~ a) = 0.772, not 0.
  const dataset = {
    variables: [
      { name: 'a', label: 'a', type: 'numeric' },
      { name: 'b', label: 'b', type: 'numeric' },
      { name: 'c', label: 'c', type: 'numeric' },
      { name: 'y', label: 'y', type: 'numeric' },
    ],
    rows: [
      [1, 2, 3, 1], [2, 4, 1, 2], [3, 6, 4, 3], [4, 8, 1, 4],
      [5, 10, 5, 5], [6, 12, 9, 6], [7, 14, 2, 7], [8, 16, 6, 8],
    ],
  }
  const table = collinearityTable(dataset, { dependent: 'y', independents: ['a', 'b', 'c'] })
  assert.equal(table.matrix[1][1], '0.000')
  assert.equal(table.matrix[2][1], '0.000')
  assert.equal(table.matrix[3][1], '0.772')
  assert.equal(table.matrix[3][2], '1.295')
})

check('a constant predictor is undefined rather than zero', () => {
  const dataset = {
    variables: [
      { name: 'k', label: 'K', type: 'numeric' },
      { name: 'x', label: 'X', type: 'numeric' },
      { name: 'y', label: 'y', type: 'numeric' },
    ],
    rows: [[5, 1, 2], [5, 2, 4], [5, 3, 5], [5, 4, 8], [5, 5, 9]],
  }
  const table = collinearityTable(dataset, { dependent: 'y', independents: ['k', 'x'] })
  assert.equal(table.matrix[1][1], '—')
  assert.ok(table.notes.some((note) => /K 是常数/.test(note)))
  assert.equal(table.notes.filter((note) => note.includes('是常数')).length, 1, 'one note per constant predictor, not one per pair')
})

check('two constant predictors give exactly two notes', () => {
  const dataset = {
    variables: [
      { name: 'k1', label: 'K1', type: 'numeric' },
      { name: 'k2', label: 'K2', type: 'numeric' },
      { name: 'x', label: 'X', type: 'numeric' },
      { name: 'y', type: 'numeric' },
    ],
    rows: [[3, 5, 1, 2], [3, 5, 2, 4], [3, 5, 3, 5], [3, 5, 4, 8], [3, 5, 5, 9]],
  }
  const table = collinearityTable(dataset, { dependent: 'y', independents: ['k1', 'k2', 'x'] })
  const constantNotes = table.notes.filter((note) => note.includes('是常数'))
  assert.equal(constantNotes.length, 2, 'K1 and K2 each get one note')
  assert.match(constantNotes.join(' '), /K1/)
  assert.match(constantNotes.join(' '), /K2/)
})

check('the note names the collinear pair instead of blaming every row', () => {
  const doubled = {
    variables: [
      { name: 'y', type: 'numeric' },
      { name: 'a', type: 'numeric', label: 'A' },
      { name: 'b', type: 'numeric', label: 'B' },
    ],
    rows: [[1, 2, 4], [2, 4, 8], [3, 6, 12], [4, 8, 16], [5, 10, 20]],
  }
  const table = collinearityTable(doubled, { dependent: 'y', independents: ['a', 'b'] })
  // Both predictors are "fully explained" by the other, but the cause is the
  // pair itself: the note has to say which two to separate.
  assert.ok(table.notes.some((note) => /A 与 B 完全相关/.test(note)), 'the note names both variables')
  assert.ok(table.notes.some((note) => /先删掉其中一个/.test(note)))
})

check('a NaN coefficient table is explained, an ordinary one is not', () => {
  const bad = [{
    kind: 'table',
    id: 'coef',
    title: 'Coefficients',
    table: { matrix: [['', 'B', 'S.E.', 't', 'Sig.'], ['a', 'NaN', '+Infinit', '.', '.']] },
  }]
  annotateNonFiniteCoefficients(bad)
  assert.equal(bad[0].notes.length, 1)
  assert.match(bad[0].notes[0], /完全共线/)
  // Running it twice must not stack the same caveat.
  annotateNonFiniteCoefficients(bad)
  assert.equal(bad[0].notes.length, 1)

  const fine = [{ kind: 'table', id: 'c2', title: 'Coefficients', table: { matrix: [['', 'B', 't', 'Sig.'], ['a', '.37', '5.94', '.000']] } }]
  annotateNonFiniteCoefficients(fine)
  assert.equal(fine[0].notes, undefined)
  // A descriptives table with no t/Sig. pair is left alone even if it shows NaN.
  const other = [{ kind: 'table', id: 'd', title: 'Descriptives', table: { matrix: [['', 'Mean'], ['x', 'NaN']] } }]
  annotateNonFiniteCoefficients(other)
  assert.equal(other[0].notes, undefined)
})

check('too few cases say so instead of inventing numbers', () => {
  const tiny = {
    variables: [
      { name: 'y', type: 'numeric' },
      { name: 'a', type: 'numeric', label: 'A' },
      { name: 'b', type: 'numeric', label: 'B' },
    ],
    rows: [[1, 2, 3], [2, 3, 4]],
  }
  const table = collinearityTable(tiny, { dependent: 'y', independents: ['a', 'b'] })
  assert.equal(table.matrix[1][1], '—')
  assert.ok(table.notes.some((note) => note.includes('不足以估计')))
})

check('rows with a missing cell are dropped before the fit', () => {
  const holed = {
    variables: [
      { name: 'y', type: 'numeric' },
      { name: 'a', type: 'numeric', label: 'A' },
      { name: 'b', type: 'numeric', label: 'B' },
    ],
    rows: [[1, 2, 3], [2, null, 4], [3, 4, 5], [4, 5, null], [5, 6, 7], [6, 7, 8], [7, 8, 9]],
  }
  const table = collinearityTable(holed, { dependent: 'y', independents: ['a', 'b'] })
  assert.notEqual(table.matrix[1][1], '—')
})


// D8: a retry has to remove ALL as well, because /STATISTICS=ALL drags TOL in
// with it and the retry then crashes exactly like the run it was rescuing.
check('a retry strips TOL and ALL, and never leaves an empty list', () => {
  assert.equal(
    degradeStatistics('REGRESSION /DEPENDENT=y /METHOD=ENTER a /STATISTICS=COEFF R ANOVA CI TOL.'),
    'REGRESSION /DEPENDENT=y /METHOD=ENTER a /STATISTICS=COEFF R ANOVA CI.',
  )
  assert.equal(
    degradeStatistics('REGRESSION /DEPENDENT=y /METHOD=ENTER a /STATISTICS=ALL.'),
    'REGRESSION /DEPENDENT=y /METHOD=ENTER a /STATISTICS=COEFF R ANOVA CI BCOV.',
  )
  // A lone TOL leaves nothing behind; an empty /STATISTICS= produces no table.
  assert.equal(
    degradeStatistics('REGRESSION /DEPENDENT=y /METHOD=ENTER a /STATISTICS=TOL.'),
    'REGRESSION /DEPENDENT=y /METHOD=ENTER a /STATISTICS=COEFF R ANOVA CI BCOV.',
  )
  // Other commands keep their own STATISTICS keywords untouched.
  assert.equal(
    degradeStatistics('FREQUENCIES /VARIABLES=x /STATISTICS=ALL.'),
    'FREQUENCIES /VARIABLES=x /STATISTICS=ALL.',
  )
  // Multi-line commands survive the rewrite with their layout intact.
  const multi = "GET FILE='x.sav'.\nREGRESSION\n  /DEPENDENT=y\n  /METHOD=ENTER a b\n  /STATISTICS=ALL."
  assert.equal(
    degradeStatistics(multi),
    "GET FILE='x.sav'.\nREGRESSION\n  /DEPENDENT=y\n  /METHOD=ENTER a b\n  /STATISTICS=COEFF R ANOVA CI BCOV.",
  )
})

// D8: the old message read "引擎没有产出任何表：引擎没有给出原因" and threw away the
// GSL line. It now carries the exit code and the engine's own words.
check('a crash with no tables reports the exit code and the engine line', () => {
  const text = describeFailure({
    code: 19,
    stderr: '',
    stdout: 'src/math/linreg.c:261:gsl_blas_dsymm: matrix/vector sizes are not conformant',
  })
  assert.ok(text.includes('退出码 19'), text)
  assert.ok(text.includes('gsl_blas_dsymm'), text)
  const named = describeFailure({ code: 1, stderr: 'error: nosuchvar is not a variable name.', stdout: '' })
  assert.ok(named.includes('退出码 1') && named.includes('nosuchvar'), named)
  const silent = describeFailure({ code: 2, stderr: '', stdout: '' })
  assert.equal(silent, '退出码 2，引擎没有输出任何诊断信息')
})


// PSPP prints "Variables in the Equation" with two header rows: the first carries
// B/S.E./Wald/df/Sig./Exp(B), the second carries the Lower/Upper labels of the CI.
// The separation note has to read that shape and only trust predictor rows.
const equationMatrix = (predictor, constant) => [
  ['', '', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)', '95% CI for Exp(B)', ''],
  ['', '', '', '', '', '', '', '', 'Lower', 'Upper'],
  predictor,
  constant,
]
const separationNotes = (matrix) => {
  const items = [{ kind: 'table', id: 'x', title: 'Variables in the Equation', table: { matrix } }]
  annotateSeparation(items, 'logistic')
  return items[0].notes ?? []
}

check('a big intercept is not separation', () => {
  // 2000 cases with 10 negatives: the constant legitimately reaches Exp(B)=149.40
  // while the predictor is ordinary (B=.30, S.E.=.55, Exp(B)=1.35, CI .46-4.01).
  const matrix = equationMatrix(
    ['Step 1', 'score', '.30', '.55', '.30', '1', '.586', '1.35', '.46', '4.01'],
    ['', '常数', '5.01', '.46', '118.6', '1', '.000', '149.40', '', ''],
  )
  assert.deepEqual(separationNotes(matrix), [])
})

check('a genuinely strong predictor is not separation either', () => {
  // OR 150 with a tight CI (120-190) is a real effect, not a runaway estimate.
  const matrix = equationMatrix(
    ['Step 1', 'score', '5.01', '.12', '1742', '1', '.000', '150.00', '120.00', '190.00'],
    ['', 'Constant', '-5.06', '1.32', '14.70', '1', '.000', '.01', '', ''],
  )
  assert.deepEqual(separationNotes(matrix), [])
})

check('an exploding standard error raises the note', () => {
  const matrix = equationMatrix(
    ['Step 1', 'score', '23.06', '5073.53', '.00', '1', '.996', '1.03E+010', '.000', '+Infinit'],
    ['', 'Constant', '-1.02', '.48', '4.5', '1', '.034', '.36', '', ''],
  )
  const notes = separationNotes(matrix)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /Firth/)
})

check('a confidence interval wider than a thousandfold raises the note', () => {
  // Exp(B)=55.06 alone is below the old 100 threshold, but CI .81-3765.36 is not
  // a usable interval: it is the same separation seen from the other side.
  const matrix = equationMatrix(
    ['Step 1', 'score', '.52', '2.13', '.06', '1', '.807', '55.06', '.81', '3765.36'],
    ['', 'Constant', '-1.02', '.48', '4.5', '1', '.034', '.36', '', ''],
  )
  assert.equal(separationNotes(matrix).length, 1)
})

check('a table without CI columns still works', () => {
  // The label sits in column 1, so B starts at column 2 — the same offset PSPP uses.
  const matrix = [
    ['', '', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)'],
    ['Step 1', 'score', '-9.20', '1200.40', '.00', '1', '.999', '.00'],
  ]
  assert.equal(separationNotes(matrix).length, 1)
})

check('other tables are left alone', () => {
  const items = [{ kind: 'table', id: 'x', title: 'ANOVA', table: { matrix: [['变量', 'N'], ['a', '1']] } }]
  annotateSeparation(items, 'oneway')
  assert.equal(items[0].notes, undefined)
})

check('a frequency table over a continuous variable is flagged as oversized', () => {
  const matrix = [['值', 'Frequency', 'Percent']]
  for (let value = 0; value < 600; value += 1) matrix.push([String(value), '1', '.2'])
  const items = [{ kind: 'table', id: 'big', title: 'score', table: { matrix } }]
  annotateOversizedTables(items)
  assert.equal(items[0].notes.length, 1)
  assert.match(items[0].notes[0], /这张表有 601 行/)
  assert.match(items[0].notes[0], /描述统计/)
})

check('an ordinary table is not flagged', () => {
  const items = [{ kind: 'table', id: 'small', title: 'ANOVA', table: { matrix: [['a', 'b'], ['1', '2']] } }]
  annotateOversizedTables(items)
  assert.equal(items[0].notes, undefined)
})


/* ------------------------------------------------------------------ *
 * 交叉表表注与 ICC：矩阵取自真实引擎输出，表注文案要能被读者直接照做。 *
 * ------------------------------------------------------------------ */

const chiSquareTable = (rows, caption = 'Chi-Square Tests') => ({
  kind: 'table',
  id: 'chi',
  title: caption,
  table: { caption, matrix: rows },
})

// 2×2、CHISQ 只请求卡方（没有 PHI，所以没有 Symmetric Measures 表）。
const items2x2 = () => [
  {
    kind: 'table',
    id: 'xtab',
    title: 'a × b',
    table: {
      caption: 'a × b',
      matrix: [
        ['', '', '', 'b', '', 'Total'],
        ['', '', '', '1.00', '2.00', ''],
        ['a', '1.00', 'Count', '8', '1', '9'],
        ['', '2.00', 'Count', '3', '8', '11'],
        ['Total', '', 'Count', '11', '9', '20'],
      ],
    },
  },
  chiSquareTable([
    ['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)'],
    ['Pearson Chi-Square', '7.59', '1', '.006'],
    ["Fisher's Exact Test", '', '', '.010'],
    ['N of Valid Cases', '20', '', ''],
  ]),
]

check("a crosstab without engine Cramer's V gets the row and the note", () => {
  const items = items2x2()
  annotateCrosstabs(items)
  const matrix = items[1].table.matrix
  assert.equal(matrix.at(-1)[0], "Cramér's V")
  // V = sqrt(7.59 / (20 × 1)) = 0.616，2×2 里和 φ 同值，表里按同列两位小数打 0.62。
  assert.equal(matrix.at(-1)[1], '0.62')
  const note = items[1].notes.find((text) => text.includes("Cramér's V"))
  assert.match(note, /0\.616/)
  assert.match(note, /φ/)
  // 2×2 且三个格子期望频数 < 5，必须点名 Fisher 那一行，而不是只说「近似不可靠」。
  const small = items[1].notes.find((text) => text.includes('期望频数'))
  assert.match(small, /Fisher's Exact Test/)
  assert.match(small, /Exact Sig\./)
})

check('a table with small expected counts says how many and what to do', () => {
  // 2×3 with 12 cases: every expected count is 2, so the approximation is gone.
  const items = [
    {
      kind: 'table',
      id: 'xtab',
      title: 'a × b',
      table: {
        caption: 'a × b',
        matrix: [
          ['', '', '', 'b', '', '', 'Total'],
          ['', '', '', 'x', 'y', 'z', ''],
          ['a', 'p', 'Count', '2', '2', '2', '6'],
          ['', 'q', 'Count', '2', '2', '2', '6'],
          ['Total', '', 'Count', '4', '4', '4', '12'],
        ],
      },
    },
  ]
  annotateCrosstabs(items)
  const note = items[0].notes.find((text) => text.includes('期望频数'))
  assert.match(note, /6 个单元格的期望频数 < 5/, 'the number of thin cells is named')
  assert.match(note, /2\.00/, 'the smallest expected count is named')
  assert.match(note, /精确卡方 p/, 'a 2×3 table points at the exact test instead of Fisher')
})

check('a homogeneity test that fails is stated next to the table', () => {
  const items = [
    {
      kind: 'table',
      id: 'levene',
      title: 'Test of Homogeneity of Variances',
      table: {
        caption: 'Test of Homogeneity of Variances',
        matrix: [
          ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
          ['Based on Mean', '4.812', '2', '21', '.019'],
        ],
      },
    },
    {
      kind: 'table',
      id: 'levene-ok',
      title: 'Test of Homogeneity of Variances',
      table: {
        caption: 'Test of Homogeneity of Variances',
        matrix: [
          ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
          ['Based on Mean', '0.412', '2', '21', '.667'],
        ],
      },
    },
  ]
  annotateAssumptions(items)
  assert.match(items[0].notes[0], /p = 0\.019/, 'the significance is quoted')
  assert.match(items[0].notes[0], /没有 Welch 行/, 'a one-way ANOVA is not told to read a row it does not print')
  assert.equal(items[1].notes, undefined, 'a variance-homogeneous run gets no note')
})

check('a blank normality row is not a deviation at p < 0.001', () => {
  const items = [{
    kind: 'table',
    id: 'norm-blank',
    title: 'Tests of Normality',
    table: {
      caption: 'Tests of Normality',
      matrix: [
        ['', 'Shapiro-Wilk', '', ''],
        ['', 'Statistic', 'df', 'Sig.'],
        ['skew', '.37', '10', ''],
        ['flat', '.98', '10', '.640'],
      ],
      notes: [],
    },
  }]
  annotateNormality(items)
  assert.equal((items[0].notes ?? []).length, 0, 'a blank Sig. cell says nothing about normality')

  const mixed = [{
    kind: 'table',
    id: 'norm-mixed',
    title: 'Tests of Normality',
    table: {
      caption: 'Tests of Normality',
      matrix: [
        ['', 'Shapiro-Wilk', '', ''],
        ['', 'Statistic', 'df', 'Sig.'],
        ['skew', '.37', '10', ''],
        ['bad', '.31', '10', '.001'],
      ],
    },
  }]
  annotateNormality(mixed)
  assert.match(mixed[0].notes[0], /bad/, 'a real p value is still reported')
  assert.ok(!/skew/.test(mixed[0].notes[0]), 'the blank row is left out')
})

check('a blank significance cell is not read as p = 0', () => {
  // Number('') is 0, so a table whose Levene column is empty used to trigger the
  // loudest warning the plugin has: "variance differs, p < 0.001".
  const blank = [{
    kind: 'table',
    id: 'levene-blank',
    title: 'Test of Homogeneity of Variances',
    table: {
      caption: 'Test of Homogeneity of Variances',
      matrix: [
        ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
        ['Based on Mean', '', '2', '15', ''],
      ],
    },
  }]
  annotateAssumptions(blank)
  assert.equal(blank[0].notes, undefined, 'no p value means no variance warning')

  const partial = [{
    kind: 'table',
    id: 'levene-partial',
    title: 'Test of Homogeneity of Variances',
    table: {
      caption: 'Test of Homogeneity of Variances',
      matrix: [
        ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
        ['Based on Median', '1.100', '2', '15', '.021'],
        ['Based on Mean', '', '2', '15', ''],
      ],
    },
  }]
  annotateAssumptions(partial)
  assert.match(partial[0].notes[0], /p = 0\.021/, 'a later row with a real p value still counts')
})

check('a variance test that underflows still warns, and a t test names the Welch row', () => {
  const anova = [{
    kind: 'table',
    id: 'levene-zero',
    title: 'Test of Homogeneity of Variances',
    table: {
      caption: 'Test of Homogeneity of Variances',
      matrix: [
        ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
        ['Based on Mean', '120.351', '2', '15', '.000'],
      ],
    },
  }]
  annotateAssumptions(anova)
  assert.match(anova[0].notes[0], /p < 0\.001/, 'an underflowing significance is not silently dropped')
  assert.match(anova[0].notes[0], /没有 Welch 行/, 'and the advice fits the ANOVA that produced it')

  // PSPP prints two header rows here: the Levene group and the t test group
  // sit above "F | Sig. | t | df | Sig. (2-tailed)", and the "not assumed" row
  // leaves the Levene columns blank. Reading "the last number in the row" would
  // pick up the t test's own p instead of Levene's.
  const ttest = [
    {
      kind: 'table',
      id: 'group-stats',
      title: 'Group Statistics',
      table: { caption: 'Group Statistics', matrix: [['g', 'N', 'Mean'], ['1', '6', '3.5'], ['2', '6', '9.5']] },
    },
    {
      kind: 'table',
      id: 'independent',
      title: 'Independent Samples Test',
      table: {
        caption: 'Independent Samples Test',
        matrix: [
          ['', '', "Levene's Test for Equality of Variances", '', 'T-Test for Equality of Means', '', '', '', ''],
          ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', '', ''],
          ['', '', '', '', '', '', '', 'Lower', 'Upper'],
          ['score', 'Equal variances assumed', '140.46', '.000', '.00', '10.00', '.999', '-2.1', '2.1'],
          ['', 'Equal variances not assumed', '', '', '.00', '5.00', '.999', '-3.0', '3.0'],
        ],
      },
    },
  ]
  annotateAssumptions(ttest)
  assert.match(ttest[1].notes[0], /p < 0\.001/, 'the blank cells of the not-assumed row do not hide the significance')
  assert.match(ttest[1].notes[0], /不假定等方差/, 'and the Welch row is named for a t test')
  assert.equal(ttest[0].notes, undefined, 'the descriptive table gets nothing')
})

check("the engine's own Cramer's V is not duplicated", () => {
  const items = items2x2()
  items.push({
    kind: 'table',
    id: 'sym',
    title: 'Symmetric Measures',
    table: {
      caption: 'Symmetric Measures',
      matrix: [
        ['', '', 'Value'],
        ['Nominal by Nominal', 'Phi', '.62'],
        ['', "Cramer's V", '.62'],
        ['N of Valid Cases', '', '20'],
      ],
    },
  })
  const before = items[1].table.matrix.length
  annotateCrosstabs(items)
  assert.equal(items[1].table.matrix.length, before, 'no second V row when the engine printed one')
  assert.match(items[1].notes.find((text) => text.includes("Cramér's V")), /Symmetric Measures/)
})

check("a blank Cramer's V cell does not become zero association", () => {
  // Number('') is 0: reporting V = 0 would claim "no association" when the
  // engine simply left the cell empty.
  const items = items2x2()
  items.push({
    kind: 'table',
    id: 'sym-blank',
    title: 'Symmetric Measures',
    table: {
      caption: 'Symmetric Measures',
      matrix: [
        ['', '', 'Value'],
        ['Nominal by Nominal', 'Phi', ''],
        ['', "Cramer's V", ''],
        ['N of Valid Cases', '', '20'],
      ],
    },
  })
  annotateCrosstabs(items)
  const row = items[1].table.matrix.find((candidate) => /Cramér's V/i.test(String((candidate ?? []).join(' '))))
  assert.ok(row, 'the plugin still adds its own row')
  assert.ok(!/^0(\.0+)?$/.test(String(row[2] ?? '').trim()), `a blank engine cell must not produce 0, got ${row[2]}`)
})

await check('a save that times out says so instead of blaming the file', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { writeSav } = await import('../lib/dataset.js')
  const root = await mkdtemp(join(tmpdir(), 'ap-sav-timeout-'))
  try {
    const dataset = {
      variables: [{ name: 'score', type: 'numeric' }],
      rows: [[1], [2]],
    }
    await assert.rejects(
      () => writeSav(async () => ({ code: null, timedOut: true, stderr: '', stdout: '' }), dataset, join(root, 'work.sav')),
      (error) => /超时/.test(error.message) && !/引擎没有给出原因/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('a typo in a variable name gets the nearest real name', () => {
  const variables = [{ name: 'score' }, { name: 'group' }, { name: 'age' }]
  assert.match(nearestVariableName('DESCRIPTIVES: scroe is not a variable name.', variables), /最接近的是 score/)
  assert.match(nearestVariableName('DESCRIPTIVES: groupp is not a variable name.', variables), /最接近的是 group/)
  assert.doesNotMatch(nearestVariableName('FREQUENCIES: income_total is not a variable name.', variables), /最接近的是/)
  assert.equal(nearestVariableName('no complaint here', variables), '')
})

check('the collinearity note does not point at a table this run never printed', () => {
  const coefficients = (caption) => ({
    kind: 'table',
    id: caption,
    title: caption,
    table: {
      caption,
      matrix: [
        ['', 'B', 'Std. Error', 't', 'Sig.'],
        ['(Constant)', '1.00', '.10', '10.00', '.000'],
        ['x1', 'NaN', 'NaN', 'NaN', 'NaN'],
      ],
    },
  })
  const alone = [coefficients('Coefficients')]
  annotateNonFiniteCoefficients(alone)
  const note = alone[0].notes.find((text) => text.includes('NaN'))
  assert.match(note, /这次没有生成「共线性诊断」表/, 'without the diagnostics table the note must not send the reader looking for it')

  const withDiagnostics = [coefficients('Coefficients'), {
    kind: 'table',
    id: 'cd',
    title: 'Collinearity Diagnostics',
    table: { caption: 'Collinearity Diagnostics', matrix: [['', 'Dimension', 'Eigenvalue', 'Condition Index']] },
  }]
  annotateNonFiniteCoefficients(withDiagnostics)
  const second = withDiagnostics[0].notes.find((text) => text.includes('NaN'))
  assert.match(second, /先看「共线性诊断」表/, 'when the table is there the note still points at it')
})

check('a rectangular table says why Kappa is missing instead of showing a number', () => {
  const items = [
    {
      kind: 'table',
      id: 'xtab',
      title: 'a × b',
      table: {
        caption: 'a × b',
        matrix: [
          ['', '', '', 'b', '', '', 'Total'],
          ['', '', '', '1.00', '2.00', '3.00', ''],
          ['a', '1.00', 'Count', '4', '2', '1', '7'],
          ['', '2.00', 'Count', '2', '4', '1', '7'],
          ['Total', '', 'Count', '6', '6', '2', '14'],
        ],
      },
    },
    chiSquareTable([
      ['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)'],
      ['Pearson Chi-Square', '2.50', '2', '.287'],
      ['N of Valid Cases', '14', '', ''],
    ]),
    {
      kind: 'table',
      id: 'sym',
      title: 'Symmetric Measures',
      table: { caption: 'Symmetric Measures', matrix: [['', '', 'Value'], ['N of Valid Cases', '', '14']] },
    },
  ]
  annotateCrosstabs(items)
  const note = items[2].notes.find((text) => text.includes('Kappa'))
  assert.match(note, /2×3/)
  assert.match(note, /方表/)
  // 2×3 没有 Fisher，但插件自己能算精确检验：卡片近似不可靠的话要说清楚出口。
  assert.match(items[1].notes.find((text) => text.includes('期望频数')), /精确检验（插件按边际枚举）/)
})

check('a 2×2 Kappa row is explained but not recomputed', () => {
  const items = items2x2()
  items.push({
    kind: 'table',
    id: 'sym',
    title: 'Symmetric Measures',
    table: {
      caption: 'Symmetric Measures',
      matrix: [['', '', 'Value', 'Asymp. Std. Error', 'Approx. T'], ['Measure of Agreement', 'Kappa', '.60', '.18', '2.76']],
    },
  })
  annotateCrosstabs(items)
  const note = items[2].notes.find((text) => text.includes('Kappa'))
  assert.match(note, /0\.600/)
  assert.match(note, /方表/)
})

check('a row/column count that cannot explain the df suppresses the V row', () => {
  const items = [
    {
      kind: 'table',
      id: 'xtab',
      title: 'a × b',
      table: {
        caption: 'a × b',
        matrix: [
          ['', '', '', 'b', '', '', 'Total'],
          ['', '', '', '1.00', '2.00', '3.00', ''],
          ['a', '1.00', 'Count', '4', '2', '1', '7'],
          ['', '2.00', 'Count', '2', '4', '1', '7'],
          ['', '3.00', 'Count', '1', '1', '2', '4'],
          ['Total', '', 'Count', '7', '7', '4', '18'],
        ],
      },
    },
    // df = 1 只对应 2×c 的表，与 3×3 的计数矛盾（层变量或合并类别时可能出现）。
    chiSquareTable([
      ['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)'],
      ['Pearson Chi-Square', '2.50', '1', '.114'],
      ['N of Valid Cases', '18', '', ''],
    ]),
  ]
  const before = items[1].table.matrix.length
  annotateCrosstabs(items)
  assert.equal(items[1].table.matrix.length, before)
  assert.match(items[1].notes.find((text) => text.includes('df')), /没有写 Cramér's V/)
})

check('a layered crosstab is explained instead of guessed at', () => {
  const items = [
    {
      kind: 'table',
      id: 'xtab',
      title: 'grp × sex × site',
      table: {
        caption: 'grp × sex × site',
        matrix: [
          ['', '', '', '', '', 'sex', '', 'Total'],
          ['', '', '', '', '', '1.00', '2.00', ''],
          ['site', '1.00', 'grp', '1.00', 'Count', '2', '1', '3'],
          ['', '', '', '2.00', 'Count', '1', '2', '3'],
          ['', '', 'Total', '', 'Count', '3', '3', '6'],
        ],
      },
    },
    chiSquareTable([
      ['', '', '', 'Value', 'df', 'Asymptotic Sig. (2-tailed)', 'Exact Sig. (2-tailed)', 'Exact Sig. (1-tailed)'],
      ['site', '1.00', "Fisher's Exact Test", '', '', '', '1.000', '.500'],
      ['', '', 'N of Valid Cases', '6', '', '', '', ''],
    ]),
  ]
  const before = items[1].table.matrix.length
  annotateCrosstabs(items)
  // 不猜行列数：交叉表上加一句说明，卡方表不动、也不追加 V 行。
  assert.match(items[0].notes.find((text) => text.includes('层变量')), /没有算 Cramér's V/)
  assert.equal(items[1].table.matrix.length, before)
  assert.equal(items[1].notes, undefined)
})

/* ------------------------------------------------------------------ *
 * ICC 表：追加位置、算法来源三个前提（语法只跑信度、N 与引擎一致）。 *
 * ------------------------------------------------------------------ */

const iccDataset = () => ({
  variables: ['j1', 'j2', 'j3', 'j4'].map((name) => ({ name, type: 'numeric' })),
  rows: [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]],
})

const reliabilityItems = (valid = '6') => [
  {
    kind: 'table',
    id: 'summary',
    title: 'Case Processing Summary',
    table: {
      caption: 'Case Processing Summary',
      matrix: [['Cases', 'N', 'Percent'], ['Valid', valid, '100.0%'], ['Excluded', '0', '.0%'], ['Total', '6', '100.0%']],
    },
  },
  {
    kind: 'table',
    id: 'stats',
    title: 'Reliability Statistics',
    table: { caption: 'Reliability Statistics', matrix: [["Cronbach's Alpha", 'N of Items'], ['.91', '4']] },
  },
]

check('ICC is appended after the reliability tables', () => {
  const items = reliabilityItems()
  annotateReliabilityIcc(items, iccDataset(), "RELIABILITY /VARIABLES=j1 j2 j3 j4 /SCALE('all') ALL /MODEL=ALPHA.", 7)
  assert.equal(items.length, 3)
  const icc = items[2]
  assert.equal(icc.kind, 'table')
  assert.equal(icc.title, '组内相关系数 ICC（插件计算）')
  assert.equal(icc.runId, 7)
  assert.equal(icc.id, 'run-7-2')
  assert.equal(icc.table.matrix[1][1], '0.290')
  // 表注要把口径、公式和「不适用」都写出来，读者不该还去翻别处。
  const text = icc.notes.join('\n')
  assert.match(text, /ICC\(2,1\)/)
  assert.match(text, /单次测量/)
  assert.match(text, /平均测量/)
  assert.match(text, /Kappa/)
  assert.match(text, /McGraw & Wong/)
})

check('ICC is skipped when the syntax changes the data first', () => {
  const items = reliabilityItems()
  annotateReliabilityIcc(items, iccDataset(), 'COMPUTE j1 = j1 * 2.\nEXECUTE.\nRELIABILITY /VARIABLES=j1 j2 j3 j4.', 8)
  assert.equal(items.length, 2, 'no ICC table was invented')
  assert.match(items[1].notes.at(-1), /没有计算 ICC/)
  assert.match(items[1].notes.at(-1), /单独跑一次/)
})

check('ICC is skipped when the engine counted different cases', () => {
  // 引擎的有效个案是 5，而插件重算得到 6：不是同一批数据，ICC 就不能贴上去。
  const items = reliabilityItems('5')
  annotateReliabilityIcc(items, iccDataset(), 'RELIABILITY /VARIABLES=j1 j2 j3 j4.', 9)
  assert.equal(items.length, 2)
  assert.match(items[1].notes.at(-1), /引擎的有效个案是 5/)
  assert.match(items[1].notes.at(-1), /6 例/)
})

check('ICC is not attempted when no reliability table came back', () => {
  const items = [chiSquareTable([['', 'Value', 'df'], ['Pearson Chi-Square', '1.00', '1']])]
  annotateReliabilityIcc(items, iccDataset(), 'RELIABILITY /VARIABLES=j1 j2 j3 j4.', 10)
  assert.equal(items.length, 1)
})


check('collinearity drops the user\'s missing-value codes', () => {
  const variables = [
    { name: 'y', type: 'numeric' },
    { name: 'a', type: 'numeric', missing: [999] },
    { name: 'b', type: 'numeric' },
  ]
  // a is 1..8 plus a 999 in the ninth case; b is a's mirror plus noise. With the
  // 999 kept, the tolerance of the honest pair moved from 0.911 to 0.728.
  const rows = []
  for (let index = 0; index < 8; index += 1) {
    rows.push([index + 1, index + 1, 8 - index])
  }
  const clean = rows.slice()
  rows.push([999, 999, 999])
  const withCode = collinearityTable({ variables, rows }, { dependent: 'y', independents: ['a', 'b'] })
  const without = collinearityTable({ variables, rows: clean }, { dependent: 'y', independents: ['a', 'b'] })
  assert.ok(withCode, 'a table is produced')
  // The 999 case must be dropped, so both grids are identical; keeping it used
  // to move the tolerance from 0.911 to 0.728.
  assert.deepEqual(withCode.matrix, without.matrix)
})

if (failures.length > 0) process.exitCode = 1

check('a requested crosstab statistic the engine skipped is named, with the reason', () => {
  const items = items2x2()
  annotateCrosstabs(items, { statistics: ['RISK', 'ETA'] })
  const note = items[0].notes.find((text) => text.includes('引擎没有输出'))
  assert.ok(note, 'the note about the skipped statistics is there')
  assert.match(note, /RISK/)
  assert.match(note, /风险估计只在 2×2 表里输出/)
  assert.match(note, /ETA/)
})

check('no complaint when the engine did print the requested table', () => {
  const items = items2x2()
  items.push({
    kind: 'table',
    id: 'risk',
    title: 'Risk Estimate',
    table: { caption: 'Risk Estimate', matrix: [['', 'Value'], ['Odds Ratio for a (1 / 2)', '21.33']] },
  })
  annotateCrosstabs(items, { statistics: ['RISK'] })
  assert.equal((items[0].notes ?? []).some((text) => text.includes('引擎没有输出')), false)
})

check('requested statistics come out of the syntax, not out of thin air', () => {
  const asked = requestedCrosstabStatistics('CROSSTABS /TABLES=a BY b /STATISTICS=CHISQ PHI RISK ETA /CELLS=COUNT.')
  assert.deepEqual(asked, ['CHISQ', 'PHI', 'RISK', 'ETA'])
  assert.deepEqual(requestedCrosstabStatistics('FREQUENCIES /VARIABLES=x.'), [])
})

check('Durbin-Watson is worked out from residuals in case order', () => {
  const dataset = {
    variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric' }],
    // A zig-zag around the line y = x: residuals alternate, so DW lands high.
    rows: [[2.1, 1], [1.9, 2], [3.2, 3], [2.8, 4], [5.1, 5], [4.9, 6]],
  }
  const table = durbinWatsonTable(dataset, { dependent: 'y', independents: ['x'] })
  assert.equal(table.title, 'Durbin-Watson（插件计算）')
  const rows = table.matrix.slice(1)
  assert.equal(rows[1][0], '个案数')
  assert.equal(rows[1][1], '6')
  assert.equal(rows[2][0], '预测变量数')
  const dw = Number(rows[0][1])
  assert.ok(dw > 2 && dw < 4, `alternating residuals give DW above 2, got ${dw}`)
  // Hand-checked: residuals e = (-.09, .19, -.11, .21, -.09, .19) around the fit
  // give sum((e_t - e_t-1)^2) / sum(e^2) = 3.234.
  assert.equal(rows[0][1], '3.234')
  // n = 6 is below the bounds table, so the note must say so instead of quoting it.
  assert.ok(table.notes.some((note) => note.includes('小于 15')), 'small samples do not get the bounds sentence')

  // A model that fits exactly has no residual variance to divide by.
  const exact = durbinWatsonTable({
    variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric' }],
    rows: [[1, 1], [2, 2], [3, 3], [4, 4]],
  }, { dependent: 'y', independents: ['x'] })
  assert.equal(exact, null, 'a perfect fit has no DW')

  // The missing-value codes the tables honour are dropped here too.
  const withCodes = durbinWatsonTable({
    variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric', missing: [999] }],
    rows: [[2.1, 1], [1.9, 2], [3.2, 999], [2.8, 4], [5.1, 5], [4.9, 6]],
  }, { dependent: 'y', independents: ['x'] })
  assert.equal(withCodes.matrix[2][1], '5', 'the missing code is excluded, so n drops to 5')

  // Twenty cases clear the bounds table.
  const big = { variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric' }], rows: [] }
  for (let i = 1; i <= 20; i += 1) big.rows.push([i + (i % 3 === 0 ? 0.4 : -0.2), i])
  const bigTable = durbinWatsonTable(big, { dependent: 'y', independents: ['x'] })
  assert.ok(bigTable.notes.some((note) => note.includes('5% 界限')), 'a big sample gets the bounds verdict')
  assert.equal(durbinWatsonTable(big, { dependent: 'y', independents: [] }), null, 'no predictors, no DW')
})

check("influence diagnostics use the hat matrix, not an inverse that collinearity breaks", () => {
  // Five points: four on y = 2x + 1, one pulled far away. For a simple
  // regression the leverage is 1/n + (x - x̄)²/Sxx = .6/.3/.2/.3/.6, which is
  // what an independent derivation gives and what the table must print.
  const dataset = {
    variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric' }],
    rows: [[3, 1], [5, 2], [7, 3], [9, 4], [30, 5]],
  }
  const table = influenceTable(dataset, { dependent: 'y', independents: ['x'] })
  assert.equal(table.title, "影响诊断（插件计算）")
  assert.equal(table.n, 5)
  assert.equal(table.matrix[0].join('|'), '个案号|杠杆值|Cook D|Mahalanobis 距离|标记')
  const body = table.matrix.slice(1)
  assert.equal(body.length, 5, 'every usable case is listed when there are few')
  assert.deepEqual(body.map((row) => row[0]), ['5', '1', '4', '3', '2'], 'sorted by Cook\'s D, largest first')
  assert.deepEqual(body.map((row) => row[1]), ['0.6000', '0.6000', '0.3000', '0.2000', '0.3000'])
  assert.equal(body[0][2], '2.2500', "hand-checked Cook's D for the wild case")
  assert.match(body[0][4], /Cook D 超 4\/n/)
  assert.equal(table.flagged, 1)
  // Mahalanobis of the predictor vector: sqrt((n-1)(h - 1/n)).
  assert.equal(body[0][3], '1.265')
  assert.equal(body[3][3], '0.000', 'the case at the mean of x has distance 0')

  // The same missing-value codes the other tables honour are dropped here.
  const withCodes = influenceTable({
    variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric', missing: [999] }],
    rows: [[3, 1], [5, 2], [7, 999], [9, 4], [30, 5]],
  }, { dependent: 'y', independents: ['x'] })
  assert.equal(withCodes.n, 4, 'the declared missing code is excluded')

  // Two identical predictors have no invertible X'X; leverage still exists, so
  // the honest answer is the projection, not a crash or a table of NaN.
  const duplicate = influenceTable({
    variables: [{ name: 'y', type: 'numeric' }, { name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }],
    rows: [[3, 1, 1], [5, 2, 2], [7, 3, 3], [9, 4, 4], [30, 5, 5]],
  }, { dependent: 'y', independents: ['a', 'b'] })
  assert.equal(duplicate, null, 'a rank-deficient design gets no influence table rather than nonsense')

  // A perfect fit leaves no residual variance for Cook's D to use. The leverage
  // is still perfectly well defined, so the row must say why the column is
  // empty instead of borrowing the "leverage near 1" flag.
  const perfect = influenceTable({
    variables: [{ name: 'y', type: 'numeric' }, { name: 'x', type: 'numeric' }],
    rows: [[3, 1], [5, 2], [7, 3], [9, 4], [11, 5]],
  }, { dependent: 'y', independents: ['x'] })
  assert.ok(perfect, 'a perfect fit still produces leverage and Mahalanobis')
  assert.deepEqual(perfect.matrix.slice(1).map((row) => row[2]), ['—', '—', '—', '—', '—'], "Cook's D is undefined")
  assert.ok(perfect.matrix.slice(1).every((row) => row[4].includes('完美拟合')), 'and the flag says so')
  assert.ok(perfect.matrix.slice(1).every((row) => !row[4].includes('杠杆接近 1')), 'no borrowed leverage flag')

  assert.equal(influenceTable(dataset, { dependent: 'y', independents: [] }), null)
  assert.equal(influenceTable({ variables: [], rows: [] }, { dependent: 'y', independents: ['x'] }), null)
})


// The engine prints the normality test; a run that shows "Sig. .000" next to a
// t test and says nothing is how a non-statistician ends up quoting a p value
// that assumes a normal distribution. The shape below is PSPP's real output.
check('a normality test that fails is stated next to the table', () => {
  const make = (p) => [{
    kind: 'table',
    table: { caption: 'Tests of Normality', matrix: [['', 'Shapiro-Wilk', '', ''], ['', 'Statistic', 'df', 'Sig.'], ['score', '.87', '12', p]] },
    notes: [],
  }]
  const quiet = make('.06')
  annotateNormality(quiet)
  assert.deepEqual(quiet[0].notes, [], 'p = .06 is not a warning')

  const bad = make('.000')
  annotateNormality(bad)
  assert.equal(bad[0].notes.length, 1)
  assert.match(bad[0].notes[0], /正态性检验/)
  assert.match(bad[0].notes[0], /score/)
  assert.match(bad[0].notes[0], /p < 0\.001/, 'an underflowed p is still reported as a failure')
  assert.match(bad[0].notes[0], /非参数检验/)

  // Two variables in one table: only the offending one is named.
  const two = [{
    kind: 'table',
    table: { caption: 'Tests of Normality', matrix: [['', 'Shapiro-Wilk', '', ''], ['', 'Statistic', 'df', 'Sig.'], ['age', '.98', '12', '.970'], ['score', '.61', '12', '.000']] },
    notes: [],
  }]
  annotateNormality(two)
  assert.match(two[0].notes[0], /score/)
  assert.ok(!two[0].notes[0].includes('age'), 'the normal variable is not named')
})

check('a 2×2 table points at the continuity correction row', () => {
  const items = [
    {
      kind: 'table',
      table: { caption: 'g × w', matrix: [['', '', '', 'w', '', 'Total'], ['', '', '', '1.00', '2.00', ''], ['g', '1.00', 'Count', '30', '10', '40'], ['', '2.00', 'Count', '12', '28', '40'], ['Total', '', 'Count', '42', '38', '80']] },
      notes: [],
    },
    {
      kind: 'table',
      table: { caption: 'Chi-Square Tests', matrix: [['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)'], ['Pearson Chi-Square', '14.55', '1', '.000'], ['Continuity Correction', '13.11', '1', '.000'], ['N of Valid Cases', '80', '', '']] },
      notes: [],
    },
  ]
  annotateCrosstabs(items)
  assert.ok(items[1].notes.some((text) => text.includes('连续性校正')), 'the correction row is named')
  assert.ok(items[1].notes.some((text) => text.includes('Continuity Correction')), 'and named in both languages')
})

check('a regression with too few cases per predictor says so', () => {
  const small = [{ kind: 'table', table: { caption: 'ANOVA', matrix: [['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'], ['Regression', '1.0', '2', '0.5', '1.0', '.400']] }, notes: [] }]
  const dataset = {
    variables: [{ name: 'y', type: 'numeric' }, { name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }],
    rows: Array.from({ length: 12 }, (_, index) => [index, index % 3, index % 5]),
  }
  annotateSampleSize(small, dataset, { dependent: 'y', independents: ['a', 'b'] })
  assert.equal(small[0].notes.length, 1)
  assert.match(small[0].notes[0], /样本量 12/)
  assert.match(small[0].notes[0], /6\.0/, 'the ratio is printed, not just the warning')

  const roomy = [{ kind: 'table', table: { caption: 'ANOVA', matrix: [['', 'Sum of Squares']] }, notes: [] }]
  annotateSampleSize(roomy, { variables: [], rows: new Array(40).fill([1, 2, 3]) }, { dependent: 'y', independents: ['a', 'b'] })
  assert.deepEqual(roomy[0].notes, [], '40 cases for 2 predictors is enough')
  assert.deepEqual(annotateSampleSize(roomy, { variables: [], rows: [] }, null), roomy, 'no regression, no note')
})

check('a table of pairwise comparisons says how many chances it took', () => {
  const matrix = [
    ['', '', '', '', '', 'Sig.'],
    ['A vs B', '', '', '', '', '0.041'],
    ['A vs C', '', '', '', '', '0.900'],
    ['B vs C', '', '', '', '', '0.230'],
  ]
  const items = [{ kind: 'table', table: { caption: 'Multiple Comparisons', matrix, notes: [] } }]
  annotateComparisons(items)
  const said = (items[0].notes ?? []).join(' ')
  assert.match(said, /3 次两两比较/)
  assert.match(said, /14%/)  // 1 - 0.95^3 = 14.26%

  const adjusted = [{ kind: 'table', table: { caption: 'Multiple Comparisons (Bonferroni)', matrix, notes: [] } }]
  annotateComparisons(adjusted)
  assert.equal((adjusted[0].notes ?? []).length, 0, 'a corrected table is not nagged')

  const single = [{ kind: 'table', table: { caption: 'Multiple Comparisons', matrix: [matrix[0], matrix[1]], notes: [] } }]
  annotateComparisons(single)
  assert.equal((single[0].notes ?? []).length, 0, 'one comparison is not a family')
})


await check('the method in the first column decides whether p values are corrected', async () => {
  // PSPP titles all three the same: "Multiple Comparisons (score)". The method
  // sits in the leftmost column of the first data row, and Bonferroni/Tukey are
  // already adjusted — warning there is wrong, not merely redundant.
  const header = ['', '(I) g', '(J) g', 'Mean Difference (I - J)', 'Std. Error', 'Sig.', '95% Confidence Interval', '']
  const sub = ['', '', '', '', '', '', 'Lower Bound', 'Upper Bound']
  const pair = (method, i, j, p) => [method, i, j, '0.00', '1.08', p, '-1.0', '1.0']
  const make = (method) => ({
    kind: 'table',
    table: {
      caption: 'Multiple Comparisons (score)',
      matrix: [
        header, sub,
        pair(method, '1.00', '2.00', '.252'),
        pair('', '', '3.00', '.000'),
        pair('', '2.00', '1.00', '.252'),
        pair('', '', '3.00', '.000'),
        pair('', '3.00', '1.00', '.000'),
        pair('', '', '2.00', '.000'),
      ],
      notes: [],
    },
  })
  const bonferroni = [make('Bonferroni')]
  annotateComparisons(bonferroni)
  assert.equal((bonferroni[0].notes ?? []).length, 0, 'Bonferroni p values are already adjusted')

  const tukey = [make('Tukey')]
  annotateComparisons(tukey)
  assert.equal((tukey[0].notes ?? []).length, 0, 'Tukey p values are already adjusted')

  const lsd = [make('LSD')]
  annotateComparisons(lsd)
  const said = (lsd[0].notes ?? []).join(' ')
  assert.match(said, /3 次两两比较/, said)
  assert.match(said, /14%/, said)

  // The method is not guaranteed to stay in the first column: a future build
  // could put it in the caption ("Multiple Comparisons (Tukey HSD)"), so the
  // caption branch has to hold on its own — and it must not swallow LSD.
  const titled = (title) => {
    const table = make('')
    table.table.caption = title
    return table
  }
  const tukeyTitle = [titled('Multiple Comparisons (Tukey HSD)')]
  annotateComparisons(tukeyTitle)
  assert.equal((tukeyTitle[0].notes ?? []).length, 0, 'a method named in the caption still counts as adjusted')

  const lsdTitle = [titled('Multiple Comparisons (LSD)')]
  annotateComparisons(lsdTitle)
  const lsdSaid = (lsdTitle[0].notes ?? []).join(' ')
  assert.match(lsdSaid, /3 次两两比较/, lsdSaid)
})

await check('a chi-square table without a Pearson row says why', () => {
  const short = [{
    kind: 'table',
    table: {
      caption: 'Chi-Square Tests',
      matrix: [
        ['', 'Value', 'df', 'Asymp. Sig. (2-sided)', 'Exact Sig. (2-sided)'],
        ['Continuity Correction', '.10', '1', '.752', ''],
        ["Fisher's Exact Test", '', '', '', '1.000'],
        ['N of Valid Cases', '20', '', '', ''],
      ],
    },
  }]
  annotateCrosstabs(short)
  assert.match((short[0].notes ?? []).join(' '), /没有 Pearson 卡方行/, 'a missing Pearson row has to be explained')

  const complete = [{
    kind: 'table',
    table: {
      caption: 'Chi-Square Tests',
      matrix: [
        ['', 'Value', 'df', 'Asymp. Sig. (2-sided)'],
        ['Pearson Chi-Square', '4.20', '1', '.040'],
        ['N of Valid Cases', '20', '', ''],
      ],
    },
  }]
  annotateCrosstabs(complete)
  assert.doesNotMatch((complete[0].notes ?? []).join(' '), /没有 Pearson 卡方行/, 'an ordinary table needs no such note')
})

check('a grouped normality table names the group, not "变量"', () => {
  // EXAMINE … BY g repeats the variable name only on the first block.
  const item = {
    kind: 'table',
    table: {
      caption: 'Tests of Normality (x)',
      matrix: [
        ['', '', 'Shapiro-Wilk', '', ''],
        ['', '', 'Statistic', 'df', 'Sig.'],
        ['x', '1.00', '.92', '20', '.041'],
        ['', '2.00', '.71', '20', '.000'],
      ],
    },
  }
  annotateNormality([item])
  const note = (item.notes ?? [])[0]
  assert.ok(note, 'the deviating group must be reported')
  assert.doesNotMatch(note, /变量（/, `the note must name the variable, got: ${note}`)
  assert.match(note, /x（分组 2\.00）/, note)
})

check('a blank count is not a zero cell for CMH', () => {
  const items = [{
    kind: 'table',
    id: 'layered',
    title: 'grp × g × wave',
    table: {
      caption: 'grp × g × wave',
      matrix: [
        ['', '', '', '', '', 'wave', '', 'Total'],
        ['', '', '', '', '', '1.00', '2.00', ''],
        ['grp', 'A', 'g', 'c1', 'Count', '9', '', '13'],
        ['', '', '', 'c2', 'Count', '3', '8', '11'],
        ['', 'B', 'g', 'c1', 'Count', '5', '10', '15'],
        ['', '', '', 'c2', 'Count', '11', '6', '17'],
      ],
    },
  }]
  annotateCrosstabs(items, { cmh: true })
  const notes = (items[0].notes ?? []).join(' ')
  assert.doesNotMatch(notes, /Cochran–Mantel–Haenszel χ²/, 'a blank cell must not be read as zero counts')
  assert.match(notes, /没有算/, 'the note has to say the test was skipped, not print a number')
})

check('a blank p value is not another comparison', () => {
  const items = [{
    kind: 'table',
    table: {
      caption: 'Multiple Comparisons',
      matrix: [
        ['', '(I) g', '(J) g', 'Mean Difference', 'Std. Error', 'Sig.'],
        ['LSD', '1.00', '2.00', '-10.00', '.82', '.000'],
        ['', '', '3.00', '6.00', '1.15', ''],
        ['', '2.00', '1.00', '10.00', '.82', '.000'],
      ],
    },
  }]
  annotateComparisons(items)
  const note = (items[0].notes ?? []).join(' ')
  assert.match(note, /2 次两两比较/, note)
})

check('a period inside a quoted string is not a statement boundary', () => {
  // `TITLE 'Step 1. Descriptives by group'` used to split in the middle of the
  // string, so every keyword after the period counted as a command: a title-only
  // script reported "nothing was produced", and a real empty-dataset message
  // could be swallowed.
  const title = classifyScript("TITLE 'Done. FREQUENCIES g'.")
  assert.equal(title.asksForResults, false, 'a title is not an analysis')
  const mixed = classifyScript("TITLE 'run 1. COMPUTE z = 2'.\nDESCRIPTIVES score.")
  assert.equal(mixed.changesData, false, 'a string is not a data step')
  assert.equal(mixed.asksForResults, true, 'the analysis after the title still counts')
  const file = classifyScript("TITLE 'run 2. GET FILE'.\nDESCRIPTIVES score.")
  assert.equal(file.loadsData, false, 'a string is not an import')
  const escaped = classifyScript("COMPUTE s = 'it''s. DESCRIPTIVES'.")
  assert.equal(escaped.asksForResults, false, 'an escaped quote does not end the string')
  assert.deepEqual(splitStatements('COMPUTE z = 1.5. FREQUENCIES g.'), ['COMPUTE z = 1.5.', 'FREQUENCIES g.'])
})

check('inline data is data, not syntax', () => {
  // A value can read like a command: `1 'Bob. DESCRIPTIVES x'` inside BEGIN DATA
  // used to count as an analysis and produce a false "nothing was produced".
  const script = "BEGIN DATA\n1 'step. DESCRIPTIVES share'\n2 'x. COMPUTE y'\nEND DATA."
  const status = classifyScript(script)
  assert.equal(status.loadsData, true, 'inline data defines the dataset')
  assert.equal(status.asksForResults, false, 'data rows are not commands')
  assert.equal(status.changesData, false, 'data rows are not data steps either')
  // Commands after the block must survive: the merge used to look at the next
  // piece and, when END DATA was already inside the current one, eat the rest.
  const after = classifyScript('BEGIN DATA\n1 2\nEND DATA.\nDESCRIPTIVES x.')
  assert.equal(after.asksForResults, true, 'the analysis after inline data still counts')
  assert.equal(after.loadsData, true, 'inline data still counts as loading')
})

check('a comment-looking line inside a string stays part of the string', () => {
  // Comments are stripped by a quote-aware pass, so `TITLE 'a\n* b\nc'.` keeps
  // its middle line instead of losing the rest of the command.
  const inside = splitStatements("TITLE 'a\n* b\nc'.")
  assert.equal(inside.length, 1, `a multi-line string is one statement: ${JSON.stringify(inside)}`)
  assert.match(inside[0], /\* b/, 'the star line survives inside the string')
  assert.equal(classifyScript("TITLE 'l1\nl2. GET FILE'.\nDESCRIPTIVES x.").loadsData, false, 'a string is not an import')
})

check('a comment is not a command, even when it holds an apostrophe', () => {
  // PSPP ignores everything after `*` or COMMENT on the line. A note like
  // `* it's here` used to open a string that never closed, so the analysis on
  // the next line disappeared and the panel stayed silent.
  const star = classifyScript('* note. DESCRIPTIVES x.')
  assert.equal(star.asksForResults, false, 'a comment is not an analysis')
  const apostrophe = classifyScript("* it's a note\nDESCRIPTIVES score.")
  assert.equal(apostrophe.asksForResults, true, 'the command after a comment still counts')
  const comment = classifyScript('COMMENT this. DESCRIPTIVES x.\nDESCRIPTIVES score.')
  assert.equal(comment.asksForResults, true, 'the command after COMMENT still counts')
})

check('double quoted strings hold periods too', () => {
  const title = classifyScript('TITLE "Step 1. Descriptives by group".')
  assert.equal(title.asksForResults, false, 'a double quoted title is not an analysis')
  const mixed = classifyScript("COMPUTE s = \"it's. FREQUENCIES g\".")
  assert.equal(mixed.asksForResults, false, 'an apostrophe inside double quotes does not end the string')
  const other = classifyScript("COMPUTE s = 'a\"b. DESCRIPTIVES x'.")
  assert.equal(other.asksForResults, false, 'a double quote inside single quotes does not end the string')
})

check('three-letter abbreviations count, and lookalike variable names do not', () => {
  // PSPP accepts `des`, `fre`, `cro`, `correl` — its own examples use them.
  for (const script of ['des x.', 'desc x.', 'fre x.', 'cro x BY y.', 'correl x WITH y.', 'exa x.', 'mea x BY g.', 'lis.', 'ran.', 'sho.']) {
    assert.equal(classifyScript(script).asksForResults, true, script)
  }
  // Reverse prefix matching: a word only counts when it is a prefix of a command,
  // so these variable names are not read as DOCUMENT / DO / SELECT / FILTER.
  for (const script of ['docount = 1.', 'description = 1.', 'selector = 1.', 'filtered = 1.']) {
    const stats = classifyScript(script)
    assert.equal(stats.changesData, false, script)
    assert.equal(stats.filtersData, false, script)
  }
  assert.equal(classifyScript('do repeat i = 1 to 3.').filtersData, false)
  assert.equal(classifyScript('do if x > 1.').filtersData, true)
})

check('a comment after the inline block does not swallow the commands after it', () => {
  // The flag that keeps data lines verbatim used to stay on when `END DATA.` was
  // followed by a comment (a missing `m` in its regex), and the next command was
  // merged into the comment: silent empty output, or the filter blamed on a file.
  const empty = 'DATA LIST FREE /v (F8.1).\nBEGIN DATA\nEND DATA.\n* keep this note\nDESCRIPTIVES VARIABLES=v.'
  const parts = splitStatements(empty)
  assert.equal(parts.length, 3, JSON.stringify(parts))
  assert.equal(parts[2], 'DESCRIPTIVES VARIABLES=v.')
  assert.equal(classifyScript(empty).asksForResults, true)
  const filtered = 'DATA LIST FREE /v (F8.1).\nBEGIN DATA\nEND DATA.\n* note\nSELECT IF v > 999.\nDESCRIPTIVES v.'
  const stats = classifyScript(filtered)
  assert.equal(stats.asksForResults, true)
  assert.equal(stats.filtersData, true)
})

check('a data value that starts with END DATA does not end the block', () => {
  // The merge loop used an unanchored /END\s+DATA\b/ while the block-end search
  // required the words to be alone on the line. `END DATA now` is a data value:
  // the two disagreed and the block ended one line early.
  const script = 'DATA LIST FREE /v (A20).\nBEGIN DATA\n1\nEND DATA now\n2\nEND DATA.\nDESCRIPTIVES v.'
  const parts = splitStatements(script)
  assert.equal(parts.length, 3, JSON.stringify(parts))
  assert.match(parts[1], /END DATA now/, JSON.stringify(parts[1]))
  assert.match(parts[1], /\n2\n/, JSON.stringify(parts[1]))
  assert.equal(classifyScript(script).asksForResults, true)
})

check('sampling everything away is not called a filter', () => {
  const stats = classifyScript('SAMPLE .01.\nDESCRIPTIVES score.')
  assert.equal(stats.samplesData, true)
  assert.equal(stats.filtersData, false)
  assert.equal(classifyScript('SAMPLE 50 FROM 1000.\nDESCRIPTIVES score.').samplesData, true)
})

check('a table that says N = 0 while the panel holds cases explains itself', () => {
  const dataset = { rows: [[1], [2], [3]] }
  const table = () => [{ kind: 'table', title: 'Descriptive Statistics', notes: [], table: { caption: 'Descriptive Statistics', matrix: [['', 'N', 'Mean'], ['score', '0', '.']] } }]
  const items = table()
  assert.equal(annotateZeroCases(items, dataset), 1)
  assert.match(items[0].notes[0], /WEIGHT OFF/)
  assert.match(items[0].notes[0], /缺失值/)
  const healthy = [{ kind: 'table', title: 'D', notes: [], table: { caption: 'D', matrix: [['', 'N', 'Mean'], ['score', '3', '2.0']] } }]
  assert.equal(annotateZeroCases(healthy, dataset), 0)
  const noCases = table()
  assert.equal(annotateZeroCases(noCases, { rows: [] }), 0)
  const oneEmptyGroup = [{ kind: 'table', title: 'Group Statistics', notes: [], table: { caption: 'Group Statistics', matrix: [['g', 'N', 'Mean'], ['1', '0', '.'], ['2', '2', '3.0']] } }]
  assert.equal(annotateZeroCases(oneEmptyGroup, dataset), 0)
  const already = table()
  already[0].notes.push('加权后有效个案是 0：…')
  assert.equal(annotateZeroCases(already, dataset), 0)
  // `DESCRIPTIVES` puts `Missing N (listwise) = 0` in the same column on ordinary
  // data; counting that zero made the note appear on healthy tables.
  const withMissing = [{ kind: 'table', title: 'Descriptive Statistics', notes: [], table: {
    caption: 'Descriptive Statistics',
    matrix: [['', 'N', 'Mean'], ['score', '12', '2.4'], ['Valid N (listwise)', '12', ''], ['Missing N (listwise)', '0', '']],
  } }]
  assert.equal(annotateZeroCases(withMissing, dataset), 0)
  // Two variables, one of them entirely missing: every row that names a variable
  // is zero, so the weight story is the right one to tell.
  const allMissing = [{ kind: 'table', title: 'Descriptive Statistics', notes: [], table: {
    caption: 'Descriptive Statistics',
    matrix: [['', 'N', 'Mean'], ['a', '0', '.'], ['b', '0', '.'], ['Valid N (listwise)', '0', '']],
  } }]
  assert.equal(annotateZeroCases(allMissing, dataset), 1)
})

check('END DATA sharing a line with a command is explained before the engine sees it', () => {
  assert.match(inlineDataTailProblem('BEGIN DATA\n1\nEND DATA. DESCRIPTIVES v.'), /独占一行/)
  assert.equal(inlineDataTailProblem('BEGIN DATA\n1\nEND DATA.\nDESCRIPTIVES v.'), null)
  assert.equal(inlineDataTailProblem('DESCRIPTIVES v.'), null)
})

check('command abbreviations the engine accepts are still analyses', () => {
  // PSPP takes any abbreviation of four characters or more; its own examples use
  // `descript` and `freq`.
  assert.equal(classifyScript('descript all/stat=all.').asksForResults, true)
  assert.equal(classifyScript('freq score.').asksForResults, true)
  assert.equal(classifyScript('crossta g by h.').asksForResults, true)
  assert.equal(classifyScript('comp z = 1.').changesData, true)
  assert.equal(classifyScript('selec if x > 1.').filtersData, true)
  assert.equal(classifyScript('filt by w.').filtersData, true)
  assert.equal(classifyScript('filt off.').filtersData, false)
})

check('a matrix string that says END MATRIX does not end the block', () => {
  const script = "MATRIX.\nCOMPUTE s = 'END MATRIX here'.\nCOMPUTE x = {1}.\nEND MATRIX.\nDESCRIPTIVES VARIABLES=v."
  const parts = splitStatements(script)
  assert.equal(parts.length, 1, JSON.stringify(parts))
  assert.equal(parts[0], 'DESCRIPTIVES VARIABLES=v.')
  assert.equal(classifyScript(script).changesData, false)
})

check('a data value that starts with END DATA is still data', () => {
  const script = 'DATA LIST FREE /s (A34).\nBEGIN DATA\nEND DATA DESCRIPTIVES VARIABLES=s\n2\nEND DATA.'
  const parts = splitStatements(script)
  assert.equal(parts.length, 2, JSON.stringify(parts))
  assert.ok(parts[1].includes('END DATA DESCRIPTIVES VARIABLES=s'), parts[1])
  assert.equal(classifyScript(script).asksForResults, false)
})

check('a data block inside matrix algebra does not leak its state', () => {
  // `BEGIN DATA` inside MATRIX never gets an END DATA of its own; the flag used
  // to stay on and the rest of the file stopped being comment-stripped.
  const stats = classifyScript('MATRIX.\nBEGIN DATA\nEND MATRIX.\n* a note\nDESCRIPTIVES v.')
  assert.equal(stats.asksForResults, true)
})

check('the end of an inline block is a command, not a value', () => {
  // `END DATA` at the start of a line ends the block; the same words inside a
  // value do not.
  const parts = splitStatements('BEGIN DATA\n1 END DATA 2\nEND DATA.\nDESCRIPTIVES v.')
  assert.equal(parts.length, 2, JSON.stringify(parts))
  assert.ok(parts[0].endsWith('END DATA.'), parts[0])
  const quoted = splitStatements("TITLE 'BEGIN DATA'. DESCRIPTIVES v.")
  assert.equal(quoted.length, 2, JSON.stringify(quoted))
})

check("an apostrophe in the data does not open a string", () => {
  // `Bob's` is a value, not the start of a quoted string. Reading it as one
  // swallowed every command after END DATA, and the run went silent.
  const script = "BEGIN DATA\nBob's data\nEND DATA.\nSELECT IF v > 9.\nDESCRIPTIVES v."
  const parts = splitStatements(script)
  assert.equal(parts.length, 3, JSON.stringify(parts))
  const stats = classifyScript(script)
  assert.equal(stats.asksForResults, true)
  assert.equal(stats.filtersData, true)
})

check('a data line that starts with a star is still a data line', () => {
  // Between BEGIN DATA and END DATA every line is a value. Stripping a line that
  // happens to start with `*` left a hole in the block, and the commands after
  // it were then read as part of the data.
  const parts = splitStatements('BEGIN DATA\n* 7\n1\nEND DATA.\nDESCRIPTIVES v.')
  assert.equal(parts.length, 2)
  assert.ok(parts[0].includes('* 7'), parts[0])
  const stats = classifyScript('BEGIN DATA\n* 7\n1\nEND DATA.\nDESCRIPTIVES v.')
  assert.equal(stats.asksForResults, true)
  assert.equal(stats.loadsData, true)
  assert.equal(stats.changesData, false)
})

check('an inline data block does not swallow the commands after it', () => {
  const stats = classifyScript('DATA LIST FREE /v (F8.1).\nBEGIN DATA\n1\n2\nEND DATA.\nSELECT IF v > 9.\nDESCRIPTIVES VARIABLES=v.')
  assert.equal(stats.asksForResults, true, 'the analysis after END DATA must be seen')
  assert.equal(stats.filtersData, true, 'the filter after END DATA must be seen')
})

check('weighting that only appears in a comment does not count', () => {
  const dataset = { variables: [{ name: 'score' }, { name: 'w' }], rows: [[1, 0], [2, 0]] }
  const table = () => [{ kind: 'table', title: 'Descriptive Statistics', notes: [] }]
  const commented = table()
  assert.equal(annotateWeightedEmpty(commented, dataset, '* WEIGHT BY w.'), 0)
  assert.equal(commented[0].notes.length, 0)
  const titled = table()
  assert.equal(annotateWeightedEmpty(titled, dataset, "TITLE 'WEIGHT BY w'."), 0)
  const real = table()
  assert.equal(annotateWeightedEmpty(real, dataset, 'WEIGHT BY w.\nDESCRIPTIVES score.'), 1)
})

check('a filter switch is not a filter, and an all-zero weight explains N = 0', () => {
  assert.equal(classifyScript('FILTER OFF.\nDESCRIPTIVES x.').filtersData, false)
  assert.equal(classifyScript('FILTER BY keep.\nDESCRIPTIVES x.').filtersData, true)
  const dataset = { variables: [{ name: 'score', type: 'numeric' }, { name: 'w', type: 'numeric' }], rows: [[1, 0], [2, 0]] }
  const items = [{ kind: 'table', title: 'Descriptive Statistics', notes: [] , table: { caption: 'Descriptive Statistics', matrix: [] } }]
  assert.equal(annotateWeightedEmpty(items, dataset, "GET FILE='w.sav'.\nWEIGHT BY w.\nDESCRIPTIVES score."), 1)
  assert.match(items[0].notes[0], /加权后有效个案是 0/)
  const positive = { variables: [{ name: 'score' }, { name: 'w' }], rows: [[1, 2], [2, 3]] }
  const clean = [{ kind: 'table', title: 'Descriptive Statistics', notes: [] }]
  assert.equal(annotateWeightedEmpty(clean, positive, 'WEIGHT BY w.'), 0)
  assert.equal(clean[0].notes.length, 0)
})

check('a filter is told apart from other data steps', () => {
  // `SELECT IF` explains "the engine saw no cases"; COMPUTE and SORT do not, and
  // telling the user to widen a filter he never wrote is the same mistake in the
  // other direction.
  assert.equal(classifyScript('SELECT IF score > 1.\nDESCRIPTIVES x.').filtersData, true)
  assert.equal(classifyScript('FILTER BY keep.').filtersData, true)
  assert.equal(classifyScript('COMPUTE z = 1.\nDESCRIPTIVES x.').filtersData, false)
  assert.equal(classifyScript('SORT CASES BY x (A).\nDESCRIPTIVES x.').filtersData, false)
})

check('a matrix block is not a data step', () => {
  // MATRIX … END MATRIX carries a COMPUTE of its own; reading it as a data step
  // made an empty run look like "you changed the data first".
  const status = classifyScript('MATRIX.\nCOMPUTE x = {1}.\nEND MATRIX.')
  assert.equal(status.changesData, false, 'matrix algebra is not a data step')
  // The block ends on the same line as the next command: dropping the block must
  // not drop the analysis that follows it.
  const sameLine = classifyScript('MATRIX.\nCOMPUTE x = {1}.\nEND MATRIX. DESCRIPTIVES score.')
  assert.equal(sameLine.asksForResults, true, 'a command after END MATRIX still counts')
  assert.equal(classifyScript("COMPUTE note = 'GET DATA'.").loadsData, false, 'a string is not a command')
})

check('a listing counts as a result', () => {
  // RANK/LIST/DISPLAY/SHOW always print something; if they ever print nothing
  // the empty-run message has to cover them too.
  for (const script of ['RANK score /RANK INTO r.', 'LIST /VARIABLES=g score.', 'DISPLAY DICTIONARY.', 'SHOW N.']) {
    assert.equal(classifyScript(script).asksForResults, true, script)
  }
})

check('a pasted one-liner is classified command by command', () => {
  // Statements, not lines: everything after the first command on a line still
  // has to count, or "COMPUTE z = 1. DESCRIPTIVES score." looks like a pure data
  // step and an empty run goes unreported.
  const oneLiner = classifyScript('COMPUTE z = 1. DESCRIPTIVES score.')
  assert.equal(oneLiner.changesData, true)
  assert.equal(oneLiner.asksForResults, true, 'the analysis after the data step must still count')

  const decimal = classifyScript('COMPUTE z = 1.5. FREQUENCIES g.')
  assert.equal(decimal.asksForResults, true, 'a decimal point is not a statement boundary')

  const imported = classifyScript("GET DATA /TYPE=TXT /FILE='/tmp/x.csv' /VARIABLES=x F8.1. DESCRIPTIVES x.")
  assert.equal(imported.loadsData, true)
  assert.equal(imported.asksForResults, true)

  assert.equal(classifyScript('COMPUTE z = 1.').asksForResults, false)
})

check('a blank SPSS-style Levene row does not hide the row after it', () => {
  // SPSS prints "Based on Mean / Based on Median / Based on trimmed mean"; PSPP
  // leaves the first Value empty. Taking the first labelled row would then read
  // NaN and skip the real number two rows down.
  const cases = [
    [['score', '', '2', '15', ''], ['', '.048', '2', '15', '.048'], ['', '.025', '2', '14.2', '.025']],
    [['score', '', '2', '15', ''], ['score', '9.49', '2', '15', '.002']],
  ]
  for (const dataRows of cases) {
    const item = {
      kind: 'table',
      table: {
        caption: 'Test of Homogeneity of Variances',
        matrix: [['', 'Levene Statistic', 'df1', 'df2', 'Sig.'], ...dataRows],
      },
    }
    annotateAssumptions([item])
    const note = (item.notes ?? [])[0]
    assert.ok(note, 'a real p further down still produces the note')
    assert.match(note, /p (?:< 0\.001|= 0\.)/, note)
    assert.doesNotMatch(note, /p < 0\.001/, 'the blank row must not become p = 0')
  }
})

check('a mixed run keeps the two variance advices on their own tables', async () => {
  // ONEWAY prints Levene in "Test of Homogeneity of Variances"; a t test keeps
  // it inside "Independent Samples Test". One syntax can contain both, and each
  // table must get the sentence that matches it.
  const anova = {
    kind: 'table',
    table: {
      caption: 'Test of Homogeneity of Variances',
      matrix: [
        ['', 'Levene Statistic', 'df1', 'df2', 'Sig.'],
        ['score', '120.35', '2', '15', '.000'],
      ],
      notes: [],
    },
  }
  const ttest = {
    kind: 'table',
    table: {
      caption: 'Independent Samples Test',
      matrix: [
        ['', '', "Levene's Test for Equality of Variances", '', 'T-Test for Equality of Means', ''],
        ['', '', 'F', 'Sig.', 't', 'Sig. (2-tailed)'],
        ['score', 'Equal variances assumed', '140.46', '.000', '3.20', '.010'],
        ['', 'Equal variances not assumed', '', '', '4.10', '.004'],
      ],
      notes: [],
    },
  }
  const items = [anova, ttest]
  annotateAssumptions(items)
  const anovaSaid = (anova.notes ?? []).join(' ')
  const ttestSaid = (ttest.notes ?? []).join(' ')
  assert.match(anovaSaid, /没有 Welch 行/)
  assert.doesNotMatch(anovaSaid, /不假定等方差/)
  assert.match(ttestSaid, /不假定等方差/)
  assert.doesNotMatch(ttestSaid, /没有 Welch 行/)
})

await check('the collinearity note stays on a coefficient table', async () => {
  const ttest = {
    kind: 'table',
    table: {
      caption: 'Independent Samples Test',
      matrix: [
        ['', '', "Levene's Test for Equality of Variances", '', 'T-Test for Equality of Means', ''],
        ['', '', 'F', 'Sig.', 't', 'Sig. (2-tailed)'],
        ['score', 'Equal variances assumed', '1.00', '.400', 'NaN', 'NaN'],
      ],
      notes: [],
    },
  }
  annotateNonFiniteCoefficients([ttest])
  assert.equal((ttest.notes ?? []).length, 0, 'a t test is not a regression coefficient table')

  const coefficients = {
    kind: 'table',
    table: {
      caption: 'Coefficients',
      matrix: [
        ['', 'Unstandardized Coefficients', '', 'Standardized Coefficients', '', 't', 'Sig.'],
        ['Model', 'B', 'Std. Error', 'Beta', '', '', ''],
        ['1', 'NaN', 'NaN', '', '', 'NaN', 'NaN'],
      ],
      notes: [],
    },
  }
  annotateNonFiniteCoefficients([coefficients])
  const said = (coefficients.notes ?? []).join(' ')
  assert.match(said, /共线性诊断/)
})

console.log(`\nregression: ${checks} checks passed${failures.length ? ` (with ${failures.length} failures)` : ''}`)
