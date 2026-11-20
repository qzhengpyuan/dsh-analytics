/**
 * Cochran–Mantel–Haenszel stratified test for a 2×2 table repeated over strata.
 *
 * The bundled GNU PSPP 2.1.3 rejects `CROSSTABS /STATISTICS=CMH` as a syntax
 * error (probed on the shipped engine: it fails before reading any data), and it
 * has no other command that conditions a 2×2 association on a third variable.
 * So the arithmetic happens here, the same way lib/risk.js computes the risk
 * difference interval PSPP never prints.
 *
 * Three statistics, all from the same per-stratum counts:
 *
 *   CMH χ² (1 df)  (Σ(a − E_a))² / Σ Var(a), with
 *                  E_a = R1·C1/T and Var(a) = R1·R2·C1·C2 / (T²·(T − 1)).
 *                  Mantel & Haenszel (1959). The variance is the
 *                  hypergeometric one, which is what makes the test a
 *                  conditional one: both margins are held fixed instead of
 *                  estimated, so a stratum with tiny cells contributes little
 *                  rather than dragging the statistic.
 *
 *   Common OR      Σ(a·d/T) / Σ(b·c/T)  (Mantel & Haenszel 1959).
 *
 *   Its interval   Robins–Breslow–Greenland (Greenland & Robins 1985,
 *                  Biometrics 41:55–68), the variance used by R's
 *                  `stats::mantelhaen.test`. Woolf's interval is the tempting
 *                  alternative — it is just a weighted mean of the per-stratum
 *                  log ORs — but it is undefined the moment one stratum has an
 *                  empty cell, and sparse 2×2 strata are exactly where a
 *                  stratified analysis gets asked for; RBG needs nothing but
 *                  the pooled sums. It is also what SPSS prints, so the note
 *                  and the engine's own table do not disagree.
 *
 *   Breslow–Day    homogeneity of the odds ratios across strata, from Breslow &
 *                  Day (1980) p.142: for each stratum solve
 *                  (1 − ψ)a² + (T − R1 − C1 + ψ(R1 + C1))a − ψR1C1 = 0 for the
 *                  expected a under the common ψ, then Σ(a − E)²/Var(a), where
 *                  Var(a) is the non-central hypergeometric variance
 *                  1 / (1/a + 1/(R1−a) + 1/(C1−a) + 1/(T−R1−C1+a)).
 *
 * Nothing here touches the engine or the workspace: these are pure functions
 * over counts, plus one Chinese sentence each for the crosstab note.
 */

import { normalQuantile } from './risk.js'
import { chiSquareP } from './tables.js'

