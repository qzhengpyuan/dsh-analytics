// 把跑出来的表写成「能直接粘进稿子」的句子。
//
// agent 写结果段时的真实痛点不是缺数字，而是数字散在一张张表的格子里，
// 还得自己判断「这一行是 Levene 还是 t」「方差不等时该抄哪一行」。这里把这些
// 判断固化下来：识别表的形状（表头 + 关键行），按统计口径挑该用的那一行，
// 生成中文与英文两套句式，并把用到的数字一起回出去，便于引用与核对。
//
// 原则：只搬运表里印出来的数（不重算），PSPP 印 `.000` 时写成 `p < 0.001`，
// 印出 `+Infinit`（完全分离）时原样照说，不替换成好看的数。

/** PSPP 的小数写法 → 句子里的写法：`.000` 是「小于 0.001」。 */
export function formatP(text) {
  const value = String(text ?? '').trim()
  if (value === '' || value === '.') return null
  // `NaN`（某一组只有 1 个个案时 Levene 算不出来）、`+Infinit`（完全分离）
  // 都不是 P 值，别把字符串塞进句子里冒充。
  if (!/^[.-]?\d/.test(value)) return null
  if (/^\.0+$/.test(value)) return '< 0.001'
  return value.replace(/^\./, '0.')
}

/**
 * PSPP 会在显著值后面挂一个脚注上标（`<sup>a</sup>`，表尾写 `a. Significant at
 * .05 level`）。那是给人看的标记，不是数字的一部分 —— 不剥掉的话句子里会出现
 * `r = .995<sup>a</sup>`，`Number()` 还会得到 NaN。
 */
const cell = (value) => {
  let text = String(value ?? '')
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim()
  // 纯数字后面粘着一个字母（`.995a`）时去掉那个字母。
  text = text.replace(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-z])$/i, '$1')
  return text === '' || text === '.' ? null : text
}

/** `p` 是否小于某个水平；`< 0.001` 这种写法也算（它是字符串，Number 会得 NaN）。 */
const below = (p, level) => p !== null && (p === '< 0.001' || Number(p) < level)

const headerOf = (matrix) => (matrix?.[0] ?? []).map((value) => String(value ?? '').trim())

/**
 * PSPP 的表头可能拆成 2–3 行（`Independent Samples Test` 是 3 行：
 * 组名 / F·Sig.·t·df… / Lower·Upper），而这在矩阵里就是几行。判断哪几行是表头、
 * 哪一行开始是数据，靠「这一行里有几个能当成数字的格子」：数据行至少有两个。
 *
 * 表头合并规则：每一列取「最靠近数据的那一个非空标签」——
 * 第 10 列上面写着 `95% Confidence Interval of the Difference`、紧接着写 `Lower`，
 * 要的是 `Lower`。
 */
export function locateTable(matrix) {
  const isNumeric = (value) => {
    const text = String(value ?? '').trim().replace(/,/g, '')
    return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?%?$/.test(text)
  }
  let start = 1
  for (let row = 1; row < matrix.length; row += 1) {
    const numeric = (matrix[row] ?? []).filter(isNumeric).length
    if (numeric >= 2) {
      start = row
      break
    }
  }
  const width = Math.max(...matrix.slice(0, Math.max(start, 1)).map((row) => (row ?? []).length), 0)
  const header = Array.from({ length: width }, (_, column) => {
    for (let row = start - 1; row >= 0; row -= 1) {
      const text = String(matrix[row]?.[column] ?? '').trim()
      if (text !== '') return text
    }
    return ''
  })
  return { header, start, rows: matrix.slice(start) }
}

/** 表头里找列号（找不到回 -1）。 */
const columnOf = (header, ...names) => {
  for (const name of names) {
    const index = header.findIndex((cellText) => cellText.toLowerCase() === name.toLowerCase())
    if (index >= 0) return index
  }
  for (const name of names) {
    const index = header.findIndex((cellText) => cellText.toLowerCase().includes(name.toLowerCase()))
    if (index >= 0) return index
  }
  return -1
}

/**
 * 描述统计：表头 N/Mean/Std Dev。
 * 行里 `Valid N (listwise)` 这类汇总行没有第二个数字，靠「第一列像变量名」过滤。
 */
