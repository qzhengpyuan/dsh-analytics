import { isUserMissing } from './missing.js'
import { chiSquareP } from './tables.js'
import { invert } from './linalg.js'
import { computeMultinomial } from './multinomial.js'

/**
 * Ordinal (proportional odds) logistic regression, computed inside the plugin.
 *
 * PSPP 2.1.3 has no PLUM and no ordered-logit procedure at all: LOGISTIC
 * REGRESSION stops at a two-level dependent variable and NOMREG reports "not
 * yet implemented". So the cumulative-logit model is fitted here:
 *
 *     logit P(Y ≤ k) = θ_k − xβ,   k = 1 … K−1,   θ_1 < θ_2 < … < θ_{K−1}
 *
 * One β is shared by every cut point — that is the proportional-odds
 * assumption, and the parallel-lines test reported next to the estimates is
 * what checks it: the same data is refitted with independent coefficients per
 * cut point (the multinomial model from ./multinomial.js), and
 * 2(ℓ_unconstrained − ℓ_proportional) is compared against χ² with p(K−2) df.
 *
 * With K = 2 the model collapses to ordinary binary logistic regression, which
 * `test/ordinal.mjs` uses as an outside check (closed-form answer) and
 * `test/smoke.mjs` checks against the engine's own LOGISTIC REGRESSION.
 */

const MAX_TERMS = 10
const MAX_CATEGORIES = 20

