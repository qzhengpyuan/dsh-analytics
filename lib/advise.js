// 方法选择：按数据的形状给「该用哪个过程」的排序建议。
//
// 这一步平时靠有经验的人看一眼变量表就决定了，初学者最容易在这里走偏
// （拿连续变量做卡方、把编号当自变量、两组不齐方差还抄等方差那一行）。
// 这里不做统计推断，只做「按结局变量与自变量的类型/分布/例数，排出该跑的
// 过程，并说明为什么、以及要注意什么」。
import { isCategorical, isUserMissing } from './missing.js'

const numericOf = (variable, raw) => {
  if (raw === null || raw === undefined || raw === '') return null
  if (isUserMissing(variable, raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const baseName = (variable) => variable.label || variable.name

/** 一列的非缺失取值概况（数值列给分布，分类列给水平）。 */
function columnSummary(dataset, variable, index) {
  const values = dataset.rows.map((row) => row[index])
  const present = values.filter((value) => value !== null && value !== '' && !isUserMissing(variable, value))
  const numeric = values.map((value) => numericOf(variable, value)).filter((value) => value !== null)
  const categorical = isCategorical(variable) || numeric.length < present.length
  const levels = new Map()
  for (const value of present) {
    const key = String(value)
    levels.set(key, (levels.get(key) ?? 0) + 1)
  }
  const counts = [...levels.values()]
  const summary = {
    name: variable.name,
    label: variable.label || null,
    kind: categorical ? 'categorical' : 'numeric',
    declaredType: variable.type ?? 'numeric',
    n: present.length,
    missing: values.length - present.length,
    distinct: levels.size,
    levels: [...levels.keys()].slice(0, 8),
    minCount: counts.length ? Math.min(...counts) : 0,
    maxCount: counts.length ? Math.max(...counts) : 0,
    // 文本列但每个值都能当数字读：这是「数字存成文本」，不能当分组变量。
    numericLooking: present.length > 0 && numeric.length === present.length,
  }
  if (!categorical && numeric.length >= 2) {
    summary.series = [...numeric].sort((left, right) => left - right)
    const mean = numeric.reduce((total, value) => total + value, 0) / numeric.length
    const sd = Math.sqrt(numeric.reduce((total, value) => total + (value - mean) ** 2, 0) / (numeric.length - 1))
    summary.mean = mean
    summary.sd = sd
    // 只有 0/1（或 0/1 的标签）的数值列就是二分结局，该走 Logistic。
    summary.binary = numeric.every((value) => value === 0 || value === 1)
    // 非负整数：可能是计数结局（泊松）。
    summary.count = numeric.every((value) => value >= 0 && Math.abs(value - Math.round(value)) < 1e-9)
    // 数值列里「只取几个整数」的（1/2/3 这种编码）在选角色时按分类看待：
    // 否则第一个变量就被当成结局，写出一句「分组是连续变量」。
    summary.discrete = summary.distinct <= 10
      && numeric.every((value) => Math.abs(value - Math.round(value)) < 1e-9)
    summary.skewed = (() => {
      if (numeric.length < 3 || sd === 0) return false
      const m3 = numeric.reduce((total, value) => total + (value - mean) ** 3, 0) / numeric.length
      const m2 = numeric.reduce((total, value) => total + (value - mean) ** 2, 0) / numeric.length
      return Math.abs(m3 / m2 ** 1.5) > 1
    })()
  }
  return summary
}

/** 建议项：分析 / 为什么 / 怎么做 / 注意事项。 */
const advice = (analysis, why, how, caveats = []) => ({ analysis, why, how, caveats })

/**
 * 按数据形状给建议。
 *
 * `options.outcome` / `options.group` / `options.predictors` 可以指定关注的角色，
 * 不指定时按变量顺序猜（第一个分类变量当分组、第一个数值变量当结局）。
 * `question` 只是用来排序（提到「相关」「差异」「预测」「生存」时把对应条目提前）。
 */
export function adviseDataset(dataset, options = {}) {
  if (!dataset?.variables?.length) throw new Error('还没有打开数据集：先导入数据或新建一个')
  if ((dataset.rows ?? []).length === 0) throw new Error('这份数据集一个个案都没有：先导入个案再谈方法')
  const columns = dataset.variables.map((variable, index) => columnSummary(dataset, variable, index))
  const named = (name) => {
    if (!name) return null
    const found = columns.find((column) => column.name === name)
    if (!found) throw new Error(`没有这个变量：${name}`)
    return found
  }
  // 结局取「取值最多」的数值列：1/2/3 这种编码（分组、性别）取值少，
  // 测量值（哪怕被四舍五入成整数）取值明显更多。只有整列取值都很少时
  // 才退到第一个数值列。
  // 也要排除 ID 列：`id` 的取值和个案一样多，按「取值最多」会把它选成结局，
  // 于是推荐里出现「对 id 做 t 检验」这种荒谬建议（复验抓到过）。
  // 「取值和个案一样多」只是 ID 的必要条件，不是充分条件：一份 30 例的随访
  // 时间也个个不同。所以再加一条 —— 要么名字像 ID，要么取值正好是 1..n 这种
  // 连续整数（真正的编号）。
  // 取值正好铺成 0..n-1 或 1..n 的一列，无论多少例都是编号：复验发现小样本
  // （n < 10）时旧的 `n >= 10` 门槛让 1..8 的 id 完全不被识别，于是它被选成
  // 结局并进了 `variables`。
  const sequenceLike = (column) => {
    if (column.kind !== 'numeric' || column.distinct !== column.n) return false
    const series = column.series
    if (!Array.isArray(series) || series.length !== column.n || column.n < 2) return false
    const sorted = [...series].sort((left, right) => left - right)
    const step = sorted[0]
    return (step === 0 || step === 1) && sorted.every((value, index) => value === sorted[0] + index)
  }
  const idLike = (column) => {
    if (column.kind !== 'numeric' || column.distinct !== column.n) return false
    // 名字就是 id/编号：不用看例数，它一定是编号。小样本时旧判据在这里漏掉，
    // 让 1..8 的 id 被当成了结局（复验反例）。
    if (/^(id|编号|序号|no\.?|case|subject)$/i.test(String(column.name))) return true
    return sequenceLike(column)
  }
  const numericColumns = columns.filter((column) => column.kind === 'numeric' && !idLike(column))
  const idColumns = columns.filter(idLike)
  const outcome = named(options.outcome)
    ?? [...numericColumns].sort((left, right) => right.distinct - left.distinct)[0]
    ?? numericColumns[0]
    // 最后一档也不能退回编号列：整张表只剩编号时，宁可拿第一个非编号列，
    // 真的一列都没有才用第一列，并说明「没什么可当结局」。
    ?? columns.find((column) => !idLike(column))
    ?? columns[0]
  const timeLikeName = (column) => /time|时间|随访|duration|survival|生存/i.test(`${column.name} ${column.label ?? ''}`)
  const groupCandidates = columns.filter((column) => column.name !== outcome.name
    && !idLike(column)
    && (column.kind === 'categorical' || column.discrete)
    && column.distinct >= 2 && column.distinct <= 10
    && column.distinct < column.n)
  // 结局像随访时间时，0/1 那一列多半是事件指示：拿它当分组等于用事件分组比较
  // 随访时间（循环论证）。只有它是唯一候选时才退回它。
  const nonEventCandidates = timeLikeName(outcome)
    ? groupCandidates.filter((column) => !(column.binary && column.distinct === 2))
    : groupCandidates
  const group = named(options.group)
    ?? nonEventCandidates[0]
    ?? (timeLikeName(outcome) ? null : groupCandidates[0])
    ?? null
  const predictors = (options.predictors ?? []).map(named).filter(Boolean)
  const numericPredictors = predictors.length
    ? predictors.filter((column) => column.kind === 'numeric')
    : columns.filter((column) => column.kind === 'numeric' && column.name !== outcome.name)
  const categoricalPredictors = predictors.length
    ? predictors.filter((column) => column.kind === 'categorical')
    : columns.filter((column) => column.kind === 'categorical' && column.name !== outcome.name)
  const notes = []
  // 编号列（取值和个案一一对应）当自变量没有意义：回归会给它一个系数，读者会
  // 以为那是效应。PSPP 那边也不会报错，所以只能在这里挡住。
  const idNames = new Set(idColumns.map((column) => column.name))
  const usablePredictors = numericPredictors.filter((column) => column.kind === 'numeric'
    && column.name !== outcome.name && !idNames.has(column.name))
  if (idColumns.length > 0 && idColumns.every((column) => column.name === outcome.name)) {
    notes.push(`表里只有 ${outcome.name} 这一列数值变量，而且它是编号：没有可分析的结局，先补上真正要研究的测量列`)
  }
  if (numericPredictors.some((column) => idNames.has(column.name))) {
    notes.push(`${numericPredictors.filter((column) => idNames.has(column.name)).map((column) => column.name).join('、')} 像编号（取值和个案一一对应）：不当自变量`)
  }
  // Logistic 收字符串自变量；多项 Logistic 与泊松只收数值（实跑抓到
  // `自变量要求数值变量：trt 是文本变量`）。
  const numericOnly = usablePredictors.map((column) => column.name)
  const predictorNames = [...usablePredictors.map((column) => column.name),
    ...(group && group.name !== outcome.name ? [group.name] : [])]
    .filter((name, index, list) => list.indexOf(name) === index)
  const items = []

  if (outcome.kind === 'categorical') {
    if (group) {
      items.push(advice(
        '交叉表 + 卡方检验（crosstabs, /STATISTICS=CHISQ）',
        `结局 ${baseName(outcome)} 与分组 ${baseName(group)} 都是分类变量，看的是构成比之间有没有差别`,
        { tool: 'pspp_analyze', params: { procedure: 'crosstabs', row: outcome.name, column: group.name, statistics: ['CHISQ'] } },
        [
          outcome.levels.length === 2 && group.levels.length === 2
            ? '2×2 表建议同时看 Fisher 精确检验（本插件在注文里给），尤其期望频数 < 5 的格子'
            : '任一格期望频数 < 5 时，卡方近似不可靠，改用精确检验',
          group.minCount < 5 ? `${baseName(group)} 有水平只有 ${group.minCount} 个个案，结论要谨慎` : null,
        ].filter(Boolean),
      ))
    }
    if (outcome.levels.length === 2) {
      // 没有任何自变量时不发 Logistic：`independents` 空着引擎会拒，
      // 而「只有编号 + 分组」这种表正是最容易走到这里的情形。
      if (predictorNames.length > 0) {
        items.push(advice(
          '二分类 Logistic 回归（logistic）',
          `结局 ${baseName(outcome)} 有两个水平`,
          { tool: 'pspp_analyze', params: { procedure: 'logistic', dependent: outcome.name, independents: predictorNames } },
          ['报告优势比 OR 与 95% CI'],
        ))
      } else {
        notes.push(`结局 ${baseName(outcome)} 有两个水平，但表里没有可用的自变量：先补一列真正要研究的变量，再谈 Logistic`)
      }
    } else if (outcome.levels.length > 2) {
      // 多项 Logistic 的引擎受不了字符串自变量（实跑报「自变量要求数值变量」），
      // 所以只在有数值自变量时才给这条；没有就明说要先做哑变量。
      if (numericOnly.length > 0) {
        items.push(advice(
          `多分类结局的回归（${outcome.levels.length} 个水平）`,
          `结局 ${baseName(outcome)} 有 ${outcome.levels.length} 个水平`,
          { tool: 'pspp_multinomial', params: { dependent: outcome.name, independents: numericOnly } },
          ['有序水平（比如轻/中/重）用有序 Logistic（pspp_ordinal），不要用多项'],
        ))
      } else {
        notes.push(`结局 ${baseName(outcome)} 有 ${outcome.levels.length} 个水平，但表里没有数值自变量：多项 Logistic 只收数值自变量，先做哑变量（转换 → 重新编码成不同变量）`)
      }
    }
    notes.push(`结局 ${baseName(outcome)} 是分类变量：不要直接做 t 检验或方差分析`)
  } else {
    // 数值结局。二分结局（0/1）不是「连续测量」：组间比的是比例而不是均值，
    // 所以均值检验与线性回归整体跳过。
    //
    // 生存上下文同理：随访时间带删失，均值和回归都会把删失当「事件没发生、
    // 时间就是观测值」，系统性低估生存时间（复验把这条列为风险）。
    const timeLikeOutcome = /time|时间|随访|duration|survival|生存/i.test(`${outcome.name} ${outcome.label ?? ''}`)
    const hasEventColumn = columns.some((column) => column.binary && column.distinct === 2 && column.name !== outcome.name)
    const censored = timeLikeOutcome && hasEventColumn
    if (censored) {
      notes.push(`${outcome.name} 像随访时间、同表里又有 0/1 事件列：这是带删失的生存数据，不要用均值检验或线性回归（会把删失当完整观测）`)
    }
    if (outcome.binary && group) {
      items.push(advice(
        '交叉表 + 卡方（crosstabs, /STATISTICS=CHISQ）',
        `结局 ${baseName(outcome)} 只取 0/1，分组 ${baseName(group)} 有 ${group.levels.length} 个水平：比的是各组的比例`,
        { tool: 'pspp_analyze', params: { procedure: 'crosstabs', row: outcome.name, column: group.name, statistics: ['CHISQ'] } },
        ['如果这是「实验组 vs 对照组」的结局，同时报风险差 / OR（本插件注文里给）'],
      ))
    }
    if (group && !outcome.binary && !censored) {
      if (group.levels.length === 2) {
        items.push(advice(
          '独立样本 t 检验（ttest_independent）',
          `结局 ${baseName(outcome)} 是连续变量、分组 ${baseName(group)} 有两个水平`,
          { tool: 'pspp_analyze', params: { procedure: 'ttest_independent', by: group.name, variables: [outcome.name], groupValues: group.levels.slice(0, 2) } },
          [
            '先看 Levene：方差不齐时抄「不假定方差相等」那一行（pspp_sentences 会自动选行并点名）',
            group.minCount < 30 ? `最小的组只有 ${group.minCount} 个个案，正态性假设吃紧，可并用 Mann-Whitney（npar_mannwhitney）` : null,
            outcome.skewed ? `${baseName(outcome)} 偏度较大（|偏度| > 1），必要时用 Mann-Whitney 而不是 t` : null,
          ].filter(Boolean),
        ))
      } else {
        items.push(advice(
          '单因素方差分析 + 两两比较（oneway，事后 Bonferroni）',
          `结局 ${baseName(outcome)} 是连续变量、分组 ${baseName(group)} 有 ${group.levels.length} 个水平`,
          { tool: 'pspp_analyze', params: { procedure: 'oneway', variables: [outcome.name], by: group.name, postHoc: ['BONFERRONI'] } },
          [
            '方差齐性看 Levene；不齐用 Welch 或改 Kruskal-Wallis（npar_kruskal）',
            '只看 F 不够：组间差异要配两两比较（pspp_pairwise 会给字母表）',
          ],
        ))
      }
    }
    if (outcome.binary) {
      notes.push(`结局 ${baseName(outcome)} 只取 0/1：按二分结局处理（Logistic 回归、报告优势比），不要当成连续测量求均值`)
      if (predictorNames.length > 0) items.push(advice(
        '二分类 Logistic 回归（logistic）',
        `结局 ${baseName(outcome)} 只取 0/1 两个值 —— 这是二分结局，不是连续测量`,
        { tool: 'pspp_analyze', params: { procedure: 'logistic', dependent: outcome.name, independents: predictorNames } },
        ['报告优势比 OR 与 95% CI，不要报「均值差」'],
      ))
    } else if (outcome.count && outcome.minCount > 2 && outcome.distinct > 10 && !outcome.binary) {
      items.push(advice(
        '泊松回归（pspp_poisson，插件自算）',
        `结局 ${baseName(outcome)} 是非负整数，可能是计数结局`,
        { tool: 'pspp_poisson', params: { dependent: outcome.name, independents: numericOnly } },
        ['先核对过度离散（插件会报 Pearson/df）；过度离散明显时结论要保守'],
      ))
    }
    if (numericOnly.length >= 1 && !outcome.binary && !censored) {
      items.push(advice(
        numericOnly.length === 1 ? 'Pearson 相关 + 简单线性回归（correlation / regression）' : '多元线性回归（regression）',
        `结局 ${baseName(outcome)} 是连续变量，可用 ${numericOnly.length} 个数值自变量`,
        { tool: 'pspp_analyze', params: { procedure: 'regression', dependent: outcome.name, independents: numericOnly } },
        [
          numericOnly.length >= 2 ? '先看共线性（容忍度/VIF，插件在注文里给）' : null,
          '残差诊断：散点与 P-P 图（回归对话框里有诊断图）',
        ].filter(Boolean),
      ))
    }
    if (categoricalPredictors.length >= 1 && numericOnly.length >= 1 && !censored && !outcome.binary) {
      // PSPP 的 GLM 因子必须是数值变量：文本因子会被引擎丢掉，然后报
      // 「grp is not a numeric variable」并一条表都不出（实跑抓到过）。
      const glmFactors = categoricalPredictors.filter((column) => column.declaredType !== 'string')
      if (glmFactors.length > 0) {
        items.push(advice(
          '一般线性模型 GLM（因子 + 协变量）',
          '既有分类自变量又有数值自变量，想同时看主效应与协变量',
          {
            tool: 'pspp_analyze',
            params: {
              procedure: 'glm',
              variables: [outcome.name],
              factors: glmFactors.map((column) => column.name),
              // PSPP 2.1.3 的 GLM 没有 WITH 子句，协变量进不去；把能当因子的
              // 分类变量交给 factors，数值的留给回归（见下一条）。
            },
          },
          ['PSPP 的 GLM 只收数值因子，文本分类变量要先重新编码成数值'],
        ))
      } else {
        notes.push(`${categoricalPredictors.map((column) => column.name).join('、')} 是文本分类变量：PSPP 的 GLM 因子只收数值编码，先重新编码成数值才能当因子`)
      }
    }
    if (outcome.skewed && !outcome.binary && !censored) {
      items.push(advice(
        '非参数替代：Mann-Whitney / Kruskal-Wallis（npar_*）',
        `${baseName(outcome)} 的偏度绝对值超过 1，正态假设吃紧`,
        { tool: 'pspp_analyze', params: group
        ? {
          procedure: group.levels.length > 2 ? 'npar_kruskal' : 'npar_mannwhitney',
          variables: [outcome.name],
          by: group.name,
          groupValues: group.levels,
        }
        : { procedure: 'npar_ks', variables: [outcome.name] } },
        ['非参数检验比的是分布位置（秩），报告要写中位数而不是均值'],
      ))
    }
  }

  // 生存：只有当「结局列看起来像随访时间，或问题就问生存」时才提，
  // 否则随便一份带 0/1 列的数据都会被推荐做 Cox。
  const timeLike = (column) => /time|时间|随访|duration|survival|生存/i.test(`${column.name} ${column.label ?? ''}`)
  const asksSurvival = /生存|随访|survival|time.?to.?event/i.test(String(options.question ?? ''))
  const eventLike = columns.find((column) => column.binary && column.distinct === 2 && column.name !== outcome.name)
  if (eventLike && outcome.kind === 'numeric' && (timeLike(outcome) || asksSurvival)) {
    items.push(advice(
      '生存分析：Kaplan–Meier / Cox（pspp_survival / pspp_cox）',
      `${outcome.name} 像随访时间、${eventLike.name} 像事件指示（0/1）`,
      {
        tool: 'pspp_cox',
        params: {
          time: outcome.name,
          event: eventLike.name,
          // covariates 是必填：没有可用自变量时拿分组列顶，仍然是合法的 Cox；
          // 一个都没有就只给 KM（见下一条），不能发出缺必填的调用。
          covariates: [...usablePredictors.map((column) => column.name), ...(group ? [group.name] : [])]
            .filter((name) => name !== outcome.name && name !== eventLike.name)
            .filter((name, index, list) => list.indexOf(name) === index),
        },
      },
      ['先画 KM 曲线看是否交叉；交叉时比例风险假设不成立，用分层 Cox 或竞争风险'],
    ))
  }

  // 数据层面的提醒（与选哪个过程无关，但会毁掉任何一个过程）。
  for (const column of columns) {
    if (column.n === 0) notes.push(`${column.name} 一个值都没有：任何分析都会丢掉它`)
    else if (column.distinct === 1) notes.push(`${column.name} 只有一个取值：不能当分组或自变量`)
    if (column.declaredType === 'string' && column.numericLooking === true && column.distinct > 10) {
      notes.push(`${column.name} 是文本列但值像数字：先转成数值（转换 → 重新编码成不同变量），否则做不了相关与回归`)
    }
    if (column.missing > 0) notes.push(`${column.name} 缺失 ${column.missing} / ${column.n + column.missing}`)
  }
  // 例数门槛：回归的经验法则是每个自变量至少 10–15 个个案。
  const cases = (dataset.rows ?? []).length
  if (numericOnly.length > 0 && cases < numericOnly.length * 15) {
    notes.push(`个案 ${cases} 个、数值自变量 ${numericOnly.length} 个：低于「每个自变量 15 个个案」的经验下限，回归系数不稳定，考虑减变量或先做描述`)
  }

  const question = String(options.question ?? '')
  const intent = /相关|association|correlat/i.test(question) ? 'correlation'
    : /差异|比较|difference|compare/i.test(question) ? 'difference'
      : /预测|影响|predict|effect/i.test(question) ? 'prediction'
        : /生存|随访|survival/i.test(question) ? 'survival'
          : null
  const boost = (entry) => {
    if (intent === 'correlation' && /相关|correlation/.test(entry.analysis)) return 0
    if (intent === 'difference' && /t 检验|方差分析|卡方|非参数/.test(entry.analysis)) return 0
    if (intent === 'prediction' && /回归|Logistic|Poisson/.test(entry.analysis)) return 0
    if (intent === 'survival' && /生存/.test(entry.analysis)) return 0
    return 1
  }
  const ordered = [...items].sort((left, right) => boost(left) - boost(right))

  return {
    cases,
    variableCount: columns.length,
    outcome: outcome.name,
    group: group?.name ?? null,
    intent,
    recommendations: ordered,
    notes,
    variables: columns.map((column) => ({
      name: column.name, label: column.label, kind: column.kind,
      declaredType: column.declaredType, n: column.n, missing: column.missing,
      distinct: column.distinct, levels: column.levels,
      ...(column.kind === 'numeric' ? { mean: column.mean, sd: column.sd, skewed: column.skewed, binary: column.binary } : {}),
    })),
  }
}

/** 建议 → 面板里能看的一张表（一行一条建议，注文写注意事项）。 */
export function adviseTable(result) {
  const matrix = [['顺序', '建议用的过程', '为什么', '怎么做']]
  result.recommendations.forEach((entry, index) => {
    const how = entry.how?.tool ? `${entry.how.tool}${entry.how.params ? `（${Object.entries(entry.how.params).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join('，')}）` : ''}` : ''
    matrix.push([String(index + 1), entry.analysis, entry.why, how])
  })
  const notes = []
  for (const entry of result.recommendations) for (const caveat of entry.caveats ?? []) notes.push(`要注意：${caveat}`)
  for (const note of result.notes) notes.push(`数据：${note}`)
  if (notes.length === 0) notes.push('没有额外的注意事项')
  return { caption: '方法建议', matrix, notes }
}
