// Time-series smoothing. PSPP 2.1.3 returns "TSLINE: Unknown command" and has no
// exponential smoothing, so the fits, the error statistics and the series chart
// are all computed here.
//
// Every method reports the one-step-ahead forecast at each point, which is what
// makes the residuals comparable across methods: the residual at case t is
// y_t minus the forecast made from the cases before t.

export const TS_METHODS = ['ma', 'ses', 'des']

const METHOD_LABELS = {
  ma: '移动平均',
  ses: '简单指数平滑',
  des: '双指数平滑（Holt）',
}

function numericSeries(dataset, name) {
  const variable = (dataset.variables ?? []).find((entry) => entry.name === name)
  if (!variable) throw new Error(`没有这个变量：${name}`)
  if (variable.type !== 'numeric') throw new Error(`时间序列要求数值变量：${name} 是文本变量`)
  const index = dataset.variables.indexOf(variable)
  const values = []
  const cases = []
  ;(dataset.rows ?? []).forEach((row, position) => {
    const value = row[index]
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return
    values.push(Number(value))
    cases.push(position + 1)
  })
  return { variable, values, cases }
}

function movingAverage(values, span) {
  const fitted = values.map((_, index) => {
    if (index < span) return null
    let total = 0
    for (let offset = 1; offset <= span; offset += 1) total += values[index - offset]
    return total / span
  })
  const tail = values.slice(-span)
  const next = tail.length === span ? tail.reduce((sum, value) => sum + value, 0) / span : null
  return { fitted, slope: 0, next, params: { span } }
}

function simpleSmoothing(values, alpha) {
  const fitted = new Array(values.length).fill(null)
  let level = values[0]
  fitted[0] = values[0]
  for (let index = 1; index < values.length; index += 1) {
    fitted[index] = level
    level = alpha * values[index] + (1 - alpha) * level
  }
  return { fitted, slope: 0, next: level, params: { alpha } }
}

function holt(values, alpha, beta) {
  const fitted = new Array(values.length).fill(null)
  let level = values[0]
  let trend = values.length > 1 ? values[1] - values[0] : 0
  fitted[0] = values[0]
  for (let index = 1; index < values.length; index += 1) {
    const predicted = level + trend
    fitted[index] = predicted
    const previous = level
    level = alpha * values[index] + (1 - alpha) * predicted
    trend = beta * (level - previous) + (1 - beta) * trend
  }
  return { fitted, slope: trend, next: level + trend, params: { alpha, beta } }
}

function errorStats(values, fitted) {
  let count = 0
  let absolute = 0
  let squared = 0
  let percent = 0
  let percentCount = 0
  values.forEach((value, index) => {
    const predicted = fitted[index]
    if (predicted === null || predicted === undefined) return
    const residual = value - predicted
    count += 1
    absolute += Math.abs(residual)
    squared += residual * residual
    if (value !== 0) {
      percent += Math.abs(residual / value)
      percentCount += 1
    }
  })
  return {
    count,
    mae: count ? absolute / count : null,
    rmse: count ? Math.sqrt(squared / count) : null,
    mape: percentCount ? (percent / percentCount) * 100 : null,
  }
}

/**
 * Fit a series and, when asked, extend it.
 *
 * `periods` forecasts are appended to the fitted line so the chart shows where
 * the model goes after the last observed case; they are also listed in the
 * series table with an empty actual column.
 */
