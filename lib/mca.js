// 多重对应分析（SPSS 的「最优尺度 → 多重对应分析」，PSPP 2.1.3 没有 HOMALS）。
//
// 做法是把 Q 个分类变量摊成一张**指标矩阵**（个案 × 每个变量的每个类别，命中为 1），
// 对这张矩阵做对应分析：标准化残差的主方向就是各维，类别的主坐标就是图上那些点。
// 三条恒等式保证算得对，用例也用它们自证：
//   Σ 列质量 × 类别坐标² = λ（某维的惯量）
//   全部维的惯量合计 = (J − Q) / Q（J = 总类别数、Q = 变量数）
//   某个变量在某维的判别度量 = 它那些类别的「质量 × 坐标²」之和，各变量之和 = λ
import { caCore } from './correspondence.js';
import { isCategorical, isUserMissing } from './missing.js';

const MAX_VARIABLES = 20;
const MAX_CATEGORIES = 60;
const MAX_CASES = 5000;

function labelOf(variable, raw) {
  const key = String(raw);
  const labels = variable?.valueLabels;
  if (labels && Object.prototype.hasOwnProperty.call(labels, key)) return `${key}（${labels[key]}）`;
  return key;
}

function sortKeys(values) {
  const numeric = values.every((value) => value !== '' && Number.isFinite(Number(value)));
  if (numeric) return [...values].sort((left, right) => Number(left) - Number(right));
  return [...values].sort((left, right) => String(left).localeCompare(String(right), 'zh-Hans-CN'));
}

/**
 * Multiple correspondence analysis of two or more categorical variables.
 *
 * `options.variables` names them; `options.dimensions` (1–3) is how many
 * dimensions to keep. The indicator matrix is analysed exactly like a
 * contingency table, so the numbers match a hand-run correspondence analysis on
 * the same indicator matrix.
 */