function numeric(variable) {
  return variable?.type !== 'string'
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function columnOf(dataset, name) {
  return (dataset.variables ?? []).findIndex((variable) => variable.name === name)
}

function categoryOf(variable, raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (isUserMissing(variable, raw)) return null
  if (numeric(variable)) {
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  const text = String(raw).trim()
  return text === '' ? null : text
}

function labelOf(value) {
  return typeof value === 'number' ? String(round(value, 6)) : String(value)
}

function sortCategories(values) {
  const list = [...values]
  if (list.every((value) => typeof value === 'number')) return list.sort((left, right) => left - right)
  return list.sort((left, right) => String(left).localeCompare(String(right), 'zh-Hans-CN'))
}

function expit(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const scale = Math.exp(value)
  return scale / (1 + scale)
}

/** γ_k = P(Y ≤ k) for k = 0 … K−1, with the two ends pinned at 0 and 1. */
function cumulative(theta, z) {
  const gamma = [0]
  for (const value of theta) gamma.push(expit(value - z))
  gamma.push(1)
  return gamma
}

export function logLikelihood(rows, theta, beta) {
  let total = 0
  for (const row of rows) {
    const z = row.x.reduce((sum, value, term) => sum + value * beta[term], 0)
    const gamma = cumulative(theta, z)
    const width = gamma[row.y + 1] - gamma[row.y]
    total += Math.log(Math.max(width, 1e-300))
  }
  return Number.isFinite(total) ? total : Number.NEGATIVE_INFINITY
}

/**
 * Analytic gradient. With a = γ_j, b = γ_{j−1}, f = a − b:
 *   ∂ℓ/∂θ_j = A/f,  ∂ℓ/∂θ_{j−1} = −B/f,  ∂ℓ/∂β = (B − A)·x/f
 * where A = a(1−a) and B = b(1−b). Written out rather than differentiated
 * numerically so the likelihood itself stays a pure function of the parameters.
 */
export function gradient(rows, theta, beta, width) {
  const size = theta.length + width
  const out = new Array(size).fill(0)
  for (const row of rows) {
    const z = row.x.reduce((sum, value, term) => sum + value * beta[term], 0)
    const gamma = cumulative(theta, z)
    const a = gamma[row.y + 1]
    const b = gamma[row.y]
    const f = Math.max(a - b, 1e-300)
    const A = a * (1 - a)
    const B = b * (1 - b)
    if (row.y < theta.length) out[row.y] += A / f
    if (row.y > 0) out[row.y - 1] -= B / f
    const scale = (B - A) / f
    for (let term = 0; term < width; term += 1) out[theta.length + term] += scale * row.x[term]
  }
  return out
}

/**
 * Hessian by central differences of the analytic gradient. The algebra for the
 * closed-form second derivatives of a cumulative-logit likelihood is long and
 * easy to get subtly wrong; the gradient is four lines and its numerical
 * derivative is verified against the closed-form answer in test/ordinal.mjs.
 */
export function hessian(rows, theta, beta, width) {
  const size = theta.length + width
  const params = () => [...theta, ...beta]
  const at = (values) => {
    const nextTheta = values.slice(0, theta.length)
    const nextBeta = values.slice(theta.length)
    return gradient(rows, nextTheta, nextBeta, width)
  }
  const base = params()
  const out = []
  for (let row = 0; row < size; row += 1) out.push(new Array(size).fill(0))
  for (let column = 0; column < size; column += 1) {
    const step = 1e-5 * Math.max(1, Math.abs(base[column]))
    const forward = [...base]
    forward[column] += step
    const backward = [...base]
    backward[column] -= step
    const plus = at(forward)
    const minus = at(backward)
    for (let row = 0; row < size; row += 1) out[row][column] = (plus[row] - minus[row]) / (2 * step)
  }
  // Symmetrise: the two halves of a numerical Hessian differ in the last bits.
  for (let row = 0; row < size; row += 1) {
    for (let column = row + 1; column < size; column += 1) {
      const mean = (out[row][column] + out[column][row]) / 2
      out[row][column] = mean
      out[column][row] = mean
    }
  }
  return out
}

function initialTheta(rows, categories) {
  const counts = new Array(categories.length).fill(0)
  for (const row of rows) counts[row.y] += 1
  const total = rows.length
  const theta = []
  let running = 0
  for (let index = 0; index < categories.length - 1; index += 1) {
    running += counts[index]
    const share = Math.min(Math.max(running / total, 1e-6), 1 - 1e-6)
    theta.push(Math.log(share / (1 - share)))
  }
  return theta
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) < 1e-10 * Math.max(1, Math.abs(left))
}

/** Fisher-style Wald ratio and its p value, with the usual «—» for unusable rows. */
function waldOf(estimate, error) {
  if (!Number.isFinite(estimate) || !Number.isFinite(error) || error <= 0) return null
  const ratio = estimate / error
  return { ratio, p: chiSquareP(ratio * ratio, 1) }
}

export function computeOrdinal(dataset, options = {}) {
  const variables = dataset?.variables ?? []
  const rows = dataset?.rows ?? []
  if (!variables.length) throw new Error('还没有打开数据集')

  const dependent = String(options.dependent ?? '').trim()
  const dependentColumn = columnOf(dataset, dependent)
  if (dependentColumn < 0) throw new Error(`没有这个变量：${dependent}`)
  const dependentVariable = variables[dependentColumn]

  const names = [...new Set((options.independents ?? []).map((name) => String(name).trim()).filter(Boolean))]
  if (!names.length) throw new Error('有序 Logistic 回归至少要一个自变量')
  if (names.length > MAX_TERMS) throw new Error(`一次最多 ${MAX_TERMS} 个自变量：再多就该先做变量筛选`)
  for (const name of names) {
    const column = columnOf(dataset, name)
    if (column < 0) throw new Error(`没有这个变量：${name}`)
    if (!numeric(variables[column])) {
      throw new Error(`自变量要求数值变量：${name} 是文本变量（分类自变量先做成哑变量）`)
    }
  }

  const cases = []
  for (const row of rows) {
    const value = categoryOf(dependentVariable, row[dependentColumn])
    if (value === null) continue
    // No intercept column: the thresholds already are the cut-point intercepts,
    // and adding a constant would leave θ_k and β_0 unidentified.
    const terms = []
    let skip = false
    for (const name of names) {
      const raw = row[columnOf(dataset, name)]
      if (raw === null || raw === undefined || raw === '' || isUserMissing(variables[columnOf(dataset, name)], raw)) {
        skip = true
        break
      }
      const number = Number(raw)
      if (!Number.isFinite(number)) {
        skip = true
        break
      }
      terms.push(number)
    }
    if (skip) continue
    cases.push({ value, x: terms })
  }

  const categories = sortCategories(new Set(cases.map((entry) => entry.value)))
  const count = categories.length
  if (count < 2) {
    throw new Error(`因变量「${dependent}」至少要两个类别，现在只有 ${count} 个`)
  }
  if (count > MAX_CATEGORIES) {
    throw new Error(`因变量有 ${count} 个类别：有序 Logistic 在这里最多 ${MAX_CATEGORIES} 个`)
  }
  const indexOfValue = new Map(categories.map((value, index) => [String(labelOf(value)), index]))

  const fitted = cases.map((entry) => ({ x: entry.x, y: indexOfValue.get(String(labelOf(entry.value))) }))
  const width = names.length
  if (fitted.length <= width + count - 1) {
    throw new Error(`个案太少：${fitted.length} 个个案连模型自己的自由度都不够，先去补数据或减少自变量`)
  }

  let theta = initialTheta(fitted, categories)
  let beta = new Array(width).fill(0)
  let logLik = logLikelihood(fitted, theta, beta)
  let iterations = 0
  let converged = false
  let singular = false

  for (let step = 0; step < 100; step += 1) {
    iterations = step + 1
    const grad = gradient(fitted, theta, beta, width)
    const info = hessian(fitted, theta, beta, width)
    let covariance
    try {
      // The gradient is of the log-likelihood, the Hessian therefore negative
      // definite at a maximum: the step solves (−H)d = g.
      covariance = invert(info)
    } catch {
      if (step === 0) {
        throw new Error(
          '有序 Logistic 的方程是奇异的：自变量之间完全共线，或者某个自变量在类别里没有变化',
        )
      }
      singular = true
      break
    }
    // H is the Hessian of the log-likelihood, so it is negative definite at a
    // maximum; the ascent step is −H⁻¹g.
    const direction = new Array(grad.length).fill(0)
    for (let row = 0; row < grad.length; row += 1) {
      let total = 0
      for (let column = 0; column < grad.length; column += 1) total += covariance[row][column] * grad[column]
      direction[row] = -total
    }
    const largest = Math.max(...direction.map(Math.abs))
    if (!Number.isFinite(largest)) {
      singular = true
      break
    }

    let scale = 1
    let accepted = false
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const trialTheta = theta.map((value, index) => value + scale * direction[index])
      const trialBeta = beta.map((value, index) => value + scale * direction[theta.length + index])
      const trial = logLikelihood(fitted, trialTheta, trialBeta)
      if (trial >= logLik - 1e-12) {
        theta = trialTheta
        beta = trialBeta
        accepted = true
        break
      }
      scale /= 2
    }
    if (!accepted) {
      singular = true
      break
    }
    const next = logLikelihood(fitted, theta, beta)
    const improvement = next - logLik
    logLik = next
    if (nearlyEqual(largest * scale, 0) || Math.abs(improvement) < 1e-10) {
      converged = true
      break
    }
  }

  const separated = Math.max(...beta.map(Math.abs)) > 15 || singular
  let covariance = null
  try {
    covariance = invert(hessian(fitted, theta, beta, width))
  } catch {
    covariance = null
  }
  const uncertain = !covariance || separated
  const standardErrors = []
  for (let index = 0; index < theta.length + width; index += 1) {
    if (!covariance) {
      standardErrors.push(null)
      continue
    }
    const variance = -covariance[index][index]
    standardErrors.push(variance > 0 ? Math.sqrt(variance) : null)
  }

  // Thresholds have to stay ordered; if they crossed, the model is not a set of
  // cumulative logits at all and reporting numbers would be misleading.
  for (let index = 1; index < theta.length; index += 1) {
    if (!(theta[index] > theta[index - 1])) {
      throw new Error(
        '阈值没有保持递增：自变量对类别的影响方向不一致，比例优势假设不成立。先做平行线检验，或者改用多项 Logistic',
      )
    }
  }

  const observed = new Array(count).fill(0)
  for (const row of fitted) observed[row.y] += 1
  const total = fitted.length
  let nullLogLik = 0
  for (const value of observed) {
    if (value > 0) nullLogLik += value * Math.log(value / total)
  }
  const chiSquare = Math.max(0, 2 * (logLik - nullLogLik))
  const df = width
  const p = chiSquareP(chiSquare, df)
  const coxSnell = 1 - Math.exp((2 / total) * (nullLogLik - logLik))
  const nagelkerke = coxSnell / (1 - Math.exp((2 / total) * nullLogLik))
  const mcfadden = 1 - logLik / nullLogLik

  // Pearson and deviance on covariate patterns, which is what the engine reports.
  const patterns = new Map()
  for (const row of fitted) {
    const key = row.x.join('|')
    if (!patterns.has(key)) patterns.set(key, { x: row.x, counts: new Array(count).fill(0) })
    patterns.get(key).counts[row.y] += 1
  }
  let pearson = 0
  let deviance = 0
  let patternsUsed = 0
  for (const pattern of patterns.values()) {
    const z = pattern.x.reduce((sum, value, term) => sum + value * beta[term], 0)
    const gamma = cumulative(theta, z)
    for (let index = 0; index < count; index += 1) {
      const expected = (gamma[index + 1] - gamma[index]) * total
      if (!(expected > 0)) continue
      const seen = pattern.counts[index]
      pearson += ((seen - expected) ** 2) / expected
      if (seen > 0) deviance += 2 * seen * Math.log(seen / expected)
    }
    patternsUsed += 1
  }
  const residualDf = Math.max(1, patternsUsed * (count - 1) - df)

  const predictions = fitted.map((row) => {
    const z = row.x.reduce((sum, value, term) => sum + value * beta[term], 0)
    const gamma = cumulative(theta, z)
    let best = 0
    let bestP = -Infinity
    for (let index = 0; index < count; index += 1) {
      const share = gamma[index + 1] - gamma[index]
      if (share > bestP) {
        bestP = share
        best = index
      }
    }
    return best
  })
  let correct = 0
  for (let index = 0; index < fitted.length; index += 1) if (predictions[index] === fitted[index].y) correct += 1

  const matrix = [['实测', ...categories.map(labelOf), '正确率']]
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    const cells = [labelOf(categories[rowIndex])]
    let rowTotal = 0
    let rowCorrect = 0
    for (let column = 0; column < count; column += 1) {
      let seen = 0
      for (let index = 0; index < fitted.length; index += 1) {
        if (fitted[index].y !== rowIndex || predictions[index] !== column) continue
        seen += 1
      }
      cells.push(String(seen))
      rowTotal += seen
      if (column === rowIndex) rowCorrect = seen
    }
    cells.push(rowTotal ? `${round((100 * rowCorrect) / rowTotal, 1)}%` : '—')
    matrix.push(cells)
  }
  const totals = ['总计']
  for (let column = 0; column < count; column += 1) {
    totals.push(String(predictions.filter((value) => value === column).length))
  }
  totals.push(`${round((100 * correct) / fitted.length, 1)}%`)
  matrix.push(totals)

  const fixed = (value, digits = 4) => Number(value).toFixed(digits)
  const pText = (value) => (value < 0.001 ? '<0.001' : Number(value).toFixed(3))
  const table = [['变量', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)']]
  for (let index = 0; index < theta.length; index += 1) {
    const error = uncertain ? null : standardErrors[index]
    const wald = error ? waldOf(theta[index], error) : null
    table.push([
      `阈值 Y ≤ ${labelOf(categories[index])}`,
      fixed(theta[index]),
      error ? fixed(error) : '—',
      wald ? fixed(wald.ratio, 3) : '—',
      '1',
      wald ? pText(wald.p) : '—',
      '—',
    ])
  }
  for (let term = 0; term < width; term += 1) {
    const estimate = beta[term]
    const error = uncertain ? null : standardErrors[theta.length + term]
    const wald = error ? waldOf(estimate, error) : null
    table.push([
      names[term],
      fixed(estimate),
      error ? fixed(error) : '—',
      wald ? fixed(wald.ratio, 3) : '—',
      '1',
      wald ? pText(wald.p) : '—',
      fixed(Math.exp(estimate), 3),
    ])
  }

  // Parallel-lines test: refit without the proportional-odds restriction.
  let parallel = null
  let parallelNote = ''
  if (count < 3) {
    parallelNote = '因变量只有两个类别：平行线检验没有自由度，此时比例优势模型就是二元 Logistic 回归。'
  } else {
    try {
      const free = computeMultinomial(dataset, { dependent, independents: names })
      const statistic = Math.max(0, 2 * (free.model.logLikelihood - logLik))
      const linesDf = width * (count - 2)
      parallel = { statistic, df: linesDf, p: chiSquareP(statistic, linesDf) }
    } catch (error) {
      parallelNote = `平行线检验没做成：${error?.message ?? error}`
    }
  }

  const notes = [
    `比例优势模型：${total} 个个案，${count} 个有序类别，${names.length} 个自变量；阈值共 ${theta.length} 个，自变量系数在所有切点上共用一套。`,
    `模型拟合：−2LL = ${round(-2 * logLik, 3)}，似然比 χ² = ${round(chiSquare, 3)}（df = ${df}，P ${p < 0.001 ? '< 0.001' : `= ${round(p, 3)}`}），Cox & Snell R² = ${round(coxSnell, 3)}，Nagelkerke R² = ${round(nagelkerke, 3)}，McFadden R² = ${round(mcfadden, 3)}。`,
    parallel
      ? `平行线检验：χ² = ${round(parallel.statistic, 3)}（df = ${parallel.df}，P ${parallel.p < 0.001 ? '< 0.001' : `= ${round(parallel.p, 3)}`}）。P 小于 0.05 说明各类别的自变量作用不一致，比例优势假设可疑，该改用多项 Logistic。`
      : parallelNote,
    'B 为正表示自变量越大越往类别序号大的方向走；Exp(B) 是「高一个单位时跨过某个切点的优势倍数」。阈值不是待解释的系数，只用来切分累积概率。',
    uncertain
      ? '标准误、Wald 与 P 记为「—」：数据与因变量几乎完全可分，或者迭代没有收敛，这些量不再可信。去掉有疑问的自变量或合并类别后再看。'
      : `牛顿迭代 ${iterations} 步${converged ? '收敛' : '停在步长上限（结果未必稳定，建议检查共线性）'}。`,
  ]

  return {
    title: `有序 Logistic 回归（比例优势）：${dependent}`,
    table,
    matrix,
    notes,
    model: {
      dependent,
      independents: names,
      categories,
      cases: total,
      thresholds: theta,
      coefficients: beta,
      // Unrounded standard errors: thresholds first, then predictors.
      standardErrors: uncertain ? standardErrors.map(() => null) : standardErrors,
      logLikelihood: logLik,
      nullLogLikelihood: nullLogLik,
      chiSquare,
      df,
      p,
      pearson,
      pearsonP: chiSquareP(pearson, residualDf),
      deviance,
      devianceP: chiSquareP(deviance, residualDf),
      residualDf,
      coxSnell,
      nagelkerke,
      mcfadden,
      accuracy: correct / fitted.length,
      iterations,
      converged,
      separated,
      parallel,
    },
  }
}
