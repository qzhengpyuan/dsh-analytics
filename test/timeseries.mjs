// Time-series smoothing. PSPP 2.1.3 answers "TSLINE: Unknown command" and has no
// exponential smoothing, so the recursion, the one-step forecasts and the error
// statistics are all computed here. Each expected value below was worked out by
// hand from the definition, not copied out of the implementation.
import assert from 'node:assert/strict'

import { computeTimeSeries } from '../lib/timeseries.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const series = (values) => ({
  variables: [{ name: 'y', type: 'numeric' }],
  rows: values.map((value) => [value]),
})

const round = (value, digits = 4) => (value === null ? null : Number(value.toFixed(digits)))

check('a moving average forecasts the mean of the previous window, and nothing before it', () => {
  const out = computeTimeSeries(series([1, 2, 3, 4, 5, 6]), { variable: 'y', method: 'ma', span: 2, periods: 2 })
  assert.deepEqual(out.model.fitted.map((value) => round(value)), [null, null, 1.5, 2.5, 3.5, 4.5])
  assert.deepEqual(out.model.forecast.map((value) => round(value)), [5.5, 5.5])
  // Residuals: 3-1.5, 4-2.5, 5-3.5, 6-4.5 -> all 1.5.
  assert.equal(round(out.model.mae), 1.5)
  assert.equal(out.model.count, 4)
})

check('simple exponential smoothing applies level = a*y + (1-a)*level', () => {
  const out = computeTimeSeries(series([1, 2, 3, 4, 5, 6]), { variable: 'y', method: 'ses', alpha: 0.5, periods: 1 })
  assert.deepEqual(out.model.fitted.map((value) => round(value)), [1, 1, 1.5, 2.25, 3.125, 4.0625])
  // The last level, 4.0625 + 0.5*(6 - 4.0625) = 5.03125.
  assert.equal(round(out.model.forecast[0], 6), 5.03125)
})

check('Holt smoothing reproduces a straight line exactly and extends it', () => {
  const out = computeTimeSeries(series([1, 2, 3, 4, 5, 6]), { variable: 'y', method: 'des', alpha: 0.5, beta: 0.5, periods: 2 })
  assert.deepEqual(out.model.fitted.map((value) => round(value)), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(out.model.forecast.map((value) => round(value)), [7, 8])
  assert.equal(round(out.model.mae), 0)
})

check('the summary table names the method, the parameters and the three errors', () => {
  const out = computeTimeSeries(series([2, 4, 6, 8]), { variable: 'y', method: 'ma', span: 2 })
  const summary = out.tables[0]
  assert.equal(summary.caption, '模型摘要')
  const labels = summary.matrix.map((row) => row[0])
  assert.deepEqual(labels.slice(0, 2), ['项目', '方法'])
  assert.ok(labels.includes('平均绝对误差 MAE'))
  assert.ok(labels.includes('均方根误差 RMSE'))
  assert.ok(labels.includes('平均绝对百分误差 MAPE'))
  assert.equal(summary.matrix.find((row) => row[0] === '移动平均的期数')[1], '2')
})

check('the series table leaves the first fitted cells empty and adds the forecast rows', () => {
  const out = computeTimeSeries(series([1, 2, 3, 4]), { variable: 'y', method: 'ma', span: 2, periods: 2 })
  const matrix = out.tables[1].matrix
  assert.deepEqual(matrix[0], ['个案', '实测值', '拟合值', '残差'])
  assert.deepEqual(matrix[2], ['2', '2.000', '', ''])
  assert.deepEqual(matrix[3], ['3', '3.000', '1.500', '1.500'])
  assert.deepEqual(matrix[5], ['4+1', '', '3.500', ''])
  assert.deepEqual(matrix[6], ['4+2', '', '3.500', ''])
})

check('the chart draws the fit over the observed line and only extends the fit', () => {
  const out = computeTimeSeries(series([1, 2, 3, 4]), { variable: 'y', method: 'ses', alpha: 0.4, periods: 3 })
  assert.equal(out.chart.kind, 'line')
  assert.equal(out.chart.series.length, 2)
  assert.equal(out.chart.labels.length, 7)
  const observed = out.chart.series[0].points.map((point) => point.value)
  const fitted = out.chart.series[1].points.map((point) => point.value)
  assert.deepEqual(observed.slice(4), [null, null, null], 'the observed line stops at the last case')
  assert.ok(fitted.slice(4).every((value) => typeof value === 'number'), 'the forecast is drawn')
  assert.match(out.chart.series[1].label, /简单指数平滑/)
})

check('missing cases are dropped but the original case numbers are kept', () => {
  const dataset = {
    variables: [{ name: 'y', type: 'numeric' }],
    rows: [[1], [null], [3], [4]],
  }
  const out = computeTimeSeries(dataset, { variable: 'y', method: 'ma', span: 1 })
  assert.deepEqual(out.model.cases, [1, 3, 4])
  assert.deepEqual(out.tables[1].matrix.map((row) => row[0]).slice(1), ['1', '3', '4'])
})

check('the guards name the variable and the bound that failed', () => {
  const dataset = series([1, 2, 3])
  assert.throws(() => computeTimeSeries(dataset, {}), /要选一个时间序列变量/)
  assert.throws(() => computeTimeSeries(dataset, { variable: 'nope' }), /没有这个变量：nope/)
  assert.throws(
    () => computeTimeSeries({ variables: [{ name: 'g', type: 'string' }], rows: [['a'], ['b'], ['c']] }, { variable: 'g' }),
    /时间序列要求数值变量：g 是文本变量/,
  )
  assert.throws(() => computeTimeSeries(series([1, 2]), { variable: 'y' }), /时间序列至少要 3 个有效个案/)
  assert.throws(() => computeTimeSeries(dataset, { variable: 'y', method: 'ewma' }), /不认识的平滑方法：ewma（可用：ma、ses、des）/)
  assert.throws(() => computeTimeSeries(dataset, { variable: 'y', alpha: 1.5 }), /平滑系数 α 要在 0 和 1 之间/)
  assert.throws(() => computeTimeSeries(dataset, { variable: 'y', method: 'des', beta: -0.1 }), /趋势系数 β 要在 0 和 1 之间/)
  assert.throws(() => computeTimeSeries(dataset, { variable: 'y', periods: 61 }), /预测期数要在 0 到 60 之间/)
})

console.log(`${checks} checks passed`)
