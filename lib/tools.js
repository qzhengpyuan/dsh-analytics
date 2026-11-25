/**
 * Agent-facing tools. They call the very same Workspace methods as the
 * sidebar UI, so a model and a user observe identical state.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname } from 'node:path'

import { engineEnv, runProcess } from './engine.js'
import { pluginInfo } from './version.js'

const pkgName = createRequire(import.meta.url)('../package.json').name

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

const NAME_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fff.]+$/

// PSPP 2.1.3 支持的 CTABLES 汇总函数（MIN/MAX 必须写成 MINIMUM/MAXIMUM）
const CTABLES_STATS = ['COUNT', 'MEAN', 'STDDEV', 'MINIMUM', 'MAXIMUM', 'SUM', 'MEDIAN', 'VARIANCE', 'SEMEAN', 'MODE', 'VALIDN', 'MISSING']

/**
 * Group codes for T-TEST and NPAR: a string grouping variable needs each code
 * quoted, a numeric one must stay bare. Without this the engine stops at
 * "Syntax error expecting string" and the message never mentions quotes.
 */
function groupCodes(list, string) {
  const entries = list.filter((value) => value !== '' && value !== null && value !== undefined)
  if (!string) return entries.join(' ')
  return entries.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(' ')
}

function assertName(name, label) {
  const text = String(name ?? '').trim()
  if (text === '' || !NAME_PATTERN.test(text)) throw new Error(`invalid ${label}: ${name}`)
  return text
}

const stripBom = (text) => String(text ?? '').replace(/^\uFEFF/, '')

/**
 * Decode a syntax file. UTF-8 is tried strictly first because that is what the
 * plugin writes, and a strict failure is the only honest signal that the file is
 * something else (GBK, from an older Windows PSPP or a teacher's handout).
 */
function decodeSyntax(bytes, encoding) {
  const forced = String(encoding ?? 'auto').toLowerCase()
  const tryDecode = (label) => new TextDecoder(label, { fatal: true }).decode(bytes)
  if (forced === 'utf-8' || forced === 'utf8') return tryDecode('utf-8')
  if (forced === 'gbk' || forced === 'cp936' || forced === 'gb18030') return tryDecode('gb18030')
  try {
    return tryDecode('utf-8')
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

function normalizeContrasts(value) {
  // Accepts [[2,-1,-1],[0,1,-1]], '2 -1 -1; 0 1 -1', or a single flat list.
  // PSPP silently ignores a /CONTRAST whose length differs from the number of
  // groups (only a stderr warning), so the length check happens here as well.
  if (value === undefined || value === null || value === '') return []
  const chunks = Array.isArray(value) && value.every((entry) => Array.isArray(entry))
    ? value
    : String(Array.isArray(value) ? value.join(';') : value).split(/[;；\n]+/)
  const lists = []
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) {
      const coeffs = chunk.map((entry) => Number(entry))
      if (coeffs.some((entry) => !Number.isFinite(entry))) throw new Error('对比系数要是数字')
      if (coeffs.length >= 2) lists.push(coeffs)
      continue
    }
    const coeffs = String(chunk).split(/[\s,，]+/).filter(Boolean).map((entry) => {
      const number = Number(entry)
      if (!Number.isFinite(number)) throw new Error(`对比系数要是数字，收到「${entry}」`)
      return number
    })
    if (coeffs.length >= 2) lists.push(coeffs)
  }
  const width = lists.length > 0 ? lists[0].length : 0
  const odd = lists.find((coeffs) => coeffs.length !== width)
  if (odd) throw new Error(`每个对比的系数个数要一样（第一个有 ${width} 个，这一组有 ${odd.length} 个）`)
  return lists
}

function vlist(input, label) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/).filter(Boolean)
  if (list.length === 0) throw new Error(`${label} requires at least one variable`)
  return list.map((name) => assertName(name, 'variable name'))
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * How many rows of a table travel back to the model.
 *
 * A frequency table over a continuous variable can run to thousands of rows;
 * sending all of them spends the caller's context on numbers nobody reads and
 * still leaves the interesting totals buried. The first rows carry the header
 * and the head of the distribution, and the note says the rest exists.
 */
const AGENT_TABLE_ROWS = 200

export function itemsForAgent(workspace, items) {
  return items.map((item) => {
    // Which data the numbers came from travels with them: the agent may be
    // asked "what is this table from" a dozen turns later, and the tool result
    // is the only thing it still has.
    const provenance = item.provenance ? { provenance: item.provenance } : {}
    if (item.kind === 'table') {
      const matrix = item.table.matrix ?? []
      const rows = matrix.slice(0, AGENT_TABLE_ROWS)
      return {
        kind: 'table',
        id: item.id,
        title: item.title,
        rows,
        ...provenance,
        ...(matrix.length > rows.length
          ? { truncated: { rows: matrix.length, shown: rows.length, hint: `这张表共 ${matrix.length} 行，只回传了前 ${rows.length} 行；完整表格在面板与导出文件里` } }
          : {}),
        // The hints a table carries are the part the agent acts on: a logistic
        // result names the outcome and predictors its ROC needs, an ANOVA names
        // its group, and neither can be reconstructed from the numbers alone.
        ...(item.roc ? { roc: item.roc } : {}),
        ...(item.pairwise ? { pairwise: item.pairwise } : {}),
        // Notes carry the caveats (separation, dropped variables, engine
        // quirks); the agent needs them as much as the panel does. Always a
        // list, so a caller can check `.length` without a guard.
        notes: Array.isArray(item.notes) ? item.notes : [],
      }
    }
    if (item.kind === 'image') {
      return {
        kind: 'image',
        id: item.id,
        title: item.title,
        path: workspace.artifactPath(item.runId, item.name ?? item.src),
        url: item.artifactUrl,
        ...provenance,
      }
    }
    return { kind: item.kind, id: item.id, title: item.title, text: item.text }
  })
}

const ONEWAY_POSTHOC = new Set(['LSD', 'BONFERRONI', 'SIDAK', 'TUKEY', 'SCHEFFE'])