function descriptivesSentences(title, matrix, language) {
  const { header, start } = locateTable(matrix)
  // 精确匹配：`Mean Difference`、`T-Test for Equality of Means` 里也含 Mean，
  // 用 includes 会把检验表当成描述统计（曾经真的这样报过一句 `M = -2.83`）。
  // `Paired Sample Statistics` 的第一列是「Pair 1」，当成描述统计会写出一句
  // 「Pair 1：n = 20」，那不是变量。
  if (/Paired/i.test(title)) return []
  const nColumn = header.indexOf('N')
  const meanColumn = header.indexOf('Mean')
  const sdColumn = Math.max(header.indexOf('Std Dev'), header.indexOf('Std. Deviation'))
  if (nColumn < 0 || meanColumn < 0) return []
  const out = []
  const body = matrix.slice(start)
  // `ONEWAY … /STATISTICS=DESCRIPTIVES` 的表是「每个组一行 + Total 行」，
  // 第一列只有每个变量的第一组那行写着变量名。直接按行造句会写出「y：n = 8」，
  // 那是第一组的数，不是全部。有 Total 行时只报 Total，并写清是全部个案。
  //
  // 两个因变量时这张表有**多个** Total 行（每个变量一段），只取第一个会把
  // 第二个变量整段丢掉（复验抓到过），所以按「变量名只在段首出现」逐段走。
  const totalIndexes = []
  let currentName = title
  body.forEach((row, index) => {
    const first = cell(row[0])
    if (first && first !== '') currentName = first
    if (/^Total$/i.test(String(cell(row[1]) ?? ''))) totalIndexes.push({ index, name: currentName })
  })
  const grouped = totalIndexes.length > 0
  const rows = grouped
    ? totalIndexes.map((entry) => ({ row: body[entry.index], name: entry.name }))
    : body.map((row) => ({ row, name: null }))
  for (const entry of rows) {
    const row = entry.row
    const name = grouped
      ? (language === 'en' ? `${entry.name} (overall)` : `${entry.name}（全部）`)
      : cell(row[0])
    if (!name || /listwise|N of Valid|Missing/i.test(name)) continue
    const mean = cell(row[meanColumn])
    if (mean === null) continue
    const sd = sdColumn >= 0 ? cell(row[sdColumn]) : null
    const n = cell(row[nColumn])
    out.push({
      kind: 'descriptives',
      table: title,
      // values 里放不带后缀的变量名：同一批句子里方差分析报「得分一」，这里
      // 报「得分一（全部）」会让按变量配对的下游对不上（复验 P2-4）。
      values: { variable: grouped ? entry.name : name, n: n === null ? null : Number(n), mean: Number(mean), sd: sd === null ? null : Number(sd) },
      text: language === 'en'
        ? `${name}: n = ${n ?? '—'}, M = ${mean}${sd === null ? '' : `, SD = ${sd}`}.`
        : `${name}：n = ${n ?? '—'}，M = ${mean}${sd === null ? '' : `，SD = ${sd}`}。`,
    })
  }
  return out
}

/** 频数表：表名就是变量名，表头有 Frequency / Percent。 */
function frequencySentences(title, matrix, language) {
  const header = headerOf(matrix)
  const frequencyColumn = columnOf(header, 'Frequency')
  const percentColumn = columnOf(header, 'Percent')
  if (frequencyColumn < 0) return []
  const parts = []
  const english = []
  const values = []
  for (const row of matrix.slice(1)) {
    const label = cell(row[1]) ?? cell(row[0])
    if (!label || /^Total$/i.test(label)) continue
    const frequency = cell(row[frequencyColumn])
    if (frequency === null) continue
    const percent = percentColumn >= 0 ? cell(row[percentColumn]) : null
    parts.push(`${label} ${frequency} 次${percent === null ? '' : `（${percent}）`}`)
    english.push(`${label} ${frequency} times${percent === null ? '' : ` (${percent})`}`)
    values.push({ label, frequency: Number(frequency), percent: percent === null ? null : percent })
  }
  if (parts.length === 0) return []
  return [{
    kind: 'frequencies',
    table: title,
    values: { variable: title, counts: values },
    text: language === 'en'
      ? `${title}: ${english.join(', ')}.`
      : `${title} 的分布：${parts.join('，')}。`,
  }]
}

