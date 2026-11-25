// 多维标度（SPSS 的「分析 → 降维 → 多维标度」，ALSCAL / PROXIMITIES）。
//
// PSPP 2.1.3 没有 PROXIMITIES、没有 ALSCAL，所以距离矩阵与坐标都在插件里算。
// 这里做的是**经典多维标度**（Torgerson / PCoA）：先把距离平方做双中心化
// B = −½·J·D²·J，再取 B 的前 k 个特征对，坐标 X = V·√Λ。
//
// 与 SPSS 的 ALSCAL 差别（写进注文，不假装等价）：ALSCAL 最小化的是
// Kruskal 的 stress，属于迭代的度量/非度量标度；经典解一步出结果，两者在
// 距离完全来自欧氏空间时一致，否则坐标会略有差异。这里报的 Stress 用的是
// 「重构距离与原始距离」的归一化残差，口径单独写清楚。
import { isUserMissing } from './missing.js'

export const MAX_OBJECTS = 120
export const MAX_DIMENSIONS = 3
export const DISTANCES = ['euclidean', 'sqeuclidean', 'cityblock']

const fixed = (value, digits = 4) => Number(value).toFixed(digits)
const blank = (value) => value === null || value === undefined || value === ''

function numeric(variable) {
  return variable?.type !== 'string'
}

function columnOf(dataset, name) {
  const index = dataset.variables.findIndex((variable) => variable.name === name)
  if (index < 0) throw new Error(`没有这个变量：${name}`)
  return index
}

// 对称矩阵的 Jacobi 特征分解：小矩阵（对象 ≤ 120）用它比幂迭代稳，也不会
// 因为重复特征值丢掉某一维（幂迭代 + 收缩那套在多重对应分析里吃过一次亏）。
function jacobiEigen(matrix, iterations = 100) {
  const size = matrix.length
  const a = matrix.map((line) => [...line])
  const vectors = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)))
  for (let sweep = 0; sweep < iterations; sweep += 1) {
    let off = 0
    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) off += a[row][column] ** 2
    }
    if (off < 1e-24) break
    for (let p = 0; p < size - 1; p += 1) {
      for (let q = p + 1; q < size; q += 1) {
        if (Math.abs(a[p][q]) < 1e-18) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < size; k += 1) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < size; k += 1) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < size; k += 1) {
          const vkp = vectors[k][p]
          const vkq = vectors[k][q]
          vectors[k][p] = c * vkp - s * vkq
          vectors[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const pairs = Array.from({ length: size }, (_, index) => ({ value: a[index][index], vector: vectors.map((line) => line[index]) }))
  pairs.sort((left, right) => right.value - left.value)
  return pairs
}

function distanceBetween(left, right, measure) {
  let sum = 0
  let block = 0
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index]
    if (measure === 'cityblock') block += Math.abs(delta)
    else sum += delta * delta
  }
  if (measure === 'sqeuclidean') return sum
  if (measure === 'cityblock') return block
  return Math.sqrt(sum)
}

function distanceName(measure) {
  switch (measure) {
    case 'sqeuclidean': return '平方欧氏距离'
    case 'cityblock': return '曼哈顿距离'
    default: return '欧氏距离'
  }
}

