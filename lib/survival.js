import { isUserMissing } from './missing.js'
import { chiSquareP } from './tables.js'

/**
 * Kaplan–Meier survival, computed inside the plugin.
 *
 * PSPP 2.1.3 has no survival procedure at all (it answers "not yet
 * implemented"), so the product-limit curve, the median and the log-rank test
 * are all estimated here. The chart renderer lives in charts.js and only draws
 * the model this module returns, which keeps the maths and the picture apart.
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

function labelFor(variable, value) {
  if (!variable || value === null || value === undefined) return ''
  const labels = variable.valueLabels ?? variable.labels ?? null
  if (labels && Object.prototype.hasOwnProperty.call(labels, String(value))) return String(labels[String(value)])
  return String(value)
}

function columnOf(dataset, name) {
  return (dataset.variables ?? []).findIndex((variable) => variable.name === name)
}

// Invert a small square matrix with Gauss–Jordan elimination. The log-rank test
// needs this because its covariance matrix is not diagonal, and doing the 2×2
// shortcut only would break the moment a third group appears.
function invertMatrix(matrix) {
  const size = matrix.length
  const work = matrix.map((row, index) => [
    ...row.map((value) => Number(value)),
    ...Array.from({ length: size }, (_, column) => (column === index ? 1 : 0)),
  ])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row
    }
    if (Math.abs(work[pivot][column]) < 1e-12) {
      throw new Error('log-rank 的方差矩阵是奇异的：某一组在整个随访里没有事件')
    }
    if (pivot !== column) {
      const swap = work[pivot]
      work[pivot] = work[column]
      work[column] = swap
    }
    const divisor = work[column][column]
    for (let index = 0; index < size * 2; index += 1) work[column][index] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = work[row][column]
      if (factor === 0) continue
      for (let index = 0; index < size * 2; index += 1) work[row][index] -= factor * work[column][index]
    }
  }
  return work.map((row) => row.slice(size))
}

export function computeKaplanMeier(dataset, options = {}) {
  const rows = dataset.rows ?? []
  const timeVariable = (dataset.variables ?? []).find((variable) => variable.name === options.time)
  if (!timeVariable) throw new Error(`unknown variable: ${options.time}`)
  if (!numeric(timeVariable)) throw new Error(`生存时间要求数值变量：${options.time} 是文本变量`)
  const eventVariable = (dataset.variables ?? []).find((variable) => variable.name === options.event)
  if (!eventVariable) throw new Error(`unknown variable: ${options.event}`)
  if (!numeric(eventVariable)) {
    throw new Error(`事件指示变量要求数值（1 = 事件发生，0 = 删失）：${options.event} 是文本变量`)
  }
  const groupVariable = options.group
    ? (dataset.variables ?? []).find((variable) => variable.name === options.group)
    : null
  if (options.group && !groupVariable) throw new Error(`unknown variable: ${options.group}`)
  const timeIndex = columnOf(dataset, options.time)
  const eventIndex = columnOf(dataset, options.event)
  const groupIndex = groupVariable ? columnOf(dataset, options.group) : -1

  const buckets = new Map()
  for (const row of rows) {
    const time = valueOf(timeVariable, row[timeIndex])
    if (time === null || time < 0) continue
    const flag = valueOf(eventVariable, row[eventIndex])
    if (flag === null) continue
    const groupValue = groupIndex >= 0 ? valueOf(groupVariable, row[groupIndex]) : null
    if (groupIndex >= 0 && groupValue === null) continue
    const key = groupIndex >= 0 ? String(groupValue) : '__all__'
    const bucket = buckets.get(key) ?? {
      key,
      label: groupIndex >= 0 ? labelFor(groupVariable, groupValue) : '全部个案',
      subjects: [],
    }
    bucket.subjects.push({ time, event: Number(flag) === 1 })
    buckets.set(key, bucket)
  }
  if (buckets.size === 0) throw new Error('没有可用的生存数据（生存时间与事件指示都得有值）')

  const groups = [...buckets.values()].map((bucket) => {
    const subjects = bucket.subjects
    const eventTimes = [...new Set(subjects.filter((subject) => subject.event).map((subject) => subject.time))].sort(
      (left, right) => left - right,
    )
    const curve = []
    let survival = 1
    let greenwood = 0
    for (const time of eventTimes) {
      const atRisk = subjects.filter((subject) => subject.time >= time).length
      const deaths = subjects.filter((subject) => subject.event && subject.time === time).length
      if (atRisk === 0 || deaths === 0) continue
      survival *= 1 - deaths / atRisk
      greenwood += deaths / (atRisk * (atRisk - deaths))
      const se = survival * Math.sqrt(greenwood)
      curve.push({
        time,
        survival: round(survival),
        atRisk,
        deaths,
        ciLow: round(Math.max(0, survival - 1.96 * se)),
        ciHigh: round(Math.min(1, survival + 1.96 * se)),
      })
    }
    // A censor mark sits on the curve at the height it had when the case left.
    const censoredTicks = [...new Set(subjects.filter((subject) => !subject.event).map((subject) => subject.time))]
      .sort((left, right) => left - right)
      .map((time) => {
        const before = [...curve].reverse().find((point) => point.time <= time)
        return { time, survival: before ? before.survival : 1 }
      })
    const medianPoint = curve.find((point) => point.survival <= 0.5) ?? null
    const followedUntil = Math.max(...subjects.map((subject) => subject.time))
    return {
      key: bucket.key,
      label: bucket.label,
      n: subjects.length,
      events: subjects.filter((subject) => subject.event).length,
      censored: subjects.filter((subject) => !subject.event).length,
      curve,
      censoredTicks,
      median: medianPoint ? medianPoint.time : null,
      followedUntil,
      subjects,
    }
  })

  const logRank = groups.length > 1 ? logRankTest(groups) : null
  return {
    kind: 'km',
    title: options.group
      ? `${options.time} 的 Kaplan–Meier 生存曲线（按 ${options.group} 分组）`
      : `${options.time} 的 Kaplan–Meier 生存曲线`,
    time: options.time,
    event: options.event,
    group: options.group ?? null,
    groups: groups.map(({ subjects, ...rest }) => rest),
    maxTime: Math.max(...groups.map((group) => group.followedUntil), 1),
    logRank,
  }
}

// Observed minus expected events summed over the distinct event times, then a
// quadratic form with the inverse covariance matrix. The last group is dropped
// because the counts sum to zero, which is also why df = groups − 1.
function logRankTest(groups) {
  const times = [
    ...new Set(groups.flatMap((group) => group.subjects.filter((subject) => subject.event).map((subject) => subject.time))),
  ].sort((left, right) => left - right)
  const count = groups.length
  const observed = Array.from({ length: count }, () => 0)
  const expected = Array.from({ length: count }, () => 0)
  const variance = Array.from({ length: count }, () => Array.from({ length: count }, () => 0))
  for (const time of times) {
    const atRisk = groups.map((group) => group.subjects.filter((subject) => subject.time >= time).length)
    const deaths = groups.map(
      (group) => group.subjects.filter((subject) => subject.event && subject.time === time).length,
    )
    const totalRisk = atRisk.reduce((total, value) => total + value, 0)
    const totalDeaths = deaths.reduce((total, value) => total + value, 0)
    // With a single case left at risk the variance contribution is zero (the
    // denominator would be totalRisk − 1); counting it would poison the matrix
    // with NaN, which is how the first version of this silently returned null.
    if (totalRisk <= 1 || totalDeaths === 0) continue
    const factor = (totalDeaths * (totalRisk - totalDeaths)) / (totalRisk - 1)
    for (let row = 0; row < count; row += 1) {
      observed[row] += deaths[row]
      expected[row] += totalDeaths * (atRisk[row] / totalRisk)
      for (let column = 0; column < count; column += 1) {
        const share = atRisk[row] / totalRisk
        variance[row][column] +=
          row === column
            ? factor * share * (1 - share)
            : -factor * share * (atRisk[column] / totalRisk)
      }
    }
  }
  const reduced = variance.slice(0, count - 1).map((row) => row.slice(0, count - 1))
  const delta = observed.slice(0, count - 1).map((value, index) => value - expected[index])
  const inverse = invertMatrix(reduced)
  const chiSquare = delta.reduce(
    (total, value, row) => total + value * inverse[row].reduce((sum, entry, index) => sum + entry * delta[index], 0),
    0,
  )
  return {
    chiSquare: round(chiSquare),
    df: count - 1,
    p: round(chiSquareP(chiSquare, count - 1)),
  }
}
