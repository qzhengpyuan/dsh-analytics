import { isUserMissing } from './missing.js'

/**
 * 生命表（actuarial life table）。
 *
 * PSPP 2.1.3 没有 `SURVIVAL`（`SURVIVAL is not yet implemented`），所以整张表在
 * 插件里算。口径按 SPSS 的生命表法（不是 Kaplan–Meier）：把随访时间切成等宽的
 * 区间，每个区间里
 *
 *   n'_i = n_i − w_i / 2          （有效样本：期内删失算半个）
 *   q_i  = d_i / n'_i             （期内死亡比例）
 *   p_i  = 1 − q_i
 *   S_i  = Π_{j ≤ i} p_j          （累积生存率）
 *   SE(S_i) = S_i · √(Σ d_j / (n'_j (n'_j − d_j)))     （Greenwood，生命表形式）
 *   h_i  = 2 q_i / (b · (1 + p_i))                    （风险率，b = 区间宽度）
 *
 * 与 Kaplan–Meier 的差别是**不可忽略**的：生命表把区间内的删失按一半处理，区间越宽
 * 误差越大。所以注文里点名区间宽度，并说明想要逐事件估计就用 Kaplan–Meier。
 */

export const MAX_INTERVALS = 60
export const MAX_GROUPS = 10

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

/** 自动选一个「好看」的区间宽度：把它切成 8–12 段，取 1/2/5 × 10^k。 */
function niceWidth(range) {
  if (!(range > 0)) return 1
  const rough = range / 10
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const scaled = rough / magnitude
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  const width = step * magnitude
  return width > 0 ? width : 1
}

/**
 * 一层的生命表。
 * @returns {{intervals: object[], survival: number[], median: number|null}}
 */
function tableFor(cases, width, start, steps) {
  const intervals = []
  let survival = 1
  let greenwood = 0
  let median = null
  for (let index = 0; index < steps; index += 1) {
    const from = start + index * width
    const to = from + width
    // 期初在险 = 时间 ≥ 区间起点（含从后面进来的个案）；最后一个区间把右端点也收进来。
    const last = index === steps - 1
    const atRisk = cases.filter((item) => item.time >= from).length
    const events = cases.filter((item) => item.time >= from && (item.time < to || (last && item.time <= to)) && item.event).length
    const censored = cases.filter((item) => item.time >= from && (item.time < to || (last && item.time <= to)) && !item.event).length
    const effective = atRisk - censored / 2
    const safe = effective > 0 ? effective : 0
    const dying = safe > 0 ? Math.min(1, events / safe) : atRisk > 0 ? 1 : 0
    const surviving = 1 - dying
    survival *= surviving
    if (safe > 0 && safe - events > 0) greenwood += events / (safe * (safe - events))
    const hazard = surviving > -1 ? (2 * dying) / (width * (1 + surviving)) : 0
    intervals.push({
      from,
      to,
      atRisk,
      effective: round(safe),
      censored,
      events,
      dying,
      surviving,
      survival,
      standardError: survival * Math.sqrt(greenwood),
      hazard,
    })
    if (median === null && survival <= 0.5) median = to
  }
  return { intervals, survival: survival, median }
}

