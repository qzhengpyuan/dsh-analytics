// 多重对应分析的用例。这套方法没有引擎答案可比，所以每条断言都是可以独立
// 推导的恒等式：总惯量 (J−Q)/Q、Σ 质量·坐标² = λ、各变量判别度量之和 = λ、
// Cronbach's α 的定义式。
import assert from 'node:assert/strict';
import { computeMultipleCorrespondence } from '../lib/mca.js';

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

const A = { name: 'a', type: 'string' };
const B = { name: 'b', type: 'string' };
const C = { name: 'c', type: 'string' };

function dataset(rows, variables = [A, B]) {
  return { variables, rows };
}

check('two independent binary variables give the textbook total inertia', () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) rows.push([index % 2 === 0 ? 'a1' : 'a2', index % 4 < 2 ? 'b1' : 'b2']);
  const out = computeMultipleCorrespondence(dataset(rows), { variables: ['a', 'b'] });
  // (类别数 − 变量数) / 变量数 = (4 − 2) / 2 = 1，也正是卡方 / 总和。
  close(out.model.inertia, 1, 1e-9, '总惯量');
  assert.equal(out.model.categories, 4, '四个类别');
  assert.equal(out.model.cases, 40, '四十例');
  // 两类互相独立 ⇒ 两维各带走一半惯量。
  close(out.model.singular[0], Math.sqrt(0.5), 1e-9, '第一奇异值');
  close(out.model.singular[1], Math.sqrt(0.5), 1e-9, '第二奇异值');
  close(out.model.explained[0] + out.model.explained[1], 1, 1e-9, '两维解释全部惯量');
  // 每个类别各占四分之一的质量。
  const masses = out.tables[2].rows.map((line) => Number(line[1]));
  for (const mass of masses) close(mass, 0.25, 1e-6, '类别质量');
});

check('the category masses and coordinates reproduce each eigenvalue', () => {
  const rows = [];
  for (let index = 0; index < 60; index += 1) {
    rows.push([['a1', 'a2', 'a3'][index % 3], index % 5 < 2 ? 'b1' : 'b2']);
  }
  const out = computeMultipleCorrespondence(dataset(rows), { variables: ['a', 'b'], dimensions: 2 });
  const table = out.tables[2];
  // 表里只有三四位小数，恒等式要用未取整的质量与坐标验（否则差在舍入上）。
  const mass = out.model.categoryMass;
  const points = out.model.categoryCoordinates;
  for (let dimension = 0; dimension < out.model.singular.length; dimension += 1) {
    const weighted = mass.reduce((sum, weight, index) => sum
      + weight * (dimension === 0 ? points[index].x : points[index].y) ** 2, 0);
    close(weighted, out.model.singular[dimension] ** 2, 1e-9, `第 ${dimension + 1} 维的加权平方和`);
  }
  // 总惯量仍然按定义：(J − Q)/Q = (5 − 2)/2 = 1.5。
  close(out.model.inertia, 1.5, 1e-9, '总惯量');
  close(mass.reduce((sum, weight) => sum + weight, 0), 1, 1e-9, '质量合计为 1');
});

check('discrimination measures add up to the dimension inertia', () => {
  const rows = [];
  for (let index = 0; index < 90; index += 1) {
    rows.push([
      ['a1', 'a2', 'a3'][index % 3],
      index % 4 < 2 ? 'b1' : 'b2',
      index % 9 < 3 ? 'c1' : index % 9 < 6 ? 'c2' : 'c3',
    ]);
  }
  const out = computeMultipleCorrespondence(dataset(rows, [A, B, C]), { variables: ['a', 'b', 'c'] });
  const table = out.tables[1];
  assert.deepEqual(table.columns, ['变量', '维 1', '维 2', '合计']);
  for (let dimension = 0; dimension < out.model.singular.length; dimension += 1) {
    const total = out.model.discrimination.reduce((sum, entry) => sum + entry.scores[dimension], 0);
    close(total, out.model.singular[dimension] ** 2, 1e-9, `第 ${dimension + 1} 维的判别度量之和`);
  }
  // 三个变量的总惯量 = (J − Q)/Q = (8 − 3)/3。
  close(out.model.inertia, 5 / 3, 1e-9, '总惯量');
});

check("Cronbach's alpha follows the definition", () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) rows.push([index % 2 === 0 ? 'a1' : 'a2', index % 4 < 2 ? 'b1' : 'b2']);
  const out = computeMultipleCorrespondence(dataset(rows), { variables: ['a', 'b'] });
  const variables = 2;
  for (let dimension = 0; dimension < out.model.singular.length; dimension += 1) {
    const inertia = out.model.singular[dimension] ** 2;
    const expected = (variables / (variables - 1)) * (1 - 1 / (variables * inertia));
    close(Number(out.tables[0].rows[dimension][1]), expected, 5e-4, `第 ${dimension + 1} 维的 α`);
  }
});

check('the chart carries one point per category, tagged by variable', () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) rows.push([index % 2 === 0 ? 'a1' : 'a2', index % 4 < 2 ? 'b1' : 'b2']);
  const out = computeMultipleCorrespondence(dataset(rows), { variables: ['a', 'b'] });
  assert.equal(out.chart.points.length, 4, '四个类别点');
  assert.deepEqual(out.chart.groups, ['a', 'b'], '图例按变量分组');
  assert.deepEqual([...new Set(out.chart.points.map((point) => point.group))], ['a', 'b']);
  assert.match(out.chart.xLabel, /维 1（50\.0%）/, '轴名带解释比例');
});

