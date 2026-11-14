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
    const values = []
    let complete = true
    for (const name of names) {
      const at = index(name)
      const cell = row[at]
      if (cell === null || cell === undefined) { complete = false; break }
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
        const flat = sxx === 0 ? labels[left] : labels[right]
        pairNotes.push(`${flat} 是常数（所有个案取值相同），容忍度无法定义：先把它从模型里去掉`)
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
      constantNotes.push(`${labels[col]} 是常数（所有个案取值相同），容忍度无法定义：先把它从模型里去掉`)
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