/** 相关矩阵：`<变量>` + `Pearson Correlation` / `Sig. (2-tailed)` / `N` 三段。 */
function correlationSentences(title, matrix, language) {
  const header = headerOf(matrix)
  const names = header.slice(2).filter(Boolean)
  if (names.length < 2) return []
  const out = []
  for (let row = 1; row < matrix.length; row += 1) {
    const name = cell(matrix[row][0])
    if (!name) continue
    const label = cell(matrix[row][1])
    if (label !== 'Pearson Correlation') continue
    const significance = cell(matrix[row + 1]?.[1]) === 'Sig. (2-tailed)' ? matrix[row + 1] : null
    const counts = cell(matrix[row + 2]?.[1]) === 'N' ? matrix[row + 2] : null
    names.forEach((other, position) => {
      if (other === name) return
      const r = cell(matrix[row][2 + position])
      if (r === null) return
      // 只报一次：矩阵对称，i<j 那条。
      if (names.indexOf(name) > names.indexOf(other)) return
      const p = significance ? formatP(cell(significance[2 + position])) : null
      const n = counts ? cell(counts[2 + position]) : null
      out.push({
        kind: 'correlation',
        table: title,
        values: { left: name, right: other, r: Number(r), p, n: n === null ? null : Number(n) },
        text: language === 'en'
          ? `${name} and ${other}: r = ${r}${p === null ? '' : `, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`}${n === null ? '' : `, n = ${n}`}.`
          : `${name} 与 ${other} 的 Pearson 相关：r = ${r}${p === null ? '' : `，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`}${n === null ? '' : `，n = ${n}`}。`,
      })
    })
  }
  return out
}

/**
 * 独立样本 t：`Group Statistics` 给两组的 n / M / SD，`Independent Samples Test`
 * 给 t / df / p / 均值差 / 区间。方差齐性用 Levene 的 Sig. 判：< 0.05 时抄
 * 「不假定方差相等」那一行 —— 抄错行是这类表最常见的错误。
 */
function independentT(item, pairs, language) {
  const groups = []
  const header = headerOf(item.table.matrix)
  const groupColumn = columnOf(header, 'Group')
  const nColumn = columnOf(header, 'N')
  const meanColumn = columnOf(header, 'Mean')
  const sdColumn = columnOf(header, 'Std. Deviation', 'Std Dev')
  for (const row of item.table.matrix.slice(1)) {
    const group = cell(row[groupColumn])
    if (!group) continue
    groups.push({
      group,
      n: cell(row[nColumn]) === null ? null : Number(cell(row[nColumn])),
      mean: cell(row[meanColumn]) === null ? null : Number(cell(row[meanColumn])),
      sd: cell(row[sdColumn]) === null ? null : Number(cell(row[sdColumn])),
    })
  }
  const test = pairs.find((entry) => /Independent Samples Test/i.test(entry.title))
  if (!test || groups.length < 2) return []
  // 表头拆成两行：第 1 行是「Levene's…/T-Test…」，第 2 行才是 F/Sig./t/df…
  const located = locateTable(test.table.matrix)
  const testHeader = located.header
  const tColumn = testHeader.indexOf('t')
  const dfColumn = testHeader.indexOf('df')
  const pColumn = testHeader.indexOf('Sig. (2-tailed)')
  const diffColumn = testHeader.indexOf('Mean Difference')
  // 置信区间的 Lower/Upper 在上一行表头里（表头被拆成两行），而它的位置是
  // 固定的：均值差、均值差的标准误、下限、上限，紧挨着排。
  const lowColumn = diffColumn >= 0 ? diffColumn + 2 : -1
  const highColumn = diffColumn >= 0 ? diffColumn + 3 : -1
  // 两个 `Sig.`：Levene 那个在 t 之前，t 检验那个是 `Sig. (2-tailed)`。
  const leveneColumn = tColumn > 0 ? testHeader.slice(0, tColumn).indexOf('Sig.') : -1
  const body = located.rows
  const assumed = body.find((row) => /Equal variances assumed/i.test(String(row[1] ?? '')))
  const notAssumed = body.find((row) => /Equal variances not assumed/i.test(String(row[1] ?? '')))
  if (!assumed) return []
  const levene = leveneColumn >= 1 ? formatP(cell(assumed[leveneColumn])) : null
  const useRow = below(levene, 0.05) && notAssumed ? notAssumed : assumed
  const equal = useRow === assumed
  const variable = cell(assumed[0]) ?? groups[0].group
  const t = cell(useRow[tColumn])
  const df = cell(useRow[dfColumn])
  const p = formatP(cell(useRow[pColumn]))
  const diff = cell(useRow[diffColumn])
  const low = lowColumn >= 0 ? cell(useRow[lowColumn]) : null
  const high = highColumn >= 0 ? cell(useRow[highColumn]) : null
  const [left, right] = groups
  const significant = below(p, 0.05)
  const values = { variable, groups, t: Number(t), df: Number(df), p, meanDifference: Number(diff), equalVariances: equal, leveneP: levene }
  const text = language === 'en'
    ? `Independent-samples t test (${variable}): ${left.group} (n = ${left.n}, M = ${left.mean}, SD = ${left.sd}) versus ${right.group} (n = ${right.n}, M = ${right.mean}, SD = ${right.sd}) — t(${df}) = ${t}, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}, mean difference ${diff}${low === null ? '' : `, 95% CI ${low} to ${high}`}${equal ? '' : ' (equal variances not assumed)'}.`
    : `独立样本 t 检验（${variable}）：${left.group} 组（n = ${left.n}，M = ${left.mean}，SD = ${left.sd}）与 ${right.group} 组（n = ${right.n}，M = ${right.mean}，SD = ${right.sd}）之间${significant ? '差异显著' : '差异不显著'}，t(${df}) = ${t}，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}，均值差 ${diff}${low === null ? '' : `（95% CI ${low} ~ ${high}）`}${equal ? '' : '（方差不齐，用不假定方差相等那一行）'}。`
  return [{ kind: 'ttest-independent', table: `${item.title} / ${test.title}`, values, text }]
}

