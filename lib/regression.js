import { isUserMissing } from './missing.js'
/**
 * Collinearity diagnostics computed here rather than by the engine.
 *
 * PSPP 2.1.3's REGRESSION with /STATISTICS=TOL crashes about one run in six
 * inside gsl_blas_dsymm ("matrix/vector sizes are not conformant", exit 19)
 * and writes no output at all, while the identical model without TOL is
 * stable. So the plugin asks the engine for the tables it can produce
 * reliably and works tolerance and VIF out itself: with k predictors,
 * tolerance_k = 1 - R²_k from regressing x_k on the other predictors,
 * VIF_k = 1 / tolerance_k.
 */

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Least squares through the normal equations, with an intercept column. */
function solveNormalEquations(columns, y) {
  const k = columns.length + 1
  const a = Array.from({ length: k }, () => new Array(k + 1).fill(0))
  const n = y.length
  for (let i = 0; i < k; i += 1) {
    const left = i === 0 ? null : columns[i - 1]
    for (let j = 0; j < k; j += 1) {
      const right = j === 0 ? null : columns[j - 1]
      let sum = 0
      for (let row = 0; row < n; row += 1) {
        sum += (left === null ? 1 : left[row]) * (right === null ? 1 : right[row])
      }
      a[i][j] = sum
    }
    let sumY = 0
    for (let row = 0; row < n; row += 1) sumY += (left === null ? 1 : left[row]) * y[row]
    a[i][k] = sumY
  }
  // A relative pivot threshold: an absolute one calls a well-conditioned
  // system in the 1e6 range singular and misses near-collinearity at 1e-3.
  let scale = 0
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) scale = Math.max(scale, Math.abs(a[i][j]))
  }
  if (scale === 0) return null
  for (let col = 0; col < k; col += 1) {
    let pivot = col
    for (let row = col + 1; row < k; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-10 * scale) return null
    if (pivot !== col) {
      const swap = a[pivot]
      a[pivot] = a[col]
      a[col] = swap
    }
    const pivotValue = a[col][col]
    for (let j = col; j <= k; j += 1) a[col][j] /= pivotValue
    for (let row = 0; row < k; row += 1) {
      if (row === col) continue
      const factor = a[row][col]
      if (factor === 0) continue
      for (let j = col; j <= k; j += 1) a[row][j] -= factor * a[col][j]
    }
  }
  return a.map((row) => row[k])
}

/** R² of y on the given columns, through an intercept. */
/**
 * R² of `y` on `columns` plus an intercept, computed by projecting onto the
 * column space instead of solving the normal equations.
 *
 * The normal equations cannot answer this when the other predictors are
 * themselves collinear: the system is singular, yet the projection — and hence
 * 1 − R² — is perfectly well defined. Solving them anyway marked every
 * predictor 0.000/∞, including variables that carry independent information.
 *
 * Returns `{ r2, relative }`, `relative` being ||residual|| / ||y − mean||:
 * near 0 means y lies in the span of the others (true tolerance 0), and a
 * healthy value means the tolerance is genuinely estimable. `null` when y is
 * constant, where R² has no meaning.
 */
function projectionFit(columns, y) {
  const n = y.length
  const average = mean(y)
  let total = 0
  for (const value of y) total += (value - average) ** 2
  if (!(total > 0)) return null
  // Modified Gram–Schmidt with re-orthogonalisation: numerically stable enough
  // for the near-collinear cases that matter here, and it degrades to a basis
  // of the actual column space when columns are exact duplicates.
  const basis = []
  const addVector = (v) => {
    let vector = v.slice()
    let norm0 = 0
    for (const value of vector) norm0 += value * value
    norm0 = Math.sqrt(norm0)
    if (norm0 === 0) return
    for (let pass = 0; pass < 2; pass += 1) {
      for (const q of basis) {
        let dot = 0
        for (let i = 0; i < n; i += 1) dot += vector[i] * q[i]
        for (let i = 0; i < n; i += 1) vector[i] -= dot * q[i]
      }
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm <= 1e-11 * norm0) return
    basis.push(vector.map((value) => value / norm))
  }
  addVector(new Array(n).fill(1))
  for (const column of columns) addVector(column)
  let residual = 0
  for (let row = 0; row < n; row += 1) {
    let fitted = 0
    for (const q of basis) fitted += q[row] * dot(q, y)
    residual += (y[row] - fitted) ** 2
  }
  const r2 = Math.max(0, Math.min(1, 1 - residual / total))
  return { r2, relative: Math.sqrt(residual / total) }
}

