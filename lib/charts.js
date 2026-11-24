import { isUserMissing } from './missing.js'
/**
 * Chart models + a small SVG renderer.
 *
 * PSPP's own charts are fixed-style 640x480 PNGs (yellow bars, tiny labels),
 * which look nothing like SPSS. Since the panel already holds the whole
 * dataset in memory, the plugin computes the aggregates itself and renders a
 * clean SVG instead: crisp at any zoom, themeable, and exportable.
 */

const FONT = '"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif'

function escapeXml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function numeric(variable) {
  return variable?.type !== 'string'
}

function variableValue(variable, raw) {
  if (raw === null || raw === undefined || raw === '') return null
  // A 999 the user declared missing must not become a data point: the table
  // says the mean is 42 and the bar chart drew 360.
  if (isUserMissing(variable, raw)) return null
  if (numeric(variable)) {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
    return Number.isNaN(value) ? null : value
  }
  return String(raw)
}

function labelFor(variable, value) {
  const key = String(value)
  return variable?.valueLabels?.[key] ?? key
}

function column(dataset, name) {
  const index = (dataset?.variables ?? []).findIndex((variable) => variable.name === name)
  if (index < 0) throw new Error(`没有这个变量：${name}`)
  return index
}

function rowsOf(dataset) {
  const rows = dataset?.rows ?? []
  if (rows.length === 0) throw new Error('the dataset has no cases')
  return rows
}

function round(value, digits = 2) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

/** mean / sum / count of `variable`, grouped by `by`. */
/**
 * Two-sided 95% critical value of Student's t.
 *
 * Kept as a reference table for the values the tests pin down; the function
 * itself inverts the p-value, so fractional df (Welch) is exact too.
 */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042]

export function tCritical95(df) {
  const n = Number(df)
  if (!Number.isFinite(n) || n < 1) return null
  // Invert the two-sided p-value instead of rounding the df down: a Welch df of
  // 2.88 used to take t(0.975, 2)=4.303 and print a 95% CI about 25% too wide,
  // which is the difference between "inconclusive" and a usable interval.
  let low = 0
  let high = 200
  for (let step = 0; step < 80; step += 1) {
    const mid = (low + high) / 2
    const p = studentTwoSidedP(mid, n)
    if (!Number.isFinite(p)) return high
    if (p > 0.05) low = mid
    else high = mid
  }
  return (low + high) / 2
}

/**
 * Two-sided p-value of Student's t, via the regularised incomplete beta.
 *
 * Significance brackets need a p-value; a chart cannot call out to a library,
 * so this is the textbook continued fraction (Numerical Recipes 6.4).
 */
function betaContinuedFraction(a, b, x) {
  const tiny = 1e-30
  let qab = a + b
  let qap = a + 1
  let qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 200; m += 1) {
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
  const front = Math.exp(
    Math.log(x) * a + Math.log(1 - x) * b - logBeta(a, b),
  )
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

function logBeta(a, b) {
  const g = (z) => {
    // Lanczos approximation; 7 terms are plenty for the df range of a chart.
    const p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - g(1 - z)
    const zz = z - 1
    let sum = p[0]
    for (let i = 1; i < 9; i += 1) sum += p[i] / (zz + i)
    const t = zz + 7.5
    return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(sum)
  }
  return g(a) + g(b) - g(a + b)
}

export function studentTwoSidedP(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null
  return Math.min(1, Math.max(0, incompleteBeta(df / 2, 0.5, df / (df + t * t))))
}

/** Welch's t test: unequal variances, which is what a two-bar comparison needs. */
export function welchTest(left, right) {
  const a = left.filter((value) => Number.isFinite(value))
  const b = right.filter((value) => Number.isFinite(value))
  if (a.length < 2 || b.length < 2) return null
  const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length
  const variance = (list) => {
    const m = mean(list)
    return list.reduce((sum, value) => sum + (value - m) ** 2, 0) / (list.length - 1)
  }
  const va = variance(a) / a.length
  const vb = variance(b) / b.length
  const se = Math.sqrt(va + vb)
  // Same rule as lib/tables.js: three 0.1s have an sd of ~5e-17, so `se === 0`
  // never fires and identical constants came back as t=1.41, p=.29 — while two
  // different constants were reported as "no difference" (t=0, p=1).
  const spread = Math.max(1, Math.abs(mean(a)), Math.abs(mean(b)))
  if (se <= 1e-12 * spread) {
    return Math.abs(mean(a) - mean(b)) <= 1e-9 * spread
      ? { t: 0, df: a.length + b.length - 2, p: 1 }
      : null
  }
  const t = (mean(a) - mean(b)) / se
  const df = (va + vb) ** 2 / ((va ** 2) / (a.length - 1) + (vb ** 2) / (b.length - 1))
  return { t, df, p: studentTwoSidedP(t, df) }
}

/** Asterisks for the usual thresholds; `ns` stays visible so nothing is silent. */
export function significanceLabel(p) {
  if (!Number.isFinite(p)) return 'ns'
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return 'ns'
}

/** Normalise the errorBars option: false | 'sd' | 'se' | 'ci95'. */
export function errorBarMode(value) {
  if (value === true) return 'sd'
  const text = String(value ?? '').toLowerCase()
  if (text === 'se' || text === 'standard_error') return 'se'
  if (text === 'ci' || text === 'ci95' || text === 'ci95%' || text === '95ci') return 'ci95'
  if (text === 'sd' || text === 'std' || text === 'stddev') return 'sd'
  return false
}

/** How a whisker is labelled in the title and legend. */
export const ERROR_BAR_LABELS = { sd: '误差线 ±1 SD', se: '误差线 ±1 SE', ci95: '误差线 95% CI' }

export function computeBar(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const valueVariable = dataset.variables.find((variable) => variable.name === options.variable)
  if (!valueVariable) throw new Error(`没有这个变量：${options.variable}`)
  // A text variable can only be counted (see below).
  const countable = numeric(valueVariable)
  const valueIndex = column(dataset, options.variable)
  const byVariable = options.by ? dataset.variables.find((variable) => variable.name === options.by) : null
  if (options.by && !byVariable) throw new Error(`没有这个变量：${options.by}`)
  const byIndex = options.by ? column(dataset, options.by) : -1
  if (!countable && byIndex >= 0) {
    throw new Error('文本变量的条形图本身就是按它的取值分类的：不要另选类别轴，要分组请用「分组（并列）」')
  }
  const statistic = String(options.statistic ?? 'MEAN').toUpperCase()
  // A text variable can only be counted: SPSS lets you draw a bar chart of a
  // categorical variable, and the bar height is then the number of cases (or
  // the percentage of them), never a mean of nothing.
  if (!countable && statistic !== 'COUNT') {
    throw new Error(`${options.variable} 是文本变量，只能画「个案数」或「百分比」条形图：把统计量改成计次，或者换一个数值变量`)
  }

  // A clustered or stacked bar has two grouping variables: `cluster` splits the
  // bars along the category axis, `stack` splits each bar into segments.
  const clusterVariable = options.cluster ? dataset.variables.find((variable) => variable.name === options.cluster) : null
  if (options.cluster && !clusterVariable) throw new Error(`没有这个变量：${options.cluster}`)
  const stackVariable = options.stack ? dataset.variables.find((variable) => variable.name === options.stack) : null
  if (options.stack && !stackVariable) throw new Error(`没有这个变量：${options.stack}`)
  if (clusterVariable && stackVariable) throw new Error('一次只能有一个分组维度：要么按类别分组，要么堆叠')
  if (options.by && (options.by === options.cluster || options.by === options.stack)) {
    throw new Error('类别变量不能同时用作分组或堆叠变量')
  }
  if (options.cluster && options.cluster === options.stack) throw new Error('分组变量与堆叠变量不能是同一个')
  const clusterIndex = clusterVariable ? column(dataset, options.cluster) : -1
  const stackIndex = stackVariable ? column(dataset, options.stack) : -1

  const groups = new Map()
  for (const row of rows) {
    const value = variableValue(valueVariable, row[valueIndex])
    if (value === null) continue
    // Without a category axis, a counted text variable is its own axis: one bar
    // per distinct value (this is what SPSS draws for 图形 → 条形图 on a string).
    const key = byIndex >= 0
      ? variableValue(byVariable, row[byIndex])
      : countable ? '__all__' : variableValue(valueVariable, row[valueIndex])
    if (key === null) continue
    const cluster = clusterIndex >= 0 ? variableValue(clusterVariable, row[clusterIndex]) : null
    if (clusterIndex >= 0 && cluster === null) continue
    const stack = stackIndex >= 0 ? variableValue(stackVariable, row[stackIndex]) : null
    if (stackIndex >= 0 && stack === null) continue
    const bucketKey = `${key}\u0001${cluster ?? ''}\u0001${stack ?? ''}`
    const bucket = groups.get(bucketKey) ?? {
      values: [],
      count: 0,
      // The raw code decides the order: a labelled group variable must run
      // 对照组 → 低剂量组 → 高剂量组 by code, not by the label's pinyin.
      key: key,
      label: byIndex >= 0
        ? labelFor(byVariable, key)
        : countable ? '全部个案' : labelFor(valueVariable, key),
      cluster: cluster === null ? null : labelFor(clusterVariable, cluster),
      clusterKey: cluster === null ? null : String(cluster),
      stack: stack === null ? null : labelFor(stackVariable, stack),
      stackKey: stack === null ? null : String(stack),
    }
    // A counted text variable has no numeric value to summarise; one unit per
    // case keeps the shared mean/spread code harmless.
    bucket.values.push(countable ? value : 1)
    bucket.count += 1
    groups.set(bucketKey, bucket)
  }
  if (groups.size === 0) throw new Error('no valid cases for this chart')

  const summarize = ([, bucket]) => {
    const total = bucket.values.reduce((sum, value) => sum + value, 0)
    const mean = total / bucket.values.length
    // The standard deviation Google Sheets and SPSS both report for a
    // spreadsheet-style error bar: the sample estimate, n-1 in the denominator.
    const spread = bucket.values.length > 1
      ? Math.sqrt(bucket.values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (bucket.values.length - 1))
      : 0
    const value = statistic === 'COUNT'
      ? bucket.count
      : statistic === 'SUM' ? total : mean
    const entry = { label: bucket.label, value: round(value), count: bucket.count, sortKey: bucket.key }
    if (bucket.cluster !== null) {
      entry.cluster = bucket.cluster
      entry.clusterKey = bucket.clusterKey
    }
    if (bucket.stack !== null) {
      entry.stack = bucket.stack
      entry.stackKey = bucket.stackKey
    }
    const mode = errorBarMode(options.errorBars)
    if (mode && bucket.values.length > 1 && statistic !== 'COUNT') {
      const se = spread / Math.sqrt(bucket.values.length)
      entry.sd = round(spread)
      entry.se = round(se)
      // The whisker is stored as an interval so the renderer never has to know
      // which of the three forms the user asked for.
      const reach = mode === 'se' ? se : mode === 'ci95' ? (tCritical95(bucket.values.length - 1) ?? 1.96) * se : spread
      entry.errorLow = round(mean - reach)
      entry.errorHigh = round(mean + reach)
      entry.errorMode = mode
    }
    return entry
  }
  const compare = (left, right) => {
    const a = Number(left.sortKey)
    const b = Number(right.sortKey)
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b
    return compareLabels(left.sortKey ?? left.label, right.sortKey ?? right.label)
  }
  const categories = [...groups.entries()].map(summarize).sort(compare)

  // 「百分比」条形图：分母是这个变量上的有效个案数（缺失不计），每根柱换成占比。
  const percentWanted = options.percent === true && statistic === 'COUNT'
  if (percentWanted) {
    const total = categories.reduce((sum, entry) => sum + entry.count, 0)
    for (const entry of categories) {
      entry.value = total > 0 ? Math.round((entry.count / total) * 1000) / 10 : 0
    }
  }

  // Raw cases per category, kept only when someone asked for significance:
  // the bracket needs the two groups' values, not just their means.
  const rawByLabel = new Map()
  if (options.significance) {
    for (const [, bucket] of groups) {
      rawByLabel.set(bucket.label, [...(rawByLabel.get(bucket.label) ?? []), ...bucket.values])
    }
  }
  const significance = buildSignificance(options.significance, categories, rawByLabel)

  const valueName = valueVariable.label || options.variable
  const byName = byVariable ? (byVariable.label || options.by) : ''
  const clusterName = clusterVariable ? (clusterVariable.label || options.cluster) : ''
  const stackName = stackVariable ? (stackVariable.label || options.stack) : ''
  const series = clusterVariable
    ? [...new Set(categories.map((entry) => entry.clusterKey))]
      .sort()
      .map((key) => ({ key, label: categories.find((entry) => entry.clusterKey === key)?.cluster ?? key }))
    : stackVariable
      ? [...new Set(categories.map((entry) => entry.stackKey))]
        .sort()
        .map((key) => ({ key, label: categories.find((entry) => entry.stackKey === key)?.stack ?? key }))
      : null
  const shape = clusterVariable ? 'clustered' : stackVariable ? (options.shape === 'stacked100' ? 'stacked100' : 'stacked') : 'simple'
  const barMode = errorBarMode(options.errorBars)
  return {
    kind: 'bar',
    shape,
    series,
    errorBars: categories.some((entry) => entry.errorLow !== undefined) ? barMode : false,
    errorBarLabel: categories.some((entry) => entry.errorLow !== undefined) ? ERROR_BAR_LABELS[barMode] : null,
    groupLabel: clusterName || stackName,
    title: `${byVariable ? `${valueName} 按 ${byName}` : countable ? valueName : `${valueName} 的分布`}${
      clusterVariable ? `，分组：${clusterName}` : stackVariable ? `，堆叠：${stackName}` : ''
    }（${percentWanted ? '百分比' : statistic === 'COUNT' ? '个案数' : statistic === 'SUM' ? '总和' : '均值'}${
      categories.some((entry) => entry.errorLow !== undefined) ? `，${ERROR_BAR_LABELS[barMode]}` : ''
    }）`,
    xLabel: byName,
    yLabel: percentWanted ? '百分比（%）' : statistic === 'COUNT' ? '个案数' : statistic === 'SUM' ? '总和' : '均值',
    categories,
    significance,
  }
}

/**
 * Turn the significance option into bracketed pairs.
 *
 * `true`/`'auto'` compares every pair of categories with Welch's t test;
 * an array of `{from, to, label}` draws exactly the brackets the caller names.
 * Only simple mean bars get brackets: a stacked or clustered bar has no single
 * pair of group means to compare.
 */
function buildSignificance(option, categories, rawByLabel) {
  if (!option) return []
  if (categories.length < 2) throw new Error('显著性标注至少需要两个类别')
  const labels = categories.map((entry) => entry.label)
  let pairs
  if (option === true || option === 'auto') {
    pairs = []
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) pairs.push({ from: labels[i], to: labels[j] })
    }
  } else if (Array.isArray(option)) {
    pairs = option.map((entry) => ({
      from: String(entry?.from ?? ''),
      to: String(entry?.to ?? ''),
      label: entry?.label,
    }))
  } else {
    throw new Error('significance 只接受 true（自动两两比较）或 [{from, to, label}]')
  }
  // The tables correct every pairwise test (Bonferroni is the default in
  // lib/tables.js), so a chart that reports the raw p would contradict the
  // table it sits next to: same pair, '*' over the bars and 'ns' in the table.
  const comparisons = pairs.length
  const brackets = []
  for (const pair of pairs) {
    const i = labels.indexOf(pair.from)
    const j = labels.indexOf(pair.to)
    if (i < 0 || j < 0) throw new Error(`显著性标注里的类别不存在：${i < 0 ? pair.from : pair.to}`)
    const test = welchTest(rawByLabel.get(pair.from) ?? [], rawByLabel.get(pair.to) ?? [])
    const raw = test?.p ?? null
    const adjusted = pair.label === undefined && raw !== null ? Math.min(1, raw * comparisons) : raw
    brackets.push({
      from: pair.from,
      to: pair.to,
      fromIndex: Math.min(i, j),
      toIndex: Math.max(i, j),
      label: pair.label ?? significanceLabel(adjusted),
      p: adjusted,
      pRaw: raw,
      t: test?.t ?? null,
      df: test?.df ?? null,
    })
  }
  // Stack the brackets: each one sits a row above any bracket it overlaps.
  brackets.sort((left, right) => (left.toIndex - left.fromIndex) - (right.toIndex - right.fromIndex))
  const levels = []
  for (const bracket of brackets) {
    let level = 0
    while ((levels[level] ?? []).some((other) => !(bracket.toIndex < other.fromIndex || bracket.fromIndex > other.toIndex))) {
      level += 1
    }
    levels[level] = [...(levels[level] ?? []), bracket]
    bracket.level = level
  }
  return brackets
}

