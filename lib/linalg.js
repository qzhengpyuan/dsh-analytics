// Small dense linear algebra shared by the procedures the plugin fits itself
// (Cox regression, discriminant analysis). Everything here works on plain
// arrays: these matrices are a handful of columns wide, so an O(n³) elimination
// is the right tool and a dependency would only add install weight.

/** Solve A·x = b with partial pivoting. Throws when A is singular. */
export function solve(matrix, vector) {
  const size = vector.length
  const work = matrix.map((row, index) => [...row.map((value) => Number(value)), Number(vector[index])])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row
    }
    if (Math.abs(work[pivot][column]) < 1e-12) {
      throw new Error('矩阵是奇异的：变量之间完全共线，或者某个变量在组内没有任何变化')
    }
    if (pivot !== column) {
      const swap = work[pivot]
      work[pivot] = work[column]
      work[column] = swap
    }
    const divisor = work[column][column]
    for (let index = column; index <= size; index += 1) work[column][index] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = work[row][column]
      if (factor === 0) continue
      for (let index = column; index <= size; index += 1) work[row][index] -= factor * work[column][index]
    }
  }
  return work.map((row) => row[size])
}

/** Inverse of a square matrix, column by column. */
export function invert(matrix) {
  const size = matrix.length
  const columns = Array.from({ length: size }, (_, index) => {
    const unit = Array.from({ length: size }, (_, position) => (position === index ? 1 : 0))
    return solve(matrix, unit)
  })
  return Array.from({ length: size }, (_, row) => columns.map((column) => column[row]))
}

/** Determinant by elimination, with the sign carried through the row swaps. */
export function determinant(matrix) {
  const size = matrix.length
  const work = matrix.map((row) => row.map((value) => Number(value)))
  let result = 1
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row
    }
    if (Math.abs(work[pivot][column]) < 1e-12) return 0
    if (pivot !== column) {
      const swap = work[pivot]
      work[pivot] = work[column]
      work[column] = swap
      result = -result
    }
    const divisor = work[column][column]
    result *= divisor
    for (let row = column + 1; row < size; row += 1) {
      const factor = work[row][column] / divisor
      if (factor === 0) continue
      for (let index = column; index < size; index += 1) work[row][index] -= factor * work[column][index]
    }
  }
  return result
}