function dot(left, right) {
  let sum = 0
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i]
  return sum
}

export function formatDiagnostic(value) {
  if (!Number.isFinite(value)) return '—'
  if (value >= 100) return value.toFixed(1)
  return value.toFixed(3)
}

/**
 * Tolerance and VIF for every predictor in the model.
 *
 * Returns `{ title, matrix, notes }` shaped like the other tables the plugin
 * builds, or null when the model has too few usable cases.
 */
export function collinearityTable(dataset, options = {}) {
  const dependent = options.dependent
  const independents = Array.isArray(options.independents) ? options.independents : []
  if (!dataset || !dependent || independents.length === 0) return null
  const index = (name) => dataset.variables.findIndex((variable) => variable.name === name)
  const dependentIndex = index(dependent)
  if (dependentIndex < 0) return null
  const columns = []
  const names = []
  const labels = []
  for (const name of independents) {
    const at = index(name)
    if (at < 0) continue
    const variable = dataset.variables[at]
    if (variable.type !== 'numeric') continue
    columns.push([])
    names.push(name)
    labels.push(variable.label || name)
    void at
  }
  if (columns.length === 0) return null
  const yValues = []
  const usable = []
  for (const row of dataset.rows) {
    const value = row[dependentIndex]
    if (value === null || value === undefined) continue
    if (isUserMissing(dataset.variables[dependentIndex], value)) continue
    const values = []
    let complete = true
    for (const name of names) {
      const at = index(name)
      const cell = row[at]
      if (cell === null || cell === undefined) { complete = false; break }
      // The same missing-value codes the table builder drops: a 999 kept here
      // moved the tolerance from 0.911 to 0.728.
      if (isUserMissing(dataset.variables[at], cell)) { complete = false; break }
      values.push(Number(cell))
    }
    if (!complete) continue
    if (!values.every((entry) => Number.isFinite(entry))) continue
    yValues.push(Number(value))
    usable.push(values)
  }
  if (usable.length <= names.length + 1) {
    return {
      title: '共线性诊断（插件计算）',
      matrix: [['变量', '容忍度', 'VIF'], ...labels.map((label) => [label, '—', '—'])],
      notes: [`有效个案 ${usable.length} 例，不足以估计 ${names.length} 个预测变量的容忍度（至少要 ${names.length + 2} 例）`],
    }
  }
  for (let col = 0; col < names.length; col += 1) {
    columns[col] = usable.map((values) => values[col])
  }
  const matrix = [['变量', '容忍度', 'VIF']]
  const notes = []
  if (names.length === 1) {
    notes.push('模型只有一个预测变量，容忍度恒为 1、VIF 恒为 1；PSPP 自己在这种情况下会打印 +Infinit 或 NaN')
  }
  // When two *other* predictors are perfectly correlated, every tolerance in the
  // model collapses to 0 — including the predictors that are themselves fine.
  // Naming the pair is what tells the user which variable to drop; without it
  // the whole table just says "完全共线" on every row and blames the wrong one.
  const pairNotes = []
  const constantNotes = []
  // One constant predictor reaches this function from two directions: its own
  // row (projectionFit returns null) and every pair it forms. Pushing the note
  // from both ends printed the same sentence up to N times.
  const constantSeen = new Set()
  const noteConstant = (label) => {
    if (constantSeen.has(label)) return
    constantSeen.add(label)
    constantNotes.push(`${label} 是常数（所有个案取值相同），容忍度无法定义：先把它从模型里去掉`)
  }
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) {
      const a = columns[left]
      const b = columns[right]
      const avgA = mean(a)
      const avgB = mean(b)
      let sxy = 0
      let sxx = 0
      let syy = 0
      for (let row = 0; row < a.length; row += 1) {
        sxy += (a[row] - avgA) * (b[row] - avgB)
        sxx += (a[row] - avgA) ** 2
        syy += (b[row] - avgB) ** 2
      }
      if (sxx === 0 || syy === 0) {
        noteConstant(sxx === 0 ? labels[left] : labels[right])
        continue
      }
      const r = sxy / Math.sqrt(sxx * syy)
      if (Math.abs(r) >= 1 - 1e-9) {
        pairNotes.push(`${labels[left]} 与 ${labels[right]} 完全相关（r = ${r.toFixed(3)}），两者的容忍度都会是 0：先删掉其中一个`)
      }
    }
  }
  for (let col = 0; col < names.length; col += 1) {
    const others = columns.filter((_, at) => at !== col)
    if (others.length === 0) {
      matrix.push([labels[col], '1.000', '1.000'])
      continue
    }
    const fit = projectionFit(others, columns[col])
    if (fit === null) {
      // A constant predictor cannot be regressed on anything: tolerance is
      // undefined rather than zero, and saying 0 would invite the user to drop
      // a variable the model needs.
      matrix.push([labels[col], '—', '—'])
      noteConstant(labels[col])
      continue
    }
    if (fit.relative <= 1e-9) {
      // The variable lies in the span of the others: tolerance really is 0.
      matrix.push([labels[col], '0.000', '∞'])
      continue
    }
    const tolerance = Math.max(0, 1 - fit.r2)
    matrix.push([
      labels[col],
      formatDiagnostic(tolerance),
      tolerance <= 1e-9 ? '∞' : formatDiagnostic(1 / tolerance),
    ])
  }
  notes.push(...constantNotes)
  notes.push(...pairNotes)
  notes.push('容忍度 = 1 − R²（该预测变量对其余预测变量回归）；VIF = 1 / 容忍度。容忍度 < 0.1（VIF > 10）通常认为存在明显共线性')
  if (!matrix.slice(1).some((row) => row[1] !== '—')) {
    notes.push('数据不足以估计共线性，所有单元格为「—」')
  }
  return { title: '共线性诊断（插件计算）', matrix, notes }
}

