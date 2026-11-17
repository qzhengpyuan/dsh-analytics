/**
 * Custom contrasts and general linear hypotheses for multi-factor models.
 *
 * PSPP 2.1.3's GLM accepts only MISSING / INTERCEPT / CRITERIA / METHOD /
 * DESIGN (probed: /CONTRAST and /POSTHOC are syntax errors), so a single-factor
 * design with contrasts or post-hoc tests is routed to ONEWAY, which does have
 * both. A design with two or more factors — necessarily including its
 * interaction terms — has no route through the engine at all. This module is
 * that route: it builds the design matrix itself and tests any linear
 * hypothesis on it in JavaScript.
 *
 * The arithmetic never inverts X'X. An estimable hypothesis L is a linear
 * combination of rows of X, so there is a λ with L = λ'X, and then
 *
 *     Lβ = λ'ŷ        (ŷ = projection of y on the column space of X)
 *     L(X'X)⁻¹L' = λ'λ
 *
 * Both are invariant to which generalised inverse a redundant design would
 * need, and both fall out of a thin QR of X with modified Gram–Schmidt and
 * re-orthogonalisation — the same stabilising trick `projectionFit` in
 * lib/regression.js uses. A hypothesis that is not estimable is reported as
 * such instead of being handed a number from a singular system.
 */
import { isUserMissing } from './missing.js'
import { fP } from './tables.js'

/**
 * Relative size below which a column of X counts as lying in the span of the
 * columns already accepted. `projectionFit` uses 1e-11 for the same decision;
 * with two re-orthogonalisation passes an exactly redundant column comes back
 * at ~1e-16 times its original length, so 1e-11 drops aliasing and keeps
 * genuinely near-collinear predictors.
 */
const RANK_TOLERANCE = 1e-11

/**
 * Relative distance from L to the row space of X'X above which the contrast is
 * called not estimable. A truly estimable L lands at ~1e-15; 1e-8 leaves room
 * for accumulated round-off in a badly scaled design without ever accepting a
 * contrast that the data cannot identify.
 */
const ESTIMABLE_TOLERANCE = 1e-8

const INTERCEPT_NAME = '(截距)'
const UNESTIMABLE_REASON = '该对比在数据里没有对应的自由度，通常是某一格没有观测'

function dot(left, right) {
  let sum = 0
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i]
  return sum
}

function norm(values) {
  let sum = 0
  for (const value of values) sum += value * value
  return Math.sqrt(sum)
}

function isBlank(value) {
  return value === null || value === undefined || value === ''
}

/** Blank, a declared user-missing code, or an unparsable number. */
function missingCell(variable, value) {
  if (isBlank(value)) return true
  if (isUserMissing(variable, value)) return true
  if (variable?.type === 'string') return false
  return !Number.isFinite(Number(value))
}

/**
 * Thin QR of a set of column vectors, by modified Gram–Schmidt with two
 * re-orthogonalisation passes.
 *
 * `columns` is an array of equal-length numeric arrays; `n` is their length.
 * Columns that are (numerically) combinations of the columns accepted before
 * them are left out of the basis and reported in `dropped`; their representation
 * in the basis is still available through `r`, because R is computed as Q'X
 * after the basis is known, so X = Q·R holds for *every* column.
 */
function thinQr(columns, n) {
  const k = columns.length
  const basis = []
  const dropped = []
  const kept = []
  for (let j = 0; j < k; j += 1) {
    const original = columns[j]
    let length0 = 0
    for (let row = 0; row < n; row += 1) length0 += original[row] * original[row]
    length0 = Math.sqrt(length0)
    if (!(length0 > 0)) {
      dropped.push(j)
      continue
    }
    const vector = original.slice()
    for (let pass = 0; pass < 2; pass += 1) {
      for (const q of basis) {
        const projection = dot(vector, q)
        if (projection === 0) continue
        for (let row = 0; row < n; row += 1) vector[row] -= projection * q[row]
      }
    }
    const length = Math.sqrt(dot(vector, vector))
    if (!(length > RANK_TOLERANCE * length0)) {
      dropped.push(j)
      continue
    }
    basis.push(vector.map((value) => value / length))
    kept.push(j)
  }
  // R = Q'X exactly, for the columns in the basis and for the aliased ones.
  const r = basis.map((q) => {
    const row = new Array(k).fill(0)
    for (let j = 0; j < k; j += 1) row[j] = dot(q, columns[j])
    return row
  })
  return { q: basis, r, rank: basis.length, kept, dropped }
}

