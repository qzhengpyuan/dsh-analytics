// 加权最小二乘（SPSS 的「分析 → 回归 → 权重估计」，WLS）。
//
// 模型与普通回归同形，只是每个个案带权重 w：残差方差假设为 σ²/w，所以
// β = (X'WX)⁻¹X'Wy。PSPP 2.1.3 没有 WLS 过程（`REGRESSION` 不吃权重变量，
// `GENLOG` 是另一族），因此这里自己算。权重为 0 或负数的个案被剔除并计数 ——
// 静默地按 0 处理会让人以为它参与了拟合。
import { invert } from './linalg.js';
import { fP, studentP } from './tables.js';
import { isUserMissing } from './missing.js';

export const MAX_TERMS = 10;

const fixed = (value, digits = 4) => Number(value).toFixed(digits);
const pText = (value) => {
  if (!Number.isFinite(value)) return '—';
  if (value < 0.001) return '< 0.001';
  return fixed(value, 6).replace(/0+$/, '').replace(/\.$/, '');
};
const blank = (value) => value === null || value === undefined || value === '';

function numeric(variable) {
  return variable?.type !== 'string';
}

function columnOf(dataset, name) {
  const index = dataset.variables.findIndex((variable) => variable.name === name);
  if (index < 0) throw new Error(`没有这个变量：${name}`);
  return index;
}

function crossProduct(rows, width) {
  const matrix = Array.from({ length: width }, () => new Array(width).fill(0));
  const vector = new Array(width).fill(0);
  for (const row of rows) {
    for (let a = 0; a < width; a += 1) {
      vector[a] += row.w * row.x[a] * row.y;
      for (let b = 0; b < width; b += 1) matrix[a][b] += row.w * row.x[a] * row.x[b];
    }
  }
  return { matrix, vector };
}

function solve(matrix, vector) {
  const inverse = invert(matrix);
  return inverse.map((line) => line.reduce((sum, value, column) => sum + value * vector[column], 0));
}

/**
 * Fits y = Xβ with case weights. Weights enter the normal equations and the
 * sums of squares; the residual degrees of freedom count cases, not weight
 * units, which is what SPSS reports for a single weight variable.
 */
