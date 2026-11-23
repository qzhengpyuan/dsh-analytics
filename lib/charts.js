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
  if (index < 0) throw new Error(`unknown variable: ${name}`)
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
  if (!valueVariable) throw new Error(`unknown variable: ${options.variable}`)
  if (!numeric(valueVariable)) throw new Error(`${options.variable} must be numeric`)
  const valueIndex = column(dataset, options.variable)
  const byVariable = options.by ? dataset.variables.find((variable) => variable.name === options.by) : null
  if (options.by && !byVariable) throw new Error(`unknown variable: ${options.by}`)
  const byIndex = options.by ? column(dataset, options.by) : -1
  const statistic = String(options.statistic ?? 'MEAN').toUpperCase()

  // A clustered or stacked bar has two grouping variables: `cluster` splits the
  // bars along the category axis, `stack` splits each bar into segments.
  const clusterVariable = options.cluster ? dataset.variables.find((variable) => variable.name === options.cluster) : null
  if (options.cluster && !clusterVariable) throw new Error(`unknown variable: ${options.cluster}`)
  const stackVariable = options.stack ? dataset.variables.find((variable) => variable.name === options.stack) : null
  if (options.stack && !stackVariable) throw new Error(`unknown variable: ${options.stack}`)
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
    const key = byIndex >= 0 ? variableValue(byVariable, row[byIndex]) : '__all__'
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
      label: byIndex >= 0 ? labelFor(byVariable, key) : '全部个案',
      cluster: cluster === null ? null : labelFor(clusterVariable, cluster),
      clusterKey: cluster === null ? null : String(cluster),
      stack: stack === null ? null : labelFor(stackVariable, stack),
      stackKey: stack === null ? null : String(stack),
    }
    bucket.values.push(value)
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
    title: `${byVariable ? `${valueName} 按 ${byName}` : valueName}${
      clusterVariable ? `，分组：${clusterName}` : stackVariable ? `，堆叠：${stackName}` : ''
    }（${statistic === 'COUNT' ? '个案数' : statistic === 'SUM' ? '总和' : '均值'}${
      categories.some((entry) => entry.errorLow !== undefined) ? `，${ERROR_BAR_LABELS[barMode]}` : ''
    }）`,
    xLabel: byName,
    yLabel: statistic === 'COUNT' ? '个案数' : statistic === 'SUM' ? '总和' : '均值',
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
  if (!variable) throw new Error(`unknown variable: ${options.variable}`)
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
  if (!xVariable) throw new Error(`unknown variable: ${options.x}`)
  if (!yVariable) throw new Error(`unknown variable: ${options.y}`)
  if (!numeric(xVariable) || !numeric(yVariable)) throw new Error('scatterplot needs two numeric variables')
  const xi = column(dataset, options.x)
  const yi = column(dataset, options.y)
  const points = []
  for (const row of rows) {
    const x = variableValue(xVariable, row[xi])
    const y = variableValue(yVariable, row[yi])
    if (x === null || y === null) continue
    points.push([x, y])
  }
  if (points.length === 0) throw new Error('no valid cases for this chart')
  const limit = 1500
  const step = Math.ceil(points.length / limit)
  const sampled = step > 1 ? points.filter((_, index) => index % step === 0) : points
  return {
    kind: 'scatter',
    title: `${yVariable.label || options.y} 与 ${xVariable.label || options.x} 的散点图`,
    xLabel: xVariable.label || options.x,
    yLabel: yVariable.label || options.y,
    points: sampled.map(([x, y]) => [round(x, 4), round(y, 4)]),
    total: points.length,
  }
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
  if (!valueVariable) throw new Error(`unknown variable: ${options.variable}`)
  if (!numeric(valueVariable)) throw new Error(`${options.variable} must be numeric`)
  const valueIndex = column(dataset, options.variable)
  const byVariable = options.by ? dataset.variables.find((variable) => variable.name === options.by) : null
  if (options.by && !byVariable) throw new Error(`unknown variable: ${options.by}`)
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
  if (!variable) throw new Error(`unknown variable: ${options.variable}`)
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

export function renderSvg(model) {
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

  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`)
  parts.push(`<text x="${WIDTH / 2}" y="22" text-anchor="middle" font-size="13" font-weight="600" fill="#1a3a63">${escapeXml(model.title)}</text>`)
  // A subtitle carries what the title cannot: the statistic, the sample, the
  // filter that was applied. It sits under the title in a lighter weight so the
  // heading still reads as one block.
  if (typeof model.subtitle === 'string' && model.subtitle.trim()) {
    parts.push(`<text x="${WIDTH / 2}" y="36" text-anchor="middle" font-size="10" fill="#5a6b82">${escapeXml(model.subtitle.trim())}</text>`)
  }

  if (model.kind === 'bar') {
    parts.push(...renderBar(model, plot, axisValue, accent))
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
    for (const [x, y] of model.points) {
      parts.push(`<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="2.4" fill="${accent ?? '#2f6fbb'}" fill-opacity="0.55"/>`)
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family='${FONT}'>${parts.join('')}</svg>\n`
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

export function buildChartModel(dataset, kind, options = {}) {
  let model
  if (kind === 'bar') model = computeBar(dataset, options)
  else if (kind === 'histogram') model = computeHistogram(dataset, options)
  else if (kind === 'scatterplot' || kind === 'scatter') model = computeScatter(dataset, options)
  else if (kind === 'boxplot' || kind === 'box') model = computeBox(dataset, options)
  else if (kind === 'line') model = options.y2 ? computeDualLine(dataset, options) : computeLine(dataset, options)
  else if (kind === 'pie') model = computePie(dataset, options)
  else if (kind === 'area') model = computeArea(dataset, options)
  else throw new Error(`unsupported chart type: ${kind}`)
  return applyChartOverrides(model, options)
}
