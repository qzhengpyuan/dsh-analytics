// 概率分布计算器（相当于 SPSS 的 CDF.* / IDF.* / PDF.* 函数，给一个对话框用）。
//
// 尾概率一律复用 lib/tables.js 那几个已经在用的实现（卡方、t、F 的 p 值），
// 这样计算器和 ANOVA / t 检验输出的 P 不可能对不上。正态分布在那里没有导出，
// 所以这里自己写一份 erfc；分位数统一用二分反查单调的累积函数 —— 与
// tables.js 的 fQuantile 同一套路，不引入新算法。
import { chiSquareP, studentP, fP } from './tables.js';

const SQRT2 = Math.SQRT2;
const SQRT2PI = Math.sqrt(2 * Math.PI);

// erfcc 有理逼近（|误差| < 1.2e-7），与 lib/poisson.js 同一份系数表。
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const coefficients = [-1.3026537197817094, 6.4196979235649026e-1,
    1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4,
    3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15];
  let d = 0;
  let dd = 0;
  for (let index = coefficients.length - 1; index > 0; index -= 1) {
    const tmp = d;
    d = ty * d - dd + coefficients[index];
    dd = tmp;
  }
  const answer = t * Math.exp(-z * z + 0.5 * (coefficients[0] + ty * d) - dd);
  return x >= 0 ? answer : 2 - answer;
}

function normalCdf(z) {
  return 0.5 * erfc(-z / SQRT2);
}

function normalPdf(z) {
  return Math.exp(-0.5 * z * z) / SQRT2PI;
}

