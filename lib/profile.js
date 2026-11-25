// 数据体检：一次把「这份数据能不能直接分析、哪里会出事」说完。
//
// agent 拿到一份陌生数据时，真正需要的不是再跑一遍描述统计，而是这些判断：
// 哪一列其实是 ID、哪一列是常量、哪一列把数字存成了文本、哪一列像日期被当成了
// 字符串、缺失集中在哪、哪两列是重复的、哪个变量有离群值、量纲是不是异常。
// 这些判断在插件里都算得出来（不需要引擎），所以不必让 agent 反复试。
import { isUserMissing } from './missing.js'

/** 一列的民族值（去重后前 5 个），用于「这一列是不是 ID」。 */
const SAMPLE = 5

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const numericOf = (variable, raw) => {
  if (raw === null || raw === undefined || raw === '') return null
  if (isUserMissing(variable, raw)) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const isDateLike = (text) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(text)

/** 偏度与峰度（Pearson 的 moment 形式，不做自由度校正）。 */
const shapeOf = (values) => {
  const n = values.length
  if (n < 3) return { skewness: null, kurtosis: null }
  const mean = values.reduce((total, value) => total + value, 0) / n
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (const value of values) {
    const d = value - mean
    m2 += d * d
    m3 += d * d * d
    m4 += d * d * d * d
  }
  m2 /= n
  m3 /= n
  m4 /= n
  if (m2 === 0) return { skewness: null, kurtosis: null }
  return {
    skewness: round(m3 / m2 ** 1.5),
    kurtosis: round(m4 / (m2 * m2) - 3),
  }
}

const quantile = (sorted, p) => {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * 体检一份数据集。
 *
 * 返回 `{cases, variables, findings, duplicates}`：
 * - `variables`：每列的 `{name, label, kind, n, missing, unique, ...}`；
 * - `findings`：需要人管的事（常量列、ID 列、数字存成文本、日期被当字符串、
 *   疑似重复列、离群比例过高、量纲异常、缺失率过高），每条带 `level`
 *   （`error` 会让常见分析直接失败，`warn` 多半要处理，`info` 只是提示）；
 * - `duplicates`：完全相同的列对（同类型、同值序列）。
 */
export function profileDataset(dataset) {
  if (!dataset?.variables?.length) throw new Error('还没有打开数据集：先导入数据或新建一个')
  const rows = dataset.rows ?? []
  const findings = []
  const variables = []
  // 每一列的值序列做成签名，用来看哪两列完全一样。
  const signatures = new Map()

  dataset.variables.forEach((variable, index) => {
    const raw = rows.map((row) => row[index] ?? null)
    const present = raw.filter((value) => value !== null && value !== '')
    const userMissing = raw.filter((value) => value !== null && value !== '' && isUserMissing(variable, value)).length
    const values = raw.map((value) => numericOf(variable, value))
    const numbers = values.filter((value) => value !== null)
    const texts = present.map((value) => String(value).trim())
    const unique = new Set(present.map((value) => String(value))).size
    const entry = {
      name: variable.name,
      label: variable.label || null,
      declaredType: variable.type ?? 'numeric',
      cases: rows.length,
      present: present.length,
      missing: rows.length - present.length,
      userMissing,
      unique,
      ...(variable.valueLabels && Object.keys(variable.valueLabels).length
        ? { valueLabels: Object.keys(variable.valueLabels).length }
        : {}),
    }

    // 只含数字的文本列：这几乎是「数字存成了文本」，PSPP 用不了它。
    const allLookNumeric = texts.length > 0 && texts.every((text) => /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text))
    const dateLike = texts.filter(isDateLike).length
    if (variable.type === 'string' && allLookNumeric) {
      entry.kind = 'numeric-as-text'
      findings.push({
        level: 'warn',
        variable: variable.name,
        text: `${variable.name} 声明成文本，但 ${texts.length} 个值全是数字 —— 转换 → 重新编码成不同变量（或改类型）之后才能算均值、回归`,
      })
    } else if (variable.type === 'string' && dateLike >= Math.max(2, Math.floor(texts.length * 0.9))) {
      entry.kind = 'date-as-text'
      findings.push({
        level: 'warn',
        variable: variable.name,
        text: `${variable.name} 看着是日期（${dateLike} 个值符合日期写法），但存成了文本：要么当文本分组用，要么先算出「距今天数」再当数值用`,
      })
    } else {
      entry.kind = variable.type === 'string' ? 'text' : 'numeric'
    }

    if (present.length === 0) {
      findings.push({ level: 'error', variable: variable.name, text: `${variable.name} 一个值都没有：常见分析会直接把它丢掉，先确认导入有没有错列` })
    } else if (unique === 1) {
      findings.push({ level: 'warn', variable: variable.name, text: `${variable.name} 只有一个取值（${texts[0]}）：它没有变异，进不了回归，也不能当分组变量` })
    }

    // 少于 10 个个案时「每个值都不同」很正常（5 个个案的年龄也能看不出重复），
    // 那种数据报「像 ID」只会制造噪音。
    if (rows.length > 0 && unique === present.length && present.length >= 10 && entry.kind === 'numeric') {
      entry.idLike = true
      findings.push({
        level: 'info',
        variable: variable.name,
        text: `${variable.name} 每个个案取值都不同（${unique} 个），像编号 / ID：别把它当分析变量`,
      })
    }
    if (rows.length > 0 && present.length < rows.length) {
      const rate = (rows.length - present.length) / rows.length
      entry.missingRate = round(rate, 4)
      if (rate > 0.5) {
        findings.push({
          level: 'warn',
          variable: variable.name,
          text: `${variable.name} 缺失 ${rows.length - present.length} / ${rows.length}（${(rate * 100).toFixed(1)}%）：超过一半，结论要谨慎，考虑先看缺失模式（分析 → 缺失值分析）`,
        })
      }
    }
    if (userMissing > 0) {
      entry.missingCodes = true
    }

    if (numbers.length > 0) {
      const sorted = [...numbers].sort((left, right) => left - right)
      const mean = numbers.reduce((total, value) => total + value, 0) / numbers.length
      const variance = numbers.length > 1
        ? numbers.reduce((total, value) => total + (value - mean) ** 2, 0) / (numbers.length - 1)
        : 0
      const sd = Math.sqrt(variance)
      const q1 = quantile(sorted, 0.25)
      const q3 = quantile(sorted, 0.75)
      const iqr = q3 - q1
      const outLow = iqr > 0 ? sorted.filter((value) => value < q1 - 1.5 * iqr).length : 0
      const outHigh = iqr > 0 ? sorted.filter((value) => value > q3 + 1.5 * iqr).length : 0
      const outliers = outLow + outHigh
      entry.numeric = true
      entry.mean = round(mean)
      entry.sd = round(sd)
      entry.min = round(sorted[0])
      entry.max = round(sorted[sorted.length - 1])
      entry.median = round(quantile(sorted, 0.5))
      entry.skewness = shapeOf(numbers).skewness
      entry.kurtosis = shapeOf(numbers).kurtosis
      entry.outliers = outliers
      if (outliers > 0 && outliers / numbers.length > 0.1) {
        findings.push({
          level: 'info',
          variable: variable.name,
          text: `${variable.name} 有 ${outliers} 个值落在 1.5×IQR 之外（占 ${(outliers / numbers.length * 100).toFixed(1)}%）：先画箱线图看是长尾还是录入错误`,
        })
      }
      const decimalsSeen = sorted.some((value) => Math.abs(value - Math.round(value)) > 1e-9)
      if (!decimalsSeen && unique > 20 && variable.type !== 'string') {
        entry.looksLikeCode = true
      }
      // 量纲：均值与标准差差三个数量级以上，多半是「一个值写成 100000 而不是 100」。
      if (sd > 0 && Math.abs(mean) > 0 && Math.abs(mean) / sd > 1e4) {
        findings.push({
          level: 'info',
          variable: variable.name,
          text: `${variable.name} 的均值（${round(mean)}）比标准差（${round(sd)}）大四个数量级以上：检查是不是有值的量纲写错（比如 100000 写成 100）`,
        })
      }
    }

    entry.sample = [...new Set(texts)].slice(0, SAMPLE)
    const signature = `${entry.kind}:${present.map((value) => String(value)).join('\u0001')}`
    if (present.length > 0) {
      if (!signatures.has(signature)) signatures.set(signature, [])
      signatures.get(signature).push(variable.name)
    }
    variables.push(entry)
  })

  const duplicates = [...signatures.values()].filter((names) => names.length > 1)
  for (const names of duplicates) {
    findings.push({
      level: 'info',
      variable: names[0],
      text: `${names.join(' 与 ')} 的取值完全一样：是不是重复导入或复制出来的列？`,
    })
  }

  const caseCount = rows.length
  if (caseCount === 0) {
    findings.unshift({ level: 'error', text: '这份数据集一个个案都没有：分析会报「0 行」' })
  }
  return {
    cases: caseCount,
    variableCount: dataset.variables.length,
    variables,
    findings,
    duplicates,
    counts: {
      error: findings.filter((entry) => entry.level === 'error').length,
      warn: findings.filter((entry) => entry.level === 'warn').length,
      info: findings.filter((entry) => entry.level === 'info').length,
    },
  }
}

/** 体检结果 → 面板里能看的一张表（每行一个变量，问题写进表注）。 */
export function profileTable(profile) {
  const header = ['变量', '类型', '个案', '缺失', '不同取值', '均值', '标准差', '最小', '最大', '偏度', '离群值']
  const matrix = [header]
  for (const entry of profile.variables) {
    const cell = (value) => (value === null || value === undefined ? '' : String(value))
    matrix.push([
      entry.label ? `${entry.name}（${entry.label}）` : entry.name,
      entry.kind === 'numeric-as-text' ? '数字存成文本'
        : entry.kind === 'date-as-text' ? '日期存成文本'
          : entry.kind === 'text' ? '文本' : '数值',
      cell(entry.cases),
      cell(entry.missing),
      cell(entry.unique),
      cell(entry.mean),
      cell(entry.sd),
      cell(entry.min),
      cell(entry.max),
      cell(entry.skewness),
      cell(entry.outliers),
    ])
  }
  const notes = profile.findings.map((entry) => `${entry.level === 'error' ? '必须先处理' : entry.level === 'warn' ? '要注意' : '提示'}：${entry.text}`)
  if (notes.length === 0) notes.push('没有发现需要处理的问题')
  return { caption: '数据体检', matrix, notes }
}
