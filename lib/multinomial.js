import { isUserMissing } from './missing.js'
import { chiSquareP } from './tables.js'
import { invert } from './linalg.js'

/**
 * Multinomial logistic regression, computed inside the plugin.
 *
 * PSPP 2.1.3 ships LOGISTIC REGRESSION, but only for a two-level dependent
 * variable; NOMREG reports "not yet implemented". So the K−1 logits are fitted
 * here by Newton–Raphson on the full log-likelihood, with one category of the
 * dependent variable taken as the reference (a user choice, the last category by
 * default, which is what SPSS does).
 *
 * The two-category case is exactly binary logistic regression, which
 * `test/smoke.mjs` uses as an independent check: the same data run through the
 * engine's LOGISTIC REGRESSION has to give the same coefficients.
 */

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

function softmax(logits) {
  const max = Math.max(...logits)
  const exps = logits.map((value) => Math.exp(value - max))
  const total = exps.reduce((sum, value) => sum + value, 0)
  return exps.map((value) => value / total)
}

/** Probabilities for one case: K−1 fitted logits plus the reference at zero. */
function probabilities(x, beta) {
  const logits = beta.map((block) => block.reduce((sum, value, term) => sum + value * x[term], 0))
  logits.push(0)
  return softmax(logits)
}

function logLikelihood(rows, beta) {
  let total = 0
  for (const row of rows) total += Math.log(Math.max(probabilities(row.x, beta)[row.outcome], 1e-300))
  return total
}

/** Gradient and information matrix of the multinomial log-likelihood. */
function derivatives(rows, beta, width) {
  const groups = beta.length
  const size = groups * width
  const gradient = new Array(size).fill(0)
  const information = Array.from({ length: size }, () => new Array(size).fill(0))
  const cache = rows.map((row) => probabilities(row.x, beta))
  rows.forEach((row, index) => {
    const p = cache[index]
    const x = row.x
    for (let group = 0; group < groups; group += 1) {
      const slack = (row.outcome === group ? 1 : 0) - p[group]
      for (let term = 0; term < width; term += 1) gradient[group * width + term] += slack * x[term]
    }
    // Information: sum of p_j (delta_jk − p_k) x_a x_b over the K−1 blocks.
    for (let j = 0; j < groups; j += 1) {
      for (let k = 0; k < groups; k += 1) {
        const weight = p[j] * ((j === k ? 1 : 0) - p[k])
        if (weight === 0) continue
        for (let a = 0; a < width; a += 1) {
          if (x[a] === 0) continue
          const left = x[a] * weight
          for (let b = 0; b < width; b += 1) information[j * width + a][k * width + b] += left * x[b]
        }
      }
    }
  })
  return { gradient, information, cache }
}

function solveLinear(matrix, vector) {
  const size = vector.length
  const a = matrix.map((row, index) => [...row, vector[index]])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row
    }
    if (Math.abs(a[pivot][column]) < 1e-12) throw new Error('singular')
    if (pivot !== column) [a[pivot], a[column]] = [a[column], a[pivot]]
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = a[row][column] / a[column][column]
      if (factor === 0) continue
      for (let col = column; col <= size; col += 1) a[row][col] -= factor * a[column][col]
    }
  }
  return a.map((row, index) => row[size] / row[index])
}

