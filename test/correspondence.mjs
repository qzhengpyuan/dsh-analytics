// 对应分析的用例：卡方/惯量/奇异值与手算对照，坐标靠加权平方和与正交性自证。
// 对应分析没有「引擎答案」可比，所以每条断言都是可以独立推导的恒等式：
// Σ 行质量 × 行坐标² = σ²、两维坐标按质量加权正交、奇异值平方和 = 卡方/个案数。
import assert from 'node:assert/strict';
import { caCore, computeCorrespondence } from '../lib/correspondence.js';

let checks = 0;
function check(name, run) {
  try {
    run();
    checks += 1;
    process.stdout.write(`ok  ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL  ${name}\n`);
    process.stdout.write(`  ${error.message}\n`);
    process.exitCode = 1;
  }
}

// 独立的特征值实现（Jacobi 旋转），只用来给主特征的幂迭代做对照。对应分析没有
// 引擎答案，幂迭代又可能因为起点与残余主方向正交而漏掉一维（Win10 0930 的 P0-1），
// 所以必须有一条「与另一种算法逐值对账」的断言，否则这类缺陷永远不会被拦住。
function eigenvaluesOf(matrix) {
  const size = matrix.length;
  const a = matrix.map((line) => [...line]);
  for (let sweep = 0; sweep < 200; sweep += 1) {
    let off = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) off += a[row][column] ** 2;
    }
    if (off < 1e-26) break;
    for (let p = 0; p < size - 1; p += 1) {
      for (let q = p + 1; q < size; q += 1) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < size; k += 1) {
          const kp = a[k][p];
          const kq = a[k][q];
          a[k][p] = c * kp - s * kq;
          a[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < size; k += 1) {
          const pk = a[p][k];
          const qk = a[q][k];
          a[p][k] = c * pk - s * qk;
          a[q][k] = s * pk + c * qk;
        }
      }
    }
  }
  return a.map((line, index) => line[index]).sort((left, right) => right - left);
}

// 与 caCore 同口径的 ZᵀZ：标准化残差按**比例**算（用频数会让 ΣZ² 等于卡方而不是惯量）。
function gramOf(observed) {
  const rows = observed.map((line) => line.reduce((sum, value) => sum + value, 0));
  const total = rows.reduce((sum, value) => sum + value, 0);
  const columns = observed[0].map((_, index) => observed.reduce((sum, line) => sum + line[index], 0));
  const rowMass = rows.map((value) => value / total);
  const columnMass = columns.map((value) => value / total);
  const z = observed.map((line, row) => line.map((value, column) => ((value / total) - rowMass[row] * columnMass[column])
    / Math.sqrt(rowMass[row] * columnMass[column])));
  return z[0].map((_, left) => z[0].map((__, right) => z.reduce((sum, line) => sum + line[left] * line[right], 0)));
}