/** Equal-width histogram of a numeric variable. */
export function computeHistogram(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const variable = dataset.variables.find((entry) => entry.name === options.variable)
  if (!variable) throw new Error(`没有这个变量：${options.variable}`)
  if (!numeric(variable)) throw new Error(`${options.variable} must be numeric`)
  const index = column(dataset, options.variable)
  const values = []
  for (const row of rows) {
    const value = variableValue(variable, row[index])
    if (value !== null) values.push(value)
  }
  if (values.length === 0) throw new Error('no valid cases for this chart')

  const min = Math.min(...values)
  const max = Math.max(...values)
  const requested = Number(options.bins)
  const bins = Number.isFinite(requested) && requested > 0
    ? Math.min(40, Math.max(2, Math.round(requested)))
    : Math.min(30, Math.max(5, Math.ceil(Math.log2(values.length) + 1)))
  const width = (max - min) / bins || 1
  const counts = new Array(bins).fill(0)
  for (const value of values) {
    const slot = Math.min(bins - 1, Math.max(0, Math.floor((value - min) / width)))
    counts[slot] += 1
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)
  const sd = Math.sqrt(variance)
  // Overlay the normal curve at the same area scale as the bars: expected
  // cases per bin = n * binWidth * density(midpoint).
  const normal = sd > 0
    ? {
      mean: round(mean, 3),
      sd: round(sd, 3),
      points: counts.map((count, slot) => {
        const x = min + (slot + 0.5) * width
        const density = Math.exp(-((x - mean) ** 2) / (2 * variance)) / (sd * Math.sqrt(2 * Math.PI))
        return { x: round(x, 3), expected: round(density * values.length * width, 3) }
      }),
    }
    : null
  return {
    kind: 'histogram',
    title: `${variable.label || options.variable} 的直方图`,
    xLabel: variable.label || options.variable,
    yLabel: '频数',
    bins: counts.map((count, slot) => ({
      start: round(min + slot * width, 3),
      end: round(min + (slot + 1) * width, 3),
      count,
    })),
    normal,
    total: values.length,
  }
}

/** Scatterplot, sampled to keep the SVG small. */
export function computeScatter(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const xVariable = dataset.variables.find((variable) => variable.name === options.x)
  const yVariable = dataset.variables.find((variable) => variable.name === options.y)
  if (!xVariable) throw new Error(`没有这个变量：${options.x}`)
  if (!yVariable) throw new Error(`没有这个变量：${options.y}`)
  if (!numeric(xVariable) || !numeric(yVariable)) throw new Error('scatterplot needs two numeric variables')
  const xi = column(dataset, options.x)
  const yi = column(dataset, options.y)
  // A third variable splits the same scatter into one colour per category,
  // which is what SPSS calls "set colour by" in Chart Builder. Without it the
  // picture is a single cloud.
  const groupVariable = options.group
    ? dataset.variables.find((variable) => variable.name === options.group)
    : null
  if (options.group && !groupVariable) throw new Error(`没有这个变量：${options.group}`)
  const gi = groupVariable ? column(dataset, options.group) : -1
  const points = []
  const series = new Map()
  for (const row of rows) {
    const x = variableValue(xVariable, row[xi])
    const y = variableValue(yVariable, row[yi])
    if (x === null || y === null) continue
    points.push([x, y])
    if (!groupVariable) continue
    const raw = row[gi]
    const label = raw === null || raw === undefined || raw === ''
      ? '（缺失）'
      : labelFor(groupVariable, variableValue(groupVariable, raw))
    if (!series.has(label)) series.set(label, [])
    series.get(label).push([x, y])
  }
  if (points.length === 0) throw new Error('no valid cases for this chart')
  const limit = 1500
  const step = Math.ceil(points.length / limit)
  const sampled = step > 1 ? points.filter((_, index) => index % step === 0) : points
  const model = {
    kind: 'scatter',
    title: `${yVariable.label || options.y} 与 ${xVariable.label || options.x} 的散点图`,
    xLabel: xVariable.label || options.x,
    yLabel: yVariable.label || options.y,
    points: sampled.map(([x, y]) => [round(x, 4), round(y, 4)]),
    total: points.length,
  }
  // A trend line is the one thing SPSS's chart editor adds to a scatter that
  // the panel could not do; PSPP itself draws no regression line either.
  if (options.fit === true || String(options.fit).toLowerCase() === 'linear') {
    const buckets = groupVariable
      ? [...series.entries()].sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'zh')).map(([label, rows]) => ({ label, points: rows }))
      : [{ label: null, points }]
    // 先按未取整的结果判断有没有斜率：round(null) 会变成 0，看着像一条
    // 水平线，其实这个变量根本不变。
    model.fits = buckets
      .map((entry) => ({ label: entry.label, fitLine: linearFit(entry.points) }))
      .filter((entry) => Number.isFinite(entry.fitLine.slope))
      .map((entry) => ({
        label: entry.label,
        slope: round(entry.fitLine.slope, 6),
        intercept: round(entry.fitLine.intercept, 6),
        r2: round(entry.fitLine.r2, 4),
      }))
    if (model.fits.length === 0) delete model.fits
  }
  if (groupVariable) {
    // The axis range must cover every series, so the sampled combined points
    // stay on the model and the series only drive drawing and the legend.
    const names = [...series.keys()].sort((left, right) => String(left).localeCompare(String(right), 'zh'))
    model.group = options.group
    model.groupLabel = groupVariable.label || options.group
    model.series = names.map((label) => ({
      label,
      points: (series.get(label) ?? []).slice(0, limit).map(([x, y]) => [round(x, 4), round(y, 4)]),
    }))
    model.title = `${yVariable.label || options.y} 与 ${xVariable.label || options.x} 的散点图（按${groupVariable.label || options.group}着色）`
  }
  return model
}

// 把 y = a + b·x 裁到绘图区里：斜率很陡时直接连两个端点会把线画到框外。
function fitSegment(slope, intercept, xMin, xMax, yMin, yMax) {
  if (Math.abs(slope) < 1e-12) {
    const y = intercept
    return y >= yMin && y <= yMax ? [xMin, xMax] : null
  }
  const xAtYMin = (yMin - intercept) / slope
  const xAtYMax = (yMax - intercept) / slope
  const low = Math.max(xMin, Math.min(xAtYMin, xAtYMax))
  const high = Math.min(xMax, Math.max(xAtYMin, xAtYMax))
  return high > low ? [low, high] : null
}

const WIDTH = 560
const HEIGHT = 360

function ticksFor(min, max, count = 5) {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [min]
  const rough = (max - min) / count
  if (!(rough > 0) || !Number.isFinite(rough)) return [min, max]
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  const start = Math.floor(min / step) * step
  const ticks = []
  // `value += step` stops advancing once step is below the float's precision
  // at that magnitude (>= 1e17), which used to loop until the array length
  // overflowed and pinned a core for seconds. Bail out on both conditions.
  for (let value = start; value <= max + step / 2; value += step) {
    if (ticks.length > 1000) break
    const next = value + step
    if (next === value) { ticks.push(round(value, 3)); break }
    ticks.push(round(value, 3))
  }
  return ticks
}

/**
 * Category labels are often numeric codes (1..12 months, question numbers).
 * A plain localeCompare turns those into 1, 10, 11, 12, 2, 3 — a bar chart
 * that shows a trend which does not exist. Compare numerically when both
 * labels are numbers, and fall back to the collator otherwise.
 */
function compareLabels(left, right) {
  const a = String(left)
  const b = String(right)
  const na = Number(a)
  const nb = Number(b)
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b, 'zh-CN')
}

