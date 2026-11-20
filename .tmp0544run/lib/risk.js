/**
 * Confidence interval for the difference of two proportions, which PSPP prints
 * only for the odds ratio and the relative risk (its "Risk Estimate" table), and
 * never for the risk difference.
 *
 * The method is Newcombe's hybrid score (his "method 10"): each proportion gets
 * a Wilson score interval, and the two are combined into an interval for the
 * difference by adding the squared distances to the point estimate in
 * quadrature. Newcombe (1998, Stat Med 17:857-872) shows it keeps close to the
 * nominal coverage at the small counts a 2×2 table usually has, without the
 * conservatism of an exact unconditional interval — and unlike the Wald
 * interval it does not collapse to a point when a cell is empty.
 */

/** Inverse standard normal CDF, Abramowitz & Stegun 26.2.23 plus a refinement. */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return null
  // Acklam's rational approximation, accurate to about 1.15e-9.
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00]
  const low = 0.02425
  let x
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else {
    const q = p - 0.5
    const r = q * q
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  // One Halley step against the erfc-based CDF.
  const tail = 0.5 * erfc(-x / Math.SQRT2) - p
  const density = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
  const step = tail / density
  return x - step / (1 + (x * step) / 2)
}

/** Complementary error function, Numerical Recipes' erfcc (|error| < 1.2e-7). */
function erfc(x) {
  const z = Math.abs(x)
  const t = 1 / (1 + z / 2)
  const value = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? value : 2 - value
}

/** Wilson score interval for one proportion, the building block of method 10. */
export function wilsonInterval(successes, total, z) {
  if (!(total > 0)) return null
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))
  return {
    p,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  }
}

/**
 * Newcombe's hybrid score interval (method 10) for p1 − p2.
 *
 * @param {number} first successes in group 1
 * @param {number} firstTotal cases in group 1
 * @param {number} second successes in group 2
 * @param {number} secondTotal cases in group 2
 * @param {number} level confidence level, 0.90 / 0.95 / 0.99
 */
export function riskDifferenceCi(first, firstTotal, second, secondTotal, level = 0.95) {
  if (!(firstTotal > 0) || !(secondTotal > 0)) return null
  const z = normalQuantile(1 - (1 - level) / 2)
  if (!z) return null
  const left = wilsonInterval(first, firstTotal, z)
  const right = wilsonInterval(second, secondTotal, z)
  if (!left || !right) return null
  const difference = left.p - right.p
  // The distance from each point estimate to its own interval edge, added in
  // quadrature: that is what makes the interval behave at empty cells.
  const shift = Math.sqrt((left.p - left.low) ** 2 + (right.high - right.p) ** 2)
  const other = Math.sqrt((left.high - left.p) ** 2 + (right.p - right.low) ** 2)
  return {
    difference,
    low: Math.max(-1, difference - shift),
    high: Math.min(1, difference + other),
    level,
    z,
    first: { p: left.p, low: left.low, high: left.high, total: firstTotal },
    second: { p: right.p, low: right.low, high: right.high, total: secondTotal },
  }
}

/** `wave=1「第一波」` for one side of the crosstab, or null when nothing is known. */
function describeCategory(part) {
  if (part === null || part === undefined) return null
  if (typeof part === 'string') return part.trim() || null
  const name = String(part.name ?? '').trim()
  const value = String(part.value ?? '').trim()
  const label = String(part.label ?? '').trim()
  const head = name && value ? `${name}=${value}` : (name || value)
  if (!head) return label || null
  // PSPP 交叉表在变量有值标签时打的是标签、没有时打的是取值；两个都拿到了才
  // 同时写，避免 `wave=1「1」` 这种把取值当标签的重复。
  if (label && label !== head && label !== value) return `${head}「${label}」`
  return head
}

/** `第 2 行（女）`, falling back to the bare position when there is no label. */
function describeRowCategory(part, index) {
  if (typeof part === 'string') {
    const text = part.trim()
    return text ? `第 ${index} 行（${text}）` : `第 ${index} 行`
  }
  if (part === null || part === undefined) return `第 ${index} 行`
  // 行的括号里只要类别值（男/女），不要再带一遍 `g=1`：事件列已经点了变量名。
  const text = String(part.label ?? '').trim() || String(part.value ?? '').trim()
  return text ? `第 ${index} 行（${text}）` : `第 ${index} 行`
}

/**
 * The sentence appended to the crosstab: the difference and its interval.
 *
 * `options.label` keeps the old free-form wording. The structured form names the
 * event column and both rows, because PSPP's own "Risk Estimate" table is per
 * column ("For cohort wave = 1") while this note is per row: without the real
 * category values the two look like they disagree.
 */
export function describeRiskDifference(result, options = {}) {
  if (!result) return null
  const percent = Math.round(result.level * 100)
  const fixed = (value) => value.toFixed(3)
  const event = describeCategory(options.event)
  const structured = Boolean(event) || (options.event !== undefined && options.event !== null)
  // With a structured event, the event column is written even when its label is
  // missing: "第 1 列" at least tells the reader which one was used.
  const subject = structured
    ? `事件列 = ${event ?? '第 1 列'}；${describeRowCategory(options.rows?.[0], 1)} − ${describeRowCategory(options.rows?.[1], 2)}`
    : (options.label ?? '第 1 行 − 第 2 行')
  const sentence = `风险差（插件计算）：${subject} = ${fixed(result.difference)}（${fixed(result.first.p)} − ${fixed(result.second.p)}），`
    + `${percent}% 置信区间 ${fixed(result.low)} ~ ${fixed(result.high)}（Newcombe 混合得分法，各比例的区间用 Wilson 得分法）`
  const mirror = describeRiskMirror(options.other)
  return mirror ? `${sentence}；${mirror}` : sentence
}

/**
 * Why the note is a difference and not a ratio: swapping which column counts as
 * the event flips the sign and mirrors the interval, so a reader comparing it
 * with PSPP's per-cohort rows is not looking at a contradiction.
 */
export function describeRiskMirror(other) {
  if (other === null || other === undefined) return null
  const text = describeCategory(other)
  if (!text) return '把事件列换成另一列时差值是相反数，区间关于 0 对称'
  // `wave=2` then `时` needs a space to stay readable; `wave=2「第二波」时` does not.
  const spacer = /[\x21-\x7e]$/.test(text) ? ' ' : ''
  return `把事件列换成 ${text}${spacer}时差值是相反数，区间关于 0 对称`
}