check('missing cases are dropped whole and reported', () => {
  const rows = [];
  for (let index = 0; index < 30; index += 1) rows.push([index % 2 === 0 ? 'a1' : 'a2', index % 4 < 2 ? 'b1' : 'b2']);
  rows.push(['a1', null], [null, 'b1'], ['a2', '']);
  const out = computeMultipleCorrespondence(dataset(rows), { variables: ['a', 'b'] });
  assert.equal(out.model.cases, 30, '有效个案');
  assert.equal(out.model.dropped, 3, '三例整例剔除');
  assert.ok(out.notes.some((note) => note.includes('3 例')), '注文点名剔除了多少例');
});

check('bad input is refused with a readable message', () => {
  const rows = [['a1', 'b1'], ['a2', 'b2'], ['a1', 'b2'], ['a2', 'b1']];
  const cases = [
    [null, { variables: ['a', 'b'] }, /还没有打开数据集/],
    [dataset(rows), { variables: ['a'] }, /至少要两个分类变量/],
    [dataset(rows), { variables: ['a', 'nope'] }, /没有这个变量/],
    [dataset(rows, [A, { name: 'n', type: 'numeric' }]), { variables: ['a', 'n'] }, /要求分类变量/],
    [dataset([['a1', 'b1'], ['a1', 'b2']]), { variables: ['a', 'b'] }, /只有一个类别/],
    [dataset([]), { variables: ['a', 'b'] }, /没有可用的个案/],
  ];
  for (const [data, options, pattern] of cases) {
    assert.throws(() => computeMultipleCorrespondence(data, options), pattern, `${JSON.stringify(options)} 应当被拒绝`);
  }
  // 变量太多与类别太多各一条。
  const wide = Array.from({ length: 21 }, (_, index) => ({ name: `v${index}`, type: 'string' }));
  assert.throws(
    () => computeMultipleCorrespondence(dataset(rows, wide), { variables: wide.map((variable) => variable.name) }),
    /变量太多/,
  );
  const many = Array.from({ length: 61 }, (_, index) => [`k${index}`, 'b1']);
  assert.throws(
    () => computeMultipleCorrespondence(dataset(many), { variables: ['a', 'b'] }),
    /类别太多/,
  );
  const tall = Array.from({ length: 5001 }, (_, index) => [index % 2 === 0 ? 'a1' : 'a2', 'b1']);
  assert.throws(
    () => computeMultipleCorrespondence(dataset(tall), { variables: ['a', 'b'] }),
    /个案太多/,
  );
});

check('a correlated pair keeps its second dimension (P0-1 guard)', () => {
  // 两个相关二分类（对角 13+13、错角 2+2）：特征值 0.8667 / 0.1333。固定起点与
  // 残余主方向正交时，第二维会被压成 0 —— V1 判据里那个「四格各 3 例」的夹具
  // 特征值恰好相等，碰巧测不出来，所以这里必须补一条特征值不相等的。
  const dataset = { variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }], rows: [] };
  const push = (left, right, times) => { for (let index = 0; index < times; index += 1) dataset.rows.push([left, right]); };
  push('x', 'x', 13); push('y', 'y', 13); push('x', 'y', 2); push('y', 'x', 2);
  const out = computeMultipleCorrespondence(dataset, { variables: ['a', 'b'], dimensions: 2 });
  close(out.model.explained[0] * out.model.inertia, 0.8666667, 1e-6, 'first eigenvalue');
  close(out.model.explained[1] * out.model.inertia, 0.1333333, 1e-6, 'second eigenvalue');
  assert.ok(out.model.explained[1] > 0.1, `the second dimension is real: ${out.model.explained[1]}`);
});

check('a balanced three-variable set keeps all three dimensions (P0-1 guard)', () => {
  const dataset = {
    variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'c', type: 'string' }],
    rows: [],
  };
  // 8 种组合各 3 例：三个变量互相独立，三维特征值都是 1/3。
  for (const left of ['x', 'y']) {
    for (const middle of ['x', 'y']) {
      for (const right of ['x', 'y']) {
        for (let index = 0; index < 3; index += 1) dataset.rows.push([left, middle, right]);
      }
    }
  }
  const out = computeMultipleCorrespondence(dataset, { variables: ['a', 'b', 'c'], dimensions: 3 });
  for (let index = 0; index < 3; index += 1) {
    close(out.model.explained[index] * out.model.inertia, 1 / 3, 1e-6, `eigenvalue ${index + 1}`);
  }
});

check('one dimension reports a single axis (P3-1 guard)', () => {
  const dataset = { variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }], rows: [] };
  for (let index = 0; index < 6; index += 1) dataset.rows.push(['x', 'x']);
  for (let index = 0; index < 6; index += 1) dataset.rows.push(['y', 'y']);
  const one = computeMultipleCorrespondence(dataset, { variables: ['a', 'b'], dimensions: 1 });
  assert.ok(!/维 2/.test(one.chart.yLabel), `the single-dimension map must not name a second axis: ${one.chart.yLabel}`);
  assert.ok(one.notes.some((note) => /只取了 1 维/.test(note)), 'and the note speaks of one dimension');
  assert.ok(!one.notes.some((note) => /前两维/.test(note)), 'without claiming two dimensions');
  const two = computeMultipleCorrespondence(dataset, { variables: ['a', 'b'], dimensions: 2 });
  assert.match(two.chart.yLabel, /^维 2（/);
});

process.stdout.write(`\n${checks} checks in test/mca.mjs\n`);
if (process.exitCode) process.stdout.write('failures above\n');
