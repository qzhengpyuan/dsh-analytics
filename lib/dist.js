// 统计分布里要用的几个特殊函数：gamme、不完全 Beta、不完全 Gamma、正态的
// 累积与分位。charts.js / tables.js 里各有一份私有的不完全 Beta（只为画图与
// 括号服务），功效计算需要更多，所以集中到这里，新代码别再复制第三份。

/** log Γ(x)，Lanczos 近似（g=7，n=9，x>0 时相对误差 < 1e-13）。 */
export function lgamma(x) {
  const p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  const z = x - 1
  let sum = p[0]
  for (let index = 1; index < 9; index += 1) sum += p[index] / (z + index)
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
}

const betaContinuedFraction = (a, b, x) => {
  const tiny = 1e-300
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
    if (Math.abs(delta - 1) < 1e-12) break
  }
  return h
}

/** 正则化不完全 Beta I_x(a, b)。 */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - (lgamma(a) + lgamma(b) - lgamma(a + b)))
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/** 正则化上侧不完全 Gamma Q(s, x) = 1 − P(s, x)。 */
export function incompleteGamma(s, x) {
  if (x <= 0) return 1
  if (x < s + 1) {
    // 级数展开 P(s, x)，再取 1 − P。
    let sum = 1 / s
    let term = sum
    for (let n = 1; n < 1000; n += 1) {
      term *= x / (s + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break
    }
    return 1 - sum * Math.exp(-x + s * Math.log(x) - lgamma(s))
  }
  // 连分式直接算 Q(s, x)。
  const tiny = 1e-300
  let b = x + 1 - s
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - s)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return h * Math.exp(-x + s * Math.log(x) - lgamma(s))
}

/** 标准正态的累积分布（Hart 1968 的 erfc，与 charts.js 用的是同一支）。 */
export function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.5 * x)
  const erf = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
      + t * (-0.82215223 + t * 0.17087277)))))))))
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/** 标准正态的分位数（Acklam 的逆误差函数近似，相对误差 < 1.2e-9）。 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`概率要在 (0, 1) 里：收到 ${p}`)
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00]
  const low = 0.02425
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}