export function computeMultinomial(dataset, options = {}) {
  const variables = dataset.variables ?? []
  const dependentName = String(options.dependent ?? '').trim()
  const dependent = variables.find((variable) => variable.name === dependentName)
  if (!dependent) throw new Error(`没有这个变量：${dependentName || '（没填）'}`)
  const names = (Array.isArray(options.independents) ? options.independents : []).map(String)
  if (names.length === 0) throw new Error('多项 Logistic 回归至少要一个自变量')
  if (names.length > 10) throw new Error('一次最多 10 个自变量：再多就该先做变量筛选')
  const independents = names.map((name) => {
    const variable = variables.find((entry) => entry.name === name)
    if (!variable) throw new Error(`没有这个变量：${name}`)
    if (!numeric(variable)) throw new Error(`自变量要求数值变量：${name} 是文本变量（分类自变量先做成哑变量）`)
    return variable
  })
  const dependentIndex = columnOf(dataset, dependent.name)
  const independentIndex = independents.map((variable) => columnOf(dataset, variable.name))

  const seen = new Map()
  for (const row of dataset.rows ?? []) {
    const value = categoryOf(dependent, row[dependentIndex])
    if (value === null) continue
    seen.set(labelOf(value), value)
  }
  const categories = sortCategories([...seen.values()])
  if (categories.length < 2) {
    throw new Error(`因变量「${dependent.name}」至少要两个类别，现在只有 ${categories.length} 个`)
  }
  if (categories.length > 20) throw new Error(`因变量有 ${categories.length} 个类别：多项 Logistic 在这里最多 20 个`)

  const wanted = options.reference
  const referenceValue = wanted === undefined || wanted === null || wanted === ''
    ? categories[categories.length - 1]
    : seen.get(labelOf(categoryOf(dependent, wanted) ?? ''))
  if (referenceValue === undefined) {
    throw new Error(`参照类别「${wanted}」不在因变量的取值里（可用：${categories.map(labelOf).join('、')}）`)
  }

  // Fitted blocks come first and the reference category comes last, so the
  // probability vector and the parameter blocks share one index.
  const levels = categories.filter((value) => labelOf(value) !== labelOf(referenceValue))
  const order = [...levels, referenceValue]
  const indexOfValue = (value) => order.findIndex((entry) => labelOf(entry) === labelOf(value))

  const rows = []
  for (const row of dataset.rows ?? []) {
    const value = categoryOf(dependent, row[dependentIndex])
    if (value === null) continue
    const x = [1]
    let complete = true
    for (const index of independentIndex) {
      const raw = row[index]
      if (raw === null || raw === undefined || raw === '') {
        complete = false
        break
      }
      const number = Number(raw)
      if (!Number.isFinite(number)) {
        complete = false
        break
      }
      x.push(number)
    }
    if (!complete) continue
    rows.push({ x, outcome: indexOfValue(value) })
  }
  const groups = levels.length
  if (rows.length < groups + 2) {
    throw new Error(`个案太少：${rows.length} 个个案、${categories.length} 个类别、${names.length} 个自变量，模型没有自由度`)
  }

  const width = names.length + 1
  const size = groups * width
  let separated = false
  let beta = Array.from({ length: groups }, () => new Array(width).fill(0))
  let logLik = logLikelihood(rows, beta)
  let iterations = 0
  let converged = false
  let warned = false
  for (iterations = 1; iterations <= 100; iterations += 1) {
    const { gradient, information } = derivatives(rows, beta, width)
    let step
    try {
      step = solveLinear(information, gradient)
    } catch {
      if (iterations === 1) {
        throw new Error('多项 Logistic 的方程是奇异的：自变量之间完全共线，或者某个自变量在类别里没有变化')
      }
      warned = true
      break
    }
    // A full Newton step overshoots on nearly separated data; halving it whenever
    // the likelihood drops keeps the iteration monotone.
    let scale = 1
    let trial = beta
    let trialLik = logLik
    for (let attempt = 0; attempt < 12; attempt += 1) {
      trial = beta.map((block, group) => block.map((value, term) => value + scale * step[group * width + term]))
      trialLik = logLikelihood(rows, trial)
      if (trialLik >= logLik - 1e-12) break
      scale /= 2
    }
    const improvement = trialLik - logLik
    beta = trial
    logLik = trialLik
    const largest = Math.max(...step.map((value) => Math.abs(value)))
    if (largest * scale < 1e-8 || Math.abs(improvement) < 1e-10) {
      converged = true
      break
    }
  }
  if (!converged && !warned) warned = true

  const { information, cache } = derivatives(rows, beta, width)
  let covariance = null
  try {
    covariance = invert(information)
  } catch {
    // Complete or quasi-complete separation drives every probability to 0 or 1,
    // which makes the information matrix singular even though the likelihood is
    // finite. SPSS still prints the coefficients and flags the standard errors;
    // refusing the whole table would hide the separation instead of reporting it.
    separated = true
    warned = true
  }

  // A coefficient beyond ±15 without a singular matrix means the likelihood is
  // flat along that direction: quasi-separation. The standard errors then only
  // look finite, so they are reported as missing rather than as facts.
  const largestBeta = Math.max(...beta.flat().map((value) => Math.abs(value)))
  if (largestBeta > 15) separated = true
  const uncertain = !covariance || separated

  const counts = new Array(order.length).fill(0)
  for (const row of rows) counts[row.outcome] += 1
  const nullLogLik = rows.reduce((total, row) => total + Math.log(counts[row.outcome] / rows.length), 0)
  const modelChiSquare = 2 * (logLik - nullLogLik)
  const df = groups * (width - 1)
  const pModel = chiSquareP(modelChiSquare, df)

  // Casewise Pearson and deviance, summed over every category of every case.
  let pearson = 0
  let deviance = 0
  const prediction = cache
  rows.forEach((row, index) => {
    const p = prediction[index]
    p.forEach((expected, category) => {
      const observed = row.outcome === category ? 1 : 0
      if (expected <= 0) return
      pearson += (observed - expected) ** 2 / expected
      if (observed === 1) deviance += 2 * Math.log(1 / expected)
    })
  })
  const residualDf = Math.max(1, rows.length * (order.length - 1) - df)
  const pPearson = chiSquareP(pearson, residualDf)
  const pDeviance = chiSquareP(deviance, residualDf)

  const table = [['因变量水平', '变量', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)']]
  for (let group = 0; group < groups; group += 1) {
    for (let term = 0; term < width; term += 1) {
      const position = group * width + term
      const estimate = beta[group][term]
      const variance = covariance ? covariance[position][position] : 0
      const se = variance > 0 ? Math.sqrt(variance) : 0
      const wald = se > 0 ? (estimate / se) ** 2 : 0
      const p = se > 0 ? chiSquareP(wald, 1) : 0
      table.push([
        labelOf(levels[group]),
        term === 0 ? '（常数）' : names[term - 1],
        round(estimate).toFixed(4),
        uncertain ? '—' : round(se).toFixed(4),
        uncertain ? '—' : round(wald).toFixed(4),
        '1',
        uncertain ? '—' : p < 0.001 ? '<0.001' : round(p, 3).toFixed(3),
        round(Math.exp(estimate)).toFixed(4),
      ])
    }
  }

  const matrix = [['实测', ...order.map(labelOf), '正确率']]
  let correct = 0
  const predictedOf = (p) => p.indexOf(Math.max(...p))
  order.forEach((category, observedGroup) => {
    const countsRow = new Array(order.length).fill(0)
    rows.forEach((row, index) => {
      if (row.outcome !== observedGroup) return
      const predicted = predictedOf(prediction[index])
      countsRow[predicted] += 1
      if (predicted === observedGroup) correct += 1
    })
    const total = countsRow.reduce((sum, value) => sum + value, 0)
    matrix.push([
      labelOf(category),
      ...countsRow.map((value) => String(value)),
      total ? `${((countsRow[observedGroup] / total) * 100).toFixed(1)}%` : '—',
    ])
  })
  matrix.push([
    '总计',
    ...order.map((_, category) => String(rows.reduce((sum, row, position) => sum + (predictedOf(prediction[position]) === category ? 1 : 0), 0))),
    `${((correct / rows.length) * 100).toFixed(1)}%`,
  ])

  // Pseudo R squares as SPSS reports them.
  const coxSnell = 1 - Math.exp((2 / rows.length) * (nullLogLik - logLik))
  const nagelkerke = coxSnell / (1 - Math.exp((2 / rows.length) * nullLogLik))
  const mcfadden = 1 - logLik / nullLogLik

  const notes = [
    `个案 ${rows.length} 例，因变量 ${order.length} 个类别（${order.map(labelOf).join('、')}），参照类别为「${labelOf(referenceValue)}」；缺失值按整例剔除。`,
    `模型 χ² = ${round(modelChiSquare).toFixed(4)}（df = ${df}，P ${pModel < 0.001 ? '< 0.001' : `= ${round(pModel, 3).toFixed(3)}`}）；-2 对数似然 = ${round(-2 * logLik).toFixed(4)}。`,
    `参照类别那一组参数按定义是 0，所以参数表里只有其余 ${groups} 组。`,
    separated
      ? `数据与因变量几乎完全可分（最大系数 ${round(largestBeta, 2).toFixed(2)}）：系数被推向无穷，标准误、Wald 与 P 不再可信，表中记为「—」。把有疑问的自变量去掉，或合并类别后再看。`
      : `牛顿迭代 ${iterations} 步${warned ? '，没有收敛（系数会很大、标准误失去意义）' : '收敛'}。`,
  ]

  return {
    title: `${dependent.name} 的多项 Logistic 回归`,
    table,
    matrix,
    classification: matrix,
    notes,
    model: {
      dependent: dependent.name,
      independents: names,
      categories: order.map(labelOf),
      reference: labelOf(referenceValue),
      cases: rows.length,
      logLikelihood: logLik,
      nullLogLikelihood: nullLogLik,
      chiSquare: modelChiSquare,
      df,
      p: pModel,
      pearson,
      pearsonP: pPearson,
      deviance,
      devianceP: pDeviance,
      residualDf,
      coxSnell,
      nagelkerke,
      mcfadden,
      accuracy: correct / rows.length,
      iterations,
      converged: !warned,
      separated,
      coefficients: levels.map((level, group) => ({
        level: labelOf(level),
        terms: beta[group].map((estimate, term) => ({ term, estimate })),
      })),
    },
  }
}