export function computeWls(dataset, options = {}) {
  const dependent = options.dependent;
  const names = Array.isArray(options.independents) ? options.independents : [];
  const weightName = options.weight;
  if (!dependent) throw new Error('权重估计要先选一个因变量');
  if (names.length === 0) throw new Error('权重估计至少要一个自变量');
  if (names.length > MAX_TERMS) throw new Error(`一次最多 ${MAX_TERMS} 个自变量：再多就该先做变量筛选`);
  if (!weightName) throw new Error('权重估计要选一个权重变量');

  const yIndex = columnOf(dataset, dependent);
  const yVariable = dataset.variables[yIndex];
  if (!numeric(yVariable)) throw new Error(`因变量要求数值变量：${dependent} 是文本变量`);
  const wIndex = columnOf(dataset, weightName);
  const wVariable = dataset.variables[wIndex];
  if (!numeric(wVariable)) throw new Error(`权重变量要求数值变量：${weightName} 是文本变量`);
  const termIndexes = names.map((name) => {
    const index = columnOf(dataset, name);
    if (!numeric(dataset.variables[index])) {
      throw new Error(`自变量要求数值变量：${name} 是文本变量（分类自变量先做成哑变量）`);
    }
    return index;
  });

  const rows = [];
  let dropped = 0;
  let nonPositive = 0;
  let weightTotal = 0;
  for (const values of dataset.rows) {
    const rawY = values[yIndex];
    const rawW = values[wIndex];
    const missing = blank(rawY) || blank(rawW)
      || isUserMissing(yVariable, rawY)
      || isUserMissing(wVariable, rawW)
      || termIndexes.some((index) => blank(values[index]) || isUserMissing(dataset.variables[index], values[index]));
    if (missing) {
      dropped += 1;
      continue;
    }
    const weight = Number(rawW);
    if (!Number.isFinite(weight)) throw new Error(`权重变量「${weightName}」里有读不成数字的取值`);
    if (weight <= 0) {
      nonPositive += 1;
      continue;
    }
    const row = { y: Number(rawY), w: weight, x: [1, ...termIndexes.map((index) => Number(values[index]))] };
    if (!Number.isFinite(row.y) || row.x.some((value) => !Number.isFinite(value))) {
      throw new Error('因变量或自变量里有读不成数字的取值');
    }
    weightTotal += weight;
    rows.push(row);
  }
  if (nonPositive > 0 && rows.length === 0) {
    throw new Error(`权重变量「${weightName}」没有正数取值：加权最小二乘要求权重为正，零或负数会被剔除`);
  }
  const width = names.length + 1;
  if (rows.length <= width) {
    throw new Error(`有效个案太少：${rows.length} 个正权重个案拟合不了 ${width} 个参数`);
  }

  const { matrix, vector } = crossProduct(rows, width);
  let beta;
  let inverse;
  try {
    inverse = invert(matrix);
    beta = solve(matrix, vector);
  } catch (error) {
    throw new Error('加权最小二乘的方程是奇异的：自变量之间完全共线，或者某个自变量的权重全落在同一取值上');
  }

  const weightedMean = rows.reduce((sum, row) => sum + row.w * row.y, 0) / weightTotal;
  let sse = 0;
  let ssr = 0;
  let fitted;
  let residuals;
  try {
    fitted = rows.map((row) => row.x.reduce((sum, value, term) => sum + value * beta[term], 0));
    residuals = rows.map((row, index) => row.y - fitted[index]);
    sse = rows.reduce((sum, row, index) => sum + row.w * residuals[index] ** 2, 0);
    ssr = rows.reduce((sum, row, index) => sum + row.w * (fitted[index] - weightedMean) ** 2, 0);
  } catch (error) {
    throw new Error(`矩阵不可逆：${error.message}`);
  }
  const sst = ssr + sse;
  const dfRegression = width - 1;
  const dfResidual = rows.length - width;
  const mse = sse / dfResidual;
  const rSquare = sst > 0 ? ssr / sst : 0;
  const adjusted = 1 - (1 - rSquare) * ((rows.length - 1) / dfResidual);
  const standardError = Math.sqrt(mse);
  const fStatistic = dfRegression > 0 ? (ssr / dfRegression) / mse : Number.NaN;
  const fPValue = dfRegression > 0 ? fP(fStatistic, dfRegression, dfResidual) : Number.NaN;

  const standardErrors = [0, ...Array.from({ length: dfRegression }, (_, index) => index + 1)]
    .map((term) => (inverse[term][term] > 0 ? Math.sqrt(mse * inverse[term][term]) : Number.NaN));
  const coefficients = names.map((name, index) => {
    const term = index + 1;
    const estimate = beta[term];
    const error = standardErrors[term];
    const t = Number.isFinite(error) && error > 0 ? estimate / error : Number.NaN;
    return { name, estimate, error, t, p: Number.isFinite(t) ? studentP(t, dfResidual) : Number.NaN };
  });

  const allEqual = rows.every((row) => Math.abs(row.w - rows[0].w) < 1e-12);
  const extremes = (list) => {
    const sorted = list.map((row) => row.w).sort((left, right) => left - right);
    return `${fixed(sorted[0], 4)} ~ ${fixed(sorted[sorted.length - 1], 4)}`;
  };

  const summaryRows = [
    ['R²', fixed(rSquare), fixed(adjusted), fixed(standardError)],
    ['个案数 / 权重和', String(rows.length), fixed(weightTotal, 4), fixed(weightedMean)],
  ];
  const anovaRows = [
    ['回归', fixed(ssr, 3), String(dfRegression), fixed(ssr / dfRegression, 3), Number.isFinite(fStatistic) ? fixed(fStatistic, 3) : '—', pText(fPValue)],
    ['残差', fixed(sse, 3), String(dfResidual), fixed(mse, 3), '—', '—'],
    ['总计', fixed(sst, 3), String(rows.length - 1), '—', '—', '—'],
  ];
  const coefficientRows = names.map((name, index) => [
    name,
    fixed(coefficients[index].estimate),
    Number.isFinite(coefficients[index].error) ? fixed(coefficients[index].error) : '—',
    Number.isFinite(coefficients[index].t) ? fixed(coefficients[index].t, 3) : '—',
    pText(coefficients[index].p),
  ]);

  const notes = [
    `模型：${dependent} = ${fixed(beta[0])}${coefficients.map((entry) => `${entry.estimate >= 0 ? ' + ' : ' − '}${fixed(Math.abs(entry.estimate))}×${entry.name}`).join('')}（权重变量「${weightName}」）。`,
    `加权统计：权重合计 ${fixed(weightTotal, 4)}、加权均值 ${fixed(weightedMean, 4)}、权重范围 ${extremes(rows)}。残差自由度按个案数算（${rows.length} − ${width} = ${dfResidual}），不是按权重之和。`,
    allEqual
      ? '所有权重相同，所以这次结果与普通最小二乘完全一致 —— 权重变量没有提供额外信息。'
      : '解读：权重大表示该个案的残差方差更小（更可信）。系数仍是「自变量增加一个单位、因变量变化多少」，但 R²、F 与标准误都是加权的，不能与不加权的回归直接比。',
    'SPSS 的权重估计还提供按「幂函数 / 指数」自动生成权重；这里只接受一个权重变量，因为它能表达同一件事且更容易核对 —— 想要的权重先算成变量再选它。',
    dropped > 0 ? `缺失值按整例剔除：${dropped} 个个案没有进入模型。` : '没有缺失值。',
    nonPositive > 0 ? `有 ${nonPositive} 个个案的权重是 0 或负数，已剔除（加权最小二乘要求权重为正）。` : null,
  ].filter(Boolean);

  return {
    title: `权重估计（${dependent}）`,
    tables: [
      { title: '模型摘要', columns: ['', 'R²', '调整 R²', '估计标准误'], rows: summaryRows },
      { title: '方差分析', columns: ['', '平方和', 'df', '均方', 'F', 'P'], rows: anovaRows },
      { title: '系数', columns: ['变量', 'B', '标准误', 't', 'P'], rows: coefficientRows },
    ],
    matrix: [['变量', 'B', '标准误', 't', 'P'], ...coefficientRows],
    notes,
    model: {
      dependent,
      independents: names,
      weight: weightName,
      cases: rows.length,
      dropped,
      nonPositive,
      weightTotal,
      weightedMean,
      rSquare,
      adjusted,
      standardError,
      ssr,
      sse,
      sst,
      dfRegression,
      dfResidual,
      f: fStatistic,
      p: fPValue,
      coefficients: [{ name: '（常数）', estimate: beta[0], error: standardErrors[0] }, ...coefficients],
      allEqual,
    },
  };
}