/**
 * Durbin-Watson for the same model the engine just fitted.
 *
 * PSPP's REGRESSION prints no DW at all, and its /SAVE only offers PED/RESID,
 * so the statistic is computed here from residuals in case order. Case order
 * matters: after a SORT the number describes the sorted file, which is why the
 * note says so out loud.
 */
/**
 * Orthonormal basis of the column space of [1, ...columns], built the same way
 * as in projectionFit. Leverage is the diagonal of the hat matrix, and with an
 * orthonormal basis Q it is simply sum_q q_i² — which stays correct when the
 * predictors are collinear, where inverting X'X is not.
 */
function hatDiagonal(columns, n) {
  const basis = []
  const add = (v) => {
    const vector = v.slice()
    let norm0 = 0
    for (const value of vector) norm0 += value * value
    norm0 = Math.sqrt(norm0)
    if (norm0 === 0) return
    for (let pass = 0; pass < 2; pass += 1) {
      for (const q of basis) {
        let projection = 0
        for (let i = 0; i < n; i += 1) projection += vector[i] * q[i]
        for (let i = 0; i < n; i += 1) vector[i] -= projection * q[i]
      }
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm <= 1e-11 * norm0) return
    basis.push(vector.map((value) => value / norm))
  }
  add(new Array(n).fill(1))
  for (const column of columns) add(column)
  const hat = new Array(n).fill(0)
  for (const q of basis) {
    for (let i = 0; i < n; i += 1) hat[i] += q[i] * q[i]
  }
  return { hat, rank: basis.length }
}

/**
 * Influence diagnostics the engine cannot print: PSPP's `/SAVE=` accepts only
 * PRED RESID (probed: "expecting PRED or RESID"), so leverage, Cook's D and the
 * Mahalanobis distance of the predictor vector are computed here.
 */
