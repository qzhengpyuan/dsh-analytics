// Hierarchical clustering. PSPP 2.1.3 only has QUICK CLUSTER (k-means), so both
// the merge tree and the dendrogram are computed here.
//
// The distances are updated with the Lance–Williams recurrence rather than
// recomputed from the cases, so a few hundred cases stay fast: every merge is
// O(n) instead of O(n^2 · p).

export const LINKAGES = ['average', 'complete', 'single', 'ward']
export const MEASURES = ['euclidean', 'sqeuclidean', 'cityblock', 'chebychev']

const MEASURE_LABELS = {
  euclidean: '欧氏距离',
  sqeuclidean: '欧氏距离平方',
  cityblock: '绝对值距离',
  chebychev: '最大值距离',
}

const LINKAGE_LABELS = {
  average: '组间平均连接',
  complete: '组间最长连接',
  single: '最短距离法',
  ward: 'Ward 法（离差平方和）',
}

function distance(left, right, measure) {
  let sum = 0
  let peak = 0
  for (let i = 0; i < left.length; i += 1) {
    const gap = Math.abs(left[i] - right[i])
    if (gap > peak) peak = gap
    if (measure === 'cityblock') sum += gap
    else if (measure !== 'chebychev') sum += gap * gap
  }
  if (measure === 'cityblock') return sum
  if (measure === 'chebychev') return peak
  if (measure === 'sqeuclidean') return sum
  return Math.sqrt(sum)
}

/**
 * One merge step of the Lance–Williams family.
 *
 * ward needs the squared Euclidean distance to mean what SPSS means by it, so
 * the caller hands in `ward: true` only when the measure is squared.
 */
function lanceWilliams(linkage, dLeft, dRight, dPair, sizeLeft, sizeRight, sizeOther) {
  if (linkage === 'single') return Math.min(dLeft, dRight)
  if (linkage === 'complete') return Math.max(dLeft, dRight)
  if (linkage === 'ward') {
    const total = sizeLeft + sizeRight + sizeOther
    return ((sizeLeft + sizeOther) * dLeft + (sizeRight + sizeOther) * dRight - sizeOther * dPair) / total
  }
  return (sizeLeft * dLeft + sizeRight * dRight) / (sizeLeft + sizeRight)
}

function numericColumns(dataset, names) {
  const chosen = []
  for (const name of names) {
    const variable = (dataset.variables ?? []).find((entry) => entry.name === name)
    if (!variable) throw new Error(`没有这个变量：${name}`)
    if (variable.type !== 'numeric') throw new Error(`聚类变量要求数值变量：${name} 是文本变量`)
    chosen.push({ name, index: dataset.variables.indexOf(variable) })
  }
  if (chosen.length === 0) throw new Error('至少要选一个聚类变量')
  return chosen
}

/**
 * Cluster the open data set.
 *
 * Returns the agglomeration schedule as a table, the membership of every case
 * for the requested number of clusters, and the merge tree the dendrogram needs.
 */
