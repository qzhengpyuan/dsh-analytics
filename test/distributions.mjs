// 概率分布计算器的用例：每个分布拿教科书上的临界值对照，再验往返一致性。
// 已知值都取常见的 0.975 / 0.95 分位（正态 1.959964、t(10) 2.228139、
// 卡方(3) 7.814728、F(2,10) 4.102821），二项与泊松用精确分数。
import assert from 'node:assert/strict';
import { computeDistribution } from '../lib/distributions.js';

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

check('a normal quantile matches the 0.975 critical value', () => {
  const at = computeDistribution({ distribution: 'normal', x: 1.959963985 });
  close(at.cdf, 0.975, 1e-9, 'P(Z ≤ 1.959964)');
  close(at.pdf, 0.058445070, 1e-8, '正态密度');
  const back = computeDistribution({ distribution: 'normal', x: 0, probability: 0.975 });
  close(back.quantile, 1.959963985, 1e-8, '0.975 的分位数');
  // 对称性：下尾与上尾在 ±z 处互换。
  const lower = computeDistribution({ distribution: 'normal', x: -1.959963985 });
  close(lower.cdf, 0.025, 1e-9, 'P(Z ≤ −1.959964)');
  close(lower.twoSided, 0.05, 1e-9, '双侧概率');
});

check('a t quantile matches the 0.975 critical value', () => {
  const at = computeDistribution({ distribution: 't', x: 2.228138852, df1: 10 });
  close(at.cdf, 0.975, 1e-6, 'P(t ≤ 2.228139)');
  const back = computeDistribution({ distribution: 't', x: 0, df1: 10, probability: 0.975 });
  close(back.quantile, 2.228138852, 1e-5, 't(10) 的 0.975 分位数');
  // t 分布比正态厚尾：同一点的概率更低。
  const normalAt = computeDistribution({ distribution: 'normal', x: 2.228138852 });
  assert.ok(at.cdf < normalAt.cdf, 't 的累积概率应当小于正态');
  // 单侧上尾与双侧必须自洽。
  close(at.upperTail, 1 - at.cdf, 1e-12, '上尾');
  close(at.twoSided, 2 * at.upperTail, 1e-12, '双侧');
});

check('a chi-square quantile matches the critical value', () => {
  const at = computeDistribution({ distribution: 'chiSquare', x: 7.814727903, df1: 3 });
  close(at.cdf, 0.95, 1e-6, 'P(χ² ≤ 7.814728)');
  const back = computeDistribution({ distribution: 'chiSquare', x: 3, df1: 3, probability: 0.95 });
  close(back.quantile, 7.814727903, 1e-5, 'χ²(3) 的 0.95 分位数');
  // 密度在定义域外为 0。
  const outside = computeDistribution({ distribution: 'chiSquare', x: -1, df1: 3 });
  assert.equal(outside.pdf, 0);
  assert.equal(outside.cdf, 0);
});

check('an F quantile matches the critical value', () => {
  const at = computeDistribution({ distribution: 'f', x: 4.102821, df1: 2, df2: 10 });
  close(at.cdf, 0.95, 1e-6, 'P(F ≤ 4.102821)');
  const back = computeDistribution({ distribution: 'f', x: 1, df1: 2, df2: 10, probability: 0.95 });
  close(back.quantile, 4.102821, 1e-5, 'F(2,10) 的 0.95 分位数');
  // F(1, df) 与 χ²(df) 的平方关系：F 的 cdf 应等于 chi2 在 x 处的 cdf。
  const one = computeDistribution({ distribution: 'f', x: 3.841458821, df1: 1, df2: 400 });
  const square = computeDistribution({ distribution: 'chiSquare', x: 3.841458821, df1: 1 });
  close(one.cdf, square.cdf, 5e-3, 'F(1,400) 与 χ²(1) 的一致性');
});

check('the discrete distributions use exact fractions', () => {
  const binomial = computeDistribution({ distribution: 'binomial', x: 5, n: 10, p: 0.5 });
  close(binomial.cdf, 638 / 1024, 1e-12, 'P(X ≤ 5) 二项');
  close(binomial.pdf, 252 / 1024, 1e-12, 'P(X = 5) 二项');
  assert.equal(binomial.discrete, true);
  assert.ok(binomial.notes.some((note) => note.includes('2.5')), '二项注释应当给出期望 2.5');
  const poisson = computeDistribution({ distribution: 'poisson', x: 3, lambda: 2 });
  close(poisson.cdf, (1 + 2 + 2 + 4 / 3) * Math.exp(-2), 1e-12, 'P(X ≤ 3) 泊松');
  close(poisson.pdf, (8 / 6) * Math.exp(-2), 1e-12, 'P(X = 3) 泊松');
});

