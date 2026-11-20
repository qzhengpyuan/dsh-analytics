/**
 * Identify unusual cases, computed here because PSPP has no such command.
 *
 * SPSS's "Identify Outliers" is a data step: it flags cases whose value on some
 * variable falls outside a percentile band, then hands you a table and, on
 * request, indicator variables to filter on. Same idea here, on the matrix the
 * host already holds, and with the same missing-value rule every other table
 * uses — a declared code is not a value, it is an absence.
 */
import { isUserMissing } from './missing.js'

function quantile(sorted, p) {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function show(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '·'
  return Number(value.toFixed(digits)).toString()
}

export function outlierReport(dataset, options = {}) {
  if (!dataset || dataset.variables.length === 0) return null
  const band = Array.isArray(options.percentiles) ? options.percentiles.map(Number) : []
  let lowPercent = Number.isFinite(band[0]) && band[0] > 0 && band[0] < 50 ? band[0] : 5
  let highPercent = Number.isFinite(band[1]) && band[1] > 50 && band[1] < 100 ? band[1] : 95
  if (highPercent <= lowPercent) {
    lowPercent = 5
    highPercent = 95
  }
  const requested = Array.isArray(options.variables) ? options.variables.map(String) : []
  const picked = []
  for (const name of requested) {
    const at = dataset.variables.findIndex((variable) => variable.name === name)
    if (at >= 0) picked.push(at)
  }
  // A percentile band only means something on a measured quantity, so strings
  // and dates stay out unless they were asked for by name — and even then the
  // numbers below just skip them.
  const columns = picked.length > 0
    ? picked
    : dataset.variables.map((variable, index) => (variable.type === 'numeric' ? index : -1)).filter((index) => index >= 0)
  if (columns.length === 0) return null

  const bounds = []
  for (const at of columns) {
    const variable = dataset.variables[at]
    const numbers = []
    for (const row of dataset.rows) {
      if (isUserMissing(variable, row[at])) continue
      const value = Number(row[at])
      if (Number.isFinite(value)) numbers.push(value)
    }
    if (numbers.length < 2) {
      bounds.push({ at, name: variable.name, label: variable.label || variable.name, lower: null, upper: null, n: numbers.length, below: 0, above: 0 })
      continue
    }
    numbers.sort((left, right) => left - right)
    bounds.push({
      at,
      name: variable.name,
      label: variable.label || variable.name,
      lower: quantile(numbers, lowPercent / 100),
      upper: quantile(numbers, highPercent / 100),
      n: numbers.length,
      below: 0,
      above: 0,
    })
  }
  // One pass over the rows: what each case is an outlier on, and how many.
  const flagCount = new Array(dataset.rows.length).fill(0)
  const details = []
  for (const [rowIndex, row] of dataset.rows.entries()) {
    for (const bound of bounds) {
      if (bound.lower === null) continue
      const variable = dataset.variables[bound.at]
      if (isUserMissing(variable, row[bound.at])) continue
      const value = Number(row[bound.at])
      if (!Number.isFinite(value)) continue
      let verdict = null
      if (value < bound.lower) {
        verdict = '低于下界'
        bound.below += 1
      } else if (value > bound.upper) {
        verdict = '高于上界'
        bound.above += 1
      }
      if (!verdict) continue
      flagCount[rowIndex] += 1
      details.push([String(rowIndex + 1), bound.label, show(value), verdict, `${show(bound.lower)} / ${show(bound.upper)}`])
    }
  }
  const flaggedCases = flagCount.filter((count) => count > 0).length

  const summary = {
    title: '标识异常个案：变量界值（插件计算）',
    matrix: [
      ['变量', '个案数', `下界（${lowPercent}%）`, `上界（${highPercent}%）`, '低于下界', '高于上界', '合计'],
      ...bounds.map((bound) => [
        bound.label,
        String(bound.n),
        show(bound.lower),
        show(bound.upper),
        String(bound.below),
        String(bound.above),
        String(bound.below + bound.above),
      ]),
    ],
    notes: [
      `界值取每个变量自身取值的第 ${lowPercent} 与第 ${highPercent} 百分位；判定只用这两条线，不假定正态`,
      `共 ${dataset.rows.length} 个个案，其中 ${flaggedCases} 个至少在一个变量上越界`,
      '判定口径与其它表一致：声明为缺失的码不参与计算，也不参与判定',
    ],
  }
  const shown = details.slice(0, 200)
  const detail = {
    title: '标识异常个案：越界的个案（插件计算）',
    matrix: [['个案号', '变量', '值', '判定', '下界 / 上界'], ...shown],
    notes: [
      details.length === 0
        ? '没有个案越界：所有取值都落在各自的百分位带之内'
        : `越界的「个案 × 变量」共 ${details.length} 处，落在 ${flaggedCases} 个个案上`,
    ],
  }
  if (details.length > shown.length) {
    detail.notes.push(`表里只列出前 ${shown.length} 处（共 ${details.length} 处）；要缩小范围，就少选几个变量或把百分位带放宽`)
  }
  const unbanded = bounds.filter((bound) => bound.lower === null)
  if (unbanded.length > 0) {
    summary.notes.splice(1, 0, `这几个变量没有两个以上的数值（或者根本不是数值变量），没有计算界值：${unbanded.map((bound) => bound.label).join('、')}`)
  }
  return {
    summary,
    details: detail,
    lowPercent,
    highPercent,
    variables: bounds.length,
    flagged: flaggedCases,
    hits: details.length,
    flagCount,
  }
}
