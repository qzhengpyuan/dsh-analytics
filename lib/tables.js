/**
 * Publication tables: "table 1" baseline characteristics and "table 2"
 * between-group comparisons.
 *
 * PSPP can produce every number here, but only one command at a time and in a
 * shape no journal accepts. A thesis table is one grid: rows are variables (and
 * their categories), columns are the groups, the last column is a p value. So
 * the arithmetic happens here from the same dataset the engine loaded, with the
 * same test SPSS would pick: Welch t for two groups, one-way ANOVA for three or
 * more, Pearson chi-square for categories.
 */

import { tCritical95 } from './charts.js'


function isNumeric(variable) {
  return variable?.type !== 'string'
}

function rawValue(variable, value) {
  if (value === null || value === undefined || value === '') return null
  if (isNumeric(variable)) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return String(value)
}

function labelFor(variable, value) {
  const labels = variable?.valueLabels ?? {}
  const text = labels[String(value)]
  return text === undefined || text === '' ? String(value) : text
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sd(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1))
}

function quantile(values, p) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function formatMeanSd(values) {
  const digits = Math.abs(mean(values)) >= 100 ? 1 : 2
  return `${mean(values).toFixed(digits)} ± ${sd(values).toFixed(digits)}`
}

function formatMedianIqr(values) {
  const digits = Math.abs(quantile(values, 0.5) ?? 0) >= 100 ? 1 : 2
  return `${(quantile(values, 0.5) ?? 0).toFixed(digits)}（${(quantile(values, 0.25) ?? 0).toFixed(digits)}–${(quantile(values, 0.75) ?? 0).toFixed(digits)}）`
}

function formatP(p) {
  if (p === null || !Number.isFinite(p)) return ''
  if (p < 0.001) return '<0.001'
  return p.toFixed(3)
}

/* ------------------------------------------------------------------ *
 * Distributions. The tables need p values for t, F and chi-square, and   *
 * a plugin cannot assume a statistics package on the host.               *
 * ------------------------------------------------------------------ */

function logGamma(z) {
  // Lanczos, same constants as lib/charts.js: 15 digits is far more than a
  // p value shown to three decimals needs.
  const p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  const zz = z - 1
  let sum = p[0]
  for (let i = 1; i < 9; i += 1) sum += p[i] / (zz + i)
  const t = zz + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(sum)
}

function betaContinuedFraction(a, b, x) {
  const tiny = 1e-30
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-10) break
  }
  return h
}

function incompleteBeta(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - (logGamma(a) + logGamma(b) - logGamma(a + b)))
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/** Upper tail of chi-square, i.e. the p value of a chi-square statistic. */
export function chiSquareP(statistic, df) {
  if (!Number.isFinite(statistic) || df <= 0) return null
  if (statistic <= 0) return 1
  // P(X > x) = Q(df/2, x/2); Q = 1 - P, and P(a,z) is the regularised lower
  // incomplete gamma, computed here by its series / continued fraction.
  const a = df / 2
  const x = statistic / 2
  if (x < a + 1) {
    let sum = 1 / a
    let term = sum
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break
    }
    const p = sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
    return Math.max(0, Math.min(1, 1 - p))
  }
  // Continued fraction for Q(a,x).
  const tiny = 1e-30
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-12) break
  }
  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
  return Math.max(0, Math.min(1, q))
}

export function studentP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return null
  return Math.min(1, Math.max(0, incompleteBeta(df / 2, 0.5, df / (df + t * t))))
}

/** Upper tail of the F distribution, as reported by ANOVA. */
export function fP(f, df1, df2) {
  if (!Number.isFinite(f) || df1 <= 0 || df2 <= 0) return null
  if (f <= 0) return 1
  return Math.min(1, Math.max(0, incompleteBeta(df2 / 2, df1 / 2, df2 / (df2 + df1 * f))))
}

/* ------------------------------------------------------------------ *
 * Tests                                                              *
 * ------------------------------------------------------------------ */

/** Welch's t test: the two-group comparison that does not assume equal SDs. */
export function welch(left, right) {
  const a = left.filter(Number.isFinite)
  const b = right.filter(Number.isFinite)
  if (a.length < 2 || b.length < 2) return null
  const va = sd(a) ** 2 / a.length
  const vb = sd(b) ** 2 / b.length
  const se = Math.sqrt(va + vb)
  if (se === 0) return { t: 0, df: a.length + b.length - 2, p: 1 }
  const t = (mean(a) - mean(b)) / se
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1))
  return { t, df, p: studentP(t, df) }
}