/** 单样本 t：`One-Sample Test` 一行一个变量，检验值是表头上写的那个数。 */
function oneSampleSentences(item, language) {
  const { header, rows: body } = locateTable(item.table.matrix)
  const tColumn = header.indexOf('t')
  const dfColumn = header.indexOf('df')
  const pColumn = header.indexOf('Sig. (2-tailed)')
  const diffColumn = header.indexOf('Mean Difference')
  if (tColumn < 0 || pColumn < 0) return []
  // 检验值写在第一行表头里（`Test Value = 5`）。
  const testValue = String(item.table.matrix[0]?.[1] ?? '').match(/=\s*([-\d.]+)/)?.[1] ?? null
  return body.map((row) => {
    const name = cell(row[0])
    const t = cell(row[tColumn])
    if (!name || t === null) return null
    const p = formatP(cell(row[pColumn]))
    const diff = diffColumn >= 0 ? cell(row[diffColumn]) : null
    const low = diffColumn >= 0 ? cell(row[diffColumn + 1]) : null
    const high = diffColumn >= 0 ? cell(row[diffColumn + 2]) : null
    return {
      kind: 'ttest-one-sample',
      table: item.title,
      values: { variable: name, testValue: testValue === null ? null : Number(testValue), t: Number(t), df: Number(cell(row[dfColumn])), p, meanDifference: diff === null ? null : Number(diff) },
      text: language === 'en'
        ? `One-sample t test (${name} against ${testValue ?? '—'}): t(${cell(row[dfColumn])}) = ${t}, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}, mean difference ${diff}${low === null ? '' : `, 95% CI ${low} to ${high}`}.`
        : `单样本 t 检验（${name} 与检验值 ${testValue ?? '—'} 比较）：t(${cell(row[dfColumn])}) = ${t}，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}，均值差 ${diff}${low === null ? '' : `（95% CI ${low} ~ ${high}）`}。`,
    }
  }).filter(Boolean)
}

/** 配对 t：`Paired Samples Test` 的 Paired Differences 三行表头。 */
function pairedSentences(item, language) {
  const { header, rows: body } = locateTable(item.table.matrix)
  const tColumn = header.indexOf('t')
  const dfColumn = header.indexOf('df')
  const pColumn = header.indexOf('Sig. (2-tailed)')
  const meanColumn = header.indexOf('Mean')
  if (tColumn < 0 || pColumn < 0 || meanColumn < 0) return []
  return body.map((row) => {
    const pair = cell(row[1]) ?? cell(row[0])
    const t = cell(row[tColumn])
    if (!pair || t === null) return null
    const p = formatP(cell(row[pColumn]))
    const difference = cell(row[meanColumn])
    return {
      kind: 'ttest-paired',
      table: item.title,
      values: { pair, meanDifference: Number(difference), t: Number(t), df: Number(cell(row[dfColumn])), p },
      text: language === 'en'
        ? `Paired-samples t test (${pair}): mean difference ${difference}, t(${cell(row[dfColumn])}) = ${t}, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}.`
        : `配对样本 t 检验（${pair}）：平均差 ${difference}，t(${cell(row[dfColumn])}) = ${t}，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}。`,
    }
  }).filter(Boolean)
}