export function computeHierarchicalClustering(dataset, options = {}) {
  const names = Array.isArray(options.variables) ? options.variables.filter(Boolean) : []
  const columns = numericColumns(dataset, names)
  const measure = String(options.measure ?? 'euclidean').toLowerCase()
  const linkage = String(options.linkage ?? 'average').toLowerCase()
  if (!MEASURES.includes(measure)) throw new Error(`不认识的距离测度：${measure}（可用：${MEASURES.join('、')}）`)
  if (!LINKAGES.includes(linkage)) throw new Error(`不认识的连接方法：${linkage}（可用：${LINKAGES.join('、')}）`)
  if (linkage === 'ward' && measure !== 'sqeuclidean') {
    // Ward is defined on squared Euclidean distance; accepting euclidean would
    // silently change the merge order instead of telling the user.
    throw new Error('Ward 法要用「欧氏距离平方」，请在距离测度里换过来')
  }

  const vectors = []
  const caseNumbers = []
  ;(dataset.rows ?? []).forEach((row, index) => {
    const point = columns.map((column) => row[column.index])
    if (point.some((value) => value === null || value === undefined || value === '' || Number.isNaN(Number(value)))) return
    vectors.push(point.map(Number))
    caseNumbers.push(index + 1)
  })
  const n = vectors.length
  if (n < 3) throw new Error(`系统聚类至少要 3 个个案，现在只有 ${n} 个`)
  if (n > 2000) throw new Error(`个案太多（${n} 个）：系统聚类最多处理 2000 个个案`)

  // The matrix is kept symmetric on both sides: the merge step reads
  // dist[left][other] where `other` may be smaller than `left`, and an
  // upper-triangle-only matrix silently returns 0 there.
  const dist = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const value = distance(vectors[i], vectors[j], measure)
      dist[i][j] = value
      dist[j][i] = value
    }
  }
  const size = new Array(n).fill(1)
  const alive = new Array(n).fill(true)
  const label = caseNumbers.map((value) => String(value))
  const firstSeen = new Array(n).fill(0)
  const merges = []
  const steps = []

  for (let stage = 1; stage < n; stage += 1) {
    let best = Infinity
    let left = -1
    let right = -1
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) continue
      for (let j = i + 1; j < n; j += 1) {
        if (!alive[j]) continue
        if (dist[i][j] < best) {
          best = dist[i][j]
          left = i
          right = j
        }
      }
    }
    if (left < 0) break
    merges.push({
      stage,
      left: label[left],
      right: label[right],
      coefficient: best,
      leftFirst: firstSeen[left],
      rightFirst: firstSeen[right],
    })
    steps.push({ stage, left, right, height: best, size: size[left] + size[right] })
    label[left] = `${label[left]},${label[right]}`
    for (let other = 0; other < n; other += 1) {
      if (!alive[other] || other === left || other === right) continue
      const updated = lanceWilliams(linkage, dist[left][other], dist[right][other], dist[left][right],
        size[left], size[right], size[other])
      dist[left][other] = updated
      dist[other][left] = updated
    }
    size[left] += size[right]
    alive[right] = false
    firstSeen[left] = stage
    firstSeen[right] = stage
    for (let other = 0; other < n; other += 1) {
      dist[right][other] = Infinity
      dist[other][right] = Infinity
    }
  }
  // "Next stage" is what SPSS prints: the stage at which the cluster formed here
  // is merged again, and 0 when it never is.
  const nextStage = new Array(merges.length).fill(0)
  const lastSeen = new Map()
  merges.forEach((entry, index) => {
    for (const key of [entry.left, entry.right]) {
      const previous = lastSeen.get(key)
      if (previous !== undefined) nextStage[previous] = entry.stage
      lastSeen.set(key, index)
    }
  })

  let k = Number(options.clusters ?? 3)
  if (!Number.isFinite(k)) k = 3
  k = Math.max(1, Math.min(n - 1, Math.trunc(k)))
  const parent = Array.from({ length: n }, (_, index) => index)
  const find = (index) => {
    let node = index
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }
  for (const step of steps.slice(0, n - k)) {
    const one = find(step.left)
    const two = find(step.right)
    if (one !== two) parent[two] = one
  }
  const roots = []
  const membership = vectors.map((_, index) => {
    const root = find(index)
    let slot = roots.indexOf(root)
    if (slot < 0) {
      roots.push(root)
      slot = roots.length - 1
    }
    return slot + 1
  })
  const sizes = roots.map(() => 0)
  for (const group of membership) sizes[group - 1] += 1

  const schedule = [['阶段', '合并的组（组 1）', '合并的组（组 2）', '系数', '首次出现的阶段（组 1）', '首次出现的阶段（组 2）', '下一步']]
  merges.forEach((entry, index) => {
    schedule.push([
      String(entry.stage),
      entry.left,
      entry.right,
      entry.coefficient.toFixed(3),
      String(entry.leftFirst),
      String(entry.rightFirst),
      String(nextStage[index]),
    ])
  })

  const members = [['个案', '组']]
  membership.forEach((group, index) => members.push([String(caseNumbers[index]), String(group)]))

  const countTable = [['组', '个案数']]
  sizes.forEach((count, index) => countTable.push([String(index + 1), String(count)]))

  const title = '系统聚类分析'
  return {
    title,
    k,
    tables: [
      {
        caption: `凝聚状态表（${LINKAGE_LABELS[linkage]}，${MEASURE_LABELS[measure]}，${columns.length} 个变量，${n} 个个案）`,
        matrix: schedule,
      },
      { caption: `聚类成员（分成 ${k} 组）`, matrix: members },
      { caption: '各组个案数', matrix: countTable },
    ],
    notes: [
      `方法：${LINKAGE_LABELS[linkage]}；距离：${MEASURE_LABELS[measure]}；参与聚类的变量：${columns.map((column) => column.name).join('、')}。`,
      '系数一列是这一阶段被合并的两组之间的距离（Ward 法是离差平方和的增量），“下一步”指这个新组下一次被合并的阶段，0 表示树到这里结束。',
      `缺失值：只要有任一聚类变量缺失，这个个案就不参与聚类（现在 ${n} 个有效个案）。`,
    ],
    model: {
      n,
      k,
      linkage,
      measure,
      variables: columns.map((column) => column.name),
      merges,
      membership,
      sizes,
      heights: steps.map((step) => step.height),
      labels: caseNumbers.map((value) => String(value)),
    },
  }
}

