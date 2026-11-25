// 曲线估计（SPSS 的「分析 → 回归 → 曲线估计」，CURVEFIT）。
//
// PSPP 2.1.3 没有 CURVEFIT，所以这 11 个模型都在插件里拟合。除二次、三次
// 直接是多元线性回归外，其余模型先取对数（或倒数）线性化，再按 SPSS 的
// 口径报数：
//
//   * 表里的「R²」是**线性化之后**那个回归的 R²（SPSS 同样口径）；
//   * 另给一列「原始尺度 R²」= 1 − 残差平方和 / 总平方和，用的还是原尺度的
//     y。两者不一致时说明线性化把残差结构改了样，读者要看得见；
//   * 系数一律报回**模型自己的参数化**（b0/b1/…），不是线性化后的截距。
//
// 线性化模型对数据有取值要求（对数要 x > 0，取对数 y 要 y > 0）—— 不满足
// 的个案被剔除并计数，静默丢掉会让人以为它们参与了拟合。
import { invert } from './linalg.js'
import { fP } from './tables.js'
import { isUserMissing } from './missing.js'

const fixed = (value, digits = 4) => Number(value).toFixed(digits)
const pText = (value) => {
  if (!Number.isFinite(value)) return '—'
  if (value < 0.001) return '< 0.001'
  return fixed(value, 6).replace(/0+$/, '').replace(/\.$/, '')
}
const blank = (value) => value === null || value === undefined || value === ''

function numeric(variable) {
  return variable?.type !== 'string'
}

function columnOf(dataset, name) {
  const index = dataset.variables.findIndex((variable) => variable.name === name)
  if (index < 0) throw new Error(`没有这个变量：${name}`)
  return index
}

// 每个模型给出：线性化后的设计矩阵构造（自变量那一列）、y 的变换、以及把
// 线性化系数翻译回模型系数的办法。
export const MODELS = [
  {
    key: 'linear',
    label: '线性',
    expression: 'y = b0 + b1·x',
    terms: 1,
    design: (x) => [1, x],
    transform: (x, y) => ({ xs: [1, x], y }),
    report: (beta) => [beta[0], beta[1]],
    requires: {},
  },
  {
    key: 'logarithmic',
    label: '对数',
    expression: 'y = b0 + b1·ln(x)',
    terms: 1,
    design: (x) => [1, Math.log(x)],
    transform: (x, y) => ({ xs: [1, Math.log(x)], y }),
    report: (beta) => [beta[0], beta[1]],
    requires: { x: 'positive' },
  },
  {
    key: 'inverse',
    label: '逆',
    expression: 'y = b0 + b1/x',
    terms: 1,
    design: (x) => [1, 1 / x],
    transform: (x, y) => ({ xs: [1, 1 / x], y }),
    report: (beta) => [beta[0], beta[1]],
    requires: { x: 'nonzero' },
  },
  {
    key: 'quadratic',
    label: '二次',
    expression: 'y = b0 + b1·x + b2·x²',
    terms: 2,
    design: (x) => [1, x, x * x],
    transform: (x, y) => ({ xs: [1, x, x * x], y }),
    report: (beta) => [beta[0], beta[1], beta[2]],
    requires: {},
  },
  {
    key: 'cubic',
    label: '三次',
    expression: 'y = b0 + b1·x + b2·x² + b3·x³',
    terms: 3,
    design: (x) => [1, x, x * x, x * x * x],
    transform: (x, y) => ({ xs: [1, x, x * x, x * x * x], y }),
    report: (beta) => [beta[0], beta[1], beta[2], beta[3]],
    requires: {},
  },
  {
    key: 'compound',
    label: '复合',
    expression: 'y = b0·b1^x',
    terms: 1,
    design: (x) => [1, x],
    transform: (x, y) => ({ xs: [1, x], y: Math.log(y) }),
    report: (beta) => [Math.exp(beta[0]), Math.exp(beta[1])],
    requires: { y: 'positive' },
  },
  {
    key: 'power',
    label: '幂',
    expression: 'y = b0·x^b1',
    terms: 1,
    design: (x) => [1, Math.log(x)],
    transform: (x, y) => ({ xs: [1, Math.log(x)], y: Math.log(y) }),
    report: (beta) => [Math.exp(beta[0]), beta[1]],
    requires: { x: 'positive', y: 'positive' },
  },
  {
    key: 's',
    label: 'S',
    expression: 'y = e^(b0 + b1/x)',
    terms: 1,
    design: (x) => [1, 1 / x],
    transform: (x, y) => ({ xs: [1, 1 / x], y: Math.log(y) }),
    report: (beta) => [beta[0], beta[1]],
    requires: { x: 'nonzero', y: 'positive' },
  },
  {
    key: 'growth',
    label: '增长',
    expression: 'y = e^(b0 + b1·x)',
    terms: 1,
    design: (x) => [1, x],
    transform: (x, y) => ({ xs: [1, x], y: Math.log(y) }),
    // 增长模型的 b0、b1 就是线性化后的截距与斜率，**不取指数**：指数在
    // e^(b0+b1·x) 的写法里是模型本身的结构，不是参数的一部分。复合模型
    // 不同（y = b0·b1^x），那里 b0、b1 才要还原成指数。
    report: (beta) => [beta[0], beta[1]],
    requires: { y: 'positive' },
  },
  {
    key: 'exponential',
    label: '指数',
    expression: 'y = b0·e^(b1·x)',
    terms: 1,
    design: (x) => [1, x],
    transform: (x, y) => ({ xs: [1, x], y: Math.log(y) }),
    report: (beta) => [Math.exp(beta[0]), beta[1]],
    requires: { y: 'positive' },
  },
  {
    key: 'logistic',
    label: 'Logistic',
    expression: 'y = 1/(1/u + b0·b1^x)',
    terms: 1,
    design: (x) => [1, x],
    transform: (x, y, upper) => ({ xs: [1, x], y: Math.log(1 / y - 1 / upper) }),
    report: (beta) => [Math.exp(beta[0]), Math.exp(beta[1])],
    requires: { y: 'positive', upper: true },
  },
]