/** 单因素方差分析：`ANOVA` 表的 Between / Within / Total 三行。 */
function anovaSentences(title, matrix, language) {
  const { header, rows: body } = locateTable(matrix)
  const dfColumn = columnOf(header, 'df')
  const fColumn = columnOf(header, 'F')
  const pColumn = columnOf(header, 'Sig.')
  if (dfColumn < 0 || fColumn < 0) return []
  // 多个因变量时 ANOVA 表是「每个变量一段」，每段各有一行 Between Groups。
  // 只取第一段会把第二个变量整段丢掉（表达式里的 byCount 早就承认多变量，
  // 却只输出一句）。
  const blocks = []
  let currentName = title
  for (const row of body) {
    const first = cell(row[0])
    if (first && first !== '') currentName = first
    if (!/Between/i.test(String(row[1] ?? ''))) continue
    blocks.push({ row, variable: currentName })
  }
  if (blocks.length === 0) return []
  const byCount = blocks.length
  return blocks.map(({ row: between, variable }) => {
    const df1 = cell(between[dfColumn])
    const index = body.indexOf(between)
    const within = body.slice(index + 1).find((row) => /Within|Residual/i.test(String(row[1] ?? '')))
    const df2 = within ? cell(within[dfColumn]) : null
    const f = cell(between[fColumn])
    const p = formatP(cell(between[pColumn]))
    if (f === null || df1 === null) return null
    return {
    kind: 'anova',
    table: title,
    values: { variable, f: Number(f), df1: Number(df1), df2: df2 === null ? null : Number(df2), p },
    text: language === 'en'
      ? `One-way ANOVA${byCount > 1 ? ' (several dependent variables)' : ''} (${variable}): F(${df1}, ${df2 ?? '—'}) = ${f}, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}.`
      : `${byCount > 1 ? '多因变量方差分析（逐变量）' : '单因素方差分析'}（${variable}）：F(${df1}, ${df2 ?? '—'}) = ${f}，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}。`,
    }
  }).filter(Boolean)
}

/** 卡方检验：`Chi-Square Tests` 的 Pearson 行 + N of Valid Cases。 */
function chiSquareSentences(title, matrix, language, crosstabTitle) {
  const { header, rows: body } = locateTable(matrix)
  const valueColumn = columnOf(header, 'Value')
  const dfColumn = columnOf(header, 'df')
  const pColumn = columnOf(header, 'Asymptotic Sig.', 'Sig.')
  if (valueColumn < 0) return []
  // PSPP 有时不印 Pearson 行（比如期望频数为 0），那就退到似然比、再退到
  // 线性关联 —— 报一张表里真有的那个检验，不要因为找不到 Pearson 就什么都不说。
  const row = ['Pearson Chi-Square', 'Likelihood Ratio', 'Linear-by-Linear Association']
    .map((name) => body.find((entry) => String(entry[0] ?? '').includes(name)))
    .find(Boolean)
  if (!row) return []
  const nRow = body.find((entry) => /N of Valid Cases/i.test(String(entry[0] ?? '')))
  const value = cell(row[valueColumn])
  const df = dfColumn >= 0 ? cell(row[dfColumn]) : null
  const p = formatP(cell(row[pColumn]))
  const n = nRow ? cell(nRow[valueColumn]) : null
  const pair = crosstabTitle ?? title
  const values = { table: pair, test: String(row[0] ?? ''), chiSquare: Number(value), df: df === null ? null : Number(df), p, n: n === null ? null : Number(n) }
  return [{
    kind: 'chi-square',
    table: title,
    values,
    text: language === 'en'
      ? `${pair}: ${String(row[0])} χ²(${df ?? '—'}) = ${value}, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}${n === null ? '' : `, n = ${n}`}.`
      : `${pair} 的${String(row[0]) === 'Pearson Chi-Square' ? ' Pearson ' : ` ${String(row[0])} `}卡方：χ²(${df ?? '—'}) = ${value}，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}${n === null ? '' : `，n = ${n}`}。`,
  }]
}