export function buildAnalysis(procedure, p = {}) {
  const proc = String(procedure ?? '').toLowerCase()
  switch (proc) {
    case 'frequencies': {
      // FREQUENCIES takes its own fixed list of statistics and a separate
      // /PERCENTILES subcommand; both are opt-in, so an array of statistics
      // used to be dropped on the floor and the caller silently got only the
      // frequency table.
      const variables = vlist(p.variables, 'frequencies').join(' ')
      const FREQ_STATS = new Set([
        'MEAN', 'SEMEAN', 'MEDIAN', 'MODE', 'STDDEV', 'VARIANCE', 'KURTOSIS',
        'SEKURTOSIS', 'SKEWNESS', 'SESKEWNESS', 'RANGE', 'MINIMUM', 'MAXIMUM',
        'SUM', 'DEFAULT', 'ALL', 'NONE',
      ])
      let stats = ''
      if (p.statistics === 'all') {
        stats = ' /STATISTICS=ALL'
      } else if (Array.isArray(p.statistics) && p.statistics.length > 0) {
        const names = p.statistics.map((entry) => assertName(entry, 'statistic').toUpperCase())
        for (const name of names) {
          if (!FREQ_STATS.has(name)) {
            throw new Error(`frequencies 不支持统计量 ${name}；可用：${[...FREQ_STATS].join(' ')}`)
          }
        }
        stats = ` /STATISTICS=${names.join(' ')}`
      }
      const percentiles = Array.isArray(p.percentiles)
        ? p.percentiles.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0 && value < 100)
        : []
      const percentilePart = percentiles.length > 0 ? ` /PERCENTILES=${percentiles.join(' ')}` : ''
      // A percentile report is normally read without the frequency table.
      const notable = p.hideTable === true || (percentiles.length > 0 && p.showTable !== true)
      const format = notable ? ' /FORMAT=NOTABLE' : ''
      // One option, four charts: a boolean keeps the old bar-chart behaviour.
      const CHART_WANTED = {
        true: ' /BARCHART',
        bar: ' /BARCHART',
        pie: ' /PIECHART',
        histogram: ' /HISTOGRAM',
        histogramnormal: ' /HISTOGRAM NORMAL',
        histnormal: ' /HISTOGRAM NORMAL',
      }
      let chart = ''
      if (p.chart) {
        const key = typeof p.chart === 'string' ? p.chart.trim().toLowerCase() : true
        chart = CHART_WANTED[key] ?? ''
        if (!chart) throw new Error(`frequencies 的 chart 只认 bar、pie、histogram、histogramNormal（收到 ${p.chart}）`)
      }
      return `FREQUENCIES /VARIABLES=${variables}${stats}${percentilePart}${format}${chart}.`
    }
    case 'descriptives': {
      const variables = vlist(p.variables, 'descriptives').join(' ')
      // DESCRIPTIVES accepts a fixed list (MINIMUM, SESKEWNESS, SEKURTOSIS …)
      // and rejects MEDIAN/MODE, so the frequent SPSS spellings are folded onto
      // it and the rest is left to FREQUENCIES below.
      const FAMILY = { MIN: 'MINIMUM', MAX: 'MAXIMUM', SESKEW: 'SESKEWNESS', SEKURT: 'SEKURTOSIS' }
      const FREQ_ONLY = new Set(['MEDIAN', 'MODE', 'PERCENTILE', 'PERCENTILES'])
      const wanted = Array.isArray(p.statistics) && p.statistics.length > 0
        ? p.statistics.map((entry) => assertName(entry, 'statistic').toUpperCase())
        : ['MEAN', 'STDDEV', 'MINIMUM', 'MAXIMUM']
      const direct = []
      const needsFrequencies = []
      for (const name of wanted) {
        if (FREQ_ONLY.has(name)) { needsFrequencies.push(name); continue }
        direct.push(FAMILY[name] ?? name)
      }
      // DESCRIPTIVES has no /PERCENTILES, so asking for percentiles means the
      // request has to go through FREQUENCIES with the frequency table
      // suppressed; the median comes along because that is what a percentile
      // report is normally read against.
      const percentiles = Array.isArray(p.percentiles)
        ? p.percentiles.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0 && value < 100)
        : []
      // Standardized values live on DESCRIPTIVES only; when the table has to go
      // through FREQUENCIES the Z variables get their own statement first.
      const save = p.save === true || p.zScores === true || p.standardize === true
      const zScores = save ? `DESCRIPTIVES /VARIABLES=${variables} /SAVE.\n` : ''
      if (percentiles.length > 0 || needsFrequencies.length > 0) {
        const merged = [...new Set([...direct, ...needsFrequencies, 'MEDIAN'])]
        const suffix = percentiles.length > 0 ? ` /PERCENTILES=${percentiles.join(' ')}` : ''
        return `${zScores}FREQUENCIES /VARIABLES=${variables} /FORMAT=NOTABLE /STATISTICS=${merged.join(' ')}${suffix}.`
      }
      return `${zScores}DESCRIPTIVES /VARIABLES=${variables} /STATISTICS=${direct.join(' ')}${save ? ' /SAVE' : ''}.`
    }
    case 'crosstabs': {
      const row = assertName(p.row ?? p.rows, 'row variable')
      const column = assertName(p.column ?? p.columns, 'column variable')
      // Kappa 是「两批评分是否一致」的统计量，SPSS 把它和卡方放在同一个统计量面板里，
      // 所以这里收 p.kappa 与 statistics.kappa 两种写法，都翻译成 /STATISTICS 的 KAPPA。
      // 要 Kappa 就同时要 CHISQ：Cramér's V 与「小样本看 Fisher」两条表注都挂在
      // Chi-Square Tests 表上，只请求 KAPPA 会连这两条一起丢掉。
      const objectStatistics = p.statistics && typeof p.statistics === 'object' && !Array.isArray(p.statistics)
        ? p.statistics
        : null
      const kappa = p.kappa === true || objectStatistics?.kappa === true
      const requested = objectStatistics
        ? Object.keys(objectStatistics).filter((name) => objectStatistics[name] === true)
        : Array.isArray(p.statistics) && p.statistics.length > 0
          ? p.statistics
          : p.statistics === false
            ? []
            : ['CHISQ', 'PHI']
      const wanted = [...requested]
      if (kappa) {
        if (!wanted.some((entry) => String(entry).toUpperCase() === 'KAPPA')) wanted.push('KAPPA')
        if (!wanted.some((entry) => String(entry).toUpperCase() === 'CHISQ')) wanted.unshift('CHISQ')
      }
      // PSPP accepts a fixed list here and wants them space separated; a comma
      // is a syntax error, so join with spaces and upper-case the names.
      const stats = wanted.length > 0
        ? ` /STATISTICS=${wanted.map((entry) => assertName(entry, 'statistic').toUpperCase()).join(' ')}`
        : ''
      // Residuals are what make a contingency table readable: the expected
      // count says what independence predicts, the adjusted residual says which
      // cell is responsible for the chi-square. Only emit /CELLS when something
      // beyond the bare count was asked for, because PSPP's default already is
      // COUNT and an empty /CELLS is a syntax error.
      const wantedCells = Array.isArray(p.cells)
        ? p.cells.map((entry) => assertName(entry, 'cell').toUpperCase())
        : []
      const cells = wantedCells.length > 0 ? ` /CELLS=${wantedCells.join(' ')}` : ''
      // A third variable layers the table the way SPSS's "Layer 1 of 1" does:
      // PSPP accepts it in the same /TABLES list instead of needing SPLIT FILE.
      const layer = p.layer ? assertName(p.layer, 'layer variable') : null
      return `CROSSTABS /TABLES=${row} BY ${column}${layer ? ` BY ${layer}` : ''}${stats}${cells}.`
    }
    case 'ttest_independent': {
      const group = assertName(p.group ?? p.by, 'group variable')
      const raw = Array.isArray(p.groupValues) ? p.groupValues : String(p.groupValues ?? '1 2').split(/\s+/)
      const values = groupCodes(raw, p.groupString)
      return `T-TEST GROUPS=${group}(${values}) /VARIABLES=${vlist(p.variables, 't-test').join(' ')}.`
    }
    case 'ttest_one_sample':
    case 'ttest_one': {
      const value = String(p.testValue ?? p.value ?? '0')
      return `T-TEST /TESTVAL=${value} /VARIABLES=${vlist(p.variables, 'one-sample t-test').join(' ')}.`
    }
    case 'ttest_paired': {
      const list = vlist(p.variables, 'paired t-test')
      // An odd count used to lose the last variable without a word: the user
      // sees a test of fewer pairs than they asked for.
      if (list.length % 2 !== 0) throw new Error(`配对 t 检验的变量必须成对出现：${list.join('、')} 是 ${list.length} 个，请再给一个变量或删掉一个`)
      const pairs = []
      for (let index = 0; index + 1 < list.length; index += 2) pairs.push(`${list[index]} ${list[index + 1]}`)
      if (pairs.length === 0) throw new Error('paired t-test needs pairs of variables')
      return `T-TEST PAIRS=${pairs.join(' ')}.`
    }
    case 'oneway':
    case 'anova': {
      // PSPP 2.1.3 accepts exactly these post-hoc methods (Gabriel, Dunnett,
      // Duncan, SNK and REGW were probed and are rejected as unknown).
      const requested = (Array.isArray(p.postHoc) ? p.postHoc : []).map((entry) => String(entry).toUpperCase())
      const unknown = requested.filter((entry) => !ONEWAY_POSTHOC.has(entry))
      if (unknown.length > 0) {
        throw new Error(`PSPP 2.1.3 没有这些事后比较方法：${unknown.join('、')}；可用 ${[...ONEWAY_POSTHOC].join('、')}`)
      }
      const methods = requested.filter((entry) => ONEWAY_POSTHOC.has(entry))
      const stats = p.statistics === false ? [] : ['DESCRIPTIVES']
      if (p.homogeneity !== false && p.statistics !== false) stats.push('HOMOGENEITY')
      const parts = [`ONEWAY ${vlist(p.variables, 'one-way ANOVA').join(' ')} BY ${assertName(p.by, 'factor')}`]
      if (stats.length > 0) parts.push(`/STATISTICS=${stats.join(' ')}`)
      if (methods.length > 0) parts.push(`/POSTHOC=${methods.join(' ')}`)
      return `${parts.join(' ')}.`
    }
    case 'glm': {
      // A randomized block design needs two factors (treatment + block) and an
      // explicit DESIGN; one factor plus no design is just a one-way ANOVA.
      const dependents = vlist(p.variables, 'GLM').join(' ')
      const factors = (Array.isArray(p.factors) && p.factors.length > 0
        ? p.factors
        : Array.isArray(p.by) && p.by.length > 0
          ? p.by
          : [p.by].filter((entry) => entry !== undefined && entry !== null && entry !== '')
      ).map((entry) => assertName(entry, 'factor'))
      if (factors.length === 0) throw new Error('GLM needs at least one factor (use `by` or `factors`)')
      const covariates = Array.isArray(p.covariates) ? p.covariates.map((entry) => assertName(entry, 'covariate')) : []
      if (covariates.length > 0) {
        // Probed: `GLM y BY g WITH x` is a syntax error in PSPP 2.1.3, so an
        // ANCOVA cannot be built from this command. Emitting it anyway gave the
        // user a syntax error instead of an explanation.
        throw new Error('PSPP 2.1.3 的 GLM 不接受协变量（WITH 子句会报语法错误），做不了协方差分析（ANCOVA）：请改用回归，或把协变量当第二个因素')
      }
      const command = `GLM ${dependents} BY ${factors.join(' ')}`
      // Without /DESIGN PSPP fits the full factorial; a block design wants the
      // two main effects only, so the default is "each factor alone".
      const design = typeof p.design === 'string' && p.design.trim() !== ''
        ? p.design.trim()
        : factors.join(' ')
      // PSPP's GLM has no /POSTHOC and no /CONTRAST (probed: "expecting
      // MISSING, INTERCEPT, CRITERIA, METHOD, or DESIGN"), but ONEWAY has both
      // and fits the same one-factor model. Asking for either on a single-factor
      // design adds a second statement instead of pretending GLM can do it.
      const posthoc = String(p.posthoc ?? '').trim().toUpperCase()
      const allowed = new Set(['LSD', 'BONFERRONI', 'SIDAK', 'TUKEY', 'SCHEFFE'])
      if (posthoc !== '' && /^[A-Z]+$/.test(posthoc) && !allowed.has(posthoc)) {
        throw new Error(`不认识的事后检验：${posthoc}（只有 ${[...allowed].join('、')}）`)
      }
      const usePosthoc = posthoc !== '' && allowed.has(posthoc)
      const termContrasts = Array.isArray(p.contrasts) && p.contrasts.some((entry) => entry && typeof entry === 'object' && entry.factor)
      if (termContrasts) {
        if (factors.length < 2) throw new Error('按因子写的对比（{factor, coefficients}）要用在两个因子以上的模型上；单因子直接写系数，例如 [2,-1,-1]')
        const full = factors.length === 2 ? `${factors[0]} ${factors[1]} ${factors[0]}*${factors[1]}` : factors.join(' ')
        const wanted = typeof p.design === 'string' && p.design.trim() !== '' ? p.design.trim() : full
        return `${command} /DESIGN=${wanted}.`
      }
      const contrasts = normalizeContrasts(p.contrasts)
      if (usePosthoc || contrasts.length > 0) {
        if (factors.length !== 1 || /[*+\-()]/.test(design)) {
          throw new Error('事后检验与对比只做单因子设计：两个因子以上的模型请先拆成单因子')
        }
        const parts = [`ONEWAY ${dependents} BY ${factors[0]}`]
        if (usePosthoc) parts.push('/STATISTICS=DESCRIPTIVES HOMOGENEITY', `/POSTHOC=${posthoc} ALPHA(0.05)`)
        contrasts.forEach((coeffs) => parts.push(`/CONTRAST=${coeffs.join(' ')}`))
        return `${command} /DESIGN=${design}.\n${parts.join(' ')}.`
      }
      return `${command} /DESIGN=${design}.`
    }
    case 'correlation': {
      // PSPP has no /MATRIX=OUT and no PARTIAL CORR (both probed: "not a
      // variable name" and "not yet implemented"), so descriptives alongside
      // the matrix and pairwise exclusion are the honest options.
      const parts = [`CORRELATIONS /VARIABLES=${vlist(p.variables, 'correlation').join(' ')}`]
      parts.push(`/PRINT=${p.oneTailed === true ? 'ONETAIL' : 'TWOTAIL'} ${p.noSignificance === true ? 'NOSIG' : 'SIG'}`)
      if (p.statistics !== false || p.descriptives === true) parts.push('/STATISTICS=DESCRIPTIVES')
      parts.push(`/MISSING=${p.missing === 'pairwise' ? 'PAIRWISE' : 'LISTWISE'}`)
      return `${parts.join(' ')}.`
    }
    case 'regression': {
      const dependent = assertName(p.dependent ?? p.dv, 'dependent variable')
      // /SAVE adds variables to the dataset, so the caller has to persist the run
      // (the workspace appends SAVE OUTFILE in that case).
      const wanted = (Array.isArray(p.save) ? p.save : p.save ? [p.save] : [])
        .map((entry) => assertName(entry, 'saved value').toUpperCase())
      const save = wanted.length > 0 ? ` /SAVE=${wanted.join(' ')}` : ''
      // PSPP prints standardized beta with COEFF; CI adds the 95% interval for
      // B. TOL is deliberately not requested by default: with TOL the engine
      // dies inside gsl_blas_dsymm on roughly one run in six and writes no
      // output at all, so tolerance/VIF are computed by the plugin instead
      // (see lib/regression.js). Durbin-Watson is not available at all.
      const allowed = new Set(['COEFF', 'R', 'ANOVA', 'BCOV', 'CI', 'TOL', 'ALL', 'DEFAULTS'])
      const explicit = (Array.isArray(p.statistics) ? p.statistics : [])
        .map((entry) => String(entry).trim().toUpperCase())
        .filter((entry) => allowed.has(entry))
      // CI takes a level: PSPP writes "90% Confidence Interval for B" only when
      // the level travels with the keyword (a bare CI means 95%).
      const level = Number(p.ciLevel ?? p.confidenceLevel ?? 95)
      const ciKeyword = `CI(${Number.isFinite(level) && level > 0 && level < 100 ? Math.round(level) : 95})`
      const stats = explicit.length > 0
        ? explicit
        : ['COEFF', 'R', 'ANOVA', ...(p.confidence === false ? [] : [ciKeyword])]
      return `REGRESSION /DEPENDENT=${dependent} /METHOD=ENTER ${vlist(p.independents ?? p.ivs, 'regression').join(' ')}${save} /STATISTICS=${stats.join(' ')}.`
    }
    case 'logistic': {
      const dependent = assertName(p.dependent ?? p.dv, 'dependent variable')
      // PSPP prints Exp(B) with its 95% interval once CI is asked for; without
      // it the table has B and S.E. but no odds ratio, which is what gets cited.
      const level = Number(p.ci ?? p.confidence ?? 95)
      const ci = Number.isFinite(level) && level > 0 && level < 100 ? Math.round(level) : 95
      return `LOGISTIC REGRESSION ${dependent} WITH ${vlist(p.independents ?? p.ivs, 'logistic regression').join(' ')} /PRINT=CI(${ci}) SUMMARY.`
    }
    case 'factor': {
      // PSPP spells "no rotation" NOROTATE and rejects NONE.
      const rotation = String(p.rotation ?? 'VARIMAX').toUpperCase()
      const keyword = rotation === 'NONE' || rotation === 'NOROTATE' ? 'NOROTATE' : rotation
      const print = ['INITIAL', 'KMO', 'EXTRACTION', ...(keyword === 'NOROTATE' ? [] : ['ROTATION'])]
      return `FACTOR /VARIABLES=${vlist(p.variables, 'factor').join(' ')} /PRINT=${print.join(' ')} /ROTATION=${keyword}.`
    }
    case 'reliability':
      return `RELIABILITY /VARIABLES=${vlist(p.variables, 'reliability').join(' ')} /SCALE('all') ALL /MODEL=ALPHA.`
    case 'npar':
      return `NPAR TESTS /CHISQUARE=${assertName(p.variables?.[0] ?? p.variable, 'variable')}.`
    case 'npar_binomial':
      return `NPAR TESTS /BINOMIAL(${String(p.testValue ?? p.p ?? 0.5).trim()})=${assertName(p.variable ?? p.variables?.[0], 'variable')}.`
    case 'npar_ks':
      return `NPAR TESTS /K-S(NORMAL)=${vlist(p.variables, 'one-sample K-S').join(' ')}.`
    case 'npar_runs':
      return `NPAR TESTS /RUNS(MEDIAN)=${vlist(p.variables, 'runs').join(' ')}.`
    case 'npar_wilcoxon':
      return `NPAR TESTS /WILCOXON=${vlist(p.variables, 'Wilcoxon').join(' ')}.`
    case 'npar_sign':
      return `NPAR TESTS /SIGN=${vlist(p.variables, 'sign test').join(' ')}.`
    case 'npar_mannwhitney': {
      const codes = p.groupValues ?? p.groups ?? [1, 2]
      const list = Array.isArray(codes) ? codes : String(codes).trim().split(/\s+/)
      const values = groupCodes(list, p.groupString)
      return `NPAR TESTS /MANN-WHITNEY=${assertName(p.variables?.[0] ?? p.variable, 'variable')} BY ${assertName(p.by, 'group variable')}(${values}).`
    }
    case 'npar_kruskal': {
      const codes = p.groupValues ?? p.groups ?? []
      const list = Array.isArray(codes) ? codes : String(codes).trim().split(/\s+/).filter(Boolean)
      if (list.length === 0) throw new Error('kruskal-wallis needs the group codes, e.g. groupValues: [1, 3]')
      // A string grouping variable takes a list of quoted codes, not the
      // "(low high)" span a numeric one uses.
      // PSPP only understands a range here (probed: `(1 2 3)` is
      // `expecting ')'`), and a range silently includes the codes in between,
      // so say which codes are being assumed.
      const wanted = list.map((value) => String(value)).filter((value) => value !== '')
      if (wanted.length < 2) throw new Error('Kruskal-Wallis 需要至少两个组代码，例如 groupValues: [1, 3]')
      const numericCodes = wanted.map(Number)
      const range = numericCodes.every((value) => Number.isFinite(value))
      const spec = range ? `${Math.min(...numericCodes)} ${Math.max(...numericCodes)}` : groupCodes(list, p.groupString)
      return `NPAR TESTS /KRUSKAL-WALLIS=${assertName(p.variables?.[0] ?? p.variable, 'variable')} BY ${assertName(p.by, 'group variable')}(${spec}).`
    }
    case 'npar_jonckheere': {
      // PSPP wants the group span here, not a list: "(1 2 3)" is a syntax error
      // while "(1 3)" means groups 1..3 in order.
      const codes = p.groupValues ?? p.groups ?? []
      const list = Array.isArray(codes) ? codes : String(codes).trim().split(/\s+/)
      if (list.length === 0) throw new Error('jonckheere needs the group codes, e.g. groupValues: [1, 3]')
      const range = list.length >= 2 ? `${list[0]} ${list[list.length - 1]}` : `${list[0]} ${list[0]}`
      return `NPAR TESTS /JONCKHEERE-TERPSTRA=${assertName(p.variables?.[0] ?? p.variable, 'variable')} BY ${assertName(p.by, 'group variable')}(${range}).`
    }
    case 'npar_median': {
      // PSPP 2.1.3 does run the median test (probed); it wants the same
      // "(low high)" span the other K-sample tests take, not a code list.
      const codes = p.groupValues ?? p.groups ?? []
      const list = Array.isArray(codes) ? codes : String(codes).trim().split(/\s+/).filter(Boolean)
      if (list.length === 0) throw new Error('median test needs the group codes, e.g. groupValues: [1, 3]')
      if (list.length < 2) throw new Error('中位数检验需要至少两个组代码，例如 groupValues: [1, 3]')
      const numericCodes = list.map(Number)
      const spec = numericCodes.every((value) => Number.isFinite(value))
        ? `${Math.min(...numericCodes)} ${Math.max(...numericCodes)}`
        : groupCodes(list, p.groupString)
      return `NPAR TESTS /MEDIAN=${assertName(p.variables?.[0] ?? p.variable, 'variable')} BY ${assertName(p.by, 'group variable')}(${spec}).`
    }
    case 'npar_friedman':
      return `NPAR TESTS /FRIEDMAN=${vlist(p.variables, 'Friedman').join(' ')}.`
    case 'npar_mcnemar': {
      const first = assertName(p.var1 ?? p.variables?.[0] ?? p.variable, 'first variable')
      const second = assertName(p.var2 ?? p.variables?.[1] ?? p.with, 'second variable')
      if (first === second) throw new Error('McNemar needs two different variables')
      return `NPAR TESTS /MCNEMAR=${first} WITH ${second} (PAIRED).`
    }
    case 'npar_cochran': {
      const names = vlist(p.variables, 'Cochran Q')
      if (names.length < 3) throw new Error('Cochran Q needs at least three variables')
      return `NPAR TESTS /COCHRAN=${names.join(' ')}.`
    }
    case 'npar_kendall': {
      const names = vlist(p.variables, 'Kendall W')
      if (names.length < 3) throw new Error('Kendall W needs at least three variables')
      return `NPAR TESTS /KENDALL=${names.join(' ')}.`
    }
    case 'examine': {
      // Explore is the one place that gives the median, the quartiles and the
      // normality tests, so ask for the descriptives too; without them the
      // output only has the case summary and a boxplot.
      // One EXAMINE per variable: with several variables in one command PSPP
      // 2.1.3 only prints the normality test for the first of them.
      const names = vlist(p.variables, 'explore')
      const by = p.by ? ` BY ${assertName(p.by, 'factor')}` : ''
      const plots = p.noPlot ? '' : ` /PLOT=${p.normalPlot ? 'BOXPLOT NPPLOT' : 'BOXPLOT'}`
      return names
        .map((name) => `EXAMINE VARIABLES=${name}${by}${plots} /STATISTICS=DESCRIPTIVES /NOTOTAL.`)
        .join('\n')
    }
    case 'means':
      return `MEANS ${vlist(p.variables, 'means').join(' ')} BY ${assertName(p.by, 'factor')} /CELLS=MEAN COUNT STDDEV.`
    case 'ctables': {
      const row = assertName(p.row ?? p.rows, 'row variable')
      const column = assertName(p.column ?? p.columns, 'column variable')
      const stats = (Array.isArray(p.statistics) ? p.statistics : [])
        .map((name) => String(name).toUpperCase())
        .filter((name) => CTABLES_STATS.includes(name))
      const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : `${row} 按 ${column} 统计`
      const cilevel = Number(p.ciLevel ?? p.cilevel ?? 95)
      // 自定义表的列轴必须是分类变量；数值编码列（测度=scale）先临时降级为名义
      const demote = p.columnMeasure === 'scale' ? [`VARIABLE LEVEL ${column} (NOMINAL).`] : []
      return [
        ...demote,
        `CTABLES /TABLE=${row}${stats.length ? ` [${stats.join(', ')}]` : ''} BY ${column}`,
        `/TITLES TITLE='${title.replace(/'/g, "''")}'`,
        `/CATEGORIES VARIABLES=${column} ORDER=A${p.includeMissing ? ' MISSING=INCLUDE' : ''}`,
        `/CRITERIA CILEVEL ${Number.isFinite(cilevel) && cilevel > 0 && cilevel < 100 ? cilevel : 95}.`,
      ].join('\n')
    }
    case 'roc':
      // /PRINT=COORDINATES is the sensitivity / 1-specificity table; the curve
      // PNG alone cannot be turned into a numbers table for a paper.
      return `ROC ${assertName(p.variables?.[0] ?? p.variable, 'variable')} BY ${assertName(p.by, 'outcome')}(${Number(p.value ?? 1)}) /PLOT=CURVE /PRINT=COORDINATES.`
    case 'cluster':
      return `QUICK CLUSTER ${vlist(p.variables, 'cluster').join(' ')} /CRITERIA=CLUSTER(${Math.max(2, Number(p.clusters ?? 2))}).`
    default:
      throw new Error(`unknown analysis procedure: ${procedure}`)
  }
}

