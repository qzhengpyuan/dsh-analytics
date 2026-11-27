// APA 写法：断言的判据是「抄进稿子要合法」—— p/r/R² 不写前导 0、p < .001、
// 效应量能算才算。表都是 PSPP 真实输出的形状（三行表头、Group Statistics）。
import assert from 'node:assert/strict'

import { apaCount, apaOf, apaP, apaUnit } from '../lib/apa.js'
import { sentencesOf } from '../lib/sentences.js'

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

const item = (title, matrix) => ({ kind: 'table', title, table: { caption: title, matrix } })
const texts = (sentences, options = {}) => apaOf(sentences, options).lines.map((line) => line.text)

check('p values follow APA: no leading zero, .000 becomes < .001', () => {
  assert.equal(apaP('.000'), '< .001')
  assert.equal(apaP('0.285'), '.285')
  assert.equal(apaP('0.001'), '.001')
  assert.equal(apaP('1.000'), '1.000')
  assert.equal(apaP('NaN'), null)
  assert.equal(apaP(''), null)
})

check('degrees of freedom drop a trailing .00 but keep Welch decimals', () => {
  assert.equal(apaCount('58.00'), '58')
  assert.equal(apaCount('1.20'), '1.20')
  assert.equal(apaCount(3), '3')
  assert.equal(apaUnit(0.8421, 2), '.84')
  assert.equal(apaUnit(0.4213, 2), '.42')
})

check('independent t reports t, df, p, mean difference and Cohen d', () => {
  const groups = item('Group Statistics', [
    ['', 'Group', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
    ['y', '1', '30', '5.50', '.71', '.13'],
    ['', '2', '30', '7.50', '.71', '.13'],
  ])
  const test = item('Independent Samples Test', [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', '0.10', '.757', '-2.83', '58.00', '.006', '-2.00', '.71', '-3.42', '-0.58'],
  ])
  const [line] = texts(sentencesOf([groups, test]).sentences)
  assert.match(line, /^独立样本 t 检验（y）：/)
  assert.match(line, /t\(58\) = -2\.83/)
  assert.match(line, /p = \.006/)
  assert.match(line, /d = -2\.82/)
})

check('no Group Statistics means no d instead of an invented effect size', () => {
  // sentencesOf 没有两组统计量时连句子都不造（它要先读 Group Statistics），
  // 这里直接把「只有检验表、没有两组 M/SD」的那条句子喂进来。
  const bare = [{ kind: 'ttest-independent', table: 'Independent Samples Test', values: { variable: 'y', t: -2.83, df: 58, p: '0.006', meanDifference: -2 } }]
  const [line] = texts(bare)
  assert.match(line, /t\(58\) = -2\.83/)
  assert.doesNotMatch(line, /d = /)
})

check('one-way ANOVA adds eta squared only when the sums of squares are in the table', () => {
  const anova = item('ANOVA', [
    ['', '', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
    ['y', 'Between Groups', '16.00', '2', '8.00', '16.00', '.025'],
    ['', 'Within Groups', '1.50', '3', '.50', '', ''],
    ['', 'Total', '17.50', '5', '', '', ''],
  ])
  const [line] = apaOf(sentencesOf([anova]).sentences, { items: [anova] }).lines.map((entry) => entry.text)
  assert.match(line, /F\(2, 3\) = 16\.00/)
  assert.match(line, /p = \.025/)
  assert.match(line, /η² = \.91/)
  // 没有原表就别凭空给 η²（apaOf 拿不到 items 时）。
  const [bare] = texts(sentencesOf([anova]).sentences)
  assert.doesNotMatch(bare, /η²/)
})

check('chi-square, correlation, reliability and regression get their APA forms', () => {
  const chi = [{ kind: 'chi-square', table: 'Chi-Square Tests', values: { table: 'sex × arm', chiSquare: 6.19, df: 1, p: '0.013', n: 60 } }]
  assert.equal(texts(chi)[0], '卡方检验（sex × arm）：χ²(1) = 6.19, p = .013, N = 60')
  const corr = [{ kind: 'correlation', table: 'Correlations', values: { left: 'x', right: 'y', r: 0.4512, p: '0.001', n: 60 } }]
  assert.equal(texts(corr)[0], 'Pearson 相关（x–y）：r(58) = .45, p = .001, n = 60')
  const alpha = [{ kind: 'reliability-alpha', table: 'Reliability Statistics', values: { alpha: 0.8421, items: 6 } }]
  assert.equal(texts(alpha)[0], "信度：Cronbach's α = .84（6 个题项）")
  const fit = [{ kind: 'regression-fit', table: 'Model Summary', values: { outcome: 'y', rSquare: 0.4213, f: 5.31, df1: 2, df2: 57, p: '0.008' } }]
  assert.equal(texts(fit)[0], '线性回归（因变量 y）：R² = .42, F(2, 57) = 5.31, p = .008')
})

check('English output keeps the same numbers', () => {
  const sample = [{ kind: 'ttest-paired', table: 'Paired Samples Test', values: { pair: 'a - b', meanDifference: -2, t: -2.83, df: 29, p: '0.006' } }]
  assert.equal(texts(sample, { language: 'en' })[0], 'Paired-samples t test (a - b): t(29) = -2.83, p = .006, M diff = -2')
})

check('kinds without an APA form are listed as skipped, not guessed', () => {
  const sentences = [
    { kind: 'descriptives', table: 'Descriptive Statistics', values: { variable: 'y' } },
    { kind: 'ttest-independent', table: 'Independent Samples Test', values: { t: null } },
  ]
  const result = apaOf(sentences)
  assert.equal(result.lines.length, 0)
  assert.deepEqual(result.skipped.sort(), ['descriptives', 'ttest-independent'])
})

console.log(`${checks} checks`)
if (process.exitCode) process.exit(1)