/** One-way ANOVA across two or more groups. */
export function anova(groups) {
  const lists = groups.map((values) => values.filter(Number.isFinite)).filter((values) => values.length > 0)
  if (lists.length < 2) return null
  const total = lists.flat()
  if (total.length <= lists.length) return null
  const grand = mean(total)
  const ssBetween = lists.reduce((sum, values) => sum + values.length * (mean(values) - grand) ** 2, 0)
  const ssWithin = lists.reduce((sum, values) => sum + values.reduce((inner, value) => inner + (value - mean(values)) ** 2, 0), 0)
  const df1 = lists.length - 1
  const df2 = total.length - lists.length
  if (df2 <= 0) return null
  if (ssWithin === 0) return { f: Infinity, df1, df2, p: 0 }
  const f = (ssBetween / df1) / (ssWithin / df2)
  return { f, df1, df2, p: fP(f, df1, df2) }
}

/** Pearson chi-square on a rows × columns contingency table. */
export function pearsonChiSquare(table) {
  const rows = table.length
  const columns = table[0]?.length ?? 0
  if (rows < 2 || columns < 2) return null
  const rowTotals = table.map((row) => row.reduce((sum, value) => sum + value, 0))
  const columnTotals = Array.from({ length: columns }, (_, index) => table.reduce((sum, row) => sum + row[index], 0))
  const total = rowTotals.reduce((sum, value) => sum + value, 0)
  if (total === 0) return null
  let stat = 0
  let minExpected = Infinity
  let small = 0
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < columns; j += 1) {
      const expected = (rowTotals[i] * columnTotals[j]) / total
      if (expected <= 0) continue
      stat += (table[i][j] - expected) ** 2 / expected
      minExpected = Math.min(minExpected, expected)
      if (expected < 5) small += 1
    }
  }
  const df = (rows - 1) * (columns - 1)
  return { statistic: stat, df, p: chiSquareP(stat, df), minExpected, smallCells: small, total }
}

/* ------------------------------------------------------------------ *
 * Table 1                                                            *
 * ------------------------------------------------------------------ */

/** Standardised mean difference with the pooled SD (Cohen's d). */
function cohensD(left, right) {
  const a = left.filter(Number.isFinite)
  const b = right.filter(Number.isFinite)
  if (a.length < 2 || b.length < 2) return null
  const pooled = Math.sqrt(((a.length - 1) * sd(a) ** 2 + (b.length - 1) * sd(b) ** 2) / (a.length + b.length - 2))
  if (!(pooled > 0)) return null
  return (mean(a) - mean(b)) / pooled
}

/** Share of the total variance explained by the groups (one-way η²). */
function etaSquared(groups) {
  const lists = groups.filter((values) => values.length > 0)
  if (lists.length < 2) return null
  const all = lists.flat()
  if (all.length <= lists.length) return null
  const grand = mean(all)
  const between = lists.reduce((sum, values) => sum + values.length * (mean(values) - grand) ** 2, 0)
  const total = all.reduce((sum, value) => sum + (value - grand) ** 2, 0)
  if (!(total > 0)) return null
  return between / total
}

/** Cramér's V for the levels × groups table behind a categorical row. */
function cramersV(counts) {
  const test = pearsonChiSquare(counts)
  if (!test || !Number.isFinite(test.statistic)) return null
  const rows = counts.length
  const columns = counts[0]?.length ?? 0
  const smallest = Math.min(rows - 1, columns - 1)
  if (smallest < 1 || test.total === 0) return null
  return Math.sqrt(test.statistic / (test.total * smallest))
}

/**
 * 95% interval for Cohen's d, Hedges & Olkin's large-sample formula.
 *
 * The exact interval needs the noncentral t; the normal approximation is what
 * textbooks print and is accurate from a handful of cases per group upward.
 */
function dInterval(d, n1, n2) {
  if (!Number.isFinite(d) || n1 < 2 || n2 < 2) return ''
  const se = Math.sqrt((n1 + n2) / (n1 * n2) + (d * d) / (2 * (n1 + n2)))
  const z = 1.959963985
  return `${formatNumber(d - z * se)} ~ ${formatNumber(d + z * se)}`
}

function formatEffect(text) {
  return text === null || !Number.isFinite(text) ? '—' : text.toFixed(2)
}