/**
 * Side tables a procedure needs that the engine cannot be asked for.
 *
 * The regression hint travels next to the syntax: runSyntax uses it to compute
 * tolerance/VIF itself, because asking PSPP for TOL crashes one run in six.
 */
export function analysisExtras(procedure, p = {}) {
  if (procedure === 'logistic') {
    const independent = (p.independents ?? p.ivs ?? p.covariates ?? []).map((name) => String(name))
    const dependent = String(p.dependent ?? p.dv ?? '')
    if (independent.length === 0 || dependent === '') return {}
    return { roc: { by: dependent, variables: independent } }
  }
  if (procedure === 'glm') {
    // Two factors or more: the engine has no /CONTRAST, so the hypotheses come
    // back as a request the host fits on the same design matrix.
    const factors = (Array.isArray(p.factors) && p.factors.length > 0
      ? p.factors
      : [p.by].filter((entry) => entry !== undefined && entry !== null && entry !== '')
    ).map((entry) => String(entry))
    const dependent = String(p.variables?.[0] ?? p.dependent ?? p.dv ?? (Array.isArray(p.variables) ? p.variables[0] : '') ?? '')
    const terms = Array.isArray(p.contrasts) ? p.contrasts : []
    if (factors.length < 2 || terms.length === 0 || dependent === '') return {}
    const hypotheses = []
    for (const entry of terms) {
      if (entry && typeof entry === 'object' && entry.factor) {
        hypotheses.push({
          label: String(entry.label ?? `${entry.factor} 的对比`),
          term: { factor: String(entry.factor), coefficients: (entry.coefficients ?? []).map(Number) },
        })
      }
    }
    if (hypotheses.length === 0) return {}
    return { contrasts: { dependent, factors, covariates: [], hypotheses } }
  }
  if (procedure !== 'regression') return {}
  // Even when the caller asks for TOL/ALL we still hand over the hint: if the
  // engine crashes and runSyntax retries without TOL, the retry needs the table
  // it promised in the log. runSyntax skips the extra table when the engine did
  // print Tolerance itself, so passing it is never duplicated.
  const independents = (p.independents ?? p.ivs ?? []).map((name) => String(name))
  if (independents.length === 0) return {}
  const influence = p.influence === true || p.diagnostics === true || p.casewise === true
  // The model travels even when neither table was asked for: the residual plots
  // need the same fit, and without it they could disagree with the coefficients.
  const plots = (Array.isArray(p.plots) ? p.plots : [])
    .map((entry) => String(entry).toLowerCase())
    .filter((entry) => entry === 'residual' || entry === 'pp')
  return {
    regression: {
      dependent: String(p.dependent ?? p.dv ?? ''),
      independents,
      influence,
    },
    ...(plots.length > 0 ? { plots } : {}),
  }
}

export function buildTransform(operation, p = {}) {
  const op = String(operation ?? '').toLowerCase()
  switch (op) {
    case 'compute': {
      const target = assertName(p.target, 'target variable')
      const expression = String(p.expression ?? '')
      if (expression.trim() === '') throw new Error('compute requires an expression')
      return `COMPUTE ${target} = ${expression}.\nEXECUTE.`
    }
    case 'recode': {
      const source = assertName(p.variable, 'variable')
      const target = assertName(p.target ?? p.variable, 'target variable')
      const spec = String(p.mapping ?? '')
      if (spec.trim() === '') throw new Error('recode requires a mapping such as "(1 THRU 3=1) (ELSE=2)"')
      return `RECODE ${source} ${spec} INTO ${target}.\nEXECUTE.`
    }
    case 'autorecode': {
      // Turn a string column into consecutive numbers: the usual way to feed a
      // text category variable to a procedure that wants numeric codes.
      const source = assertName(p.variable ?? (p.variables ?? [])[0], 'variable')
      const target = assertName(p.target ?? `n_${source}`, 'target variable')
      return `AUTORECODE VARIABLES=${source} /INTO ${target}.\nEXECUTE.`
    }
    case 'sample': {
      const percent = Number(p.percent ?? 25)
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('sample requires percent between 1 and 100')
      return `SAMPLE ${Math.min(1, percent / 100)}.`
    }
    case 'count': {
      const target = assertName(p.target, 'target variable')
      const vars = vlist(p.variables, 'count')
      const raw = String(p.value ?? '1').trim()
      const literal = /^-?\d+(\.\d+)?$/.test(raw) ? raw : `'${raw.replace(/'/g, '')}'`
      return `COUNT ${target} = ${vars.join(' ')} (${literal}).`
    }
    case 'transpose': {
      // FLIP is supported by PSPP 2.1.3 (probed: cases become variables, the old
      // variable names land in CASE_LBL). /NEWNAMES takes the names from the
      // values of a variable instead.
      const variables = vlist(p.variables, 'transpose')
      const names = p.newNames ?? p.names
      const newNames = names ? ` /NEWNAMES=${assertName(names, 'name variable')}` : ''
      return `FLIP VARIABLES=${variables.join(' ')}${newNames}.`
    }
    case 'rank': {
      const variable = assertName(p.variable ?? (p.variables ?? [])[0], 'rank variable')
      const base = variable.replace(/[^A-Za-z0-9_]/g, '_')
      const target = p.target ? assertName(p.target, 'rank target') : `r_${base}`
      const ties = String(p.ties ?? 'MEAN').toUpperCase()
      // PSPP spells the rank types RANK / N / PERCENT / PROPORTION / RFRACTION /
      // NORMAL / SAVAGE / NTILES(n); anything else is refused rather than sent.
      const TYPES = {
        rank: () => `/RANK INTO ${target}`,
        n: () => `/N INTO n_${base}`,
        percent: () => `/PERCENT INTO p_${base}`,
        proportion: () => `/PROPORTION INTO prop_${base}`,
        rfraction: () => `/RFRACTION INTO rf_${base}`,
        normal: () => `/NORMAL INTO z_${base}`,
        savage: () => `/SAVAGE INTO sv_${base}`,
      }
      const asked = Array.isArray(p.rankTypes) && p.rankTypes.length > 0
        ? p.rankTypes.map((entry) => String(entry).trim().toLowerCase())
        : null
      const parts = []
      if (asked) {
        for (const name of asked) {
          if (name === 'ntiles') throw new Error('ntiles 不是秩类型，它是个独立参数：给 ntiles: 2 或更多即可')
          if (!TYPES[name]) throw new Error(`不认识的秩类型：${name}（只有 ${Object.keys(TYPES).join('、')}）`)
          parts.push(TYPES[name]())
        }
      } else {
        parts.push(TYPES.rank())
      }
      const ntiles = Number(p.ntiles ?? 0)
      if (Number.isFinite(ntiles) && ntiles >= 2) parts.push(`/NTILES(${Math.round(ntiles)}) INTO q_${base}`)
      if (parts.length === 0) throw new Error('至少给一种秩类型')
      return `RANK VARIABLES=${variable} ${parts.join(' ')} /TIES=${ties}.`
    }
    case 'sort': {
      const variables = vlist(p.variables, 'sort')
      const order = String(p.order ?? 'A').toUpperCase() === 'D' ? 'D' : 'A'
      return `SORT CASES BY ${variables.map((name) => `${name} (${order})`).join(' ')}.`
    }
    case 'aggregate': {
      const breaks = vlist(p.break ?? p.by, 'break variable')
      const target = assertName(p.target, 'aggregate variable')
      const func = String(p.function ?? 'MEAN').toUpperCase()
      const source = assertName(p.variable, 'variable')
      return `AGGREGATE /OUTFILE=* MODE=ADDVARIABLES /BREAK=${breaks.join(' ')} /${target}=${func}(${source}).`
    }
    case 'select':
      return `SELECT IF ${String(p.expression ?? '')}.\nEXECUTE.`
    case 'filter':
      return `FILTER BY ${assertName(p.variable, 'filter variable')}.\nEXECUTE.`
    case 'weight':
      return p.off === true
        ? 'WEIGHT OFF.\nEXECUTE.'
        : `WEIGHT BY ${assertName(p.variable, 'weight variable')}.\nEXECUTE.`
    case 'split':
      return p.off === true
        ? 'SPLIT FILE OFF.\nEXECUTE.'
        : `SPLIT FILE BY ${vlist(p.variables ?? p.break, 'split variable').join(' ')}.\nEXECUTE.`
    case 'rename':
      return `RENAME VARIABLES (${assertName(p.from, 'variable')}=${assertName(p.to, 'new name')}).`
    case 'delete':
      return `DELETE VARIABLES ${vlist(p.variables, 'variables').join(' ')}.`
    default:
      throw new Error(`unknown transform: ${operation}`)
  }
}

export function buildChart(type, p = {}) {
  const chart = String(type ?? 'bar').toLowerCase()
  switch (chart) {
    case 'bar': {
      const variable = assertName(p.variable, 'variable')
      const by = p.by ? assertName(p.by, 'category variable') : null
      const stat = String(p.statistic ?? 'MEAN').toUpperCase()
      return by ? `GRAPH /BAR(SIMPLE)=${stat}(${variable}) BY ${by}.` : `GRAPH /BAR(SIMPLE)=${stat}(${variable}).`
    }
    case 'histogram':
      return `GRAPH /HISTOGRAM=${assertName(p.variable, 'variable')}.`
    case 'scatterplot':
      return `GRAPH /SCATTERPLOT(BIVAR)=${assertName(p.x, 'x variable')} WITH ${assertName(p.y, 'y variable')}.`
    default:
      throw new Error(`chart type not supported by the engine: ${type} (supported: bar, histogram, scatterplot)`)
  }
}