/**
 * The dendrogram: leaves on the bottom, each merge drawn as a U whose top is at
 * the merge coefficient. Case numbers are printed when they still fit.
 */
export function computeDendrogram(dataset, options = {}) {
  const built = computeHierarchicalClustering(dataset, options)
  const { model } = built
  // Rebuild the hierarchy from the merge list: every entry names the combined
  // labels of the two groups it joins, so a map from label to node is enough.
  const byLabel = new Map()
  for (let index = 0; index < model.n; index += 1) {
    byLabel.set(String(index + 1), { id: index, children: [], height: 0, leaves: 1 })
  }
  let root = null
  model.merges.forEach((entry, index) => {
    const left = byLabel.get(entry.left)
    const right = byLabel.get(entry.right)
    if (!left || !right) throw new Error(`系统聚类的树不对：找不到第 ${entry.stage} 阶段合并的组`)
    const node = {
      id: model.n + index,
      children: [left, right],
      height: entry.coefficient,
      leaves: left.leaves + right.leaves,
    }
    byLabel.delete(entry.left)
    byLabel.delete(entry.right)
    byLabel.set(`${entry.left},${entry.right}`, node)
    root = node
  })
  if (!root) throw new Error('系统聚类没有产生合并，画不出树状图')
  // Leaves sit in label order, then every parent sits over the middle of its
  // two children — the standard right-angle dendrogram layout.
  let leaf = 0
  const walk = (node) => {
    if (!node.children.length) {
      node.x = leaf
      leaf += 1
      return
    }
    walk(node.children[0])
    walk(node.children[1])
    node.x = (node.children[0].x + node.children[1].x) / 2
  }
  walk(root)
  const maxHeight = Math.max(...model.merges.map((entry) => entry.coefficient), 1e-9)
  return {
    kind: 'dendrogram',
    root,
    leaves: leaf,
    maxHeight,
    title: `${model.variables.join('、')} 的系统聚类树状图（${LINKAGE_LABELS[model.linkage]}）`,
    xLabel: '个案',
    yLabel: `合并距离（${MEASURE_LABELS[model.measure]}）`,
    membership: model.membership,
    k: model.k,
    linkage: model.linkage,
    measure: model.measure,
    variables: model.variables,
    labels: model.labels,
    n: model.n,
    maxLeafLabels: 40,
  }
}

export { LINKAGE_LABELS, MEASURE_LABELS }