function groupColumns(dataset, groupVariable) {
  const index = dataset.variables.findIndex((variable) => variable.name === groupVariable)
  if (index < 0) throw new Error(`unknown variable: ${groupVariable}`)
  const variable = dataset.variables[index]
  const seen = new Map()
  for (const row of dataset.rows) {
    const raw = rawValue(variable, row[index])
    if (raw === null) continue
    const key = String(raw)
    if (!seen.has(key)) seen.set(key, labelFor(variable, raw))
  }
  const keys = [...seen.keys()].sort((left, right) => {
    const a = Number(left)
    const b = Number(right)
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b
    return left.localeCompare(right, 'zh-CN')
  })
  return { index, variable, keys, labels: keys.map((key) => seen.get(key)) }
}

/**
 * Build the baseline grid.
 *
 * `continuous` picks how numeric rows are summarised ("mean" or "median"); the
 * p value always comes from the test SPSS would run for the number of groups.
 */
export function buildBaselineTable(dataset, options = {}) {
  const groupName = options.group
  if (!groupName) throw new Error('表 1 需要一个分组变量（group）')
  const { index: groupIndex, variable: groupVariable, keys, labels } = groupColumns(dataset, groupName)
  if (keys.length < 2) throw new Error(`分组变量 ${groupName} 至少要有两个取值`)
  const names = options.variables?.length ? options.variables : dataset.variables
    .map((variable) => variable.name)
    .filter((name) => name !== groupName)
  if (names.length === 0) throw new Error('表 1 至少需要一个分析变量')
  const continuous = options.continuous === 'median' ? 'median' : 'mean'

  const header = ['变量', `总体（n=${dataset.rows.length}）`, ...labels.map((label, position) => (
    `${label}（n=${dataset.rows.filter((row) => String(rawValue(groupVariable, row[groupIndex]) ?? '') === keys[position]).length}）`
  )), 'P', '效应量']
  const matrix = [header]
  const notes = []

  for (const name of names) {
    const variableIndex = dataset.variables.findIndex((variable) => variable.name === name)
    if (variableIndex < 0) throw new Error(`unknown variable: ${name}`)
    const variable = dataset.variables[variableIndex]
    const label = variable.label || name

    if (isNumeric(variable)) {
      const all = dataset.rows.map((row) => rawValue(variable, row[variableIndex])).filter((value) => value !== null)
      const per = keys.map((key) => dataset.rows
        .filter((row) => String(rawValue(groupVariable, row[groupIndex]) ?? '') === key)
        .map((row) => rawValue(variable, row[variableIndex]))
        .filter((value) => value !== null))
      const summary = continuous === 'median' ? formatMedianIqr : formatMeanSd
      const row = [`${label}，${continuous === 'median' ? '中位数（四分位数间距）' : '均数±标准差'}`, summary(all), ...per.map(summary)]
      const test = per.length === 2 ? welch(per[0], per[1]) : anova(per)
      row.push(formatP(test?.p ?? null))
      // Two groups get Cohen's d, three or more η²: both answer "how big",
      // which a P value deliberately does not.
      row.push(per.length === 2
        ? `d=${formatEffect(cohensD(per[0], per[1]))}`
        : `η²=${formatEffect(etaSquared(per))}`)
      matrix.push(row)
      if (per.some((values) => values.length < 2)) notes.push(`${label}：有组少于 2 个有效值，该行的检验不成立`)
    } else {
      const levels = new Map()
      for (const row of dataset.rows) {
        const raw = rawValue(variable, row[variableIndex])
        if (raw === null) continue
        const key = String(raw)
        if (!levels.has(key)) levels.set(key, labelFor(variable, raw))
      }
      const sortedLevels = [...levels.keys()]
      const counts = sortedLevels.map((level) => keys.map((key) => dataset.rows.filter((row) => (
        String(rawValue(groupVariable, row[groupIndex]) ?? '') === key
        && String(rawValue(variable, row[variableIndex]) ?? '') === level
      )).length))
      const totals = sortedLevels.map((_, index) => counts[index].reduce((sum, value) => sum + value, 0))
      const grand = dataset.rows.filter((row) => rawValue(variable, row[variableIndex]) !== null).length
      const percent = (value, denominator) => (denominator === 0 ? '' : `${value}（${((value / denominator) * 100).toFixed(1)}）`)
      const test = pearsonChiSquare(counts)
      matrix.push([`${label}，n（%）`, percent(grand, grand), ...keys.map((_, column) => percent(
        counts.reduce((sum, row) => sum + row[column], 0),
        dataset.rows.filter((row) => String(rawValue(groupVariable, row[groupIndex]) ?? '') === keys[column]).length,
      )), '', `V=${formatEffect(cramersV(counts))}`])
      sortedLevels.forEach((level, position) => {
        const row = [`　${levels.get(level)}`, percent(totals[position], grand), ...keys.map((_, column) => percent(
          counts[position][column],
          dataset.rows.filter((item) => String(rawValue(groupVariable, item[groupIndex]) ?? '') === keys[column]).length,
        ))]
        row.push(position === 0 ? formatP(test?.p ?? null) : '', '')
        matrix.push(row)
      })
      if (test && test.smallCells > 0) {
        notes.push(`${label}：有 ${test.smallCells} 个单元格的期望频数 < 5（最小 ${test.minExpected.toFixed(2)}），卡方近似不可靠，宜用 Fisher 确切概率法`)
      }
    }
  }

  return {
    title: `表 1　基线特征（按 ${groupVariable.label || groupName} 分组）`,
    matrix,
    notes,
  }
}

