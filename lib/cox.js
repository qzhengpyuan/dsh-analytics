import { isUserMissing } from './missing.js'
import { chiSquareP } from './tables.js'

/**
 * Cox proportional-hazards regression, computed inside the plugin.
 *
 * PSPP 2.1.3 answers "not yet implemented" for COXREG, so the partial
 * likelihood is maximised here: Newton–Raphson on the Breslow approximation for
 * tied event times. The score statistic at β = 0 is the log-rank statistic when
 * there is a single binary covariate, which `test/cox.mjs` uses as an
 * independent check of the machinery.
 */

function numeric(variable) {
  return variable?.type !== 'string'
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function valueOf(variable, raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (isUserMissing(variable, raw)) return null
  if (!numeric(variable)) return String(raw)
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function columnOf(dataset, name) {
  return (dataset.variables ?? []).findIndex((variable) => variable.name === name)
}

// Solve a small linear system with partial pivoting (p = number of covariates).
function solve(matrix, vector) {
  const size = vector.length
  const work = matrix.map((row, index) => [...row.map((value) => Number(value)), Number(vector[index])])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row
    }
    if (Math.abs(work[pivot][column]) < 1e-12) {
      throw new Error('Cox 的方程是奇异的：协变量之间完全共线，或者某个协变量在事件上没有任何变化')
    }
    if (pivot !== column) {
      const swap = work[pivot]
      work[pivot] = work[column]
      work[column] = swap
    }
    const divisor = work[column][column]
    for (let index = column; index <= size; index += 1) work[column][index] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = work[row][column]
      if (factor === 0) continue
      for (let index = column; index <= size; index += 1) work[row][index] -= factor * work[column][index]
    }
  }
  return work.map((row) => row[size])
}

function invert(matrix) {
  const size = matrix.length
  const columns = Array.from({ length: size }, (_, index) => {
    const unit = Array.from({ length: size }, (_, position) => (position === index ? 1 : 0))
    return solve(matrix, unit)
  })
  return Array.from({ length: size }, (_, row) => columns.map((column) => column[row]))
}

function zeros(width) {
  return Array.from({ length: width }, () => 0)
}

function zeroMatrix(width) {
  return Array.from({ length: width }, () => Array.from({ length: width }, () => 0))
}

