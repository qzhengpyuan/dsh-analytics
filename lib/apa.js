// APA 7 的统计量写法：把 `sentencesOf` 已经认出来的每个检验写成
// `t(57) = -2.83, p = .106, d = -0.61` 这种能直接抄进稿子的串。
//
// 与句子层的分工：句子（`sentences.js`）是「这一结果说明了什么」，给人和 agent 读；
// 这里是「怎么写成 APA 格式」，给投稿的表格与正文用。两者共用同一份解析结果
// （句子的 `values`），所以数字不可能一边一个样。
//
// 规则（APA 7 Publication Manual §6.36–6.40）：
// - p、r、α、R² 这类不会超过 1 的量，不写前导 0：`.024`、`.45`；
// - t、F、χ²、d、B 照常写：`-2.83`、`0.61`；
// - `p < .001` 不写成 `.000`；
// - 效应量只在能从同一组表算出来时给（独立样本 t 的 d、单因素方差分析的 η²），
//   算不出来就不写，不填一个看起来合理的数。
const text = (value) => (value === null || value === undefined ? null : String(value).trim() || null)

/** df 这类计数：`58.00` 写成 `58`；Welch 的 `1.20` 原样保留。 */
export function apaCount(value) {
  const raw = text(value)
  if (raw === null) return null
  if (/^\d+\.0+$/.test(raw)) return String(Number(raw))
  return raw
}

/** p 值：不写前导 0；`< 0.001` 写成 `< .001`。 */
export function apaP(value) {
  const raw = text(value)
  if (raw === null) return null
  if (/^</.test(raw)) return '< .001'
  const number = Number(raw)
  if (!Number.isFinite(number)) return null
  if (number < 0.001) return '< .001'
  return number.toFixed(3).replace(/^0/, '')
}

/** 0–1 之间的量（r、α、R²）：去掉前导 0，保留 `digits` 位。 */
export function apaUnit(value, digits = 2) {
  const number = Number(text(value) ?? NaN)
  if (!Number.isFinite(number)) return null
  return number.toFixed(digits).replace(/^(-?)0\./, '$1.')
}

/** 统计量一律两位小数（APA 的默认精度）：F 印成 16 时写成 16.00。 */
export function apaStat(value, digits = 2) {
  const number = Number(text(value) ?? NaN)
  if (!Number.isFinite(number)) return null
  return number.toFixed(digits)
}

/** 把若干段拼成 APA 的一串统计量：空的段直接省略，不留 `, ,`。 */
const cluster = (...parts) => parts.filter((part) => part !== null && part !== '').join(', ')

const pTerm = (p) => (p === null || p === undefined ? null : `p ${p === '< .001' ? '< .001' : `= ${p}`}`)

/** 相关系数：一般两位；舍入后变成 .00 / 1.00 时多给一位，免得把 .995 说成 1.00。 */
function apaR(value) {
  const number = Number(text(value) ?? NaN)
  if (!Number.isFinite(number)) return null
  const two = number.toFixed(2)
  if (Math.abs(number) < 1 && (two === '0.00' || two === '1.00' || two === '-1.00')) {
    return number.toFixed(3).replace(/^(-?)0\./, '$1.')
  }
  return two.replace(/^(-?)0\./, '$1.')
}

/** 独立样本 t 的 Cohen's d：合并标准差从 Group Statistics 两行算。 */
function cohensD(groups) {
  if (!Array.isArray(groups) || groups.length < 2) return null
  const [left, right] = groups
  const numbers = [left.n, left.mean, left.sd, right.n, right.mean, right.sd].map(Number)
  if (!numbers.every((value) => Number.isFinite(value))) return null
  if (left.n < 2 || right.n < 2) return null
  const pooled = Math.sqrt(((left.n - 1) * left.sd ** 2 + (right.n - 1) * right.sd ** 2) / (left.n + right.n - 2))
  if (!Number.isFinite(pooled) || pooled === 0) return null
  return (left.mean - right.mean) / pooled
}