/** Solve an upper-triangular system R·x = b by back substitution. */
function solveUpper(r, b) {
  const k = r.length
  const x = new Array(k).fill(0)
  for (let i = k - 1; i >= 0; i -= 1) {
    let sum = b[i]
    for (let j = i + 1; j < k; j += 1) sum -= r[i][j] * x[j]
    if (r[i][i] === 0) return null
    x[i] = sum / r[i][i]
  }
  return x
}

/** Cholesky solve of a small symmetric positive-definite system. */
function solveSpd(matrix, rhs) {
  const size = matrix.length
  const lower = Array.from({ length: size }, () => new Array(size).fill(0))
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j]
      for (let k = 0; k < j; k += 1) sum -= lower[i][k] * lower[j][k]
      if (i === j) {
        if (!(sum > 0)) return null
        lower[i][j] = Math.sqrt(sum)
      } else {
        if (lower[j][j] === 0) return null
        lower[i][j] = sum / lower[j][j]
      }
    }
  }
  const forward = new Array(size).fill(0)
  for (let i = 0; i < size; i += 1) {
    let sum = rhs[i]
    for (let k = 0; k < i; k += 1) sum -= lower[i][k] * forward[k]
    forward[i] = sum / lower[i][i]
  }
  const solution = new Array(size).fill(0)
  for (let i = size - 1; i >= 0; i -= 1) {
    let sum = forward[i]
    for (let k = i + 1; k < size; k += 1) sum -= lower[k][i] * solution[k]
    solution[i] = sum / lower[i][i]
  }
  return solution
}

