// 同质子集（compact letter display）：把「哪两组有显著差异」压缩成字母表 ——
// 这是农业与医学论文里最常见的一张表，SPSS 本身不画（要自己看 Post Hoc 表），
// 但读者只认字母。算法用 Piepho (2004) 的 insert-absorb，避免自己拼字母时
// 出现「同一字母下的两组其实显著」（letters 是最大团覆盖的必要条件）。
//
// 输入是 n×n 的布尔矩阵：same[i][j] 为真表示两组在 α 下没有显著差异（对角线为真）。
// 输出每组的字母串（如 'ab'），空数组表示这一组不参与（样本不足）。

/** 把一组列合并成「同质子集」列表；返回每个下标所属的子集编号。 */
export function homogeneousSubsets(same) {
  const count = same.length
  if (count === 0) return []
  // 每个 column 必须是一个「团」（队内两两都不显著）。所以不能从「全体一组」
  // 开始 —— 全体通常不是团，那样得到一个吞掉所有的假集合。逐行插入：
  // 能整列吸收的列合并成一个；否则为这一行开一个新列，装进与原列里相容的成员。
  let columns = []
  for (let row = 0; row < count; row += 1) {
    const fits = (column) => column.every((member) => same[row][member])
    const absorbing = columns.filter(fits)
    if (absorbing.length > 0) {
      const merged = [...new Set([row, ...absorbing.flat()])].sort((left, right) => left - right)
      columns = columns.filter((column) => !absorbing.includes(column))
      columns.push(merged)
      continue
    }
    // 每个列各开一个候选：跨列合并会把「彼此显著不同」的两组塞进同一个字母，
    // 那正是字母表最不该犯的错（团内必须两两不显著）。
    const candidates = []
    for (const column of columns) {
      const compatible = column.filter((member) => same[row][member])
      if (compatible.length === 0) continue
      candidates.push([row, ...compatible].sort((left, right) => left - right))
    }
    if (candidates.length === 0) {
      columns.push([row])
      continue
    }
    for (const candidate of candidates) {
      const duplicate = columns.some((column) => column.length === candidate.length
        && candidate.every((member) => column.includes(member)))
      if (!duplicate) columns.push(candidate)
    }
  }
  // 去掉被别的列严格包含的列（子集不再提供信息）。
  return columns.filter((column) => !columns.some((other) => other !== column
    && other.length > column.length && column.every((member) => other.includes(member))))
}

/**
 * 给每组分配字母。`order` 是字母的排列顺序（通常是均数从大到小），
 * 排在前面的组拿到更靠前的字母 —— 与论文里的习惯一致。
 */
export function letterDisplay(same, order) {
  const columns = homogeneousSubsets(same)
  const rank = new Map()
  ;(order ?? Array.from({ length: same.length }, (_, index) => index))
    .forEach((index, position) => rank.set(index, position))
  // 列按「最小名次」排序，这样均数最大的那一列拿 A。
  const sorted = [...columns].sort((left, right) => Math.min(...left.map((index) => rank.get(index) ?? index))
    - Math.min(...right.map((index) => rank.get(index) ?? index)))
  const labels = Array.from({ length: same.length }, () => '')
  sorted.forEach((column, position) => {
    for (const index of column) labels[index] += String.fromCharCode(97 + position)
  })
  return { labels, subsets: sorted }
}

/**
 * 由「两两比较的校正后 P」构造 same 矩阵。`pairs` 是
 * `[{left, right, p, df}]`，df 不足的对比按「无法判断 → 视为不同」处理，
 * 因为把无法判断的两组并到同一字母下更容易误导读者。
 */
export function sameMatrix(count, pairs, alpha = 0.05) {
  const same = Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => row === column))
  for (const pair of pairs) {
    const value = Number(pair.p)
    const comparable = Number.isFinite(value) && Number.isFinite(Number(pair.df)) && Number(pair.df) >= 1
    if (comparable && value > alpha) {
      same[pair.left][pair.right] = true
      same[pair.right][pair.left] = true
    }
  }
  return same
}