/** Pairs × variables grid: the compact form a multi-group paper prints. */
export function buildSignificanceMatrix(dataset, options = {}) {
  const groupName = options.group
  if (!groupName) throw new Error('显著性矩阵需要一个分组变量（group）')
  const { index: groupIndex, variable: groupVariable, keys, labels } = groupColumns(dataset, groupName)
  if (keys.length < 2) throw new Error(`分组变量 ${groupName} 至少要有两个取值`)
  const adjust = options.adjust === 'none' ? 'none' : 'bonferroni'
  const names = options.variables?.length
    ? options.variables
    : dataset.variables.map((variable) => variable.name).filter((name) => name !== groupName)
  const pairs = []
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) pairs.push([left, right])
  }
  const header = ['变量', ...pairs.map(([left, right]) => `${labels[left]} vs ${labels[right]}`)]
  const matrix = [header]
  const notes = []
  for (const name of names) {
    const variableIndex = dataset.variables.findIndex((variable) => variable.name === name)
    if (variableIndex < 0) throw new Error(`unknown variable: ${name}`)
    const variable = dataset.variables[variableIndex]
    if (!isNumeric(variable)) continue
    const per = keys.map((key) => dataset.rows
      .filter((row) => String(rawValue(groupVariable, row[groupIndex]) ?? '') === key)
      .map((row) => rawValue(variable, row[variableIndex]))
      .filter((value) => value !== null))
    if (per.every((values) => values.length === 0)) continue
    const row = [variable.label || name]
    for (const [left, right] of pairs) {
      const test = welch(per[left], per[right])
      if (!test) { row.push('—'); continue }
      const adjusted = adjust === 'bonferroni' ? Math.min(1, test.p * pairs.length) : test.p
      const diff = mean(per[left]) - mean(per[right])
      const mark = stars(adjusted)
      row.push(`${formatNumber(diff)}${mark === 'ns' ? '' : ` ${mark}`}`)
    }
    matrix.push(row)
  }
  notes.push(adjust === 'bonferroni'
    ? `数值为均数差（左组 − 右组），星号为 Bonferroni 校正后的 P：*** <0.001，** <0.01，* <0.05；ns 不标注`
    : '数值为均数差（左组 − 右组），星号为未校正 P：*** <0.001，** <0.01，* <0.05；ns 不标注')
  notes.push('每对用 Welch t 检验，不要求方差齐；「—」表示该组不足 2 个个案')
  return { title: `两两比较矩阵（按 ${groupVariable.label || groupName} 分组）`, matrix, notes }
}

/**
 * Table 2: the selected outcome variables compared across the same groups —
 * the same grid minus the "overall" column, which is what a results table wants.
 */
export function buildCompareTable(dataset, options = {}) {
  const baseline = buildBaselineTable(dataset, options)
  const matrix = baseline.matrix.map((row, index) => (index === 0 ? row.filter((_, position) => position !== 1) : row.filter((_, position) => position !== 1)))
  return {
    title: `表 2　组间比较（按 ${dataset.variables.find((variable) => variable.name === options.group)?.label || options.group} 分组）`,
    matrix,
    notes: baseline.notes,
  }
}