function formatNumber(value) {
  if (Math.abs(value) >= 10000) return value.toExponential(1)
  const rounded = round(value, 2)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function clipLabel(text, max = 10) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const weight = position - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

/**
 * Tukey's hinges: the median of each half, and for an odd number of cases the
 * median itself belongs to BOTH halves. Verified against the bundled engine's
 * `EXAMINE /PLOT=BOXPLOT`: 1..8 gives 2.50 / 4.50 / 6.50, 1..5 gives
 * 2.00 / 3.00 / 4.00, 1..7 gives 2.50 / 4.00 / 5.50. (FREQUENCIES
 * /PERCENTILES is a different definition: 2.75 / 4.5 / 6.25 for 1..8.)
 */
function hinges(sorted) {
  const count = sorted.length
  const median = quantile(sorted, 0.5)
  if (count < 2) return { q1: median, q3: median }
  const half = Math.ceil(count / 2)
  const lower = sorted.slice(0, half)
  const upper = sorted.slice(count - half)
  return { q1: quantile(lower, 0.5), q3: quantile(upper, 0.5) }
}

/** Five-number summary per group (optionally split by `by`). */
export function computeBox(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const valueVariable = dataset.variables.find((variable) => variable.name === options.variable)
  if (!valueVariable) throw new Error(`没有这个变量：${options.variable}`)
  if (!numeric(valueVariable)) throw new Error(`${options.variable} must be numeric`)
  const valueIndex = column(dataset, options.variable)
  const byVariable = options.by ? dataset.variables.find((variable) => variable.name === options.by) : null
  if (options.by && !byVariable) throw new Error(`没有这个变量：${options.by}`)
  const byIndex = options.by ? column(dataset, options.by) : -1

  const groups = new Map()
  for (const row of rows) {
    const value = variableValue(valueVariable, row[valueIndex])
    if (value === null) continue
    const key = byIndex >= 0 ? variableValue(byVariable, row[byIndex]) : '__all__'
    if (key === null) continue
    const bucket = groups.get(key) ?? { values: [], label: byIndex >= 0 ? labelFor(byVariable, key) : '全部个案' }
    bucket.values.push(value)
    groups.set(key, bucket)
  }
  if (groups.size === 0) throw new Error('no valid cases for this chart')

  const summary = [...groups.entries()].map(([, bucket]) => {
    const sorted = [...bucket.values].sort((left, right) => left - right)
    const median = quantile(sorted, 0.5)
    const { q1, q3 } = hinges(sorted)
    const iqr = q3 - q1
    const lowFence = q1 - 1.5 * iqr
    const highFence = q3 + 1.5 * iqr
    const inside = sorted.filter((value) => value >= lowFence && value <= highFence)
    return {
      label: bucket.label,
      count: sorted.length,
      min: round(inside.length > 0 ? inside[0] : sorted[0]),
      q1: round(q1),
      median: round(median),
      q3: round(q3),
      max: round(inside.length > 0 ? inside[inside.length - 1] : sorted[sorted.length - 1]),
      outliers: sorted.filter((value) => value < lowFence || value > highFence).slice(0, 60).map((value) => round(value)),
    }
  }).sort((left, right) => compareLabels(left.label, right.label))

  const valueName = valueVariable.label || options.variable
  const byName = byVariable ? (byVariable.label || options.by) : ''
  return {
    kind: 'boxplot',
    title: byVariable ? `${valueName} 按 ${byName} 的箱线图` : `${valueName} 的箱线图`,
    xLabel: byName,
    yLabel: valueName,
    groups: summary,
  }
}

/** Mean (or count/sum) of `variable` per category, drawn as a line chart. */
export function computeLine(dataset, options = {}) {
  const model = computeBar(dataset, { ...options, statistic: options.statistic ?? 'MEAN' })
  const numericKey = /^-?\d+(\.\d+)?$/
  const order = (left, right) => {
    if (numericKey.test(String(left)) && numericKey.test(String(right))) return Number(left) - Number(right)
    return compareLabels(left, right)
  }
  const points = [...model.categories]
    .sort((left, right) => order(left.label, right.label))
    .map((entry) => ({ label: entry.label, value: entry.value }))
  // A second variable turns one trend into several: each of its values gets its
  // own polyline over the same category axis, which is what SPSS calls a
  // "line chart with lines represent = 变量".
  let series = null
  const labels = [...new Set(model.categories.map((entry) => entry.label))].sort(order)
  if (model.series && model.series.length > 1) {
    const groupKey = options.cluster ? 'clusterKey' : 'stackKey'
    series = model.series.map((entry) => ({
      key: entry.key,
      label: entry.label,
      points: labels.map((label) => {
        const hit = model.categories.find((candidate) => candidate.label === label && candidate[groupKey] === entry.key)
        return { label, value: hit ? hit.value : null }
      }),
    }))
  }
  const lineMode = errorBarMode(options.errorBars)
  const withBars = Boolean(lineMode) && !series && model.categories.some((entry) => entry.errorLow !== undefined || entry.sd !== undefined)
  return {
    kind: 'line',
    errorBars: withBars,
    errorBarLabel: withBars ? ERROR_BAR_LABELS[lineMode] : null,
    // The bar model already names the grouping variable by its label; reuse it
    // so a split line chart reads "按 组别，分组：性别" like SPSS does.
    title: `${model.title.replace(/（.*）$/, '')} 趋势`,
    xLabel: model.xLabel,
    yLabel: model.yLabel,
    labels: series ? labels : points.map((point) => point.label),
    series,
    points: series
      ? []
      : points.map((entry) => {
        const source = model.categories.find((candidate) => candidate.label === entry.label)
        if (!withBars) return { label: entry.label, value: entry.value }
        return {
          label: entry.label,
          value: entry.value,
          sd: source?.sd,
          errorLow: source?.errorLow,
          errorHigh: source?.errorHigh,
        }
      }),
  }
}

/**
 * Two lines on two y axes.
 *
 * Counts and concentrations on the same chart (a common figure in papers) need
 * each series read against its own scale; sharing one axis makes the flatter
 * series look dead.
 */
export function computeDualLine(dataset, options = {}) {
  if (!options.y2) throw new Error('双 Y 轴折线图需要第二个变量（y2）')
  const label = (name) => dataset.variables.find((entry) => entry.name === name)?.label || name
  const primary = computeLine(dataset, { ...options, variable: options.variable, errorBars: false })
  const secondary = computeLine(dataset, { ...options, variable: options.y2, errorBars: false })
  const labels = primary.labels
  const align = (model) => labels.map((entry) => model.points.find((point) => String(point.label) === String(entry))?.value ?? null)
  const leftValues = align(primary).filter((value) => value !== null)
  const rightValues = align(secondary).filter((value) => value !== null)
  if (leftValues.length === 0 || rightValues.length === 0) throw new Error('双 Y 轴折线图的两个变量都没有有效数据')
  return {
    kind: 'line2',
    title: `${label(options.variable)} 与 ${label(options.y2)} 趋势（双 Y 轴）`,
    xLabel: primary.xLabel,
    labels,
    axes: [
      { side: 'left', series: { key: options.variable, label: label(options.variable), values: align(primary) } },
      { side: 'right', series: { key: options.y2, label: label(options.y2), values: align(secondary) } },
    ],
  }
}

/** Category counts as a pie chart. */
export function computePie(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const variable = dataset.variables.find((entry) => entry.name === options.variable)
  if (!variable) throw new Error(`没有这个变量：${options.variable}`)
  const index = column(dataset, options.variable)
  const buckets = new Map()
  for (const row of rows) {
    const value = variableValue(variable, row[index])
    if (value === null) continue
    const key = String(value)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  if (buckets.size === 0) throw new Error('no valid cases for this chart')
  const slices = [...buckets.entries()]
    .map(([key, count]) => ({ label: labelFor(variable, key), value: count }))
    .sort((left, right) => compareLabels(left.label, right.label))
  const name = variable.label || options.variable
  return {
    kind: 'pie',
    // The shape is part of the model: an export or a re-render has to know a
    // ring from a disc without being handed the original options again.
    donut: options.donut === true,
    title: `${name} 的构成${options.donut === true ? '（环形）' : ''}`,
    xLabel: '',
    yLabel: '',
    slices,
  }
}

/** Render a chart model to a standalone SVG document. */
/**
 * Draw a plain, clustered or stacked bar chart.
 *
 * The three shapes share one pass: a row of slots along the category axis, then
 * either one bar, several side-by-side bars, or several segments per slot.
 * Error bars are drawn last so they sit on top of the fill.
 */
function renderBar(model, plot, axisValue, accent) {
  const parts = []
  const shape = model.shape ?? 'simple'
  // A percentage stack has the same geometry as a plain stack; only the height
  // of each segment differs (share of its own bar instead of the raw value).
  const stacked = shape === 'stacked' || shape === 'stacked100'
  const series = model.series ?? []
  const byLabel = new Map()
  for (const entry of model.categories) {
    const key = shape === 'clustered' ? entry.clusterKey : stacked ? entry.stackKey : '__all__'
    const bucket = byLabel.get(entry.label) ?? new Map()
    bucket.set(key ?? '__all__', entry)
    byLabel.set(entry.label, bucket)
  }
  const labels = [...byLabel.keys()].sort(compareLabels)
  const keys = series.length ? series.map((entry) => entry.key) : ['__all__']
  // Stacked segments add up, clustered bars and error bars push the axis out.
  let topValue = 0
  let bottomValue = 0
  for (const label of labels) {
    const bucket = byLabel.get(label)
    if (shape === 'stacked100') {
      // Every bar is full height by definition.
      topValue = 100
    } else if (stacked) {
      const positive = keys.reduce((sum, key) => sum + Math.max(0, bucket.get(key)?.value ?? 0), 0)
      const negative = keys.reduce((sum, key) => sum + Math.min(0, bucket.get(key)?.value ?? 0), 0)
      topValue = Math.max(topValue, positive)
      bottomValue = Math.min(bottomValue, negative)
    } else {
      for (const key of keys) {
        const entry = bucket.get(key)
        if (!entry) continue
        const low = entry.errorLow ?? (entry.value - (Number(entry.sd ?? entry.se ?? 0) || 0))
        const high = entry.errorHigh ?? (entry.value + (Number(entry.sd ?? entry.se ?? 0) || 0))
        topValue = Math.max(topValue, high)
        bottomValue = Math.min(bottomValue, low)
      }
    }
  }
  // Brackets sit above the bars, so give them room instead of drawing over the
  // tallest whisker.
  const headroom = model.significance?.length ? 0.16 + 0.06 * Math.max(...model.significance.map((entry) => entry.level ?? 0)) : 0
  const padding = shape === 'stacked100' ? 0 : (topValue - bottomValue) * (0.08 + headroom) || 1
  const max = topValue + padding
  const min = bottomValue < 0 ? bottomValue - padding : 0
  const { scale } = axisValue(model, min, max)
  const slot = plot.width / labels.length
  const barWidth = Math.min(shape === 'simple' ? 64 : 48, (slot * 0.62) / keys.length)
  const palette = [accent ?? '#7aa9dd', '#e8a33d', '#6bbf8a', '#b57edc', '#e07b7b', '#7fb2d8']
  const strokeFor = (index) => (palette[index % palette.length] === accent ? (accent ?? '#3f6f9f') : ['#3f6f9f', '#b07319', '#3d8a5c', '#7b4fa0', '#a84747'][index % 5])
  const geometry = new Map()
  labels.forEach((label, index) => {
    const center = plot.x + slot * index + slot / 2
    const bucket = byLabel.get(label)
    const groupWidth = barWidth * keys.length
    // A stacked segment starts where the previous one ended, measured in data
    // units, so positive segments grow up from zero and negative ones down.
    let stackRun = 0
    // The denominator of a percentage bar: the sum of its own segments, so
    // every bar is normalised separately (that is what "100%" means here).
    const barTotal = shape === 'stacked100'
      ? keys.reduce((sum, key) => sum + Math.abs(bucket.get(key)?.value ?? 0), 0) || 1
      : 1
    const zero = scale(0)
    keys.forEach((key, seriesIndex) => {
      const entry = bucket.get(key)
      if (!entry) return
      let x
      let y
      let height
      if (stacked) {
        const from = scale(stackRun)
        // In a percentage stack the running total counts shares, so each bar
        // ends at exactly 100 whatever its raw totals were.
        stackRun += shape === 'stacked100' ? (Math.abs(entry.value) / barTotal) * 100 : entry.value
        const to = scale(stackRun)
        y = Math.min(from, to)
        height = Math.max(1, Math.abs(to - from))
        x = center - barWidth / 2
      } else {
        x = center - groupWidth / 2 + barWidth * seriesIndex
        y = Math.min(scale(entry.value), zero)
        height = Math.max(1, Math.abs(zero - scale(entry.value)))
      }
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" fill="${palette[seriesIndex % palette.length]}" stroke="${strokeFor(seriesIndex)}" stroke-width="1"/>`)
      if (shape !== 'stacked' && !model.errorBars && bucket.size <= 1) {
        parts.push(`<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#24405f">${escapeXml(formatNumber(entry.value))}</text>`)
      }
      if (model.errorBars && (entry.errorLow !== undefined || entry.sd !== undefined)) {
        // Older models only carry `sd`; prefer the interval when it is there so
        // SE and 95% CI whiskers are not silently drawn as ±1 SD.
        const lowValue = entry.errorLow ?? (entry.value - (Number(entry.sd) || 0))
        const highValue = entry.errorHigh ?? (entry.value + (Number(entry.sd) || 0))
        const high = scale(highValue)
        const low = scale(lowValue)
        const cx = (x + barWidth / 2).toFixed(1)
        parts.push(`<line x1="${cx}" y1="${high.toFixed(1)}" x2="${cx}" y2="${low.toFixed(1)}" stroke="#24405f" stroke-width="1"/>`)
        for (const edge of [high, low]) {
          parts.push(`<line x1="${(x + barWidth * 0.2).toFixed(1)}" y1="${edge.toFixed(1)}" x2="${(x + barWidth * 0.8).toFixed(1)}" y2="${edge.toFixed(1)}" stroke="#24405f" stroke-width="1"/>`)
        }
      }
    })
    const topEntry = [...bucket.values()].reduce((best, entry) => {
      const top = entry.errorHigh ?? entry.value
      return best === null || top > best ? top : best
    }, null)
    geometry.set(label, { center, top: topEntry === null ? plot.y + plot.height : scale(topEntry) })
    parts.push(`<text x="${center.toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(label))}</text>`)
  })
  // Brackets live above the tallest bar of the pair they connect, stacked so
  // two overlapping comparisons never share a line.
  if (model.significance?.length) {
    const topMost = Math.min(...[...geometry.values()].map((entry) => entry.top), plot.y + plot.height)
    const step = 18
    for (const bracket of model.significance) {
      const left = geometry.get(bracket.from)
      const right = geometry.get(bracket.to)
      if (!left || !right) continue
      const highest = Math.min(left.top, right.top)
      const y = Math.max(plot.y + 6, Math.min(highest - 16, topMost - 12) - bracket.level * step)
      const x1 = left.center
      const x2 = right.center
      parts.push(`<path d="M${x1.toFixed(1)} ${(y + 6).toFixed(1)} L${x1.toFixed(1)} ${y.toFixed(1)} L${x2.toFixed(1)} ${y.toFixed(1)} L${x2.toFixed(1)} ${(y + 6).toFixed(1)}" fill="none" stroke="#333" stroke-width="1"/>`)
      parts.push(`<text x="${((x1 + x2) / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#1a3a63">${escapeXml(bracket.label)}</text>`)
    }
  }
  parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333" stroke-width="1"/>`)
  parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333" stroke-width="1"/>`)
  // A legend only earns its space when there is more than one series.
  if (series.length > 1) {
    let x = plot.x
    const y = plot.y - 14
    series.forEach((entry, index) => {
      parts.push(`<rect x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" width="10" height="10" fill="${palette[index % palette.length]}" stroke="${strokeFor(index)}" stroke-width="1"/>`)
      parts.push(`<text x="${(x + 14).toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="#444">${escapeXml(clipLabel(entry.label, 12))}</text>`)
      x += 24 + String(entry.label).length * 6
    })
  }
  return parts
}

/**
 * A dendrogram: leaves along the bottom, every merge a right-angle U whose top
 * sits at the merge coefficient. Case numbers are printed while they fit.
 */
function renderDendrogram(model, { parts, plot, height }) {
  const root = model.root
  const leaves = Math.max(1, model.leaves)
  if (!root) return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"></svg>`
  const step = leaves > 1 ? plot.width / (leaves - 1) : 0
  const top = model.maxHeight > 0 ? model.maxHeight : 1
  const xOf = (node) => plot.x + (leaves > 1 ? node.x * step : plot.width / 2)
  const yOf = (value) => plot.y + plot.height - (Math.max(value, 0) / top) * plot.height

  // Axis: the merge coefficient, from zero at the bottom to the last merge on top.
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top]
  for (const tick of ticks) {
    const y = yOf(tick)
    parts.push(`<line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8ebf0" stroke-width="1"/>`)
    parts.push(`<text x="${(plot.x - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#555">${formatNumber(tick)}</text>`)
  }

  const walk = (node, depth) => {
    if (!node.children.length) {
      if (leaves <= (model.maxLeafLabels ?? 40)) {
        const label = model.labels?.[node.x] ?? String(node.x + 1)
        parts.push(`<text x="${xOf(node).toFixed(1)}" y="${(plot.y + plot.height + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="#5a6b82">${escapeXml(label)}</text>`)
      }
      return
    }
    const y = yOf(node.height)
    const [left, right] = node.children
    // The two vertical stems come up from the children's own merge heights.
    for (const child of [left, right]) {
      parts.push(`<line x1="${xOf(child).toFixed(1)}" y1="${yOf(child.height).toFixed(1)}" x2="${xOf(child).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2f6db8" stroke-width="1.4"/>`)
    }
    parts.push(`<line x1="${xOf(left).toFixed(1)}" y1="${y.toFixed(1)}" x2="${xOf(right).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2f6db8" stroke-width="1.4"/>`)
    walk(left, depth + 1)
    walk(right, depth + 1)
  }
  walk(root, 0)
  // The horizontal axis label explains what the leaves are.
  parts.push(`<text x="${(plot.x + plot.width / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="10" fill="#5a6b82">${escapeXml(model.xLabel ?? '个案')}</text>`)
  parts.push(`<text x="14" y="${(plot.y + plot.height / 2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 14 ${(plot.y + plot.height / 2).toFixed(1)})" font-size="10" fill="#5a6b82">${escapeXml(model.yLabel ?? '合并距离')}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">${parts.join('')}</svg>`
}

export function renderSvg(model) {
  // The control chart stacks two panels (means over ranges), so it needs more
  // vertical room than a single-plot figure.
  // A survival figure also prints the median survival under the axis, which
  // needs one more text line than the other single-plot kinds.
  const height = model.kind === 'control' ? 480 : model.kind === 'km' ? 378 : HEIGHT
  // A right-hand axis needs room for its own tick labels.
  const margin = { left: 56, right: model.kind === 'line2' ? 56 : 18, top: 40, bottom: 48 }
  const plot = {
    x: margin.left,
    y: margin.top,
    width: WIDTH - margin.left - margin.right,
    height: HEIGHT - margin.top - margin.bottom,
  }
  const parts = []
  const accent = model.accent ?? null

  const axisValue = (model, min, max) => {
    const ticks = ticksFor(min, max)
    const scale = (value) => {
      if (max === min) return plot.y + plot.height / 2
      return plot.y + plot.height - ((value - min) / (max - min)) * plot.height
    }
    for (const tick of ticks) {
      const y = scale(tick)
      parts.push(`<line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8ebf0" stroke-width="1"/>`)
      parts.push(`<text x="${(plot.x - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#555">${escapeXml(formatNumber(tick))}</text>`)
    }
    return { ticks, scale }
  }

  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="#ffffff"/>`)
  parts.push(`<text x="${WIDTH / 2}" y="22" text-anchor="middle" font-size="13" font-weight="600" fill="#1a3a63">${escapeXml(model.title)}</text>`)
  // A subtitle carries what the title cannot: the statistic, the sample, the
  // filter that was applied. It sits under the title in a lighter weight so the
  // heading still reads as one block.
  if (typeof model.subtitle === 'string' && model.subtitle.trim()) {
    parts.push(`<text x="${WIDTH / 2}" y="36" text-anchor="middle" font-size="10" fill="#5a6b82">${escapeXml(model.subtitle.trim())}</text>`)
  }

  if (model.kind === 'dendrogram') return renderDendrogram(model, { parts, plot, height })

  if (model.kind === 'control') {
    // Two Shewhart panels sharing the x positions: subgroup means above, ranges
    // below. Centre and ±3σ limits come from the average range, so the band is
    // drawn once per panel and the points that cross it are flagged in red.
    const panelAxis = (panel, min, max, formatter) => {
      const scale = (value) => (max === min
        ? panel.y + panel.height / 2
        : panel.y + panel.height - ((value - min) / (max - min)) * panel.height)
      for (const tick of ticksFor(min, max)) {
        const y = scale(tick)
        parts.push(`<line x1="${panel.x}" y1="${y.toFixed(1)}" x2="${(panel.x + panel.width).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8ebf0" stroke-width="1"/>`)
        parts.push(`<text x="${(panel.x - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#555">${escapeXml(formatter(tick))}</text>`)
      }
      return scale
    }
    const gap = 42
    const usable = height - margin.top - margin.bottom - gap
    const meanPanel = { x: plot.x, y: margin.top, width: plot.width, height: usable * 0.56 }
    const rangePanel = { x: plot.x, y: meanPanel.y + meanPanel.height + gap, width: plot.width, height: usable * 0.44 }
    const step = model.points.length > 1 ? plot.width / (model.points.length - 1) : 0
    const drawPanel = (panel, key, legend, formatter) => {
      const limits = model[key]
      const values = [limits.ucl, limits.lcl, ...model.points.map((point) => point[key === 'meanChart' ? 'mean' : 'range'])]
      const rawMax = Math.max(...values)
      const rawMin = Math.min(...values)
      const padding = (rawMax - rawMin) * 0.12 || 1
      const scale = panelAxis(panel, rawMin - padding, rawMax + padding, formatter)
      parts.push(`<text x="${panel.x}" y="${(panel.y - 10).toFixed(1)}" font-size="11" font-weight="600" fill="#1a3a63">${escapeXml(legend)}</text>`)
      for (const [value, color, dash, label] of [
        [limits.ucl, '#b4453a', '5 4', 'UCL'],
        [limits.cl, '#3f6f9f', '4 4', 'CL'],
        [limits.lcl, '#b4453a', '5 4', 'LCL'],
      ]) {
        const y = scale(value)
        parts.push(`<line x1="${panel.x}" y1="${y.toFixed(1)}" x2="${(panel.x + panel.width).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="${dash}"/>`)
        parts.push(`<text x="${(panel.x + panel.width + 4).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="9" fill="${color}">${label} ${escapeXml(formatter(value))}</text>`)
      }
      const points = model.points.map((point, index) => ({
        x: plot.x + step * index,
        y: scale(point[key === 'meanChart' ? 'mean' : 'range']),
        value: point[key === 'meanChart' ? 'mean' : 'range'],
        label: point.label,
      }))
      parts.push(`<polyline points="${points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${accent ?? '#3f6f9f'}" stroke-width="1.6"/>`)
      for (const point of points) {
        const outside = point.value > limits.ucl || point.value < limits.lcl
        parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${outside ? 3.4 : 2.6}" fill="${outside ? '#b4453a' : '#ffffff'}" stroke="${outside ? '#b4453a' : (accent ?? '#3f6f9f')}" stroke-width="1.4"/>`)
      }
      parts.push(`<line x1="${panel.x}" y1="${panel.y + panel.height}" x2="${(panel.x + panel.width).toFixed(1)}" y2="${panel.y + panel.height}" stroke="#333"/>`)
      parts.push(`<line x1="${panel.x}" y1="${panel.y}" x2="${panel.x}" y2="${panel.y + panel.height}" stroke="#333"/>`)
      return points
    }
    drawPanel(meanPanel, 'meanChart', `子组均值（每 ${model.size} 个个案一组）`, (value) => formatNumber(round(value, 2)))
    const rangePoints = drawPanel(rangePanel, 'rangeChart', '子组极差', (value) => formatNumber(round(value, 2)))
    const every = Math.max(1, Math.ceil(model.points.length / 12))
    rangePoints.forEach((point, index) => {
      if (index % every !== 0 && index !== rangePoints.length - 1) return
      parts.push(`<text x="${point.x.toFixed(1)}" y="${(rangePanel.y + rangePanel.height + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="#444">${escapeXml(clipLabel(point.label, 6))}</text>`)
    })
  } else if (model.kind === 'km') {
    // Survival curves are step functions: the estimate only drops at an event
    // time, so a straight polyline between points would claim a decline that
    // never happened. Censor marks ride on the curve, and the log-rank result is
    // printed inside the figure because that is the number a paper needs.
    const colors = ['#3f6f9f', '#b4453a', '#4a8b5c', '#8a5aa8', '#c08a2e', '#3f8f8f']
    const scaleY = (value) => plot.y + plot.height - value * plot.height
    const scaleX = (value) => plot.x + (model.maxTime === 0 ? 0 : (value / model.maxTime) * plot.width)
    for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
      const y = scaleY(tick)
      parts.push(`<line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8ebf0" stroke-width="1"/>`)
      parts.push(`<text x="${(plot.x - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#555">${Math.round(tick * 100)}%</text>`)
    }
    for (const tick of ticksFor(0, model.maxTime)) {
      const x = scaleX(tick)
      parts.push(`<text x="${x.toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="#555">${escapeXml(formatNumber(tick))}</text>`)
    }
    model.groups.forEach((group, index) => {
      const color = colors[index % colors.length]
      let previous = 0
      const points = []
      for (const point of group.curve) {
        points.push(`${scaleX(point.time).toFixed(1)},${scaleY(previous).toFixed(1)}`)
        points.push(`${scaleX(point.time).toFixed(1)},${scaleY(point.survival).toFixed(1)}`)
        previous = point.survival
      }
      if (points.length) {
        // The curve runs flat to the end of follow-up, which is where the last
        // censored case left.
        points.push(`${scaleX(model.maxTime).toFixed(1)},${scaleY(previous).toFixed(1)}`)
        parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8"/>`)
      }
      for (const tick of group.censoredTicks) {
        const x = scaleX(tick.time)
        const y = scaleY(tick.survival)
        parts.push(`<line x1="${x.toFixed(1)}" y1="${(y - 3).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + 3).toFixed(1)}" stroke="${color}" stroke-width="1.2"/>`)
      }
      const legendY = plot.y + 12 + index * 15
      parts.push(`<line x1="${(plot.x + plot.width - 132).toFixed(1)}" y1="${legendY}" x2="${(plot.x + plot.width - 112).toFixed(1)}" y2="${legendY}" stroke="${color}" stroke-width="2"/>`)
      parts.push(`<text x="${(plot.x + plot.width - 106).toFixed(1)}" y="${(legendY + 4).toFixed(1)}" font-size="10" fill="#333">${escapeXml(clipLabel(`${group.label} (n=${group.n}, 事件 ${group.events})`, 22))}</text>`)
    })
    // The median survival is the number a paper quotes next to the curve, so it
    // belongs in the figure; a group that never falls to 50% says so with a dash
    // instead of a zero that would read as "died immediately".
    if (Array.isArray(model.groups) && model.groups.length) {
      const said = model.groups.map((group) => {
        const median = group.median === null || group.median === undefined ? '—' : formatNumber(group.median)
        return model.groups.length > 1 ? `${group.label} = ${median}` : median
      })
      const prefix = model.groups.length > 1 ? '中位生存期：' : '中位生存期 = '
      parts.push(`<text x="${plot.x}" y="${(plot.y + plot.height + 34).toFixed(1)}" font-size="10" fill="#444">${escapeXml(prefix + said.join('，'))}</text>`)
    }
    if (model.logRank) {
      // Three decimals, because a test statistic printed as 0.43 hides which
      // side of a rounding boundary it was on; a really small P says so.
      const threeDigits = (value) => (typeof value === 'number' ? (value < 0.001 ? '< 0.001' : value.toFixed(3)) : String(value))
      parts.push(`<text x="${plot.x}" y="${(plot.y + plot.height + 47).toFixed(1)}" font-size="10" fill="#444">log-rank χ² = ${escapeXml(threeDigits(model.logRank.chiSquare))}，df = ${model.logRank.df}，P = ${escapeXml(threeDigits(model.logRank.p))}</text>`)
    }
    parts.push(`<text x="${plot.x}" y="${(plot.y + plot.height + 60).toFixed(1)}" font-size="9" fill="#777">${escapeXml(model.xLabel ?? `随访时间（${model.time}）`)}</text>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'bar') {
    parts.push(...renderBar(model, plot, axisValue, accent))
  } else if (model.kind === 'pareto') {
    // Two axes: counts on the left, the cumulative share on the right. The bars
    // are already sorted by the model, so the curve only ever goes up.
    const max = Math.max(...model.bars.map((bar) => bar.count), 1)
    const { scale } = axisValue(model, 0, max)
    const pctScale = (percent) => plot.y + plot.height - (percent / 100) * plot.height
    const slot = plot.width / model.bars.length
    const barWidth = Math.max(4, Math.min(60, slot * 0.6))
    model.bars.forEach((bar, index) => {
      const center = plot.x + slot * index + slot / 2
      const y = scale(bar.count)
      parts.push(`<rect x="${(center - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, plot.y + plot.height - y).toFixed(1)}" fill="${accent ?? '#a9c6e6'}" stroke="${accent ?? '#5b89b8'}" stroke-width="0.8"/>`)
      parts.push(`<text x="${center.toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="#444">${escapeXml(clipLabel(bar.label, 8))}</text>`)
      if (bar.folded) {
        parts.push(`<text x="${center.toFixed(1)}" y="${(plot.y + plot.height + 27).toFixed(1)}" text-anchor="middle" font-size="8" fill="#888">${bar.count}</text>`)
      }
    })
    const points = model.bars
      .map((bar, index) => `${(plot.x + slot * index + slot / 2).toFixed(1)},${pctScale(bar.cumulative).toFixed(1)}`)
      .join(' ')
    parts.push(`<polyline points="${points}" fill="none" stroke="#b4453a" stroke-width="1.8"/>`)
    model.bars.forEach((bar, index) => {
      const center = plot.x + slot * index + slot / 2
      parts.push(`<circle cx="${center.toFixed(1)}" cy="${pctScale(bar.cumulative).toFixed(1)}" r="2.4" fill="#b4453a"/>`)
      // With many categories the labels would collide; the reader can still see
      // the curve and read exact numbers from the output table.
      if (model.bars.length <= 8) {
        parts.push(`<text x="${center.toFixed(1)}" y="${(pctScale(bar.cumulative) - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#b4453a">${escapeXml(formatNumber(bar.cumulative))}%</text>`)
      }
    })
    // The reference line is the whole point of the chart: it says where the
    // cumulative share passes the threshold the reader cares about.
    const referenceY = pctScale(model.reference)
    parts.push(`<line x1="${plot.x}" y1="${referenceY.toFixed(1)}" x2="${plot.x + plot.width}" y2="${referenceY.toFixed(1)}" stroke="#b4453a" stroke-width="1" stroke-dasharray="5 4"/>`)
    parts.push(`<text x="${(plot.x + 4).toFixed(1)}" y="${(referenceY - 4).toFixed(1)}" font-size="9" fill="#b4453a">参考线 ${escapeXml(formatNumber(model.reference))}%</text>`)
    for (const tick of [0, 25, 50, 75, 100]) {
      const y = pctScale(tick)
      parts.push(`<text x="${(plot.x + plot.width + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="start" font-size="9" fill="#b4453a">${tick}%</text>`)
    }
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'histogram') {
    const max = Math.max(
      ...model.bins.map((bin) => bin.count),
      ...(model.normal?.points ?? []).map((point) => point.expected),
      1,
    )
    const { scale } = axisValue(model, 0, max)
    const slot = plot.width / model.bins.length
    model.bins.forEach((bin, index) => {
      const y = scale(bin.count)
      const height = Math.max(0, plot.y + plot.height - y)
      parts.push(`<rect x="${(plot.x + slot * index + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, slot - 1).toFixed(1)}" height="${height.toFixed(1)}" fill="${accent ?? '#a9c6e6'}" stroke="${accent ?? '#5b89b8'}" stroke-width="0.8"/>`)
      if (model.bins.length <= 16 || index % Math.ceil(model.bins.length / 10) === 0) {
        parts.push(`<text x="${(plot.x + slot * index + slot / 2).toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="#555">${escapeXml(formatNumber(bin.start))}</text>`)
      }
    })
    if (model.normal && model.normal.points.length > 1) {
      const path = model.normal.points
        .map((point, index) => `${(plot.x + slot * index + slot / 2).toFixed(1)},${scale(point.expected).toFixed(1)}`)
        .join(' ')
      parts.push(`<polyline points="${path}" fill="none" stroke="#b4453a" stroke-width="1.8"/>`)
      parts.push(`<text x="${(plot.x + plot.width - 4).toFixed(1)}" y="${(plot.y + 12).toFixed(1)}" text-anchor="end" font-size="10" fill="#b4453a">正态曲线 μ=${escapeXml(formatNumber(model.normal.mean))} σ=${escapeXml(formatNumber(model.normal.sd))}</text>`)
    }
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333" stroke-width="1"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333" stroke-width="1"/>`)
  } else if (model.kind === 'boxplot') {
    const values = []
    for (const group of model.groups) {
      values.push(group.min, group.q1, group.median, group.q3, group.max, ...group.outliers)
    }
    const rawMax = Math.max(...values)
    const rawMin = Math.min(...values)
    const padding = (rawMax - rawMin) * 0.1 || 1
    const max = rawMax + padding
    const min = rawMin - padding
    const { scale } = axisValue(model, min, max)
    const slot = plot.width / model.groups.length
    const boxWidth = Math.min(52, slot * 0.5)
    model.groups.forEach((group, index) => {
      const center = plot.x + slot * index + slot / 2
      const x = center - boxWidth / 2
      parts.push(`<line x1="${center.toFixed(1)}" y1="${scale(group.min).toFixed(1)}" x2="${center.toFixed(1)}" y2="${scale(group.q1).toFixed(1)}" stroke="${accent ?? '#3f6f9f'}" stroke-width="1"/>`)
      parts.push(`<line x1="${center.toFixed(1)}" y1="${scale(group.q3).toFixed(1)}" x2="${center.toFixed(1)}" y2="${scale(group.max).toFixed(1)}" stroke="${accent ?? '#3f6f9f'}" stroke-width="1"/>`)
      parts.push(`<line x1="${(center - boxWidth / 3).toFixed(1)}" y1="${scale(group.max).toFixed(1)}" x2="${(center + boxWidth / 3).toFixed(1)}" y2="${scale(group.max).toFixed(1)}" stroke="${accent ?? '#3f6f9f'}"/>`)
      parts.push(`<line x1="${(center - boxWidth / 3).toFixed(1)}" y1="${scale(group.min).toFixed(1)}" x2="${(center + boxWidth / 3).toFixed(1)}" y2="${scale(group.min).toFixed(1)}" stroke="${accent ?? '#3f6f9f'}"/>`)
      parts.push(`<rect x="${x.toFixed(1)}" y="${scale(group.q3).toFixed(1)}" width="${boxWidth.toFixed(1)}" height="${Math.max(1, scale(group.q1) - scale(group.q3)).toFixed(1)}" fill="${accent ?? '#cfe0f2'}" stroke="${accent ?? '#3f6f9f'}"/>`)
      parts.push(`<line x1="${x.toFixed(1)}" y1="${scale(group.median).toFixed(1)}" x2="${(x + boxWidth).toFixed(1)}" y2="${scale(group.median).toFixed(1)}" stroke="#1a3a63" stroke-width="1.6"/>`)
      for (const outlier of group.outliers) {
        parts.push(`<circle cx="${center.toFixed(1)}" cy="${scale(outlier).toFixed(1)}" r="1.8" fill="none" stroke="#b4614a"/>`)
      }
      parts.push(`<text x="${center.toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(group.label))}</text>`)
    })
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'line2') {
    // One polyline per variable, each read against its own axis; the left axis
    // supplies the grid so the two scales never fight over the same lines.
    const [leftAxis, rightAxis] = model.axes
    const bounds = (values) => {
      const nums = values.filter((value) => typeof value === 'number')
      const lo = Math.min(...nums)
      const hi = Math.max(...nums)
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1
      return [lo - pad, hi + pad]
    }
    const [leftLo, leftHi] = bounds(leftAxis.series.values)
    const [rightLo, rightHi] = bounds(rightAxis.series.values)
    const yFor = (value, lo, hi) => (hi === lo ? plot.y + plot.height / 2 : plot.y + plot.height - ((value - lo) / (hi - lo)) * plot.height)
    const leftTicks = ticksFor(leftLo, leftHi)
    for (const tick of leftTicks) {
      const y = yFor(tick, leftLo, leftHi)
      parts.push(`<line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8ebf0" stroke-width="1"/>`)
      parts.push(`<text x="${(plot.x - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#555">${escapeXml(formatNumber(tick))}</text>`)
    }
    for (const tick of ticksFor(rightLo, rightHi)) {
      const y = yFor(tick, rightLo, rightHi)
      parts.push(`<line x1="${(plot.x + plot.width).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(plot.x + plot.width + 4).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#9aa4b0" stroke-width="1"/>`)
      parts.push(`<text x="${(plot.x + plot.width + 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="start" font-size="10" fill="#555">${escapeXml(formatNumber(tick))}</text>`)
    }
    const slot = model.labels.length > 1 ? plot.width / (model.labels.length - 1) : 0
    const colors = { left: accent ?? '#3f6f9f', right: '#c9702f' }
    for (const axis of model.axes) {
      const [lo, hi] = axis.side === 'left' ? [leftLo, leftHi] : [rightLo, rightHi]
      const points = axis.series.values
        .map((value, index) => (typeof value === 'number'
          ? { x: plot.x + slot * index, y: yFor(value, lo, hi), value }
          : null))
        .filter(Boolean)
      if (points.length === 0) continue
      const color = colors[axis.side]
      parts.push(`<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"/>`)
      for (const point of points) {
        parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>`)
      }
    }
    model.labels.forEach((label, index) => {
      parts.push(`<text x="${(plot.x + slot * index).toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(label))}</text>`)
    })
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${(plot.x + plot.width).toFixed(1)}" y1="${plot.y}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    let legendX = plot.x + 6
    for (const axis of model.axes) {
      const color = colors[axis.side]
      const y = plot.y + plot.height + 34
      parts.push(`<rect x="${legendX}" y="${(y - 8).toFixed(1)}" width="10" height="10" fill="${color}" stroke="${color}" stroke-width="1"/>`)
      parts.push(`<text x="${(legendX + 14).toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="#444">${escapeXml(clipLabel(`${axis.series.label}（${axis.side === 'left' ? '左轴' : '右轴'}）`, 18))}</text>`)
      legendX += 24 + String(`${axis.series.label}（${axis.side === 'left' ? '左轴' : '右轴'}）`).length * 12
    }
  } else if (model.kind === 'line' && model.errorBars === true) {
    // A trend with ±1 standard deviation whiskers at every point, which is how
    // SPSS draws a "line chart with error bars".
    const values = []
    for (const point of model.points) {
      values.push(point.value)
      if (typeof point.errorLow === 'number') values.push(point.errorHigh, point.errorLow)
      else if (typeof point.sd === 'number') values.push(point.value + point.sd, point.value - point.sd)
    }
    const rawMax = Math.max(...values)
    const rawMin = Math.min(...values)
    const padding = (rawMax - rawMin) * 0.1 || 1
    const { scale } = axisValue(model, rawMin - padding, rawMax + padding)
    const step = model.points.length > 1 ? plot.width / (model.points.length - 1) : 0
    const placed = model.points.map((point, index) => ({ x: plot.x + step * index, y: scale(point.value), ...point }))
    parts.push(`<polyline fill="none" stroke="${accent ?? '#3f6f9f'}" stroke-width="1.8" points="${placed.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"/>`)
    for (const point of placed) {
      const lowValue = point.errorLow ?? (typeof point.sd === 'number' ? point.value - point.sd : null)
      const highValue = point.errorHigh ?? (typeof point.sd === 'number' ? point.value + point.sd : null)
      if (lowValue !== null && highValue !== null && highValue > lowValue) {
        const high = scale(highValue)
        const low = scale(lowValue)
        parts.push(`<line x1="${point.x.toFixed(1)}" y1="${high.toFixed(1)}" x2="${point.x.toFixed(1)}" y2="${low.toFixed(1)}" stroke="#24405f" stroke-width="1"/>`)
        for (const edge of [high, low]) {
          parts.push(`<line x1="${(point.x - 5).toFixed(1)}" y1="${edge.toFixed(1)}" x2="${(point.x + 5).toFixed(1)}" y2="${edge.toFixed(1)}" stroke="#24405f" stroke-width="1"/>`)
        }
      }
      parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="#ffffff" stroke="${accent ?? '#3f6f9f'}" stroke-width="1.6"/>`)
      parts.push(`<text x="${point.x.toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(point.label))}</text>`)
    }
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'area') {
    // A stacked area: each series fills from the running total below it upward,
    // so the top edge is the cumulative sum.
    const lines = ['#7aa9dd', '#e8a33d', '#6bbf8a', '#b57edc', '#e07b7b', '#7fb2d8']
    const labels = model.labels
    const running = labels.map(() => 0)
    let peak = 0
    for (const series of model.series) {
      series.points.forEach((point, index) => {
        if (typeof point.value !== 'number') return
        running[index] += Math.max(0, point.value)
        peak = Math.max(peak, running[index])
      })
    }
    const { scale } = axisValue(model, 0, peak * 1.1 || 1)
    const step = labels.length > 1 ? plot.width / (labels.length - 1) : 0
    const bottom = labels.map(() => 0)
    model.series.forEach((series, seriesIndex) => {
      const upper = labels.map((label, index) => {
        const point = series.points[index]
        return bottom[index] + (typeof point?.value === 'number' ? Math.max(0, point.value) : 0)
      })
      const top = upper.map((value, index) => `${(plot.x + step * index).toFixed(1)},${scale(value).toFixed(1)}`)
      const under = bottom.map((value, index) => `${(plot.x + step * index).toFixed(1)},${scale(value).toFixed(1)}`).reverse()
      parts.push(`<polygon points="${[...top, ...under].join(' ')}" fill="${accent && seriesIndex === 0 ? accent : lines[seriesIndex % lines.length]}" fill-opacity="0.85" stroke="#ffffff" stroke-width="1"/>`)
      upper.forEach((value, index) => { bottom[index] = value })
    })
    labels.forEach((label, index) => {
      parts.push(`<text x="${(plot.x + step * index).toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(label))}</text>`)
    })
    let legendX = plot.x
    model.series.forEach((series, index) => {
      parts.push(`<rect x="${legendX.toFixed(1)}" y="${(plot.y + 12).toFixed(1)}" width="10" height="10" fill="${lines[index % lines.length]}"/>`)
      parts.push(`<text x="${(legendX + 14).toFixed(1)}" y="${(plot.y + 21).toFixed(1)}" font-size="10" fill="#444">${escapeXml(clipLabel(series.label, 12))}</text>`)
      legendX += 24 + String(series.label).length * 6
    })
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'line' && Array.isArray(model.series)) {
    // Several trends over one category axis. A missing category leaves a gap in
    // that line rather than a line drawn straight through it.
    const lines = ['#3f6f9f', '#e8a33d', '#6bbf8a', '#b57edc', '#e07b7b', '#7fb2d8']
    const all = model.series.flatMap((entry) => entry.points.map((point) => point.value)).filter((value) => typeof value === 'number')
    const rawMax = Math.max(...all)
    const rawMin = Math.min(...all)
    const padding = (rawMax - rawMin) * 0.1 || 1
    const { scale } = axisValue(model, rawMin - padding, rawMax + padding)
    const count = model.labels.length
    const step = count > 1 ? plot.width / (count - 1) : 0
    model.series.forEach((entry, seriesIndex) => {
      const color = entry.key === undefined ? accent ?? lines[seriesIndex % lines.length] : lines[seriesIndex % lines.length]
      const segments = []
      let current = []
      entry.points.forEach((point, index) => {
        if (typeof point.value !== 'number') {
          if (current.length) segments.push(current)
          current = []
          return
        }
        current.push({ x: plot.x + step * index, y: scale(point.value), ...point })
      })
      if (current.length) segments.push(current)
      for (const segment of segments) {
        if (segment.length > 1) {
          parts.push(`<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"/>`)
        }
        for (const point of segment) {
          parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>`)
        }
      }
    })
    model.labels.forEach((label, index) => {
      parts.push(`<text x="${(plot.x + step * index).toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(label))}</text>`)
    })
    let legendX = plot.x
    model.series.forEach((entry, index) => {
      const color = lines[index % lines.length]
      parts.push(`<rect x="${legendX.toFixed(1)}" y="${(plot.y + 12).toFixed(1)}" width="10" height="10" fill="${color}"/>`)
      parts.push(`<text x="${(legendX + 14).toFixed(1)}" y="${(plot.y + 21).toFixed(1)}" font-size="10" fill="#444">${escapeXml(clipLabel(entry.label, 12))}</text>`)
      legendX += 24 + String(entry.label).length * 6
    })
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'line') {
    const values = model.points.map((point) => point.value)
    const rawMax = Math.max(...values)
    const rawMin = Math.min(...values)
    const padding = (rawMax - rawMin) * 0.1 || 1
    const { scale } = axisValue(model, rawMin - padding, rawMax + padding)
    const step = model.points.length > 1 ? plot.width / (model.points.length - 1) : 0
    const placed = model.points.map((point, index) => ({
      x: plot.x + step * index,
      y: scale(point.value),
      ...point,
    }))
    parts.push(`<polyline fill="none" stroke="${accent ?? '#3f6f9f'}" stroke-width="1.8" points="${placed.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"/>`)
    for (const point of placed) {
      parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="#ffffff" stroke="${accent ?? '#3f6f9f'}" stroke-width="1.6"/>`)
      parts.push(`<text x="${point.x.toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#444">${escapeXml(clipLabel(point.label))}</text>`)
    }
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  } else if (model.kind === 'pie') {
    const total = model.slices.reduce((sum, slice) => sum + slice.value, 0) || 1
    const radius = Math.min(plot.height, plot.width * 0.6) / 2 - 8
    const centerX = plot.x + plot.width * 0.32
    const centerY = plot.y + plot.height / 2
    const colors = ['#7aa9dd', '#f0b46a', '#93c47d', '#d98f8f', '#b39ddb', '#8fd1c9', '#d7c26a', '#a0a8c0']
    let angle = -Math.PI / 2
    // One category is a real case (all cases fall in one group): its arc has
    // identical start and end points, which SVG spec says to ignore, so draw
    // the two half arcs explicitly instead of an empty disc.
    if (model.slices.length === 1) {
      const color = colors[0]
      if (model.donut === true) {
        const inner = radius * 0.55
        parts.push(`<path d="M ${(centerX - radius).toFixed(1)} ${centerY.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 1 ${(centerX + radius).toFixed(1)} ${centerY.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 1 ${(centerX - radius).toFixed(1)} ${centerY.toFixed(1)} M ${(centerX - inner).toFixed(1)} ${centerY.toFixed(1)} A ${inner.toFixed(1)} ${inner.toFixed(1)} 0 1 0 ${(centerX + inner).toFixed(1)} ${centerY.toFixed(1)} A ${inner.toFixed(1)} ${inner.toFixed(1)} 0 1 0 ${(centerX - inner).toFixed(1)} ${centerY.toFixed(1)} Z" fill="${color}" fill-rule="evenodd" stroke="#ffffff" stroke-width="1"/>`)
      } else {
        parts.push(`<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" stroke="#ffffff" stroke-width="1"/>`)
      }
      const slice = model.slices[0]
      parts.push(`<rect x="${(plot.x + plot.width * 0.66).toFixed(1)}" y="${(plot.y + 6).toFixed(1)}" width="10" height="10" fill="${color}"/>`)
      parts.push(`<text x="${(plot.x + plot.width * 0.66 + 16).toFixed(1)}" y="${(plot.y + 14).toFixed(1)}" font-size="10" fill="#333">${escapeXml(clipLabel(slice.label, 8))} ${slice.value} (100.0%)</text>`)
    } else {
    model.slices.forEach((slice, index) => {
      const sweep = (slice.value / total) * Math.PI * 2
      const x1 = centerX + radius * Math.cos(angle)
      const y1 = centerY + radius * Math.sin(angle)
      const x2 = centerX + radius * Math.cos(angle + sweep)
      const y2 = centerY + radius * Math.sin(angle + sweep)
      const large = sweep > Math.PI ? 1 : 0
      const color = colors[index % colors.length]
      if (model.donut === true) {
        // A ring: the same arc twice, so the hole is a real hole rather than a
        // white disc on top of an overlapping slice.
        const inner = radius * 0.55
        const ix1 = centerX + inner * Math.cos(angle)
        const iy1 = centerY + inner * Math.sin(angle)
        const ix2 = centerX + inner * Math.cos(angle + sweep)
        const iy2 = centerY + inner * Math.sin(angle + sweep)
        parts.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${ix2.toFixed(1)} ${iy2.toFixed(1)} A ${inner.toFixed(1)} ${inner.toFixed(1)} 0 ${large} 0 ${ix1.toFixed(1)} ${iy1.toFixed(1)} Z" fill="${color}" stroke="#ffffff" stroke-width="1"/>`)
        // The share goes inside the ring when the slice is wide enough to hold it.
        if (sweep > Math.PI / 6) {
          const middle = angle + sweep / 2
          const share = ((slice.value / total) * 100).toFixed(0)
          parts.push(`<text x="${(centerX + ((radius + inner) / 2) * Math.cos(middle)).toFixed(1)}" y="${(centerY + ((radius + inner) / 2) * Math.sin(middle) + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#ffffff">${share}%</text>`)
        }
      } else {
        parts.push(`<path d="M ${centerX.toFixed(1)} ${centerY.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}" stroke="#ffffff" stroke-width="1"/>`)
      }
      const legendY = plot.y + 14 + index * 18
      parts.push(`<rect x="${(plot.x + plot.width * 0.66).toFixed(1)}" y="${(legendY - 8).toFixed(1)}" width="10" height="10" fill="${color}"/>`)
      const percent = ((slice.value / total) * 100).toFixed(1)
      parts.push(`<text x="${(plot.x + plot.width * 0.66 + 16).toFixed(1)}" y="${legendY.toFixed(1)}" font-size="10" fill="#333">${escapeXml(clipLabel(slice.label, 8))} ${slice.value} (${percent}%)</text>`)
      angle += sweep
    })
    }
  } else {
    const xs = model.points.map(([x]) => x)
    const ys = model.points.map(([, y]) => y)
    const xPad = (Math.max(...xs) - Math.min(...xs)) * 0.04 || 1
    const yPad = (Math.max(...ys) - Math.min(...ys)) * 0.04 || 1
    const xMin = Math.min(...xs) - xPad
    const xMax = Math.max(...xs) + xPad
    const yMin = Math.min(...ys) - yPad
    const yMax = Math.max(...ys) + yPad
    const xTicks = ticksFor(xMin, xMax)
    const yTicks = ticksFor(yMin, yMax)
    const sx = (value) => (xMax === xMin ? plot.x + plot.width / 2 : plot.x + ((value - xMin) / (xMax - xMin)) * plot.width)
    const sy = (value) => (yMax === yMin ? plot.y + plot.height / 2 : plot.y + plot.height - ((value - yMin) / (yMax - yMin)) * plot.height)
    for (const tick of yTicks) {
      parts.push(`<line x1="${plot.x}" y1="${sy(tick).toFixed(1)}" x2="${plot.x + plot.width}" y2="${sy(tick).toFixed(1)}" stroke="#e8ebf0"/>`)
      parts.push(`<text x="${plot.x - 8}" y="${(sy(tick) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#555">${escapeXml(formatNumber(tick))}</text>`)
    }
    for (const tick of xTicks) {
      parts.push(`<text x="${sx(tick).toFixed(1)}" y="${(plot.y + plot.height + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#555">${escapeXml(formatNumber(tick))}</text>`)
    }
    if (Array.isArray(model.series) && model.series.length > 0) {
      // Same eight colours the pie chart uses, so two charts side by side agree.
      const seriesColors = ['#2f6fbb', '#d98f3a', '#4f9d5b', '#b4453a', '#7a5bb0', '#3d9b96', '#a8823a', '#7d8794']
      model.series.forEach((entry, index) => {
        const color = seriesColors[index % seriesColors.length]
        for (const [x, y] of entry.points) {
          parts.push(`<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="2.4" fill="${color}" fill-opacity="0.6"/>`)
        }
      })
      // The legend sits inside the plot's top-right corner; a scatter fills the
      // whole box, so it gets a translucent plate to stay readable.
      const rows = model.series.slice(0, 8)
      const boxWidth = 108
      const boxHeight = 8 + rows.length * 14
      const boxX = plot.x + plot.width - boxWidth - 6
      const boxY = plot.y + 6
      parts.push(`<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxWidth}" height="${boxHeight}" fill="#ffffff" fill-opacity="0.88" stroke="#d8dde6"/>`)
      rows.forEach((entry, index) => {
        const color = seriesColors[index % seriesColors.length]
        const lineY = boxY + 12 + index * 14
        parts.push(`<circle cx="${(boxX + 8).toFixed(1)}" cy="${(lineY - 3.5).toFixed(1)}" r="2.6" fill="${color}"/>`)
        parts.push(`<text x="${(boxX + 16).toFixed(1)}" y="${lineY.toFixed(1)}" font-size="9" fill="#333">${escapeXml(clipLabel(entry.label, 10))}</text>`)
      })
    } else {
      for (const [x, y] of model.points) {
        parts.push(`<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="2.4" fill="${accent ?? '#2f6fbb'}" fill-opacity="0.55"/>`)
      }
    }
    if (Array.isArray(model.fits) && model.fits.length > 0) {
      const fitColors = ['#2f6fbb', '#d98f3a', '#4f9d5b', '#b4453a', '#7a5bb0', '#3d9b96', '#a8823a', '#7d8794']
      model.fits.forEach((fit, index) => {
        if (!Number.isFinite(fit.slope) || !Number.isFinite(fit.intercept)) return
        const color = Array.isArray(model.series) && model.series.length > 0 ? fitColors[index % fitColors.length] : (accent ?? '#b4453a')
        const segment = fitSegment(fit.slope, fit.intercept, xMin, xMax, yMin, yMax)
        if (!segment) return
        parts.push(`<line x1="${sx(segment[0]).toFixed(1)}" y1="${sy(fit.slope * segment[0] + fit.intercept).toFixed(1)}" x2="${sx(segment[1]).toFixed(1)}" y2="${sy(fit.slope * segment[1] + fit.intercept).toFixed(1)}" stroke="${color}" stroke-width="1.6"/>`)
      })
      const labels = model.fits.filter((fit) => Number.isFinite(fit.r2)).slice(0, 4)
      labels.forEach((fit, index) => {
        const text = fit.label ? `${clipLabel(fit.label, 12)}：R² = ${formatNumber(fit.r2)}` : `R² = ${formatNumber(fit.r2)}`
        parts.push(`<text x="${(plot.x + 8).toFixed(1)}" y="${(plot.y + 14 + index * 13).toFixed(1)}" font-size="10" fill="#333">${escapeXml(text)}</text>`)
      })
    }
    // Residual plots read against a reference: zero for residuals, the diagonal
    // for a P-P plot. Without it "points sit above the line" is not visible.
    if (model.zeroLine === true) {
      parts.push(`<line x1="${plot.x}" y1="${sy(0).toFixed(1)}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${sy(0).toFixed(1)}" stroke="#b4453a" stroke-dasharray="4 3" stroke-width="1"/>`)
    }
    if (model.diagonal === true) {
      const low = Math.max(xMin, yMin)
      const high = Math.min(xMax, yMax)
      parts.push(`<line x1="${sx(low).toFixed(1)}" y1="${sy(low).toFixed(1)}" x2="${sx(high).toFixed(1)}" y2="${sy(high).toFixed(1)}" stroke="#b4453a" stroke-dasharray="4 3" stroke-width="1"/>`)
    }
    parts.push(`<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#333"/>`)
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#333"/>`)
  }

  if (model.xLabel) {
    parts.push(`<text x="${(plot.x + plot.width / 2).toFixed(1)}" y="${HEIGHT - 8}" text-anchor="middle" font-size="11" fill="#333">${escapeXml(model.xLabel)}</text>`)
  }
  if (model.yLabel) {
    parts.push(`<text transform="translate(16 ${(plot.y + plot.height / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="11" fill="#333">${escapeXml(model.yLabel)}</text>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family='${FONT}'>${parts.join('')}</svg>\n`
}

/** Titles, accent colour and category order applied after the numbers are in. */

/**
 * Tile several charts into one picture.
 *
 * The charts are already SVG at a fixed size, and each one's content is drawn in
 * its own 0..WIDTH/0..HEIGHT coordinates. Embedding a whole `<svg>` per cell
 * would need nested viewports that the PNG rasteriser does not read, so each
 * chart's body is translated into place inside one outer coordinate system —
 * one document, one background, no seams.
 */
export function composeChartGrid(svgs, layout = '2x2', options = {}) {
  const list = (Array.isArray(svgs) ? svgs : []).filter((svg) => typeof svg === 'string' && svg.includes('<svg'))
  if (list.length === 0) throw new Error('拼版至少要有一张图')
  const cells = layout === '1x2' ? { columns: 2, rows: 1 }
    : layout === '2x1' ? { columns: 1, rows: 2 }
      : { columns: 2, rows: 2 }
  const capacity = cells.columns * cells.rows
  if (list.length > capacity) {
    throw new Error(`拼版放不下 ${list.length} 张图：${layout} 只有 ${capacity} 格，请少勾几张或换一种拼版`)
  }
  const gap = Number(options.gap ?? 12) || 0
  const padding = Number(options.padding ?? 8) || 0
  const bodies = list.map((svg) => {
    const open = svg.indexOf('<svg')
    const start = svg.indexOf('>', open) + 1
    const end = svg.lastIndexOf('</svg>')
    const width = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? WIDTH)
    const height = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? HEIGHT)
    return { body: svg.slice(start, end), width, height }
  })
  // Uniform cells keep the numbers on the axes at the same size across the
  // grid; scaling each chart to its own best fit would make four charts of
  // different data ranges look like four different documents.
  const cellWidth = Math.max(...bodies.map((entry) => entry.width))
  const cellHeight = Math.max(...bodies.map((entry) => entry.height))
  const usedRows = Math.ceil(list.length / cells.columns)
  const width = padding * 2 + cells.columns * cellWidth + (cells.columns - 1) * gap
  const height = padding * 2 + usedRows * cellHeight + (usedRows - 1) * gap
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`]
  bodies.forEach((entry, index) => {
    const column = index % cells.columns
    const row = Math.floor(index / cells.columns)
    const x = padding + column * (cellWidth + gap)
    const y = padding + row * (cellHeight + gap)
    parts.push(`<g transform="translate(${x},${y})">${entry.body}</g>`)
  })
  parts.push('</svg>')
  return parts.join('')
}

export function applyChartOverrides(model, options = {}) {
  const next = { ...model }
  if (typeof options.title === 'string' && options.title.trim()) next.title = options.title.trim()
  if (typeof options.subtitle === 'string') {
    // An empty subtitle is a request to remove one, not to keep the old text.
    if (options.subtitle.trim()) next.subtitle = options.subtitle.trim()
    else delete next.subtitle
  }
  if (typeof options.xLabel === 'string') next.xLabel = options.xLabel.trim()
  if (typeof options.yLabel === 'string') next.yLabel = options.yLabel.trim()
  if (typeof options.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(options.accent)) next.accent = options.accent
  const order = options.sortCategories
  if (order === 'asc' || order === 'desc') {
    const sign = order === 'asc' ? 1 : -1
    const sorted = (list) => [...list].sort((left, right) => sign * (left.value - right.value))
    if (Array.isArray(next.categories)) next.categories = sorted(next.categories)
    if (Array.isArray(next.slices)) next.slices = sorted(next.slices)
    if (Array.isArray(next.points) && next.kind !== 'line') next.points = sorted(next.points)
  }
  return next
}

/** Build a chart model by kind. */
/**
 * Stacked area chart: the cumulative shape of one or more series over a
 * category axis. With one series it is the same numbers as a line chart,
 * filled in; with several they pile up, which is how a cumulative trend reads.
 */
export function computeArea(dataset, options = {}) {
  const line = computeLine(dataset, options)
  const series = line.series ?? [{
    key: '__all__',
    label: line.yLabel || options.variable,
    points: line.points.map((point) => ({ label: point.label, value: point.value })),
  }]
  return {
    kind: 'area',
    // Charts with several series share one renderer shape.
    labels: series === line.series ? line.labels : line.points.map((point) => point.label),
    series,
    // The shared renderer keys off `series`; the area branch keys off the kind.
    points: line.points,
    title: `${line.title.replace(/ 趋势$/, '')} 累积面积`,
    xLabel: line.xLabel,
    yLabel: line.yLabel,
  }
}

// 最小二乘直线与 R²；x 全相同时没有斜率可画（返回 null，调用方丢掉这条线）。
function linearFit(points) {
  const n = points.length
  if (n < 2) return { slope: null, intercept: null, r2: null }
  let sx = 0
  let sy = 0
  for (const [x, y] of points) { sx += x; sy += y }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (y - my)
    syy += (y - my) ** 2
  }
  if (!(sxx > 0)) return { slope: null, intercept: null, r2: null }
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1
  return { slope, intercept, r2 }
}

// 正态累积分布：Hart 1968 的 erfc 有理逼近，误差 < 1.5e-7，画图足够。
function standardNormal(z) {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.5 * x)
  const erf = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))))
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

// SPSS 的 P-P / Q-Q 图靠 EXAMINE /PLOT=NPPLOT 出，但 PSPP 2.1.3 只打
// 「Tests of Normality」那张表，图一个像素都没有（探过）。所以这里按同一次
// 样本自己算点：P-P 画（观测累积比例，正态期望累积比例），Q-Q 画（观测值，
// 正态期望分位数）。两种都用散点渲染器，配上 y=x 参考线。


// Control-chart constants for subgroup sizes 2–10 (ASTM/Shewhart). A2 turns the
// average range into the ±3σ band of the means; D3 and D4 do the same for the
// range chart itself. Sizes above ten are unusual in practice and the table
// stops there rather than being invented.
const SPC_CONSTANTS = {
  2: { A2: 1.88, D3: 0, D4: 3.267 },
  3: { A2: 1.023, D3: 0, D4: 2.574 },
  4: { A2: 0.729, D3: 0, D4: 2.282 },
  5: { A2: 0.577, D3: 0, D4: 2.114 },
  6: { A2: 0.483, D3: 0, D4: 2.004 },
  7: { A2: 0.419, D3: 0.076, D4: 1.924 },
  8: { A2: 0.373, D3: 0.136, D4: 1.864 },
  9: { A2: 0.337, D3: 0.184, D4: 1.816 },
  10: { A2: 0.308, D3: 0.223, D4: 1.777 },
}

// An X̄–R chart: each subgroup gives a mean and a range, the two charts share
// the same x positions, and the limits come from the average range rather than
// from the within-subgroup standard deviation. SPSS keeps this under 质量控制;
// PSPP has nothing of the kind, so the whole model is computed here.
export function computeControlChart(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const variable = dataset.variables.find((entry) => entry.name === options.variable)
  if (!variable) throw new Error(`没有这个变量：${options.variable}`)
  if (!numeric(variable)) throw new Error(`控制图要求数值变量：${options.variable} 是文本变量`)
  const index = column(dataset, options.variable)
  const subgroupVariable = options.subgroup ? dataset.variables.find((entry) => entry.name === options.subgroup) : null
  if (options.subgroup && !subgroupVariable) throw new Error(`没有这个变量：${options.subgroup}`)
  const subgroupIndex = subgroupVariable ? column(dataset, options.subgroup) : -1
  const wanted = Math.trunc(Number(options.size ?? 5))
  if (!subgroupVariable && !(wanted >= 2 && wanted <= 10)) {
    throw new Error('子组大小要在 2 到 10 之间（控制图常数表只到 10）；要按变量分子组就把「子组变量」选上')
  }
  const groups = []
  if (subgroupVariable) {
    const buckets = new Map()
    for (const row of rows) {
      const value = variableValue(variable, row[index])
      if (value === null) continue
      const key = variableValue(subgroupVariable, row[subgroupIndex])
      if (key === null) continue
      const bucket = buckets.get(String(key)) ?? { key: String(key), label: labelFor(subgroupVariable, key), values: [] }
      bucket.values.push(value)
      buckets.set(bucket.key, bucket)
    }
    groups.push(...buckets.values())
  } else {
    let current = []
    for (const row of rows) {
      const value = variableValue(variable, row[index])
      if (value === null) continue
      current.push(value)
      if (current.length === wanted) {
        groups.push({ key: String(groups.length + 1), label: `第 ${groups.length + 1} 组`, values: current })
        current = []
      }
    }
    // A trailing partial subgroup is dropped: its range would be a range over
    // fewer cases, and mixing sizes makes the constants meaningless.
  }
  if (groups.length < 2) throw new Error('至少要两个子组才画得出控制图（子组太少，控制限没有意义）')
  const sizes = new Set(groups.map((group) => group.values.length))
  if (sizes.size > 1) {
    const list = [...sizes].sort((left, right) => left - right).join('、')
    throw new Error(`各子组的大小必须相同，现在有 ${list} 种：控制限常数是按固定子组大小查表的`)
  }
  const size = groups[0].values.length
  if (!(size >= 2 && size <= 10)) throw new Error('子组大小要在 2 到 10 之间（控制图常数表只到 10）')
  const constants = SPC_CONSTANTS[size]
  const points = groups.map((group) => {
    const sum = group.values.reduce((total, value) => total + value, 0)
    return {
      label: group.label,
      mean: round(sum / group.values.length),
      range: round(Math.max(...group.values) - Math.min(...group.values)),
      count: group.values.length,
    }
  })
  const grand = points.reduce((total, point) => total + point.mean, 0) / points.length
  const averageRange = points.reduce((total, point) => total + point.range, 0) / points.length
  const meanChart = {
    cl: round(grand),
    ucl: round(grand + constants.A2 * averageRange),
    lcl: round(grand - constants.A2 * averageRange),
  }
  const rangeChart = {
    cl: round(averageRange),
    ucl: round(constants.D4 * averageRange),
    lcl: round(constants.D3 * averageRange),
  }
  const outOf = (value, limits) => value > limits.ucl || value < limits.lcl
  return {
    kind: 'control',
    title: `${options.variable} 的控制图（X̄–R）`,
    variable: options.variable,
    subgroup: options.subgroup ?? null,
    size,
    points,
    meanChart,
    rangeChart,
    violations: {
      mean: points.map((point, position) => (outOf(point.mean, meanChart) ? position : -1)).filter((position) => position >= 0),
      range: points.map((point, position) => (outOf(point.range, rangeChart) ? position : -1)).filter((position) => position >= 0),
    },
  }
}

// A Pareto chart is a bar chart whose bars are sorted by size, with the
// cumulative percentage drawn on a second axis. SPSS puts it under 质量控制;
// PSPP has no such procedure, so the counting happens here. The reference line
// marks the share at which the "vital few" end — 80% by default.
export function computePareto(dataset, options = {}) {
  const rows = rowsOf(dataset)
  const variable = dataset.variables.find((entry) => entry.name === options.variable)
  if (!variable) throw new Error(`没有这个变量：${options.variable}`)
  const index = column(dataset, options.variable)
  const reference = Number(options.reference ?? 80)
  if (!Number.isFinite(reference) || reference <= 0 || reference >= 100) {
    throw new Error('参考线的百分比要在 0 到 100 之间（不含两端）')
  }
  const buckets = new Map()
  let total = 0
  for (const row of rows) {
    const raw = row[index]
    if (raw === null || raw === undefined) continue
    const value = variableValue(variable, raw)
    if (value === null) continue
    const key = String(value)
    const bucket = buckets.get(key) ?? { key, label: labelFor(variable, value), count: 0 }
    bucket.count += 1
    buckets.set(key, bucket)
    total += 1
  }
  if (total === 0) throw new Error('no valid cases for this chart')
  // Ties fall back to the code order so two runs of the same data draw the same
  // picture; sorting by label would depend on the locale.
  const sorted = [...buckets.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
  const limit = Math.trunc(Number(options.maxCategories ?? 0))
  const shown = limit > 0 && sorted.length > limit ? sorted.slice(0, limit) : sorted
  const folded = limit > 0 && sorted.length > limit ? sorted.slice(limit) : []
  let running = 0
  const bars = shown.map((bucket) => {
    running += bucket.count
    return { label: bucket.label, count: bucket.count, cumulative: round((100 * running) / total) }
  })
  if (folded.length) {
    const count = folded.reduce((sum, bucket) => sum + bucket.count, 0)
    running += count
    bars.push({ label: '其他', count, cumulative: round((100 * running) / total), folded: folded.length })
  }
  return {
    kind: 'pareto',
    title: `${options.variable} 的帕累托图`,
    variable: options.variable,
    total,
    bars,
    reference,
    categories: sorted.length,
  }
}

export function computeProbabilityPlot(dataset, options = {}) {
  const variable = dataset.variables.find((entry) => entry.name === options.variable)
  if (!variable) throw new Error(`没有这个变量：${options.variable}`)
  if (!numeric(variable)) throw new Error(`${options.variable} 不是数值变量：P-P / Q-Q 图只能对连续变量画`)
  const index = column(dataset, options.variable)
  const values = []
  for (const row of rowsOf(dataset)) {
    const value = variableValue(variable, row[index])
    if (value !== null) values.push(value)
  }
  if (values.length < 3) throw new Error('有效个案不足 3 个：P-P / Q-Q 图至少要有三个值')
  values.sort((left, right) => left - right)
  const n = values.length
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  const sd = Math.sqrt(Math.max(variance, 0))
  if (!(sd > 0)) throw new Error(`${options.variable} 的取值全都一样，画不出 P-P / Q-Q 图`)
  const wanted = String(options.plot ?? 'pp').toLowerCase()
  const qq = wanted === 'qq'
  const points = []
  for (let i = 0; i < n; i += 1) {
    // 中位秩，和 SPSS 用的一致：既不把点固定到 0 也不固定到 1。
    const observed = (i + 0.5) / n
    if (qq) points.push([values[i], mean + sd * inverseNormal(observed)])
    else points.push([observed, standardNormal((values[i] - mean) / sd)])
  }
  const label = variable.label || variable.name
  // 标题写成两段字面量：词典按「 的 P-P 图（正态分布）」这段去认，拼出来的
  // 模板字符串在死词条检查里不算引用。
  const title = qq ? label + ' 的 Q-Q 图（正态分布）' : label + ' 的 P-P 图（正态分布）'
  return {
    kind: 'scatter',
    points: points.map(([x, y]) => [round4(x), round4(y)]),
    diagonal: true,
    title,
    xLabel: qq ? '观测值' : '观测累积概率',
    yLabel: qq ? '期望值（正态）' : '期望累积概率',
  }
}

// Abramowitz & Stegun 26.2.23 的逆正态补，精度约 4.5e-4，够画图用。
function inverseNormal(probability) {
  const p = Math.min(Math.max(probability, 1e-9), 1 - 1e-9)
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export function buildChartModel(dataset, kind, options = {}) {
  let model
  if (kind === 'bar') model = computeBar(dataset, options)
  else if (kind === 'histogram') model = computeHistogram(dataset, options)
  else if (kind === 'scatterplot' || kind === 'scatter') model = computeScatter(dataset, options)
  else if (kind === 'boxplot' || kind === 'box') model = computeBox(dataset, options)
  else if (kind === 'line') model = options.y2 ? computeDualLine(dataset, options) : computeLine(dataset, options)
  else if (kind === 'pie') model = computePie(dataset, options)
  else if (kind === 'area') model = computeArea(dataset, options)
  else if (kind === 'ppplot' || kind === 'probability') model = computeProbabilityPlot(dataset, options)
  else if (kind === 'pareto') model = computePareto(dataset, options)
  else if (kind === 'control' || kind === 'xbar') model = computeControlChart(dataset, options)
  else {
    // km, dendrogram and timeseries are built by the host's own factories, so
    // they do not belong in this list — naming them here is what made the error
    // read "unknown chart type: km (available: …, km)".
    const known = ['bar', 'histogram', 'boxplot', 'line', 'pie', 'area', 'scatter', 'scatterplot', 'ppplot', 'pareto', 'control']
    throw new Error(`不认识的图型：${kind}（可用：${known.join('、')}；生存曲线、树状图与时间序列由宿主的专用工厂画）`)
  }
  return applyChartOverrides(model, options)
}