export function influenceTable(dataset, options = {}) {
  const dependent = options.dependent
  const independents = Array.isArray(options.independents) ? options.independents : []
  if (!dataset || !dependent || independents.length === 0) return null
  const index = (name) => dataset.variables.findIndex((variable) => variable.name === name)
  const dependentIndex = index(dependent)
  if (dependentIndex < 0) return null
  const names = []
  const columns = []
  for (const name of independents) {
    const at = index(name)
    if (at < 0) continue
    const variable = dataset.variables[at]
    if (variable.type !== 'numeric') continue
    names.push({ name, at })
    columns.push([])
  }
  if (names.length === 0) return null
  const y = []
  const caseNumbers = []
  dataset.rows.forEach((row, rowIndex) => {
    const value = row[dependentIndex]
    if (value === null || value === undefined) return
    if (isUserMissing(dataset.variables[dependentIndex], value)) return
    const values = []
    for (const entry of names) {
      const cell = row[entry.at]
      if (cell === null || cell === undefined) return
      if (isUserMissing(dataset.variables[entry.at], cell)) return
      values.push(Number(cell))
    }
    if (!values.every((entry) => Number.isFinite(entry))) return
    y.push(Number(value))
    caseNumbers.push(rowIndex + 1)
    for (let col = 0; col < names.length; col += 1) columns[col].push(values[col])
  })
  const n = y.length
  if (n <= names.length + 1) return null
  const { hat, rank } = hatDiagonal(columns, n)
  if (rank < names.length + 1) return null
  const fit = solveNormalEquations(columns, y)
  if (!fit) return null
  const residuals = []
  let sse = 0
  for (let row = 0; row < n; row += 1) {
    let predicted = fit[0]
    for (let col = 0; col < names.length; col += 1) predicted += fit[col + 1] * columns[col][row]
    const residual = y[row] - predicted
    residuals.push(residual)
    sse += residual * residual
  }
  const p = rank
  const df = n - p
  const mse = sse / df
  if (!(mse >= 0)) return null
  // "Perfect fit" has to be judged relative to the spread of the dependent
  // variable: solving the normal equations leaves residuals around 1e-15 even
  // when the model reproduces the data exactly, and dividing those by a
  // likewise-tiny residual mean squares turns rounding noise into a Cook's D
  // that looks meaningful.
  const mean = y.reduce((total, value) => total + value, 0) / n
  const sst = y.reduce((total, value) => total + (value - mean) ** 2, 0)
  const perfectFit = !(mse > 0) || sse <= Number.EPSILON * Math.max(sst, 1) * n
  const rows = []
  const cookLimit = 4 / n
  const leverageLimit = (2 * p) / n
  for (let row = 0; row < n; row += 1) {
    const h = Math.min(0.999999, Math.max(0, hat[row]))
    const denominator = (1 - h) ** 2
    // A perfect fit leaves the residual variance at zero, so Cook's D has no
    // denominator to stand on: report it as undefined instead of inventing a
    // leverage flag (the leverage itself is fine and still shown).
    const cook = perfectFit || denominator <= 0
      ? null
      : (residuals[row] ** 2 * h) / (p * mse * denominator)
    // With an intercept in the model, the leverage and the Mahalanobis distance
    // of the predictor vector are the same thing up to an affine map.
    const mahalanobis = Math.sqrt(Math.max(0, (n - 1) * (h - 1 / n)))
    const flags = []
    if (cook == null) flags.push(perfectFit ? '完美拟合，Cook D 无定义' : '杠杆等于 1，Cook D 无定义')
    else if (cook > cookLimit) flags.push('Cook D 超 4/n')
    if (h > (3 * p) / n) flags.push('高杠杆')
    rows.push({ case: caseNumbers[row], hat: h, cook, mahalanobis, flag: flags.join('、') })
  }
  const ranked = rows.slice().sort((left, right) => (right.cook ?? -1) - (left.cook ?? -1))
  const shown = ranked.slice(0, 20)
  const matrix = [['个案号', '杠杆值', 'Cook D', "Mahalanobis 距离", '标记']]
  for (const entry of shown) {
    matrix.push([
      String(entry.case),
      entry.hat.toFixed(4),
      Number.isFinite(entry.cook) ? entry.cook.toFixed(4) : '—',
      entry.mahalanobis.toFixed(3),
      entry.flag || '',
    ])
  }
  const flagged = rows.filter((entry) => entry.cook > cookLimit).length
  const notes = [
    `按 Cook's D 从大到小列出前 ${shown.length} 个个案（共 ${n} 个有效个案、${names.length} 个预测变量）`,
    `判据：Cook's D > 4/n = ${cookLimit.toFixed(4)} 视为强影响点（这里 ${flagged} 个）；杠杆值 > 2p/n = ${leverageLimit.toFixed(4)} 提示高杠杆，> 3p/n = ${((3 * p) / n).toFixed(4)} 则更高`,
    "PSPP 的 /SAVE= 只认 PRED 与 RESID，杠杆值、Cook's D 与 Mahalanobis 距离由插件按帽子矩阵算；Mahalanobis 距离只针对预测变量本身（n−1)(h−1/n) 的开方",
    '个案号从 1 起、按数据文件当前行序；改了排序后这些编号要重算',
  ]
  return { title: "影响诊断（插件计算）", matrix, notes, n, flagged, cookLimit, forTable: names.length }
}