export function computeMultipleCorrespondence(dataset, options = {}) {
  if (!dataset) throw new Error('还没有打开数据集');
  const names = [...new Set((options.variables ?? []).filter(Boolean))];
  if (names.length < 2) throw new Error('多重对应分析至少要两个分类变量');
  if (names.length > MAX_VARIABLES) {
    throw new Error(`变量太多：${names.length} 个，多重对应分析在这里最多 ${MAX_VARIABLES} 个（先挑最相关的几组）`);
  }
  const find = (name) => (dataset.variables ?? []).find((variable) => variable.name === name);
  const chosen = names.map((name) => {
    const variable = find(name);
    if (!variable) throw new Error(`没有这个变量：${name}`);
    if (!isCategorical(variable)) throw new Error(`多重对应分析要求分类变量：${name} 是数值变量（先做分箱，或者在变量视图里改成名义变量）`);
    return variable;
  });
  const positions = chosen.map((variable) => dataset.variables.indexOf(variable));

  // 整例剔除：任一所选变量缺失就整行不要（与 SPSS 的缺省一致）。
  const rows = [];
  let dropped = 0;
  for (const row of dataset.rows ?? []) {
    const values = positions.map((position) => row?.[position]);
    const missing = values.some((value, index) => value === null || value === undefined || value === ''
      || isUserMissing(chosen[index], value));
    if (missing) { dropped += 1; continue; }
    rows.push(values);
  }
  if (!rows.length) throw new Error('没有可用的个案：所选变量都有效的行是 0 行');
  if (rows.length > MAX_CASES) {
    throw new Error(`个案太多：${rows.length} 例，多重对应分析在这里最多 ${MAX_CASES} 例（指标矩阵会随个案数膨胀）`);
  }

  // 每个变量的类别（按取值排序），列的顺序就是变量顺序 + 类别顺序。
  const levels = chosen.map((variable, index) => sortKeys([...new Set(rows.map((line) => String(line[index])))]));
  levels.forEach((keys, index) => {
    if (keys.length < 2) throw new Error(`变量「${chosen[index].name}」只有一个类别，没有可比较的东西`);
    if (keys.length > MAX_CATEGORIES) {
      throw new Error(`类别太多：变量「${chosen[index].name}」有 ${keys.length} 个类别，这里最多 ${MAX_CATEGORIES} 个（先合并）`);
    }
  });

  const offsets = [];
  let totalCategories = 0;
  for (const keys of levels) {
    offsets.push(totalCategories);
    totalCategories += keys.length;
  }

  // 一张空类别（没有任何个案）会让列质量为零，对应分析直接除零，所以先查。
  const hits = new Array(totalCategories).fill(0);
  const indicator = rows.map((line) => {
    const vector = new Array(totalCategories).fill(0);
    line.forEach((value, index) => {
      const column = offsets[index] + levels[index].indexOf(String(value));
      vector[column] = 1;
      hits[column] += 1;
    });
    return vector;
  });
  const empty = [];
  hits.forEach((count, column) => {
    if (count === 0) {
      let index = 0;
      while (index + 1 < offsets.length && offsets[index + 1] <= column) index += 1;
      empty.push(`${chosen[index].name}=${levels[index][column - offsets[index]]}`);
    }
  });
  if (empty.length) throw new Error(`有类别一个个案都没有：${empty.join('、')}，多重对应分析拒收空类别，先合并或剔除`);

  const core = caCore(indicator, { dimensions: options.dimensions });
  const variables = chosen.length;
  const dimensions = core.dimensions;
  const singular = core.singular;
  // 分母用定义值（卡方 / 总和 = (J − Q) / Q），而不是前几维特征值之和 ——
  // 类别一多，维数取不完，用和当分母会把解释比例算大。
  const totalInertia = core.inertia;

  // Cronbach's α 是 SPSS 在模型摘要里给的那一列：α = Q/(Q−1) × (1 − 1/(Q·λ))。
  const alpha = (inertia) => (variables > 1 && inertia > 0
    ? (variables / (variables - 1)) * (1 - 1 / (variables * inertia))
    : null);

  // 判别度量：某变量在某维上「质量 × 坐标²」之和；按构造，各变量之和 = 该维惯量。
  const discrimination = chosen.map((variable, index) => {
    const scores = [];
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      let sum = 0;
      for (let offset = 0; offset < levels[index].length; offset += 1) {
        const column = offsets[index] + offset;
        sum += core.columnMass[column] * core.columnCoordinates[column][dimension] ** 2;
      }
      scores.push(sum);
    }
    return { name: variable.name, scores };
  });

  const fixed = (value, digits = 3) => (Number.isFinite(value) ? Number(value).toFixed(digits) : '—');
  const percent = (value) => `${(100 * value).toFixed(1)}%`;

  const tables = [];
  tables.push({
    title: '模型摘要',
    columns: ['维', "Cronbach's α", '惯量', '解释比例', '累计比例'],
    rows: [
      ...singular.map((sigma, index) => [
        String(index + 1),
        alpha(sigma * sigma) === null ? '—' : fixed(alpha(sigma * sigma)),
        fixed(sigma * sigma, 4),
        percent(sigma * sigma / totalInertia),
        percent(singular.slice(0, index + 1).reduce((sum, value) => sum + value * value, 0) / totalInertia),
      ]),
      ['合计', '—', fixed(totalInertia, 4), percent(1), '—'],
    ],
  });
  tables.push({
    title: '判别度量',
    columns: ['变量', ...singular.map((_, index) => `维 ${index + 1}`), '合计'],
    rows: discrimination.map((entry) => [
      entry.name,
      ...entry.scores.map((score) => fixed(score)),
      fixed(entry.scores.reduce((sum, score) => sum + score, 0)),
    ]),
  });
  const points = [];
  tables.push({
    title: '类别坐标',
    columns: ['变量 = 类别', '质量', '维 1', '维 2', '维 3'],
    rows: chosen.flatMap((variable, index) => levels[index].map((key, offset) => {
      const column = offsets[index] + offset;
      const label = `${variable.name} = ${labelOf(variable, key)}`;
      points.push({
        label: `${labelOf(variable, key)}`,
        group: variable.name,
        x: core.columnCoordinates[column][0],
        y: core.columnCoordinates[column][1],
      });
      return [
        label,
        fixed(core.columnMass[column], 4),
        fixed(core.columnCoordinates[column][0]),
        fixed(core.columnCoordinates[column][1]),
        fixed(core.columnCoordinates[column][2]),
      ];
    })),
  });

  const model = {
    variables: names,
    cases: rows.length,
    dropped,
    categories: totalCategories,
    dimensions,
    singular,
    inertia: totalInertia,
    explained: singular.map((sigma) => (sigma * sigma) / totalInertia),
    discrimination: discrimination.map((entry) => ({ name: entry.name, scores: entry.scores })),
    categoryCoordinates: points.map((point) => ({ label: point.label, group: point.group, x: point.x, y: point.y })),
    // 未取整的类别质量，用例拿它验「Σ 质量·坐标² = λ」这类恒等式。
    categoryMass: core.columnMass.slice(),
  };

  const notes = [
    `指标矩阵：${rows.length} 个个案 × ${totalCategories} 个类别（${variables} 个分类变量）。全部维的惯量合计 ${fixed(totalInertia, 4)}，`
    + `按公式应为 (类别数 − 变量数) / 变量数 = (${totalCategories} − ${variables}) / ${variables} = ${fixed((totalCategories - variables) / variables, 4)}。`,
    dimensions > 1
      ? `前两维解释 ${percent(model.explained[0] + (model.explained[1] ?? 0))}`
        + `${model.explained[0] + (model.explained[1] ?? 0) >= 0.6 ? '，二维图能看出主要结构' : '，二维图只画出一部分结构，读图时要留余地'}。`
      : `只取了 1 维，它解释 ${percent(model.explained[0] ?? 0)}。`,
    `Cronbach's α 是各维的内部一致性：α = 变量数 /(变量数 − 1) × (1 − 1 /(变量数 × 惯量))。`
    + `α 只反映该维的类别是否成组，不说明变量之间有关系还是没关系。`,
    dropped > 0 ? `有 ${dropped} 例因为所选变量缺失被整例剔除。` : null,
    '类别的距离要按变量分别看：同一个变量的两个类别之间距离有意义，不同变量的类别之间的距离只作定性参考（这与对应分析里行点/列点的规矩相同）。',
  ].filter(Boolean);

  const chart = {
    title: `多重对应分析：${names.join('、')}`,
    xLabel: `维 1（${percent(model.explained[0] ?? 0)}）`,
    // 只取一维时没有第二条轴：轴名不能仍写「维 2」，否则图上的纵轴是个解释不了的空轴。
    yLabel: dimensions > 1 ? `维 2（${percent(model.explained[1] ?? 0)}）` : '（只取了 1 维，纵向无信息）',

    groups: names,
    points,
  };

  return { title: '多重对应分析', tables, model, notes, chart };
}