export function computeTimeSeries(dataset, options = {}) {
  const name = String(options.variable ?? '').trim()
  if (!name) throw new Error('要选一个时间序列变量')
  const { variable, values, cases } = numericSeries(dataset, name)
  if (values.length < 3) throw new Error(`时间序列至少要 3 个有效个案，现在只有 ${values.length} 个`)
  const method = String(options.method ?? 'ses').toLowerCase()
  if (!TS_METHODS.includes(method)) throw new Error(`不认识的平滑方法：${method}（可用：${TS_METHODS.join('、')}）`)
  let span = Math.trunc(Number(options.span ?? 4))
  if (!Number.isFinite(span) || span < 1) span = 4
  span = Math.min(span, Math.max(1, values.length - 1))
  let alpha = Number(options.alpha ?? 0.3)
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('平滑系数 α 要在 0 和 1 之间')
  let beta = Number(options.beta ?? 0.2)
  if (!Number.isFinite(beta) || beta < 0 || beta > 1) throw new Error('趋势系数 β 要在 0 和 1 之间')
  let periods = Math.trunc(Number(options.periods ?? 0))
  if (!Number.isFinite(periods) || periods < 0 || periods > 60) throw new Error('预测期数要在 0 到 60 之间')

  const fittedByMethod = method === 'ma'
    ? movingAverage(values, span)
    : method === 'ses'
      ? simpleSmoothing(values, alpha)
      : holt(values, alpha, beta)
  const { fitted, next } = fittedByMethod
  const stats = errorStats(values, fitted)

  const forecast = []
  for (let step = 1; step <= periods; step += 1) {
    forecast.push(method === 'des' && next !== null ? next + (step - 1) * fittedByMethod.slope : next)
  }

  const label = variable.label || variable.name
  const rows = [['个案', '实测值', '拟合值', '残差']]
  values.forEach((value, index) => {
    const predicted = fitted[index]
    rows.push([
      String(cases[index]),
      value.toFixed(3),
      predicted === null ? '' : predicted.toFixed(3),
      predicted === null ? '' : (value - predicted).toFixed(3),
    ])
  })
  const lastCase = cases[cases.length - 1]
  forecast.forEach((value, index) => {
    rows.push([`${lastCase}+${index + 1}`, '', value === null ? '' : value.toFixed(3), ''])
  })
  // A few thousand rows of numbers is more than the panel needs to see; the CSV
  // export still carries every row because it walks the session's data instead.
  const shown = rows.length > 202 ? [...rows.slice(0, 201), ['…', '…', '…', '…']] : rows

  const summary = [['项目', '值'], ['方法', METHOD_LABELS[method]]]
  if (method === 'ma') summary.push(['移动平均的期数', String(span)])
  if (method === 'ses') summary.push(['平滑系数 α', alpha.toFixed(2)])
  if (method === 'des') {
    summary.push(['平滑系数 α', alpha.toFixed(2)])
    summary.push(['趋势系数 β', beta.toFixed(2)])
  }
  summary.push(['参与拟合的个案', String(stats.count)])
  summary.push(['平均绝对误差 MAE', stats.mae === null ? '—' : stats.mae.toFixed(3)])
  summary.push(['均方根误差 RMSE', stats.rmse === null ? '—' : stats.rmse.toFixed(3)])
  summary.push(['平均绝对百分误差 MAPE', stats.mape === null ? '—' : `${stats.mape.toFixed(1)}%`])

  const labels = Array.from({ length: values.length + periods }, (_, index) => String(cases[index] ?? `${lastCase}+${index - values.length + 1}`))
  const observed = values.concat(new Array(periods).fill(null))
  const fittedLine = fitted.concat(forecast)
  const series = [
    { key: 'observed', label: `${label}（实测）`, points: labels.map((entry, index) => ({ label: entry, value: observed[index] })) },
    { key: 'fitted', label: `拟合（${METHOD_LABELS[method]}）`, points: labels.map((entry, index) => ({ label: entry, value: fittedLine[index] })) },
  ]
  if (periods === 0) series.pop()

  return {
    title: `${label} 的时间序列`,
    method,
    tables: [
      { caption: '模型摘要', matrix: summary },
      { caption: `序列与拟合值（${METHOD_LABELS[method]}）`, matrix: shown },
    ],
    notes: [
      `方法：${METHOD_LABELS[method]}；${
        method === 'ma' ? `期数 ${span}` : method === 'ses' ? `α = ${alpha.toFixed(2)}` : `α = ${alpha.toFixed(2)}，β = ${beta.toFixed(2)}`
      }。`,
      '拟合值一律是「用这一期之前的值做的一步预测」，残差 = 实测 − 拟合，前几期没有拟合值是因为方法还缺初始历史。',
      periods > 0
        ? `已外推 ${periods} 期，图上接在实测线后面；指数平滑的外推沿最后一段趋势走，期数越多越不可靠。`
        : '没有外推：需要预测时把「预测期数」填上。',
    ],
    model: {
      variable: name,
      method,
      values,
      cases,
      fitted,
      forecast,
      residuals: values.map((value, index) => (fitted[index] === null ? null : value - fitted[index])),
      ...stats,
    },
    chart: {
      kind: 'line',
      title: `${label} 的时间序列（${METHOD_LABELS[method]}）`,
      xLabel: '个案',
      yLabel: label,
      labels,
      series,
      points: [],
    },
  }
}

export { METHOD_LABELS }
