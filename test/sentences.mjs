// 结果变句子：断言的每条表都是 PSPP 2.1.3 真实输出的形状（多行表头、
// `.000` 写法、`NaN` 的 Levene、只印线性关联的卡方表），不是编出来的。
import assert from 'node:assert/strict'

import { formatP, locateTable, sentencesOf } from '../lib/sentences.js'

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
const texts = (items, options) => sentencesOf(items, options).sentences.map((entry) => entry.text)

check('p values print the way a paper wants them', () => {
  assert.equal(formatP('.000'), '< 0.001')
  assert.equal(formatP('.285'), '0.285')
  assert.equal(formatP('1.000'), '1.000')
  // 非数字不能冒充 P 值
  assert.equal(formatP('NaN'), null)
  assert.equal(formatP('+Infinit'), null)
  assert.equal(formatP(''), null)
})

check('multi-row headers are merged to the label closest to the data', () => {
  const matrix = [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', 'NaN', 'NaN', '-2.83', '2.00', '.106', '-2.00', '.71', '-5.04', '1.04'],
  ]
  const { header, start } = locateTable(matrix)
  assert.equal(start, 3, '数据从第 4 行开始')
  assert.equal(header[4], 't')
  assert.equal(header[9], 'Lower', '要的是最近的那个标签')
  assert.equal(header[10], 'Upper')
})

check('descriptive statistics become one sentence per variable', () => {
  const lines = texts([item('Descriptive Statistics', [
    ['', 'N', 'Mean', 'Std Dev', 'Minimum', 'Maximum'],
    ['y', '6', '7.500', '1.8708', '5.0', '10.0'],
    ['Valid N (listwise)', '6', '', '', '', ''],
  ])])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^y：n = 6，M = 7\.500/)
})

check('an independent t test quotes the Levene row, and says which row it used', () => {
  const table = item('Independent Samples Test', [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', '5.2', '.030', '-2.83', '2.00', '.106', '-2.00', '.71', '-5.04', '1.04'],
    ['', 'Equal variances not assumed', '', '', '-4.00', '1.20', '.140', '-2.00', '.50', '-6.00', '2.00'],
  ])
  const groups = item('Group Statistics', [
    ['', 'Group', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
    ['y', '1', '2', '5.50', '.71', '.50'],
    ['', '2', '2', '7.50', '.71', '.50'],
  ])
  const [sentence] = sentencesOf([groups, table]).sentences
  assert.match(sentence.text, /差异不显著/)
  // Levene p = .030 < 0.05 ⇒ 必须抄「不假定方差相等」那一行（t = -4.00, df = 1.20）
  assert.match(sentence.text, /t\(1\.20\) = -4\.00/)
  assert.match(sentence.text, /方差不齐/)
  assert.equal(sentence.values.equalVariances, false)
})

check('one-way ANOVA reads the Between Groups row', () => {
  const lines = texts([item('ANOVA', [
    ['', '', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
    ['y', 'Between Groups', '16.00', '2', '8.00', '16.00', '.025'],
    ['', 'Within Groups', '1.50', '3', '.50', '', ''],
    ['', 'Total', '17.50', '5', '', '', ''],
  ])])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], '单因素方差分析（y）：F(2, 3) = 16.00，p = 0.025。')
})

check('a chi-square table without a Pearson row names the test it has', () => {
  const lines = texts([item('Chi-Square Tests', [
    ['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)'],
    ['Linear-by-Linear Association', '.00', '1', '1.000'],
    ['N of Valid Cases', '20', '', ''],
  ])])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Linear-by-Linear Association 卡方/)
  assert.doesNotMatch(lines[0], /Pearson/)
})