export function computeLifeTable(dataset, options = {}) {
  if (!dataset) throw new Error('还没有打开数据集')
  const time = String(options.time ?? '').trim()
  const status = String(options.status ?? '').trim()
  const group = String(options.group ?? '').trim()
  if (!time) throw new Error('生命表要指定随访时间变量')
  if (!status) throw new Error('生命表要指定状态变量（0 = 删失，其他取值为事件）')
  const timeColumn = columnOf(dataset, time)
  const statusColumn = columnOf(dataset, status)
  if (timeColumn < 0) throw new Error(`没有这个变量：${time}`)
  if (statusColumn < 0) throw new Error(`没有这个变量：${status}`)
  if (group && group !== time && group !== status) {
    if (columnOf(dataset, group) < 0) throw new Error(`没有这个变量：${group}`)
  }
  const groupColumn = group && group !== time && group !== status ? columnOf(dataset, group) : -1
  if (!numeric(dataset.variables[timeColumn])) {
    throw new Error(`随访时间要是数值变量：${time} 是文本变量（先转成数值）`)
  }
  if (!numeric(dataset.variables[statusColumn])) {
    throw new Error(`状态变量要是数值变量：${status} 先用数值码记事件与删失`)
  }

  const rows = dataset.rows ?? []
  const cases = []
  let dropped = 0
  for (const row of rows) {
    const rawTime = row[timeColumn]
    const rawStatus = row[statusColumn]
    const groupValue = groupColumn >= 0 ? row[groupColumn] : null
    if (blank(rawTime) || blank(rawStatus)) {
      dropped += 1
      continue
    }
    if (groupColumn >= 0 && blank(groupValue)) {
      dropped += 1
      continue
    }
    if (isUserMissing(dataset.variables[timeColumn], rawTime) || isUserMissing(dataset.variables[statusColumn], rawStatus)) {
      dropped += 1
      continue
    }
    const value = Number(rawTime)
    const code = Number(rawStatus)
    if (!Number.isFinite(value) || !Number.isFinite(code)) {
      dropped += 1
      continue
    }
    if (value < 0) {
      dropped += 1
      continue
    }
    cases.push({ time: value, event: code !== 0, group: groupColumn >= 0 ? labelFor(dataset.variables[groupColumn], groupValue) : null })
  }
  if (cases.length < 2) throw new Error(`可用的个案太少：${cases.length} 个个案（生命表至少要 2 个）`)
  if (!cases.some((item) => item.event)) throw new Error('状态变量里没有事件：所有个案都是 0（删失），生命表没有可估计的死亡比例')

  const names = groupColumn >= 0 ? [...new Set(cases.map((item) => item.group))].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')) : [null]
  if (names.length > MAX_GROUPS) {
    throw new Error(`分组太多：${names.length} 组，生命表在这里最多 ${MAX_GROUPS} 组（先合并组）`)
  }

  const first = Math.min(...cases.map((item) => item.time))
  const lastTime = Math.max(...cases.map((item) => item.time))
  const requested = Number(options.interval)
  // 区间宽度可以是数字，也可以是 'auto'。宽度必须为正，否则切不出区间。
  let width = Number.isFinite(requested) && requested > 0 ? requested : 0
  if (!width) width = niceWidth(lastTime - first)
  const steps = Math.max(1, Math.ceil((lastTime - first) / width) + (lastTime === first ? 1 : 0))
  if (steps > MAX_INTERVALS) {
    throw new Error(`区间太多：按宽度 ${round(width)} 要切 ${steps} 段，生命表在这里最多 ${MAX_INTERVALS} 段（把区间宽度加大）`)
  }

  const matrix = [['区间', '区间起点', '区间终点', '期初在险数', '期内删失', '期内事件数', '有效样本数', '期内死亡比例', '期内生存比例', '累积生存率', '标准误', '风险率']]
  if (groupColumn >= 0) matrix[0].splice(1, 0, '分组')
  const medians = [['分组', '中位生存期', '说明']]
  const curves = []
  for (const name of names) {
    const subset = name === null ? cases : cases.filter((item) => item.group === name)
    if (subset.length === 0) continue
    const built = tableFor(subset, width, first, steps)
    for (const item of built.intervals) {
      const cells = [
        `${round(item.from, 2)}–${round(item.to, 2)}`,
        String(round(item.from, 2)),
        String(round(item.to, 2)),
        String(item.atRisk),
        String(item.censored),
        String(item.events),
        String(item.effective),
        round(item.dying).toFixed(4),
        round(item.surviving).toFixed(4),
        round(item.survival).toFixed(4),
        round(item.standardError).toFixed(4),
        round(item.hazard).toFixed(4),
      ]
      if (name !== null) cells.splice(1, 0, name)
      matrix.push(cells)
    }
    const label = name === null ? '全部' : name
    medians.push([
      label,
      built.median === null ? '未达到' : String(round(built.median, 2)),
      built.median === null ? '累积生存率始终高于 0.5（随访太短或事件太少）' : `累积生存率首次 ≤ 0.5 的区间终点（区间宽 ${round(width)}）`,
    ])
    curves.push({
      label,
      curve: built.intervals.map((item) => ({ time: item.to, survival: item.survival })),
      median: built.median,
      censoredTicks: [],
    })
  }

  const notes = []
  notes.push(`区间宽度 ${round(width)}，从 ${round(first, 2)} 到 ${round(lastTime, 2)}，共 ${steps} 段${Number.isFinite(requested) && requested > 0 ? '' : '（宽度是自动取的）'}`)
  notes.push('生命表把区间内的删失按半个个案处理，区间越宽误差越大；要逐事件的估计请用 Kaplan–Meier')
  if (dropped > 0) notes.push(`有 ${dropped} 个个案因为时间/状态/分组缺失（或时间为负）被剔除`)
  if (curves.some((item) => item.median === null)) notes.push('有分组的累积生存率始终没有降到 0.5 以下，中位生存期记为「未达到」')

  return {
    variables: { time, status, group: group || null },
    interval: width,
    steps,
    first,
    last: lastTime,
    cases: cases.length,
    dropped,
    groups: names.filter((name) => name !== null),
    matrix,
    medians,
    intervals: matrix.slice(1),
    curves,
    notes,
    model: { time, status, group: group || null, interval: width, steps, groups: names.filter((name) => name !== null) },
  }
}