// Acklam 的有理逼近给出 1.15e-9 的相对精度，再补一次牛顿修正到双精度。
function normalQuantile(probability) {
  if (!(probability > 0 && probability < 1)) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const low = 0.02425;
  const high = 1 - low;
  let x;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (probability <= high) {
    const q = probability - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // 一次 Halley 修正。
  const error = normalCdf(x) - probability;
  const u = error * SQRT2PI * Math.exp(0.5 * x * x);
  return x - u / (1 + 0.5 * x * u);
}

const logGammaCache = [0, 0];
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const coefficients = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (let index = 0; index < 6; index += 1) {
    y += 1;
    series += coefficients[index] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

function factorial(n) {
  if (n <= 1) return 1;
  let product = 1;
  for (let index = 2; index <= n; index += 1) product *= index;
  return product;
}

// 二分反查：累积函数单调，先翻倍找上界再对半分到双精度。
function invert(cumulative, probability, high = 1) {
  if (!(probability > 0 && probability < 1)) return null;
  let top = high;
  for (let step = 0; step < 200 && (cumulative(top) ?? 1) < probability; step += 1) {
    top *= 2;
    if (!Number.isFinite(top)) return null;
  }
  let low = 0;
  for (let step = 0; step < 400; step += 1) {
    const middle = (low + top) / 2;
    // 允许 1e-12 的差：离散分布的累积概率由对数伽马拼出，末位误差不该把
    // 「恰好等于 P(X ≤ k)」判成还差一点，否则分位数会退回上一个计数。
    if ((cumulative(middle) ?? 1) < probability - 1e-12) low = middle;
    else top = middle;
    if (top - low <= Math.abs(top) * 1e-15) break;
  }
  return (low + top) / 2;
}

function distributionOf(name) {
  switch (String(name ?? '').toLowerCase()) {
    case 'normal':
    case 'z':
      return 'normal';
    case 't':
    case 'student':
      return 't';
    case 'chi':
    case 'chi2':
    case 'chisquare':
      return 'chiSquare';
    case 'f':
      return 'f';
    case 'binomial':
    case 'binom':
      return 'binomial';
    case 'poisson':
      return 'poisson';
    default:
      return null;
  }
}

/**
 * Evaluates one distribution at one point.
 *
 * `x` is the statistic (for the discrete distributions: a count), `df1`/`df2`
 * are the degrees of freedom, `n`/`p` are the binomial size and probability,
 * `lambda` is the Poisson mean. The result carries the density or mass, the
 * cumulative probability at the point, both tails and (when `probability` is
 * given) the quantile, so a caller never has to combine pieces itself.
 */
export function computeDistribution(options = {}) {
  const name = distributionOf(options.distribution);
  if (!name) throw new Error('不认识的分布：可用 normal / t / chiSquare / f / binomial / poisson');
  const label = { normal: '正态', t: 't', chiSquare: '卡方', f: 'F', binomial: '二项', poisson: '泊松' }[name];
  const x = Number(options.x);
  if (!Number.isFinite(x)) throw new Error('要给定点 x（要算的那个统计量或计数）');
  const probability = options.probability === undefined || options.probability === null || options.probability === ''
    ? null
    : Number(options.probability);
  if (probability !== null && !(probability > 0 && probability < 1)) {
    throw new Error('累积概率要在 0 与 1 之间（不含端点）：分位数只在中间那段有定义');
  }

  const df1 = Number(options.df1);
  const df2 = Number(options.df2);
  const size = Number(options.n);
  const success = Number(options.p);
  const lambda = Number(options.lambda);

  const need = (value, description) => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}分布要给定${description}`);
  };

  let pdf;
  let cdf;
  let quantile = null;
  let support = '（−∞, +∞）';
  const extra = [];

  if (name === 'normal') {
    pdf = normalPdf(x);
    cdf = normalCdf(x);
    if (probability !== null) quantile = normalQuantile(probability);
  } else if (name === 't') {
    need(df1, '自由度 df');
    const twoSided = studentP(x, df1);
    if (twoSided === null) throw new Error('自由度必须是正数');
    cdf = x >= 0 ? 1 - twoSided / 2 : twoSided / 2;
    pdf = Math.exp(logGamma((df1 + 1) / 2) - logGamma(df1 / 2)) / Math.sqrt(df1 * Math.PI)
      * (1 + (x * x) / df1) ** (-(df1 + 1) / 2);
    if (probability !== null) quantile = invert((point) => (point >= 0 ? 1 - (studentP(point, df1) ?? 1) / 2 : (studentP(point, df1) ?? 2) / 2), probability);
    // 对称分布：上尾与下尾互换着看。
    support = '（−∞, +∞）';
  } else if (name === 'chiSquare') {
    need(df1, '自由度 df');
    cdf = 1 - (chiSquareP(x, df1) ?? 0);
    if (x <= 0) { cdf = 0; pdf = 0; } else {
      pdf = Math.exp((df1 / 2 - 1) * Math.log(x) - x / 2 - logGamma(df1 / 2) - (df1 / 2) * Math.log(2));
    }
    if (probability !== null) quantile = invert((point) => 1 - (chiSquareP(point, df1) ?? 0), probability);
    support = '（0, +∞）';
  } else if (name === 'f') {
    need(df1, '分子自由度 df1');
    need(df2, '分母自由度 df2');
    cdf = x <= 0 ? 0 : 1 - (fP(x, df1, df2) ?? 0);
    if (x <= 0) pdf = 0; else {
      pdf = Math.exp((df1 / 2) * Math.log(df1 / df2) + (df1 / 2 - 1) * Math.log(x)
        - ((df1 + df2) / 2) * Math.log(1 + (df1 * x) / df2)
        - logGamma(df1 / 2) - logGamma(df2 / 2) + logGamma((df1 + df2) / 2));
    }
    if (probability !== null) quantile = invert((point) => 1 - (fP(point, df1, df2) ?? 0), probability);
    support = '（0, +∞）';
  } else if (name === 'binomial') {
    if (!Number.isInteger(size) || size <= 0) throw new Error('二项分布要给定试验次数 n（正整数）');
    if (!(success >= 0 && success <= 1)) throw new Error('二项分布要给定成功概率 p（0 到 1 之间）');
    const k = Math.round(x);
    if (k < 0 || k > size) { cdf = k < 0 ? 0 : 1; pdf = 0; } else {
      pdf = Math.exp(logGamma(size + 1) - logGamma(k + 1) - logGamma(size - k + 1)
        + k * Math.log(success || Number.MIN_VALUE) + (size - k) * Math.log(1 - success || Number.MIN_VALUE));
      let total = 0;
      for (let index = 0; index <= k; index += 1) {
        total += Math.exp(logGamma(size + 1) - logGamma(index + 1) - logGamma(size - index + 1)
          + index * Math.log(success || Number.MIN_VALUE) + (size - index) * Math.log(1 - success || Number.MIN_VALUE));
      }
      cdf = Math.min(1, total);
    }
    if (probability !== null) {
      quantile = invert((point) => {
        const limit = Math.floor(point);
        let total = 0;
        for (let index = 0; index <= Math.min(limit, size); index += 1) {
          total += Math.exp(logGamma(size + 1) - logGamma(index + 1) - logGamma(size - index + 1)
            + index * Math.log(success || Number.MIN_VALUE) + (size - index) * Math.log(1 - success || Number.MIN_VALUE));
        }
        return Math.min(1, total);
      }, probability, size);
      // 二分只会逼到 4.999999999999998 这种邻近值，取整到最近的计数，不能 floor。
      quantile = Math.round(quantile);
    }
    support = `0 … ${size}`;
    extra.push(`期望 np = ${(size * success).toFixed(4)}，方差 np(1−p) = ${(size * success * (1 - success)).toFixed(4)}`);
  } else {
    need(lambda, '均值 λ');
    const k = Math.round(x);
    if (k < 0) { cdf = 0; pdf = 0; } else {
      pdf = Math.exp(-lambda + k * Math.log(lambda) - logGamma(k + 1));
      let total = 0;
      for (let index = 0; index <= k; index += 1) total += Math.exp(-lambda + index * Math.log(lambda) - logGamma(index + 1));
      cdf = Math.min(1, total);
    }
    if (probability !== null) {
      quantile = invert((point) => {
        const limit = Math.floor(point);
        let total = 0;
        for (let index = 0; index <= limit; index += 1) total += Math.exp(-lambda + index * Math.log(lambda) - logGamma(index + 1));
        return Math.min(1, total);
      }, probability, Math.max(10, lambda * 2));
      quantile = Math.round(quantile);
    }
    support = '0 … ∞';
    extra.push(`期望 = 方差 = λ = ${lambda}`);
  }

  const discrete = name === 'binomial' || name === 'poisson';
  return {
    distribution: name,
    label,
    x,
    support,
    discrete,
    pdf,
    cdf,
    lowerTail: cdf,
    upperTail: 1 - cdf,
    twoSided: Math.min(1, 2 * Math.min(cdf, 1 - cdf)),
    probability,
    quantile,
    parameters: {
      df1: Number.isFinite(df1) ? df1 : null,
      df2: Number.isFinite(df2) ? df2 : null,
      n: Number.isFinite(size) ? size : null,
      p: Number.isFinite(success) ? success : null,
      lambda: Number.isFinite(lambda) ? lambda : null,
    },
    notes: [
      `${label}分布在 x = ${x} 处：${discrete ? '概率质量' : '密度'} ${pdf.toFixed(6)}，累积概率 ${cdf.toFixed(6)}。`,
      `单侧上尾 P(X ≥ x) = ${(1 - cdf).toFixed(6)}；双侧 = ${Math.min(1, 2 * Math.min(cdf, 1 - cdf)).toFixed(6)}。`,
      probability !== null && quantile !== null
        ? `累积概率 ${probability} 对应的分位数 = ${quantile.toFixed(6)}。`
        : '想算分位数就填一个累积概率（比如 0.975）。',
      discrete ? '离散分布的上尾按累积函数算：P(X ≥ x) = 1 − P(X ≤ x − 1)，两者差一个点概率。' : null,
      ...extra,
    ].filter(Boolean),
  };
}

export { normalCdf, normalQuantile, factorial };
