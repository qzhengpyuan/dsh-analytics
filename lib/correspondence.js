// 对应分析（SPSS 的「分析 → 降维 → 对应分析」）。
//
// PSPP 2.1.3 没有 CORRESPONDENCE，所以整套在插件里算：先做卡方分解，把标准化
// 残差矩阵 Z = D_r^(-1/2) (P − r cᵀ) D_c^(-1/2) 做奇异值分解，再换成主坐标。
// 奇异值分解借对称矩阵的 Jacobi 特征分解：ZᵀZ 的特征向量就是右奇异向量，
// σ = √λ，左奇异向量 U = Z V / σ。维度只有个位数，不需要更快的算法。
import { chiSquareP } from './tables.js';
import { isUserMissing } from './missing.js';

const MAX_CATEGORIES = 60;
const MAX_DIMENSIONS = 3;

function isCategorical(variable) {
  return Boolean(variable);
}

function labelOf(variable, raw) {
  if (raw === null || raw === undefined) return '（缺失）';
  const value = typeof raw === 'number' ? raw : Number(raw);
  const text = Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : String(raw);
  const labels = variable?.valueLabels ?? variable?.labels ?? [];
  const found = Array.isArray(labels)
    ? labels.find((entry) => String(entry.value) === text || String(entry.value) === String(raw))
    : null;
  return found?.label ? `${text}（${found.label}）` : text;
}

function sortKeys(values) {
  const numeric = values.every((value) => Number.isFinite(Number(value)));
  return [...values].sort((left, right) => (numeric
    ? Number(left) - Number(right)
    : String(left).localeCompare(String(right), 'zh-Hans-CN')));
}

// 对称矩阵的主特征对：幂迭代 + 逐维收缩（deflation）。
//
// 一开始用 Jacobi 旋转，但特征值排序与特征向量排序容易弄反（第一版就把
// 第二主方向的向量当成了第一主方向，行坐标差了 1/7）。幂迭代慢一点，但每一步
// 只做矩阵乘向量、主方向按构造逐维剥掉，不会错位；维度最多三四个，代价可忽略。
function principalPairs(matrix, count) {
  const size = matrix.length;
  const working = matrix.map((line) => [...line]);
  const values = [];
  const vectors = [];
  const multiply = (grid, vector) => grid.map((line) => line.reduce((sum, cell, index) => sum + cell * vector[index], 0));
  for (let dimension = 0; dimension < count; dimension += 1) {
    // 起始向量必须随维变化：重复特征值（多重对应分析的指标矩阵里很常见）时，
    // 固定起点会正好落在上一维的特征空间里，收缩掉一维后迭代就停在 0，
    // 惯量合计少一半。这里用彼此不成比例的有理数序列，再在收敛后对前面的
    // 向量做一次 Gram–Schmidt，保证各维正交。
    let vector = Array.from({ length: size }, (_, index) => 1 + ((index + 1) * (dimension + 2) % (size + 3)) / (size + 3));
    let lambda = 0;
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const next = multiply(working, vector);
      const norm = Math.sqrt(next.reduce((sum, cell) => sum + cell * cell, 0));
      if (!(norm > 1e-14)) { lambda = 0; break; }
      vector = next.map((cell) => cell / norm);
      lambda = norm;
    }
    // 对前面已经取出的向量正交化，避免重复特征值时各维不正交。
    for (const previous of vectors) {
      const projection = previous.reduce((sum, cell, index) => sum + cell * vector[index], 0);
      vector = vector.map((cell, index) => cell - projection * previous[index]);
    }
    const length = Math.sqrt(vector.reduce((sum, cell) => sum + cell * cell, 0));
    if (length > 1e-12) vector = vector.map((cell) => cell / length);
    // 取向确定下来（最大分量取正），这样重复运行给出同一张图。
    let largest = 0;
    for (let index = 1; index < size; index += 1) {
      if (Math.abs(vector[index]) > Math.abs(vector[largest])) largest = index;
    }
    if (vector[largest] < 0) vector = vector.map((cell) => -cell);
    // 收缩：A ← A − λ v vᵀ。
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        working[row][column] -= lambda * vector[row] * vector[column];
      }
    }
    values.push(Math.max(0, lambda));
    vectors.push(vector);
  }
  return { values, vectors };
}