export function createTools({ registry, config }) {
  const tool = (definition) => ({
    ...definition,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
  })

  const resolve = (exec) => {
    const sessionId = exec?.agent?.session?.id
    const cwd = exec?.agent?.session?.header?.cwd
    const primary = String(sessionId ?? 'default')
    // Follow the tab the user has on screen; fall back to the primary one.
    const session = registry?.resolveForTools ? registry.resolveForTools(primary) : primary
    return { sessionId: session, cwd: typeof cwd === 'string' && cwd ? cwd : undefined }
  }

  return [
    tool({
      name: 'pspp_status',
      description: 'Report the PSPP engine (binary, origin, version), the current session dataset, and the engine capabilities. Call this before the first analytics operation in a session. `engine.source` is `bundled` for the copy that ships with the plugin and `configured` when the session points at an engine directory of its own.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.engine.bin) throw new Error(workspace.engine.hint ?? 'no PSPP engine available')
        // The bundled engine keeps its shared libraries beside the binary, so
        // probing it without the engine's own environment fails silently on
        // Windows and left `version` empty.
        const inspection = await runProcess(workspace.engine.bin, ['--version'], {
          timeoutMs: 15000,
          env: engineEnv(workspace.engine, {}),
        })
        return {
          // Read live: a hot reload rewrites package.json, and a cached value
          // would keep telling the verifier the old build is running.
          plugin: { name: pluginInfo().name || pkgName, version: pluginInfo().version || workspace.config?.pluginVersion || null },
          engine: {
            source: workspace.engine.source,
            bundled: workspace.engine.source === 'bundled',
            binary: workspace.engine.bin,
            version: inspection.stdout.split('\n')[0]?.trim() ?? '',
          },
          dataset: workspace.dataset
            ? {
              path: workspace.dataset.sourcePath,
              cases: workspace.dataset.rows.length,
              variables: workspace.dataset.variables.map((variable) => `${variable.name} (${variable.type}${variable.label ? `, ${variable.label}` : ''})`),
            }
            : null,
          capabilities: {
            dataFiles: ['.sav', '.por', '.csv', '.txt', '.tsv', '.xlsx', '.ods', '.dta'],
            exports: ['.sav', '.csv', '.pdf', '.odt', '.docx', '.xlsx', '.html', '.png', '.svg'],
            analyses: ['frequencies', 'descriptives', 'crosstabs', 'ttest_one_sample', 'ttest_independent', 'ttest_paired', 'oneway', 'glm', 'correlation', 'regression', 'logistic', 'factor', 'reliability', 'npar', 'npar_binomial', 'npar_ks', 'npar_runs', 'npar_wilcoxon', 'npar_sign', 'npar_mannwhitney', 'npar_kruskal', 'npar_median', 'npar_friedman', 'npar_mcnemar', 'npar_cochran', 'npar_kendall', 'npar_jonckheere', 'examine', 'means', 'ctables', 'roc', 'cluster', 'partial'],
            transforms: ['compute', 'recode', 'autorecode', 'sort', 'aggregate', 'select', 'filter', 'weight', 'split', 'rename', 'delete', 'sample', 'count', 'rank', 'transpose'],
            charts: ['bar', 'histogram', 'scatterplot', 'boxplot', 'line', 'pie', 'area', 'bar+95%CI', 'bar+significance', 'line+2Y', 'line+95%CI'],
            tables: ['baseline（表 1）', 'compare（表 2）', 'pairwise（两两比较）', 'partial（偏相关）'],
            // Spelled out on purpose: a missing menu entry looks like an
            // oversight, a named limitation with a reason does not.
            unsupported: [
              { feature: '生存分析（Kaplan-Meier / Cox 回归）', reason: 'PSPP 2.1.3 未实现，引擎报 not yet implemented', alternative: '导出 CSV 后用 R 的 survival 包，或装 SPSS/R 插件' },
              { feature: '复杂抽样（CSDESCRIPTIVES / CSTABULATE）', reason: 'PSPP 2.1.3 未实现', alternative: '用「加权个案」近似分层权重，或改用 R survey 包' },
              { feature: '多重插补（MULTIPLE IMPUTATION）', reason: 'PSPP 2.1.3 不认识这条命令（Unknown command），要做得自己实现', alternative: '先用「选择个案」排除缺失，或用「计算变量」做均值/中位数填补（会低估方差，需在限制里说明）' },
              { feature: '协方差分析（GLM … WITH 协变量）', reason: 'PSPP 2.1.3 的 GLM 不接受 WITH 子句', alternative: '用 REGRESSION 把分组变量当哑变量、协变量当预测变量，等价于 ANCOVA 的模型' },
              { feature: '偏相关（PARTIAL CORR 命令）', reason: 'PSPP 2.1.3 没有这条命令；本插件用残差法自己算，见「分析 → 相关 → 偏相关…」或 pspp_partial', alternative: '直接用「相关 → 偏相关…」，它给出 r、df、P、N 与星号；想自己核对时用 REGRESSION 取残差再 CORRELATIONS' },
              { feature: '决策树（TREE）/ 报表（REPORT）/ 概率图（PPLOT）', reason: 'PSPP 2.1.3 未实现', alternative: 'P-P/Q-Q 图可用 EXAMINE /PLOT=NPPLOT 近似；报表用「表 1/表 2」或输出导出 Word' },
              { feature: 'Durbin-Watson 残差自相关检验', reason: 'PSPP 的 REGRESSION /STATISTICS 只接受 COEFF、R、ANOVA、BCOV、CI、TOL', alternative: '回归时加 /SAVE=RESID 存残差，导出 CSV 后按公式自己算 DW' },
              { feature: '曲线估计（CURVEFIT）', reason: 'PSPP 2.1.3 返回「CURVEFIT 尚未实现」', alternative: '用「计算变量」造 x²、ln(x)、1/x 等项，再跑 REGRESSION' },
              { feature: '多选题直接参与 CROSSTABS 等命令', reason: 'PSPP 不认 $ 变量；本插件自己算频数与交叉表（见转换 → 多选题面板）', alternative: '用「转换 → 多选题面板」出频数与交叉表；要进其他过程先把选项拆成二分变量' },
            ],
            syntax: 'any PSPP command through pspp_run',
          },
        }
      },
    }),

    tool({
      name: 'pspp_open',
      description: 'Open (or import) a data file into the session dataset. Supports SPSS system files (.sav), portable files (.por), delimited text (.csv/.txt/.tsv), Excel workbooks (.xlsx), OpenDocument spreadsheets (.ods) and Stata files (.dta, release 117/118); the first sheet is used unless sheet is given. Relative paths resolve against the session working directory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/path, or path relative to the session working directory.' },
          encoding: { type: 'string', description: 'Text encoding for .csv/.txt/.tsv: auto (default), utf-8, gbk, gb18030, big5, latin1.' },
          delimiter: { type: 'string', description: "Field separator for delimited text: auto (default), ',', ';', tab or '|'." },
          hasHeader: { type: 'boolean', description: 'Whether the first line holds variable names (default true for .csv/.tsv, false for .txt).' },
          sheet: { type: 'string', description: 'For .xlsx/.ods: sheet name, or a zero-based index (default: first sheet).' },
          skipRows: { type: 'number', description: 'Skip this many lines above the table (title rows, notes). For .csv/.txt the count is file lines; for a worksheet it is sheet rows.' },
          skipTailRows: { type: 'number', description: 'Drop this many lines after the table. Chinese reports usually end with a 合计 (totals) line, which is a footnote rather than a case.' },
          names: { type: 'array', items: { type: 'string' }, description: 'One variable name per column, in file order. An empty string keeps the name the import would pick. Illegal characters are stripped and reported back.' },
          types: { type: 'array', items: { type: 'string', enum: ['numeric', 'string'] }, description: 'One type per column, in file order. An empty string keeps the inferred type.' },
          missing: { type: 'array', items: { type: 'string' }, description: 'Cell values that mean "no answer" (e.g. "-9", "NA"). They become user-missing values and are reported in notes; statistics then exclude them.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const result = await workspace.open(args.path, {
          encoding: args.encoding,
          delimiter: args.delimiter,
          hasHeader: args.hasHeader,
          sheet: args.sheet,
          skipRows: args.skipRows,
          skipTailRows: args.skipTailRows,
          names: args.names,
          types: args.types,
          missing: args.missing,
        })
        return {
          path: result.path,
          cases: result.caseCount,
          variables: result.variables.map((variable) => ({
            name: variable.name,
            label: variable.label,
            type: variable.type,
            measure: variable.measure,
            valueLabels: variable.valueLabels,
          })),
          // Renamed column headings (non-ASCII, longer than 64 characters or
          // duplicated) are reported so the caller knows the original heading
          // now lives in the variable label.
          ...(result.notes?.length ? { renamed: result.notes } : {}),
        }
      },
    }),

    tool({
      name: 'pspp_new',
      description: 'Create a new dataset from scratch (replacing whatever is open) by defining its variables and, optionally, its cases. Use it when there is no data file yet: build the table here, then pspp_run / pspp_analyze it, then pspp_save it. A variable is {name, label?, type: "numeric"|"string", width?, decimals?, measure?: "nominal"|"ordinal"|"scale"}. A case is either an object keyed by variable name or a positional array; empty values become system-missing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Dataset name shown in the panel; does not write a file.' },
          variables: {
            type: 'array',
            description: 'Variable definitions, in column order.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', enum: ['numeric', 'string'] },
                width: { type: 'integer' },
                decimals: { type: 'integer' },
                measure: { type: 'string', enum: ['nominal', 'ordinal', 'scale'] },
              },
              required: ['name'],
            },
          },
          rows: { type: 'array', description: 'Cases: objects keyed by variable name, or positional arrays.', items: {} },
          path: { type: 'string', description: 'Optional .sav path to write immediately.' },
        },
        required: ['variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const variables = Array.isArray(args.variables) ? args.variables : []
        if (variables.length === 0) throw new Error('至少需要一个变量定义')
        await workspace.createDataset({ name: args.name, variables, rows: args.rows ?? [] })
        const saved = args.path ? await workspace.save(args.path) : null
        return {
          path: saved?.path ?? null,
          cases: workspace.state().dataset?.caseCount ?? 0,
          variables: workspace.dataset.variables.map((variable) => ({
            name: variable.name,
            type: variable.type,
            format: variable.format,
            label: variable.label,
            measure: variable.measure,
            role: variable.role,
          })),
        }
      },
    }),

    tool({
      name: 'pspp_add_variable',
      description: 'Add one variable (column) to the open dataset. The column is appended on the right and existing cases get system-missing values in it. Use pspp_transform / pspp_run afterwards to fill it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Variable name; sanitised and de-duplicated automatically.' },
          label: { type: 'string' },
          type: { type: 'string', enum: ['numeric', 'string'], description: 'Defaults to numeric.' },
          width: { type: 'integer', description: 'Display width; defaults to 8.' },
          decimals: { type: 'integer', description: 'Decimal places for numeric variables; defaults to 2.' },
          measure: { type: 'string', enum: ['nominal', 'ordinal', 'scale'] },
        },
        required: ['name'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('没有打开数据集；先用 pspp_open 或 pspp_new')
        const variable = workspace.addVariable(args)
        await workspace.workSav()
        return {
          variable: {
            name: variable.name,
            type: variable.type,
            format: variable.format,
            label: variable.label,
            measure: variable.measure,
            role: variable.role,
            alignment: variable.alignment,
          },
          variables: workspace.dataset.variables.map((entry) => entry.name),
          cases: workspace.dataset.rows.length,
        }
      },
    }),

    tool({
      name: 'pspp_append_cases',
      description: 'Append cases (rows) to the open dataset. Each case is an object keyed by variable name or a positional array in column order; a value that does not parse as a number for a numeric variable becomes system-missing. All cases are added as one undo step.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cases: { type: 'array', description: 'Cases to append.', items: {} },
        },
        required: ['cases'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('没有打开数据集；先用 pspp_open 或 pspp_new')
        const result = workspace.appendCases(args.cases)
        await workspace.workSav()
        return { added: result.added, cases: result.cases }
      },
    }),

    tool({
      name: 'pspp_variables',
      description: 'List the variables of the open dataset: name, label, type, format, measurement level, value labels and missing values.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        return {
          path: workspace.dataset.sourcePath,
          cases: workspace.dataset.rows.length,
          variables: workspace.dataset.variables,
        }
      },
    }),

    tool({
      name: 'pspp_data',
      description: 'Read a page of cases from the open dataset, plus a variable summary. Use it to inspect values, missing data and outliers before analysing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          offset: { type: 'integer', description: 'Zero-based first case; defaults to 0.' },
          limit: { type: 'integer', description: 'Number of cases to return; defaults to 50, max 2000.' },
          variables: { type: 'array', items: { type: 'string' }, description: 'Optional subset of variable names.' },
        },
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const page = workspace.page(args.offset ?? 0, args.limit ?? 50, args.variables)
        return {
          total: page.total,
          columns: page.columns ?? page.variables.map((variable) => variable.name),
          rows: page.rows,
        }
      },
    }),

    tool({
      name: 'pspp_run',
      description: 'Run arbitrary PSPP syntax against the open dataset and return structured output (tables as matrices, charts as files) plus diagnostics. Use persist=true only when the syntax changes the data (COMPUTE, RECODE, SORT, AGGREGATE, SELECT IF, ...); analysis commands leave the dataset untouched.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          syntax: { type: 'string', description: 'PSPP syntax; commands end with a period.' },
          persist: { type: 'boolean', description: 'Save data changes back to the dataset; defaults to false.' },
        },
        required: ['syntax'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const result = await workspace.runSyntax(args.syntax, { persist: args.persist === true })
        return {
          runId: result.runId,
          cases: result.caseCount,
          tables: itemsForAgent(workspace, result.items.filter((item) => item.kind === 'table')),
          charts: itemsForAgent(workspace, result.items.filter((item) => item.kind === 'image')),
          diagnostics: result.diagnostics,
          log: result.log,
        }
      },
    }),

    tool({
      name: 'pspp_run_file',
      description: 'Run a syntax file (.sps) against the open dataset. Same result shape as pspp_run, but the syntax comes from a file on disk instead of the argument, which is what teaching material, saved syntax and lab hand-outs look like. The encoding is detected: UTF-8 first, then GBK/cp936 (old Windows material), and can be forced with encoding. Use persist=true only when the file changes the data.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/path, or path relative to the session working directory; .sps expected.' },
          persist: { type: 'boolean', description: 'Save data changes back to the dataset; defaults to false.' },
          encoding: { type: 'string', description: 'Force the file encoding: auto (default), utf-8 or gbk.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const target = workspace.resolvePath(args.path)
        if (extname(target).toLowerCase() !== '.sps') {
          throw new Error('语法文件需要 .sps 扩展名')
        }
        // .sps files from teaching material are often GBK (cp936): two-byte
        // sequences that are still "valid UTF-8" byte runs in some cases, so a
        // silent wrong decode would drop Chinese labels without any error. Decode
        // strictly and fall back only when UTF-8 actually fails.
        const bytes = await readFile(target)
        const text = stripBom(decodeSyntax(bytes, args.encoding))
        if (text.trim() === '') throw new Error(`语法文件是空的：${target}`)
        const result = await workspace.runSyntax(text, { persist: args.persist === true })
        return {
          path: target,
          runId: result.runId,
          cases: result.caseCount,
          tables: itemsForAgent(workspace, result.items.filter((item) => item.kind === 'table')),
          charts: itemsForAgent(workspace, result.items.filter((item) => item.kind === 'image')),
          diagnostics: result.diagnostics,
          log: result.log,
        }
      },
    }),

    tool({
      name: 'pspp_convert',
      description: 'Convert a data file between formats with the engine\'s own pspp-convert: .sav -> .por/.sys/.csv/.txt, .por -> .sav/.csv, .sps (encrypted syntax) -> .sps. The destination format follows the extension. The source must already be an SPSS data file (.sav/.por/.sys): pspp-convert cannot read CSV or Excel, so import those with pspp_open and then convert. It does not touch the open dataset.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Destination path; the extension picks the format (.sav/.por/.sys/.csv/.txt).' },
          source: { type: 'string', description: 'SPSS data file to convert (.sav/.por/.sys); defaults to a temporary copy of the open dataset.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        return workspace.convert(args.path, { path: args.source })
      },
    }),

    tool({
      name: 'pspp_analyze',
      description: 'Run one common analysis without writing syntax. Procedures: frequencies, descriptives, crosstabs, ttest_independent, ttest_paired, ttest_one_sample, oneway, glm, correlation, regression, logistic, factor, reliability, npar (chi-square), npar_binomial, npar_ks, npar_runs, npar_wilcoxon, npar_sign, npar_mannwhitney, npar_kruskal, npar_median, npar_jonckheere, npar_friedman, npar_mcnemar, npar_cochran, npar_kendall, examine, means, ctables, roc, cluster, mva (missing value analysis: per-variable counts and the missing-data patterns; computed inside the plugin because PSPP has no MVA). Returns the resulting tables as matrices. For regression, pass plots: ["residual","pp"] to have the plugin draw the residual scatter and the normal P-P plot from the same fit (PSPP prints no regression plots).',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          procedure: { type: 'string', description: 'Procedure name listed in the description.' },
          testValue: { type: 'number', description: 'Test value for ttest_one_sample (default 0).' },
          variables: { type: 'array', items: { type: 'string' }, description: 'Variables to analyse.' },
          by: { type: 'string', description: 'Grouping / factor variable where the procedure needs one.' },
          factors: { type: 'array', items: { type: 'string' }, description: 'For glm: two or more factors, e.g. ["trt","block"] for a randomized block design. Defaults to [by].' },
          covariates: { type: 'array', items: { type: 'string' }, description: 'Not supported: PSPP 2.1.3 GLM rejects a WITH clause, so glm refuses covariates with an explanation.' },
          design: { type: 'string', description: 'For glm: explicit /DESIGN term list, e.g. "trt block" or "trt block trt*block". Defaults to the factors joined, i.e. main effects only.' },
          postHoc: { type: 'array', items: { type: 'string', enum: ['LSD', 'BONFERRONI', 'SIDAK', 'TUKEY', 'SCHEFFE'] }, description: 'Post-hoc pairwise comparisons for oneway (PSPP supports LSD, Bonferroni, Sidak, Tukey, Scheffe).' },
          homogeneity: { type: 'boolean', description: 'For oneway: add the Levene test of homogeneity of variances (default true).' },
          row: { type: 'string', description: 'Row variable for crosstabs / ctables.' },
          column: { type: 'string', description: 'Column variable for crosstabs / ctables.' },
          layer: { type: 'string', description: 'For crosstabs: a third variable that splits the table into layers (SPSS "Layer 1 of 1"), e.g. crosstabs row=a column=b layer=c.' },
          dependent: { type: 'string', description: 'Dependent variable for regression / logistic.' },
          independents: { type: 'array', items: { type: 'string' }, description: 'Predictors for regression / logistic.' },
          groupValues: { type: 'array', items: { type: 'string' }, description: 'The two group codes for ttest_independent.' },
          statistics: { description: 'Statistic list, depends on the procedure: for regression raw /STATISTICS keywords (COEFF, R, ANOVA, BCOV, CI, TOL; omit for COEFF R ANOVA CI — TOL is not requested by default because it makes the engine crash one run in six, tolerance/VIF are computed by the plugin and returned as their own table); for crosstabs e.g. ["CHISQ","PHI","CC","LAMBDA","GAMMA","KAPPA","RISK","ETA"] (omit for CHISQ PHI, false for none); descriptives e.g. ["MEAN","STDDEV","SKEWNESS","SESKEW","KURTOSIS","SEKURT","MEDIAN","MODE","SEMEAN","VARIANCE","RANGE","SUM"]; other procedures use their own names from the PSPP manual.' },
          cells: { type: 'array', items: { type: 'string' }, description: 'Crosstabs cell contents: COUNT, ROW, COLUMN, TOTAL, EXPECTED, RESID, SRESID, ASRESID.' },
          kappa: { type: 'boolean', description: 'For crosstabs: ask for Kappa (agreement between two ratings). Kappa only exists for a square table (2×2 or the same categories on both sides), so a rectangular table still returns a Symmetric Measures table with just the case count — that is the engine being correct, not a bug. Asking for it also adds CHISQ, because Cramér\'s V and the small-sample Fisher pointer are written on the Chi-Square Tests table.' },
          percentiles: { type: 'array', items: { type: 'number' }, description: 'For descriptives: percentiles to report, e.g. [25, 50, 75]. Asking for any makes the request run through FREQUENCIES, which also adds the median.' },
          chart: { type: 'string', enum: ['bar', 'pie', 'histogram', 'histogramNormal'], description: 'For frequencies: also draw a chart. bar is the frequency bar chart, pie the share pie, histogram the distribution, histogramNormal the histogram with a normal curve over it. The picture comes from the engine and lands in the output as an image item.' },
          save: { type: 'array', items: { type: 'string' }, description: 'For regression: values to add to the dataset — PRED, RESID, ZPRED, ZRESID, SRESID, SEPRED, SDRESID, COOK, LEVER. They are written back, so the variables list grows.' },
          rotation: { type: 'string', enum: ['VARIMAX', 'EQUAMAX', 'QUARTIMAX', 'PROMAX', 'NONE'], description: 'Factor rotation: VARIMAX (default), EQUAMAX, QUARTIMAX, PROMAX, or NONE (PSPP calls it NOROTATE).' },
          confidence: { type: 'boolean', description: 'For regression: include the 95% confidence interval for B (default true).' },
          collinearity: { type: 'boolean', description: 'For regression: include a tolerance/VIF table (default true, computed by the plugin). Pass statistics:["TOL"] only if you really want the engine to print it — that path can crash.' },
          clusters: { type: 'integer', description: 'Cluster count for cluster.' },
          value: { type: 'integer', description: 'Outcome value for roc.' },
          exactChi: { type: 'boolean', description: 'For crosstabs: add exact p-values for Pearson chi-square and the likelihood-ratio statistic, computed by enumerating the tables with the same margins (Monte Carlo with a fixed seed when there are too many).' },
          exact: { type: 'boolean', description: 'For crosstabs: add an exact test of the table (Fisher-Freeman-Halton). PSPP only prints Fisher for 2x2 and rejects METHOD=EXACT, so the plugin enumerates the tables with the same margins and reports the two-sided p as a table note; tables too large to enumerate are sampled (Monte Carlo, fixed seed).' },
        },
        required: ['procedure'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const columnName = args.column ?? args.columns ?? null
        const columnVar = columnName ? workspace.dataset.variables.find((v) => v.name === columnName) : null
        const groupName = args.by ?? args.group ?? null
        const groupVar = groupName ? workspace.dataset.variables.find((v) => v.name === groupName) : null
        // Missing value analysis has no syntax at all: PSPP refuses MVA, so the
        // tables come from the plugin. It still returns tables like every other
        // procedure, so callers do not need a second tool.
        if (/^mva$/i.test(String(args.procedure))) {
          const analysed = workspace.missingAnalysis({
            variables: args.variables,
            univariate: args.univariate,
            patterns: args.patterns,
          })
          const items = (workspace.items ?? []).filter((item) => item.runId === analysed.runId)
          return {
            procedure: 'mva',
            syntax: null,
            cases: analysed.cases,
            variables: analysed.variables,
            tables: itemsForAgent(workspace, items.filter((item) => item.kind === 'table')),
            charts: [],
            diagnostics: [],
            note: 'computed inside the plugin: PSPP 2.1.3 has no MVA',
          }
        }
        const syntax = buildAnalysis(args.procedure, {
          ...args,
          columnMeasure: columnVar?.measure ?? null,
          groupString: groupVar ? groupVar.type === 'string' : false,
        })
        // The same hint the panel sends: a t-test / ANOVA / GLM run from the
        // agent should offer the pairwise table on its output too.
        const pairwise = ['ttest_independent', 'oneway', 'glm'].includes(args.procedure)
          && args.by
          && Array.isArray(args.variables) && args.variables.length > 0
          ? { group: args.by, variables: args.variables }
          : null
        // REGRESSION /SAVE adds columns, so that one run has to be written back.
        const extras = analysisExtras(args.procedure, args)
        // Regression plots are drawn from the same fit as the tables, after they
        // succeed: a failed run must not leave a picture of nothing behind.
        // Exact tests are computed after the run, from the table the engine
        // printed: PSPP rejects METHOD=EXACT and only handles 2x2 itself.
        const exact = args.exact === true && /^crosstabs$/i.test(String(args.procedure))
        const exactChi = args.exactChi === true && /^crosstabs$/i.test(String(args.procedure))
        const result = await workspace.runSyntax(syntax, { persist: Boolean(args.save), pairwise, exact, exactChi, ...extras })
        const drawn = []
        for (const plot of extras.plots ?? []) {
          try {
            const made = await workspace.addRegressionPlot(plot, { regression: extras.regression })
            drawn.push({ kind: plot, runId: made.runId, itemId: made.item.id, url: made.item.artifactUrl ?? null })
          } catch (error) {
            drawn.push({ kind: plot, error: error.message })
          }
        }
        return {
          procedure: args.procedure,
          syntax,
          tables: itemsForAgent(workspace, result.items.filter((item) => item.kind === 'table')),
          charts: itemsForAgent(workspace, result.items.filter((item) => item.kind === 'image')),
          ...(drawn.length > 0 ? { plots: drawn } : {}),
          diagnostics: result.diagnostics,
        }
      },
    }),

    tool({
      name: 'pspp_transform',
      description: 'Apply a data transformation and keep it in the dataset. Operations: compute, recode, sort, aggregate, select, filter, weight, split, rename, delete, sample, count, rank, transpose (FLIP: rows become columns, the old variable names land in CASE_LBL; pass newNames to take the names from a variable instead), casesToVars (pivot once-case-per-index into one-case-per-identifier), varsToCases (stack several wide columns into long form). The last two are computed inside the plugin because PSPP has neither CASESTOVARS nor VARSTOCASES; they return counts instead of syntax. replaceMissing fills blanks and declared missing codes with the series mean (mean), a linear interpolation between neighbours (linear), the nearest present value (nearby), the mean or median of the nearest points (nearbyMean / nearbyMedian) or the least-squares trend at that case (trend) — PSPP has no RMV, so it is computed inside the plugin. identifyDuplicates groups rows by the key variables and reports the repeated groups, optionally adding dupSeq/dupLast; identifyOutliers flags the cases whose values fall outside a percentile band (default 5%–95%), optionally adding outlier/outlierN. Neither has any PSPP syntax, so both return counts instead of a program. Every operation persists; check the returned syntax to confirm what ran.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          operation: { type: 'string', description: 'Operation name.' },
          variables: { type: 'array', items: { type: 'string' }, description: 'Input variables.' },
          target: { type: 'string', description: 'Output variable name.' },
          variable: { type: 'string', description: 'Single input variable.' },
          expression: { type: 'string', description: 'Arithmetic or logical expression for compute / select.' },
          mapping: { type: 'string', description: 'Recode mapping, e.g. "(1 THRU 3=1) (ELSE=2)".' },
          function: { type: 'string', description: 'Aggregate function, e.g. MEAN / SUM / MAX.' },
          break: { type: 'array', items: { type: 'string' }, description: 'Break variables for aggregate / split.' },
          from: { type: 'string', description: 'Old variable name for rename.' },
          to: { type: 'string', description: 'New variable name for rename.' },
          order: { type: 'string', description: 'A or D for sort.' },
          off: { type: 'boolean', description: 'Turn weight/filter/split off.' },
          id: { type: 'array', items: { type: 'string' }, description: 'Identifier variables to keep one row per combination (casesToVars / varsToCases).' },
          index: { type: 'string', description: 'casesToVars: variable whose values become the new columns.' },
          indexName: { type: 'string', description: 'varsToCases: name of the column that records which variable each row came from (default index).' },
          indexValues: { type: 'string', enum: ['names', 'numbers'], description: 'varsToCases: index cell holds the original variable name (names) or its 1-based position (numbers).' },
          targetName: { type: 'string', description: 'varsToCases: name of the stacked value column (default value).' },
          method: { type: 'string', enum: ['mean', 'linear', 'nearby', 'nearbyMean', 'nearbyMedian', 'trend'], description: 'replaceMissing: series mean (mean, the default), linear interpolation (linear), the nearest present value (nearby), the mean or median of the nearest points (nearbyMean / nearbyMedian), or the least-squares trend at that case (trend).' },
          span: { type: 'integer', description: 'replaceMissing with nearbyMean / nearbyMedian: how many present points on each side take part (default 2).' },
          rankTypes: { type: 'array', items: { type: 'string' }, description: 'rank: any of rank, n, percent, proportion, rfraction, normal, savage (default rank).' },
          indicators: { type: 'boolean', description: 'identifyDuplicates / identifyOutliers: also create the two indicator variables (dupSeq and dupLast, or outlier and outlierN).' },
          percentiles: { type: 'array', items: { type: 'number' }, description: 'identifyOutliers: the band to call unusual, e.g. [5, 95] (the default). Values outside the low and high percentile are flagged.' },
          ntiles: { type: 'integer', description: 'rank: split the distribution into this many quantile groups (2 or more).' },
        },
        required: ['operation'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const pivot = String(args.operation ?? '').toLowerCase().replaceAll(/[^a-z]/g, '')
        if (pivot === 'identifyduplicates' || pivot === 'duplicates') {
          const result = workspace.identifyDuplicates({
            variables: args.variables ?? args.keys,
            indicators: args.indicators === true,
          })
          return {
            operation: 'identifyDuplicates',
            syntax: null,
            groups: result.groups,
            duplicates: result.duplicates,
            created: result.created,
            cases: result.cases,
            note: 'computed inside the plugin: PSPP 2.1.3 has no duplicate-case command',
          }
        }
        if (pivot === 'identifyoutliers' || pivot === 'outliers' || pivot === 'unusualcases') {
          const result = workspace.identifyOutliers({
            variables: args.variables,
            percentiles: args.percentiles,
            indicators: args.indicators === true,
          })
          return {
            operation: 'identifyOutliers',
            syntax: null,
            variables: result.variables,
            flagged: result.flagged,
            hits: result.hits,
            band: `${result.lowPercent}%–${result.highPercent}%`,
            created: result.created,
            cases: result.cases,
            note: 'computed inside the plugin: PSPP 2.1.3 has no unusual-case command',
          }
        }
        if (pivot === 'casestovars' || pivot === 'varstocases') {
          const reshaped = pivot === 'casestovars'
            ? workspace.restructureCasesToVars({ id: args.id, index: args.index, variables: args.variables })
            : workspace.restructureVarsToCases({
              variables: args.variables,
              id: args.id,
              target: args.targetName ?? args.target,
              indexName: args.indexName,
              indexValues: args.indexValues,
            })
          return {
            operation: pivot === 'casestovars' ? 'casesToVars' : 'varsToCases',
            syntax: null,
            cases: reshaped.cases,
            variables: reshaped.variables,
            created: reshaped.created,
            duplicates: reshaped.duplicates ?? 0,
            note: 'computed inside the plugin: PSPP 2.1.3 has no CASESTOVARS / VARSTOCASES',
          }
        }
        if (pivot === 'replacemissing' || pivot === 'rmv') {
          const filled = workspace.replaceMissingValues({
            variables: args.variables,
            method: args.method ?? args.function,
            span: args.span,
          })
          return {
            operation: 'replaceMissing',
            syntax: null,
            method: filled.method,
            filled: filled.filled,
            variables: filled.variables,
            cases: filled.cases,
            note: 'computed inside the plugin: PSPP 2.1.3 has no RMV',
          }
        }
        const syntax = buildTransform(args.operation, args)
        const result = await workspace.runSyntax(syntax, { persist: true })
        return {
          operation: args.operation,
          syntax,
          cases: result.caseCount,
          variables: result.variables.map((variable) => variable.name),
          diagnostics: result.diagnostics,
        }
      },
    }),

    tool({
      name: 'pspp_chart',
      description: 'Draw a chart from the open dataset: bar (mean/sum/count of a variable, optionally by a category, optionally clustered or stacked by a second variable, optionally with standard-deviation error bars), histogram, boxplot (five-number summary, optionally by a category), line (means per category, optionally one line per value of a second variable), pie (category shares, optionally as a ring), area (stacked cumulative trend, optionally split by a second variable), or scatterplot (optionally with a linear fit line), plus ppplot (P-P / Q-Q against the normal distribution, computed inside the plugin because PSPP prints no such figure) pareto (categories counted and sorted from most to least, with the cumulative share as a line and a reference line at 80% by default) control (an X̄–R control chart: subgroup means and ranges with centre and ±3σ limits from the average range, out-of-control points flagged) or km (a Kaplan–Meier survival curve with censor marks, median survival and a log-rank test when grouping — computed inside the plugin because PSPP 2.1.3 has no survival procedure at all). Returns the chart file and its URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', description: 'bar, histogram, scatterplot, boxplot, line, pie, area, pareto (sorted bars with a cumulative line), control (X̄–R control chart), km (Kaplan–Meier survival curve) or ppplot (P-P / Q-Q against the normal distribution).' },
          variable: { type: 'string', description: 'Variable for bar / histogram / boxplot / line / pie.' },
          reference: { type: 'number', description: 'pareto: where the dashed reference line sits, as a cumulative percentage (default 80).' },
          maxCategories: { type: 'integer', description: 'pareto: draw at most this many categories and fold the rest into one bar labelled 其他; 0 or omitted draws every category.' },
          subgroup: { type: 'string', description: 'control: the variable whose values define the subgroups; omit to split the cases in order into groups of `size`.' },
          time: { type: 'string', description: 'km: the follow-up time variable (numeric, non-negative).' },
          event: { type: 'string', description: 'km: the event indicator (numeric; 1 = the event happened, anything else = censored).' },
          size: { type: 'integer', description: 'control: cases per subgroup when no subgroup variable is given (2–10, default 5).' },
          plot: { type: 'string', enum: ['pp', 'qq'], description: 'ppplot: pp draws observed against expected cumulative probability, qq draws observed values against expected normal quantiles (default pp).' },
          by: { type: 'string', description: 'Category variable for bar / boxplot / line.' },
          statistic: { type: 'string', description: 'MEAN, SUM, COUNT for bar. A text variable can only be COUNTed (its bar height is the number of cases).' },
          percent: { type: 'boolean', description: 'bar of a text variable: draw each category as its share of the valid cases (percentages) instead of raw counts.' },
          x: { type: 'string', description: 'X variable for scatterplot.' },
          y: { type: 'string', description: 'Y variable for scatterplot.' },
          group: { type: 'string', description: 'scatterplot: colour the points by this variable categories (a legend is drawn); km: draw and test one curve per value (the log-rank test compares them).' },
          fit: { type: 'string', enum: ['linear'], description: 'scatterplot: draw a least-squares line (one per series when group is set) and label it with R².' },
          title: { type: 'string', description: 'Chart title (overrides the generated one).' },
          subtitle: { type: 'string', description: 'Second line under the title: the statistic, the N, or the filter applied. An empty string removes it.' },
          xLabel: { type: 'string', description: 'X axis label.' },
          yLabel: { type: 'string', description: 'Y axis label.' },
          accent: { type: 'string', description: 'Main colour as #rrggbb (bars, line, points, boxes).' },
          sortCategories: { type: 'string', enum: ['none', 'asc', 'desc'], description: 'Order categories by value.' },
          cluster: { type: 'string', description: 'bar: second category variable drawn as side-by-side bars; line: split the trend into one line per value.' },
          stack: { type: 'string', description: 'bar: second category variable whose values stack inside each bar.' },
          y2: { type: 'string', description: 'line: a second numeric variable drawn against a right-hand axis, for "two series, two scales" figures.' },
          significance: { type: 'string', enum: ['auto'], description: 'bar: bracket every pair of categories and label it with Welch t-test asterisks (*** p<.001, ** p<.01, * p<.05, ns). Only for simple mean bars.' },
          errorBars: { type: 'string', enum: ['sd', 'se', 'ci95'], description: 'bar or line: whiskers at ±1 standard deviation (sd), ±1 standard error (se) or the 95% confidence interval of the mean (ci95). Needs at least two cases per point; true is accepted as sd.' },
          donut: { type: 'boolean', description: 'pie: draw a ring instead of a solid disc, with the share printed inside each slice.' },
          shape: { type: 'string', enum: ['stacked', 'stacked100'], description: 'bar with stack: raw totals, or shares of 100% per bar.' },
          tableId: { type: 'string', description: 'Output table this chart belongs to (a table id from a previous run). The Word/Excel export embeds the image inside that table; without it the exporter pairs the picture by source run.' },
          redrawOf: { type: 'integer', description: 'Run id of an existing chart: draw the same data again as `type` instead of a new chart. The old chart stays in the output.' },
          grid: { type: 'object', additionalProperties: false, description: 'Bind existing charts into one picture instead of drawing a new one (type is then ignored).', properties: {
            items: { type: 'array', items: { type: 'string' }, description: 'Chart item ids, in cell order (as the panel ticked them).' },
            layout: { type: 'string', enum: ['2x2', '1x2', '2x1'], description: '2x2 holds four, 1x2 and 2x1 hold two.' },
          }, required: ['items'] },
        },
        required: ['type'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (args.redrawOf !== undefined && args.redrawOf !== null) {
          const again = await workspace.redrawChart(args.redrawOf, args.type)
          return {
            kind: 'redraw',
            chart: again.chart,
            runId: again.runId,
            itemId: again.item.id,
            redrawnFrom: again.redrawnFrom,
            url: again.item.artifactUrl ?? null,
          }
        }
        if (args.grid) {
          // A grid binds what is already in the output tree; it does not need a
          // dataset of its own, only the charts.
          const bound = await workspace.addChartGrid(args.grid.items ?? [], args.grid.layout ?? '2x2')
          return {
            kind: 'grid',
            runId: bound.runId,
            itemId: bound.item.id,
            title: bound.item.title,
            charts: bound.charts,
            layout: bound.layout,
            url: bound.item.artifactUrl ?? null,
          }
        }
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        // Charts are computed from the in-memory dataset and rendered as SVG,
        // so the panel shows the same crisp figure the agent gets back.
        const result = await workspace.addChart(args.type, args)
        return {
          chart: result.chart,
          // pspp_export_chart takes either of these; without them the agent has
          // a figure it cannot write to disk.
          runId: result.runId,
          url: result.item.artifactUrl ?? null,
          svgPath: result.svgPath,
          charts: itemsForAgent(workspace, [result.item]),
        }
      },
    }),

    tool({
      name: 'pspp_publication_table',
      description: 'Build a journal-ready table straight from the loaded dataset. kind "baseline" makes 表 1: one row per variable (continuous = mean±SD or median(IQR), categorical = n(%) per level), one column per group plus overall, and a P column from Welch t (two groups), one-way ANOVA (three or more) or Pearson chi-square. kind "compare" makes 表 2: the same grid without the overall column. Returns the matrix, which also appears in the panel output.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['baseline', 'compare'], description: 'baseline = 表 1 with an overall column; compare = 表 2 without it.' },
          group: { type: 'string', description: 'The grouping variable (分组变量).' },
          variables: { type: 'array', items: { type: 'string' }, description: 'Variables to tabulate; omit to use every variable except the group.' },
          continuous: { type: 'string', enum: ['mean', 'median'], description: 'How numeric rows are summarised: mean±SD (default) or median (IQR).' },
        },
        required: ['group'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.publicationTable(args.kind ?? 'baseline', args)
        return {
          kind: args.kind ?? 'baseline',
          title: result.item.title,
          matrix: result.matrix,
          notes: result.notes,
          runId: null,
        }
      },
    }),

    tool({
      name: 'pspp_pairwise',
      description: 'Pairwise comparison table for every pair of groups of a categorical variable: mean difference, standard error, Welch t, raw P, and Bonferroni adjusted P with asterisks (*** <0.001, ** <0.01, * <0.05, ns). Bonferroni is applied by default — the asterisks follow the adjusted P, so a table copied into a paper is already corrected; pass adjust:"none" only when you deliberately want the raw P. Welch t does not assume equal variances, so it holds up when the group sizes differ. Use it when a paper needs the pairwise P values behind an overall group difference. The rows layout also returns a homogeneous-subsets table (compact letter display): groups that share a letter are not significantly different at α = 0.05 under the adjusted P, letters are handed out from the largest mean down, and a group with two letters (ab) sits between both sides.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', description: 'The grouping variable (分组变量).' },
          variables: { type: 'array', items: { type: 'string' }, description: 'Numeric variables to compare; omit for every numeric variable except the group.' },
          adjust: { type: 'string', enum: ['none', 'bonferroni'], description: 'Default bonferroni: each P is multiplied by the number of pairs of that variable, and the asterisks follow the adjusted P. "none" keeps the raw P.' },
          layout: { type: 'string', enum: ['rows', 'matrix'], description: "rows (default) gives one row per pair with the difference, SE, t, df, 95% CI and Cohen's d; matrix gives a compact variables × pairs grid with stars — the form a multi-group paper prints." },
        },
        required: ['group'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.pairwiseTable(args)
        return {
          title: result.item.title,
          matrix: result.matrix,
          notes: result.notes,
          ...(result.letters ? { homogeneousSubsets: result.letters } : {}),
        }
      },
    }),

    tool({
      name: 'pspp_partial',
      description: 'Partial correlation table: for every pair of the analysis variables, correlate them after removing the linear effect of the control variables (residual method, so it works with any number of controls). PSPP itself has no PARTIAL CORR, which is why this runs in the plugin. Prints r, df, P, the number of complete cases and significance stars; missing values are deleted listwise over the analysis and control variables.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: { type: 'array', items: { type: 'string' }, description: 'Two or more numeric variables; every pair among them gets one row.' },
          controls: { type: 'array', items: { type: 'string' }, description: 'Numeric control variables whose effect is removed. Omit for plain Pearson correlations.' },
          layout: { type: 'string', enum: ['rows', 'matrix'], description: "rows (default) gives one row per variable pair with r, df, P, N and stars; matrix gives a variables × variables grid of starred r — the shape a paper prints when several variables share one control set." },
        },
        required: ['variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.partialTable(args)
        return {
          title: result.item.title,
          matrix: result.matrix,
          notes: result.notes,
        }
      },
    }),

    tool({
      name: 'pspp_cluster',
      description: 'Hierarchical clustering (系统聚类 / 层次聚类) of cases on numeric variables: the agglomeration schedule (stage, the two combined groups, the merge coefficient, when each group first appeared, and the next stage it is merged at), the cluster membership for the requested number of clusters, and the group sizes. PSPP 2.1.3 only ships k-means (QUICK CLUSTER), so the tree is built inside the plugin with the Lance–Williams recurrence. Linkage: average (组间平均连接, default), complete (最长连接), single (最短距离), ward (Ward 法, requires measure:"sqeuclidean"). Cases with a missing value are dropped whole; a text variable is refused by name.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: { type: 'array', items: { type: 'string' }, description: 'Numeric variables to cluster on.' },
          clusters: { type: 'integer', description: 'How many groups the membership table should show (default 3).' },
          linkage: { type: 'string', enum: ['average', 'complete', 'single', 'ward'], description: 'average (default), complete, single, or ward.' },
          measure: { type: 'string', enum: ['euclidean', 'sqeuclidean', 'cityblock', 'chebychev'], description: 'Distance measure; ward requires sqeuclidean.' },
          chart: { type: 'boolean', description: 'Also draw the dendrogram (树状图).' },
        },
        required: ['variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.clusterTable({
          variables: args.variables,
          clusters: args.clusters,
          linkage: args.linkage,
          measure: args.measure,
        })
        const out = {
          title: result.items?.[0]?.title ?? '系统聚类分析',
          matrix: result.matrix,
          notes: result.notes,
          model: { ...result.model, merges: result.model?.merges },
          tables: result.items.map((item) => ({ title: item.title, matrix: item.table.matrix })),
        }
        if (args.chart) {
          const drawn = await workspace.addChart('dendrogram', {
            variables: args.variables,
            clusters: args.clusters,
            linkage: args.linkage,
            measure: args.measure,
          })
          out.chart = { title: drawn.chart.title, sourceRunId: drawn.sourceRunId }
        }
        return out
      },
    }),

    tool({
      name: 'pspp_timeseries',
      description: 'Time-series smoothing of one numeric variable in case order: simple moving average (移动平均), simple exponential smoothing (简单指数平滑) or double exponential smoothing / Holt (双指数平滑). Returns a model summary (MAE, RMSE, MAPE and the parameters), the series table (case, actual, fitted, residual, plus the requested forecasts) and, with chart:true, a line chart of the observed series against the fit. PSPP 2.1.3 answers "TSLINE: Unknown command" and has no exponential smoothing, so the fit is computed inside the plugin. Each fitted value is the one-step-ahead forecast from the cases before it, so the first periods have no fitted value, and the residuals are comparable across methods.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variable: { type: 'string', description: 'The numeric series variable (数值变量).' },
          method: { type: 'string', enum: ['ma', 'ses', 'des'], description: 'ma = moving average, ses = simple exponential smoothing (default), des = Holt double smoothing.' },
          span: { type: 'integer', description: 'Moving-average period count (default 4, at least 1, at most n-1).' },
          alpha: { type: 'number', description: 'Smoothing coefficient, strictly between 0 and 1 (default 0.3).' },
          beta: { type: 'number', description: 'Trend coefficient for des, between 0 and 1 (default 0.2).' },
          periods: { type: 'integer', description: 'How many periods to forecast past the last case (default 0, at most 60).' },
          chart: { type: 'boolean', description: 'Also draw the series chart.' },
        },
        required: ['variable'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const options = {
          variable: args.variable,
          method: args.method,
          span: args.span,
          alpha: args.alpha,
          beta: args.beta,
          periods: args.periods,
        }
        const result = await workspace.timeseriesTable(options)
        const out = {
          title: result.items?.[0]?.title ?? '时间序列',
          matrix: result.matrix,
          notes: result.notes,
          model: result.model,
          tables: result.items.map((item) => ({ title: item.title, matrix: item.table.matrix })),
        }
        if (args.chart) {
          const drawn = await workspace.addChart('timeseries', options)
          out.chart = { title: drawn.chart.title, sourceRunId: drawn.sourceRunId }
        }
        return out
      },
    }),

    tool({
      name: 'pspp_discriminant',
      description: 'Discriminant analysis (判别分析) for a categorical grouping variable: Fisher linear discriminant functions, the classification table (actual group × predicted group, with per-group hit rates), the canonical discriminant functions (eigenvalue, variance share, cumulative share, canonical correlation) and the Wilks lambda test. PSPP 2.1.3 reports DISCRIMINANT as not yet implemented, so everything is fitted inside the plugin with the pooled within-group covariance matrix. Predictors must be numeric; cases with a missing value are removed whole. Use priors:"size" to weight the groups by their case counts instead of assuming equal priors.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', description: 'The grouping variable (分组变量); two to twenty groups.' },
          variables: { type: 'array', items: { type: 'string' }, description: 'Numeric discriminant variables (判别变量), one or more.' },
          priors: { type: 'string', enum: ['equal', 'size'], description: 'equal (default) treats every group as equally likely; size weights by the observed group sizes.' },
        },
        required: ['group', 'variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.discriminantTable({ group: args.group, variables: args.variables, priors: args.priors })
        return {
          title: result.items?.[0]?.title ?? '判别分析',
          matrix: result.matrix,
          notes: result.notes,
          model: result.model,
          tables: result.items.map((item) => ({ title: item.title, matrix: item.table.matrix })),
        }
      },
    }),

    tool({
      name: 'pspp_cox',
      description: 'Cox proportional-hazards regression for survival data: one row per covariate with B, standard error, Wald chi-square, P, Exp(B) and the 95% confidence interval of Exp(B), plus the -2 log likelihood, the likelihood-ratio, score and Wald tests, and the number of cases and events. PSPP 2.1.3 reports COXREG as not yet implemented, so the partial likelihood is maximised inside the plugin (Newton–Raphson, Breslow handling of tied event times). Only numeric covariates are accepted: recode a categorical variable into dummy variables first. Pass strata to give every level of that variable its own risk set and baseline hazard while B stays shared across strata (SPSS COXREG /STRATA), which also returns a by-strata case table. Pass start to fit a time-dependent covariate instead: every row is then the interval (start, stop] and the risk set at a time holds the rows whose interval covers it, so one case may occupy several rows with different covariate values. Cases with a missing value in any of the variables are removed whole.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'string', description: 'The survival time variable (生存时间), a numeric variable whose values are positive.' },
          event: { type: 'string', description: 'The event indicator (事件): 1 means the event happened, 0 means the case was censored.' },
          covariates: { type: 'array', items: { type: 'string' }, description: 'One to ten numeric covariates (协变量). Categorical variables must be recoded into dummies first.' },
          strata: { type: 'string', description: 'Optional stratification variable (分层): every level of it gets its own risk set and baseline hazard while B stays shared across strata, which is how SPSS COXREG /STRATA works.' },
          start: { type: 'string', description: 'Optional interval start (起始时间, 时依协变量): makes every row the interval (start, time]. Rows with start >= time are dropped, and the risk set at a time holds only the rows whose interval covers it.' },
        },
        required: ['time', 'event', 'covariates'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.coxTable({
          time: args.time,
          event: args.event,
          covariates: args.covariates,
          strata: args.strata,
          start: args.start,
        })
        return {
          title: result.item.title,
          matrix: result.matrix,
          notes: result.notes,
          ...(result.strata ? { strata: result.strata, strataVariable: result.model.strataVariable } : {}),
        }
      },
    }),

    tool({
      name: 'pspp_competing',
      description: 'Competing-risks analysis: the cumulative incidence function (CIF) for each event type with Aalen standard errors and 95% confidence intervals, an event count table, and — when a grouping variable is given — a cause-specific log-rank test per event type. The status variable carries 0 for censored cases and 1..k for the event type; other codes can be listed as causes or left out (they are then treated as censored). The CIF is the Aalen–Johansen estimate (each cause weighted by the all-cause Kaplan–Meier), so 1 − Kaplan–Meier would overstate it; the Gray subdistribution test is not implemented, the group test is the cause-specific log-rank. Cases missing the time, the status or the grouping variable are removed whole.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'string', description: 'The follow-up time variable (随访时间), numeric.' },
          status: { type: 'string', description: 'The status variable (状态): 0 means censored, other codes are the event type (原因).' },
          group: { type: 'string', description: 'Optional grouping variable (分组): with two or more groups the result includes a cause-specific log-rank test per event type.' },
          causes: { type: 'array', items: { type: 'number' }, description: 'Optional list of event-type codes to report (at most six). Defaults to every non-zero code found in the data; codes left out are treated as censored.' },
        },
        required: ['time', 'status'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.competingTable({
          time: args.time,
          status: args.status,
          group: args.group,
          causes: args.causes,
        })
        const incidence = result.tables.find((table) => table.caption === '累积发生率')
        return {
          title: result.item.title,
          matrix: result.matrix,
          counts: result.matrix,
          incidence: incidence ? incidence.matrix : [],
          notes: result.notes,
          causes: result.causes,
          cases: result.cases,
          dropped: result.dropped,
          ...(result.logRank.length ? { logRank: result.logRank } : {}),
          chart: result.chart,
        }
      },
    }),

    tool({
      name: 'pspp_survival_means',
      description: 'Mean, median and percentiles of survival time (the "Means and Medians for Survival Time" table of a Kaplan–Meier run). The mean is the RESTRICTED mean: the area under the curve up to the last follow-up time, not the expectation to infinity (the tail has no data). The standard error of that mean uses the Klein–Moeschberger variance; the percentiles are the first event time whose cumulative survival reaches the percentile, and a curve that never gets there is reported as not reached. PSPP 2.1.3 has no survival procedure, so everything is estimated inside the plugin.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'string', description: 'The survival time variable (生存时间), numeric.' },
          event: { type: 'string', description: 'The event indicator (事件): 1 means the event happened, anything else (or 0) means censored.' },
          group: { type: 'string', description: 'Optional grouping variable (分组): one row per group.' },
        },
        required: ['time', 'event'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.survivalMeanTable({
          time: args.time,
          event: args.event,
          group: args.group,
        })
        return {
          title: result.item.title,
          matrix: result.matrix,
          percentiles: result.tables[1].matrix,
          groups: result.groups,
          notes: result.notes,
          ...(result.model.logRank ? { logRank: result.model.logRank } : {}),
        }
      },
    }),

    tool({
      name: 'pspp_lifetable',
      description: 'Actuarial life table (生命表) for survival data: follow-up time is cut into equal-width intervals and each interval reports the number at risk, censored, events, effective sample size (at risk minus half the censored), proportion dying and surviving, cumulative survival with Greenwood standard error, and the hazard rate; a second table gives the median survival time per group. PSPP 2.1.3 has no SURVIVAL command (it answers "not yet implemented"), so the table is computed inside the plugin. This is the actuarial method, not Kaplan–Meier: censoring inside an interval counts as half a case, so a wide interval is less accurate than the event-by-event estimate. A status of 0 means censored, anything else means the event. Cases missing the time, the status or the grouping variable (or with a negative time) are removed whole and counted in the notes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'string', description: 'The follow-up time variable (随访时间), numeric and non-negative.' },
          status: { type: 'string', description: 'The status variable (状态): 0 means censored, anything else means the event.' },
          group: { type: 'string', description: 'Optional grouping variable (分组): the table and the medians get one block per group.' },
          interval: { type: 'number', description: 'Interval width (区间宽度), a positive number. Left out the plugin picks a readable width (about ten intervals).' },
        },
        required: ['time', 'status'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.lifeTable({
          time: args.time,
          status: args.status,
          group: args.group,
          interval: args.interval,
        })
        return {
          title: result.item.title,
          matrix: result.matrix,
          medians: result.medians,
          notes: result.notes,
          interval: result.interval,
          steps: result.steps,
          cases: result.cases,
          dropped: result.dropped,
          ...(result.groups.length ? { groups: result.groups } : {}),
          chart: result.chart,
        }
      },
    }),

    tool({
      name: 'pspp_multinomial',
      description: 'Multinomial logistic regression for a dependent variable with three or more categories: one row per category per term with B, standard error, Wald chi-square, P and Exp(B), plus model fit (likelihood-ratio chi-square, -2 log likelihood), goodness of fit (Pearson and deviance), pseudo R squares, and the observed-by-predicted classification table. PSPP 2.1.3 only fits LOGISTIC REGRESSION with two levels, so the K−1 logits are fitted here by Newton–Raphson; a two-level dependent variable gives exactly the binary logistic coefficients. Only numeric independents are accepted: recode a categorical predictor into dummy variables first. Cases missing any variable are removed whole.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dependent: { type: 'string', description: 'The dependent variable (因变量): a categorical variable with two to twenty categories.' },
          independents: { type: 'array', items: { type: 'string' }, description: 'One to ten numeric predictors (自变量). Categorical predictors must be recoded into dummies first.' },
          reference: { type: 'string', description: 'The category used as the reference (参照类别), by value; the last category by default, as in SPSS. The other categories get one parameter block each.' },
        },
        required: ['dependent', 'independents'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.multinomialTable({
          dependent: args.dependent,
          independents: args.independents,
          reference: args.reference,
        })
        const parameters = result.items[result.items.length - 1]
        return {
          title: parameters.title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          reference: result.model.reference,
          accuracy: result.model.accuracy,
        }
      },
    }),

    tool({
      name: 'pspp_twostage',
      description: 'Two-stage least squares (SPSS 「二阶段最小二乘」) for a model with endogenous regressors that are instrumented by others. PSPP 2.1.3 has no 2SLS procedure, so the projection is built here: beta = (X\'P_Z X)^-1 X\'P_Z y with P_Z = Z(Z\'Z)^-1Z\', where Z stacks the constant, the exogenous regressors and the instruments. Returns the model summary (R², cases, residual df), the first stage for each endogenous variable (R², F and P of the instruments — the weak-instrument diagnostic; F well above 10 is the usual rule), and coefficients with B, standard error, t and P. Standard errors assume homoskedasticity and use the real residuals, not the second-stage regression. Fewer instruments than endogenous variables is refused as under-identified. Cases missing any used variable are removed whole.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dependent: { type: 'string', description: 'The numeric dependent variable (因变量).' },
          endogenous: { type: 'array', items: { type: 'string' }, description: 'The numeric endogenous regressors (内生自变量) — the ones instrumented.' },
          instruments: { type: 'array', items: { type: 'string' }, description: 'The numeric instruments (工具变量). Needs at least as many as there are endogenous regressors.' },
          exogenous: { type: 'array', items: { type: 'string' }, description: 'Optional numeric exogenous regressors that need no instrument (外生自变量).' },
        },
        required: ['dependent', 'endogenous', 'instruments'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.twoStageTable({
          dependent: args.dependent,
          endogenous: args.endogenous,
          instruments: args.instruments,
          exogenous: args.exogenous ?? [],
        })
        return {
          title: result.items[result.items.length - 1].title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          rSquare: result.model.rSquare,
          cases: result.model.cases,
          stageOne: result.model.stageOne,
        }
      },
    }),

    tool({
      name: 'pspp_wls',
      description: 'Weighted least squares regression (SPSS 「权重估计」): y = b0 + b1*x1 + ... fitted with case weights, where a larger weight means that case is more reliable (residual variance is assumed proportional to 1/weight). PSPP 2.1.3 has no WLS procedure and REGRESSION does not take a weight variable, so the weighted normal equations are solved here. Returns the model summary (R², adjusted R², standard error of the estimate, weighted mean), the weighted ANOVA table (regression, residual and total sums of squares with F and P), and the coefficient table with B, standard error, t and P. Weights of zero or below are dropped and counted, cases missing any variable are removed whole, and the notes say both. When every weight is the same the result equals ordinary least squares and a note says so. Residual degrees of freedom count cases, not the weight total — the R², F and standard errors are weighted and are not comparable with an unweighted regression on the same data.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dependent: { type: 'string', description: 'The numeric dependent variable (因变量).' },
          independents: { type: 'array', items: { type: 'string' }, description: 'One to ten numeric predictors (自变量).' },
          weight: { type: 'string', description: 'The weight variable (权重变量): numeric, positive. Zero or negative weights are dropped.' },
        },
        required: ['dependent', 'independents', 'weight'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.wlsTable({
          dependent: args.dependent,
          independents: args.independents,
          weight: args.weight,
        })
        return {
          title: result.items[result.items.length - 1].title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          rSquare: result.model.rSquare,
          cases: result.model.cases,
        }
      },
    }),

    tool({
      name: 'pspp_poisson',
      description: 'Poisson regression for a count dependent variable with a log link: predicted counts = exp(b0 + b1*x1 + ...), fitted here by IRLS because PSPP 2.1.3 has no procedure that fits a Poisson mean model (GENLOG only does log-linear models of contingency tables, NLR needs a hand-written model). Returns model fit (-2 log likelihood against the intercept-only model, likelihood-ratio chi-square), goodness of fit (deviance and Pearson chi-square with their degrees of freedom), and the parameter table with B, standard error, Wald, P and Exp(B) — the multiplicative change in the predicted count per unit of the predictor. The Pearson chi-square over its degrees of freedom is reported as a dispersion parameter, and a note warns when it clearly exceeds one (overdispersion), because the standard errors then understate the uncertainty. Only numeric independents are accepted; recode categorical predictors into dummies first. Cases missing any variable are removed whole. A rate variable is rejected: model events with the exposure as a log offset instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dependent: { type: 'string', description: 'The count dependent variable (因变量): a numeric variable of non-negative integers.' },
          independents: { type: 'array', items: { type: 'string' }, description: 'One to ten numeric predictors (自变量). Categorical predictors must be recoded into dummies first.' },
        },
        required: ['dependent', 'independents'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.poissonTable({
          dependent: args.dependent,
          independents: args.independents,
        })
        return {
          title: result.items[result.items.length - 1].title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          dispersion: result.model.dispersion,
          cases: result.model.cases,
        }
      },
    }),

    tool({
      name: 'pspp_correspondence',
      description: 'Correspondence analysis of two categorical variables (SPSS 「分析 → 降维 → 对应分析」): a two-dimensional map of the row and column categories, built from the chi-square decomposition of the contingency table. PSPP 2.1.3 has no CORRESPONDENCE procedure, so the singular value decomposition is done here (power iteration on the standardized residual cross-product, one direction at a time). Returns the contingency table, the summary table (singular values, inertia, explained and cumulative proportion per dimension), the chi-square decomposition (chi-square, degrees of freedom, P value, total inertia = chi-square over cases), and the principal coordinates of the row and column points with their masses. A biplot of both sets of points goes to the output. Total inertia is chi-square divided by the case count, so it is comparable across tables of different sizes; the coordinates are principal normalised, so distances between two row points and between two column points are meaningful while a row-to-column distance is only qualitative.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          row: { type: 'string', description: 'The row variable (行变量): a categorical variable with two to sixty categories.' },
          column: { type: 'string', description: 'The column variable (列变量): a categorical variable with two to sixty categories, different from the row variable.' },
          dimensions: { type: 'integer', description: 'How many dimensions to keep, 1 to 3 (two is enough for the map). Default 2.' },
        },
        required: ['row', 'column'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.correspondenceTable({
          row: args.row,
          column: args.column,
          dimensions: args.dimensions,
        })
        return {
          title: result.items[0].title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          chiSquare: result.model.chiSquare,
          inertia: result.model.inertia,
          rows: result.model.rows,
          columns: result.model.columns,
        }
      },
    }),

    tool({
      name: 'pspp_loglinear',
      description: 'General log-linear analysis (SPSS: Analyze > Loglinear > General). Cross-tabulates two to four categorical variables and fits a hierarchical log-linear model to the cell counts as a Poisson regression with a log link (PSPP 2.1.3 has no HILOGLINEAR, so the fit happens inside the plugin). Returns four tables: cell counts with expected counts / residuals / adjusted residuals, goodness of fit (likelihood-ratio G-squared, df, p, Pearson chi-square), parameter estimates (dummy contrast coding, so an estimate is the log-odds against the reference level) and partial association (how much G-squared rises when a term is removed).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: { type: 'array', items: { type: 'string' }, description: 'Two to four categorical variables.' },
          terms: {
            type: 'array',
            description: 'Effects to keep, each an array of variable names: ["a"] is a main effect, ["a","b"] an interaction. Defaults to main effects only.',
            items: { type: 'array', items: { type: 'string' } },
          },
          model: { type: 'string', enum: ['saturated'], description: 'Set to saturated to fit every interaction instead of listing terms.' },
        },
        required: ['variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.logLinearTable(args)
        return {
          title: result.items[0]?.title ?? 'log-linear analysis',
          matrix: result.matrix,
          cells: result.matrices[0],
          parameters: result.matrices[2],
          partial: result.matrices[3],
          terms: result.model.terms,
          fit: {
            g2: Number(result.model.fit.g2.toFixed(6)),
            df: result.model.fit.df,
            p: Number.isFinite(result.model.fit.p) ? Number(result.model.fit.p.toFixed(6)) : null,
            pearson: Number(result.model.fit.pearson.toFixed(6)),
          },
          cases: result.model.cases,
          notes: result.notes,
        }
      },
    }),

    tool({
      name: 'pspp_mds',
      description: 'Multidimensional scaling (SPSS: Analyze > Dimension Reduction > Multiscale). Builds the distance matrix from the chosen numeric variables (euclidean, squared euclidean or city-block, optionally after z-standardizing them) and runs classical MDS (Torgerson double centering plus eigendecomposition). Returns a model summary (eigenvalues, explained proportions, stress), the object coordinates and a labelled map. PSPP 2.1.3 has no PROXIMITIES or ALSCAL, so everything is computed in the plugin; the stress is the normalized residual of the reconstructed distances, not Kruskal stress from a full ALSCAL run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: { type: 'array', items: { type: 'string' }, description: 'Numeric variables that define the space (one or more).' },
          distance: { type: 'string', enum: ['euclidean', 'sqeuclidean', 'cityblock'], description: 'Distance measure; defaults to euclidean.' },
          dimensions: { type: 'integer', description: 'Dimensions to keep, 1 to 3; defaults to 2.' },
          standardize: { type: 'boolean', description: 'Standardize each variable to z scores first (SPSS normally does this when the scales differ).' },
        },
        required: ['variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.mdsTable(args)
        return {
          title: result.items[0]?.title ?? 'multidimensional scaling',
          matrix: result.matrix,
          coordinates: result.matrices[1],
          notes: result.notes,
          dimensions: result.model.dimensions,
          stress: Number(result.model.stress.toFixed(6)),
          explained: result.model.explained.map((value) => Number(value.toFixed(6))),
          cases: result.model.cases,
          chart: result.chart ? { kind: result.chart.kind, title: result.chart.title } : null,
        }
      },
    }),

    tool({
      name: 'pspp_curve',
      description: 'Curve estimation (SPSS: Analyze > Regression > Curve Estimation). Fits up to eleven models — linear, logarithmic, inverse, quadratic, cubic, compound, power, S, growth, exponential and logistic — on one dependent and one independent numeric variable, and reports R squared, adjusted R squared, F, P and the coefficients in each model own parameterization. Nonlinear models are linearized first, so the R squared column is that of the linearized regression; a second column gives R squared on the original scale. Also draws a scatter plot with the best-fitting curve.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dependent: { type: 'string', description: 'Numeric dependent variable.' },
          independent: { type: 'string', description: 'Numeric independent variable.' },
          models: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional subset of linear / logarithmic / inverse / quadratic / cubic / compound / power / s / growth / exponential / logistic. Defaults to all eleven.',
          },
          upper: { type: 'number', description: 'Upper bound u for the logistic model (must exceed the largest y). Defaults to max(y) * 1.1.' },
        },
        required: ['dependent', 'independent'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.curveTable(args)
        return {
          title: result.items[0]?.title ?? 'curve estimation',
          matrix: result.matrix,
          notes: result.notes,
          models: result.model.parameters.map((entry) => ({
            model: entry.model,
            rSquare: Number(entry.rSquare.toFixed(6)),
            rSquareOriginal: Number(entry.rSquareOriginal.toFixed(6)),
            coefficients: entry.coefficients,
          })),
          best: result.model.best,
          cases: result.model.cases,
          chart: result.chart ? { kind: result.chart.kind, title: result.chart.title } : null,
        }
      },
    }),

    tool({
      name: 'pspp_mca',
      description: 'Multiple correspondence analysis (SPSS 「分析 → 降维 → 最优尺度 → 多重对应分析」): a two-dimensional map of the categories of two or more categorical variables. PSPP 2.1.3 has no HOMALS, so the whole thing is computed here — the variables are expanded into an indicator matrix (cases x every category), that matrix is analysed exactly like a contingency table (standardized residuals, then power iteration on the cross-product), and the category principal coordinates are reported. Returns the model summary (Cronbach\'s alpha, inertia, explained and cumulative proportion per dimension), the discrimination measures (how much each variable contributes to each dimension; they add up to the dimension inertia), the category coordinates with their masses, and a category map coloured by variable. Total inertia follows the textbook identity (number of categories - number of variables) / number of variables. Categories that belong to the same variable are comparable; distances across variables are only qualitative. Cases missing any of the chosen variables are dropped whole and counted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: {
            type: 'array',
            items: { type: 'string' },
            description: 'Two to twenty categorical variable names (分类变量). Numeric variables must be binned or declared nominal first.',
          },
          dimensions: { type: 'integer', description: 'How many dimensions to keep, 1 to 3 (two is enough for the map). Default 2.' },
        },
        required: ['variables'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = await workspace.mcaTable({
          variables: args.variables,
          dimensions: args.dimensions,
        })
        return {
          title: result.items[0].title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          cases: result.model.cases,
          categories: result.model.categories,
          inertia: result.model.inertia,
          explained: result.model.explained,
        }
      },
    }),

    tool({
      name: 'pspp_distribution',
      description: 'Probability distribution calculator: for one point of a normal, t, chi-square, F, binomial or Poisson distribution it returns the density (or probability mass for the two discrete ones), the cumulative probability, the upper and two-sided tails, and — when a cumulative probability is given — the quantile. Handy for checking a critical value, a p value or a power calculation without opening another program. It needs no dataset. The tails follow SPSS conventions: upper tail P(X >= x) = 1 - P(X <= x), and for the discrete distributions that differs from P(X > x) by one point mass, which a note spells out. Bad input (unknown distribution, missing point, missing or non-positive degrees of freedom, a binomial probability outside 0..1, a non-positive Poisson mean, a cumulative probability outside the open interval 0..1) is refused with a readable message.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          distribution: { type: 'string', enum: ['normal', 't', 'chiSquare', 'f', 'binomial', 'poisson'], description: 'Which distribution to evaluate.' },
          x: { type: 'number', description: 'The point to evaluate at: the statistic for the continuous distributions, a count for binomial and Poisson.' },
          probability: { type: 'number', description: 'Optional cumulative probability (0 < p < 1). When given, the quantile at that probability is returned too.' },
          df: { type: 'number', description: 'Degrees of freedom for t, chi-square (one) and F (numerator).' },
          df2: { type: 'number', description: 'Denominator degrees of freedom, for F only.' },
          n: { type: 'integer', description: 'Number of trials, for the binomial.' },
          p: { type: 'number', description: 'Success probability between 0 and 1, for the binomial.' },
          lambda: { type: 'number', description: 'Mean, for the Poisson (its variance equals the mean).' },
        },
        required: ['distribution', 'x'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const result = workspace.distributionTable({
          distribution: args.distribution,
          x: args.x,
          probability: args.probability,
          df1: args.df,
          df2: args.df2,
          n: args.n,
          p: args.p,
          lambda: args.lambda,
        })
        return {
          title: result.items[result.items.length - 1].title,
          matrix: result.matrix,
          notes: result.notes,
          cdf: result.result.cdf,
          pdf: result.result.pdf,
          quantile: result.result.quantile,
        }
      },
    }),

    tool({
      name: 'pspp_ordinal',
      description: 'Ordinal logistic regression (proportional odds / cumulative logit) for an ordered dependent variable with three or more categories: thresholds plus one coefficient per predictor, model fit (-2 log likelihood, likelihood-ratio chi-square), pseudo R squares, the observed-by-predicted classification table, and the parallel-lines test that checks the proportional-odds assumption by refitting the same data as an unrestricted multinomial model. PSPP 2.1.3 has no ordered-logit procedure (NOMREG reports "not yet implemented"), so the model is fitted here by Newton–Raphson; a two-level dependent variable gives exactly the binary logistic coefficients. Only numeric independents are accepted: recode a categorical predictor into dummy variables first. Cases missing any variable are removed whole.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dependent: { type: 'string', description: 'The ordered dependent variable (因变量): a categorical variable with two to twenty categories; its sorted values define the order.' },
          independents: { type: 'array', items: { type: 'string' }, description: 'One to ten numeric predictors (自变量). Categorical predictors must be recoded into dummies first.' },
        },
        required: ['dependent', 'independents'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const result = workspace.ordinalTable({
          dependent: args.dependent,
          independents: args.independents,
        })
        const parameters = result.items[result.items.length - 1]
        return {
          title: parameters.title,
          matrix: result.matrix,
          tables: result.matrices,
          notes: result.notes,
          categories: result.model.categories,
          accuracy: result.model.accuracy,
          parallel: result.model.parallel,
        }
      },
    }),

    tool({
      name: 'pspp_edit_chart',
      description: 'Change an existing chart instead of drawing a new one: title, subtitle, axis labels, main colour (#rrggbb) or category order (asc/desc). The numbers are recomputed from the same dataset and options, so the figure still matches the data. Use the runId returned by pspp_chart. Works for every kind pspp_chart can draw, including Kaplan–Meier (km), the hierarchical-clustering dendrogram and the timeseries smoothing chart; the categorical sort order only applies to bar, pie, pareto and area.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'number', description: 'The run that produced the chart (from pspp_chart).' },
          title: { type: 'string' },
          xLabel: { type: 'string' },
          yLabel: { type: 'string' },
          accent: { type: 'string', description: 'Main colour as #rrggbb.' },
          sortCategories: { type: 'string', enum: ['none', 'asc', 'desc'] },
        },
        required: ['runId'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (!workspace.dataset) throw new Error('no dataset is open; call pspp_open first')
        const { runId, ...patch } = args
        const result = await workspace.updateChart(runId, patch)
        return {
          runId: result.runId,
          chart: result.chart,
          charts: itemsForAgent(workspace, result.item ? [result.item] : []),
        }
      },
    }),

    tool({
      name: 'pspp_save',
      description: 'Save the current dataset to an SPSS system file (.sav). Without a path it overwrites the file it was opened from.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Destination path; defaults to the source file.' },
        },
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const result = await workspace.save(args.path)
        return result
      },
    }),

    tool({
      name: 'pspp_merge',
      description: 'Merge another PSPP system file into the open dataset: kind "add" appends its cases (ADD FILES), kind "match" joins its variables by the given key variables (MATCH FILES /BY). The result is written back to the working file.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'System file (.sav/.por/.sys) to merge in.' },
          kind: { type: 'string', enum: ['add', 'match'], description: 'add = append cases, match = join variables by key.' },
          by: { type: 'array', items: { type: 'string' }, description: 'Key variables for kind "match".' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        const result = await workspace.mergeFile(args)
        return {
          kind: result.kind,
          path: result.path,
          variables: result.variables,
          cases: result.cases,
          runId: result.runId,
        }
      },
    }),

    tool({
      name: 'pspp_export_document',
      description: 'Render the most recent run (or the given syntax) to a printable PDF/ODT document, or to an SPSS .spv output archive that SPSS can open. Replaying syntax that changes data would apply it twice, so pass only read-only procedures.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Destination path: .pdf, .odt or .spv (the extension chooses the format).' },
          syntax: { type: 'string', description: 'Optional syntax to render instead of the last run.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        if (typeof args.syntax === 'string' && args.syntax.trim() !== '') {
          await workspace.runSyntax(args.syntax, { persist: false })
        }
        return workspace.exportDocument(args.path)
      },
    }),

    tool({
      name: 'pspp_export_office',
      description: 'Write the current output to a Word (.docx) or Excel (.xlsx) file. The .docx keeps tables and embeds the charts; the .xlsx puts every table on its own sheet with numeric cells. Use it for reports and homework, not for the dataset itself.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Destination .docx or .xlsx path.' },
          scope: { type: 'string', enum: ['session', 'last'], description: 'session (default) exports every table and chart of the session; last exports only what the most recent run produced.' },
          items: { type: 'array', items: { type: 'string' }, description: 'Export only these output entries, by id (tables and charts both accepted). Takes precedence over scope; an id that no longer exists is an error rather than a silent fallback to everything.' },
          formulas: { type: 'boolean', description: 'Write the quantities that a table already carries as Excel formulas (percentages, column totals, Wald, exp(B) intervals) so editing an input cell recalculates them. Default true; false writes plain numbers.' },
          dataSheet: { type: 'boolean', description: 'Append a hidden worksheet holding the raw cases (xlsx only, default false). With the data present a reader can recompute means and SDs, which no printed table carries.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        // Ids are resolved against the live output so a stale id fails loudly
        // instead of exporting the whole session.
        const picked = Array.isArray(args.items) && args.items.length > 0
          ? args.items.map((id) => workspace.state().items.find((item) => item.id === id) ?? null)
          : null
        if (picked && picked.some((item) => item === null)) {
          throw new Error('指定的输出条目已经不在了：先用 pspp_status 或重新运行分析取新的 id')
        }
        return workspace.exportOffice(args.path, picked, { scope: args.scope, formulas: args.formulas, data: args.dataSheet === true })
      },
    }),

    tool({
      name: 'pspp_export_chart',
      description: 'Write one of the current output charts to a .png or .svg file. Get runId from pspp_chart or from the chart url the panel shows; the format follows the path extension, and png encodes the chart geometry and colours exactly (labels are meant to be added in a document).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Destination .png or .svg path.' },
          runId: { type: 'integer', description: 'Run number of the chart (the runs/<n> directory it was drawn into).' },
          url: { type: 'string', description: 'Alternatively, the artifact url of the chart, which carries runId.' },
          scale: { type: 'number', description: 'Pixel multiplier for png, between 1 and 4. Default 1.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        return workspace.exportChart({ path: args.path, runId: args.runId, url: args.url, scale: args.scale })
      },
    }),

    tool({
      name: 'pspp_export',
      description: 'Export the current dataset as CSV (UTF-8, header row, no value labels). Use pspp_export_office for Word/Excel, pspp_export_document for the tables and charts of a run, and pspp_export_chart for a single chart as .png or .svg.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Destination .csv path.' },
        },
        required: ['path'],
      },
      async execute(args, exec) {
        const { sessionId, cwd } = resolve(exec)
        const workspace = await registry.ensure(sessionId, cwd)
        return workspace.exportCsv(args.path)
      },
    }),
  ]
}
