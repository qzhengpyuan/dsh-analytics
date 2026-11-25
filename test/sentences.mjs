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

check('a footnote superscript is not part of the number', () => {
  // PSPP 给显著的相关挂 `.995<sup>a</sup>`；不剥掉的话句子里会印出标记，
  // 而且 values.r 会变成 NaN（复验抓到过）。
  const [sentence] = sentencesOf([item('Correlations', [
    ['', '', 'y', 'x'],
    ['y', 'Pearson Correlation', '1.000', '.995<sup>a</sup>'],
    ['', 'Sig. (2-tailed)', '', '.000'],
    ['', 'N', '24', '24'],
    ['x', 'Pearson Correlation', '.995<sup>a</sup>', '1.000'],
    ['', 'Sig. (2-tailed)', '.000', ''],
    ['', 'N', '24', '24'],
  ])]).sentences
  assert.doesNotMatch(sentence.text, /<sup>/)
  assert.equal(sentence.values.r, 0.995)
  assert.equal(typeof sentence.values.r, 'number')
})

check('p < 0.001 still counts as significant', () => {
  // `formatP` 回的是字符串 `< 0.001`，`Number()` 得到 NaN，判成「不显著」过。
  const groups = item('Group Statistics', [
    ['', 'Group', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
    ['y', '1', '12', '20', '.01', '.00'],
    ['', '2', '12', '46.5', '10.82', '3.12'],
  ])
  const test = item('Independent Samples Test', [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', '1.0', '.330', '-8.49', '22.00', '.000', '-26.50', '3.12', '-33.00', '-20.00'],
    ['', 'Equal variances not assumed', '', '', '-8.49', '11.00', '.000', '-26.50', '3.12', '-33.37', '-19.62'],
  ])
  const [sentence] = sentencesOf([groups, test]).sentences
  assert.match(sentence.text, /差异显著/)
  assert.equal(sentence.values.p, '< 0.001')
})

check('Levene p = .000 selects the not-assumed row', () => {
  const groups = item('Group Statistics', [
    ['', 'Group', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
    ['y', '1', '12', '20', '.01', '.00'],
    ['', '2', '12', '46.5', '10.82', '3.12'],
  ])
  const test = item('Independent Samples Test', [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', '50.30', '.000', '-8.49', '22.00', '.000', '-26.50', '3.12', '-33.00', '-20.00'],
    ['', 'Equal variances not assumed', '', '', '-8.49', '11.00', '.000', '-26.50', '3.12', '-33.37', '-19.62'],
  ])
  const [sentence] = sentencesOf([groups, test]).sentences
  assert.match(sentence.text, /t\(11\.00\)/)
  assert.match(sentence.text, /方差不齐/)
})

check('English frequencies carry no Chinese words', () => {
  const [sentence] = sentencesOf([item('g', [
    ['', '', 'Frequency', 'Percent', 'Valid Percent', 'Cumulative Percent'],
    ['Valid', '1.00', '8', '33.3%', '33.3%', '33.3%'],
    ['', '2.00', '16', '66.7%', '66.7%', '100.0%'],
    ['Total', '', '24', '100.0%', '', ''],
  ])], { language: 'en' }).sentences
  assert.doesNotMatch(sentence.text, /[\u4e00-\u9fff]/)
  assert.match(sentence.text, /^g: 1\.00 8 times \(33\.3%\), 2\.00 16 times \(66\.7%\)\.$/)
})

check('a table used for a sentence is not also listed as skipped', () => {
  const groups = item('Group Statistics', [
    ['', 'Group', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
    ['y', '1', '2', '5.50', '.71', '.50'],
    ['', '2', '2', '7.50', '.71', '.50'],
  ])
  const test = item('Independent Samples Test', [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', '.10', '.700', '-2.83', '2.00', '.106', '-2.00', '.71', '-5.04', '1.04'],
  ])
  const out = sentencesOf([groups, test])
  assert.equal(out.sentences.length, 1)
  assert.deepEqual(out.skipped, [])
})

check('a grouped descriptives table reports the Total row, not the first group', () => {
  // `ONEWAY … /STATISTICS=DESCRIPTIVES` 的表是每组一行 + Total，第一列只有
  // 第一组那行写着变量名；按行造句会写出「y：n = 8」，那是第一组的数。
  const [sentence] = sentencesOf([item('Descriptives', [
    ['', 'g', 'N', 'Mean', 'Std. Deviation', 'Std. Error', '95% Confidence Interval for Mean', '', 'Minimum', 'Maximum'],
    ['', '', '', '', '', '', 'Lower Bound', 'Upper Bound', '', ''],
    ['y', '1.00', '8', '24.90', '2.71', '.96', '22.64', '27.16', '20.00', '28.40'],
    ['', '2.00', '8', '25.57', '2.81', '.99', '23.23', '27.92', '21.30', '29.70'],
    ['', 'Total', '24', '25.37', '2.67', '.55', '24.24', '26.50', '20.00', '29.90'],
  ])]).sentences
  assert.match(sentence.text, /^y（全部）：n = 24，M = 25\.37/)
  assert.equal(sentence.values.n, 24)
})

check('several dependent variables each get their own sentence', () => {
  // 复验抓到过：`ONEWAY y1 y2 BY g /STATISTICS=DESCRIPTIVES` 的表里每个变量
  // 一段、各有一个 Total 行，只取第一个会把第二个变量整段丢掉。
  const descriptives = item('Descriptives', [
    ['', 'g', 'N', 'Mean', 'Std. Deviation', 'Std. Error', '95% CI for Mean', '', 'Minimum', 'Maximum'],
    ['', '', '', '', '', '', 'Lower Bound', 'Upper Bound', '', ''],
    ['得分一', '1.00', '3', '11.0', '1.0', '.58', '9.5', '12.5', '10.0', '12.0'],
    ['', '2.00', '3', '13.0', '1.0', '.58', '11.5', '14.5', '12.0', '14.0'],
    ['', 'Total', '6', '12.0', '1.4', '.58', '10.5', '13.5', '10.0', '14.0'],
    ['得分二', '1.00', '3', '22.0', '2.0', '1.15', '19.0', '25.0', '20.0', '24.0'],
    ['', '2.00', '3', '24.0', '2.0', '1.15', '21.0', '27.0', '22.0', '26.0'],
    ['', 'Total', '6', '23.0', '2.0', '1.15', '20.0', '26.0', '20.0', '26.0'],
  ])
  const anova = item('ANOVA', [
    ['', '', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
    ['得分一', 'Between Groups', '6.0', '1', '6.0', '6.00', '.070'],
    ['', 'Within Groups', '4.0', '4', '1.0', '', ''],
    ['', 'Total', '10.0', '5', '', '', ''],
    ['得分二', 'Between Groups', '6.0', '1', '6.0', '1.50', '.287'],
    ['', 'Within Groups', '16.0', '4', '4.0', '', ''],
    ['', 'Total', '22.0', '5', '', '', ''],
  ])
  const out = sentencesOf([descriptives, anova])
  const texts = out.sentences.map((entry) => entry.text)
  assert.equal(texts.filter((text) => /得分一（全部）/.test(text)).length, 1, texts.join(' | '))
  assert.equal(texts.filter((text) => /得分二（全部）/.test(text)).length, 1, texts.join(' | '))
  // values.variable 不带「（全部）」后缀：同一批句子里方差分析报「得分一」，
  // 按变量配对的下游（报告、复现包）才对得上（复验 P2-4）。
  const listed = out.sentences.filter((entry) => entry.kind === 'descriptives').map((entry) => entry.values.variable)
  assert.deepEqual(listed, ['得分一', '得分二'], listed.join(' | '))
  const anovas = out.sentences.filter((entry) => entry.kind === 'anova')
  assert.equal(anovas.length, 2, `两个因变量各要一句：${texts.join(' | ')}`)
  assert.ok(anovas.some((entry) => entry.text.includes('得分一')) && anovas.some((entry) => entry.text.includes('得分二')))
})

check('the variance homogeneity table is consumed, not skipped', () => {
  // t 检验的句子已经用过 Levene 的结果，把它再列进 skipped 等于说「没看懂」。
  const test = item('Independent Samples Test', [
    ['', '', "Levene's Test", '', 'T-Test', '', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', '95% CI', ''],
    ['', '', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['y', 'Equal variances assumed', '.10', '.700', '-2.83', '2.00', '.106', '-2.00', '.71', '-5.04', '1.04'],
  ])
  const homogeneity = item('Test of Homogeneity of Variances', [
    ['', "Levene's Test", 'df1', 'df2', 'Sig.'],
    ['y', '.10', '1', '4', '.767'],
  ])
  const groups = item('Group Statistics', [
    ['', 'Group', 'N', 'Mean', 'Std. Deviation', 'S.E. Mean'],
    ['y', '1', '2', '5.50', '.71', '.50'],
    ['', '2', '2', '7.50', '.71', '.50'],
  ])
  const out = sentencesOf([groups, test, homogeneity])
  assert.equal(out.sentences.length, 1, JSON.stringify(out.skipped))
  assert.deepEqual(out.skipped, [])
})

check('a logistic table becomes odds ratios with their interval', () => {
  // 真引擎版式：表头两行（B/SE/Wald/df/Sig/Exp(B)/CI），第二行才是 Lower/Upper。
  const item = {
    kind: 'table',
    title: 'Variables in the Equation',
    table: {
      caption: 'Variables in the Equation',
      matrix: [
        ['', '', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)', '95% CI for Exp(B)', ''],
        ['', '', '', '', '', '', '', '', 'Lower', 'Upper'],
        ['Step 1', 'x', '.02', '.11', '.03', '1', '.873', '1.02', '.82', '1.25'],
        ['', 'grp', '-.02', '.33', '.00', '1', '.959', '.98', '.51', '1.89'],
        ['', 'Constant', '-.22', '1.43', '.02', '1', '.878', '.80', '', ''],
      ],
    },
  }
  const out = sentencesOf([item])
  assert.equal(out.sentences.length, 2, JSON.stringify(out.skipped))
  assert.equal(out.sentences[0].values.term, 'x')
  assert.equal(out.sentences[0].values.oddsRatio, 1.02)
  assert.match(out.sentences[0].text, /OR = 1\.02/)
  assert.match(out.sentences[0].text, /95% CI \.82 ~ 1\.25/)
  assert.match(out.sentences[0].text, /p = 0\.873/)
  // 常数项不是自变量，不能造句。
  assert.ok(!out.sentences.some((entry) => /Constant/.test(entry.text)))
  assert.deepEqual(out.skipped, [])
})

check('a fully separated logistic model produces no odds sentence', () => {
  // 分离时 PSPP 印 NaN：那不是「效应为零」，不能写成 OR = NaN。
  const item = {
    kind: 'table',
    title: 'Variables in the Equation',
    table: {
      caption: 'Variables in the Equation',
      matrix: [
        ['', '', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)', '95% CI for Exp(B)', ''],
        ['', '', '', '', '', '', '', '', 'Lower', 'Upper'],
        ['Step 1', 'y', 'NaN', 'NaN', 'NaN', '1', 'NaN', 'NaN', 'NaN', 'NaN'],
      ],
    },
  }
  const out = sentencesOf([item])
  assert.deepEqual(out.sentences, [])
})

check('nonparametric tests become sentences in both layouts', () => {
  const mannWhitney = {
    kind: 'table',
    title: 'Test Statistics',
    table: {
      caption: 'Test Statistics',
      matrix: [
        ['', 'Mann-Whitney U', 'Wilcoxon W', 'Z', 'Asymp. Sig. (2-tailed)'],
        ['y', '197.50', '407.50', '-.07', '.946'],
      ],
    },
  }
  const first = sentencesOf([mannWhitney])
  assert.equal(first.sentences.length, 1)
  assert.equal(first.sentences[0].kind, 'npar-mannwhitney')
  assert.match(first.sentences[0].text, /U = 197\.50/)
  assert.match(first.sentences[0].text, /不显著/)

  // Kruskal-Wallis 与 Wilcoxon 是转置版式：行是统计量，列是变量。
  const kruskal = {
    kind: 'table',
    title: 'Test Statistics',
    table: {
      caption: 'Test Statistics',
      matrix: [
        ['', 'y', 'z'],
        ['Chi-Square', '.00', '7.50'],
        ['df', '1', '1'],
        ['Asymp. Sig.', '.946', '.006'],
      ],
    },
  }
  const second = sentencesOf([kruskal])
  assert.equal(second.sentences.length, 2, JSON.stringify(second.sentences))
  assert.match(second.sentences[1].text, /χ²\(1\) = 7\.50/)
  assert.match(second.sentences[1].text, /p = 0\.006/)
})

check('reliability becomes a Cronbach alpha sentence', () => {
  const item = {
    kind: 'table',
    title: 'Reliability Statistics',
    table: { caption: 'Reliability Statistics', matrix: [["Cronbach's Alpha", 'N of Items'], ['.82', '5']] },
  }
  const out = sentencesOf([item])
  assert.equal(out.sentences.length, 1)
  assert.equal(out.sentences[0].kind, 'reliability-alpha')
  assert.match(out.sentences[0].text, /5 个题项/)
  assert.match(out.sentences[0].text, /α = \.82/)
})

console.log(`\nsentences: ${checks} checks passed`)