/* ------------------------------------------------------------------ *
 * Pairwise comparisons                                               *
 * ------------------------------------------------------------------ */

/** The asterisk convention the charts use, so the two never disagree. */
function stars(p) {
  if (!Number.isFinite(p)) return ''
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return 'ns'
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return ''
  return value.toFixed(3)
}

/**
 * Every pair of groups for every numeric variable, tested with Welch's t (which
 * does not assume equal variances — the same choice table 1 makes) and
 * optionally Bonferroni adjusted over the pairs of that variable.
 *
 * Tables written by hand usually need exactly this: the group means, the
 * difference, and a p value that survives having looked at several pairs.
 */
export function buildPairwiseTable(dataset, options = {}) {
  const groupName = options.group
  if (!groupName) throw new Error('两两比较需要一个分组变量（group）')
  const { index: groupIndex, variable: groupVariable, keys, labels } = groupColumns(dataset, groupName)
  if (keys.length < 2) throw new Error(`分组变量 ${groupName} 至少要有两个取值`)
  // Multiple comparisons are the rule, not the exception: three groups already
  // give three pairs, and an unadjusted P written into a paper is a mistake the
  // reader cannot spot. Adjusting is the default; 'none' has to be asked for.
  const adjust = options.adjust === 'none' ? 'none' : 'bonferroni'
  const names = options.variables?.length
    ? options.variables
    : dataset.variables.map((variable) => variable.name).filter((name) => name !== groupName)
  if (names.length === 0) throw new Error('两两比较至少需要一个分析变量')

  const pairs = []
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) pairs.push([left, right])
  }

  const header = ['变量', '比较', '均数差', '标准误', 't', 'df', 'P', adjust === 'bonferroni' ? 'P（Bonferroni）' : 'P（未校正）', '95% CI（差）', "Cohen's d", "d 的 95% CI", '标记']
  const matrix = [header]
  const notes = []
  for (const name of names) {
    const variableIndex = dataset.variables.findIndex((variable) => variable.name === name)
    if (variableIndex < 0) throw new Error(`unknown variable: ${name}`)
    const variable = dataset.variables[variableIndex]
    if (!isNumeric(variable)) continue
    const label = variable.label || name
    const per = keys.map((key) => dataset.rows
      .filter((row) => String(rawValue(groupVariable, row[groupIndex]) ?? '') === key)
      .map((row) => rawValue(variable, row[variableIndex]))
      .filter((value) => value !== null))
    if (per.every((values) => values.length === 0)) {
      notes.push(`${label}：没有有效数据（已跳过）`)
      continue
    }
    let drawn = 0
    for (const [left, right] of pairs) {
      const test = welch(per[left], per[right])
      if (!test) continue
      drawn += 1
      const a = per[left]
      const b = per[right]
      const se = Math.sqrt((sd(a) ** 2) / a.length + (sd(b) ** 2) / b.length)
      const adjusted = adjust === 'bonferroni' ? Math.min(1, test.p * pairs.length) : test.p
      const diff = mean(a) - mean(b)
      // The interval a T-TEST prints: the difference plus/minus t(0.975, df)·SE,
      // with this pair's own Welch df rather than a pooled one.
      const critical = tCritical95(test.df)
      const interval = critical === null || !Number.isFinite(se)
        ? ''
        : `${formatNumber(diff - critical * se)} ~ ${formatNumber(diff + critical * se)}`
      matrix.push([
        label,
        `${labels[left]} vs ${labels[right]}`,
        formatNumber(diff),
        formatNumber(se),
        formatNumber(test.t),
        formatNumber(test.df),
        formatP(test.p),
        formatP(adjusted),
        interval,
        formatEffect(cohensD(a, b)),
        dInterval(cohensD(a, b), a.length, b.length),
        stars(adjusted),
      ])
    }
    if (drawn === 0) notes.push(`${label}：至少有一组不足 2 个个案，无法做两两比较`)
    else if (drawn < pairs.length) {
      notes.push(adjust === 'bonferroni'
        ? `${label}：${pairs.length - drawn} 对因某组不足 2 个个案没有比较（Bonferroni 乘数仍按计划比较 ${pairs.length} 对算）`
        : `${label}：${pairs.length - drawn} 对因某组不足 2 个个案没有比较`)
    }
  }
  if (adjust === 'bonferroni') {
    notes.push(`P（Bonferroni）= 原始 P × ${pairs.length}（同一变量的比较对数），上限 1；标记按校正后 P 判定`)
  }
  notes.push('两两比较用 Welch t 检验，不要求各组方差齐；df 是 Welch–Satterthwaite 自由度，95% CI 用该 df 算 t(0.975, df)；Cohen\'s d 用合并标准差，其区间用 Hedges & Olkin 大样本近似')
  notes.push('标记：*** <0.001，** <0.01，* <0.05，ns 无统计学意义')
  return { title: `两两比较（按 ${groupVariable.label || groupName} 分组）`, matrix, notes }
}

