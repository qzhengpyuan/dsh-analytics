// 功效与样本量：这类计算在写方法学一节时会用到（「每组需要 N 例，按 α=0.05、
// 双侧、把握度 0.80 估算」），PSPP 自己不提供，所以由插件算。
//
// 分布反演一律走数值方法，不抄近似公式：t 检验用非中心 t（对卡方混合做
// Simpson 积分），方差分析与非中心卡方的检验分别用非中心 F 的 Poisson
// 权重不完全 Beta 表示与非中心卡方的 Poisson 权重不完全 Gamma 表示。
import { incompleteBeta, incompleteGamma, lgamma, normalCdf, normalQuantile } from './dist.js'

/** 非中心 t 的尾概率 P(T' ≥ t | df, δ)。 */
export function noncentralTupper(t, df, delta) {
  if (!(df > 0)) throw new Error(`自由度要大于 0：收到 ${df}`)
  // 大自由度时非中心 t 与正态几乎相同（差在 1e-4 以下），直接退正态。
  if (df > 400) return 1 - normalCdf(t - delta)
  // P(T' ≥ t) = ∫₀^∞ Φ(δ − t·√(2u/df)) · u^{df/2−1} e^{−u} / Γ(df/2) du，
  // 其中 u = df·w/2，w 是卡方的商变量。
  const shape = df / 2
  const logNorm = lgamma(shape)
  const upper = Math.max(40, 3 * shape + 40)
  const steps = 4000
  const h = upper / steps
  let sum = 0
  for (let index = 0; index <= steps; index += 1) {
    const u = index * h
    const weight = index === 0 || index === steps ? 1 : index % 2 === 0 ? 2 : 4
    // u = 0 时 shape < 1 会给出无穷，密度在端点按 0 处理（积分贡献可忽略）。
    let density = 0
    if (u > 0) density = Math.exp((shape - 1) * Math.log(u) - u - logNorm)
    const z = delta - t * Math.sqrt((2 * u) / df)
    sum += weight * normalCdf(z) * density
  }
  return Math.min(1, Math.max(0, (sum * h) / 3))
}

/** 非中心 F 的尾概率 P(F' ≥ f | df1, df2, λ)。 */
export function noncentralFupper(f, df1, df2, lambda) {
  if (f <= 0) return 1
  const x = (df1 * f) / (df1 * f + df2)
  // P(F' ≤ f) = Σ_j Pois(j; λ/2) · I_x(df1/2 + j, df2/2)
  const half = lambda / 2
  let total = 0
  let weight = Math.exp(-half)
  for (let j = 0; j < 400; j += 1) {
    if (weight < 1e-15 && j > half) break
    total += weight * incompleteBeta(x, df1 / 2 + j, df2 / 2)
    weight *= half / (j + 1)
  }
  // incompleteGamma 给的是上侧 Q，所以这里已经是 P(χ'² ≥ x)。
  return Math.min(1, Math.max(0, 1 - total))
}

/** 非中心卡方的尾概率 P(χ'² ≥ x | df, nc)。 */
export function noncentralChiSquareUpper(x, df, nc) {
  if (x <= 0) return 1
  const half = nc / 2
  let total = 0
  let weight = Math.exp(-half)
  for (let j = 0; j < 500; j += 1) {
    if (weight < 1e-15 && j > half) break
    total += weight * incompleteGamma(df / 2 + j, x / 2)
    weight *= half / (j + 1)
  }
  return Math.min(1, Math.max(0, total))
}

/** 双侧 t 检验的临界值（用不完全 Beta 反解，二分 60 次够到 1e-9）。 */
export function tCritical(df, alpha) {
  let low = 0
  let high = 100
  for (let index = 0; index < 200; index += 1) {
    const mid = (low + high) / 2
    const tail = 0.5 * incompleteBeta(df / (df + mid * mid), df / 2, 0.5)
    if (tail > alpha / 2) low = mid
    else high = mid
  }
  return (low + high) / 2
}

const twoSidedPowerT = (ncp, df, alpha) => {
  const critical = tCritical(df, alpha)
  return noncentralTupper(critical, df, ncp) + noncentralTupper(critical, df, -ncp)
}

