import { chiSquareP } from './tables.js'
import { determinant, invert } from './linalg.js'
import { isCategorical, isUserMissing } from './missing.js'

/**
 * Discriminant analysis (the linear kind SPSS calls "Discriminant").
 *
 * PSPP 2.1.3 answers `DISCRIMINANT` with "not yet implemented", so the whole
 * thing is fitted here: pooled within-class covariance, Fisher's linear
 * discriminant functions for classification, and the canonical discriminant
 * functions (eigenvalues of W⁻¹B) that SPSS prints as the eigenvalue table.
 */

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function valueOf(variable, raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (isUserMissing(variable, raw)) return null
  if (variable?.type === 'string') return String(raw)
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const labelOf = (variable, value) => {
  const labels = variable?.valueLabels ?? {}
  const labelled = labels[value]
  return labelled === undefined || labelled === '' ? String(value) : String(labelled)
}

function zeros(width) {
  return Array.from({ length: width }, () => 0)
}

function zeroMatrix(width) {
  return Array.from({ length: width }, () => Array.from({ length: width }, () => 0))
}

// Eigenvalues of a small symmetric-definite generalised problem W⁻¹B, done with
// the power iteration on W⁻¹B followed by deflation. The number of functions is
// at most min(groups − 1, variables), so the matrices stay tiny.
function canonicalEigenvalues(within, between, count) {
  const product = (left, right) => left.map((row) => right[0].map((_, column) => row.reduce((total, value, index) => total + value * right[index][column], 0)))
  let current = product(invert(within), between)
  const eigenvalues = []
  for (let index = 0; index < count; index += 1) {
    let vector = Array.from({ length: current.length }, (_, position) => (position === index % current.length ? 1 : 0.5))
    let value = 0
    for (let step = 0; step < 200; step += 1) {
      const next = product(current, vector.map((entry) => [entry])).map((row) => row[0])
      const norm = Math.hypot(...next)
      if (!Number.isFinite(norm) || norm < 1e-12) {
        value = 0
        break
      }
      const scaled = next.map((entry) => entry / norm)
      const shift = Math.abs(norm - value)
      vector = scaled
      value = norm
      if (shift < 1e-10) break
    }
    eigenvalues.push(Math.max(0, value))
    // Deflate: subtract λ·v·vᵀ so the next sweep finds the next eigenvalue.
    const norm = Math.hypot(...vector)
    const unit = norm > 0 ? vector.map((entry) => entry / norm) : vector
    current = current.map((row, rowIndex) => row.map((entry, column) => entry - value * unit[rowIndex] * unit[column]))
  }
  return eigenvalues.sort((left, right) => right - left)
}

export function computeDiscriminant(dataset, options = {}) {
  const variables = dataset.variables ?? []
  const rows = dataset.rows ?? []
  const groupVariable = variables.find((variable) => variable.name === options.group)
  if (!groupVariable) throw new Error(`unknown variable: ${options.group}`)
  const names = Array.isArray(options.variables) ? options.variables.map(String) : []
  if (names.length === 0) throw new Error('判别分析至少需要一个判别变量')
  const predictors = names.map((name) => {
    const variable = variables.find((entry) => entry.name === name)
    if (!variable) throw new Error(`unknown variable: ${name}`)
    if (isCategorical(variable)) throw new Error(`判别变量要求数值变量：${name} 是文本变量`)
    return variable
  })
  const groupIndex = variables.findIndex((variable) => variable.name === options.group)
  const predictorIndex = predictors.map((variable) => variables.findIndex((entry) => entry.name === variable.name))

  const cases = []
  for (const row of rows) {
    const group = valueOf(groupVariable, row[groupIndex])
    if (group === null) continue
    const values = []
    let complete = true
    for (const index of predictorIndex) {
      const value = valueOf(variables[index], row[index])
      if (value === null) {
        complete = false
        break
      }
      values.push(value)
    }
    if (!complete) continue
    cases.push({ group: String(group), values })
  }
  if (cases.length === 0) throw new Error('没有可用个案：分组变量与判别变量都得有值')

  const order = []
  const groups = new Map()
  for (const entry of cases) {
    if (!groups.has(entry.group)) {
      groups.set(entry.group, [])
      order.push(entry.group)
    }
    groups.get(entry.group).push(entry.values)
  }
  if (order.length < 2) throw new Error('分组变量至少要两个组')
  if (order.length > 20) throw new Error('分组超过 20 个：判别分析的函数个数会失控，先合并稀有组')
  const width = predictors.length
  const total = cases.length
  if (total - order.length < width) {
    throw new Error(`个案太少：${total} 例、${order.length} 组、${width} 个判别变量，组内协方差矩阵没有自由度`)
  }

  // Group means and the pooled within-class covariance.
  const means = new Map()
  for (const key of order) {
    const members = groups.get(key)
    means.set(key, Array.from({ length: width }, (_, column) => members.reduce((sum, row) => sum + row[column], 0) / members.length))
  }
  const within = zeroMatrix(width)
  for (const key of order) {
    const members = groups.get(key)
    const center = means.get(key)
    for (const row of members) {
      for (let rowIndex = 0; rowIndex < width; rowIndex += 1) {
        for (let column = 0; column < width; column += 1) {
          within[rowIndex][column] += (row[rowIndex] - center[rowIndex]) * (row[column] - center[column])
        }
      }
    }
  }
  const degreesWithin = total - order.length
  const pooled = within.map((row) => row.map((entry) => entry / degreesWithin))
  let pooledInverse
  try {
    pooledInverse = invert(pooled)
  } catch (error) {
    throw new Error(`判别变量的组内协方差矩阵是奇异的（${error.message}）：通常是两个判别变量完全相关，去掉其中一个再试`)
  }

  // Between-class scatter, needed for the canonical functions and Wilks' lambda.
  const grand = Array.from({ length: width }, (_, column) => cases.reduce((sum, row) => sum + row.values[column], 0) / total)
  const totalScatter = zeroMatrix(width)
  for (const row of cases) {
    for (let rowIndex = 0; rowIndex < width; rowIndex += 1) {
      for (let column = 0; column < width; column += 1) {
        totalScatter[rowIndex][column] += (row.values[rowIndex] - grand[rowIndex]) * (row.values[column] - grand[column])
      }
    }
  }
  const between = zeroMatrix(width)
  for (const key of order) {
    const members = groups.get(key)
    const center = means.get(key)
    for (let rowIndex = 0; rowIndex < width; rowIndex += 1) {
      for (let column = 0; column < width; column += 1) {
        between[rowIndex][column] += members.length * (center[rowIndex] - grand[rowIndex]) * (center[column] - grand[column])
      }
    }
  }

  const determinantTotal = determinant(totalScatter)
  const determinantWithin = determinant(within)
  const wilks = determinantTotal === 0 ? 0 : determinantWithin / determinantTotal
  const functions = Math.min(order.length - 1, width)
  const eigenvalues = canonicalEigenvalues(within, between, functions)
  const eigenvalueTotal = eigenvalues.reduce((sum, value) => sum + value, 0)

  // Fisher's linear discriminant functions: a_g = S⁻¹·mean_g, constant read at
  // the pooled mean, so a case is classified by the largest score.
  const priors = options.priors === 'size'
    ? new Map(order.map((key) => [key, (groups.get(key) ?? []).length / total]))
    : new Map(order.map((key) => [key, 1 / order.length]))
  const fisher = new Map()
  for (const key of order) {
    const center = means.get(key)
    const weights = Array.from({ length: width }, (_, row) => pooledInverse[row].reduce((sum, entry, column) => sum + entry * center[column], 0))
    const constant = -0.5 * weights.reduce((sum, weight, column) => sum + weight * center[column], 0) + Math.log(priors.get(key))
    fisher.set(key, { weights, constant })
  }

  const scoreOf = (values, key) => {
    const { weights, constant } = fisher.get(key)
    return values.reduce((sum, value, column) => sum + value * weights[column], 0) + constant
  }

  const confusion = new Map(order.map((key) => [key, new Map(order.map((other) => [other, 0]))]))
  const hits = new Map(order.map((key) => [key, 0]))
  for (const entry of cases) {
    let best = order[0]
    let bestScore = scoreOf(entry.values, best)
    for (const key of order.slice(1)) {
      const score = scoreOf(entry.values, key)
      if (score > bestScore) {
        best = key
        bestScore = score
      }
    }
    confusion.get(entry.group).set(best, (confusion.get(entry.group).get(best) ?? 0) + 1)
    if (best === entry.group) hits.set(entry.group, (hits.get(entry.group) ?? 0) + 1)
  }

  const format = (value) => (Number.isFinite(value) ? round(value).toFixed(4) : '—')
  const formatP = (value) => {
    if (!Number.isFinite(value)) return '—'
    const rounded = round(value)
    return rounded < 0.001 ? '<0.001' : rounded.toFixed(3)
  }

  const classification = [
    ['实际组', ...order.map((key) => `预测：${labelOf(groupVariable, key)}`), '正确数', '正确率'],
    ...order.map((key) => {
      const row = [labelOf(groupVariable, key), ...order.map((other) => String(confusion.get(key).get(other) ?? 0))]
      const members = (groups.get(key) ?? []).length
      const correct = hits.get(key) ?? 0
      row.push(String(correct), `${((correct / members) * 100).toFixed(1)}%`)
      return row
    }),
  ]

  const eigenvaluesTable = eigenvalues.map((value, index) => [
    String(index + 1),
    format(value),
    `${((value / (eigenvalueTotal || 1)) * 100).toFixed(1)}%`,
    `${((eigenvalues.slice(0, index + 1).reduce((sum, entry) => sum + entry, 0) / (eigenvalueTotal || 1)) * 100).toFixed(1)}%`,
    format(Math.sqrt(value / (1 + value))),
  ])

  const fisherTable = predictors.map((variable, column) => [
    variable.name,
    ...order.map((key) => format(fisher.get(key).weights[column])),
  ])

  const lambdaChi = -(total - 1 - (width + order.length) / 2) * Math.log(Math.max(wilks, 1e-300))
  const lambdaDf = width * (order.length - 1)
  const correct = order.reduce((sum, key) => sum + (hits.get(key) ?? 0), 0)

  return {
    title: `${options.group} 的判别分析`,
    tables: [
      {
        caption: '分类结果',
        matrix: classification,
        notes: [
          `个案 ${total} 例，按 ${order.length} 组分类；先验概率${options.priors === 'size' ? '按各组个案数' : '相等'}。`,
          `总体正确率 ${((correct / total) * 100).toFixed(1)}%（${correct} / ${total}）。`,
        ],
      },
      {
        caption: '特征值',
        matrix: [['函数', '特征值', '方差百分比', '累积百分比', '典型相关'], ...eigenvaluesTable],
        notes: eigenvalues.length === 0 ? ['没有可估计的判别函数。'] : [],
      },
      {
        caption: 'Wilks 的 Lambda',
        matrix: [
          ['函数检验', 'Wilks 的 Lambda', '卡方', 'df', 'P'],
          ['1 到 ' + functions, format(wilks), format(lambdaChi), String(lambdaDf), formatP(chiSquareP(lambdaChi, lambdaDf))],
        ],
        notes: [
          'Wilks 的 Lambda 用组内与总散度矩阵的行列式之比；卡方近似取 Bartlett 的形式，小样本时只作参考。',
        ],
      },
      {
        caption: 'Fisher 线性判别函数',
        matrix: [['变量', ...order.map((key) => `组 ${labelOf(groupVariable, key)}`)], ...fisherTable],
        notes: ['系数已含先验常数项在内的是每组各自的判别式；把个案值代入后取分数最大的组。'],
      },
    ],
    model: {
      n: total,
      groups: order,
      wilks: round(wilks),
      lambdaChiSquare: round(lambdaChi),
      lambdaDf,
      lambdaP: formatP(chiSquareP(lambdaChi, lambdaDf)),
      eigenvalues: eigenvalues.map((value) => round(value)),
      correct,
      accuracy: round(correct / total),
    },
  }
}
