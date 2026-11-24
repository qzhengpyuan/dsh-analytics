// 泊松回归：计数因变量、对数连接。
//
// PSPP 2.1.3 没有能直接拟合泊松回归的过程（GENLOG 只做列联表的对数线性
// 模型，NLR 要手写模型表达式），所以这里用 IRLS 自己算：log μ = xβ，
// 迭代 β ← (X'WX)⁻¹X'Wz，W = diag(μ)，z = xβ + (y − μ)/μ。它与牛顿法是
// 同一个不动点（对数似然的 Hessian 恰好是 −X'WX），因此两种写法只在数值
// 细节上有区别；本实现对分数检验、信息矩阵与偏差都用同一组 μ。
import { invert } from './linalg.js';
import { chiSquareP } from './tables.js';
import { isUserMissing } from './missing.js';

export const MAX_TERMS = 10;

const fixed = (value, digits = 4) => Number(value).toFixed(digits);
const pText = (value) => {
  if (!Number.isFinite(value)) return '—';
  if (value < 0.001) return '< 0.001';
  return fixed(value, 6).replace(/0+$/, '').replace(/\.$/, '');
};

function numeric(variable) {
  return variable?.type !== 'string';
}

function columnOf(dataset, name) {
  const index = dataset.variables.findIndex((variable) => variable.name === name);
  if (index < 0) throw new Error(`没有这个变量：${name}`);
  return index;
}

function labelOf(raw, variable) {
  if (raw === null || raw === undefined || raw === '') return '—';
  return typeof raw === 'number' ? fixed(raw, 6) : String(raw);
}

function isCount(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw - Math.round(raw)) < 1e-9;
}

// ln Γ(x)，Lanczos 近似（g = 7，n = 9）。只用来算 ln(y!)。
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let index = 1; index < 9; index += 1) sum += LANCZOS[index] / (z + index);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

// 正态尾概率：P(|Z| > |z|)，用 erfcc 有理逼近（|误差| < 1.2e-7）。
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const coefficients = [-1.3026537197817094, 6.4196979235649026e-1,
    1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4,
    3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15];
  let d = 0;
  let dd = 0;
  for (let index = coefficients.length - 1; index > 0; index -= 1) {
    const tmp = d;
    d = ty * d - dd + coefficients[index];
    dd = tmp;
  }
  const answer = t * Math.exp(-z * z + 0.5 * (coefficients[0] + ty * d) - dd);
  return x >= 0 ? answer : 2 - answer;
}

function twoSidedNormal(z) {
  return erfc(Math.abs(z) / Math.SQRT2);
}

function design(rows, names) {
  return rows.map((row) => [1, ...names.map((name) => row[name])]);
}

function muOf(x, beta) {
  const linear = x.reduce((sum, value, term) => sum + value * beta[term], 0);
  return Math.exp(linear);
}

function logLikelihood(rows, beta) {
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const mu = muOf(rows[index].x, beta);
    const y = rows[index].y;
    total += y * Math.log(mu) - mu - logGamma(y + 1);
  }
  return total;
}

function devianceOf(rows, beta) {
  let total = 0;
  for (const row of rows) {
    const mu = muOf(row.x, beta);
    const y = row.y;
    total += y === 0 ? 2 * mu : 2 * (y * Math.log(y / mu) - (y - mu));
  }
  return total;
}

function pearsonOf(rows, beta) {
  let total = 0;
  for (const row of rows) {
    const mu = muOf(row.x, beta);
    total += ((row.y - mu) ** 2) / mu;
  }
  return total;
}

function scoreOf(rows, beta) {
  return rows[0].x.map((_, term) => rows.reduce((sum, row) => {
    const mu = muOf(row.x, beta);
    return sum + (row.y - mu) * row.x[term];
  }, 0));
}

function informationOf(rows, beta) {
  const width = rows[0].x.length;
  const matrix = Array.from({ length: width }, () => new Array(width).fill(0));
  for (const row of rows) {
    const mu = muOf(row.x, beta);
    for (let a = 0; a < width; a += 1) {
      for (let b = 0; b < width; b += 1) matrix[a][b] += mu * row.x[a] * row.x[b];
    }
  }
  return matrix;
}

/**
 * Fits a Poisson regression with a log link.
 *
 * The dependent variable has to be a non-negative integer count: a rate
 * variable would need an offset, and a Poisson likelihood on a fraction is
 * meaningless. Overdispersion is reported rather than corrected — the scale
 * factor is printed so the reader can decide, which is what SPSS's
 * `GENLIN` does when you ask for it explicitly.
 */