function uniqueNames(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Numeric levels sort ascending, string levels in dictionary order. */
function compareLevels(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  const a = String(left)
  const b = String(right)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function normalizedLevel(variable, value) {
  if (variable?.type === 'string') return String(value)
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** All combinations of `dimensions`, with the first dimension varying fastest. */
function cartesian(dimensions) {
  let combos = [[]]
  for (let depth = dimensions.length - 1; depth >= 0; depth -= 1) {
    const next = []
    for (const combo of combos) {
      for (let index = 0; index < dimensions[depth].length; index += 1) {
        next.push([index].concat(combo))
      }
    }
    combos = next
  }
  return combos
}

function subsets(items, size) {
  if (size === 0) return [[]]
  if (items.length < size) return []
  const out = []
  for (let index = 0; index <= items.length - size; index += 1) {
    for (const rest of subsets(items.slice(index + 1), size - 1)) {
      out.push([items[index]].concat(rest))
    }
  }
  return out
}

/**
 * Build the treatment-coded design matrix for `dependent` given `factors`,
 * `covariates` and (optionally) every interaction between the factors.
 *
 * - Each factor contributes k − 1 indicator columns, the first level (by
 *   numeric or dictionary order) being the reference: `a` with levels 1, 2, 3
 *   becomes `a[2]`, `a[3]`.
 * - With `interactions: true` every factor pair, triple … contributes the
 *   products of its indicator columns, named `a[2]*b[3]`, first factor varying
 *   fastest — the same column order R's `model.matrix(~a*b)` produces.
 * - Covariates enter as their own numeric columns.
 * - Cases with a blank, a declared user-missing code, or a non-numeric value in
 *   *any* of those variables are dropped listwise, exactly as the table builder
 *   drops them; `dropped` is how many went.
 *
 * Returns `{ columns, names, n, cases, levels, dropped }` — plus `y`
 * (an alias of `cases`), `rows` (the kept row indices), `rank`/`aliased` (from
 * the same QR the test uses) and `notes` for anything that was refused.
 * `cases` holds the dependent values, one per kept case, aligned with every
 * column of `columns`.
 */
export function designColumns(dataset, options = {}) {
  if (!dataset || !Array.isArray(dataset.variables) || !Array.isArray(dataset.rows)) return null
  const dependent = typeof options.dependent === 'string' ? options.dependent.trim() : ''
  if (dependent === '') return null
  const indexOf = (name) => dataset.variables.findIndex((variable) => variable && variable.name === name)
  const dependentIndex = indexOf(dependent)
  if (dependentIndex < 0) return null
  const dependentVariable = dataset.variables[dependentIndex]
  // A string dependent variable is not a regression: refuse rather than turn
  // category codes into numbers behind the caller's back.
  if (dependentVariable?.type === 'string') return null

  const notes = []
  const factorNames = uniqueNames(Array.isArray(options.factors) ? options.factors : []).filter((name) => {
    if (name === dependent) {
      notes.push(`因子 ${name} 同时被指定为因变量，已忽略`)
      return false
    }
    if (indexOf(name) < 0) {
      notes.push(`因子 ${name} 不在数据集里，已忽略`)
      return false
    }
    return true
  })
  const covariateNames = uniqueNames(Array.isArray(options.covariates) ? options.covariates : []).filter((name) => {
    if (name === dependent) {
      notes.push(`协变量 ${name} 同时被指定为因变量，已忽略`)
      return false
    }
    const at = indexOf(name)
    if (at < 0) {
      notes.push(`协变量 ${name} 不在数据集里，已忽略`)
      return false
    }
    if (dataset.variables[at]?.type === 'string') {
      // A string covariate is a factor in disguise; treating its codes as a
      // metric would fit a straight line through category labels.
      notes.push(`协变量 ${name} 是字符串变量，已忽略（想按水平比较请把它放进因子）`)
      return false
    }
    return true
  })

  // Levels come from the whole file, not from the kept cases only: a level that
  // shows up in one dropped row would otherwise silently change the coding of
  // every row above it as data is edited.
  const levels = {}
  for (const name of factorNames) {
    const variable = dataset.variables[indexOf(name)]
    const values = []
    for (const row of dataset.rows) {
      const cell = Array.isArray(row) ? row[indexOf(name)] : undefined
      if (missingCell(variable, cell)) continue
      const level = normalizedLevel(variable, cell)
      if (level === null) continue
      if (!values.some((entry) => entry === level)) values.push(level)
    }
    values.sort(compareLevels)
    levels[name] = values
  }
  const usableFactors = factorNames.filter((name) => {
    if (levels[name].length > 1) return true
    notes.push(`因子 ${name} 只有 ${levels[name].length} 个水平，不产生哑变量（水平数 > 1 才能当因子）`)
    return false
  })

  // --- listwise deletion ----------------------------------------------------
  const usedNames = [dependent].concat(usableFactors, covariateNames)
  const keptRows = []
  const cases = []
  for (let rowIndex = 0; rowIndex < dataset.rows.length; rowIndex += 1) {
    const row = dataset.rows[rowIndex]
    if (!Array.isArray(row)) continue
    let complete = true
    for (const name of usedNames) {
      const at = indexOf(name)
      if (missingCell(dataset.variables[at], row[at])) { complete = false; break }
    }
    if (!complete) continue
    keptRows.push(rowIndex)
    cases.push(Number(row[dependentIndex]))
  }
  const dropped = dataset.rows.length - keptRows.length

  const columnAt = (name) => {
    const at = indexOf(name)
    return keptRows.map((rowIndex) => Number(dataset.rows[rowIndex][at]))
  }
  const factorAt = (name) => {
    const variable = dataset.variables[indexOf(name)]
    const at = indexOf(name)
    return keptRows.map((rowIndex) => normalizedLevel(variable, dataset.rows[rowIndex][at]))
  }

  const columns = []
  const names = []
  if (options.intercept !== false) {
    columns.push(new Array(keptRows.length).fill(1))
    names.push(INTERCEPT_NAME)
  }
  for (const name of covariateNames) {
    columns.push(columnAt(name))
    names.push(name)
  }
  // Dummy blocks, kept so the interactions can multiply their columns.
  const blocks = []
  for (const name of usableFactors) {
    const values = factorAt(name)
    const entries = []
    for (let index = 1; index < levels[name].length; index += 1) {
      const level = levels[name][index]
      entries.push({
        name: `${name}[${level}]`,
        values: values.map((value) => (value === level ? 1 : 0)),
        level,
      })
    }
    for (const entry of entries) {
      columns.push(entry.values)
      names.push(entry.name)
    }
    blocks.push(entries)
  }

  if (options.interactions !== false) {
    for (let size = 2; size <= blocks.length; size += 1) {
      for (const subset of subsets(blocks, size)) {
        for (const combo of cartesian(subset)) {
          const parts = combo.map((index, depth) => subset[depth][index])
          const values = new Array(keptRows.length).fill(1)
          for (const part of parts) {
            for (let row = 0; row < values.length; row += 1) values[row] *= part.values[row]
          }
          columns.push(values)
          names.push(parts.map((part) => part.name).join('*'))
        }
      }
    }
  }

  const qr = thinQr(columns, keptRows.length)
  const aliased = qr.dropped.map((index) => names[index])
  if (aliased.length > 0 && keptRows.length > 0) {
    notes.push(`设计矩阵秩 = ${qr.rank}（共 ${names.length} 列），共线被剔除的列：${aliased.join('、')}`)
  }

  return {
    columns,
    names,
    n: keptRows.length,
    cases,
    y: cases,
    rows: keptRows,
    levels: Object.fromEntries(usableFactors.map((name) => [name, levels[name].slice()])),
    dropped,
    rank: qr.rank,
    aliased,
    dependent,
    notes,
  }
}

/**
 * One linear hypothesis as rows of coefficients over `names`.
 * Accepts a flat numeric array (one contrast) or an array of arrays (several
 * restrictions tested jointly, giving df1 > 1).
 */
function hypothesisRows(coefficients, width) {
  const rows = Array.isArray(coefficients) && coefficients.length > 0 && Array.isArray(coefficients[0])
    ? coefficients
    : [coefficients]
  const out = []
  for (const row of rows) {
    if (!Array.isArray(row)) return null
    if (row.length !== width) return null
    const values = row.map((value) => (value === null || value === undefined ? 0 : Number(value)))
    if (values.some((value) => !Number.isFinite(value))) return null
    out.push(values)
  }
  return out
}

/**
 * Test each hypothesis of the form Lβ = 0 against a model from
 * `designColumns`, and return one result object per hypothesis.
 *
 * `hypotheses` is `[{ label, coefficients }]`, where `coefficients` is a numeric
 * array as long as `model.names` (a `null`/missing entry means "0 for that
 * column"). Every result is either
 * `{ ok: true, label, estimate, se, t, f, df1, df2, p }` or
 * `{ ok: false, label, reason }` — a hypothesis the data cannot identify is
 * never given a number.
 *
 * The estimability test is the one the spec asks for: L must lie in the row
 * space of X'X. Its distance to that row space is measured with the
 * orthonormal basis of the columns of X, and a relative distance above
 * 1e-8 (i.e. |L − proj| > 1e-8·|L|) marks it not estimable.
 */
export function generalLinearTest(model, hypotheses = []) {
  // A single `{ label, coefficients }` is accepted as well, so a caller testing
  // one contrast does not have to wrap it; the return value is still a list.
  const list = Array.isArray(hypotheses)
    ? hypotheses
    : (hypotheses && typeof hypotheses === 'object' ? [hypotheses] : [])
  const width = Array.isArray(model?.names) ? model.names.length : 0
  const columns = Array.isArray(model?.columns) ? model.columns : []
  const y = Array.isArray(model?.cases) ? model.cases : (Array.isArray(model?.y) ? model.y : [])
  const n = Number.isFinite(model?.n) ? model.n : (columns.length > 0 ? columns[0].length : 0)
  const empty = (label, reason) => ({ ok: false, label, reason })

  if (width === 0 || columns.length === 0) {
    return list.map((hypothesis) => empty(hypothesis?.label, '设计矩阵为空：没有可以检验的模型'))
  }
  if (n === 0) {
    return list.map((hypothesis) => empty(hypothesis?.label, '有效个案为 0：listwise 删完后没有可拟合的数据'))
  }
  if (y.length === 0 || n !== y.length) {
    return list.map((hypothesis) => empty(hypothesis?.label, '模型内部不一致：有效个案数与因变量长度不同'))
  }

  const qr = thinQr(columns, n)
  const rank = qr.rank
  const df2 = n - rank
  const qty = qr.q.map((q) => dot(q, y))
  // Residual sum of squares straight from the residuals, not ||y||² − ||Q'y||²:
  // that difference loses every significant digit when the mean is large.
  const residuals = y.slice()
  for (let index = 0; index < qr.q.length; index += 1) {
    const q = qr.q[index]
    const loading = qty[index]
    for (let row = 0; row < n; row += 1) residuals[row] -= loading * q[row]
  }
  const rss = dot(residuals, residuals)
  const mse = df2 > 0 ? rss / df2 : null

  // Q2 spans the row space of X'X restricted to the coefficient space: rows of
  // R are its columns, so a QR of R (r vectors of length k) gives both the
  // projection of L onto that space and the map from L to λ.
  const rowQr = rank > 0 ? thinQr(qr.r, width) : { q: [], r: [], rank: 0 }
  const rowBasis = rowQr.q

  return list.map((hypothesis) => {
    const label = hypothesis?.label === undefined || hypothesis?.label === null || hypothesis.label === ''
      ? '未命名的对比'
      : String(hypothesis.label)
    if (hypothesis?.coefficients === undefined || hypothesis?.coefficients === null) {
      return empty(label, '这条假设没有给出系数向量')
    }
    const rows = hypothesisRows(hypothesis.coefficients, width)
    if (rows === null) {
      return empty(label, `系数向量长度必须等于设计列数（${width}）`)
    }
    if (rows.length === 0) return empty(label, '假设里没有系数')

    const mus = []
    for (const row of rows) {
      const length = norm(row)
      if (!(length > 0)) {
        return empty(label, '对比的系数全为 0：这条假设没有内容')
      }
      // Project L onto the row space of X'X: L ≈ Q2·(Q2'L).
      const loadings = rowBasis.map((q) => dot(q, row))
      // The residual is formed from the vectors, not from ||L||² − ||Q2'L||²:
      // that difference cancels to about one ulp and its square root bottoms out
      // at sqrt(2ε) ≈ 2e-8, which would fail every estimable contrast against a
      // 1e-8 threshold. Subtracting the vectors keeps the error at ε·|L|.
      const residual = new Array(row.length).fill(0)
      for (let index = 0; index < row.length; index += 1) residual[index] = row[index]
      for (let depth = 0; depth < rowBasis.length; depth += 1) {
        const q = rowBasis[depth]
        const loading = loadings[depth]
        if (loading === 0) continue
        for (let index = 0; index < row.length; index += 1) residual[index] -= loading * q[index]
      }
      if (norm(residual) > ESTIMABLE_TOLERANCE * length) {
        return empty(label, UNESTIMABLE_REASON)
      }
      // Solve R2·μ = Q2'L, with R2 the triangular factor of that projection.
      const mu = solveUpper(rowQr.r, loadings)
      if (mu === null) return empty(label, UNESTIMABLE_REASON)
      mus.push(mu)
    }

    if (rank === 0) return empty(label, '设计矩阵的秩为 0：所有解都是同一个值')
    if (!(mse > 0)) {
      // sigma² = 0 means the fitted values reproduce y exactly; the standard
      // error of any contrast is then 0 and every ratio is 0/0. R prints NaN
      // here, and printing Infinity with p = 0 would be a fake finding.
      return empty(label, df2 <= 0
        ? '没有残差自由度：设计矩阵一列就占满全部个案，无法估计误差方差'
        : '残差方差为 0：模型完全拟合，标准误无定义')
    }

    // Reduce the μ rows to an independent set; dependent restrictions must not
    // inflate df1. The map L ↦ μ is injective on estimable L, so this is the
    // rank of L.
    const basis = []
    const kept = []
    for (const mu of mus) {
      const length = norm(mu)
      const vector = mu.slice()
      for (let pass = 0; pass < 2; pass += 1) {
        for (const q of basis) {
          const projection = dot(vector, q)
          if (projection === 0) continue
          for (let index = 0; index < vector.length; index += 1) vector[index] -= projection * q[index]
        }
      }
      const length2 = norm(vector)
      if (!(length2 > 1e-10 * length)) continue
      basis.push(vector.map((value) => value / length2))
      kept.push(mu)
    }
    const df1 = kept.length
    if (df1 === 0) return empty(label, '对比的系数全为 0：这条假设没有内容')

    const estimates = kept.map((mu) => dot(mu, qty))
    const covariance = kept.map((left) => kept.map((right) => dot(left, right)))
    const solution = solveSpd(covariance, estimates)
    if (solution === null) return empty(label, UNESTIMABLE_REASON)
    let quadratic = 0
    for (let index = 0; index < estimates.length; index += 1) quadratic += estimates[index] * solution[index]
    const f = quadratic / df1 / mse

    if (df1 === 1) {
      const estimate = estimates[0]
      const se = Math.sqrt(mse * covariance[0][0])
      const t = se > 0 ? estimate / se : Number.NaN
      return {
        ok: true,
        label,
        estimate,
        se,
        t,
        f: Number.isFinite(t) ? t * t : f,
        df1,
        df2,
        p: fP(Number.isFinite(t) ? t * t : f, 1, df2),
      }
    }
    return {
      ok: true,
      label,
      estimate: estimates,
      se: null,
      t: null,
      f,
      df1,
      df2,
      p: fP(f, df1, df2),
    }
  })
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—'
  const text = value.toFixed(3)
  return text === '-0.000' ? '0.000' : text
}

function formatP(p) {
  if (!Number.isFinite(p)) return 'p = —'
  if (p < 0.001) return 'p < 0.001'
  if (p > 0.999) return 'p > 0.999'
  return `p = ${p.toFixed(3)}`
}

/**
 * Chinese note lines for the results of `generalLinearTest`.
 *
 * Accepts the whole result array or one result, and returns one line per
 * hypothesis; a hypothesis that is not estimable gets the explanation instead
 * of numbers. Every line repeats the 「自定义对比（插件计算）」 prefix so a
 * single line copied out of the output is still self-explanatory.
 */
export function describeContrasts(result) {
  const list = Array.isArray(result) ? result : (result ? [result] : [])
  const lines = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const label = entry.label === undefined || entry.label === null || entry.label === ''
      ? '未命名的对比'
      : String(entry.label)
    const head = `自定义对比（插件计算）：「${label}」`
    if (entry.ok !== true) {
      // The estimability failure carries the wording the note is specified to
      // use; a different refusal (wrong coefficient count, no df) keeps its own
      // reason instead of being dressed up as an empty cell.
      const reason = typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : UNESTIMABLE_REASON
      lines.push(`${head}：不可估（${reason}）`)
      continue
    }
    if (Number(entry.df1) > 1) {
      lines.push(`${head} F = ${formatNumber(entry.f)}，df1 = ${entry.df1}，df2 = ${entry.df2}，${formatP(entry.p)}`)
      continue
    }
    lines.push(`${head} 估计 = ${formatNumber(entry.estimate)}，标准误 = ${formatNumber(entry.se)}，t = ${formatNumber(entry.t)}，df = ${entry.df2}，${formatP(entry.p)}`)
  }
  return lines.join('\n')
}