export function durbinWatsonTable(dataset, options = {}) {
  const dependent = options.dependent
  const independents = Array.isArray(options.independents) ? options.independents : []
  if (!dataset || !dependent || independents.length === 0) return null
  const index = (name) => dataset.variables.findIndex((variable) => variable.name === name)
  const dependentIndex = index(dependent)
  if (dependentIndex < 0) return null
  const names = []
  const columns = []
  for (const name of independents) {
    const at = index(name)
    if (at < 0) continue
    const variable = dataset.variables[at]
    if (variable.type !== 'numeric') continue
    names.push({ name, at, label: variable.label || name })
    columns.push([])
  }
  if (names.length === 0) return null
  const yValues = []
  for (const row of dataset.rows) {
    const value = row[dependentIndex]
    if (value === null || value === undefined) continue
    if (isUserMissing(dataset.variables[dependentIndex], value)) continue
    const values = []
    let complete = true
    for (const entry of names) {
      const cell = row[entry.at]
      if (cell === null || cell === undefined) { complete = false; break }
      if (isUserMissing(dataset.variables[entry.at], cell)) { complete = false; break }
      values.push(Number(cell))
    }
    if (!complete) continue
    if (!values.every((candidate) => Number.isFinite(candidate))) continue
    yValues.push(Number(value))
    for (let col = 0; col < names.length; col += 1) columns[col].push(values[col])
  }
  if (yValues.length <= names.length + 1) return null
  const fit = solveNormalEquations(columns, yValues)
  if (!fit) return null
  const residuals = []
  for (let row = 0; row < yValues.length; row += 1) {
    let predicted = fit[0]
    for (let col = 0; col < names.length; col += 1) predicted += fit[col + 1] * columns[col][row]
    residuals.push(yValues[row] - predicted)
  }
  let numerator = 0
  for (let row = 1; row < residuals.length; row += 1) {
    const delta = residuals[row] - residuals[row - 1]
    numerator += delta * delta
  }
  let denominator = 0
  for (const value of residuals) denominator += value * value
  if (!(denominator > 0)) return null
  const dw = numerator / denominator
  const n = residuals.length
  const k = names.length
  // Savin-White bounds at the 5% level, close enough for the "is it in the
  // inconclusive zone" sentence a reader actually uses.
  const table = { 1: [1.65, 1.69], 2: [1.63, 1.72], 3: [1.59, 1.76], 4: [1.55, 1.80], 5: [1.52, 1.82] }[k]
  const notes = [
    `DW = ${dw.toFixed(3)}（n = ${n}，预测变量 ${k} 个）；PSPP 不打印这个统计量，这里是按残差在数据顺序上自算的`,
    'DW 只有落在 0–4 之间才有意义：接近 2 表示没有一阶自相关，接近 0 表示正自相关，接近 4 表示负自相关',
    '顺序按数据文件当前的行序；如果刚做过排序，这个数字描述的是排序后的顺序',
  ]
  if (n < 15) {
    // The Savin-White bounds below are tabulated from n = 15 up; quoting them
    // for a dozen cases would dress up a number the table does not cover.
    notes.push(`n = ${n} 小于 15，界限表不适用：只能看数值本身（2 附近无自相关，靠近 0 正自相关，靠近 4 负自相关）`)
  } else if (table) {
    const [low, high] = table
    const verdict = dw < low ? '小于 5% 下限，存在正自相关的迹象' : dw > 4 - low ? '大于 4−下限，存在负自相关的迹象' : dw <= high ? '落在不确定区间' : '落在无自相关区间'
    notes.push(`n = ${n}、${k} 个预测变量对应的 5% 界限约为 ${low} / ${high}：DW ${dw.toFixed(3)} ${verdict}`)
  }
  return {
    title: 'Durbin-Watson（插件计算）',
    matrix: [['统计量', '值'], ['Durbin-Watson', dw.toFixed(3)], ['个案数', String(n)], ['预测变量数', String(k)]],
    notes,
  }
}