function close(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual), `${message}: ${actual} 不是有限数值`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: 实际 ${actual}，期望 ${expected}（容差 ${tolerance}）`);
}

const ROW = { name: 'r', type: 'string' };
const COLUMN = { name: 'c', type: 'string' };

function build(cells, options = {}) {
  const rows = [];
  for (const [row, column, times] of cells) {
    for (let index = 0; index < times; index += 1) rows.push([row, column]);
  }
  return computeCorrespondence({ variables: [ROW, COLUMN, ...(options.variables ?? [])], rows }, { row: 'r', column: 'c', ...options });
}

check('a 2x2 table reproduces the hand-computed chi-square and inertia', () => {
  const out = build([['A', 'X', 20], ['A', 'Y', 10], ['B', 'X', 10], ['B', 'Y', 30]]);
  // 期望频数 12.857 / 17.143 / 17.143 / 22.857，卡方 = 12.1528，惯量 = 卡方/70。
  close(out.model.chiSquare, 12.152777777777779, 1e-9, '卡方');
  close(out.model.inertia, 12.152777777777779 / 70, 1e-12, '惯量');
  close(out.model.p ?? 0, 0.0001, 0.001, 'P 值');
  assert.equal(out.model.df, 1, '2×2 的自由度是 1');
  assert.equal(out.model.singular.length, 1, '2×2 只有一个维度');
  close(out.model.singular[0], Math.sqrt(out.model.inertia), 1e-9, '奇异值 = √惯量');
  // 行质量 × 行坐标² 之和必须等于 σ²（这是主坐标的定义，写错就会差一个质量因子）。
  const rowMass = out.model.counts.map((line) => line.reduce((sum, cell) => sum + cell, 0) / out.model.cases);
  const weighted = rowMass.reduce((sum, mass, index) => sum + mass * out.model.rowCoordinates[index][0] ** 2, 0);
  close(weighted, out.model.singular[0] ** 2, 1e-9, '行坐标的加权平方和');
  close(out.model.rowCoordinates[0][0], 0.4811252243246882, 1e-9, 'A 的行坐标');
  close(out.model.rowCoordinates[1][0], -0.3608439182435161, 1e-9, 'B 的行坐标');
});

check('a 3x3 table keeps two dimensions, orthogonal and mass-weighted', () => {
  const out = build([
    ['r1', 'c1', 20], ['r1', 'c2', 5], ['r1', 'c3', 3],
    ['r2', 'c1', 4], ['r2', 'c2', 18], ['r2', 'c3', 6],
    ['r3', 'c1', 2], ['r3', 'c2', 7], ['r3', 'c3', 22],
  ]);
  assert.equal(out.model.dimensions, 2, '3×3 最多两个维度');
  assert.equal(out.model.singular.length, 2);
  const totals = out.model.counts.map((line) => line.reduce((sum, cell) => sum + cell, 0));
  const mass = totals.map((value) => value / out.model.cases);
  const [first, second] = out.model.singular;
  const weightedSquare = (dimension) => mass.reduce((sum, weight, row) => sum + weight * out.model.rowCoordinates[row][dimension] ** 2, 0);
  close(weightedSquare(0), first * first, 1e-9, '第一维的加权平方和');
  close(weightedSquare(1), second * second, 1e-9, '第二维的加权平方和');
  const cross = mass.reduce((sum, weight, row) => sum + weight * out.model.rowCoordinates[row][0] * out.model.rowCoordinates[row][1], 0);
  close(cross, 0, 1e-9, '两维行坐标按质量加权正交');
  // 解释比例加起来不超过 1，且按奇异值降序。
  const explained = out.model.explained;
  assert.ok(explained[0] >= explained[1] - 1e-12, '第一维解释得最多');
  assert.ok(explained.reduce((sum, value) => sum + value, 0) <= 1 + 1e-9, '解释比例合计不超过 1');
});

check('column points carry the same inertia as the row points', () => {
  const out = build([
    ['r1', 'c1', 20], ['r1', 'c2', 5], ['r1', 'c3', 3],
    ['r2', 'c1', 4], ['r2', 'c2', 18], ['r2', 'c3', 6],
    ['r3', 'c1', 2], ['r3', 'c2', 7], ['r3', 'c3', 22],
  ]);
  const columnTotals = out.model.counts[0].map((_, column) => out.model.counts.reduce((sum, line) => sum + line[column], 0));
  const mass = columnTotals.map((value) => value / out.model.cases);
  for (let dimension = 0; dimension < out.model.singular.length; dimension += 1) {
    const weighted = mass.reduce((sum, weight, column) => sum + weight * out.model.columnCoordinates[column][dimension] ** 2, 0);
    close(weighted, out.model.singular[dimension] ** 2, 1e-9, `第 ${dimension + 1} 维的列坐标加权平方和`);
  }
  close(mass.reduce((sum, value) => sum + value, 0), 1, 1e-12, '列质量合计为 1');
});

check('the chart model carries every point once', () => {
  const out = build([['A', 'X', 20], ['A', 'Y', 10], ['B', 'X', 10], ['B', 'Y', 30]]);
  assert.equal(out.chart.rows.length, 2, '两个行点');
  assert.equal(out.chart.columns.length, 2, '两个列点');
  assert.deepEqual(out.chart.rows.map((point) => point.label), ['A', 'B']);
  assert.ok(Number.isFinite(out.chart.rows[0].x) && Number.isFinite(out.chart.rows[0].y), '行点坐标是有限数值');
  assert.match(out.chart.xLabel, /维 1（100\.0%）/, '第一维解释了全部惯量');
});

check('missing cases are dropped whole and reported', () => {
  const rows = [];
  for (const [row, column, times] of [['A', 'X', 10], ['A', 'Y', 6], ['B', 'X', 6], ['B', 'Y', 14]]) {
    for (let index = 0; index < times; index += 1) rows.push([row, column]);
  }
  rows.push(['A', null], [null, 'X'], ['B', '']);
  const out = computeCorrespondence({ variables: [ROW, COLUMN], rows }, { row: 'r', column: 'c' });
  assert.equal(out.model.cases, 36, '有效个案');
  assert.equal(out.model.dropped, 3, '三例整例剔除');
  assert.ok(out.notes.some((note) => note.includes('3 例')), '注文点名剔除了多少例');
});

check('bad input is refused with a readable message', () => {
  const rows = [['A', 'X'], ['B', 'Y']];
  const dataset = { variables: [ROW, COLUMN], rows };
  const refusals = [
    [null, { row: 'r', column: 'c' }, /还没有打开数据集/],
    [dataset, { row: 'r' }, /行变量与列变量/],
    [dataset, { row: 'r', column: 'r' }, /不能是同一个变量/],
    [dataset, { row: 'nope', column: 'c' }, /没有这个变量/],
    [{ variables: [ROW, COLUMN], rows: [['A', 'X'], ['B', 'X']] }, { row: 'r', column: 'c' }, /至少要有两个/],
    [{ variables: [ROW, COLUMN], rows: [['A', 'X'], ['A', 'Y']] }, { row: 'r', column: 'c' }, /至少要有两个/],
    [{ variables: [ROW, COLUMN], rows: [] }, { row: 'r', column: 'c' }, /没有可用的个案/],
  ];
  for (const [data, options, pattern] of refusals) {
    assert.throws(() => computeCorrespondence(data, options), pattern, `${JSON.stringify(options)} 应当被拒绝`);
  }
});

check('too many categories are refused instead of producing a slow chart', () => {
  const rows = [];
  for (let index = 0; index < 61; index += 1) rows.push([`r${index}`, index % 2 === 0 ? 'X' : 'Y']);
  assert.throws(
    () => computeCorrespondence({ variables: [ROW, COLUMN], rows }, { row: 'r', column: 'c' }),
    /类别太多/,
  );
});

check('the second dimension is not lost when the eigenvalues differ (P0-1 guard)', () => {
  // 相关 3×2 表：特征值互不相同，幂迭代的固定起点曾在这里与残余主方向正交，
  // 把真实的第二维压成 0。
  const observed = [[13, 2, 3], [2, 13, 1], [6, 4, 3]];
  const core = caCore(observed, { dimensions: 2 });
  const truth = eigenvaluesOf(gramOf(observed));
  close(core.singular[0] ** 2, truth[0], 1e-10, 'first eigenvalue');
  close(core.singular[1] ** 2, truth[1], 1e-10, 'second eigenvalue');
  assert.ok(core.singular[1] > 0.1, `second singular value stays real: ${core.singular[1]}`);
});

check('a balanced table keeps every dimension (repeated eigenvalues, P0-1 guard)', () => {
  // 4×4 均衡表：四个特征值有两两相等，收缩后起点容易落进上一维的特征空间。
  const observed = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => (row === column ? 60 : 20)));
  const core = caCore(observed, { dimensions: 3 });
  const truth = eigenvaluesOf(gramOf(observed));
  for (let index = 0; index < 3; index += 1) {
    close(core.singular[index] ** 2, truth[index], 1e-9, `eigenvalue ${index + 1}`);
  }
});

check('the total inertia comes from chi-square, not from the few eigenvalues retrieved (P0-2 guard)', () => {
  // 7×7 偏斜表：非零特征值有 6 个，而 caCore 只取前 4 个。用「取到的和」当分母时
  // 「合计」行会小于卡方分解里的总惯量，解释比例也被系统性放大。
  const base = [40, 18, 12, 8, 5, 3, 2];
  const observed = base.map((value, row) => base.map((other, column) => (row === column ? value * 3 : value + other)));
  const core = caCore(observed, { dimensions: 3 });
  const total = observed.reduce((sum, line) => sum + line.reduce((left, right) => left + right, 0), 0);
  const truth = eigenvaluesOf(gramOf(observed));
  const allEigenvalues = truth.reduce((sum, value) => sum + value, 0);
  close(core.totalInertia, core.chiSquare / total, 1e-12, 'definition');
  close(core.totalInertia, allEigenvalues, 1e-9, 'sum of every eigenvalue');
  const proportions = truth.map((value) => value / allEigenvalues);
  for (let index = 0; index < 3; index += 1) {
    close(core.explained[index], proportions[index], 1e-9, `explained ${index + 1}`);
  }
  // 取到的四个特征值之和必须严格小于总惯量，否则这条用例根本没触发缺陷。
  const retrieved = truth.slice(0, 4).reduce((sum, value) => sum + value, 0);
  assert.ok(retrieved < allEigenvalues - 1e-6, `the fixture spans more than four dimensions: ${retrieved} vs ${allEigenvalues}`);
});

check('one dimension reports a single axis and does not claim two (P3-1 guard)', () => {
  // 3×3 才能取到两维（维数上限是 min(行, 列, 4) − 1）。
  const observed = [[13, 2, 4], [2, 13, 5], [7, 6, 3]];
  const dataset = {
    variables: [{ name: 'row', type: 'string' }, { name: 'col', type: 'string' }],
    rows: [],
  };
  const rowLabels = ['p', 'q', 'r'];
  const columnLabels = ['u', 'v', 'w'];
  observed.forEach((line, row) => line.forEach((count, column) => {
    for (let repeat = 0; repeat < count; repeat += 1) dataset.rows.push([rowLabels[row], columnLabels[column]]);
  }));
  const one = computeCorrespondence(dataset, { row: 'row', column: 'col', dimensions: 1 });
  assert.ok(!/维 2/.test(one.chart.yLabel), `the single-dimension map must not name a second axis: ${one.chart.yLabel}`);
  assert.ok(one.notes.some((note) => /这一维占/.test(note)), 'and the note speaks of one dimension');
  const two = computeCorrespondence(dataset, { row: 'row', column: 'col', dimensions: 2 });
  assert.match(two.chart.yLabel, /^维 2（/);
});

process.stdout.write(`\n${checks} checks in test/correspondence.mjs\n`);
if (process.exitCode) process.stdout.write('failures above\n');
