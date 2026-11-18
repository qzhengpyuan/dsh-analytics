// Collinearity diagnostics, computed in Node because the engine crashes on TOL.
import assert from 'node:assert/strict'
import { collinearityTable, durbinWatsonTable, influenceTable } from '../lib/regression.js'
import { annotateSeparation, annotateNonFiniteCoefficients, annotateOversizedTables, annotateCrosstabs, annotateAssumptions, annotateReliabilityIcc, degradeStatistics, describeFailure, requestedCrosstabStatistics } from '../lib/workspace.js'

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
          ['', 'Levene Statistic', 'Sig.', 't', 'df', 'Sig. (2-tailed)'],
          ['Equal variances assumed', '6.100', '.032', '-2.1', '10', '.062'],
        ],
      },
    },
  ]
  annotateAssumptions(ttest)
  assert.match(ttest[1].notes[0], /p = 0\.032/, 'the t test significance is quoted')
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

console.log(`\nregression: ${checks} checks passed${failures.length ? ` (with ${failures.length} failures)` : ''}`)