check('regression reports the fit once, then one line per coefficient', () => {
  const items = [
    item('Model Summary (y)', [
      ['R', 'R Square', 'Adjusted R Square', 'Std. Error of the Estimate'],
      ['.20', '.04', '.01', '2.31'],
    ]),
    item('ANOVA (y)', [
      ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
      ['Regression', '6.22', '1', '6.22', '1.17', '.289'],
      ['Residual', '148.92', '28', '5.32', '', ''],
      ['Total', '155.14', '29', '', '', ''],
    ]),
    item('Coefficients (y)', [
      ['', 'Unstandardized Coefficients', '', 'Standardized Coefficients', 't', 'Sig.'],
      ['', 'B', 'Std. Error', 'Beta', '', ''],
      ['(Constant)', '13.57', '.78', '', '17.34', '.000'],
      ['x', '.16', '.15', '.20', '1.08', '.289'],
    ]),
  ]
  const sentences = sentencesOf(items).sentences
  assert.equal(sentences.length, 3, JSON.stringify(sentences.map((entry) => entry.kind)))
  assert.match(sentences[0].text, /线性回归（因变量 y）：R² = \.04，F\(1, 28\) = 1\.17，p = 0\.289/)
  assert.match(sentences[1].text, /^\(Constant\)：B = 13\.57，SE = \.78，t = 17\.34，p < 0\.001/)
  assert.match(sentences[2].text, /^x：B = \.16，SE = \.15，t = 1\.08，p = 0\.289/)
})

check('paired sample statistics are not reported as a variable', () => {
  const items = [
    item('Paired Sample Statistics', [
      ['', '', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
      ['Pair 1', 'y', '20', '7.00', '1.45', '.32'],
    ]),
    item('Paired Samples Test', [
      ['', '', 'Paired Differences', '', '', '', '', 't', 'df', 'Sig. (2-tailed)'],
      ['', '', 'Mean', 'Std. Deviation', 'S.E. Mean', '95% CI', '', '', '', ''],
      ['', '', '', '', '', 'Lower', 'Upper', '', '', ''],
      ['', 'y - x', '-.50', '.80', '.18', '-.90', '-.10', '-1.21', '19', '.242'],
    ]),
  ]
  const sentences = sentencesOf(items).sentences
  assert.equal(sentences.length, 1, JSON.stringify(sentences.map((entry) => entry.kind)))
  assert.equal(sentences[0].kind, 'ttest-paired')
  assert.match(sentences[0].text, /配对样本 t 检验（y - x）：平均差 -\.50，t\(19\) = -1\.21，p = 0\.242/)
})

check('frequencies list every category with its share', () => {
  const lines = texts([item('g', [
    ['', '', 'Frequency', 'Percent', 'Valid Percent', 'Cumulative Percent'],
    ['Valid', '1', '2', '33.3%', '33.3%', '33.3%'],
    ['', '2', '4', '66.7%', '66.7%', '100.0%'],
    ['Total', '', '6', '100.0%', '', ''],
  ])])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'g 的分布：1 2 次（33.3%），2 4 次（66.7%）。')
})

check('a correlation matrix reports each pair once', () => {
  const lines = texts([item('Correlations', [
    ['', '', 'y', 'x'],
    ['y', 'Pearson Correlation', '1.000', '.500'],
    ['', 'Sig. (2-tailed)', '', '.030'],
    ['', 'N', '6', '6'],
    ['x', 'Pearson Correlation', '.500', '1.000'],
    ['', 'Sig. (2-tailed)', '.030', ''],
    ['', 'N', '6', '6'],
  ])])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /y 与 x 的 Pearson 相关：r = \.500，p = 0\.030，n = 6/)
})

check('English output keeps the same numbers', () => {
  const lines = texts([item('Descriptive Statistics', [
    ['', 'N', 'Mean', 'Std Dev'],
    ['y', '6', '7.500', '1.8708'],
  ])], { language: 'en' })
  assert.equal(lines[0], 'y: n = 6, M = 7.500, SD = 1.8708.')
})

check('a table it cannot read is listed, not guessed at', () => {
  const out = sentencesOf([item('Some Other Table', [['a', 'b'], ['1', '2']])])
  assert.deepEqual(out.sentences, [])
  assert.deepEqual(out.skipped, ['Some Other Table'])
})

console.log(`\nsentences: ${checks} checks passed`)