/**
 * Residual diagnostics the engine does not draw.
 *
 * PSPP prints the numbers but no plots, so the two pictures SPSS offers on its
 * Linear Regression → Plots tab are drawn here from the same least-squares fit
 * the other diagnostics use: residuals against fitted values (is the spread
 * even?), and a normal P-P plot of the standardised residuals (are they normal?).
 * Both are plain scatter models, so they go through the same renderer as every
 * other chart and can be exported or put in a report book like any chart.
 */
export function regressionPlots(dataset, options = {}) {
  const dependent = options.dependent
  const independents = Array.isArray(options.independents) ? options.independents : []
  if (!dataset || !dependent || independents.length === 0) return []
  const index = (name) => dataset.variables.findIndex((variable) => variable.name === name)
  const dependentIndex = index(dependent)
  if (dependentIndex < 0) return []
  const names = []
  const columns = []
  for (const name of independents) {
    const at = index(name)
    if (at < 0) continue
    if (dataset.variables[at].type !== 'numeric') continue
    names.push({ name, at })
    columns.push([])
  }
  if (names.length === 0) return []
  const y = []
  dataset.rows.forEach((row) => {
    const value = row[dependentIndex]
    if (value === null || value === undefined) return
    if (isUserMissing(dataset.variables[dependentIndex], value)) return
    const values = []
    for (const entry of names) {
      const cell = row[entry.at]
      if (cell === null || cell === undefined) return
      if (isUserMissing(dataset.variables[entry.at], cell)) return
      values.push(Number(cell))
    }
    if (!values.every((entry) => Number.isFinite(entry))) return
    y.push(Number(value))
    for (let col = 0; col < names.length; col += 1) columns[col].push(values[col])
  })
  const n = y.length
  if (n <= names.length + 1) return []
  const fit = solveNormalEquations(columns, y)
  if (!fit) return []
  const fitted = []
  const residuals = []
  let sse = 0
  for (let row = 0; row < n; row += 1) {
    let predicted = fit[0]
    for (let col = 0; col < names.length; col += 1) predicted += fit[col + 1] * columns[col][row]
    const residual = y[row] - predicted
    fitted.push(predicted)
    residuals.push(residual)
    sse += residual * residual
  }
  const df = n - (names.length + 1)
  const mse = df > 0 ? sse / df : 0
  const plots = []
  if (mse > 0) {
    plots.push({
      kind: 'scatter',
      title: `${dependent} 的残差散点图`,
      xLabel: '未标准化预测值',
      yLabel: '未标准化残差',
      points: fitted.map((value, at) => [round4(value), round4(residuals[at])]),
      zeroLine: true,
    })
    const root = Math.sqrt(mse)
    const z = residuals.map((value) => value / root).sort((left, right) => left - right)
    // Expected cumulative probability of the i-th order statistic, against the
    // observed one; the diagonal is what "perfectly normal" would look like.
    const points = z.map((value, at) => [round4(standardNormalCdf(value)), round4((at + 0.5) / z.length)])
    plots.push({
      kind: 'scatter',
      title: `${dependent} 的标准化残差正态 P-P 图`,
      xLabel: '期望累积概率',
      yLabel: '实测累积概率',
      points,
      diagonal: true,
    })
  }
  return plots
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
function standardNormalCdf(value) {
  const z = Math.abs(value)
  const t = 1 / (1 + 0.3275911 * z)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const cdf = 1 - poly * Math.exp(-z * z)
  return value >= 0 ? (1 + cdf) / 2 : (1 - cdf) / 2
}
