// 一般对数线性分析（SPSS 的「分析 → 对数线性 → 一般」；PSPP 2.1.3 没有 HILOGLINEAR）。
//
// 对数线性模型就是「单元格计数 ~ 泊松分布，log(期望频数) = 设计矩阵 × 参数」，
// 所以这里把列联表的每个单元格当成一个个案、用泊松回归拟合：单元格是分类变量的
// 全组合（含频数为 0 的格子），设计矩阵取各效应的哑变量乘积，参数用 IRLS 迭代。
//
// 三条可以独立验算的性质（用例就用它们自证，不依赖引擎答案）：
//   1. 只含 a、b 主效应的模型，期望频数是 r_i·c_j/n —— 与「独立性的估计值」逐位相同；
//   2. 任何被放进模型的项，拟合表的对应边距必须等于观察边距（得分方程的直接结果）；
//   3. 饱和模型的期望频数等于观察频数，G² = 0、自由度 = 0。
import { chiSquareP } from './tables.js';
import { isCategorical, isUserMissing } from './missing.js';

export const MAX_VARIABLES = 4;
export const MAX_CELLS = 5000;

const blank = (value) => value === null || value === undefined || value === '';

function sortKeys(values) {
  const numeric = values.every((value) => value !== '' && Number.isFinite(Number(value)));
  if (numeric) return [...values].sort((left, right) => Number(left) - Number(right));
  return [...values].sort((left, right) => String(left).localeCompare(String(right), 'zh-Hans-CN'));
}

function labelOf(variable, key) {
  const labels = variable?.valueLabels;
  if (labels && Object.prototype.hasOwnProperty.call(labels, key)) return `${key}（${labels[key]}）`;
  return String(key);
}

// 求解 X'WX β = X'Wz 的对称正定方程组（Gauss 消元 + 部分主元）。
// 维度是个位数到几十，直接消元足够，不必上 Cholesky 优化。
function solve(matrix, vector) {
  const size = matrix.length;
  const a = matrix.map((line, index) => [...line, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-12) throw new Error('设计矩阵退化：要先删掉共线的项（比如同时放进 a*b 和它拆开的项）');
    if (pivot !== column) {
      const swap = a[pivot];
      a[pivot] = a[column];
      a[column] = swap;
    }
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row][column] / a[column][column];
      if (factor === 0) continue;
      for (let k = column; k <= size; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  const result = new Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = a[row][size];
    for (let column = row + 1; column < size; column += 1) sum -= a[row][column] * result[column];
    result[row] = sum / a[row][row];
  }
  return result;
}

function invert(matrix) {
  const size = matrix.length;
  const columns = [];
  for (let column = 0; column < size; column += 1) {
    const unit = new Array(size).fill(0);
    unit[column] = 1;
    columns.push(solve(matrix, unit));
  }
  return Array.from({ length: size }, (_, row) => columns.map((line) => line[row]));
}

// 归一化模型说明：把 ['a','b'] 这样的项写成 a×b，方便直接印在表里。
function termLabel(term) {
  return term.join(' × ');
}

function normalizeTerms(names, terms, model) {
  const known = new Set(names);
  if (model === 'saturated') {
    // 饱和模型：所有非空组合。
    const all = [];
    const walk = (start, current) => {
      if (current.length > 0) all.push([...current]);
      for (let index = start; index < names.length; index += 1) {
        current.push(names[index]);
        walk(index + 1, current);
        current.pop();
      }
    };
    walk(0, []);
    return all;
  }
  const requested = Array.isArray(terms) && terms.length > 0 ? terms : names.map((name) => [name]);
  const seen = new Set();
  const result = [];
  for (const entry of requested) {
    const list = Array.isArray(entry) ? entry : String(entry).split('*');
    const term = [...new Set(list.map((name) => String(name).trim()).filter(Boolean))];
    if (term.length === 0) continue;
    for (const name of term) {
      if (!known.has(name)) throw new Error(`不认识的对数线性项：${termLabel(term)}（里面的 ${name} 不在所选变量里）`);
    }
    const key = [...term].sort().join('*');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(term);
  }
  if (result.length === 0) throw new Error('对数线性分析至少要放进一个项（主效应就算）');
  return result;
}