/* ------------------------------------------------------------------ *
 * Partial correlation                                                *
 * ------------------------------------------------------------------ */

/** A dataset cell as a number, or null when it is not one (missing included). */
function numericCell(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Pearson r of two equal-length arrays that are already free of missing values. */
function pearsonOf(left, right) {
  const n = left.length
  if (n < 3) return null
  const meanLeft = mean(left)
  const meanRight = mean(right)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let index = 0; index < n; index += 1) {
    const dx = left[index] - meanLeft
    const dy = right[index] - meanRight
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

/**
 * Solve a small dense system by Gaussian elimination with partial pivoting.
 * Returns null when the normal equations are singular — the caller reports that
 * as collinear controls, which is a different problem from "no variation".
 */
function solveLinear(matrix, vector) {
  const size = vector.length
  const rows = matrix.map((row, index) => [...row, vector[index]])
  // Pivots shrink with the scale of the matrix, so the cut-off has to scale
  // too: an absolute 1e-12 calls a perfectly conditioned 1e6-scale system
  // singular, and misses near-collinearity in a 1e-3-scale one.
  let scale = 1
  for (const row of matrix) {
    for (const value of row) scale = Math.max(scale, Math.abs(value))
  }
  const epsilon = 1e-10 * scale
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    }
    if (!(Math.abs(rows[pivot][column]) > epsilon)) return null
    if (pivot !== column) { const swap = rows[pivot]; rows[pivot] = rows[column]; rows[column] = swap }
    for (let row = column + 1; row < size; row += 1) {
      const factor = rows[row][column] / rows[column][column]
      if (factor === 0) continue
      for (let k = column; k <= size; k += 1) rows[row][k] -= factor * rows[column][k]
    }
  }
  const solution = new Array(size).fill(0)
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = rows[row][size]
    for (let column = row + 1; column < size; column += 1) sum -= rows[row][column] * solution[column]
    solution[row] = sum / rows[row][row]
  }
  return solution
}

/**
 * Regress one column on an intercept plus the control columns and return the
 * residuals. Partial correlation is the correlation of these residuals, which
 * stays correct for any number of controls (the closed-form two-variable
 * version does not generalise).
 */
function residualize(values, controls) {
  const size = controls.length + 1
  const normal = Array.from({ length: size }, () => new Array(size).fill(0))
  const rhs = new Array(size).fill(0)
  for (let row = 0; row < values.length; row += 1) {
    const design = [1, ...controls.map((column) => column[row])]
    for (let i = 0; i < size; i += 1) {
      rhs[i] += design[i] * values[row]
      for (let j = 0; j < size; j += 1) normal[i][j] += design[i] * design[j]
    }
  }
  const coefficients = solveLinear(normal, rhs)
  if (!coefficients) return null
  return values.map((value, row) => {
    const design = [1, ...controls.map((column) => column[row])]
    let fitted = 0
    for (let i = 0; i < size; i += 1) fitted += coefficients[i] * design[i]
    return value - fitted
  })
}

/**
 * Partial correlations, which PSPP does not implement (no PARTIAL CORR): the
 * plugin regresses both variables on the controls and correlates the residuals,
 * so the same numbers a reader would check by hand come out of the panel.
 */