export const MODEL_KEYS = MODELS.map((model) => model.key)

const DEFAULTS = ['linear', 'logarithmic', 'inverse', 'quadratic', 'cubic', 'compound', 'power', 's', 'growth', 'exponential', 'logistic']

function modelOf(key) {
  const wanted = String(key ?? '').toLowerCase()
  const hit = MODELS.find((model) => model.key === wanted)
  if (!hit) {
    throw new Error(`不认识的曲线模型：${key}（可用：${MODELS.map((model) => model.key).join(' / ')}）`)
  }
  return hit
}

function evaluate(model, coefficients, x) {
  switch (model.key) {
    case 'linear': return coefficients[0] + coefficients[1] * x
    case 'logarithmic': return coefficients[0] + coefficients[1] * Math.log(x)
    case 'inverse': return coefficients[0] + coefficients[1] / x
    case 'quadratic': return coefficients[0] + coefficients[1] * x + coefficients[2] * x * x
    case 'cubic': return coefficients[0] + coefficients[1] * x + coefficients[2] * x * x + coefficients[3] * x * x * x
    case 'compound': return coefficients[0] * coefficients[1] ** x
    case 'power': return coefficients[0] * x ** coefficients[1]
    case 's': return Math.exp(coefficients[0] + coefficients[1] / x)
    case 'growth': return Math.exp(coefficients[0] + coefficients[1] * x)
    case 'exponential': return coefficients[0] * Math.exp(coefficients[1] * x)
    case 'logistic': return 1 / (1 / coefficients.upper + coefficients[0] * coefficients[1] ** x)
    default: return Number.NaN
  }
}

export function evaluateCurve(model, coefficients, x) {
  return evaluate(modelOf(model), coefficients, x)
}