export function computeMds(dataset, options = {}) {
  const names = Array.isArray(options.variables) ? options.variables.map((entry) => String(entry)) : []
  if (names.length === 0) throw new Error('多维标度要至少选一个数值变量')
  const measure = String(options.distance ?? 'euclidean').toLowerCase()
  if (!DISTANCES.includes(measure)) {
    throw new Error(`不认识的距离测度：${options.distance}（可用：${DISTANCES.join(' / ')}）`)
  }
  const dimensions = options.dimensions === undefined ? 2 : Number(options.dimensions)
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
    throw new Error(`维数要在 1 到 ${MAX_DIMENSIONS} 之间`)
  }

  const indexes = names.map((name) => {
    const index = columnOf(dataset, name)
    if (!numeric(dataset.variables[index])) throw new Error(`多维标度要求数值变量：${name} 是文本变量（先转成数值）`)
    return index
  })

  // 整例剔除之后才建距离矩阵：只剔一列会让「个案 i 与 j 的距离」用不同的
  // 变量集合，那已经不是同一个空间了。
  const objects = []
  let dropped = 0
  for (const row of dataset.rows) {
    const values = []
    let usable = true
    for (let slot = 0; slot < indexes.length; slot += 1) {
      const raw = row[indexes[slot]]
      const variable = dataset.variables[indexes[slot]]
      if (blank(raw) || isUserMissing(variable, raw)) { usable = false; break }
      const value = Number(raw)
      if (!Number.isFinite(value)) { usable = false; break }
      values.push(value)
    }
    if (!usable) { dropped += 1; continue }
    objects.push(values)
  }
  if (objects.length < 3) throw new Error(`可用个案太少：${objects.length} 个（多维标度至少要 3 个）`)
  if (objects.length > MAX_OBJECTS) {
    throw new Error(`个案太多：${objects.length} 个，多维标度在这里最多 ${MAX_OBJECTS} 个（先抽样，或者先聚成几类）`)
  }

  // 标准化是可选的：量纲差异大的变量不标准化时，距离会被大方差变量主导。
  const standardized = options.standardize === true
  const columns = names.map((_, slot) => objects.map((entry) => entry[slot]))
  const scales = columns.map((values) => {
    if (!standardized) return { mean: 0, sd: 1 }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    return { mean, sd: variance > 0 ? Math.sqrt(variance) : 1 }
  })
  const matrix = objects.map((entry) => entry.map((value, slot) => (value - scales[slot].mean) / scales[slot].sd))

  const count = matrix.length
  const distances = Array.from({ length: count }, () => new Array(count).fill(0))
  for (let row = 0; row < count; row += 1) {
    for (let column = row + 1; column < count; column += 1) {
      const value = distanceBetween(matrix[row], matrix[column], measure)
      distances[row][column] = value
      distances[column][row] = value
    }
  }

  // B = −½ · J · D² · J，J = I − 11ᵀ/n。先算行平方和，避免真的乘三个矩阵。
  const squared = distances.map((line) => line.map((value) => value * value))
  const rowMeans = squared.map((line) => line.reduce((sum, value) => sum + value, 0) / count)
  const grandMean = rowMeans.reduce((sum, value) => sum + value, 0) / count
  const centered = squared.map((line, row) => line.map((value, column) => -0.5 * (value - rowMeans[row] - rowMeans[column] + grandMean)))

  const pairs = jacobiEigen(centered)
  const positive = pairs.filter((pair) => pair.value > 1e-12)
  const total = positive.reduce((sum, pair) => sum + pair.value, 0)
  if (!(total > 1e-12)) throw new Error('距离矩阵退化：所有个案的取值都一样，没有可以标度的结构')

  const used = Math.min(dimensions, positive.length)
  const coordinates = Array.from({ length: count }, () => new Array(used).fill(0))
  for (let slot = 0; slot < used; slot += 1) {
    const scale = Math.sqrt(positive[slot].value)
    for (let row = 0; row < count; row += 1) coordinates[row][slot] = positive[slot].vector[row] * scale
  }

  // Stress：按选定的维数把坐标还原成距离，和原始距离比。
  let residual = 0
  let baseline = 0
  for (let row = 0; row < count; row += 1) {
    for (let column = row + 1; column < count; column += 1) {
      let sum = 0
      for (let slot = 0; slot < used; slot += 1) sum += (coordinates[row][slot] - coordinates[column][slot]) ** 2
      const fittedDistance = Math.sqrt(sum)
      residual += (distances[row][column] - fittedDistance) ** 2
      baseline += distances[row][column] ** 2
    }
  }
  const stress = baseline > 0 ? Math.sqrt(residual / baseline) : Number.NaN

  const eigenvalues = positive.slice(0, Math.max(used, 3)).map((pair) => pair.value)
  const explained = eigenvalues.map((value) => value / total)

  const objectLabels = []
  for (let row = 0; row < count; row += 1) objectLabels.push(String(row + 1))

  const notes = []
  notes.push(`用的是经典多维标度（Torgerson 双中心化 + 特征分解），不是 SPSS 那个迭代的 ALSCAL：距离真的来自欧氏空间时两者一致，否则坐标会略有差异，别把 Stress 当作 ALSCAL 的 Kruskal stress 去比对。`)
  notes.push(`距离测度：${distanceName(measure)}；${standardized ? '变量已按 z 分数标准化' : '变量未标准化（量纲大的变量会主导距离，需要的话在对话框里勾标准化）'}。`)
  notes.push(`Stress = ${Number.isFinite(stress) ? fixed(stress, 6) : '—'}（按 ${used} 维还原距离的归一化残差，0 表示完美还原）。`)
  if (positive.length < dimensions) {
    notes.push(`只有 ${positive.length} 个正特征值，所以实际画了 ${used} 维：距离矩阵里没有更多可恢复的结构。`)
  }
  if (dropped > 0) notes.push(`有 ${dropped} 个案的选中变量含缺失值，按整例剔除。`)
  notes.push('轴的方向与符号不唯一（旋转、翻转后距离不变），解释时看相对位置，不要看单个数。')

  return {
    variables: names,
    distance: measure,
    distanceLabel: distanceName(measure),
    standardized,
    dimensions: used,
    cases: count,
    dropped,
    coordinates: coordinates.map((point, index) => point.map((value) => Number(value))),
    labels: objectLabels,
    eigenvalues,
    explained,
    stress,
    notes,
    model: {
      variables: names,
      distance: measure,
      dimensions: used,
      cases: count,
      dropped,
      eigenvalues,
      explained,
      stress,
      coordinates: coordinates.map((point) => point.map((value) => value)),
      labels: objectLabels,
    },
  }
}