/**
 * The engine both correspondence analyses share: given a count matrix, build the
 * standardized residuals (in *proportions*, not frequencies — using counts makes
 * ΣZ² equal the chi-square instead of the inertia, and every singular value
 * comes out √chi-square times too large), take the leading pairs of ZᵀZ by power
 * iteration, and hand back the principal coordinates of both point sets.
 */
export function caCore(observed, options = {}) {
  const rowTotals = observed.map((line) => line.reduce((sum, value) => sum + value, 0));
  const columnTotals = observed[0].map((_, column) => observed.reduce((sum, line) => sum + line[column], 0));
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new Error('表里一个个案都没有');
  const rowMass = rowTotals.map((value) => value / total);
  const columnMass = columnTotals.map((value) => value / total);
  let chiSquare = 0;
  const z = observed.map((line, rowPosition) => line.map((value, columnPosition) => {
    const expected = (rowTotals[rowPosition] * columnTotals[columnPosition]) / total;
    chiSquare += ((value - expected) ** 2) / expected;
    return (value / total - rowMass[rowPosition] * columnMass[columnPosition])
      / Math.sqrt(rowMass[rowPosition] * columnMass[columnPosition]);
  }));
  const gram = Array.from({ length: observed[0].length }, (_, left) =>
    Array.from({ length: observed[0].length }, (__, right) => z.reduce((sum, line) => sum + line[left] * line[right], 0)));
  const eigen = principalPairs(gram, Math.min(observed[0].length, MAX_DIMENSIONS + 1));
  const maximum = Math.min(observed.length, observed[0].length, MAX_DIMENSIONS + 1) - 1;
  const dimensions = Math.max(1, Math.min(Number(options.dimensions) || 2, maximum));
  const singular = [];
  for (let index = 0; index < dimensions; index += 1) singular.push(Math.sqrt(Math.max(0, eigen.values[index] ?? 0)));
  const totalInertia = eigen.values.reduce((sum, value) => sum + Math.max(0, value), 0) || chiSquare / total || 1;
  const rowCoordinates = observed.map(() => [0, 0, 0]);
  const columnCoordinates = observed[0].map(() => [0, 0, 0]);
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const sigma = singular[dimension];
    const right = eigen.vectors[dimension] ?? [];
    // 左奇异向量 U = Z V / σ；主坐标 = D^(-1/2) Z V。
    const u = observed.map((_, rowPosition) => (sigma > 1e-12
      ? z[rowPosition].reduce((sum, cell, columnPosition) => sum + cell * (right[columnPosition] ?? 0), 0) / sigma
      : 0));
    for (let rowPosition = 0; rowPosition < observed.length; rowPosition += 1) {
      rowCoordinates[rowPosition][dimension] = sigma * u[rowPosition] / Math.sqrt(rowMass[rowPosition]);
    }
    for (let columnPosition = 0; columnPosition < observed[0].length; columnPosition += 1) {
      columnCoordinates[columnPosition][dimension] = sigma * (right[columnPosition] ?? 0) / Math.sqrt(columnMass[columnPosition]);
    }
  }
  return {
    chiSquare,
    // 定义的惯量：卡方 / 总和。特征值之和只在维数取得够多时才等于它，
    // 所以算解释比例要用这个当分母。
    inertia: chiSquare / total,
    total,
    rowMass,
    columnMass,
    rowTotals,
    columnTotals,
    singular,
    totalInertia,
    dimensions,
    explained: singular.map((sigma) => (sigma * sigma) / totalInertia),
    rowCoordinates,
    columnCoordinates,
  };
}

/**
 * Correspondence analysis of two categorical variables.
 *
 * Returns the contingency table, the chi-square decomposition (inertia is
 * chi-square over the case count, so a row's inertia is directly comparable
 * across tables), the singular values with explained proportions, and the
 * principal coordinates of the row and column points — plus the chart model
 * the biplot is drawn from.
 */
