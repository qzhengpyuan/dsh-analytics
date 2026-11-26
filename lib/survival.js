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
  if (!timeVariable) throw new Error(`没有这个变量：${options.time}`)
  if (!numeric(timeVariable)) throw new Error(`生存时间要求数值变量：${options.time} 是文本变量`)
  const eventVariable = (dataset.variables ?? []).find((variable) => variable.name === options.event)
  if (!eventVariable) throw new Error(`没有这个变量：${options.event}`)
  if (!numeric(eventVariable)) {
    throw new Error(`事件指示变量要求数值（1 = 事件发生，0 = 删失）：${options.event} 是文本变量`)
  }
  const groupVariable = options.group
    ? (dataset.variables ?? []).find((variable) => variable.name === options.group)
    : null
  if (options.group && !groupVariable) throw new Error(`没有这个变量：${options.group}`)
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
      // atRisk === deaths is the last step of a group where everyone still at
      // risk dies now: S is exactly 0 and the Greenwood term divides by zero.
      // Skipping it keeps the band at (0, 0) instead of 0 × ∞ = NaN, which the
      // renderer would have turned into "NaN" coordinates and the browser into
      // a silently missing confidence band.
      if (deaths < atRisk) greenwood += deaths / (atRisk * (atRisk - deaths))
      const se = deaths < atRisk ? survival * Math.sqrt(greenwood) : 0
      curve.push({
        time,
        survival: round(survival),
        // 判定（中位、百分位）必须用未舍入的 S：S 的真值落在 (p, p+5e-5] 时，
        // 舍入到 4 位就成了 p，于是 0.50004 被当成「达到了中位数」。
        raw: survival,
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
    const medianPoint = curve.find((point) => point.raw <= 0.5) ?? null
    const followedUntil = Math.max(...subjects.map((subject) => subject.time))
    const limited = restrictedMean(curve, subjects, followedUntil)
    return {
      key: bucket.key,
      label: bucket.label,
      n: subjects.length,
      events: subjects.filter((subject) => subject.event).length,
      censored: subjects.filter((subject) => !subject.event).length,
      curve,
      censoredTicks,
      median: medianPoint ? medianPoint.time : null,
      mean: limited ? limited.mean : null,
      meanSe: limited ? limited.se : null,
      meanLow: limited ? limited.low : null,
      meanHigh: limited ? limited.high : null,
      percentiles: {
        p25: percentileOf(curve, 0.25),
        p50: medianPoint ? medianPoint.time : null,
        p75: percentileOf(curve, 0.75),
      },
      followedUntil,
      subjects,
    }
  })

  // 某组在别人的事件时间上无人在险时，约化方差是 0 阵、求逆会抛错（详见
  // lib/survival.js 的 logRankTest）。曲线本身完全可算，所以这里只放弃检验。
  const notes = []
  let logRank = null
  if (groups.length > 1) {
    const tested = groups.filter((group) => group.events > 0)
    if (tested.length < 2) {
      notes.push('有分组在这个随访里一个事件都没有，做不了 log-rank 检验（曲线照常给出）')
    } else {
      try {
        logRank = logRankTest(tested)
        if (tested.length < groups.length) {
          notes.push(`log-rank 只用了有事件的 ${tested.length} 组：${groups.filter((group) => group.events === 0).map((group) => group.label).join('、')} 没有事件，不进检验`)
        }
      } catch (error) {
        logRank = null
        notes.push(`log-rank 检验没有做成（${String(error.message).replace(/^log-rank 的方差矩阵是奇异的：/, '')}），曲线照常给出`)
      }
    }
  }
  return {
    kind: 'km',
    // A title the user edited wins over the generated one; the edit dialog sends
    // it back as options.title and used to be ignored here.
    title: typeof options.title === 'string' && options.title.trim()
      ? options.title.trim()
      : options.group
        ? `${options.time} 的 Kaplan–Meier 生存曲线（按 ${options.group} 分组）`
        : `${options.time} 的 Kaplan–Meier 生存曲线`,
    xLabel: typeof options.xLabel === 'string' && options.xLabel.trim() ? options.xLabel.trim() : `随访时间（${options.time}）`,
    time: options.time,
    event: options.event,
    group: options.group ?? null,
    groups: groups.map(({ subjects, ...rest }) => rest),
    maxTime: Math.max(...groups.map((group) => group.followedUntil), 1),
    logRank,
    notes,
  }
}

/**
 * 限制均值（restricted mean survival time）与百分位。
 *
 * 曲线是阶梯函数：每个事件时间 t_i 上 S 掉一截。面积按左端点取值累加 ——
 * 区间 [t_{i-1}, t_i) 用的是 t_{i-1} 之后的 S，最后一段从最后一个事件时间量到
 * 随访终点 followedUntil。所以「均值」是**截到随访终点**的限制均值，不是到 ∞
 * 的均值：随访不够长时后者根本估不出来（曲线尾部没有数据）。
 *
 * 方差用 Klein–Moeschberger 的 RMST 公式：
 *   Var(μ̂) = Σ_i [∫_{t_i}^{τ} Ŝ(u) du]^2 · d_i / (Y_i (Y_i − d_i))
 * 只有 Y_i > d_i 的项能进（分母为 0 的项跳过），与 Greenwood 的守卫同一个理由。
 */
function restrictedMean(curve, subjects, until) {
  if (!Number.isFinite(until) || until <= 0) return null
  const points = curve.filter((point) => point.time <= until)
  let area = 0
  let previous = 0
  let survival = 1
  for (const point of points) {
    area += survival * (point.time - previous)
    survival = point.survival
    previous = point.time
  }
  area += survival * Math.max(0, until - previous)
  // 方差：每个事件时间往后到 τ 的面积
  let variance = 0
  for (const point of points) {
    const atRisk = point.atRisk
    const deaths = point.deaths
    if (!(atRisk > deaths)) continue
    let tail = 0
    let previousTime = point.time
    let level = point.survival
    for (const later of points.filter((entry) => entry.time > point.time)) {
      tail += level * (later.time - previousTime)
      level = later.survival
      previousTime = later.time
    }
    tail += level * Math.max(0, until - previousTime)
    variance += (tail * tail * deaths) / (atRisk * (atRisk - deaths))
  }
  const se = Math.sqrt(variance)
  return {
    mean: round(area),
    se: round(se),
    low: round(Math.max(0, area - 1.96 * se)),
    high: round(area + 1.96 * se),
    until,
  }
}

/** p 分位：第一个 S(t) ≤ p 的事件时间；没到就返回 null（报告里记「未达到」）。 */
export function percentileOf(curve, p) {
  // 用未舍入的 S（entry.raw）判定：0.50004 不是「达到中位数」，舍入成 0.5000
  // 就会误报（复验抓到过这一点）。
  const point = curve.find((entry) => (Number.isFinite(entry.raw) ? entry.raw : entry.survival) <= p)
  return point ? point.time : null
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
