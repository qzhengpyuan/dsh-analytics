// 对应分析的用例：卡方/惯量/奇异值与手算对照，坐标靠加权平方和与正交性自证。
// 对应分析没有「引擎答案」可比，所以每条断言都是可以独立推导的恒等式：
// Σ 行质量 × 行坐标² = σ²、两维坐标按质量加权正交、奇异值平方和 = 卡方/个案数。
import assert from 'node:assert/strict';
import { computeCorrespondence } from '../lib/correspondence.js';

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

process.stdout.write(`\n${checks} checks in test/correspondence.mjs\n`);
if (process.exitCode) process.stdout.write('failures above\n');