/**
 * 按方法与参数算功效或样本量。
 *
 * `options.mode`：`'sample'`（给定效应量与把握度，求每组例数）或
 * `'power'`（给定例数与效应量，求把握度）。返回真实算出的数字，不给「大概」。
 */
export function computePower(options = {}) {
  const method = String(options.method ?? 'ttest-two')
  const KNOWN = ['ttest-one', 'ttest-two', 'ttest-paired', 'correlation', 'anova', 'proportions', 'chisquare']
  // 先验方法名：方法写错时应该直接说「没有这个方法」，而不是先抱怨缺效应量。
  if (!KNOWN.includes(method)) {
    throw new Error(`没有这个方法：${method}（可用 ttest-one、ttest-two、ttest-paired、correlation、anova、proportions、chisquare）`)
  }
  const alpha = Number(options.alpha ?? 0.05)
  if (!(alpha > 0 && alpha < 1)) throw new Error(`α 要在 (0, 1) 里：收到 ${options.alpha}`)
  const target = Number(options.power ?? 0.8)
  if (!(target > 0 && target < 1)) throw new Error(`把握度要在 (0, 1) 里：收到 ${options.power}`)
  const mode = String(options.mode ?? 'sample')
  if (mode !== 'sample' && mode !== 'power') throw new Error(`mode 只能是 sample 或 power：收到 ${mode}`)

  const effect = Number(options.effect)
  const n = Number(options.n ?? options.nPerGroup)
  const groups = Math.max(2, Math.round(Number(options.groups ?? 2)))

  if (mode === 'sample' && method !== 'proportions' && !(Number.isFinite(effect) && effect !== 0)) {
    throw new Error('求样本量要给效应量 effect（t 检验用 Cohen\'s d，方差分析用 f，相关用 r，卡方用 w）')
  }
  if (mode === 'power' && !(Number.isFinite(n) && n >= 2)) {
    throw new Error(`求把握度要给每组例数 n（至少 2）：收到 ${options.n}`)
  }

  // 每种方法：给每组例数 → 把握度；反过来搜最小例数。
  const powerAt = (perGroup) => {
    if (method === 'ttest-one') {
      return twoSidedPowerT(Math.abs(effect) * Math.sqrt(perGroup), perGroup - 1, alpha)
    }
    if (method === 'ttest-two') {
      return twoSidedPowerT(Math.abs(effect) * Math.sqrt(perGroup / 2), 2 * perGroup - 2, alpha)
    }
    if (method === 'ttest-paired') {
      return twoSidedPowerT(Math.abs(effect) * Math.sqrt(perGroup), perGroup - 1, alpha)
    }
    if (method === 'correlation') {
      // 相关用 Fisher z 的闭式解：z = atanh(r)，临界值按 n−3 的正态。
      const z = 0.5 * Math.log((1 + Math.abs(effect)) / (1 - Math.abs(effect)))
      const se = 1 / Math.sqrt(Math.max(1, perGroup - 3))
      const critical = normalQuantile(1 - alpha / 2) * se
      return normalCdf((z - critical) / se) + normalCdf((-z - critical) / se)
    }
    if (method === 'anova') {
      const lambda = perGroup * groups * effect * effect
      const df1 = groups - 1
      const df2 = groups * (perGroup - 1)
      const fCritical = fCriticalValue(df1, df2, alpha)
      return noncentralFupper(fCritical, df1, df2, lambda)
    }
    if (method === 'proportions') {
      // 两独立比例：合并方差的 z 检验，按合计例数 n1 = n2 = perGroup。
      const p1 = Number(options.p1)
      const p2 = Number(options.p2)
      if (!(p1 >= 0 && p1 <= 1 && p2 >= 0 && p2 <= 1)) throw new Error('两比例要给 p1 与 p2（0 到 1 之间）')
      const pooled = (p1 + p2) / 2
      const se0 = Math.sqrt(2 * pooled * (1 - pooled) / perGroup)
      const se1 = Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / perGroup)
      if (se0 === 0) return 1
      const critical = normalQuantile(1 - alpha / 2)
      const delta = Math.abs(p2 - p1)
      return normalCdf((delta - critical * se0) / se1) + normalCdf((-delta - critical * se0) / se1)
    }
    if (method === 'chisquare') {
      const df = Math.max(1, Math.round(Number(options.df ?? 1)))
      const lambda = perGroup * effect * effect
      const critical = chiSquareCritical(df, alpha)
      return noncentralChiSquareUpper(critical, df, lambda)
    }
    throw new Error(`没有这个方法：${method}（可用 ttest-one、ttest-two、ttest-paired、correlation、anova、proportions、chisquare）`)
  }

  if (mode === 'power') {
    const value = powerAt(Math.round(n))
    return {
      method, mode, alpha, effect, n: Math.round(n), groups,
      power: value,
      note: `每组 ${Math.round(n)} 例时把握度 ${value.toFixed(3)}`,
    }
  }

  // 找最小的每组例数，使其把握度达标；上限 100000。
  let low = 2
  let high = 8
  while (powerAt(high) < target) {
    high *= 2
    if (high > 100000) throw new Error(`在每组 100000 例以内达不到把握度 ${target}：效应量太小`)
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (powerAt(mid) >= target) high = mid
    else low = mid + 1
  }
  const perGroup = low
  const achieved = powerAt(perGroup)
  const roundUpTo = Math.ceil(perGroup / 10) * 10
  return {
    method, mode, alpha, effect, groups,
    nPerGroup: perGroup,
    // chisquare 的 perGroup 就是总例数（非中心参数 λ = N·w²）；anova 每组相同。
    total: ['ttest-two', 'proportions'].includes(method) ? perGroup * 2
      : method === 'anova' ? perGroup * groups : perGroup,
    power: achieved,
    suggestion: roundUpTo > perGroup ? `取每组 ${roundUpTo} 例（多留 ${roundUpTo - perGroup} 例余地）` : `每组 ${perGroup} 例恰好够`,
    note: `按 α = ${alpha}、双侧、目标把握度 ${target} 估算`,
  }
}