export function buildPartialTable(dataset, options = {}) {
  const variables = (options.variables ?? []).filter(Boolean)
  const controls = (options.controls ?? []).filter(Boolean)
  if (variables.length < 2) throw new Error('偏相关至少需要两个分析变量')
  const byName = new Map(dataset.variables.map((variable, index) => [variable.name, { variable, index }]))
  for (const name of [...variables, ...controls]) {
    if (!byName.has(name)) throw new Error(`变量 ${name} 不在数据集里`)
    if (controls.includes(name) && variables.includes(name)) throw new Error(`变量 ${name} 不能同时是分析变量和控制变量`)
    const kind = byName.get(name).variable.type
    // A string variable has no numbers to correlate; saying "0 valid cases"
    // would look like the data is empty instead of the variable being wrong.
    if (kind && kind !== 'numeric') throw new Error(`偏相关只能用于数值变量：${name} 是${kind === 'string' ? '字符串' : kind}变量`)
  }
  const columns = [...variables, ...controls].map((name) => {
    const { index } = byName.get(name)
    return { name, values: dataset.rows.map((row) => numericCell(row[index])) }
  })
  const columnOf = new Map(columns.map((column) => [column.name, column]))
  const controlColumns = controls.map((name) => columnOf.get(name).values)
  const controlLabel = controls.length > 0
    ? controls.map((name) => byName.get(name).variable.label || name).join('、')
    : '（无）'
  const matrix = [['变量对', '控制变量', 'r', 'df', 'P', 'N', '标记']]
  const notes = []
  for (let left = 0; left < variables.length; left += 1) {
    for (let right = left + 1; right < variables.length; right += 1) {
      const x = columnOf.get(variables[left]).values
      const y = columnOf.get(variables[right]).values
      // Listwise deletion over the pair *and* the controls: a partial
      // correlation is only defined on cases that have all of them.
      const keep = []
      for (let row = 0; row < x.length; row += 1) {
        if (x[row] === null || y[row] === null) continue
        if (controlColumns.some((column) => column[row] === null)) continue
        keep.push(row)
      }
      const count = keep.length
      const usable = count - controls.length - 2
      const pairLabel = `${byName.get(variables[left]).variable.label || variables[left]} × ${byName.get(variables[right]).variable.label || variables[right]}`
      if (usable <= 0) {
        matrix.push([pairLabel, controlLabel, '—', '—', '—', String(count), ''])
        notes.push(`${pairLabel}：有效个案 ${count} 个，扣掉控制变量后自由度不足，算不出偏相关`)
        continue
      }
      const xs = keep.map((row) => x[row])
      const ys = keep.map((row) => y[row])
      const residualX = controls.length > 0 ? residualize(xs, controlColumns.map((column) => keep.map((row) => column[row]))) : xs
      const residualY = controls.length > 0 ? residualize(ys, controlColumns.map((column) => keep.map((row) => column[row]))) : ys
      // Singular normal equations mean the controls are collinear (or one of
      // them is a constant) — the residuals are not "flat", they do not exist.
      if (residualX === null || residualY === null) {
        throw new Error(`控制变量之间完全共线（或其中某个是常数），无法求残差：请删掉一个控制变量（当前控制：${controls.join('、')}）`)
      }
      const r = pearsonOf(residualX, residualY)
      if (r === null) {
        matrix.push([pairLabel, controlLabel, '—', '—', '—', String(count), ''])
        notes.push(`${pairLabel}：残差没有变异，算不出偏相关（控制变量把两个变量都解释完了）`)
        continue
      }
      const df = usable
      // |r| = 1 makes t infinite, and studentP refuses infinity: p is exactly 0
      // there, not "unknown", so a perfect correlation still gets its stars.
      const perfect = Math.abs(r) >= 1
      const t = perfect ? Infinity : r * Math.sqrt(df / (1 - r * r))
      const p = perfect ? 0 : studentP(t, df)
      matrix.push([
        pairLabel,
        controlLabel,
        formatNumber(r),
        String(df),
        p === null ? '—' : (p < 0.001 ? '.000' : formatNumber(p)),
        String(count),
        stars(p),
      ])
    }
  }
  notes.push(controls.length > 0
    ? '偏相关：把两个变量分别对控制变量做线性回归，再求两组残差的 Pearson 相关；P 来自 t = r·√(df/(1-r²))，df = 有效个案数 − 控制变量个数 − 2'
    : '没有指定控制变量，这里的 r 就是普通的 Pearson 相关；P 来自 t = r·√(df/(1-r²))，df = 有效个案数 − 2')
  notes.push('缺失按列表删除：只保留分析变量与控制变量都齐全的个案，所以 N 可能小于数据集的总个案数')
  notes.push('标记：*** <0.001，** <0.01，* <0.05，ns 无统计学意义')
  const title = controls.length > 0 ? `偏相关（控制：${controlLabel}）` : '相关（未控制其他变量）'
  return { title, matrix, notes }
}