/** One non-negative count, or null when the cell is not a number at all. */
function cellCount(value) {
  if (value === null || value === undefined || value === '') return 0
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

/**
 * Read one stratum as `[[a, b], [c, d]]` (rows = groups, columns = outcomes).
 *
 * `empty` marks a stratum with a row or a column total of 0: it cannot move the
 * CMH statistic (both a − E and Var(a) are 0 there) but it still has to be
 * counted, otherwise "3 层、有效 2 层" would silently look like a 2-stratum
 * analysis.
 */
function readStratum(entry) {
  if (!Array.isArray(entry) || entry.length < 2) return null
  const top = entry[0] ?? []
  const bottom = entry[1] ?? []
  const a = cellCount(top[0])
  const b = cellCount(top[1])
  const c = cellCount(bottom[0])
  const d = cellCount(bottom[1])
  if (a === null || b === null || c === null || d === null) return null
  const row1 = a + b
  const row2 = c + d
  const col1 = a + c
  const col2 = b + d
  return {
    a, b, c, d, row1, row2, col1, col2,
    total: row1 + row2,
    empty: row1 === 0 || row2 === 0 || col1 === 0 || col2 === 0,
  }
}

/** Every usable stratum, in order, with T ≤ 1 dropped (its variance divides by T − 1). */
function usableStrata(entries) {
  const tables = []
  let empty = 0
  let tooSmall = 0
  for (const entry of entries) {
    const counts = readStratum(entry)
    if (!counts) {
      empty += 1
      continue
    }
    if (counts.empty) {
      empty += 1
      continue
    }
    if (counts.total <= 1) {
      tooSmall += 1
      continue
    }
    tables.push(counts)
  }
  return { tables, empty, tooSmall }
}

/**
 * Cochran–Mantel–Haenszel test and the Mantel–Haenszel common odds ratio.
 *
 * @param {number[][][]} strata array of 2×2 count matrices, `[[a, b], [c, d]]`
 * @param {object} [options]
 * @param {number} [options.level] confidence level for the interval, default 0.95
 * @param {boolean} [options.correction] apply the 0.5 continuity correction
 * @returns {{statistic: ?number, df: number, p: ?number, oddsRatio: ?number,
 *   low: ?number, high: ?number, level: number, correction: boolean,
 *   strata: number, used: number, empty: number, note: ?string}}
 *   `correction` reports whether the correction was *applied*, not whether it
 *   was asked for; `used` counts the strata that entered Σ Var; `empty` counts
 *   the strata with an empty row or column; `note` is the Chinese reason
 *   something could not be estimated, or null.
 */
export function mantelHaenszel(strata, options = {}) {
  const entries = Array.isArray(strata) ? strata : []
  const level = Number.isFinite(options.level) && options.level > 0 && options.level < 1
    ? options.level
    : 0.95
  const wanted = options.correction === true
  const { tables, empty } = usableStrata(entries)

  let delta = 0
  let variance = 0
  let numerator = 0
  let denominator = 0
  // The three RBG sums: Σ(a+d)ad/T², Σ[(a+d)bc + (b+c)ad]/T², Σ(b+c)bc/T².
  let diagonal = 0
  let cross = 0
  let offDiagonal = 0

  for (const table of tables) {
    const { a, b, c, d, row1, row2, col1, col2, total } = table
    delta += a - (row1 * col1) / total
    variance += (row1 * row2 * col1 * col2) / (total * total * (total - 1))
    numerator += (a * d) / total
    denominator += (b * c) / total
    diagonal += ((a + d) * a * d) / (total * total)
    cross += ((a + d) * b * c + (b + c) * a * d) / (total * total)
    offDiagonal += ((b + c) * b * c) / (total * total)
  }

  let statistic = null
  let p = null
  let correction = false
  if (variance > 0) {
    // The 0.5 is only defensible when it cannot overshoot zero: with
    // |Δ| < 0.5 the textbook (|Δ| − 0.5)² would *raise* the statistic, so the
    // correction is left off there instead. R's mantelhaen.test guards it the
    // same way, which keeps the two numbers comparable.
    const shift = wanted && Math.abs(delta) >= 0.5 ? 0.5 : 0
    correction = shift > 0
    statistic = ((Math.abs(delta) - shift) ** 2) / variance
    p = chiSquareP(statistic, 1)
  }

  let oddsRatio = null
  let low = null
  let high = null
  if (numerator > 0 && denominator > 0) {
    oddsRatio = numerator / denominator
    const z = normalQuantile(1 - (1 - level) / 2)
    const varianceOfLog = diagonal / (2 * numerator * numerator)
      + cross / (2 * numerator * denominator)
      + offDiagonal / (2 * denominator * denominator)
    const spread = Math.sqrt(varianceOfLog)
    if (z && Number.isFinite(spread)) {
      low = oddsRatio * Math.exp(-z * spread)
      high = oddsRatio * Math.exp(z * spread)
    }
  }

  let note = null
  if (statistic === null) {
    note = '各层的方差之和为 0，CMH 统计量无从计算（每层都缺一条非空的行或列）'
  } else if (numerator <= 0 && denominator <= 0) {
    note = '所有层的 a·d 与 b·c 权重之和都是 0，共同优势比无从估计'
  } else if (denominator <= 0) {
    note = '各层 b·c 权重之和为 0，Mantel–Haenszel 估计的分母不存在'
  } else if (numerator <= 0) {
    note = '各层 a·d 权重之和为 0，Mantel–Haenszel 估计的分子为 0'
  }

  return {
    statistic,
    df: 1,
    p,
    oddsRatio,
    low,
    high,
    level,
    correction,
    strata: entries.length,
    used: tables.length,
    empty,
    note,
  }
}

/**
 * Breslow–Day test of a common odds ratio across strata.
 *
 * Plain Breslow–Day, without Tarone's correction. SPSS prints "Breslow-Day" and
 * "Tarone's" as two separate rows in `CROSSTABS /STATISTICS=CMH`, so the plain
 * form is the primary result; Tarone's correction also subtracts part of the CMH
 * statistic itself, which couples the homogeneity test to the very effect test
 * it is supposed to be independent of.
 *
 * @param {number[][][]} strata same shape as `mantelHaenszel`
 * @param {object} [options]
 * @param {number} [options.oddsRatio] ψ to hold fixed; defaults to the
 *   Mantel–Haenszel estimate (and is required when that one is undefined)
 */
export function breslowDay(strata, options = {}) {
  const entries = Array.isArray(strata) ? strata : []
  const { tables, empty, tooSmall } = usableStrata(entries)

  // Too few layers is a fact about the input, not about the odds ratio, so it is
  // reported first: an all-zero table has no ψ either, and "只有一层" is the
  // answer the reader needs.
  if (tables.length < 2) return tooFewLayers(tables.length, empty, tooSmall)

  const pooled = mantelHaenszel(entries, { level: options.level })
  const psi = Number.isFinite(options.oddsRatio) && options.oddsRatio > 0
    ? options.oddsRatio
    : pooled.oddsRatio

  if (psi === null || psi === undefined || !(psi > 0)) {
    return {
      statistic: null,
      df: 0,
      p: null,
      note: '共同优势比无定义，Breslow–Day 的期望格子无从求（可传 options.oddsRatio 指定一个 ψ）',
    }
  }

  let statistic = 0
  let used = 0
  for (const table of tables) {
    const { a, row1, col1, total } = table
    const estimate = expectedCell(table, psi)
    if (estimate === null) continue
    // The non-central hypergeometric variance of that cell: 1 over the sum of
    // the reciprocal counts of the four cells at the fitted table.
    const inverse = 1 / estimate
      + 1 / (row1 - estimate)
      + 1 / (col1 - estimate)
      + 1 / (total - row1 - col1 + estimate)
    if (!(inverse > 0) || !Number.isFinite(inverse)) continue
    statistic += (a - estimate) ** 2 * inverse
    used += 1
  }

  if (used < 2) return tooFewLayers(used, empty, tooSmall)
  const df = used - 1
  return { statistic, df, p: chiSquareP(statistic, df), note: null }
}

/** `df = 0` and an explanation when there is nothing to compare. */
function tooFewLayers(used, empty, tooSmall) {
  return {
    statistic: null,
    df: 0,
    p: null,
    note: used === 1
      ? '只有一层，同质性无从检验'
      : `没有可用于同质性检验的层（${empty} 层有空行或空列，${tooSmall} 层总例数不足 2）`,
  }
}

/**
 * The cell count the stratum would show under a common odds ratio ψ: the root of
 * (1 − ψ)a² + (T − R1 − C1 + ψ(R1 + C1))a − ψR1C1 = 0 that lands inside the
 * feasible range for a, or null when the quadratic has no usable root (a fitted
 * zero cell leaves the variance undefined, so such a stratum cannot contribute).
 */
function expectedCell(table, psi) {
  const { row1, row2, col1, total } = table
  const low = Math.max(0, col1 - row2)
  const high = Math.min(row1, col1)
  const first = 1 - psi
  if (Math.abs(first) < 1e-12) {
    const estimate = (row1 * col1) / total
    return estimate > low - 1e-9 && estimate < high + 1e-9 ? estimate : null
  }
  const second = total - row1 - col1 + psi * (row1 + col1)
  const third = -psi * row1 * col1
  const discriminant = second * second - 4 * first * third
  if (!(discriminant >= 0)) return null
  const root = Math.sqrt(discriminant)
  for (const candidate of [(-second + root) / (2 * first), (-second - root) / (2 * first)]) {
    if (candidate > low + 1e-9 && candidate < high - 1e-9) return candidate
  }
  return null
}

/** Three decimals, the precision the rest of the crosstab notes use. */
function fixed(value) {
  return Number(value).toFixed(3)
}

/** `p = 0.002`, or `p < 0.001` when that is all the precision can honestly say. */
function pPhrase(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'p 无法计算'
  return p < 0.001 ? 'p < 0.001' : `p = ${fixed(p)}`
}

/**
 * The sentence appended to a stratified crosstab: the CMH χ² and the common OR.
 *
 * `共 3 层、有效 3 层` is spelled out because PSPP's own table is per stratum:
 * without it a reader cannot tell whether the note used every layer the
 * `LAYER=` subcommand asked for.
 */
export function describeMantelHaenszel(result) {
  if (!result) return null
  const percent = Math.round(result.level * 100)
  const layers = `共 ${result.strata} 层、有效 ${result.used} 层`
  const skipped = result.strata - result.used
  // Only the clauses that actually apply: "0 层总例数不足 2" reads like a
  // counting mistake, not like a reassurance.
  const reasons = []
  if (result.empty > 0) reasons.push(`${result.empty} 层有空行或空列`)
  if (skipped - result.empty > 0) reasons.push(`${skipped - result.empty} 层总例数不足 2`)
  const tail = skipped > 0 ? `${layers}（${skipped} 层未参与：${reasons.join('，')}）` : layers

  if (result.statistic === null || result.statistic === undefined) {
    return `分层卡方（插件计算）：Cochran–Mantel–Haenszel χ² 无法计算（${result.note ?? '各层方差之和为 0'}）；${tail}`
  }

  const chiSquare = `Cochran–Mantel–Haenszel χ² = ${fixed(result.statistic)}（${result.df} df，${pPhrase(result.p)}${result.correction ? '，连续性校正' : ''}）`
  const ratio = result.oddsRatio === null || result.oddsRatio === undefined
    ? `共同 OR 无定义（${result.note ?? '各层权重之和为 0'}）`
    : `共同优势比 OR = ${fixed(result.oddsRatio)}，${percent}% 置信区间 ${fixed(result.low)} ~ ${fixed(result.high)}`
      + '（Mantel–Haenszel 估计，Robins–Breslow–Greenland 区间）'
  return `分层卡方（插件计算）：${chiSquare}，${ratio}；${tail}`
}

/** The homogeneity sentence: one line, same three decimals. */
export function describeHomogeneity(result) {
  if (!result) return null
  if (result.statistic === null || result.statistic === undefined) {
    return `同质性检验（Breslow–Day）：${result.note ?? 'χ² 无法计算'}`
  }
  return `同质性检验（Breslow–Day）：χ² = ${fixed(result.statistic)}，df = ${result.df}，${pPhrase(result.p)}`
}