/** 线性回归：`Model Summary` 给 R²，`ANOVA` 给 F，`Coefficients` 给每个系数。 */
function regressionSentences(items, language) {
  const summary = items.find((item) => /Model Summary/i.test(item.title))
  const anova = items.find((item) => /^ANOVA/i.test(item.title) && !/Between/i.test(String(item.table.matrix?.[1]?.[1] ?? '')))
  const coefficients = items.find((item) => /Coefficients/i.test(item.title))
  if (!summary || !coefficients) return []
  const out = []
  const outcome = String(summary.title).match(/\(([^)]+)\)/)?.[1] ?? 'y'
  const summaryHeader = headerOf(summary.table.matrix)
  const r2Column = columnOf(summaryHeader, 'R Square')
  const r2 = r2Column >= 0 ? cell(summary.table.matrix[1]?.[r2Column]) : null
  let fit = null
  if (anova) {
    const anovaHeader = headerOf(anova.table.matrix)
    const fColumn = columnOf(anovaHeader, 'F')
    const pColumn = columnOf(anovaHeader, 'Sig.')
    const dfColumn = columnOf(anovaHeader, 'df')
    const regressionRow = anova.table.matrix.find((row) => /Regression/i.test(String(row[0] ?? '')))
    const residualRow = anova.table.matrix.find((row) => /Residual/i.test(String(row[0] ?? '')))
    if (regressionRow) {
      fit = {
        rSquare: r2 === null ? null : Number(r2),
        f: Number(cell(regressionRow[fColumn])),
        df1: Number(cell(regressionRow[dfColumn])),
        df2: residualRow ? Number(cell(residualRow[dfColumn])) : null,
        p: formatP(cell(regressionRow[pColumn])),
      }
    }
  }
  out.push({
    kind: 'regression-fit',
    table: summary.title,
    values: { outcome, ...fit },
    text: language === 'en'
      ? `Linear regression (${outcome}): R² = ${r2 ?? '—'}${fit ? `, F(${fit.df1}, ${fit.df2}) = ${fit.f}, p ${fit.p === '< 0.001' ? '< 0.001' : `= ${fit.p}`}` : ''}.`
      : `线性回归（因变量 ${outcome}）：R² = ${r2 ?? '—'}${fit ? `，F(${fit.df1}, ${fit.df2}) = ${fit.f}，p ${fit.p === '< 0.001' ? '< 0.001' : `= ${fit.p}`}` : ''}。`,
  })
  const located = locateTable(coefficients.table.matrix)
  const head = located.header
  const bColumn = head.indexOf('B')
  const seColumn = head.indexOf('Std. Error')
  const tColumn = head.indexOf('t')
  const pColumn = head.indexOf('Sig.')
  for (const row of located.rows) {
    const name = cell(row[0])
    if (!name) continue
    const b = cell(row[bColumn])
    if (b === null) continue
    const se = seColumn >= 0 ? cell(row[seColumn]) : null
    const t = tColumn >= 0 ? cell(row[tColumn]) : null
    const p = pColumn >= 0 ? formatP(cell(row[pColumn])) : null
    out.push({
      kind: 'regression-coefficient',
      table: coefficients.title,
      values: { outcome, term: name, b: Number(b), se: se === null ? null : Number(se), t: t === null ? null : Number(t), p },
      text: language === 'en'
        ? `${name}: B = ${b}${se === null ? '' : `, SE = ${se}`}${t === null ? '' : `, t = ${t}`}${p === null ? '' : `, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`}.`
        : `${name}：B = ${b}${se === null ? '' : `，SE = ${se}`}${t === null ? '' : `，t = ${t}`}${p === null ? '' : `，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`}。`,
    })
  }
  return out
}

/**
 * 引擎偶尔把很小的数印成 `-3.30E-018`（B 很接近 0 时）。句子是给人抄进稿子
 * 的，科学计数法要换成小数；小到不足以影响解释的直接写 0.000。
 */
function readableNumber(raw) {
  const text = String(raw ?? '').trim()
  if (!/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) return text
  const value = Number(text)
  if (!Number.isFinite(value)) return text
  if (Math.abs(value) < 1e-9) return '0.000'
  if (Math.abs(value) >= 0.001) return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return value.toFixed(6)
}