export function computeCurveEstimate(dataset, options = {}) {
  const dependent = String(options.dependent ?? '').trim()
  const independent = String(options.independent ?? '').trim()
  if (!dependent) throw new Error('曲线估计要指定因变量')
  if (!independent) throw new Error('曲线估计要指定自变量')
  if (dependent === independent) throw new Error('因变量与自变量不能是同一个变量')
  const yIndex = columnOf(dataset, dependent)
  const xIndex = columnOf(dataset, independent)
  const yVariable = dataset.variables[yIndex]
  const xVariable = dataset.variables[xIndex]
  if (!numeric(xVariable)) throw new Error(`曲线估计要求数值自变量：${independent} 是文本变量（先转成数值，或者改用分类分析）`)
  if (!numeric(yVariable)) throw new Error(`曲线估计要求数值因变量：${dependent} 是文本变量（先转成数值）`)

  const wanted = Array.isArray(options.models) && options.models.length > 0
    ? options.models.map((entry) => modelOf(entry))
    : DEFAULTS.map((key) => modelOf(key))
  const deduped = []
  for (const model of wanted) if (!deduped.includes(model)) deduped.push(model)

  const upper = options.upper === undefined || options.upper === null || options.upper === ''
    ? null
    : Number(options.upper)
  if (upper !== null && !(Number.isFinite(upper) && upper > 0)) {
    throw new Error('Logistic 的上界 u 要给定一个正数：模型里的 y 必须小于它')
  }

  // 先把成对的观测收齐（两个变量都有效），再按各模型自己的取值要求筛。
  const pairs = []
  let dropped = 0
  for (const row of dataset.rows) {
    const rawX = row[xIndex]
    const rawY = row[yIndex]
    if (blank(rawX) || blank(rawY) || isUserMissing(xVariable, rawX) || isUserMissing(yVariable, rawY)) {
      dropped += 1
      continue
    }
    const x = Number(rawX)
    const y = Number(rawY)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      dropped += 1
      continue
    }
    pairs.push([x, y])
  }
  if (pairs.length < 3) throw new Error(`可用个案太少：${pairs.length} 对（曲线估计至少要 3 对）`)

  const maxY = Math.max(...pairs.map(([, y]) => y))
  const logisticUpper = upper ?? (maxY > 0 ? maxY * 1.1 : 1)
  if (upper !== null && !(upper > maxY)) {
    throw new Error(`Logistic 的上界 u = ${upper} 必须大于因变量的最大值 ${fixed(maxY, 4)}：y 要落在 0 与 u 之间`)
  }

  const results = []
  for (const model of deduped) {
    const needsUpper = model.requires.upper === true
    // 没给上界时用 max(y) × 1.1 兜底：SPSS 要求明确给 u，但把它做成硬性拦截
    // 只会让「先跑一遍看看」做不到。兜底值写进注文，读者能看出来这不是用户定的。
    const usable = []
    let excluded = 0
    for (const [x, y] of pairs) {
      if (model.requires.x === 'positive' && !(x > 0)) { excluded += 1; continue }
      if (model.requires.x === 'nonzero' && !(x !== 0)) { excluded += 1; continue }
      if (model.requires.y === 'positive' && !(y > 0)) { excluded += 1; continue }
      if (needsUpper && !(y > 0 && y < logisticUpper)) { excluded += 1; continue }
      usable.push([x, y])
    }
    if (usable.length < model.terms + 2) {
      results.push({ model, skipped: `可用个案只有 ${usable.length} 个，模型要 ${model.terms + 1} 个参数，拟合不出标准误` })
      continue
    }

    const rows = usable.map(([x, y]) => model.transform(x, y, logisticUpper))
    const width = model.terms + 1
    const xtx = Array.from({ length: width }, () => new Array(width).fill(0))
    const xty = new Array(width).fill(0)
    for (const row of rows) {
      for (let a = 0; a < width; a += 1) {
        xty[a] += row.xs[a] * row.y
        for (let b = 0; b < width; b += 1) xtx[a][b] += row.xs[a] * row.xs[b]
      }
    }
    const xtxInverse = invert(xtx)
    if (!xtxInverse) {
      results.push({ model, skipped: '设计矩阵奇异：自变量在可用个案上没有变化' })
      continue
    }
    const beta = xtxInverse.map((line) => line.reduce((sum, value, index) => sum + value * xty[index], 0))
    if (!beta.every((value) => Number.isFinite(value))) {
      results.push({ model, skipped: '拟合出来的系数不是有限数：自变量或取值尺度不合适' })
      continue
    }

    let sse = 0
    let sst = 0
    const meanY = rows.reduce((sum, row) => sum + row.y, 0) / rows.length
    for (const row of rows) {
      const fitted = row.xs.reduce((sum, value, index) => sum + value * beta[index], 0)
      sse += (row.y - fitted) ** 2
      sst += (row.y - meanY) ** 2
    }
    const df1 = model.terms
    const df2 = rows.length - width
    const rSquare = sst > 0 ? 1 - sse / sst : Number.NaN
    const adjusted = df2 > 0 ? 1 - ((1 - rSquare) * (rows.length - 1)) / df2 : Number.NaN
    const f = df1 > 0 && df2 > 0 && sse > 0 ? ((sst - sse) / df1) / (sse / df2) : Number.NaN
    const p = Number.isFinite(f) ? fP(f, df1, df2) : Number.NaN
    const standardError = df2 > 0 ? Math.sqrt(sse / df2) : Number.NaN

    const coefficients = model.report(beta)
    // 原始尺度 R²：线性化的 R² 看着高、原尺度其实拟合差时，这一列会露馅。
    let sseOriginal = 0
    let sstOriginal = 0
    const meanOriginal = usable.reduce((sum, [, y]) => sum + y, 0) / usable.length
    const curveCoefficients = needsUpper ? Object.assign([...coefficients], { upper: logisticUpper }) : coefficients
    for (const [x, y] of usable) {
      const fitted = evaluate(model, curveCoefficients, x)
      sseOriginal += (y - fitted) ** 2
      sstOriginal += (y - meanOriginal) ** 2
    }
    const rSquareOriginal = sstOriginal > 0 ? 1 - sseOriginal / sstOriginal : Number.NaN

    results.push({
      model,
      cases: usable.length,
      excluded: excluded + dropped,
      coefficients,
      curveCoefficients,
      rSquare,
      rSquareOriginal,
      adjusted,
      standardError,
      f,
      df1,
      df2,
      p,
      linearized: ['linear', 'inverse', 'quadratic', 'cubic'].includes(model.key) ? false : true,
    })
  }

  const fitted = results.filter((entry) => entry.model && !entry.skipped)
  if (fitted.length === 0) {
    const reasons = results.map((entry) => `${entry.model.label}：${entry.skipped}`).join('；')
    throw new Error(`没有一个曲线模型能拟合这组数据（${reasons}）`)
  }

  const best = fitted.reduce((left, right) => (Number(right.rSquare) > Number(left.rSquare) ? right : left))

  const notes = []
  notes.push(`线性化的模型（复合、幂、S、增长、指数、Logistic）先取对数再拟合，表里的 R² 是线性化那个回归的；「原始尺度 R²」用的是原尺度的 y，两者不一致说明线性化改变了残差的形状。`)
  notes.push('复合、增长、指数的参数按 b0·b1^x 或 e^(b0+b1·x) 的形式还原，b1 一定是正的（取过指数）。')
  if (dropped > 0) notes.push(`有 ${dropped} 个案的因变量或自变量是缺失值（含用户声明的缺失值），按整例剔除。`)
  const excludedAny = fitted.filter((entry) => entry.excluded > dropped)
  if (excludedAny.length > 0) {
    notes.push(`有些取值不满足模型要求被剔除：${excludedAny.map((entry) => `${entry.model.label} ${entry.excluded - dropped} 例`).join('、')}（对数类要求 x > 0，取对数的 y 要求 y > 0）。`)
  }
  if (upper === null && deduped.some((model) => model.requires.upper)) {
    notes.push(`Logistic 的上界没有指定，按因变量最大值 × 1.1 = ${fixed(logisticUpper, 4)} 计算；这个取值会改变 b0 与 b1 的含义，正式报告请明确给出上界。`)
  }
  notes.push(`最佳模型按线性化 R² 选：${best.model.label}（R² = ${fixed(best.rSquare, 4)}，原始尺度 ${fixed(best.rSquareOriginal, 4)}）。`)

  const parameters = fitted.map((entry) => ({
    model: entry.model.key,
    label: entry.model.label,
    expression: entry.model.expression,
    coefficients: entry.coefficients,
    rSquare: entry.rSquare,
    rSquareOriginal: entry.rSquareOriginal,
    adjusted: entry.adjusted,
    standardError: entry.standardError,
    f: entry.f,
    df1: entry.df1,
    df2: entry.df2,
    p: entry.p,
    cases: entry.cases,
    excluded: entry.excluded,
  }))

  return {
    dependent,
    independent,
    cases: fitted[0].cases,
    dropped,
    logisticUpper,
    parameters,
    best: best.model.key,
    skipped: results.filter((entry) => entry.skipped).map((entry) => ({ model: entry.model.key, label: entry.model.label, reason: entry.skipped })),
    notes,
    curve: {
      model: best.model.key,
      label: best.model.label,
      expression: best.model.expression,
      coefficients: best.curveCoefficients,
    },
  }
}