/** F 分布上侧临界值（二分不完全 Beta）。 */
export function fCriticalValue(df1, df2, alpha) {
  let low = 0
  let high = 1000
  for (let index = 0; index < 200; index += 1) {
    const mid = (low + high) / 2
    const upper = 1 - incompleteBeta((df1 * mid) / (df1 * mid + df2), df1 / 2, df2 / 2)
    if (upper > alpha) low = mid
    else high = mid
  }
  return (low + high) / 2
}

/** 卡方分布上侧临界值（二分不完全 Gamma）。 */
export function chiSquareCritical(df, alpha) {
  let low = 0
  let high = 1000
  for (let index = 0; index < 200; index += 1) {
    const mid = (low + high) / 2
    if (incompleteGamma(df / 2, mid / 2) > alpha) low = mid
    else high = mid
  }
  return (low + high) / 2
}

/** 结果 → 面板里能看的一张表。 */
export function powerTable(result) {
  const rows = [['项目', '值']]
  const label = {
    'ttest-one': '单样本 t 检验', 'ttest-two': '独立样本 t 检验（每组相同）', 'ttest-paired': '配对 t 检验',
    correlation: 'Pearson 相关', anova: '单因素方差分析', proportions: '两独立比例', chisquare: '卡方拟合优度',
  }[result.method] ?? result.method
  rows.push(['方法', label])
  rows.push(['α（双侧）', String(result.alpha)])
  rows.push(['效应量', String(result.effect ?? '—')])
  if (result.nPerGroup !== undefined) {
    rows.push(['每组例数', String(result.nPerGroup)])
    rows.push(['合计例数', String(result.total)])
  }
  if (result.n !== undefined) rows.push(['每组例数（已定）', String(result.n)])
  rows.push(['把握度', result.power.toFixed(3)])
  const notes = [result.note, result.suggestion].filter(Boolean)
  return { caption: '功效与样本量', matrix: rows, notes }
}