/** 单因素方差分析的 η² = SS组间 / SS总（表里印了 Sum of Squares 才算）。 */
function etaSquared(items, tableTitle) {
  const table = (items ?? []).find((item) => item.kind === 'table' && String(item.title ?? '') === String(tableTitle ?? ''))
  const matrix = table?.table?.matrix
  if (!Array.isArray(matrix) || matrix.length < 2) return null
  const header = matrix[0].map((cell) => String(cell ?? '').trim())
  const ssColumn = header.findIndex((label) => /Sum of Squares/i.test(label))
  if (ssColumn < 0) return null
  // 行标签所在的列不固定（变量名单独一行时会整体右移一列），所以按「哪个格子
  // 写着 Between / Total」找行，不去猜列号。
  const hasLabel = (row, pattern) => row.some((cellValue) => pattern.test(String(cellValue ?? '').trim()))
  const between = matrix.slice(1).find((row) => hasLabel(row, /^Between/i))
  const total = matrix.slice(1).find((row) => hasLabel(row, /^Total$/i))
  const betweenSS = between ? Number(between[ssColumn]) : NaN
  const totalSS = total ? Number(total[ssColumn]) : NaN
  if (!Number.isFinite(betweenSS) || !Number.isFinite(totalSS) || totalSS <= 0) return null
  return betweenSS / totalSS
}