/**
 * The same partial correlations as buildPartialTable, laid out as a matrix:
 * one row per variable, one column per partner, cell `r` with stars. This is
 * the shape a paper prints when several variables share one control set, and
 * it is what buildSignificanceMatrix does for group comparisons.
 */
export function buildPartialMatrix(dataset, options = {}) {
  const variables = (options.variables ?? []).filter(Boolean)
  const controls = (options.controls ?? []).filter(Boolean)
  if (variables.length < 2) throw new Error('偏相关至少需要两个分析变量')
  const byName = new Map(dataset.variables.map((variable, index) => [variable.name, { variable, index }]))
  for (const name of [...variables, ...controls]) {
    if (!byName.has(name)) throw new Error(`变量 ${name} 不在数据集里`)
    if (controls.includes(name) && variables.includes(name)) throw new Error(`变量 ${name} 不能同时是分析变量和控制变量`)
    const kind = byName.get(name).variable.type
    if (kind && kind !== 'numeric') throw new Error(`偏相关只能用于数值变量：${name} 是${kind === 'string' ? '字符串' : kind}变量`)
  }
  const columns = [...variables, ...controls].map((name) => {
    const { index } = byName.get(name)
    return { name, values: dataset.rows.map((row) => numericCell(row[index])) }
  })
  const valueOf = new Map(columns.map((column) => [column.name, column.values]))
  const controlColumns = controls.map((name) => valueOf.get(name))
  const controlLabel = controls.length > 0
    ? controls.map((name) => byName.get(name).variable.label || name).join('、')
    : '（无）'
  // One listwise deletion for the whole matrix, not one per cell: a matrix whose
  // cells are computed on different case sets looks comparable but is not.
  const keep = []
  for (let row = 0; row < dataset.rows.length; row += 1) {
    if (variables.some((name) => valueOf.get(name)[row] === null)) continue
    if (controlColumns.some((column) => column[row] === null)) continue
    keep.push(row)
  }
  const count = keep.length
  const df = count - controls.length - 2
  const label = (name) => byName.get(name).variable.label || name
  const matrix = [['', ...variables.map(label)]]
  const notes = []
  if (df <= 0) {
    for (const name of variables) matrix.push([label(name), ...variables.map(() => '—')])
    notes.push(`有效个案 ${count} 个，扣掉控制变量后自由度不足（df = ${df}），算不出任何偏相关`)
    notes.push('缺失按列表删除：只保留分析变量与控制变量都齐全的个案')
    return { title: controls.length > 0 ? `偏相关矩阵（控制：${controlLabel}）` : '相关矩阵', matrix, notes }
  }
  const residuals = new Map()
  for (const name of variables) {
    const values = keep.map((row) => valueOf.get(name)[row])
    const residual = controls.length > 0 ? residualize(values, controlColumns.map((column) => keep.map((row) => column[row]))) : values
    if (residual === null) {
      throw new Error(`控制变量之间完全共线（或其中某个是常数），无法求残差：请删掉一个控制变量（当前控制：${controls.join('、')}）`)
    }
    residuals.set(name, residual)
  }
  for (const left of variables) {
    const cells = [label(left)]
    for (const right of variables) {
      if (left === right) {
        cells.push('1')
        continue
      }
      const r = pearsonOf(residuals.get(left), residuals.get(right))
      if (r === null) {
        cells.push('—')
        continue
      }
      const perfect = Math.abs(r) >= 1
      const t = perfect ? Infinity : r * Math.sqrt(df / (1 - r * r))
      const p = perfect ? 0 : studentP(t, df)
      cells.push(`${formatNumber(r)}${stars(p) === 'ns' ? '' : stars(p)}`)
    }
    matrix.push(cells)
  }
  notes.push(controls.length > 0
    ? `偏相关：每个变量分别对控制变量做线性回归，再求两组残差的相关；df = ${count} − ${controls.length} − 2 = ${df}（N − 控制变量个数 − 2），对角线固定为 1`
    : `没有指定控制变量，这里的 r 就是普通的 Pearson 相关；df = ${count} − 2 = ${df}`)
  notes.push('缺失按列表删除：整张矩阵用同一批个案（分析变量与控制变量都齐全），所以矩阵内各行可比')
  notes.push('标记：*** <0.001，** <0.01，* <0.05，不标表示无统计学意义')
  const title = controls.length > 0 ? `偏相关矩阵（控制：${controlLabel}）` : '相关矩阵'
  return { title, matrix, notes }
}
