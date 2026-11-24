// Hierarchical clustering: PSPP 2.1.3 has no hierarchical procedure, so the
// merge tree is computed here. The average-linkage coefficients are checked
// against a brute-force reference that recomputes every cluster distance from
// the raw points after each merge — a Lance–Williams mistake shows up at once.
import assert from 'node:assert/strict'

import { computeDendrogram, computeHierarchicalClustering } from '../lib/cluster.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const points = [[1, 1], [1.5, 1.2], [5, 5], [5.4, 5.2], [9, 1]]
const dataset = (rows = points) => ({
  variables: [{ name: 'x', type: 'numeric' }, { name: 'y', type: 'numeric' }],
  rows,
})

const gap = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1])

// Average linkage, recomputed from the points instead of updated in place.
function averageReference(rows) {
  let clusters = rows.map((_, index) => [index])
  const coefficients = []
  while (clusters.length > 1) {
    let best = Infinity
    let pair = null
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        let total = 0
        for (const a of clusters[i]) for (const b of clusters[j]) total += gap(rows[a], rows[b])
        const average = total / (clusters[i].length * clusters[j].length)
        if (average < best) {
          best = average
          pair = [i, j]
        }
      }
    }
    coefficients.push(best)
    const [i, j] = pair
    clusters = clusters.filter((_, index) => index !== i && index !== j)
      .concat([[...clusters[i], ...clusters[j]]])
  }
  return coefficients
}

check('average linkage matches a brute-force agglomeration', () => {
  const out = computeHierarchicalClustering(dataset(), { variables: ['x', 'y'], linkage: 'average' })
  const reference = averageReference(points)
  out.model.merges.forEach((entry, index) => {
    assert.ok(Math.abs(entry.coefficient - reference[index]) < 1e-9,
      `stage ${entry.stage}: ${entry.coefficient} vs ${reference[index]}`)
  })
  assert.equal(out.model.merges.length, points.length - 1, 'n - 1 merges')
})

check('the agglomeration schedule names the groups and the next stage', () => {
  const out = computeHierarchicalClustering(dataset(), { variables: ['x', 'y'] })
  const schedule = out.tables[0].matrix
  assert.equal(schedule[0].length, 7, 'seven columns like the SPSS table')
  assert.equal(schedule[1][0], '1', 'the first stage is numbered 1')
  // The nearest pair is cases 3 and 4 at 0.447.
  assert.equal(schedule[1][1], '3')
  assert.equal(schedule[1][2], '4')
  assert.equal(schedule[1][3], '0.447')
  assert.equal(schedule[1][4], '0', 'a case appears for the first time at its own stage')
  assert.equal(schedule[schedule.length - 1][6], '0', 'the last merge never happens again')
  assert.match(out.tables[0].caption, /组间平均连接/, 'the method is in the caption')
  assert.match(out.tables[0].caption, /欧氏距离/)
})

check('k clusters cut the tree and every case lands in one group', () => {
  const out = computeHierarchicalClustering(dataset(), { variables: ['x', 'y'], clusters: 2 })
  assert.equal(out.model.membership.length, points.length)
  // The third merge joins {3,4} with case 5 (5.594) before the two pairs meet
  // (5.623), so cutting at two clusters leaves {1,2} and {3,4,5}.
  assert.deepEqual(out.model.sizes, [2, 3], 'the far point joins the top pair')
  assert.deepEqual(out.model.membership, [1, 1, 2, 2, 2])
  const counts = out.tables[2].matrix.slice(1).map((row) => row[1])
  assert.deepEqual(counts, ['2', '3'], 'the size table agrees with the membership')
  const members = out.tables[1].matrix
  assert.equal(members[0].length, 2, 'case number and group')
  assert.equal(members.length, points.length + 1, 'one row per case plus the header')
})

check('single and complete linkage differ where the tree forks', () => {
  const single = computeHierarchicalClustering(dataset(), { variables: ['x', 'y'], linkage: 'single' })
  const complete = computeHierarchicalClustering(dataset(), { variables: ['x', 'y'], linkage: 'complete' })
  // Single linkage meets case 5 through case 4 (5.532) but prefers d(2,3) =
  // 5.166; complete linkage sees the farthest pair either way.
  assert.ok(Math.abs(single.model.merges[2].coefficient - 5.166) < 1e-3, `single ${single.model.merges[2].coefficient}`)
  assert.ok(Math.abs(complete.model.merges[2].coefficient - 5.657) < 1e-3, `complete ${complete.model.merges[2].coefficient}`)
  assert.ok(complete.model.merges[3].coefficient > single.model.merges[3].coefficient,
    'complete linkage is never shorter than single')
})

check('Ward needs squared Euclidean distance and refuses to guess', () => {
  assert.throws(
    () => computeHierarchicalClustering(dataset(), { variables: ['x', 'y'], linkage: 'ward' }),
    /Ward 法要用「欧氏距离平方」/,
  )
  const out = computeHierarchicalClustering(dataset(), { variables: ['x', 'y'], linkage: 'ward', measure: 'sqeuclidean' })
  assert.equal(out.model.merges.length, points.length - 1)
  const rising = out.model.merges.every((entry, index) => index === 0 || entry.coefficient >= out.model.merges[index - 1].coefficient)
  assert.ok(rising, 'Ward coefficients never go down')
})

check('a missing value drops the whole case and a text predictor is named', () => {
  const rows = [...points, [null, 2], [3, null]]
  const out = computeHierarchicalClustering(dataset(rows), { variables: ['x', 'y'] })
  assert.equal(out.model.n, points.length, 'the two incomplete cases do not cluster')
  const text = {
    variables: [{ name: 'x', type: 'numeric' }, { name: 'g', type: 'string' }],
    rows: [[1, 'a'], [2, 'b'], [3, 'c']],
  }
  assert.throws(() => computeHierarchicalClustering(text, { variables: ['g'] }), /聚类变量要求数值变量/)
  assert.throws(() => computeHierarchicalClustering(dataset(), { variables: ['nope'] }), /没有这个变量：nope/)
  assert.throws(() => computeHierarchicalClustering(dataset([[1, 1], [2, 2]]), { variables: ['x', 'y'] }), /至少要 3 个个案/)
  assert.throws(() => computeHierarchicalClustering(dataset(), { variables: ['x'], measure: 'cosine' }), /不认识的距离测度：cosine/)
  assert.throws(() => computeHierarchicalClustering(dataset(), { variables: ['x'], linkage: 'median' }), /不认识的连接方法：median/)
})

check('the dendrogram puts the last merge at the top and leaves in label order', () => {
  const chart = computeDendrogram(dataset(), { variables: ['x', 'y'] })
  assert.equal(chart.kind, 'dendrogram')
  assert.equal(chart.leaves, points.length)
  assert.equal(chart.root.leaves, points.length, 'the root holds every case')
  assert.ok(Math.abs(chart.root.height - chart.maxHeight) < 1e-9, 'the root sits at the last coefficient')
  assert.equal(chart.root.children.length, 2)
  assert.match(chart.title, /系统聚类树状图/)
  assert.match(chart.title, /组间平均连接/)
  assert.equal(chart.maxLeafLabels, 40, 'the drawing stops printing case numbers past forty leaves')
})

console.log(`${checks} checks passed`)