export function computeCox(dataset, options = {}) {
  const rows = dataset.rows ?? []
  const variables = dataset.variables ?? []
  const timeVariable = variables.find((variable) => variable.name === options.time)
  if (!timeVariable) throw new Error(`unknown variable: ${options.time}`)
  if (!numeric(timeVariable)) throw new Error(`生存时间要求数值变量：${options.time} 是文本变量`)
  const eventVariable = variables.find((variable) => variable.name === options.event)
  if (!eventVariable) throw new Error(`unknown variable: ${options.event}`)
  if (!numeric(eventVariable)) {
    throw new Error(`事件指示变量要求数值（1 = 事件发生，0 = 删失）：${options.event} 是文本变量`)
  }
  const names = Array.isArray(options.covariates) ? options.covariates.map(String) : []
  if (names.length === 0) throw new Error('Cox 回归至少要一个协变量')
  if (names.length > 10) throw new Error('一次最多 10 个协变量：再多就该先做变量筛选，而不是硬塞进一个模型')
  const covariates = names.map((name) => {
    const variable = variables.find((entry) => entry.name === name)
    if (!variable) throw new Error(`unknown variable: ${name}`)
    if (!numeric(variable)) {
      throw new Error(`Cox 回归目前只收数值协变量：${name} 是分类变量，先用「转换 → 重新编码成不同变量」造哑变量`)
    }
    return { name, variable, index: columnOf(dataset, name) }
  })
  const timeIndex = columnOf(dataset, options.time)
  const eventIndex = columnOf(dataset, options.event)
  const times = []
  const events = []
  const design = []
  for (const row of rows) {
    const time = valueOf(timeVariable, row[timeIndex])
    if (time === null || time <= 0) continue
    const flag = valueOf(eventVariable, row[eventIndex])
    if (flag === null) continue
    const values = []
    let complete = true
    for (const covariate of covariates) {
      const value = valueOf(covariate.variable, row[covariate.index])
      if (value === null) {
        complete = false
        break
      }
      values.push(value)
    }
    if (!complete) continue
    times.push(time)
    events.push(Number(flag) === 1)
    design.push(values)
  }
  const count = times.length
  if (count < 5) throw new Error('可用的个案太少（少于 5 例），Cox 回归没有意义')
  const eventCount = events.filter(Boolean).length
  if (eventCount === 0) throw new Error('一次事件都没有发生：Cox 回归至少需要一次事件')
  const width = covariates.length

  // Centre the covariates: the partial likelihood is invariant to a shift, and
  // it keeps exp(η) away from overflow on a variable with a large scale.
  const means = Array.from({ length: width }, (_, column) => design.reduce((total, row) => total + row[column], 0) / count)
  const centered = design.map((row) => row.map((value, column) => value - means[column]))

  // Group the cases by event time once: the risk set only grows as the times go
  // backwards, so one pass over the distinct times accumulates everything.
  const byTime = new Map()
  for (let index = 0; index < count; index += 1) {
    const time = times[index]
    const bucket = byTime.get(time) ?? { all: [], events: [] }
    bucket.all.push(index)
    if (events[index]) bucket.events.push(index)
    byTime.set(time, bucket)
  }
  const distinctTimes = [...byTime.keys()].sort((left, right) => right - left)

  const evaluate = (beta) => {
    const eta = centered.map((row) => row.reduce((total, value, column) => total + value * beta[column], 0))
    const weights = eta.map((value) => Math.exp(value))
    let logLikelihood = 0
    const gradient = zeros(width)
    const information = zeroMatrix(width)
    const s0 = [0]
    const s1 = zeros(width)
    const s2 = zeroMatrix(width)
    for (const time of distinctTimes) {
      const bucket = byTime.get(time)
      for (const index of bucket.all) {
        const weight = weights[index]
        s0[0] += weight
        for (let row = 0; row < width; row += 1) {
          s1[row] += weight * centered[index][row]
          for (let column = 0; column < width; column += 1) {
            s2[row][column] += weight * centered[index][row] * centered[index][column]
          }
        }
      }
      const deaths = bucket.events.length
      if (deaths === 0) continue
      const mean = s1.map((value) => value / s0[0])
      logLikelihood += bucket.events.reduce((total, index) => total + eta[index], 0) - deaths * Math.log(s0[0])
      for (let row = 0; row < width; row += 1) {
        gradient[row] += bucket.events.reduce((total, index) => total + centered[index][row], 0) - deaths * mean[row]
        for (let column = 0; column < width; column += 1) {
          information[row][column] += deaths * (s2[row][column] / s0[0] - mean[row] * mean[column])
        }
      }
    }
    return { logLikelihood, gradient, information }
  }

  const nullFit = evaluate(zeros(width))
  let beta = zeros(width)
  let fit = nullFit
  let converged = false
  for (let iteration = 0; iteration < 30; iteration += 1) {
    fit = evaluate(beta)
    let delta
    try {
      delta = solve(fit.information, fit.gradient)
    } catch (error) {
      // Beta = 0 is the first step: if the information matrix is singular
      // there, the design itself is degenerate (collinear covariates) and no
      // amount of iteration will fix it. Later steps only fail when complete
      // separation pushes a coefficient towards infinity, and a table with a
      // warning beats no table at all.
      if (iteration === 0) throw error
      break
    }
    beta = beta.map((value, index) => value + delta[index])
    if (Math.max(...delta.map(Math.abs)) < 1e-9) {
      converged = true
      break
    }
  }
  fit = evaluate(beta)
  const standardErrors = (() => {
    try {
      const inverse = invert(fit.information)
      return inverse.map((row, index) => Math.sqrt(Math.max(0, row[index])))
    } catch {
      return zeros(width)
    }
  })()

  const coefficients = covariates.map((covariate, index) => {
    const estimate = beta[index]
    const se = standardErrors[index]
    const wald = se > 0 ? (estimate / se) ** 2 : Number.NaN
    return {
      name: covariate.name,
      b: round(estimate),
      se: round(se),
      wald: round(wald),
      p: Number.isFinite(wald) ? round(chiSquareP(wald, 1)) : null,
      hazardRatio: round(Math.exp(estimate)),
      ciLow: round(Math.exp(estimate - 1.96 * se)),
      ciHigh: round(Math.exp(estimate + 1.96 * se)),
    }
  })

  const likelihoodRatio = 2 * (fit.logLikelihood - nullFit.logLikelihood)
  const score = (() => {
    try {
      const inverse = invert(nullFit.information)
      return nullFit.gradient.reduce(
        (total, value, row) => total + value * inverse[row].reduce((sum, entry, column) => sum + entry * nullFit.gradient[column], 0),
        0,
      )
    } catch {
      return Number.NaN
    }
  })()
  const waldGlobal = (() => {
    try {
      const inverse = invert(fit.information)
      return beta.reduce((total, value, row) => total + value * inverse[row].reduce((sum, entry, column) => sum + entry * beta[column], 0), 0)
    } catch {
      return Number.NaN
    }
  })()

  const format = (value) => (Number.isFinite(value) ? round(value).toFixed(4) : '—')
  const formatP = (value) => {
    if (!Number.isFinite(value)) return '—'
    const rounded = round(value)
    return rounded < 0.001 ? '<0.001' : rounded.toFixed(3)
  }
  const matrix = [
    ['变量', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)', '95% CI 下限', '95% CI 上限'],
    ...coefficients.map((entry) => [
      entry.name,
      entry.b.toFixed(4),
      entry.se.toFixed(4),
      format(entry.wald),
      '1',
      formatP(entry.p),
      entry.hazardRatio.toFixed(4),
      entry.ciLow.toFixed(4),
      entry.ciHigh.toFixed(4),
    ]),
  ]
  const notes = [
    `个案 ${count} 例，事件 ${eventCount} 例（删失 ${count - eventCount} 例）；缺失值按整例剔除。`,
    `-2 对数似然 = ${(-2 * fit.logLikelihood).toFixed(4)}；似然比 χ² = ${format(likelihoodRatio)}（df = ${width}，P = ${formatP(chiSquareP(likelihoodRatio, width))}）。`,
    `得分检验 χ² = ${format(score)}（df = ${width}，P = ${formatP(chiSquareP(score, width))}）；Wald 检验 χ² = ${format(waldGlobal)}（df = ${width}，P = ${formatP(chiSquareP(waldGlobal, width))}）。`,
    '并列事件时间用 Breslow 近似；协变量在计算时已中心化，不影响 B 与 Exp(B)。',
  ]
  if (!converged) notes.push('注意：牛顿迭代 30 步没有收敛，系数可能不可靠（常见原因是协变量把事件完全分开）。')
  if (covariates.length > 0 && means.some((mean) => !Number.isFinite(mean))) notes.push('注意：某个协变量的均值不是有限值，请检查数据。')

  return {
    title: `${options.time} 的 Cox 比例风险回归`,
    matrix,
    notes,
    model: {
      n: count,
      events: eventCount,
      coefficients,
      logLikelihood: round(fit.logLikelihood),
      likelihoodRatio: round(likelihoodRatio),
      score: round(score),
      wald: round(waldGlobal),
      converged,
    },
  }
}