/** Logistic 回归：Variables in the Equation 每行一个自变量，报 OR 与 95% CI。 */
function logisticSentences(title, matrix, language) {
  const { header, rows } = locateTable(matrix)
  const bColumn = columnOf(header, 'B')
  const seColumn = columnOf(header, 'S.E.')
  const pColumn = columnOf(header, 'Sig.')
  const orColumn = columnOf(header, 'Exp(B)')
  const lowerColumn = columnOf(header, 'Lower')
  const upperColumn = columnOf(header, 'Upper')
  if (bColumn < 0 || orColumn < 0) return []
  const out = []
  for (const row of rows) {
    const name = cell(row[1]) ?? cell(row[0])
    if (!name || /Constant|常数|Step/i.test(String(name))) continue
    const b = readableNumber(cell(row[bColumn]))
    const or = readableNumber(cell(row[orColumn]))
    // 完全分离时 PSPP 印 NaN：这不是「有效应」，不能造句。
    if (b === null || or === null || !Number.isFinite(Number(b)) || !Number.isFinite(Number(or))) continue
    const se = seColumn >= 0 ? readableNumber(cell(row[seColumn])) : null
    const p = formatP(pColumn >= 0 ? cell(row[pColumn]) : null)
    // CI 上下限也过 readableNumber：1.23E-005 这种印法留在句子里比 B 那格
    // 更难读（复验 P2-1）。
    const lower = lowerColumn >= 0 ? readableNumber(cell(row[lowerColumn])) : null
    const upper = upperColumn >= 0 ? readableNumber(cell(row[upperColumn])) : null
    const ci = lower === null || upper === null
      ? ''
      : language === 'en' ? `, 95% CI ${lower} to ${upper}` : `，95% CI ${lower} ~ ${upper}`
    const pText = p === null ? '' : language === 'en' ? `, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}` : `，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`
    out.push({
      kind: 'logistic-odds',
      table: title,
      values: { term: String(name), b: Number(b), se: se === null ? null : Number(se), oddsRatio: Number(or), p },
      text: language === 'en'
        ? `${name}: OR = ${or}${ci} (B = ${b}${se === null ? '' : `, SE = ${se}`})${pText}.`
        : `${name}：OR = ${or}${ci}（B = ${b}${se === null ? '' : `，SE = ${se}`}）${pText}。`,
    })
  }
  return out
}

/**
 * 非参数检验的两张 Test Statistics 版式都要认：
 * Mann-Whitney 是「一行一个变量 + U/W/Z/p 列」，Kruskal-Wallis 与
 * Wilcoxon 是**转置**的（行是统计量名、列是变量名），转置版式里 p 在
 * `Asymp. Sig.` 行。
 */
function nonparametricSentences(title, matrix, language) {
  const header = headerOf(matrix)
  const out = []
  const uColumn = columnOf(header, 'Mann-Whitney U')
  if (uColumn >= 0) {
    const { rows } = locateTable(matrix)
    const zColumn = columnOf(header, 'Z')
    const pColumn = header.findIndex((label, index) => index > 0 && /Asymp\. Sig|Exact Sig|Sig/.test(String(label)))
    for (const row of rows) {
      const name = cell(row[0])
      const u = cell(row[uColumn])
      if (!name || u === null || /^(Total|合计)$/i.test(name)) continue
      const z = zColumn >= 0 ? cell(row[zColumn]) : null
      const p = formatP(pColumn >= 0 ? cell(row[pColumn]) : null)
      out.push({
        kind: 'npar-mannwhitney',
        table: title,
        values: { variable: String(name), u: Number(u), z: z === null ? null : Number(z), p },
        text: language === 'en'
          ? `${name}: the two groups ${p !== null && (p === '< 0.001' || Number(p) < 0.05) ? 'differ in location' : 'do not differ in location'} (Mann-Whitney U = ${u}${z === null ? '' : `, Z = ${z}`}${p === null ? '' : `, p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`}).`
          : `${name}：两组的位置分布差异${p !== null && (p === '< 0.001' || Number(p) < 0.05) ? '有统计学意义' : '不显著'}（Mann-Whitney U = ${u}${z === null ? '' : `，Z = ${z}`}${p === null ? '' : `，p ${p === '< 0.001' ? '< 0.001' : `= ${p}`}`}）。`,
      })
    }
    return out
  }
  // 转置版式：第一行是变量名，行名里找 Chi-Square / df / Asymp. Sig.
  const statRow = matrix.find((row) => /^Chi-Square$/i.test(String(row[0] ?? '')))
  const dfRow = matrix.find((row) => /^df$/i.test(String(row[0] ?? '')))
  const pRow = matrix.find((row) => /^Asymp\. Sig/i.test(String(row[0] ?? '')))
  if (!statRow) return []
  const first = header.findIndex((label) => label !== '' && label !== undefined)
  for (let column = 0; column < (matrix[0]?.length ?? 0); column += 1) {
    const name = cell(matrix[0][column])
    const statistic = cell(statRow[column])
    if (!name || statistic === null) continue
    const df = dfRow ? cell(dfRow[column]) : null
    const p = formatP(pRow ? cell(pRow[column]) : null)
    out.push({
      kind: 'npar-kruskal',
      table: title,
      values: { variable: String(name), chiSquare: Number(statistic), df: df === null ? null : Number(df), p },
      text: language === 'en'
        ? `${name}: Kruskal-Wallis χ²(${df ?? '—'}) = ${statistic}, p ${p === '< 0.001' ? '< 0.001' : `= ${p ?? '—'}`}.`
        : `${name}：Kruskal-Wallis 检验 χ²(${df ?? '—'}) = ${statistic}，p ${p === '< 0.001' ? '< 0.001' : `= ${p ?? '—'}`}。`,
    })
  }
  return out
}