/**
 * Fit a hierarchical log-linear model to a contingency table of counts.
 *
 * `options.variables` are the factors (2–4), `options.terms` lists the effects
 * to keep as arrays of variable names (each entry is an interaction, e.g.
 * `['a', 'b']`), `options.model: 'saturated'` fits every interaction instead.
 * A cell is one combination of levels — including combinations nobody fell into,
 * because those empty cells carry the degrees of freedom.
 */
export function computeLogLinear(dataset, options = {}) {
  if (!dataset) throw new Error('还没有打开数据集');
  const names = [...new Set((options.variables ?? []).map(String))];
  if (names.length < 2) throw new Error('对数线性分析至少要两个分类变量');
  if (names.length > MAX_VARIABLES) {
    throw new Error(`变量太多：${names.length} 个，这里最多 ${MAX_VARIABLES} 个（先把不关心的变量合起来）`);
  }

  const variables = names.map((name) => {
    const variable = dataset.variables.find((entry) => entry.name === name);
    if (!variable) throw new Error(`没有这个变量：${name}`);
    return variable;
  });
  variables.forEach((variable) => {
    if (!isCategorical(variable)) {
      throw new Error(`对数线性分析要求分类变量：${variable.name} 是数值变量（先分箱，或者在变量视图里改成名义变量）`);
    }
  });

  // 先做整例剔除，再枚举类别。反过来的话，只在被剔除那些行里出现过的类别会变成
  // 「一个个案都没有」的类别，本来能分析的数据被误拒（复验 verify-loglinear 的 P2）。
  const indexes = names.map((name) => dataset.variables.findIndex((entry) => entry.name === name));
  const usable = [];
  for (const row of dataset.rows) {
    let keep = true;
    for (let index = 0; index < indexes.length; index += 1) {
      const raw = row[indexes[index]];
      if (blank(raw) || isUserMissing(variables[index], raw)) { keep = false; break; }
    }
    if (keep) usable.push(row);
  }
  if (usable.length < 1) throw new Error('没有可用的个案：所选变量的有效行是 0 行');

  // 类别按变量的观测值排序（数值按大小、文本按字典序），表里印的次序就靠它。
  const levels = names.map((name, slot) => {
    const values = new Set();
    for (const row of usable) values.add(String(row[indexes[slot]]));
    const sorted = sortKeys([...values]);
    if (sorted.length < 2) throw new Error(`变量 ${name} 只有一个类别，做不了对数线性分析`);
    return sorted;
  });

  const offsets = { names };
  const boxes = levels.map((entry) => entry.length);
  const totalCells = boxes.reduce((product, value) => product * value, 1);
  if (totalCells > MAX_CELLS) {
    throw new Error(`单元格太多：${totalCells} 个，对数线性分析在这里最多 ${MAX_CELLS} 个（先合并类别）`);
  }

  // 观察频数：把每个个案投到它的格子里（上面已经整例剔除过）。
  const counts = new Array(totalCells).fill(0);
  const cases = usable.length;
  const dropped = dataset.rows.length - cases;
  const strides = boxes.map((_, slot) => boxes.slice(slot + 1).reduce((product, value) => product * value, 1));
  for (const row of usable) {
    const slot = indexes.map((index) => {
      const level = levels[indexes.indexOf(index)].indexOf(String(row[index]));
      if (level < 0) throw new Error(`内部错误：类别 ${names[indexes.indexOf(index)]}=${row[index]} 不在表里`);
      return level;
    });
    counts[slot.reduce((sum, value, index) => sum + value * strides[index], 0)] += 1;
  }

  // 边距为 0 的类别（整列一个个案都没有）会让 MLE 不存在，直接拒绝。
  const empty = [];
  for (let index = 0; index < names.length; index += 1) {
    levels[index].forEach((level, levelIndex) => {
      let sum = 0;
      for (let cell = 0; cell < totalCells; cell += 1) {
        const position = Math.floor(cell / strides[index]) % boxes[index];
        if (position === levelIndex) sum += counts[cell];
      }
      if (sum === 0) empty.push(`${names[index]}=${level}`);
    });
  }
  if (empty.length) throw new Error(`有类别一个个案都没有：${empty.join('、')}，对数线性分析拒收空类别，先合并或剔除`);

  const terms = normalizeTerms(names, options.terms, options.model);

  // 交互项对应的边距上如果有 0 格，MLE 就落在边界上（系数会被推到无穷）：这时 G²
  // 与标准误都没有意义，必须报错而不是照印（复验 verify-loglinear 的 P1）。
  const combinationsOf = (widths) => {
    const out = [];
    const walk = (slot, picked) => {
      if (slot === widths.length) { out.push([...picked]); return; }
      for (let value = 0; value < widths[slot]; value += 1) walk(slot + 1, [...picked, value]);
    };
    walk(0, []);
    return out;
  };
  const boundary = [];
  for (const term of terms) {
    if (term.length < 2) continue;
    const positions = term.map((name) => offsets.names.indexOf(name));
    for (const combination of combinationsOf(positions.map((position) => boxes[position]))) {
      const wanted = new Set();
      for (let cell = 0; cell < totalCells; cell += 1) {
        let hit = true;
        for (let index = 0; index < positions.length; index += 1) {
          if (Math.floor(cell / strides[positions[index]]) % boxes[positions[index]] !== combination[index]) { hit = false; break; }
        }
        if (hit) wanted.add(cell);
      }
      let sum = 0;
      for (const cell of wanted) sum += counts[cell];
      if (sum === 0) {
        boundary.push(`${termLabel(term)} 的 ${term.map((name, index) => `${name}=${levels[positions[index]][combination[index]]}`).join(' × ')}`);
      }
    }
  }
  if (boundary.length) {
    const shown = boundary.slice(0, 3).join('、');
    throw new Error(`模型里有交互项，但它在某些格子上一个个案都没有：${shown}${boundary.length > 3 ? ' 等' : ''}。这种模型没有有限的最大似然解（系数会被推到无穷，G² 与标准误都没有意义），先把这个组合去掉，或者改用不含该交互项的模型。`);
  }

  // 设计矩阵：截距 + 每个项（项内各变量取哑变量后相乘）。哑变量以第一类为参照，
  // 所以参数是「相对第一类的对数优势」，与 SPSS 的对照编码方向一致。
  const columns = [{ term: null, levels: [] }];
  for (const term of terms) {
    const positions = term.map((name) => offsets.names.indexOf(name));
    const widths = positions.map((position) => boxes[position] - 1);
    const build = (slot, code) => {
      if (slot === positions.length) {
        columns.push({ term, levels: [...code] });
        return;
      }
      for (let value = 1; value <= widths[slot]; value += 1) build(slot + 1, [...code, value]);
    };
    build(0, []);
  }

  const rows = [];
  for (let cell = 0; cell < totalCells; cell += 1) {
    const position = [];
    for (let index = 0; index < names.length; index += 1) {
      position.push(Math.floor(cell / strides[index]) % boxes[index]);
    }
    const line = [1];
    for (const column of columns.slice(1)) {
      const term = column.term;
      let value = 1;
      term.forEach((name, termIndex) => {
        const position_ = offsets.names.indexOf(name);
        const level = position[position_];
        const code = column.levels[termIndex];
        value *= level === code ? 1 : 0;
      });
      line.push(value);
    }
    rows.push({ position, line, count: counts[cell] });
  }

  const fit = (design) => {
    const width = design[0].length;
    let beta = new Array(width).fill(0);
    const average = Math.max(1e-6, counts.reduce((sum, value) => sum + value, 0) / totalCells);
    beta[0] = Math.log(average);
    let deviance = Number.POSITIVE_INFINITY;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const mu = design.map((line) => Math.exp(Math.min(700, line.reduce((sum, cell, index) => sum + cell * beta[index], 0))));
      const info = Array.from({ length: width }, () => new Array(width).fill(0));
      const score = new Array(width).fill(0);
      for (let row = 0; row < design.length; row += 1) {
        const line = design[row];
        const weight = Math.max(mu[row], 1e-8);
        const residual = counts[row] - mu[row];
        for (let left = 0; left < width; left += 1) {
          if (line[left] === 0) continue;
          score[left] += line[left] * residual;
          for (let right = 0; right < width; right += 1) {
            if (line[right] === 0) continue;
            info[left][right] += weight * line[left] * line[right];
          }
        }
      }
      const step = solve(info, score);
      // 泊松回归的 IRLS：步长就是「得分 / 信息」，全步收敛得很稳；
      // 但离散模型的期望离 0 很近时步长会炸，所以限个界。
      const limit = Math.min(1, 10 / Math.max(...step.map((value) => Math.abs(value))));
      beta = beta.map((value, index) => value + limit * step[index]);
      const nextDeviance = 2 * design.reduce((sum, line, row) => {
        const value = Math.exp(Math.min(700, line.reduce((acc, cell, index) => acc + cell * beta[index], 0)));
        return sum + (counts[row] > 0 ? counts[row] * Math.log(counts[row] / value) : 0);
      }, 0);
      if (Math.abs(deviance - nextDeviance) < 1e-10 * (1 + Math.abs(nextDeviance))) { deviance = nextDeviance; break; }
      deviance = nextDeviance;
    }
    const mu = design.map((line) => Math.exp(Math.min(700, line.reduce((sum, cell, index) => sum + cell * beta[index], 0))));
    const information = Array.from({ length: width }, () => new Array(width).fill(0));
    for (let row = 0; row < design.length; row += 1) {
      const line = design[row];
      const weight = Math.max(mu[row], 1e-8);
      for (let left = 0; left < width; left += 1) {
        if (line[left] === 0) continue;
        for (let right = 0; right < width; right += 1) {
          if (line[right] === 0) continue;
          information[left][right] += weight * line[left] * line[right];
        }
      }
    }
    const covariance = invert(information);
    let g2 = 0;
    let pearson = 0;
    for (let row = 0; row < design.length; row += 1) {
      if (counts[row] > 0) g2 += 2 * counts[row] * Math.log(counts[row] / mu[row]);
      pearson += (counts[row] - mu[row]) ** 2 / mu[row];
    }
    const df = design.length - width;
    return { beta, mu, covariance, g2: Math.max(0, g2), pearson, df };
  };

  const design = rows.map((row) => row.line);
  const full = fit(design);
  const df = full.df;
  const p = df > 0 ? chiSquareP(full.g2, df) : Number.NaN;

  // 分层检验（偏关联）：把某个项拿掉再拟一次，G² 的增加量就是它的贡献。
  const partial = terms.map((term) => {
    // 重建去掉该项的设计矩阵：保持列次序，只跳过属于这个项的列。
    const kept = [];
    columns.forEach((column, index) => {
      if (column.term && termLabel(column.term) === termLabel(term)) return;
      kept.push(index);
    });
    const reduced = rows.map((row) => kept.map((index) => row.line[index]));
    const fitReduced = fit(reduced);
    return {
      term,
      label: termLabel(term),
      change: Math.max(0, fitReduced.g2 - full.g2),
      df: Math.max(0, fitReduced.df - df),
      p: fitReduced.df - df > 0 ? chiSquareP(Math.max(0, fitReduced.g2 - full.g2), fitReduced.df - df) : Number.NaN,
    };
  });

  // 调整残差：z = (o − μ) / √(μ(1 − h))，h 是杠杆值。
  const adjusted = rows.map((row, index) => {
    let leverage = 0;
    for (let left = 0; left < columns.length; left += 1) {
      if (row.line[left] === 0) continue;
      for (let right = 0; right < columns.length; right += 1) {
        if (row.line[right] === 0) continue;
        leverage += row.line[left] * full.covariance[left][right] * row.line[right];
      }
    }
    leverage *= Math.max(full.mu[index], 1e-8);
    const scale = Math.sqrt(Math.max(1e-12, full.mu[index] * (1 - Math.min(0.999999, leverage))));
    return (counts[index] - full.mu[index]) / scale;
  });

  const parameters = columns.map((column, index) => {
    const estimate = full.beta[index];
    const se = Math.sqrt(Math.max(0, full.covariance[index][index]));
    const z = se > 0 ? estimate / se : 0;
    // 参数名写成「a=y vs x」这种：读表的人要知道是哪个类别相对参照类，
    // 而不是「第 2 类」——后者要回去数类别次序。
    const contrast = column.term === null ? '' : column.term.map((name, slot) => {
      const position = offsets.names.indexOf(name);
      return `${name}=${levels[position][column.levels[slot]]}`;
    }).join('，');
    return {
      label: column.term === null ? '常数项' : `${termLabel(column.term)}（${contrast} vs 参照）`,
      term: column.term === null ? null : termLabel(column.term),
      estimate,
      se,
      z,
      p: chiSquareP(z * z, 1),
    };
  });

  const notes = [
    `模型：${terms.map(termLabel).join('、')}（共 ${terms.length} 个项）。期望频数由泊松回归的 IRLS 迭代给出，单元格包含频数为 0 的组合——那些空格子也算自由度。`,
    `似然比 G² = ${full.g2.toFixed(4)}，自由度 ${df}，P = ${df > 0 ? (p < 0.001 ? '< 0.001' : p.toFixed(4)) : '—'}；Pearson 卡方 ${full.pearson.toFixed(4)}。`
      + `${df > 0 && p < 0.05 ? '模型拟合不足：被去掉的那些交互里有真结构，试把对应的项加进模型。' : df > 0 ? '没有证据说明模型不够（P ≥ 0.05）。' : '饱和模型，自由度 0，拟合优度没有信息。'}`,
    '参数用哑变量对照编码（每个变量以第一类为参照），所以估计值是「相对参照类别的对数优势」，不是原始计数；看方向与显著性，别把常数项当均值。',
    '分层检验是「把该项拿掉后 G² 增加多少」：增加量大说明这个（交互）效应不能省。',
  ];
  if (dropped > 0) notes.push(`有 ${dropped} 例因为所选变量缺失被整例剔除。`);
  if (df === 0) notes.push('饱和模型只是把观察频数原样抄一遍，别用它判断有没有结构。');

  return {
    variables: names,
    terms: terms.map(termLabel),
    levels,
    boxes,
    cells: totalCells,
    cases,
    dropped,
    counts,
    expected: full.mu,
    residuals: counts.map((value, index) => value - full.mu[index]),
    adjusted,
    fit: { g2: full.g2, df, p, pearson: full.pearson, pearsonP: df > 0 ? chiSquareP(full.pearson, df) : Number.NaN },
    parameters,
    partial,
    notes,
    model: {
      variables: names,
      terms: terms.map(termLabel),
      levels,
      cells: totalCells,
      cases,
      dropped,
      counts: counts.slice(),
      expected: full.mu.slice(),
      residuals: counts.map((value, index) => value - full.mu[index]),
      adjusted,
      fit: { g2: full.g2, df, p, pearson: full.pearson },
      parameters,
      partial,
    },
  };
}
