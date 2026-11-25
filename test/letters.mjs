// 同质子集的字母标记：算法（Piepho 2004 insert-absorb）没有外部答案可比，
// 所以断言全部落在「字母表本身必须满足的性质」上：同一字母下的两组不能显著
// 不同、显著不同的两组不能共用一个字母、每组的字母非空且可以被复现。
import assert from 'node:assert/strict'

import { homogeneousSubsets, letterDisplay, sameMatrix } from '../lib/letters.js'

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

const matrixOf = (count, edges) => {
  const same = Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => row === column))
  for (const [left, right] of edges) {
    same[left][right] = true
    same[right][left] = true
  }
  return same
}

const invariants = (same) => {
  const { labels, subsets } = letterDisplay(same)
  const count = same.length
  assert.equal(labels.length, count, 'one label per group')
  for (const column of subsets) {
    for (const left of column) {
      for (const right of column) {
        assert.ok(same[left][right], `字母 ${labels[left]} 里的 ${left} 与 ${right} 其实显著不同（团内必须两两不显著）`)
      }
    }
  }
  for (let left = 0; left < count; left += 1) {
    assert.ok(labels[left].length > 0, `第 ${left} 组一个字母都没拿到`)
    for (let right = left + 1; right < count; right += 1) {
      if (same[left][right]) continue
      const shared = [...labels[left]].some((letter) => labels[right].includes(letter))
      assert.ok(!shared, `显著不同的 ${left}（${labels[left]}）与 ${right}（${labels[right]}）共用了字母`)
    }
  }
  return { labels, subsets }
}

check('all groups alike share one letter', () => {
  const { labels, subsets } = invariants(matrixOf(3, [[0, 1], [0, 2], [1, 2]]))
  assert.deepEqual(labels, ['a', 'a', 'a'])
  assert.equal(subsets.length, 1)
})

check('all groups different get a letter each', () => {
  const { labels } = invariants(matrixOf(3, []))
  assert.deepEqual(labels, ['a', 'b', 'c'])
})

check('a chain of overlaps produces a bridging letter', () => {
  // 1~2 不显著、2~3 不显著、1~3 显著 —— 教科书里的 ab 情形。
  const { labels } = invariants(matrixOf(3, [[0, 1], [1, 2]]))
  assert.deepEqual(labels, ['a', 'ab', 'b'])
})

check('two disjoint pairs keep their own letters', () => {
  const { labels } = invariants(matrixOf(4, [[0, 1], [2, 3]]))
  assert.deepEqual(labels, ['a', 'a', 'b', 'b'])
})

check('a group compatible with two incompatible groups bridges them', () => {
  const same = matrixOf(5, [[0, 1], [1, 4], [2, 3], [3, 4]])
  const { labels } = invariants(same)
  assert.ok(labels[4].length >= 2, `第 5 组应当同时拿到两侧的字母：${labels[4]}`)
})

check('letters follow the order the caller passes in', () => {
  const same = matrixOf(3, [])
  const ascending = letterDisplay(same, [0, 1, 2]).labels
  const descending = letterDisplay(same, [2, 1, 0]).labels
  assert.deepEqual(ascending, ['a', 'b', 'c'])
  assert.deepEqual(descending, ['c', 'b', 'a'])
})

check('the display is deterministic', () => {
  const same = matrixOf(6, [[0, 1], [1, 2], [3, 4]])
  assert.deepEqual(letterDisplay(same).labels, letterDisplay(same).labels)
})

check('a p value above alpha joins the groups, one below does not', () => {
  const same = sameMatrix(3, [{ left: 0, right: 1, p: 0.30, df: 8 }, { left: 0, right: 2, p: 0.01, df: 8 }, { left: 1, right: 2, p: 0.04, df: 8 }])
  assert.equal(same[0][1], true, 'p = 0.30 算同质')
  assert.equal(same[0][2], false, 'p = 0.01 算不同')
  assert.equal(same[1][2], false, 'p = 0.04 算不同')
  const { labels } = invariants(same)
  assert.deepEqual(labels, ['a', 'a', 'b'])
})

check('a comparison with no degrees of freedom is never pooled', () => {
  // 任一组不足 2 个个案时 df 是 0：这一对「无法判断」，不能并进同一个字母，
  // 否则读者会以为它们相等。
  const same = sameMatrix(2, [{ left: 0, right: 1, p: 0.9, df: 0 }])
  assert.equal(same[0][1], false)
})

check('alpha can be loosened', () => {
  const pairs = [{ left: 0, right: 1, p: 0.06, df: 9 }]
  assert.equal(sameMatrix(2, pairs, 0.05)[0][1], true, '判据是 p > α：0.06 在 α = 0.05 下算同质')
  // 把 α 放宽到 0.10 后同一对变成「显著不同」—— 放宽 α 让「不同」更容易成立，
  // 收紧 α 则相反（这条曾经把方向写反过）。
  assert.equal(sameMatrix(2, pairs, 0.10)[0][1], false, 'α = 0.10 时 p = 0.06 算不同')
  assert.equal(sameMatrix(2, pairs, 0.01)[0][1], true, 'α = 0.01 时仍是同质')
})

check('an empty table stays empty', () => {
  assert.deepEqual(homogeneousSubsets([]), [])
  assert.deepEqual(letterDisplay([]).labels, [])
})

check('the subsets are maximal cliques', () => {
  // 被别的列严格包含的列不提供信息，必须已经被去掉。
  const same = matrixOf(4, [[0, 1], [0, 2], [1, 2], [2, 3]])
  const subsets = homogeneousSubsets(same)
  for (const column of subsets) {
    assert.ok(!subsets.some((other) => other !== column && other.length > column.length
      && column.every((member) => other.includes(member))), `列 ${column} 被别的列包含`)
  }
})

console.log(`\nletters: ${checks} checks passed`)