/** 信度：Reliability Statistics 只有两行（α 与题项数）。 */
function alphaSentences(title, matrix, language) {
  const header = headerOf(matrix)
  const alphaColumn = columnOf(header, "Cronbach's Alpha")
  const itemsColumn = columnOf(header, 'N of Items')
  if (alphaColumn < 0) return []
  const alpha = cell(matrix[1]?.[alphaColumn])
  if (alpha === null || !Number.isFinite(Number(alpha))) return []
  const items = itemsColumn >= 0 ? cell(matrix[1][itemsColumn]) : null
  return [{
    kind: 'reliability-alpha',
    table: title,
    values: { alpha: Number(alpha), items: items === null ? null : Number(items) },
    text: language === 'en'
      ? `${items ?? '—'} items: Cronbach's α = ${alpha}.`
      : `${items ?? '—'} 个题项：Cronbach's α = ${alpha}。`,
  }]
}

/**
 * 一组输出项 → 句子列表。
 *
 * 只认得出形状的表会被转成句子；认不出的表进 `skipped`（带标题），
 * 不硬编一句「看起来很显著」出来。语言取 `language`（`zh` / `en`）。
 */
/** 已经变成句子的表（同一组表只算一次，不再列进 skipped）。 */
const CONSUMED_TITLES = /Model Summary|Coefficients|^ANOVA|Group Statistics|Independent Samples Test|Test of Homogeneity of Variances|Chi-Square Tests|Correlations|One-Sample|Paired|^Descriptives$|^Test Statistics|^Ranks$|Reliability Statistics|Variables in the Equation/i

/** 引擎自己印的流水表：没有句子可造，也不算「认不出来」。 */
const PLUMBING_TITLES = /Reading free-form data|Case Processing Summary|Dependent Variable Encoding|Classification Table|Variables Entered|Residuals Statistics|Notes$|Warnings$|Omnibus Tests|Block \d/i

export function sentencesOf(items, options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh'
  const tables = (items ?? []).filter((item) => item.kind === 'table' && item.table?.matrix?.length)
  const sentences = []
  const skipped = []
  const seen = new Set()
  const crosstabTitle = tables.find((item) => /×|×| by /i.test(String(item.title ?? '')))?.title
  for (const item of tables) {
    const title = String(item.title ?? item.table.caption ?? '表格')
    const matrix = item.table.matrix
    const header = headerOf(matrix)
    let produced = []
    if (/Group Statistics/i.test(title)) {
      produced = independentT(item, tables, language)
    } else if (/One-Sample Test/i.test(title)) {
      produced = oneSampleSentences(item, language)
    } else if (/Paired Samples Test/i.test(title)) {
      produced = pairedSentences(item, language)
    } else if (/Chi-Square Tests/i.test(title)) {
      produced = chiSquareSentences(title, matrix, language, crosstabTitle)
    } else if (/^ANOVA/i.test(title)) {
      produced = anovaSentences(title, matrix, language)
    } else if (/Variables in the Equation/i.test(title)) {
      produced = logisticSentences(title, matrix, language)
    } else if (/^Test Statistics/i.test(title)) {
      produced = nonparametricSentences(title, matrix, language)
    } else if (/Reliability Statistics/i.test(title)) {
      produced = alphaSentences(title, matrix, language)
    } else if (/Model Summary|Coefficients/i.test(title)) {
      // 回归三张表合成一组句子，放在一起只算一次。
      if (!seen.has('regression')) {
        seen.add('regression')
        produced = regressionSentences(tables, language)
      }
    } else if (/Correlations/i.test(title)) {
      produced = correlationSentences(title, matrix, language)
    } else if (columnOf(header, 'Frequency') >= 0) {
      produced = frequencySentences(title, matrix, language)
    } else if (columnOf(header, 'Mean') >= 0 && columnOf(header, 'N') >= 0) {
      produced = descriptivesSentences(title, matrix, language)
    }
    if (produced.length > 0) {
      sentences.push(...produced)
    } else if (!CONSUMED_TITLES.test(title) && !PLUMBING_TITLES.test(title)) {
      // 引擎的流水表（读数据提示、个案处理摘要、哑变量编码、分类表）本来
      // 就不该变成句子；把它们算进「认不出来的表」会让面板报一个虚高的数
      // （复验 P2-2）。同名表只列一次。
      if (!skipped.includes(title)) skipped.push(title)
    }
  }
  return { language, sentences, skipped }
}
