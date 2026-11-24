// 两阶段最小二乘（SPSS 的「分析 → 回归 → 二阶段最小二乘」，2SLS）。
//
// 内生自变量 X_e 与工具变量 Z 的关系先估出来，第二段用 X_e 的拟合值代替它
// 本身。代数上与 β = (X'P_Z X)⁻¹X'P_Z y 完全等价（P_Z = Z(Z'Z)⁻¹Z'），这里
// 直接解正规方程，不做两遍回归 —— 两遍回归的第二段标准误是错的（它忘了
// X̂ 本身是估出来的），所以标准误统一用 σ²(X'P_Z X)⁻¹，残差用真实残差。
//
// PSPP 2.1.3 没有 2SLS 过程（`2SLS` 不是有效命令），因此全在这里算。
import { invert, solve } from './linalg.js';
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

function matrixProduct(left, right) {
  const rows = left.length;
  const inner = right.length;
  const columns = right[0].length;
  const out = Array.from({ length: rows }, () => new Array(columns).fill(0));
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let sum = 0;
      for (let term = 0; term < inner; term += 1) sum += left[row][term] * right[term][column];
      out[row][column] = sum;
    }
  }
  return out;
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function vectorProduct(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

/**
 * Fits y = Xβ where some columns of X are endogenous. Instruments plus the
 * exogenous regressors make up the instrument matrix Z.
 */
export function computeTwoStage(dataset, options = {}) {
  const dependent = options.dependent;
  const endogenous = Array.isArray(options.endogenous) ? options.endogenous : [];
  const instruments = Array.isArray(options.instruments) ? options.instruments : [];
  const exogenous = Array.isArray(options.exogenous) ? options.exogenous : [];
  if (!dependent) throw new Error('二阶段最小二乘要先选一个因变量');
  if (endogenous.length === 0) throw new Error('二阶段最小二乘至少要一个内生自变量');
  if (instruments.length === 0) throw new Error('二阶段最小二乘至少要一个工具变量');
  if (instruments.length < endogenous.length) {
    throw new Error(`工具变量不足：${endogenous.length} 个内生自变量至少要 ${endogenous.length} 个工具变量，现在只有 ${instruments.length} 个 —— 这属于识别不足，方程解不出来`);
  }
  if (endogenous.length + exogenous.length > MAX_TERMS) {
    throw new Error(`一次最多 ${MAX_TERMS} 个自变量：再多就该先做变量筛选`);
  }

  const yIndex = columnOf(dataset, dependent);
  if (!numeric(dataset.variables[yIndex])) throw new Error(`因变量要求数值变量：${dependent} 是文本变量`);
  const pick = (names, role) => names.map((name) => {
    const index = columnOf(dataset, name);
    if (!numeric(dataset.variables[index])) {
      throw new Error(`${role}要求数值变量：${name} 是文本变量（分类变量先做成哑变量）`);
    }
    return index;
  });
  const endogIndexes = pick(endogenous, '内生自变量');
  const exogIndexes = pick(exogenous, '外生自变量');
  const instrumentIndexes = pick(instruments, '工具变量');

  const used = [yIndex, ...endogIndexes, ...exogIndexes, ...instrumentIndexes];
  const rows = [];
  let dropped = 0;
  for (const values of dataset.rows) {
    const missing = used.some((index) => blank(values[index]) || isUserMissing(dataset.variables[index], values[index]));
    if (missing) {
      dropped += 1;
      continue;
    }
    const read = (index) => Number(values[index]);
    if (used.some((index) => !Number.isFinite(read(index)))) {
      throw new Error('因变量或自变量里有读不成数字的取值');
    }
    rows.push({
      y: read(yIndex),
      endogenous: endogIndexes.map(read),
      exogenous: exogIndexes.map(read),
      instruments: [1, ...exogIndexes.map(read), ...instrumentIndexes.map(read)],
      x: [1, ...exogIndexes.map(read), ...endogIndexes.map(read)],
    });
  }
  const width = 1 + exogenous.length + endogenous.length;
  if (rows.length <= width) throw new Error(`有效个案太少：${rows.length} 个个案拟合不了 ${width} 个参数`);

  const X = rows.map((row) => row.x);
  const Z = rows.map((row) => row.instruments);
  const y = rows.map((row) => row.y);
  const ZtZ = matrixProduct(transpose(Z), Z);
  let ZtZInverse;
  try {
    ZtZInverse = invert(ZtZ);
  } catch (error) {
    throw new Error('工具变量之间完全共线：工具变量矩阵（含常数项与外生自变量）不可逆，先把重复的工具变量去掉');
  }
  const XtZ = matrixProduct(transpose(X), Z);
  const ZtX = transpose(XtZ);
  const middle = matrixProduct(matrixProduct(XtZ, ZtZInverse), ZtX);
  const right = vectorProduct(matrixProduct(matrixProduct(XtZ, ZtZInverse), transpose(Z)), y);
  let beta;
  let covarianceMiddle;
  try {
    beta = solve(middle, right);
    covarianceMiddle = invert(middle);
  } catch (error) {
    throw new Error('两阶段最小二乘的方程是奇异的：内生自变量与工具变量之间没有足够相关，或者外生部分完全共线');
  }

  const fitted = X.map((row) => row.reduce((sum, value, index) => sum + value * beta[index], 0));
  const residuals = y.map((value, index) => value - fitted[index]);
  const sse = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const mean = y.reduce((sum, value) => sum + value, 0) / y.length;
  const sst = y.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const dfResidual = rows.length - width;
  const mse = sse / dfResidual;
  const rSquare = sst > 0 ? 1 - sse / sst : 0;
  const standardErrors = covarianceMiddle.map((row, index) => (row[index] > 0 ? Math.sqrt(mse * row[index]) : Number.NaN));
  const names = [...exogenous, ...endogenous];
  const coefficients = names.map((name, offset) => {
    const index = offset + 1;
    const estimate = beta[index];
    const error = standardErrors[index];
    const t = Number.isFinite(error) && error > 0 ? estimate / error : Number.NaN;
    return { name, estimate, error, t, p: Number.isFinite(t) ? studentP(t, dfResidual) : Number.NaN };
  });

  // 第一阶段：每个内生自变量对「外生 + 工具」做一次 OLS，报告 R² 与整体 F。
  // 弱工具的直接症状就是这一步的 F 很小。
  const stageOne = endogenous.map((name, position) => {
    const column = rows.map((row) => row.endogenous[position]);
    const columnMean = column.reduce((sum, value) => sum + value, 0) / column.length;
    const zt = transpose(Z);
    const ztz = matrixProduct(zt, Z);
    const ztColumn = vectorProduct(zt, column);
    const coefficientsZ = solve(ztz, ztColumn);
    const predicted = Z.map((row) => row.reduce((sum, value, index) => sum + value * coefficientsZ[index], 0));
    const residualSum = column.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0);
    const totalSum = column.reduce((sum, value) => sum + (value - columnMean) ** 2, 0);
    const rSquareStage = totalSum > 0 ? 1 - residualSum / totalSum : 0;
    const dfNumerator = Z[0].length - 1;
    const dfDenominator = column.length - Z[0].length;
    const fStage = dfDenominator > 0 && dfNumerator > 0
      ? (rSquareStage / dfNumerator) / ((1 - rSquareStage) / dfDenominator)
      : Number.NaN;
    return {
      name,
      rSquare: rSquareStage,
      f: fStage,
      p: Number.isFinite(fStage) ? fP(fStage, dfNumerator, dfDenominator) : Number.NaN,
      dfNumerator,
      dfDenominator,
    };
  });

  const overIdentified = instruments.length > endogenous.length;
  const summaryRows = [
    ['R²', fixed(rSquare), String(rows.length), String(dfResidual)],
    ['内生 / 工具', String(endogenous.length), String(instruments.length), fixed(Math.sqrt(mse), 4)],
  ];
  const stageRows = stageOne.map((entry) => [
    entry.name,
    Number.isFinite(entry.rSquare) ? fixed(entry.rSquare) : '—',
    Number.isFinite(entry.f) ? fixed(entry.f, 3) : '—',
    pText(entry.p),
    `${entry.dfNumerator}/${entry.dfDenominator}`,
  ]);
  const coefficientRows = [
    ['（常数）', fixed(beta[0]), Number.isFinite(standardErrors[0]) ? fixed(standardErrors[0]) : '—',
      Number.isFinite(standardErrors[0]) && standardErrors[0] > 0 ? fixed(beta[0] / standardErrors[0], 3) : '—',
      Number.isFinite(standardErrors[0]) && standardErrors[0] > 0 ? pText(studentP(beta[0] / standardErrors[0], dfResidual)) : '—'],
    ...coefficients.map((entry) => [
      entry.name,
      fixed(entry.estimate),
      Number.isFinite(entry.error) ? fixed(entry.error) : '—',
      Number.isFinite(entry.t) ? fixed(entry.t, 3) : '—',
      pText(entry.p),
    ]),
  ];

  const notes = [
    `模型：${dependent} = ${fixed(beta[0])}${coefficients.map((entry) => `${entry.estimate >= 0 ? ' + ' : ' − '}${fixed(Math.abs(entry.estimate))}×${entry.name}`).join('')}；工具变量 ${instruments.join('、')}。`,
    '标准误按同方差假设算（σ²(X\'P_Z X)⁻¹），残差用真实残差 —— 不能拿「第二段回归」的标准误，那会把估出来的拟合值当成观测值。',
    `第一阶段：${stageOne.map((entry) => `${entry.name} 的 R² ${fixed(entry.rSquare)}、F ${Number.isFinite(entry.f) ? fixed(entry.f) : '—'}`).join('；')}。经验判据是 F 明显大于 10 才算强工具；F 小意味着工具与内生变量关系弱，2SLS 的系数会被放大成噪声。`,
    overIdentified
      ? `过度识别：工具比内生多 ${instruments.length - endogenous.length} 个，这允许你检验工具的外生性（Sargan / Hansen J），本版不自动做 —— 先确认工具的经济含义再谈统计检验。`
      : '恰好识别：工具数与内生变量数相同，无法用数据检验工具是否外生，只能靠理论论证。',
    dropped > 0 ? `缺失值按整例剔除：${dropped} 个个案没有进入模型。` : '没有缺失值。',
    '2SLS 只处理「内生自变量被测量误差或反向因果污染」这一种情形；如果工具本身与误差项相关，系数仍然有偏，而且比 OLS 偏得更远。',
  ];

  return {
    title: `二阶段最小二乘（${dependent}）`,
    tables: [
      { title: '模型摘要', columns: ['', 'R²', '个案数', '残差 df'], rows: summaryRows },
      { title: '第一阶段', columns: ['内生变量', 'R²', 'F', 'P', 'df'], rows: stageRows },
      { title: '系数', columns: ['变量', 'B', '标准误', 't', 'P'], rows: coefficientRows },
    ],
    matrix: [['变量', 'B', '标准误', 't', 'P'], ...coefficientRows],
    notes,
    model: {
      dependent,
      endogenous,
      instruments,
      exogenous,
      cases: rows.length,
      dropped,
      rSquare,
      standardError: Math.sqrt(mse),
      dfResidual,
      overIdentified,
      stageOne,
      coefficients: [
        { name: '（常数）', estimate: beta[0], error: standardErrors[0] },
        ...coefficients,
      ],
    },
  };
}