export function computePoisson(dataset, options = {}) {
  const dependent = options.dependent;
  const names = Array.isArray(options.independents) ? options.independents : [];
  if (!dependent) throw new Error('泊松回归要先选一个计数因变量');
  // 不带自变量是合法的：仅截距模型是似然比检验的基准，也是「这些计数到底
  // 能不能用泊松描述」的第一问。界面上要求至少勾一个，宿主这里不挡。
  if (names.length > MAX_TERMS) throw new Error(`一次最多 ${MAX_TERMS} 个自变量：再多就该先做变量筛选`);

  const yIndex = columnOf(dataset, dependent);
  const yVariable = dataset.variables[yIndex];
  if (!numeric(yVariable)) throw new Error(`泊松回归的因变量要求数值变量：${dependent} 是文本变量`);
  const termIndexes = names.map((name) => {
    const index = columnOf(dataset, name);
    if (!numeric(dataset.variables[index])) {
      throw new Error(`自变量要求数值变量：${name} 是文本变量（分类自变量先做成哑变量）`);
    }
    return index;
  });

  const rows = [];
  let dropped = 0;
  const offenders = new Set();
  for (const values of dataset.rows) {
    const raw = values[yIndex];
    const blank = (value) => value === null || value === undefined || value === '';
    const missing = blank(raw)
      || isUserMissing(yVariable, raw)
      || termIndexes.some((index) => blank(values[index]) || isUserMissing(dataset.variables[index], values[index]));
    if (missing) {
      dropped += 1;
      continue;
    }
    if (!isCount(raw)) {
      offenders.add(labelOf(raw, yVariable));
      continue;
    }
    if (raw < 0) throw new Error(`泊松回归的因变量不能是负数：第 ${rows.length + 1} 个个案是 ${fixed(raw, 6)}`);
    const row = { y: raw, x: [1, ...termIndexes.map((index) => Number(values[index]))] };
    if (row.x.some((value) => !Number.isFinite(value))) {
      throw new Error('泊松回归的自变量必须是数值：有取值读不成数字');
    }
    rows.push(row);
  }
  if (offenders.size > 0) {
    const sample = [...offenders].slice(0, 3).join('、');
    throw new Error(`泊松回归的因变量必须是非负整数计数：「${dependent}」里有 ${sample} 这样的小数或非数字。如果它是比率（比如每千人发病率），要做成「事件数 + 暴露量」的形式；如果它是连续测量值，请用线性回归或 Logistic 回归`);
  }
  if (rows.length === 0) throw new Error('没有可用的个案：因变量或自变量全部缺失');
  const width = names.length + 1;
  if (rows.length <= width) throw new Error(`个案太少：${rows.length} 个个案拟合不了 ${width} 个参数`);

  const mean = rows.reduce((sum, row) => sum + row.y, 0) / rows.length;
  if (mean <= 0) throw new Error(`因变量「${dependent}」的取值全是 0：泊松回归的均值必须大于 0`);

  // 仅截距模型有闭式解 μ = 均值，用它作为起始值与似然比检验的基准。
  const nullBeta = new Array(width).fill(0);
  nullBeta[0] = Math.log(mean);
  const nullLogLikelihood = logLikelihood(rows, nullBeta);

  let beta = nullBeta.slice();
  let iterations = 0;
  let converged = false;
  let singular = false;
  let covariance = null;
  while (iterations < 100) {
    iterations += 1;
    const score = scoreOf(rows, beta);
    const information = informationOf(rows, beta);
    let step;
    try {
      step = invert(information).map((row) => row.reduce((sum, value, column) => sum + value * score[column], 0));
    } catch (error) {
      singular = true;
      break;
    }
    let scale = 1;
    const before = logLikelihood(rows, beta);
    let accepted = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const trial = beta.map((value, term) => value + scale * step[term]);
      if (trial.some((value) => !Number.isFinite(value))) { scale /= 2; continue; }
      const after = logLikelihood(rows, trial);
      if (after >= before - 1e-12) {
        beta = trial;
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) break;
    const largest = Math.max(...step.map((value) => Math.abs(value)));
    if (largest < 1e-10 || Math.abs(logLikelihood(rows, beta) - before) < 1e-12) {
      converged = true;
      break;
    }
  }

  const logLikelihoodValue = logLikelihood(rows, beta);
  let separated = false;
  try {
    covariance = invert(informationOf(rows, beta));
  } catch (error) {
    covariance = null;
    separated = true;
  }
  if (Math.max(...beta.map((value) => Math.abs(value))) > 25) separated = true;
  const residualDf = Math.max(1, rows.length - width);
  const deviance = devianceOf(rows, beta);
  const pearson = pearsonOf(rows, beta);
  const dispersion = pearson / residualDf;
  const aic = -2 * logLikelihoodValue + 2 * width;
  const bic = -2 * logLikelihoodValue + width * Math.log(rows.length);
  const chiSquare = Math.max(0, 2 * (logLikelihoodValue - nullLogLikelihood));
  const df = width - 1;
  const p = df > 0 ? chiSquareP(chiSquare, df) : Number.NaN;

  const coefficients = names.map((name, index) => {
    const estimate = beta[index + 1];
    const variance = covariance ? covariance[index + 1][index + 1] : Number.NaN;
    const error = variance > 0 ? Math.sqrt(variance) : Number.NaN;
    const wald = Number.isFinite(error) && error > 0 ? (estimate / error) ** 2 : Number.NaN;
    return {
      name,
      estimate,
      error,
      wald,
      p: Number.isFinite(wald) ? chiSquareP(wald, 1) : Number.NaN,
      exp: Math.exp(estimate),
    };
  });
  const interceptVariance = covariance ? covariance[0][0] : Number.NaN;
  const interceptError = interceptVariance > 0 ? Math.sqrt(interceptVariance) : Number.NaN;

  const fitRows = [
    ['仅截距', fixed(-2 * nullLogLikelihood, 3), '—', '—', '—'],
    ['最终模型', fixed(-2 * logLikelihoodValue, 3), fixed(chiSquare, 3), String(df), pText(p)],
  ];
  const goodnessRows = [
    ['偏差（Deviance）', fixed(deviance, 3), String(residualDf), fixed(deviance / residualDf, 3)],
    ['Pearson 卡方', fixed(pearson, 3), String(residualDf), fixed(dispersion, 3)],
  ];
  const parameterRows = [
    ['（常数）', fixed(beta[0]), Number.isFinite(interceptError) ? fixed(interceptError) : '—',
      Number.isFinite(interceptError) ? fixed((beta[0] / interceptError) ** 2, 3) : '—',
      '1',
      Number.isFinite(interceptError) ? pText(chiSquareP((beta[0] / interceptError) ** 2, 1)) : '—',
      fixed(Math.exp(beta[0]))],
    ...coefficients.map((entry) => [
      entry.name,
      fixed(entry.estimate),
      Number.isFinite(entry.error) ? fixed(entry.error) : '—',
      Number.isFinite(entry.wald) ? fixed(entry.wald, 3) : '—',
      '1',
      pText(entry.p),
      fixed(entry.exp),
    ]),
  ];

  const notes = [
    `模型：log(预测计数) = ${fixed(beta[0])}${coefficients.map((entry) => `${entry.estimate >= 0 ? ' + ' : ' − '}${fixed(Math.abs(entry.estimate))}×${entry.name}`).join('')}；因变量「${dependent}」的均值是 ${fixed(mean)}。`,
    `似然比检验：相对于仅截距模型，-2 对数似然从 ${fixed(-2 * nullLogLikelihood, 3)} 降到 ${fixed(-2 * logLikelihoodValue, 3)}，χ² = ${fixed(chiSquare, 3)}，df = ${df}，P ${Number.isFinite(p) && p < 0.001 ? '< 0.001' : `= ${pText(p)}`}。`,
    `拟合优度：偏差 ${fixed(deviance, 3)}（df = ${residualDf}），Pearson 卡方 ${fixed(pearson, 3)}；按 Pearson 卡方算的离散参数是 ${fixed(dispersion, 3)}。`,
    dispersion > 1.5
      ? `离散参数 ${fixed(dispersion, 3)} 明显大于 1：计数比泊松模型允许的更分散（过度离散）。系数方向仍可读，但标准误偏小、P 偏乐观；严格推断请改用负二项回归或带离散参数的广义线性模型。`
      : `离散参数接近 1，与泊松假定（方差等于均值）相容。`,
    `Exp(B) 是「自变量增加一个单位时预测计数乘多少倍」；计数因变量若是事件数，注意把暴露量（观察时间、人年）作为自变量取对数放入，否则比较的是不同暴露量下的原始计数。`,
    dropped > 0 ? `缺失值按整例剔除：${dropped} 个个案没有进入模型。` : '没有缺失值，全部个案进入模型。',
    separated
      ? '迭代中出现奇异矩阵或系数被推向很大：自变量之间可能完全共线，或者某个自变量把预测计数压到了 0。系数字面上看，但标准误与 P 不再可信。'
      : null,
    converged ? null : `牛顿迭代 ${iterations} 步没有收敛：结果可能不可靠，先检查自变量是否共线或量纲差别过大。`,
  ].filter(Boolean);

  return {
    title: `泊松回归（${dependent}）`,
    tables: [
      { title: '模型拟合信息', columns: ['模型', '-2 对数似然', '似然比 χ²', 'df', 'P'], rows: fitRows },
      { title: '拟合优度', columns: ['', '值', 'df', '值/df'], rows: goodnessRows },
      { title: '参数估计', columns: ['参数', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)'], rows: parameterRows },
    ],
    matrix: [['参数', 'B', '标准误', 'Wald', 'df', 'P', 'Exp(B)'], ...parameterRows],
    notes,
    model: {
      dependent,
      independents: names,
      cases: rows.length,
      dropped,
      mean,
      logLikelihood: logLikelihoodValue,
      nullLogLikelihood,
      chiSquare,
      df,
      p,
      deviance,
      pearson,
      residualDf,
      dispersion,
      aic,
      bic,
      iterations,
      converged: converged && !singular,
      separated,
      coefficients: [
        { name: '（常数）', estimate: beta[0], error: interceptError, exp: Math.exp(beta[0]) },
        ...coefficients,
      ],
    },
  };
}