check('discrete quantiles land on whole counts', () => {
  const binomial = computeDistribution({ distribution: 'binomial', x: 5, n: 10, p: 0.5, probability: 0.623046875 });
  assert.equal(binomial.quantile, 5, '累积概率等于 P(X ≤ 5) 时分位数应当是 5');
  assert.equal(Number.isInteger(binomial.quantile), true, '离散分布的分位数必须是整数');
  const poisson = computeDistribution({ distribution: 'poisson', x: 0, lambda: 2, probability: 0.8571 });
  assert.equal(poisson.quantile, 3, '泊松的 0.8571 分位数应当是 3');
  // 分位数的定义是最小的 k 使 P(X ≤ k) ≥ p：p 略大于 P(X ≤ 3) 就得跳到 4。
  const beyond = computeDistribution({ distribution: 'poisson', x: 0, lambda: 2, probability: 0.8571234620 });
  assert.equal(beyond.quantile, 4, 'p 超过 P(X ≤ 3) 时分位数应当是 4');
  // 累积概率跳过某个点时要落到第一个达到它的计数。
  const earlier = computeDistribution({ distribution: 'poisson', x: 0, lambda: 2, probability: 0.13 });
  assert.equal(earlier.quantile, 0, 'P(X ≤ 0) = 0.1353，故 0.13 的分位数是 0');
});

check('every continuous quantile round-trips through its cdf', () => {
  const cases = [
    { distribution: 'normal', x: 0.75 },
    { distribution: 't', x: 1.5, df1: 7 },
    { distribution: 'chiSquare', x: 5.5, df1: 4 },
    { distribution: 'f', x: 2.25, df1: 3, df2: 12 },
  ];
  for (const item of cases) {
    const at = computeDistribution(item);
    const back = computeDistribution({ ...item, probability: at.cdf });
    close(back.quantile, item.x, 1e-6 * Math.max(1, Math.abs(item.x)), `${item.distribution} 往返`);
  }
});

check('bad input is refused with a readable message', () => {
  const refusals = [
    [{ distribution: 'cauchy', x: 1 }, /不认识的分布/],
    [{ distribution: 'normal' }, /要给定点 x/],
    [{ distribution: 't', x: 1 }, /要给定自由度/],
    [{ distribution: 'f', x: 1, df1: 3 }, /分母自由度/],
    [{ distribution: 'binomial', x: 1, n: 10, p: 1.5 }, /成功概率/],
    [{ distribution: 'poisson', x: 1 }, /均值 λ/],
    [{ distribution: 'normal', x: 1, probability: 1.5 }, /累积概率要在 0 与 1 之间/],
  ];
  for (const [options, pattern] of refusals) {
    assert.throws(() => computeDistribution(options), pattern, `${JSON.stringify(options)} 应当被拒绝`);
  }
});

check('a quantile accepts the six-decimal value the panel shows', () => {
  // 用户照着屏幕上六位小数的 CDF(5)=0.623047 反查分位数：真值比它小 1.2e-7，
  // 容差只给 1e-12 时会被判成 CDF(5) 还不够，落到 6（差一格）。
  assert.equal(computeDistribution({ distribution: 'binomial', x: 5, n: 10, p: 0.5, probability: 0.623047 }).quantile, 5);
  assert.equal(computeDistribution({ distribution: 'binomial', x: 5, n: 10, p: 0.5, probability: 0.623046875 }).quantile, 5);
  assert.equal(computeDistribution({ distribution: 'binomial', x: 5, n: 10, p: 0.5, probability: 0.376953 }).quantile, 4);
  // 泊松同理：P(X≤3) = 0.857123（六位），真值 0.8571234604。
  assert.equal(computeDistribution({ distribution: 'poisson', x: 3, lambda: 2, probability: 0.857123 }).quantile, 3);
})

process.stdout.write(`\n${checks} checks in test/distributions.mjs\n`);
if (process.exitCode) process.stdout.write('failures above\n');
