import { isUserMissing } from './missing.js'
import { chiSquareP } from './tables.js'

/**
 * 竞争风险（competing risks）：累积发生率函数（CIF）、Aalen 方差、原因别 log-rank。
 *
 * PSPP 2.1.3 没有生存分析，更没有竞争风险，所以这里全部自算。口径按 Aalen–Johansen：
 * CIF_k(t) = Σ_{t_i ≤ t} S(t_{i−1}) · d_ki / n_i，其中 S 是**全因** Kaplan–Meier
 * （任何原因都算事件）。因此恒等式 Σ_k CIF_k(t) = 1 − S(t) 必须逐位成立 —— 用例就是
 * 靠它守住实现的（1 − KM 那条曲线是把删失当唯一出口，会系统性高估）。
 *
 * 组间检验是**原因别 log-rank**（把别的原因为删失后对每一类各做一次），不是 Gray 的
 * 次分布检验；两者回答的问题不同，注文里写清楚了。
 */

export const MAX_CAUSES = 6
export const MAX_TABLE_TIMES = 40
export const MAX_VARIANCE_TIMES = 300

function numeric(variable) {
  return variable?.type !== 'string'
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function blank(value) {
  return value === null || value === undefined || value === ''
}

function labelFor(variable, value) {
  const labels = variable?.valueLabels ?? variable?.labels ?? null
  if (labels && Object.prototype.hasOwnProperty.call(labels, String(value))) return String(labels[String(value)])
  return String(value)
}

function columnOf(dataset, name) {
  return (dataset.variables ?? []).findIndex((variable) => variable.name === name)
}

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
      throw new Error('原因别 log-rank 的方差矩阵是奇异的：某一组在这一类原因上一个事件都没有')
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

// 原因别 log-rank：event 只看这一类原因，别的原因为删失。
function causeLogRank(groups, cause) {
  if (groups.length < 2) return null
  const times = [...new Set(groups.flatMap((group) => group.subjects
    .filter((subject) => subject.cause === cause)
    .map((subject) => subject.time)))].sort((left, right) => left - right)
  const count = groups.length
  const observed = Array.from({ length: count }, () => 0)
  const expected = Array.from({ length: count }, () => 0)
  const variance = Array.from({ length: count }, () => Array.from({ length: count }, () => 0))
  for (const time of times) {
    const atRisk = groups.map((group) => group.subjects.filter((subject) => subject.time >= time).length)
    const deaths = groups.map((group) => group.subjects
      .filter((subject) => subject.cause === cause && subject.time === time).length)
    const totalRisk = atRisk.reduce((total, value) => total + value, 0)
    const totalDeaths = deaths.reduce((total, value) => total + value, 0)
    if (totalRisk <= 1 || totalDeaths === 0) continue
    const factor = (totalDeaths * (totalRisk - totalDeaths)) / (totalRisk - 1)
    for (let row = 0; row < count; row += 1) {
      observed[row] += deaths[row]
      expected[row] += totalDeaths * (atRisk[row] / totalRisk)
      for (let column = 0; column < count; column += 1) {
        const share = atRisk[row] / totalRisk
        variance[row][column] += row === column
          ? factor * share * (1 - share)
          : -factor * share * (atRisk[column] / totalRisk)
      }
    }
  }
  const reduced = variance.slice(0, count - 1).map((row) => row.slice(0, count - 1))
  const delta = observed.slice(0, count - 1).map((value, index) => value - expected[index])
  let inverse
  try {
    inverse = invertMatrix(reduced)
  } catch (error) {
    return { chiSquare: Number.NaN, df: count - 1, p: Number.NaN, note: error.message }
  }
  const chiSquare = delta.reduce(
    (total, value, row) => total + value * inverse[row].reduce((sum, entry, index) => sum + entry * delta[index], 0),
    0,
  )
  return {
    chiSquare: round(Math.max(0, chiSquare)),
    df: count - 1,
    p: round(chiSquareP(Math.max(0, chiSquare), count - 1)),
  }
}

export function computeCompetingRisks(dataset, options = {}) {
  if (!dataset) throw new Error('还没有打开数据集')
  const names = dataset.variables ?? []
  if (!options.time) throw new Error('竞争风险要指定生存时间变量')
  if (!options.status) throw new Error('竞争风险要指定状态变量（0 = 删失，其他取值为事件原因）')
  const timeIndex = columnOf(dataset, options.time)
  const statusIndex = columnOf(dataset, options.status)
  if (timeIndex < 0) throw new Error(`没有这个变量：${options.time}`)
  if (statusIndex < 0) throw new Error(`没有这个变量：${options.status}`)
  const timeVariable = names[timeIndex]
  const statusVariable = names[statusIndex]
  if (!numeric(timeVariable)) throw new Error(`生存时间要是数值变量：${options.time} 是文本变量（先转成数值）`)
  if (!numeric(statusVariable)) throw new Error(`状态变量要是数值变量：${options.status} 是文本变量（先用数值码记原因）`)

  let groupIndex = -1
  let groupVariable = null
  if (options.group) {
    groupIndex = columnOf(dataset, options.group)
    if (groupIndex < 0) throw new Error(`没有这个变量：${options.group}`)
    groupVariable = names[groupIndex]
  }
  if (groupIndex === timeIndex || groupIndex === statusIndex) {
    throw new Error('分组变量不能与生存时间或状态变量是同一个变量')
  }

  const subjects = []
  let dropped = 0
  for (const row of dataset.rows) {
    const rawTime = row[timeIndex]
    const rawStatus = row[statusIndex]
    if (blank(rawTime) || blank(rawStatus) || isUserMissing(timeVariable, rawTime)
      || isUserMissing(statusVariable, rawStatus)) {
      dropped += 1
      continue
    }
    const time = Number(rawTime)
    const status = Number(rawStatus)
    if (!Number.isFinite(time) || !Number.isFinite(status)) { dropped += 1; continue }
    if (time < 0) { dropped += 1; continue }
    let groupKey = '__all__'
    let groupLabel = '全部个案'
    if (groupIndex >= 0) {
      const rawGroup = row[groupIndex]
      if (blank(rawGroup) || isUserMissing(groupVariable, rawGroup)) { dropped += 1; continue }
      groupKey = String(rawGroup)
      groupLabel = labelFor(groupVariable, rawGroup)
    }
    subjects.push({ time, status, groupKey, groupLabel })
  }
  if (subjects.length < 2) throw new Error(`可用的个案太少：${subjects.length} 个个案（竞争风险至少要 2 个）`)

  // 原因：用户指定优先，否则按数据里出现过的非 0 状态码排序。
  const present = [...new Set(subjects.filter((subject) => subject.status !== 0).map((subject) => subject.status))]
    .sort((left, right) => left - right)
  let causes = Array.isArray(options.causes) && options.causes.length
    ? options.causes.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : present
  causes = [...new Set(causes)].sort((left, right) => left - right)
  if (!causes.length) throw new Error('状态变量里没有事件：所有个案都是 0（删失），做不了竞争风险')
  const missingCauses = causes.filter((cause) => !present.includes(cause))
  if (missingCauses.length) {
    throw new Error(`状态变量里没有这些原因码：${missingCauses.join('、')}（出现过的是：${present.join('、') || '无'}）`)
  }
  if (causes.length > MAX_CAUSES) {
    throw new Error(`原因太多了：${causes.length} 类，竞争风险在这里最多 ${MAX_CAUSES} 类（先把少见的原因合并）`)
  }
  const causeLabels = causes.map((cause) => ({
    code: cause,
    label: `${labelFor(statusVariable, cause)}（状态码 ${cause}）`,
  }))

  const buckets = new Map()
  for (const subject of subjects) {
    const bucket = buckets.get(subject.groupKey) ?? { key: subject.groupKey, label: subject.groupLabel, subjects: [] }
    // 不在 causes 里的状态码当作删失（注文会点名），这样「只看某一类原因」的说法成立。
    bucket.subjects.push({
      time: subject.time,
      cause: causes.includes(subject.status) ? subject.status : null,
      otherEvent: subject.status !== 0 && !causes.includes(subject.status),
    })
    buckets.set(subject.groupKey, bucket)
  }
  const groups = [...buckets.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'))

  const otherStatuses = [...new Set(subjects
    .filter((subject) => subject.status !== 0 && !causes.includes(subject.status))
    .map((subject) => subject.status))].sort((left, right) => left - right)

  for (const group of groups) {
    const eventTimes = [...new Set(group.subjects
      .filter((subject) => subject.cause !== null)
      .map((subject) => subject.time))].sort((left, right) => left - right)
    const rows = []
    let survival = 1
    let nextTime = 0
    const cumulative = new Map(causes.map((cause) => [cause, 0]))
    for (const time of eventTimes) {
      const atRisk = group.subjects.filter((subject) => subject.time >= time).length
      const deaths = group.subjects.filter((subject) => subject.cause !== null && subject.time === time).length
      const perCause = new Map(causes.map((cause) => [cause, group.subjects
        .filter((subject) => subject.cause === cause && subject.time === time).length]))
      if (atRisk === 0 || deaths === 0) continue
      const before = survival
      for (const cause of causes) cumulative.set(cause, cumulative.get(cause) + before * (perCause.get(cause) / atRisk))
      survival *= 1 - deaths / atRisk
      rows.push({
        time,
        nextTime,
        atRisk,
        deaths,
        perCause,
        survivalBefore: before,
        survival,
        cumulative: new Map(cumulative),
      })
      nextTime = time
    }
    group.rows = rows
    group.followedUntil = Math.max(...group.subjects.map((subject) => subject.time))
    group.eventTimes = eventTimes
    group.survivalEnd = rows.length ? rows[rows.length - 1].survival : 1
    group.byCause = new Map(causes.map((cause) => [cause, {
      events: group.subjects.filter((subject) => subject.cause === cause).length,
      censored: group.subjects.filter((subject) => subject.cause === null && !subject.otherEvent).length,
      other: group.subjects.filter((subject) => subject.otherEvent).length,
    }]))
  }
  // 原因别 log-rank 只依赖各组，按原因各算一次就够。
  const logRanks = new Map(causes.map((cause) => [cause, causeLogRank(groups, cause)]))

  // 方差（Aalen / Marubini–Valsecchi）：
  //   Var(F_k(t)) = Σ_{t_i≤t} (F_k(t) − F_k(t_i))² · d_i / (n_i (n_i − d_i))
  //               + Σ_{t_i≤t} S(t_{i−1})² · ((n_i − d_ki) / n_i) · (d_ki / n_i²)
  // 第一项要「到 t 为止」的累积量，所以每个报告时间点各走一遍；时间点太多的数据集
  // 只在高频区抽稀（MAX_VARIANCE_TIMES），否则 O(T²) 会拖住面板。
  const allTimes = [...new Set(groups.flatMap((group) => group.eventTimes))].sort((left, right) => left - right)
  let reported = allTimes
  if (allTimes.length > MAX_VARIANCE_TIMES) {
    const step = allTimes.length / MAX_VARIANCE_TIMES
    reported = Array.from({ length: MAX_VARIANCE_TIMES }, (_, index) => allTimes[Math.min(allTimes.length - 1,
      Math.round(index * step))])
  }
  const reportedSet = new Set(reported)
  for (const group of groups) {
    group.estimates = []
    for (const row of group.rows) {
      if (!reportedSet.has(row.time)) continue
      for (const cause of causes) {
        const target = row.cumulative.get(cause)
        let first = 0
        for (const earlier of group.rows) {
          if (earlier.time > row.time) break
          const gap = target - earlier.cumulative.get(cause)
          const denominator = earlier.atRisk * (earlier.atRisk - earlier.deaths)
          if (denominator > 0) first += (gap * gap * earlier.deaths) / denominator
        }
        let second = 0
        for (const earlier of group.rows) {
          if (earlier.time > row.time) break
          const deaths = earlier.perCause.get(cause)
          if (deaths === 0) continue
          second += (earlier.survivalBefore ** 2) * ((earlier.atRisk - deaths) / earlier.atRisk) * (deaths / (earlier.atRisk ** 2))
        }
        const variance = Math.max(0, first + second)
        const se = Math.sqrt(variance)
        group.estimates.push({
          time: row.time,
          atRisk: row.atRisk,
          deaths: row.perCause.get(cause),
          cause,
          estimate: target,
          se,
          ciLow: Math.max(0, target - 1.96 * se),
          ciHigh: Math.min(1, target + 1.96 * se),
        })
      }
    }
  }

  const tables = []
  const countTable = {
    caption: '事件计数',
    matrix: [
      ['原因', '事件数', '占比', '删失'],
      ...causeLabels.map((cause) => {
        const events = groups.reduce((total, group) => total + group.byCause.get(cause.code).events, 0)
        const censored = groups.reduce((total, group) => total + group.byCause.get(cause.code).censored, 0)
        const allEvents = causes.reduce((total, code) => total + groups
          .reduce((sum, group) => sum + group.byCause.get(code).events, 0), 0)
        return [cause.label, String(events), `${((events / Math.max(1, allEvents)) * 100).toFixed(1)}%`, String(censored)]
      }),
      ['合计', String(causes.reduce((total, code) => total + groups
        .reduce((sum, group) => sum + group.byCause.get(code).events, 0), 0)),
      '100.0%', String(groups.reduce((total, group) => total + causes
        .reduce((sum, code) => sum + group.byCause.get(code).censored, 0), 0))],
    ],
  }
  tables.push(countTable)

  // 报告哪些时间：所有事件时间，超过 MAX_TABLE_TIMES 就均匀抽稀（抽稀后仍含最早的几个
  // 与最后一个，读者要靠它们读中位时间附近的行为）。
  let shown = allTimes
  if (allTimes.length > MAX_TABLE_TIMES) {
    const step = allTimes.length / MAX_TABLE_TIMES
    shown = [...new Set(Array.from({ length: MAX_TABLE_TIMES }, (_, index) => allTimes[Math.min(allTimes.length - 1,
      Math.round(index * step))]))]
  }
  const shownSet = new Set(shown)
  const incidence = {
    caption: '累积发生率',
    matrix: [
      ['时间', ...(groupIndex >= 0 ? ['分组'] : []), '原因', '在险数', '该类事件', '累积发生率', '标准误', '95% CI 下限', '95% CI 上限'],
      ...groups.flatMap((group) => group.estimates
        .filter((estimate) => shownSet.has(estimate.time))
        .map((estimate) => [
          String(estimate.time),
          ...(groupIndex >= 0 ? [group.label] : []),
          causes.find((code) => code === estimate.cause) === undefined ? '' : causeLabels.find((entry) => entry.code === estimate.cause).label,
          String(estimate.atRisk),
          String(estimate.deaths),
          estimate.estimate.toFixed(4),
          estimate.se.toFixed(4),
          estimate.ciLow.toFixed(4),
          estimate.ciHigh.toFixed(4),
        ])),
    ],
  }
  tables.push(incidence)

  let testTable = null
  if (groups.length > 1) {
    testTable = {
      caption: '组间检验（原因别 log-rank）',
      matrix: [
        ['原因', '卡方', '自由度', 'P'],
        ...causes.map((cause) => {
          const test = logRanks.get(cause)
          return [
            causeLabels.find((entry) => entry.code === cause).label,
            Number.isFinite(test?.chiSquare) ? test.chiSquare.toFixed(3) : '—',
            String(groups.length - 1),
            Number.isFinite(test?.p) ? (test.p < 0.001 ? '< 0.001' : test.p.toFixed(4)) : '—',
          ]
        }),
      ],
    }
    tables.push(testTable)
  }

  const notes = [
    `共 ${subjects.length} 个个案，${dropped} 例因为所选变量缺失被整例剔除。`,
    '累积发生率用 Aalen–Johansen 公式算：Σ S(t_{i−1})·d_ki/n_i，S 是**全因** Kaplan–Meier。'
      + '所以它比「1 − Kaplan–Meier」小 —— 后者把删失当唯一出口，会把累积发生率系统性高估，两者不能混用。',
    `这里的原因码：${causeLabels.map((entry) => entry.label).join('、')}；0 表示删失。`
      + (otherStatuses.length ? `状态码 ${otherStatuses.join('、')} 不在所选原因里，按删失处理。` : ''),
    '标准误用 Aalen 的方差公式（两项：累积发生率自身的波动 + 每一步的二项方差），置信区间是估计值 ± 1.96·SE 后截在 [0, 1]。',
    '组间检验是**原因别 log-rank**（把其他原因当删失后逐类比较），不是 Gray 的次分布检验：前者检验原因别风险，后者检验累积发生率本身，问题不同、结论可能不同。',
  ]
  if (allTimes.length > reported.length) {
    notes.push(`事件时间太多（${allTimes.length} 个），方差只在前 ${reported.length} 个报告时间点上算过；表里也只列了 ${shown.length} 个时间点。`)
  }

  return {
    time: options.time,
    status: options.status,
    group: groupIndex >= 0 ? options.group : null,
    causes: causeLabels,
    cases: subjects.length,
    dropped,
    maxTime: Math.max(...subjects.map((subject) => subject.time), 1),
    groups: groups.map((group) => ({
      label: group.label,
      n: group.subjects.length,
      events: causes.reduce((total, code) => total + group.byCause.get(code).events, 0),
      censored: causes.reduce((total, code) => total + group.byCause.get(code).censored, 0),
      followedUntil: group.followedUntil,
      curve: causes.map((code) => ({
        cause: code,
        points: group.estimates.filter((estimate) => estimate.cause === code)
          .map((estimate) => ({ time: estimate.time, incidence: estimate.estimate, se: estimate.se })),
      })),
    })),
    logRank: groups.length > 1 ? causes.map((cause) => ({ cause, ...logRanks.get(cause) })) : [],
    tables: tables.map((table) => ({ caption: table.caption, matrix: table.matrix })),
    overallSurvival: groups.map((group) => ({
      label: group.label,
      followedUntil: group.followedUntil,
      survivalEnd: group.survivalEnd,
    })),
    notes,
  }
}