export function computeCorrespondence(dataset, options = {}) {
  const rowName = options.row;
  const columnName = options.column;
  if (!dataset) throw new Error('还没有打开数据集');
  if (!rowName || !columnName) throw new Error('对应分析要指定行变量与列变量');
  if (rowName === columnName) throw new Error('行变量与列变量不能是同一个变量');
  const find = (name) => (dataset.variables ?? []).find((variable) => variable.name === name);
  const rowVariable = find(rowName);
  const columnVariable = find(columnName);
  if (!rowVariable) throw new Error(`没有这个变量：${rowName}`);
  if (!columnVariable) throw new Error(`没有这个变量：${columnName}`);
  if (!isCategorical(rowVariable) || !isCategorical(columnVariable)) throw new Error('对应分析要两个分类变量');

  const rowIndex = dataset.variables.indexOf(rowVariable);
  const columnIndex = dataset.variables.indexOf(columnVariable);
  const counts = new Map();
  const rowKeys = new Set();
  const columnKeys = new Set();
  let cases = 0;
  let dropped = 0;
  for (const row of dataset.rows ?? []) {
    const rawRow = row?.[rowIndex];
    const rawColumn = row?.[columnIndex];
    if (rawRow === null || rawRow === undefined || rawRow === ''
      || rawColumn === null || rawColumn === undefined || rawColumn === ''
      || isUserMissing(rowVariable, rawRow) || isUserMissing(columnVariable, rawColumn)) {
      dropped += 1;
      continue;
    }
    cases += 1;
    rowKeys.add(String(rawRow));
    columnKeys.add(String(rawColumn));
    const key = `${String(rawRow)}\u0001${String(rawColumn)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (cases === 0) throw new Error('没有可用的个案：两个变量都有效的行是 0 行');
  const rows = sortKeys([...rowKeys]);
  const columns = sortKeys([...columnKeys]);
  if (rows.length < 2 || columns.length < 2) throw new Error('对应分析至少要有两个行类别与两个列类别');
  if (rows.length > MAX_CATEGORIES || columns.length > MAX_CATEGORIES) {
    throw new Error(`类别太多：行 ${rows.length} 个、列 ${columns.length} 个，对应分析在这里最多各 ${MAX_CATEGORIES} 个（先合并类别）`);
  }

  const rowTotals = rows.map((rowKey) => columns.reduce((sum, columnKey) => sum + (counts.get(`${rowKey}\u0001${columnKey}`) ?? 0), 0));
  const columnTotals = columns.map((columnKey) => rows.reduce((sum, rowKey) => sum + (counts.get(`${rowKey}\u0001${columnKey}`) ?? 0), 0));
  if (rowTotals.some((value) => value === 0) || columnTotals.some((value) => value === 0)) {
    throw new Error('有类别一个个案都没有：对应分析拒收空行或空列，先合并或剔除');
  }

  const total = cases;
  const observedMatrix = rows.map((rowKey) => columns.map((columnKey) => counts.get(`${rowKey}\u0001${columnKey}`) ?? 0));
  const core = caCore(observedMatrix, { dimensions: options.dimensions });
  const chiSquare = core.chiSquare;
  const singular = core.singular;
  const totalInertia = core.totalInertia;
  const dimensions = core.dimensions;
  const rowCoordinates = core.rowCoordinates;
  const columnCoordinates = core.columnCoordinates;
  const inertia = chiSquare / cases;
  const df = (rows.length - 1) * (columns.length - 1);
  const p = chiSquareP(chiSquare, df);

  const fixed = (value, digits = 3) => (Number.isFinite(value) ? Number(value).toFixed(digits) : '—');
  const percent = (value) => `${(100 * value).toFixed(1)}%`;

  const tables = [];
  tables.push({
    title: '对应分析摘要',
    columns: ['维', '奇异值', '惯量', '解释比例', '累计比例'],
    rows: [
      ...singular.map((sigma, index) => [
        String(index + 1),
        fixed(sigma),
        fixed(sigma * sigma, 4),
        percent(sigma * sigma / totalInertia),
        percent(singular.slice(0, index + 1).reduce((sum, value) => sum + value * value, 0) / totalInertia),
      ]),
      ['合计', fixed(Math.sqrt(totalInertia)), fixed(totalInertia, 4), percent(1), '—'],
    ],
  });
  tables.push({
    title: '卡方分解',
    columns: ['项目', '值'],
    rows: [
      ['行类别数', String(rows.length)],
      ['列类别数', String(columns.length)],
      ['有效个案', String(cases)],
      ['剔除个案', String(dropped)],
      ['卡方', fixed(chiSquare)],
      ['自由度', String(df)],
      ['P 值', p === null ? '—' : (p < 0.001 ? '<0.001' : fixed(p))],
      ['总惯量（卡方 / 个案数）', fixed(inertia, 4)],
    ],
  });
  tables.push({
    title: `${rowName} 的行点坐标`,
    columns: ['类别', '质量', '维 1', '维 2', '维 3'],
    rows: rows.map((key, index) => [
      labelOf(rowVariable, key),
      fixed(rowTotals[index] / total),
      fixed(rowCoordinates[index][0]),
      fixed(rowCoordinates[index][1]),
      fixed(rowCoordinates[index][2]),
    ]),
  });
  tables.push({
    title: `${columnName} 的列点坐标`,
    columns: ['类别', '质量', '维 1', '维 2', '维 3'],
    rows: columns.map((key, index) => [
      labelOf(columnVariable, key),
      fixed(columnTotals[index] / total),
      fixed(columnCoordinates[index][0]),
      fixed(columnCoordinates[index][1]),
      fixed(columnCoordinates[index][2]),
    ]),
  });

  const model = {
    row: rowName,
    column: columnName,
    rows: rows.map((key) => labelOf(rowVariable, key)),
    columns: columns.map((key) => labelOf(columnVariable, key)),
    cases,
    dropped,
    chiSquare,
    df,
    p,
    inertia,
    singular,
    explained: singular.map((sigma) => sigma * sigma / totalInertia),
    dimensions,
    rowCoordinates: rowCoordinates.map((point) => point.slice(0, 2)),
    columnCoordinates: columnCoordinates.map((point) => point.slice(0, 2)),
    counts: rows.map((key) => columns.map((columnKey) => counts.get(`${key}\u0001${columnKey}`) ?? 0)),
  };

  const notes = [
    `对应分析的惯量 = 卡方 / 个案数：本次 ${fixed(chiSquare, 3)} / ${cases} = ${fixed(inertia, 4)}。`,
    `解释比例按惯量算，前两维合计 ${percent((singular.slice(0, 2).reduce((sum, value) => sum + value * value, 0)) / totalInertia)}`
    + `${(singular.slice(0, 2).reduce((sum, value) => sum + value * value, 0)) / totalInertia >= 0.75 ? '，足以看二维图' : '，二维图只画出一部分结构，读图时要留余地'}。`,
    dropped > 0 ? `有 ${dropped} 例因为变量缺失被整例剔除。` : null,
    '行点与列点的坐标都在同一张图上，但各自的尺度由行/列质量决定：两个行点之间的距离有意义，两个列点之间也有意义，行点与列点之间的距离只作定性参考。',
  ].filter(Boolean);

  const chart = {
    title: `对应分析：${rowName} × ${columnName}`,
    xLabel: `维 1（${percent(singular[0] * singular[0] / totalInertia)}）`,
    yLabel: `维 2（${percent((singular[1] ?? 0) * (singular[1] ?? 0) / totalInertia)}）`,
    rows: rows.map((key, index) => ({ label: labelOf(rowVariable, key), x: rowCoordinates[index][0], y: rowCoordinates[index][1] })),
    columns: columns.map((key, index) => ({ label: labelOf(columnVariable, key), x: columnCoordinates[index][0], y: columnCoordinates[index][1] })),
  };

  return { title: '对应分析', tables, model, notes, chart };
}
