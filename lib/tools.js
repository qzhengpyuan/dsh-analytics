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
      const chart = p.chart ? ' /BARCHART=COUNT' : ''
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
            analyses: ['frequencies', 'descriptives', 'crosstabs', 'ttest_one_sample', 'ttest_independent', 'ttest_paired', 'oneway', 'glm', 'correlation', 'regression', 'logistic', 'factor', 'reliability', 'npar', 'npar_binomial', 'npar_ks', 'npar_runs', 'npar_wilcoxon', 'npar_sign', 'npar_mannwhitney', 'npar_kruskal', 'npar_friedman', 'npar_mcnemar', 'npar_cochran', 'npar_kendall', 'npar_jonckheere', 'examine', 'means', 'ctables', 'roc', 'cluster', 'partial'],
            transforms: ['compute', 'recode', 'autorecode', 'sort', 'aggregate', 'select', 'filter', 'weight', 'split', 'rename', 'delete', 'sample', 'count', 'rank'],
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
      description: 'Run one common analysis without writing syntax. Procedures: frequencies, descriptives, crosstabs, ttest_independent, ttest_paired, ttest_one_sample, oneway, glm, correlation, regression, logistic, factor, reliability, npar (chi-square), npar_binomial, npar_ks, npar_runs, npar_wilcoxon, npar_sign, npar_mannwhitney, npar_kruskal, npar_jonckheere, npar_friedman, npar_mcnemar, npar_cochran, npar_kendall, examine, means, ctables, roc, cluster, mva (missing value analysis: per-variable counts and the missing-data patterns; computed inside the plugin because PSPP has no MVA). Returns the resulting tables as matrices. For regression, pass plots: ["residual","pp"] to have the plugin draw the residual scatter and the normal P-P plot from the same fit (PSPP prints no regression plots).',
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
      description: 'Apply a data transformation and keep it in the dataset. Operations: compute, recode, sort, aggregate, select, filter, weight, split, rename, delete, sample, count, rank, casesToVars (pivot once-case-per-index into one-case-per-identifier), varsToCases (stack several wide columns into long form). The last two are computed inside the plugin because PSPP has neither CASESTOVARS nor VARSTOCASES; they return counts instead of syntax. replaceMissing fills blanks and declared missing codes with the series mean (mean), a linear interpolation between neighbours (linear), the nearest present value (nearby), the mean or median of the nearest points (nearbyMean / nearbyMedian) or the least-squares trend at that case (trend) — PSPP has no RMV, so it is computed inside the plugin. identifyDuplicates groups rows by the key variables and reports the repeated groups, optionally adding dupSeq/dupLast; identifyOutliers flags the cases whose values fall outside a percentile band (default 5%–95%), optionally adding outlier/outlierN. Neither has any PSPP syntax, so both return counts instead of a program. Every operation persists; check the returned syntax to confirm what ran.',
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
      description: 'Draw a chart from the open dataset: bar (mean/sum/count of a variable, optionally by a category, optionally clustered or stacked by a second variable, optionally with standard-deviation error bars), histogram, boxplot (five-number summary, optionally by a category), line (means per category, optionally one line per value of a second variable), pie (category shares, optionally as a ring), area (stacked cumulative trend, optionally split by a second variable), or scatterplot. Returns the chart file and its URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', description: 'bar, histogram, scatterplot, boxplot, line, pie or area.' },
          variable: { type: 'string', description: 'Variable for bar / histogram / boxplot / line / pie.' },
          by: { type: 'string', description: 'Category variable for bar / boxplot / line.' },
          statistic: { type: 'string', description: 'MEAN, SUM, COUNT for bar. A text variable can only be COUNTed (its bar height is the number of cases).' },
          percent: { type: 'boolean', description: 'bar of a text variable: draw each category as its share of the valid cases (percentages) instead of raw counts.' },
          x: { type: 'string', description: 'X variable for scatterplot.' },
          y: { type: 'string', description: 'Y variable for scatterplot.' },
          group: { type: 'string', description: 'scatterplot: colour the points by this variable categories (a legend is drawn).' },
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
      description: 'Pairwise comparison table for every pair of groups of a categorical variable: mean difference, standard error, Welch t, raw P, and Bonferroni adjusted P with asterisks (*** <0.001, ** <0.01, * <0.05, ns). Bonferroni is applied by default — the asterisks follow the adjusted P, so a table copied into a paper is already corrected; pass adjust:"none" only when you deliberately want the raw P. Welch t does not assume equal variances, so it holds up when the group sizes differ. Use it when a paper needs the pairwise P values behind an overall group difference.',
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
      name: 'pspp_edit_chart',
      description: 'Change an existing chart instead of drawing a new one: title, axis labels, main colour (#rrggbb) or category order (asc/desc). The numbers are recomputed from the same dataset and options, so the figure still matches the data. Use the runId returned by pspp_chart.',
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