/** 一条句子 → 一行 APA 写法；这个检验不适用 APA 串时回 null。 */
function apaLine(entry, language, items) {
  const values = entry.values ?? {}
  const zh = language !== 'en'
  switch (entry.kind) {
    case 'ttest-independent': {
      const t = apaStat(values.t)
      if (t === null) return null
      const dataframe = apaCount(values.df)
      const p = apaP(values.p)
      const diff = text(values.meanDifference)
      const d = cohensD(values.groups)
      const stats = cluster(`t(${dataframe}) = ${t}`, pTerm(p), diff === null ? null : `${zh ? '均值差' : 'M diff'} = ${diff}`, d === null ? null : `d = ${d.toFixed(2)}`)
      return { text: zh ? `独立样本 t 检验（${values.variable}）：${stats}` : `Independent-samples t test (${values.variable}): ${stats}` }
    }
    case 'ttest-one-sample': {
      const t = apaStat(values.t)
      if (t === null) return null
      const stats = cluster(`t(${apaCount(values.df)}) = ${t}`, pTerm(apaP(values.p)), text(values.meanDifference) === null ? null : `${zh ? '均值差' : 'M diff'} = ${text(values.meanDifference)}`)
      return { text: zh ? `单样本 t 检验（${values.variable}）：${stats}` : `One-sample t test (${values.variable}): ${stats}` }
    }
    case 'ttest-paired': {
      const t = apaStat(values.t)
      if (t === null) return null
      const stats = cluster(`t(${apaCount(values.df)}) = ${t}`, pTerm(apaP(values.p)), text(values.meanDifference) === null ? null : `${zh ? '均值差' : 'M diff'} = ${text(values.meanDifference)}`)
      return { text: zh ? `配对样本 t 检验（${values.pair}）：${stats}` : `Paired-samples t test (${values.pair}): ${stats}` }
    }
    case 'anova': {
      const f = apaStat(values.f)
      if (f === null) return null
      const eta = etaSquared(items, entry.table)
      const stats = cluster(`F(${apaCount(values.df1)}, ${apaCount(values.df2)}) = ${f}`, pTerm(apaP(values.p)), eta === null ? null : `η² = ${apaUnit(eta, 2)}`)
      return { text: zh ? `单因素方差分析（${values.variable}）：${stats}` : `One-way ANOVA (${values.variable}): ${stats}` }
    }
    case 'chi-square': {
      const value = apaStat(values.chiSquare)
      if (value === null) return null
      const stats = cluster(`χ²(${apaCount(values.df)}) = ${value}`, pTerm(apaP(values.p)), values.n === null || values.n === undefined ? null : `N = ${values.n}`)
      const pair = values.table ?? entry.table ?? ''
      return { text: zh ? `卡方检验（${pair}）：${stats}` : `Chi-square test (${pair}): ${stats}` }
    }
    case 'correlation': {
      const r = apaR(values.r)
      if (r === null) return null
      const n = Number(values.n)
      const dataframe = Number.isFinite(n) && n > 2 ? n - 2 : null
      const stats = cluster(dataframe === null ? `r = ${r}` : `r(${dataframe}) = ${r}`, pTerm(apaP(values.p)), Number.isFinite(n) ? `n = ${n}` : null)
      return { text: zh ? `Pearson 相关（${values.left}–${values.right}）：${stats}` : `Pearson correlation (${values.left}–${values.right}): ${stats}` }
    }
    case 'regression-fit': {
      const r2 = apaUnit(values.rSquare, 2)
      if (r2 === null) return null
      const f = apaStat(values.f)
      const stats = cluster(`R² = ${r2}`, f === null ? null : `F(${apaCount(values.df1)}, ${apaCount(values.df2)}) = ${f}`, pTerm(apaP(values.p)))
      return { text: zh ? `线性回归（因变量 ${values.outcome}）：${stats}` : `Linear regression (outcome ${values.outcome}): ${stats}` }
    }
    case 'regression-coefficient': {
      const b = apaStat(values.b)
      if (b === null) return null
      const se = apaStat(values.se)
      const t = apaStat(values.t)
      const stats = cluster(`B = ${b}`, se === null ? null : `SE = ${se}`, t === null ? null : `t = ${t}`, pTerm(apaP(values.p)))
      return { text: zh ? `回归系数（${values.term}）：${stats}` : `Regression coefficient (${values.term}): ${stats}` }
    }
    case 'logistic-odds': {
      const odds = apaStat(values.oddsRatio)
      if (odds === null) return null
      const stats = cluster(`OR = ${odds}`, pTerm(apaP(values.p)))
      return { text: zh ? `Logistic 回归（${values.term}）：${stats}` : `Logistic regression (${values.term}): ${stats}` }
    }
    case 'npar-mannwhitney': {
      const u = apaStat(values.u)
      if (u === null) return null
      const z = apaStat(values.z)
      const stats = cluster(`U = ${u}`, z === null ? null : `Z = ${z}`, pTerm(apaP(values.p)))
      return { text: zh ? `Mann–Whitney U 检验（${values.variable}）：${stats}` : `Mann–Whitney U test (${values.variable}): ${stats}` }
    }
    case 'npar-kruskal': {
      const h = apaStat(values.chiSquare)
      if (h === null) return null
      const stats = cluster(`H(${apaCount(values.df)}) = ${h}`, pTerm(apaP(values.p)))
      return { text: zh ? `Kruskal–Wallis 检验（${values.variable}）：${stats}` : `Kruskal–Wallis test (${values.variable}): ${stats}` }
    }
    case 'reliability-alpha': {
      const alpha = apaUnit(values.alpha, 2)
      if (alpha === null) return null
      return { text: zh ? `信度：Cronbach's α = ${alpha}（${values.items ?? '—'} 个题项）` : `Reliability: Cronbach's α = ${alpha} (${values.items ?? '—'} items)` }
    }
    default:
      return null
  }
}

/**
 * 一组句子 → APA 串。`items` 只用来补算方差分析的 η²（表里的平方和）；
 * 其余统计量都来自句子已经解析好的 `values`。
 */
export function apaOf(sentences, options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh'
  const lines = []
  const skipped = []
  for (const entry of sentences ?? []) {
    const line = apaLine(entry, language, options.items ?? [])
    if (line) lines.push({ kind: entry.kind, table: entry.table, text: line.text })
    else if (!skipped.includes(entry.kind)) skipped.push(entry.kind)
  }
  return { language, lines, skipped }
}
