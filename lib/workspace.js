import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { checkPath, rootsFrom } from './paths.js'

import { engineEnv, runProcess } from './engine.js'
import { quoteSyntaxPath, readData, readDictionary, importDelimited, buildTable, decodeText, guessDelimiter, writeSav } from './dataset.js'
import { describeEngineCrash, describeFsError, describeEngineError, stripEngineLocation } from './fserr.js'
import { readXlsx } from './xlsx.js'
import { readOds } from './ods.js'
import { readDta } from './dta.js'
import { breslowDay, describeHomogeneity, describeMantelHaenszel, mantelHaenszel } from './cmh.js'
import { describeContrasts, designColumns, generalLinearTest } from './contrasts.js'
import { parseDiagnostics, parseHtmlOutput } from './html.js'
import { buildChartModel, composeChartGrid, renderSvg } from './charts.js'
import { localize } from './i18n.js'
import { explainMessage } from './messages.js'
import { buildDocx, buildReportDocx, buildReportHtml, buildXlsx, pngSize, readableTime } from './office.js'
import { svgToPng } from './raster.js'
import { normalizeSet, parseMrSetAttribute, tabulate, frequencyMatrix, crosstab as mrCrosstab, mrsetsSyntax } from './mrsets.js'
import { pluginInfo } from './version.js'
import { buildBaselineTable, buildCompareTable, buildPairwiseTable, buildPartialMatrix, buildPartialTable, buildSignificanceMatrix, chiSquareFromTable, cramersVFromChiSquare, crosstabCounts, iccTable, pearsonChiSquare } from './tables.js'
import { collinearityTable, durbinWatsonTable, influenceTable, regressionPlots } from './regression.js'
import { mvaTables, replaceMissing } from './mva.js'
import { duplicateReport } from './dupes.js'
import { exactChiSquare, describeChiSquareExact, describeExact, exactTest } from './exact.js'
import { describeRiskDifference, riskDifferenceCi } from './risk.js'
import { outlierReport } from './outliers.js'
import { isPlainPath, stageFile, stageInput, stageOutput } from './stage.js'

/**
 * Recover multiple response sets from a .sav's file attributes.
 *
 * The attributes sit in the dictionary as plain `$name=<value>` runs, and the
 * value format is decoded by parseMrSetAttribute. Only .sav files are scanned,
 * only for small files (a 2 GB data file is not worth a full read for this),
 * and a definition is kept only when every variable it names exists in the
 * dictionary — anything the parser misreads is dropped rather than shown.
 */
/**
 * Decode one MRSETS attribute string.
 *
 * PSPP writes the attribute as the bytes of a NUL-terminated string; on Windows
 * it is the ANSI code page (cp936 on a Chinese install), on Linux UTF-8. A
 * strict UTF-8 attempt separates the two cleanly, because a GBK label is almost
 * never valid UTF-8 — and when it happens to be, GBK bytes and UTF-8 bytes
 * differ anyway, so the fallback is safe to prefer for non-UTF-8 input.
 */
function decodeAttributeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes)
    } catch {
      return bytes.toString('latin1')
    }
  }
}

export async function readMrSetsFromFile(filePath, variables) {
  if (extname(String(filePath)).toLowerCase() !== '.sav') return []
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return []
    const bytes = await readFile(filePath)
    const found = []
    const seen = new Set()
    for (let at = bytes.indexOf(0x24); at >= 0; at = bytes.indexOf(0x24, at + 1)) {
      const eq = bytes.indexOf(0x3d, at)
      if (eq < 0 || eq - at > 40) continue
      const end = bytes.indexOf(0x0a, at)
      if (end < 0 || end - at > 512) continue
      const name = bytes.subarray(at, eq).toString('latin1')
      if (!/^\$[A-Za-z0-9@#_]{1,32}$/.test(name)) continue
      const text = decodeAttributeText(bytes.subarray(at, end))
      const parsed = parseMrSetAttribute(text, variables)
      if (!parsed) continue
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)
      found.push({ ...parsed, counted: parsed.kind === 'mdgroup' ? 'counted' : null, empty: false })
    }
    return found
  } catch {
    return []
  }
}

/**
 * A .spv is a zip of XML parts; the tables live in `*_lightTableData.bin`
 * entries. When the exported run produced no table at all PSPP happily writes a
 * handful of heading parts and nothing else, which SPSS opens as an empty
 * document — refuse it here instead of handing the user a file that looks like
 * a failed export.
 */
async function assertSpvHasTables(file, kind) {
  if (kind !== 'spv') return
  let bytes
  try {
    bytes = await readFile(file)
  } catch {
    return
  }
  if (!bytes.includes('lightTableData.bin')) {
    await rm(file, { force: true }).catch(() => { /* best effort */ })
    throw new Error('这次输出里没有表格，PSPP 只能生成一个空的 .spv：先运行一个会出表的分析（频率、描述、交叉表…），或者改导出 PDF / ODT')
  }
}

/**
 * Pick the line worth showing from engine stderr: the first error, else the
 * first line that is not a 提示/note. Notes are routinely printed before the
 * actual failure, and showing one of those hides the cause.
 */
// The statistics PSPP 2.1.3 can compute without the TOL bug. Used when a retry
// has to rewrite /STATISTICS and nothing usable is left in the list.
const STABLE_STATISTICS = 'COEFF R ANOVA CI BCOV'

/**
 * Drop TOL and ALL from every /STATISTICS list.
 *
 * /STATISTICS=TOL dies inside gsl_blas_dsymm about one run in six, and
 * /STATISTICS=ALL drags TOL in with it, so removing only the word TOL leaves
 * ALL behind and the retry crashes the same way. A list that ends up empty is
 * replaced by the stable set, because a bare /STATISTICS= produces nothing.
 */
export function degradeStatistics(script) {
  const lines = String(script ?? '').split('\n')
  const statements = []
  let buffer = []
  for (const line of lines) {
    buffer.push(line)
    if (/\.\s*$/.test(line)) {
      statements.push(buffer.join('\n'))
      buffer = []
    }
  }
  if (buffer.length > 0) statements.push(buffer.join('\n'))
  return statements.map((statement) => {
    // Only REGRESSION knows these words. Rewriting /STATISTICS=ALL of, say,
    // FREQUENCIES would hand the engine a keyword it cannot parse.
    if (!/^\s*REGRESSION\b/i.test(statement)) return statement
    return statement.replace(/\/STATISTICS\s*=\s*([^.\n]*)/gi, (whole, list) => {
      const tokens = String(list).trim().split(/\s+/).filter(Boolean)
      if (tokens.length === 0) return whole
      const kept = tokens.filter((token) => !/^(TOL|ALL)$/i.test(token))
      if (kept.length === tokens.length) return whole
      return `/STATISTICS=${kept.length > 0 ? kept.join(' ') : STABLE_STATISTICS}`
    })
  }).join('\n')
}

/**
 * PSPP 2.1.3 segfaults (rc 139, no output at all) when a crosstab asks for RISK
 * on a string grouping variable — probed with `CROSSTABS /TABLES=g BY wave
 * /STATISTICS=CHISQ RISK` where `g` is A1: the whole run dies and nothing comes
 * back, so the user sees "the engine produced no tables" for a table that would
 * have worked without RISK.
 *
 * The statistics are dropped from the syntax instead, and the risk difference
 * (with its Newcombe interval) is computed from the counts afterwards.
 */
export function dropRiskOnStrings(script, dataset) {
  const variables = Array.isArray(dataset?.variables) ? dataset.variables : []
  if (variables.length === 0) return null
  const typeOf = new Map(variables.map((variable) => [String(variable.name ?? '').toUpperCase(), variable.type]))
  let dropped = null
  const rewritten = String(script ?? '').replace(/^\s*CROSSTABS\b[\s\S]*?\./gim, (statement) => {
    const tables = statement.match(/\/TABLES\s*=\s*([^\/\n]+)/i)
    if (!tables) return statement
    // Identifiers only: `(1 2)` inline recodes and `+` are not variable names,
    // and a name we cannot look up is not evidence of safety — PSPP only needs a
    // string anywhere in the table to die, so an unknown name counts as risky.
    const names = String(tables[1])
      .replace(/\bBY\b/gi, ' ')
      .split(/[\s+()]+/)
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z][A-Za-z0-9_.$#@]*$/.test(entry))
    const upper = names.map((entry) => entry.toUpperCase())
    const stringNames = upper.filter((name) => typeOf.get(name) === 'string')
    const unknownNames = upper.filter((name) => !typeOf.has(name))
    if (stringNames.length === 0 && unknownNames.length === 0) return statement
    const statistics = statement.match(/\/STATISTICS\s*=\s*([^\/.\n]*)/i)
    if (!statistics) return statement
    const tokens = String(statistics[1]).trim().split(/\s+/).filter(Boolean)
    const kept = tokens.filter((token) => !/^RISK$/i.test(token))
    if (kept.length === tokens.length) return statement
    dropped = { variables: stringNames, unknown: unknownNames }
    if (kept.length === 0) return statement.replace(statistics[0], '')
    return statement.replace(statistics[0], `/STATISTICS=${kept.join(' ')} `)
  })
  if (!dropped) return null
  return { syntax: rewritten, variables: dropped.variables, unknown: dropped.unknown }
}

/**
 * CMH 只在插件里算，引擎那条路要先把关键字去掉。
 *
 * PSPP 2.1.3 的 `CROSSTABS /STATISTICS=` 不收 `CMH`（整份语法直接报错，一行输出
 * 都没有），所以带 CMH 的语法发车前必须剥掉它；剥掉之后还要知道「用户本来要
 * 它」，否则注文永远不会出现。返回的 `requested` 就是这个记忆。
 */
/** Everything a replay needs to survive the same engine bugs the first run did. */
function guardForReplay(script, dataset) {
  let text = String(script ?? '')
  if (dataset) {
    const risk = dropRiskOnStrings(text, dataset)
    if (risk) text = risk.syntax
  }
  const cmh = dropCmhStatistic(text)
  return cmh.requested ? cmh.syntax : text
}

export function dropCmhStatistic(script) {
  let requested = false
  const rewritten = String(script ?? '').replace(/^\s*CROSSTABS\b[\s\S]*?\./gim, (statement) => {
    const statistics = statement.match(/\/STATISTICS\s*=\s*([^\/.\n]*)/i)
    if (!statistics) return statement
    const tokens = String(statistics[1]).trim().split(/\s+/).filter(Boolean)
    const kept = tokens.filter((token) => !/^CMH$/i.test(token))
    if (kept.length === tokens.length) return statement
    requested = true
    if (kept.length === 0) return statement.replace(statistics[0], '')
    return statement.replace(statistics[0], `/STATISTICS=${kept.join(' ')} `)
  })
  return { syntax: rewritten, requested }
}

/**
 * 崩溃时的「退出码」：Node 在子进程被信号杀死时给的 code 是 null，只在 signal
 * 里留 SIGSEGV；按 shell 的习惯换算成 128 + 信号号，用户和引擎文档对得上
 * （Linux 上段错误 = 139）。这只是给用户看的参考，不是崩溃判据。
 */
function crashExitCode(result) {
  const code = Number(result?.code)
  if (result?.code !== null && result?.code !== undefined && Number.isFinite(code)) return code
  const bySignal = { SIGSEGV: 139, SIGBUS: 135, SIGABRT: 134, SIGILL: 132, SIGFPE: 136 }
  return bySignal[String(result?.signal ?? '').toUpperCase()] ?? null
}

/**
 * Why a run produced no tables: exit code plus the engine's own first line.
 *
 * A crash is answered by the banner first (see `describeEngineCrash`): its own
 * "last non-empty line" is `build_system: ...`, which reads like a syntax
 * complaint. The old text also repeated its own prefix ("引擎没有产出任何表：引擎
 * 没有给出原因") and dropped the GSL line that explains the failure.
 */
/**
 * The closest variable name when the engine says one does not exist.
 *
 * `FREQUENCIES scroe.` fails with "scroe is not a variable name"; a reader with
 * thirty variables in front of them then has to hunt for the typo. One line
 * naming the nearest real variable turns that into a two-second fix.
 */
/**
 * What a syntax file is asking for.
 *
 * The previous version asked one regex "does the text mention GET DATA" and
 * exempted the whole script, so `GET DATA …` reading an empty file followed by
 * `DESCRIPTIVES` came back as a silent empty run — the exact "no results" trap
 * the empty-dataset message exists to close. It also missed `GET FILE`, `SAVE`,
 * `SORT CASES` and `COMPUTE`, which are data steps that read fine on an empty
 * dataset and were told "this dataset has no cases".
 */
/**
 * PSPP wants `END DATA` alone on its line. When it shares the line with the
 * next command the engine stops with "END DATA must appear by itself on a
 * single line", and repeating that English sentence is not much help — say it
 * in the user's terms before the run.
 */
export function inlineDataTailProblem(script) {
  const blocks = splitStatements(String(script ?? '')).filter((part) => /^BEGIN\s+DATA\b/i.test(part.trim()))
  for (const block of blocks) {
    const lines = block.split('\n')
    for (const line of lines) {
      const match = /^[ \t]*END\s+DATA\b([^\n]*)$/i.exec(line)
      if (!match) continue
      const rest = match[1].replace(/^[ \t]*\.?/, '').trim()
      if (rest === '') continue
      return `END DATA 必须独占一行：它后面还有「${rest}」。PSPP 读到这一行就停，把后面的命令挪到下一行再跑`
    }
  }
  return null
}

/**
 * PSPP starts reading a command at the beginning of a line: `DESCRIPTIVES a.
 * DESCRIPTIVES b.` is one command in which `DESCRIPTIVES` is a variable name,
 * so the engine answers "`a.` is not a variable name" — a sentence about the
 * wrong thing. Pasted one-liners are common, so name the real mistake.
 */
// Character ranges covered by `BEGIN DATA … END DATA` blocks, so callers that
// scan the raw script can leave data values alone.
export function inlineDataRanges(text) {
  const ranges = []
  let start = -1
  let offset = 0
  for (const line of String(text ?? '').split('\n')) {
    if (start === -1 && /^[ \t]*BEGIN\s+DATA\b/i.test(line)) start = offset
    else if (start >= 0 && END_DATA_ONE.test(line)) {
      ranges.push([start, offset + line.length])
      start = -1
    }
    offset += line.length + 1
  }
  if (start >= 0) ranges.push([start, offset])
  return ranges
}

/**
 * Analysis commands that PSPP accepts and then silently skips.
 *
 * `REGRESSION.`, `REGRESSION /DEPENDENT=y.` and `FACTOR.` all exit 0, write
 * nothing to stderr and print no table — there is no engine signal to read, so
 * the only honest thing is to name the missing part of the command instead of
 * blaming a filter the user never wrote.
 */
export function silentCommandProblem(script) {
  const statements = splitStatements(script)
  for (const statement of statements) {
    const text = statement.trim()
    // The statement still carries its terminating period (splitStatements
    // keeps it), so the head has to stop at `.` as well as `/`.
    const head = /^([A-Za-z][A-Za-z ]*?)\s*(?:[/.]|$)/.exec(text)?.[1]?.trim().toUpperCase() ?? ''
    if (head === 'REGRESSION' || head === 'REG') {
      if (!/\/DEPENDENT\s*=/i.test(text)) {
        return '这条 REGRESSION 没有写 /DEPENDENT=…：PSPP 2.1.3 会静默跳过它（不报错、也不产出任何表）。补上 /DEPENDENT=因变量 /METHOD=ENTER 自变量名 再跑一次'
      }
    }
    if (head === 'FACTOR') {
      if (!/\/VARIABLES\s*=/i.test(text) && !/\/CRITERIA\s*=/i.test(text)) {
        return '这条 FACTOR 没有写 /VARIABLES=…：PSPP 2.1.3 会静默跳过它（不报错、也不产出任何表）。补上要分析的变量名再跑一次'
      }
    }
  }
  return null
}
export function inlineCommandProblem(script) {
  const text = String(script ?? '')
  // Data lines are data: `Mr. Smith` in a string column is one value, not two
  // commands. Inline blocks are skipped before anything else looks for periods.
  const dataRanges = inlineDataRanges(text)
  const insideData = (at) => dataRanges.some(([from, to]) => at >= from && at < to)
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) {
        if (text[index + 1] === quote) index += 1
        else quote = ''
      }
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char !== '.') continue
    if (insideData(index)) continue
    // `1.5`, `1. 5` and `.05` hold a decimal point, not the end of a command:
    // a period followed by a digit never starts the next command.
    if (/\d/.test(text[index + 1] ?? '')) continue
    if (/\d/.test(text[index - 1] ?? '') && text[index + 1] === ' ' && /\d/.test(text[index + 2] ?? '')) continue
    // Look along the same line only: the next line is a legal new command.
    let next = index + 1
    while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next += 1
    if (next >= text.length) return null
    if (text[next] === '\n' || text[next] === '\r') continue
    const lineEnd = text.indexOf('\n', next)
    const rest = text.slice(next, lineEnd === -1 ? text.length : lineEnd).trim()
    // An empty rest or a bare second period is not another command.
    if (rest === '' || rest === '.') continue
    const before = text.slice(text.lastIndexOf('\n', index) + 1, index + 1).trim()
    const looksLikeCommand = /^[A-Za-z]/.test(rest)
    const what = looksLikeCommand
      ? 'PSPP 会把它们读成一条命令，于是第二段被当成变量名'
      : 'PSPP 读到这一行就停，后面的内容不算注释也不会执行'
    return `一条命令要另起一行：「${before}」后面紧跟着「${rest}」，${what}。把「${rest}」挪到下一行再跑`
  }
  return null
}

export function classifyScript(script) {
  // MATRIX … END MATRIX is matrix algebra, not a data step; splitStatements()
  // drops the block (its COMPUTE is a different command with the same word).
  const text = String(script ?? '')
  // Statements, not lines: a pasted one-liner ("COMPUTE z = 1. DESCRIPTIVES x.")
  // is common, and anchoring at the line start missed everything after the
  // first command. The split has to respect quotes: `TITLE 'Step 1.
  // Descriptives by group'` holds a period and a command word inside a string,
  // and splitting there invented an analysis (a false "nothing was produced")
  // or hid the real "this dataset has no cases" message.
  const statements = splitStatements(text)
  const statement = (pattern) => statements.some((part) => new RegExp(`^(?:${pattern})\\b`, 'i').test(part))
  // PSPP accepts abbreviations down to three letters (`des`, `fre`, `cro`), and
  // its own examples use them. Matching the other way round — "is what I see a
  // prefix of a command name" — also stops `docount` or `selector` from being
  // read as DO/SELECT: those are not prefixes of anything.
  const head = (part) => {
    const match = /^([A-Za-z][A-Za-z-]*)/.exec(String(part).trim())
    return match ? match[1].toUpperCase() : ''
  }
  const found = (names) => statements.some((part) => {
    const word = head(part)
    if (word.length < 3) return false
    return names.some((name) => name.replace(/\s+/g, '').startsWith(word))
  })
  const LOADS = ['GET DATA', 'GET FILE', 'DATA LIST', 'INPUT PROGRAM', 'BEGIN DATA', 'IMPORT']
  const CHANGES = ['SAVE OUTFILE', 'SAVE TRANSLATE', 'SORT CASES', 'COMPUTE', 'RECODE', 'AUTORECODE', 'AGGREGATE', 'FLIP', 'DO IF', 'DO REPEAT', 'SELECT IF', 'FILTER', 'WEIGHT', 'MISSING VALUES', 'VARIABLE', 'RENAME VARIABLES', 'DELETE VARIABLES', 'MATCH FILES', 'ADD FILES', 'COUNT', 'SAMPLE', 'SAMPLING']
  const ASKS = ['FREQUENCIES', 'DESCRIPTIVES', 'CROSSTABS', 'T-TEST', 'ONEWAY', 'GLM', 'REGRESSION', 'CORRELATIONS', 'PARTIAL', 'MEANS', 'EXAMINE', 'FACTOR', 'RELIABILITY', 'NPAR', 'LOGISTIC', 'ROC', 'CTABLES', 'CLUSTER', 'DISCRIMINANT', 'MVA', 'SUMMARIZE', 'TABLES', 'RANK', 'LIST', 'DISPLAY', 'SHOW']
  const loadsData = statement('GET\\s+DATA|GET\\s+FILE|DATA\\s+LIST|INPUT\\s+PROGRAM|BEGIN\\s+DATA|IMPORT') || found(LOADS)
  const changesData = statement('SAVE\\s+OUTFILE|SAVE\\s+TRANSLATE|SORT\\s+CASES|COMPUTE|RECODE|AUTORECODE|AGGREGATE|FLIP|IF|DO\\s+IF|DO\\s+REPEAT|SELECT\\s+IF|FILTER|WEIGHT|MISSING\\s+VALUES|VARIABLE|RENAME\\s+VARIABLES|DELETE\\s+VARIABLES|MATCH\\s+FILES|ADD\\s+FILES|COUNT') || found(CHANGES)
  // SAMPLE draws a subset; drawing zero cases also leaves no tables behind, but
  // telling the user to widen a filter he never wrote points the wrong way.
  const samplesData = statement('SAMPLE|SAMPL') || found(['SAMPLE', 'SAMPLING'])
  const asksForResults = statement('FREQUENCIES|DESCRIPTIVES|CROSSTABS|T-TEST|ONEWAY|GLM|REG|REGRESSION|CORRELATIONS|PARTIAL|MEANS|EXAMINE|FACTOR|RELIABILITY|NPAR|LOGISTIC|ROC|CTABLES|QUICK\\s+CLUSTER|CLUSTER|DISCRIMINANT|MVA|SUMMARIZE|TABLES|RANK|LIST|DISPLAY|SHOW') || found(ASKS)
  // A filter is the data step that explains "the engine saw no cases"; COMPUTE
  // or SORT do not, and telling the user to widen a filter he never wrote sends
  // him looking in the wrong place. `FILTER OFF` removes a filter, and a bare
  // `FILT` only filters when it names a variable: both would otherwise blame a
  // filter for a problem it did not cause.
  const filtersData = statement('SELECT\\s+IF|FILTER\\s+BY|DO\\s+IF|IF')
    || found(['SELECT IF', 'DO IF'])
    || statements.some((part) => /^FIL(?:T(?:ER)?)?\s+BY\b/i.test(String(part).trim()))
  return { loadsData, changesData, filtersData, samplesData, definesData: loadsData || changesData, asksForResults }
}

/**
 * Split a syntax file into statements, ignoring the periods inside quoted
 * strings (`''` is an escaped quote in SPSS syntax). A period ends a statement
 * only when followed by whitespace or the end of the text, which keeps `1.5`
 * and `C:/a.b/x.csv` intact.
 */
/**
 * Remove `*` and COMMENT lines the way PSPP sees them: at the start of a line,
 * outside any quoted string, everything up to the newline is a comment.
 */
function stripCommentLines(text) {
  const out = []
  let quote = ''
  let atLineStart = true
  // Between BEGIN DATA and END DATA every line is a data value, not syntax: a
  // value that starts with `*` is a value, and stripping it would leave the
  // classifying code reading a hole where the data block is.
  let inInlineData = false
  // `BEGIN DATA` inside MATRIX / END MATRIX never gets an `END DATA` of its own,
  // so the block there is closed by `END MATRIX` instead. Tracked separately, or
  // a data value that reads `END MATRIX.` closes an ordinary block.
  let inMatrix = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      out.push(character)
      if (character === quote) {
        if (text[index + 1] === quote) { index += 1; out.push(text[index]); continue }
        quote = ''
      }
      if (character === '\n') atLineStart = true
      else atLineStart = false
      continue
    }
    if (character === '\n') { out.push(character); atLineStart = true; continue }
    if (atLineStart) {
      if (character === ' ' || character === '\t') { out.push(character); continue }
      const upcoming = text.slice(index)
      if (inInlineData) {
        // `BEGIN DATA` inside a MATRIX block never gets its own `END DATA`;
        // without this the flag leaked and the rest of the file lost its
        // comment stripping.
        // Only a real end-of-block command clears the flag; a data value such as
        // `END DATA DESCRIPTIVES …` starts with the same words and is data.
        // `m` matters: without it `^…$` only matches the whole remainder, so a
        // comment line after `END DATA.` kept the flag on and every later command
        // was swallowed into that comment.
        // Judge *this line only*: `END_DATA_LINE` carries `m`, so testing the rest
        // of the file from the first data line would find a later `END DATA.` and
        // clear the flag early — the second and later `*`-prefixed values were
        // then eaten as comments.
        const thisLine = upcoming.slice(0, upcoming.indexOf('\n') === -1 ? upcoming.length : upcoming.indexOf('\n'))
        // `END DATA` is the only command that closes inline data. A data value
        // that happens to read `END MATRIX.` on its own line used to close the
        // block too (PSPP keeps it as data, and the value after it was then
        // stripped as a comment); `END MATRIX` only matters outside the block.
        if (END_DATA_ONE.test(thisLine)) { inInlineData = false; inMatrix = false } else if (inMatrix && END_MATRIX_ONE.test(thisLine)) { inInlineData = false; inMatrix = false }
        out.push(character)
        atLineStart = false
        continue
      }
      if (/^BEGIN\s+DATA\b/i.test(upcoming)) inInlineData = true
      const lineNow = upcoming.slice(0, upcoming.indexOf('\n') === -1 ? upcoming.length : upcoming.indexOf('\n'))
      // `MATRIX DATA …` ends at `END DATA` and is not matrix algebra; only a
      // `MATRIX.` command opens one (same test as splitStatements).
      if (/^[ \t]*MATRIX[ \t]*\./i.test(lineNow)) inMatrix = true
      else if (END_MATRIX_ONE.test(lineNow)) inMatrix = false
      if (character === '*' || /^COMMENT\b/i.test(upcoming)) {
        while (index < text.length && text[index] !== '\n') index += 1
        out.push('\n')
        atLineStart = true
        continue
      }
    }
    if (character === "'" || character === '"') quote = character
    out.push(character)
    atLineStart = false
  }
  return out.join('')
}

// `END DATA` ends an inline block only when it is alone on its line (a trailing
// `.` allowed). Three places test this — the block-end search, the flag that
// keeps data lines verbatim, and the merge loop — and they must agree: an
// unanchored `/END\s+DATA\b/` also matches a data value that merely starts with
// those words, which would end the block early and hand the rest of the data to
// the engine as syntax.
const END_DATA_LINE = /^[ \t]*END\s+DATA[ \t]*(?:\.[ \t]*.*)?$/im
// `END DATA` plus anything on the same line: PSPP rejects the extra tokens, but
// inside matrix algebra the line is still the end of the data group.
const END_DATA_ANY = /^[ \t]*END\s+DATA\b[^\n]*$/im
const END_MATRIX_LINE = /^[ \t]*END\s+MATRIX\b/im
// Same rules, one line at a time, for callers that hold the rest of the file.
const END_DATA_ONE = /^[ \t]*END\s+DATA[ \t]*(?:\.[ \t]*.*)?$/i
// Lone `END MATRIX.` only: `END_MATRIX_ONE` also clears a leaked data flag, and
// a data value such as `END MATRIX 5` must not look like the end of the block.
const END_MATRIX_ONE = /^[ \t]*END\s+MATRIX[ \t]*\.?[ \t]*$/i

export function splitStatements(text) {
  // `*` and COMMENT comments run to the end of the line and PSPP ignores
  // everything after them — including an apostrophe in prose (`* it's here`),
  // which used to open a string that never closed and swallowed the rest of the
  // file. They are stripped by a quote-aware pass, so a line that only looks
  // like a comment inside a multi-line string is left alone.
  const source = stripCommentLines(String(text ?? ''))
  const parts = []
  let start = 0
  let quote = ''
  // Inside `MATRIX … END MATRIX` the block is closed by END MATRIX, never by a
  // data value that happens to read END DATA, and matrix algebra is not split on
  // periods. Track it here so a data value reading `END MATRIX.` inside an
  // ordinary data block no longer closes that block early.
  let inMatrix = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    // An inline data block is data all the way to END DATA, quotes included: a
    // value like `Bob's` used to open a string that never closed and swallowed
    // every command after the block (the run then looked empty for no reason).
    if (quote === '') {
      if (index === 0 || source[index - 1] === '\n') {
        const lineEnd = source.indexOf('\n', index)
        const line = source.slice(index, lineEnd === -1 ? source.length : lineEnd)
        // `MATRIX DATA` is its own command that ends at `END DATA`; only a
        // `MATRIX.` command opens matrix algebra, so the period is part of the
        // test.
        if (/^[ \t]*MATRIX[ \t]*\./i.test(line)) inMatrix = true
        else if (/^[ \t]*END\s+MATRIX\b/i.test(line)) inMatrix = false
      }
      const upcoming = source.slice(index)
      if (/^BEGIN\s+DATA\b/i.test(upcoming)) {
        // END DATA is a command, so it sits at the start of a line; a data
        // value that merely contains the words (`1 END DATA 2`) is not the end
        // of the block.
        // `END DATA` is a command of its own: a data value that starts with the
        // same words and then carries more (`END DATA DESCRIPTIVES …`) is data.
        // Inside MATRIX the block is closed by `END MATRIX` instead: without
        // this fallback a period inside such a data group split the matrix
        // algebra into statements and the commands after it moved too.
        // Whichever comes first closes the block: inside MATRIX it is
        // `END MATRIX`, and picking `END DATA` merely because it exists later in
        // the file swallowed the ordinary data block that followed the algebra
        // (with its DATA LIST and the analysis after it).
        // A plain data block ends only at END DATA: a value that reads
        // `END MATRIX.` is a value there, not the end of the block.
        // Inside MATRIX a data group's closing line is `END DATA` and PSPP only
        // reports a syntax error for junk after it (`END DATA 5`); taking the
        // whole line as the end keeps the commands after it out of the group.
        const dataEnd = inMatrix ? END_DATA_ANY.exec(upcoming) : END_DATA_LINE.exec(upcoming)
        const matrixEnd = inMatrix ? END_MATRIX_LINE.exec(upcoming) : null
        const end = dataEnd && matrixEnd
          ? (matrixEnd.index < dataEnd.index ? matrixEnd : dataEnd)
          : (dataEnd ?? matrixEnd)
        if (end) {
          let stop = index + end.index + end[0].length
          let after = stop
          while (after < source.length && /\s/.test(source[after])) after += 1
          if (source[after] === '.') after += 1
          parts.push(source.slice(start, after))
          start = after
          index = after - 1
          // Either marker closed the block: a matrix group that ends at
          // `END DATA` (a malformed script) must not leave the flag on.
          inMatrix = false
          continue
        }
      }
    }
    if (character === "'" || character === '"') {
      if (quote === character && source[index + 1] === character) { index += 1; continue }
      if (quote === '') quote = character
      else if (quote === character) quote = ''
      continue
    }
    if (quote !== '') continue
    if (character === '.' && !inMatrix && (index + 1 >= source.length || /\s/.test(source[index + 1]))) {
      parts.push(source.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < source.length) parts.push(source.slice(start))
  const statements = parts.map((part) => part.trim()).filter(Boolean)
  // Inline data between BEGIN DATA and END DATA is data, not syntax: a value
  // that happens to read `Bob. DESCRIPTIVES x` must not be counted as a command.
  const merged = []
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]
    // Matrix algebra is not a data step; drop the whole block rather than
    // leaving its COMPUTE behind as a false "you changed the data".
    if (/^MATRIX\b/i.test(statement)) {
      // `MATRIX DATA …` ends at END DATA and is a command like any other: only a
      // `MATRIX.` command opens algebra, the same test the splitter uses.
      if (!/^[ \t]*MATRIX[ \t]*\./i.test(statement)) { merged.push(statement); continue }
      // The end marker is a command too, so it sits at the start of a line; a
      // matrix string that mentions `END MATRIX` used to end the block early and
      // left its commands behind (they then looked like data steps).
      if (!/^[ \t]*END\s+MATRIX\b/im.test(statement)) {
        // An unterminated `MATRIX` swallows only its own statement: dropping
        // every remaining command made a typo look like an empty script. The
        // splitter keeps the whole tail in one statement there, so what follows
        // the `MATRIX.` is split again and kept.
        // A data group *immediately* after `MATRIX.` belongs to the algebra (it
        // is the matrix's own data), so it goes with the block instead of being
        // read as a data step. Anything further into the tail is the user's and
        // is split normally: only whitespace may sit between the two.
        let tail = statement.replace(/^[ \t]*MATRIX[ \t]*\./i, '')
        // Blank lines and indentation still count as `MATRIX.` being next to the
        // data group; a comment line in between does not (that is the user's).
        if (/^[ \t\r\n]*BEGIN\s+DATA\b/i.test(tail)) {
          const close = END_DATA_ANY.exec(tail)
          if (close) tail = tail.slice(tail.indexOf('\n', close.index) === -1 ? tail.length : tail.indexOf('\n', close.index))
        }
        statements.splice(index, 1, ...splitStatements(tail))
        index -= 1
        continue
      }
      while (index < statements.length && !/^[ \t]*END\s+MATRIX\b/im.test(statements[index])) index += 1
      continue
    }
    if (!/^BEGIN\s+DATA\b/i.test(statement)) { merged.push(statement); continue }
    // The splitter may already have `END DATA.` inside this same statement, so
    // the loop asks the last piece it took rather than the next one — checking
    // the next piece swallowed every command that followed the block.
    const block = [statement]
    while (!END_DATA_LINE.test(block[block.length - 1]) && index + 1 < statements.length) {
      index += 1
      block.push(statements[index])
    }
    merged.push(block.join(' '))
  }
  return merged
}

export function nearestVariableName(message, variables) {
  const match = /([A-Za-z_$#@][A-Za-z0-9_.$#@]*) is not a variable name/i.exec(String(message ?? ''))
  if (!match) return ''
  const wanted = match[1]
  const candidates = variables.map((variable) => String(variable?.name ?? '')).filter(Boolean)
  if (candidates.length === 0) return ''
  const distance = (left, right) => {
    const a = left.toLowerCase()
    const b = right.toLowerCase()
    const rows = a.length + 1
    const columns = b.length + 1
    let previous = Array.from({ length: columns }, (_, index) => index)
    for (let i = 1; i < rows; i += 1) {
      const current = [i]
      for (let j = 1; j < columns; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      }
      previous = current
    }
    return previous[columns - 1]
  }
  let best = null
  for (const name of candidates) {
    const score = distance(wanted, name)
    if (best === null || score < best.score) best = { name, score }
  }
  if (!best) return ''
  const tolerance = Math.max(2, Math.floor(wanted.length / 3))
  if (best.score > tolerance) return `数据集里没有叫 ${wanted} 的变量`
  return `数据集里没有叫 ${wanted} 的变量，最接近的是 ${best.name}`
}

export function describeFailure(result) {
  // Read the crash banner before picking a line: the banner's own "last non-empty
  // line" is `build_system: ...`, which reads like a syntax complaint and hides
  // that the engine died of its own defect. The exit code is only a hint here
  // (139 on Linux, 3 on Windows for the same crash), never the test.
  const combined = `${String(result?.stderr ?? '')}\n${String(result?.stdout ?? '')}`
  const crash = describeEngineCrash(combined, crashExitCode(result))
  if (crash) return crash
  const lines = [
    ...String(result?.stderr ?? '').split('\n'),
    ...String(result?.stdout ?? '').split('\n'),
  ].map((line) => line.trim()).filter(Boolean)
  const pick = lines.find((line) => /error|错误|conformant|gsl_|cannot|无法/i.test(line))
    ?? lines[lines.length - 1]
  const code = result?.code === null || result?.code === undefined
    ? (result?.timedOut ? '超时' : '没有退出码')
    : `退出码 ${result.code}${result?.timedOut ? '（超时）' : ''}`
  // The picked line still names the plugin's own temp syntax file; the user
  // needs the sentence, not the path they never saw.
  return pick ? `${code}：${stripEngineLocation(pick)}` : `${code}，引擎没有输出任何诊断信息`
}

/**
 * Tolerance values from the engine's Coefficients table, or null.
 *
 * PSPP splits the header over two rows ("Collinearity Statistics" then
 * "Tolerance | VIF"), so the word has to be searched in the first few rows and
 * the numbers read from the column below it.
 */
function engineTolerance(items) {
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    for (let row = 0; row < Math.min(matrix.length, 3); row += 1) {
      const header = Array.isArray(matrix[row]) ? matrix[row] : []
      const column = header.findIndex((cell) => /^(tolerance|容忍度)/i.test(String(cell ?? '').trim()))
      if (column < 0) continue
      return matrix.slice(row + 1)
        .map((entry) => String(entry?.[column] ?? '').trim())
        .filter((value) => value !== '')
    }
  }
  return null
}

function tolerancesAgree(engineValues, built) {
  if (!built || engineValues.length === 0) return false
  const mine = built.matrix.slice(1).map((row) => Number(row[1]))
  if (mine.length !== engineValues.length) return false
  return engineValues.every((value, index) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return false
    return Math.abs(parsed - mine[index]) <= 0.02
  })
}

/**
 * Blank the engine's tolerance cells when they cannot be trusted.
 *
 * PSPP writes ".00 / +Infinit" for a degenerate fit; leaving that above our own
 * table makes the reader trust the wrong number, so those cells become "—" and
 * the table says where the real values are.
 */
function blankEngineTolerance(items) {
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    for (let row = 0; row < Math.min(matrix.length, 3); row += 1) {
      const header = Array.isArray(matrix[row]) ? matrix[row] : []
      const tolerance = header.findIndex((cell) => /^(tolerance|容忍度)/i.test(String(cell ?? '').trim()))
      if (tolerance < 0) continue
      const vif = header.findIndex((cell) => /^vif$/i.test(String(cell ?? '').trim()))
      for (const entry of matrix.slice(row + 1)) {
        if (!Array.isArray(entry)) continue
        if (String(entry[tolerance] ?? '').trim() !== '') entry[tolerance] = '—'
        if (vif >= 0 && String(entry[vif] ?? '').trim() !== '') entry[vif] = '—'
      }
      item.notes = [
        ...(item.notes ?? []),
        '引擎打印的容忍度不可用（PSPP 在退化拟合下会写成 .00 / +Infinit），已置为「—」；正确值见下面的「共线性诊断（插件计算）」',
      ]
      return
    }
  }
}

/**
 * Flag the separation warning on a logistic table.
 *
 * Separation means one predictor (nearly) determines the outcome: the estimate
 * runs off to infinity, its standard error explodes and the confidence interval
 * turns into 0 to +Infinit. A huge Exp(B) alone is NOT the signal — a genuinely
 * strong risk factor (OR 150, CI 120-190) is a real result — and the constant is
 * not a predictor at all, so an imbalanced outcome that pushes the intercept to
 * Exp(B)=199 says nothing about separation. The check therefore looks only at
 * predictor rows and asks for direct evidence: a standard error above 5, a
 * non-finite confidence limit, or an interval wider than 1000-fold.
 */
/**
 * A frequency table over a continuous variable has one row per distinct value,
 * so `FREQUENCIES /VARIABLES=score` on 10 000 cases produces a 4 000-row table
 * and the Word export grows to ten megabytes. That is the engine behaving as
 * documented, but nothing warns the user, so the note says which command to
 * use instead.
 */
/** Create the folder a user asked us to write into, with a readable failure. */
async function firstNonDirectory(target) {
  // Walk down from the root and return the first component that exists but is
  // not a folder. "上级路径里有一段是文件" without a name leaves the user to
  // guess which one, and the guess is usually wrong.
  const { root } = parse(target)
  const parts = target.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = current ? join(current, part) : part
    const info = await stat(current).catch(() => null)
    if (!info) return null
    if (!info.isDirectory()) return current
  }
  return null
}

async function ensureParentDir(target) {
  const parent = dirname(target)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    // mkdir -p reports EEXIST when a component of the path is an existing file
    // ("/tmp/a.csv/out.xlsx"), and saying "out.xlsx 已经存在" about a file that
    // does not exist sends the user looking in the wrong place.
    if (error?.code === 'EEXIST' || error?.code === 'ENOTDIR') {
      const blocker = await firstNonDirectory(parent)
      if (blocker === null) {
        throw new Error(`写不进去：${parent} 的上级路径里有一段是文件，不是文件夹`)
      }
      throw new Error(blocker === parent
        ? `写不进去：${parent} 是一个文件，不能当作文件夹用；要保存到它旁边，把路径改成 ${dirname(parent)}/ 下的另一个名字`
        : `写不进去：${blocker} 是一个文件，不能当作文件夹用（${parent} 这段路径要经过它）；把路径换到别处，或者先给它改名`)
    }
    throw new Error(describeFsError(error, target))
  }
}

const NON_FINITE = /^(nan|\+?infinit\w*|-?infinit\w*|inf|\+inf|-inf|∞)$/i

/**
 * Flag a coefficients table whose numbers include NaN or infinite values.
 *
 * A perfect collinear pair or a constant predictor makes the engine print NaN /
 * +Infinit in B and S.E.; the table looks finished, so without this note the
 * numbers get copied into a report as if they meant something.
 */
export function annotateNonFiniteCoefficients(items) {
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    // A t test's "Independent Samples Test" also has a t column and a Sig.
    // column, so the header alone is not enough: the note talks about
    // coefficients and collinearity, which only a regression table has.
    const caption = String(item.table?.caption ?? item.title ?? '')
    if (!/Coefficients|系数/i.test(caption)) continue
    const head = matrix.slice(0, 4)
    const looksLikeCoefficients = head.some((row) => (
      row.some((cell) => /^t$/i.test(String(cell ?? '').trim()))
      && row.some((cell) => /^sig\.?/i.test(String(cell ?? '').trim()))
    ))
    if (!looksLikeCoefficients) continue
    const hit = matrix.some((row) => row.some((cell) => NON_FINITE.test(String(cell ?? '').trim())))
    if (!hit) continue
    const notes = item.notes ?? (item.notes = [])
    if (notes.some((note) => /Infinit|NaN/.test(note))) continue
    // Only point at a table that is actually in this run: with perfect
    // collinearity the engine stops before printing Collinearity Diagnostics,
    // and "go look at that table" sends the reader hunting for nothing.
    const hasDiagnostics = items.some((other) => other.kind === 'table'
      && /Collinearity Diagnostics|共线性诊断/i.test(String(other.table?.caption ?? other.title ?? '')))
    const pointer = hasDiagnostics
      ? '先看「共线性诊断」表（看条件指数与方差比例），或者去掉多余的变量再重跑'
      : '这次没有生成「共线性诊断」表（回归在打印它之前就停了），所以先看清楚哪几个自变量是同一个东西的线性组合，去掉其中一个再重跑'
    notes.push(`系数里有 NaN 或 +Infinit：常见原因是预测变量之间完全共线、某个预测变量是常数，或者某一组数据完全没有变异。这几行的 B、S.E.、t 与 Sig. 不能用，${pointer}`)
  }
  return items
}

export function annotateOversizedTables(items, limit = 500) {
  for (const item of items) {
    if (item.kind !== 'table') continue
    const rows = item.table?.matrix?.length ?? 0
    if (rows <= limit) continue
    item.notes = [
      ...(item.notes ?? []),
      `这张表有 ${rows} 行：多半是把连续变量放进了频率表（FREQUENCIES 会为每个不同取值列一行）。连续变量请改用描述统计或探索；导出 Word/Excel 时这张表会占很大篇幅`,
    ]
    if (item.table) item.table.notes = item.notes
  }
  return items
}

export function annotateSeparation(items) {
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    let headerRow = -1
    let expColumn = -1
    for (let index = 0; index < Math.min(matrix.length, 4) && headerRow < 0; index += 1) {
      const header = Array.isArray(matrix[index]) ? matrix[index] : []
      const found = header.findIndex((cell) => /^exp\(b\)$/i.test(String(cell ?? '').trim()))
      if (found >= 0) { headerRow = index; expColumn = found }
    }
    if (headerRow < 0) continue
    // Column layout differs between PSPP builds, so read the header text rather
    // than assuming a fixed order.
    const headerText = matrix.slice(0, headerRow + 2).flat()
      .map((cell) => String(cell ?? '').trim())
    const findColumn = (pattern) => {
      for (let index = 0; index < headerRow + 2; index += 1) {
        const row = Array.isArray(matrix[index]) ? matrix[index] : []
        const found = row.findIndex((cell) => pattern.test(String(cell ?? '').trim()))
        if (found >= 0) return found
      }
      return -1
    }
    const seColumn = findColumn(/^s\.e\.$/i)
    const lowerColumn = findColumn(/^lower$/i)
    const upperColumn = findColumn(/^upper$/i)
    const parseNumber = (value) => {
      const text = String(value ?? '').trim()
      if (text === '') return null
      const parsed = Number(text)
      return Number.isFinite(parsed) ? parsed : null
    }
    const nonFinite = (value) => {
      const text = String(value ?? '').trim()
      return text !== '' && !Number.isFinite(Number(text))
    }
    let separated = false
    for (const entry of matrix.slice(headerRow + 1)) {
      if (!Array.isArray(entry)) continue
      const label = String(entry[1] ?? entry[0] ?? '').trim()
      if (label === '') continue
      // Header carries "Std. Error"/"Lower"/"Upper"/"Exp(B)" in the same rows.
      if (/^(b|s\.e\.|lower|upper|exp\(b\))$/i.test(label)) continue
      if (/^(constant|常数项?|截距)$/i.test(label)) continue
      const se = seColumn >= 0 ? parseNumber(entry[seColumn]) : null
      if (se !== null && se > 5) { separated = true; break }
      if (lowerColumn >= 0 && upperColumn >= 0) {
        const lowerText = entry[lowerColumn]
        const upperText = entry[upperColumn]
        if (nonFinite(lowerText) || nonFinite(upperText)) { separated = true; break }
        const lower = parseNumber(lowerText)
        const upper = parseNumber(upperText)
        if (lower !== null && upper !== null && lower > 0 && upper > 0 && upper / lower > 1000) {
          separated = true
          break
        }
      }
      const exp = parseNumber(entry[expColumn])
      if (exp !== null && (exp > 1e6 || (exp > 0 && exp < 1e-6))) { separated = true; break }
    }
    if (!separated) continue
    item.notes = [
      ...(item.notes ?? []),
      '预测变量的标准误异常大、或 Exp(B) 的置信区间宽到不合理（含 +Infinit、上下限相差千倍以上）：这通常是小样本里结局被完全或近乎完全预测造成的「分离」，不是拟合出错。本例可用 Firth 惩罚似然或精确 Logistic 复核，或增加样本量',
    ]
  }
}

/* ------------------------------------------------------------------ *
 * 交叉表与信度输出的表注                                            *
 * ------------------------------------------------------------------ */

/**
 * 从语法里读 CROSSTABS 的 /STATISTICS 列表：有些「勾了但引擎没给」的解释只能
 * 靠请求了什么来判断（引擎不报错，只是不打那一行）。
 */
/**
 * Exact test for the crosstab the engine just printed.
 *
 * PSPP prints Fisher only for 2×2 and rejects `/METHOD=EXACT`, so when the
 * dialog asks for the exact p the plugin reads the counts back off its own
 * crosstab table and appends the verdict as a note on that table. The note
 * names the method, so a Monte Carlo estimate cannot be mistaken for an
 * enumerated one.
 */
export function annotateExactTest(items, request) {
  const wantExact = request === true || request?.exact === true
  const wantChi = request?.exactChi === true
  if (!wantExact && !wantChi) return
  const target = items.find((item) => item.kind === 'table' && crosstabCounts(item.table?.matrix))
  if (!target) return
  // crosstabCounts hands back the counts plus their margins, not a bare matrix.
  const parsed = crosstabCounts(target.table.matrix)
  if (!parsed) return
  const lines = []
  let result = null
  if (wantExact) {
    result = exactTest(parsed.counts)
    const text = describeExact(result)
    if (text) lines.push(text)
  }
  if (wantChi) {
    for (const kind of ['pearson', 'likelihood']) {
      const text = describeChiSquareExact(exactChiSquare(parsed.counts, kind))
      if (text) lines.push(text)
    }
  }
  if (lines.length === 0) return result
  const note = `精确检验（插件计算）：${lines.join('；')}`
  target.notes = [...(target.notes ?? []), note]
  target.table = { ...target.table, notes: [...(target.table.notes ?? []), note] }
  return result
}

/**
 * Read the predictors out of a hand-written `REGRESSION` command.
 *
 * The panel's dialogs and `pspp_analyze` hand the workspace an explicit list, but a
 * script typed into the syntax editor only has the command itself — and without the
 * list the sample-size note silently never fires, which is the path most people use.
 */
export function requestedRegression(syntax) {
  // The editor keeps whatever the user typed, including `* REGRESSION …` comments
  // and other commands that carry a /VARIABLES= list. Only the statement the engine
  // actually runs describes this regression, and when several run the last one wins
  // (the tables on screen are the last one's).
  const statements = splitStatements(String(syntax ?? ''))
    .filter((part) => /^\s*REGRESSION\b/i.test(part))
  const last = statements[statements.length - 1]
  if (!last) return null
  // `METHOD=STEPWISE PIN(0.05) POUT(0.10) a b` mixes suboptions with names, and
  // `METHOD=TEST(a)` / `METHOD=TEST(a; b)` carries names inside parentheses. Drop
  // the parenthesised groups first, then the suboption keywords that stand alone.
  const tokensOf = (text) => String(text ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9_.$#@]/g, '').replace(/[.,;]+$/, ''))
    .filter(Boolean)
    .filter((token) => !/^(ENTER|STEPWISE|REMOVE|TEST|BACKWARD|FORWARD|PIN|POUT|CRITERIA|SINGLE)$/i.test(token))
  const independents = []
  const sources = [
    last.match(/\/METHOD\s*=\s*\w+\s+([^/\n]*)/i),
    last.match(/\/ENTER\s*=\s*([^/\n]*)/i),
    last.match(/\/VARIABLES\s*=\s*([^/\n]*)/i),
  ]
  for (const match of sources) {
    if (!match) continue
    for (const clean of tokensOf(match[1])) {
      if (!independents.includes(clean)) independents.push(clean)
    }
  }
  const dependent = last.match(/\/DEPENDENT\s*=\s*([A-Za-z][A-Za-z0-9_.$#@]*)/i)?.[1]?.replace(/[.,;]+$/, '') ?? null
  const predictors = independents.filter((name) => name !== dependent)
  if (predictors.length === 0) return null
  // Same shape as `analysisExtras('regression', …)`: `dependent` is one name.
  return { dependent, independents: predictors }
}

export function requestedCrosstabStatistics(syntax) {
  let statement = ''
  for (const part of String(syntax ?? '').split('.')) {
    if (/\bCROSSTABS\b/i.test(part)) { statement = part; break }
  }
  if (!statement) return []
  const match = statement.match(/STATISTICS\s*=\s*([^/\n]*)/i)
  if (!match) return []
  return match[1].trim().split(/\s+/).filter(Boolean).map((entry) => entry.toUpperCase())
}

/**
 * 交叉表补 Cramér's V、小样本的 Fisher 指向、Kappa 的适用范围。
 *
 * 数字只从引擎那几张表里读：χ² 与有效 N 带着 WEIGHT / FILTER，在数据集上重算会
 * 得出另一个数，而交叉表是最容易被整张贴进论文的东西 —— 一个和旁边 χ² 对不上的 V
 * 比没有 V 糟糕得多，所以行列数对不上 df 时宁可只写一句「没算」。
 */
export function annotateCrosstabs(items, options = {}) {
  const pairs = []
  let pending = null
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    // 层变量的交叉表（a × b × c）每层各有一套行合计，结构不是一张方表，插件在这里
    // 不猜行列数；顺手把 pending 清掉，免得它的卡方表被算到上一张单层交叉表头上。
    if (isLayeredCrosstab(item)) {
      pushNote(item, '这是带层变量（a × b × c）的交叉表：引擎把它按层拆成好几张，插件不在这里推断行列数，所以没有算 Cramér\'s V，也没有加 Fisher 提示。要看效应量请去掉层变量、或者在每层上单独跑一次交叉表')
      if (options.cmh === true) annotateLayeredCmh(item, options.dataset ?? null)
      pending = null
      continue
    }
    // A 2×2 chi-square table with a tiny sample can carry only Fisher's Exact
    // Test and the continuity correction: PSPP drops the Pearson row instead of
    // printing a zero. Without a word, the reader thinks the run was wrong.
    if (isChiSquareTable(item)
      && !matrix.some((row) => Array.isArray(row) && /^(pearson chi-square|likelihood ratio)$/i.test(assumptionText(row[0])))
      && matrix.some((row) => Array.isArray(row) && /fisher|精确检验|确切概率/i.test(assumptionText(row[0])))) {
      pushNote(item, '这张表没有 Pearson 卡方行：2×2 小样本时 PSPP 只打印 Fisher 精确检验与连续性校正（不是跑错了）。这种样本量下就该看 Fisher 的 p 值')
    }
    const counts = crosstabCounts(matrix)
    if (counts) {
      pending = { counts, item }
      pairs.push(pending)
      continue
    }
    if (!pending) continue
    if (!pending.chi && isChiSquareTable(item)) {
      // PSPP 在 Pearson χ² 恰好为 0 时会把那一行整个省掉（2×2 小样本里很常见），
      // 所以拿不到引擎的 χ² 就按同一张表的计数补算，V 与「看 Fisher」都还能给。
      pending.chi = { item, value: chiSquareFromTable(matrix) ?? chiSquareFromCounts(pending.counts, matrix) }
      continue
    }
    if (!pending.sym && isSymmetricMeasures(item)) pending.sym = { item, matrix }
  }
  // 先收齐再动笔：引擎在用 PHI 时自己就会打一张带 Cramer's V 的 Symmetric Measures，
  // 那种情况不该再往 Chi-Square Tests 里塞一行重复的数字。
  const requested = Array.isArray(options.statistics)
    ? options.statistics.map((entry) => String(entry).toUpperCase())
    : []
  for (const pair of pairs) {
    if (pair.chi) applyCramersV(pair)
    else applyMissingChiSquareHint(pair)
    if (pair.sym) applyKappa(pair.counts, pair.sym.item, pair.sym.matrix)
    applyMissingCrosstabStatistics(pair, items, options.statistics)
    applySmallCellNote(pair, items)
    applyContinuityNote(pair, items)
    if (requested.includes('RISK') || options.forceRisk === true) applyRiskDifference(pair, items, options.dataset)
  }
  return items
}

/**
 * The chi-square approximation is only good while the expected counts are big
 * enough. PSPP prints them only when asked (`/CELLS=EXPECTED`), so the counts
 * are recomputed here — and the note has to come with the number, because "期望
 * 频数偏小" without a figure reads as boilerplate and gets ignored.
 */
function applySmallCellNote(pair, items = []) {
  const small = Number(pair?.counts?.smallCells ?? 0)
  if (!(small > 0)) return
  // The "the engine did not print an exact test" note says the same thing when
  // it applies — and it lands on the χ² table, not on the crosstab, so the
  // duplicate has to be looked for across the run's items.
  const spoken = items.some((item) => (item?.notes ?? []).some((text) => String(text).includes('期望频数')))
  if (spoken) return
  const min = Number(pair?.counts?.minExpected)
  const where = Number.isFinite(min) ? `（最小 ${min.toFixed(2)}）` : ''
  const advice = pair.counts.rows === 2 && pair.counts.columns === 2
    ? '2×2 请以 Fisher 精确检验为准'
    : '可以勾「精确卡方 p」让插件按边际枚举出精确 p'
  pushNote(pair.item, `有 ${small} 个单元格的期望频数 < 5${where}：Pearson 卡方在这里只是近似，${advice}`)
}

/**
 * PSPP prints a Continuity Correction row for every 2×2 table, and it is the
 * row a statistician would read when the counts are small. A non-statistician
 * reads "Pearson Chi-Square" because it is first, so the note points at the row
 * the engine already printed rather than asking for another run.
 */
function applyContinuityNote(pair, items = []) {
  const target = pair?.chi?.item
  const matrix = target?.table?.matrix
  if (!Array.isArray(matrix)) return
  const hasCorrection = matrix.some((row) => (row ?? []).some((cell) => /continuity correction|连续性校正|連續性修正/i.test(assumptionText(cell))))
  if (!hasCorrection) return
  // When the expected counts are small the note above already names Fisher, and
  // it names the correction too; saying it twice is noise.
  const spoken = items.some((item) => (item?.notes ?? []).some((text) => String(text).includes('期望频数')))
  if (spoken) return
  pushNote(target, '这是 2×2 表：PSPP 额外给了一行连续性校正（Continuity Correction），个案不多时它比 Pearson 卡方保守，优先读那一行；个案很少时以 Fisher 精确检验为准')
}

/**
 * PSPP prints the odds ratio and the relative risk in "Risk Estimate", but never
 * the risk difference or its interval. The counts are already here, so the
 * difference of the two row proportions and Newcombe's hybrid score interval go
 * onto that table as a note.
 *
 * The note names the real category values: PSPP's own Risk Estimate is per
 * column ("For cohort wave = 1") while the difference is per row, so a note that
 * only said "第 1 行 / 第一列" left the reader convinced the arithmetic was
 * reversed.
 */
function applyRiskDifference(pair, items, dataset) {
  const counts = pair?.counts?.counts
  if (!Array.isArray(counts) || counts.length !== 2 || (counts[0] ?? []).length !== 2) return
  const firstRow = counts[0][0] + counts[0][1]
  const secondRow = counts[1][0] + counts[1][1]
  if (!(firstRow > 0) || !(secondRow > 0)) return
  const result = riskDifferenceCi(counts[0][0], firstRow, counts[1][0], secondRow, 0.95)
  if (!result) return
  const scope = riskScope(pair, dataset)
  const text = scope
    ? describeRiskDifference(result, scope)
    : `${describeRiskDifference(result, { label: '第 1 行 − 第 2 行（第一列的事件）' }) ?? ''}；把事件列换成另一列时差值是相反数，区间关于 0 对称`
  if (!text) return
  pushNote(riskEstimateAfter(pair.item, items) ?? pair.item, text)
}

/** The Risk Estimate table that belongs to THIS crosstab, not the first one. */
function riskEstimateAfter(item, items) {
  const start = Array.isArray(items) ? items.indexOf(item) : -1
  if (start < 0) return null
  for (let index = start + 1; index < items.length; index += 1) {
    const candidate = items[index]
    const caption = String(candidate?.table?.caption ?? candidate?.title ?? '')
    if (/×(?!Risk)/.test(caption) && candidate !== item) {
      // The next crosstab starts here; its Risk Estimate is not ours.
      if (!/risk estimate/i.test(caption)) break
    }
    if (candidate.kind === 'table' && /risk estimate/i.test(caption)) return candidate
  }
  return null
}

const CROSSTAB_TOTAL_LABEL = /^(?:总计|total)$/i
const CROSSTAB_COUNT_LABEL = /^(?:计数|count)$/i
const CROSSTAB_EXPECTED_LABEL = /^(?:期望值|expected)$/i

/**
 * 单层交叉表里两类标签各在哪一列。
 *
 * 第一行是列变量的名字，第二行是列变量的各个取值（有值标签时引擎打的是标签），
 * 数据行的第 2 列则是行变量的取值；统计量标签列（计数/期望值）固定在第 3 列，
 * 所以在单层表里行标签必在第 2 列（下标 1）。带层变量的表每层各有一套行合计，
 * 结构完全不同，这里直接不认，免得把层名当成类别值。
 */
function crosstabAxes(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 4) return null
  const text = (cell) => String(cell ?? '').trim()
  const header = (matrix[0] ?? []).map(text)
  const totalColumn = header.findIndex((cell) => CROSSTAB_TOTAL_LABEL.test(cell))
  const lastColumn = totalColumn > 0 ? totalColumn : header.length - 1
  const columnLabels = matrix[1] ?? []
  const dataColumns = []
  for (let column = 1; column < lastColumn; column += 1) {
    if (text(columnLabels[column]) !== '') dataColumns.push(column)
  }
  if (dataColumns.length !== 2) return null
  let labelColumn = -1
  for (let column = 0; column < dataColumns[0] && labelColumn < 0; column += 1) {
    const found = matrix.some((row) => (
      CROSSTAB_COUNT_LABEL.test(text(row?.[column])) || CROSSTAB_EXPECTED_LABEL.test(text(row?.[column]))
    ))
    if (found) labelColumn = column
  }
  if (labelColumn !== 2) return null
  const rows = []
  let rowHeader = ''
  for (const row of matrix) {
    if (!Array.isArray(row)) continue
    if (CROSSTAB_TOTAL_LABEL.test(text(row[0]))) continue
    if (!CROSSTAB_COUNT_LABEL.test(text(row[labelColumn]))) continue
    if (!rowHeader) rowHeader = text(row[0])
    rows.push({ text: text(row[labelColumn - 1]) })
  }
  if (rows.length !== 2) return null
  return {
    columns: dataColumns.map((column) => ({ text: text(columnLabels[column]), header: text(matrix[0]?.[column]) })),
    rows,
    columnHeader: text(matrix[0]?.[dataColumns[0]]) || text(matrix[1]?.[dataColumns[0]]),
    rowHeader,
  }
}

/** 交叉表表头写的是变量标签（有的话），拿它回数据集里找回真名与值标签。 */
function crosstabVariable(dataset, hint) {
  const text = String(hint ?? '').trim()
  if (!text) return null
  const variables = Array.isArray(dataset?.variables) ? dataset.variables : []
  // A name is unique, a label is not (a copied variable keeps its label). Two
  // variables sharing the label means the table header cannot say which one it
  // is, so guessing would print `<other variable>=男` under this table.
  const byLabel = variables.filter((variable) => String(variable.label ?? '').trim() === text)
  if (byLabel.length === 1) return byLabel[0]
  const byName = variables.find((variable) => String(variable.name ?? '').trim().toUpperCase() === text.toUpperCase())
  return byName ?? null
}

/**
 * 矩阵里那一格到底是取值还是值标签：有值标签时引擎打标签，没有时打取值。
 * 两种都换算成 `{ name, value, label }`，让注文能写成 `wave=1「第一波」`。
 */
function crosstabCategory(variable, cellText) {
  // The engine prints a category with the variable's FORMAT, so an integer code
  // arrives as `1.00`. A note saying `wave=1.00` under a table that says `1`
  // reads as a different value; drop the padding zeros.
  const text = String(cellText ?? '').trim()
    .replace(/^(-?\d+)\.(\d*?)0+$/, (whole, head, tail) => (tail === '' ? head : `${head}.${tail}`))
    .replace(/^(-?\d+)\.$/, '$1')
  const part = { name: String(variable?.name ?? '').trim(), value: text, label: '' }
  const entries = variable?.valueLabels && typeof variable.valueLabels === 'object'
    ? Object.entries(variable.valueLabels)
    : []
  if (entries.length === 0 || text === '') return part
  const byLabel = entries.filter(([, label]) => String(label ?? '').trim() === text)
  // Two values sharing one label ("是"/"是") cannot tell us which value this
  // column is; claiming the first would make the note say both columns are 1.
  if (byLabel.length === 1) return { ...part, value: String(byLabel[0][0]).trim(), label: text }
  if (byLabel.length > 1) return part
  const byValue = entries.find(([value]) => String(value).trim() === text)
  if (byValue) return { ...part, label: String(byValue[1] ?? '').trim() }
  return part
}

/**
 * 注文要讲的三个位置：事件列（第一列）、另一列、两行的类别值。
 * 标签取不到时留空，由 describeRiskDifference 退回「第 N 列 / 第 N 行」。
 */
function riskScope(pair, dataset) {
  const axes = crosstabAxes(pair?.item?.table?.matrix)
  if (!axes) return null
  const columnVariable = crosstabVariable(dataset, axes.columnHeader)
  const rowVariable = crosstabVariable(dataset, axes.rowHeader)
  const columns = axes.columns.map((entry) => {
    const part = crosstabCategory(columnVariable, entry.text)
    if (!part.name) part.name = axes.columnHeader || entry.header
    return part
  })
  return {
    event: columns[0],
    other: columns[1],
    rows: axes.rows.map((entry) => crosstabCategory(rowVariable, entry.text)),
  }
}

/**
 * 引擎对几个统计量有前置条件，不满足时它不报错、只是把那张表整张省掉。用户勾了
 * 却什么都没看到时最容易以为插件漏了，所以逐个点名，并写清为什么没有。
 */
const CROSSTAB_STATISTIC_ROWS = {
  RISK: { table: /risk estimate/i, rows: [/^risk estimate/i, /odds ratio/i], why: '风险估计只在 2×2 表里输出' },
  ETA: { table: null, rows: [/^eta$/i], why: 'Eta 需要一个名义变量配一个数值变量' },
  CORR: { table: null, rows: [/spearman/i, /pearson's r/i], why: '要求两个变量都是数值（或有序）变量' },
  BTAU: { table: null, rows: [/tau-b/i], why: '要求两个变量都是有序变量' },
  CTAU: { table: null, rows: [/tau-c/i], why: '要求两个变量都是有序变量' },
  D: { table: null, rows: [/^somers' d/i], why: '要求两个变量都是有序变量' },
  UC: { table: null, rows: [/uncertainty coefficient/i], why: '要求两个变量都是分类变量' },
  LAMBDA: { table: null, rows: [/lambda/i], why: '要求两个变量都是分类变量' },
  GAMMA: { table: null, rows: [/gamma/i], why: '要求两个变量都是有序变量' },
}

function applyMissingCrosstabStatistics(pair, items, statistics) {
  const requested = Array.isArray(statistics) ? statistics.map((entry) => String(entry).toUpperCase()) : []
  if (requested.length === 0) return
  const rows = []
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    rows.push(String(item.table?.caption ?? item.title ?? ''))
    for (const line of item.table.matrix) {
      for (const cell of line ?? []) rows.push(String(cell ?? '').trim())
    }
  }
  const seen = (probe) => rows.some((text) => probe.test(text))
  const missing = []
  for (const name of requested) {
    const spec = CROSSTAB_STATISTIC_ROWS[name]
    if (!spec) continue
    if (spec.table && seen(spec.table)) continue
    if (seen(spec.rows[0])) continue
    if (spec.rows.slice(1).some((probe) => seen(probe))) continue
    missing.push(`${name}（${spec.why}）`)
  }
  if (missing.length === 0) return
  pushNote(pair.item, `这几项统计量勾了，但引擎没有输出：${missing.join('、')}。引擎对不满足前提的表不报错，只是把那一行/那张表省掉`)
}

/**
 * 认带层变量的交叉表：标题里不止一个 ×，而且表里有计数行。
 * 单层交叉表的标题只有一个 ×（"a × b"），所以这个判据很稳。
 */
/**
 * 层变量交叉表的计数：引擎把它们压在一张表里，每层一块。
 *
 * 形状（实测 PSPP 2.1.3）：
 *   ["","","","","","wave","","Total"]
 *   ["","","","","","1.00","2.00",""]
 *   ["grp","A","g","female","Count","14","1","15"]
 * 层名在第 0 列、行类别在 Count 左边一列、计数在列变量那几列。只有每层都是
 * 2×2 时才拿去做 CMH —— 别的形状硬凑会给出一个不属于任何表的数。
 */
function layeredCrosstabCounts(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 5) return null
  const text = (cell) => String(cell ?? '').trim()
  const header = (matrix[0] ?? []).map(text)
  const columnLabels = (matrix[1] ?? []).map(text)
  const dataColumns = []
  for (let column = 0; column < columnLabels.length; column += 1) {
    if (columnLabels[column] === '') continue
    if (CROSSTAB_TOTAL_LABEL.test(header[column] ?? '')) continue
    dataColumns.push(column)
  }
  if (dataColumns.length !== 2) return null
  let labelColumn = -1
  for (const row of matrix) {
    const found = (row ?? []).findIndex((cell) => CROSSTAB_COUNT_LABEL.test(text(cell)))
    if (found >= 0) { labelColumn = found; break }
  }
  if (labelColumn < 2) return null
  const strata = []
  let current = null
  for (const row of matrix.slice(2)) {
    if (!Array.isArray(row)) continue
    // A new layer block starts where the layer value appears; the variable name
    // sits one column to its left and only on the first block.
    const layerValue = text(row[1])
    if (layerValue !== '' && !CROSSTAB_TOTAL_LABEL.test(layerValue)) {
      current = { label: layerValue, rows: [] }
      strata.push(current)
      // The block's first row is also its first category, so do not skip it --
      // dropping it left every stratum with a single row and no CMH.
    }
    if (!current) continue
    if (!CROSSTAB_COUNT_LABEL.test(text(row[labelColumn]))) continue
    const category = text(row[labelColumn - 1])
    if (category === '' || CROSSTAB_TOTAL_LABEL.test(category)) continue
    const countText = dataColumns.map((column) => text(row[column]))
    // A blank count is a missing number, not a zero: Number('') is 0 and would
    // quietly turn an empty cell into an empty stratum.
    if (countText.some((entry) => entry === '')) return null
    const counts = countText.map((entry) => Number(entry))
    if (!counts.every((value) => Number.isFinite(value) && value >= 0)) return null
    current.rows.push({ label: category, counts })
  }
  const usable = strata.filter((stratum) => stratum.rows.length === 2)
  if (usable.length !== strata.length || usable.length === 0) return null
  return {
    layerName: text(matrix[2]?.[0]) || '',
    rowName: text(matrix[2]?.[2]) || '',
    columnName: header.find((cell) => cell !== '' && !CROSSTAB_TOTAL_LABEL.test(cell)) || '',
    strata: usable.map((stratum) => ({ label: stratum.label, matrix: stratum.rows.map((row) => row.counts) })),
  }
}

/**
 * The assumptions live in tables the engine already prints, so the only thing
 * missing was reading them: a run that reports "方差齐性 不成立" in the same
 * output as the t test is easy to miss, and somebody who does not know SPSS will
 * read the equal-variances row anyway.
 */
const HOMOGENEITY_LABEL = /Levene|Homogeneity of Variance|方差齐性|變異數同質/i
const HOMOGENEITY_ROW = /Based on Mean|Based on Median|Based on trimmed mean/i
const assumptionText = (value) => String(value?.text ?? value ?? '').replace(/\s+/g, ' ').trim()

export function annotateAssumptions(items) {
  if (!Array.isArray(items)) return items
  // A t test prints the unequal-variances row inside its own table; a one-way
  // ANOVA prints Levene in a table of its own and has no such row. The advice
  // therefore follows the table being annotated, not the other tables in the
  // run: a syntax that mixes both would otherwise get the t test's sentence on
  // the ANOVA table.
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    const labelled = matrix.some((row) => Array.isArray(row) && HOMOGENEITY_LABEL.test(row.map(assumptionText).join(' ')))
    if (!labelled) continue
    // The header is not always one row: an Independent Samples Test prints
    // "Levene's Test for Equality of Variances | T-Test for Equality of Means"
    // above "F | Sig. | t | df | Sig. (2-tailed)". So find the row that actually
    // names "Sig." and take that column — in the t test the same row also
    // carries the t test's own p, so "the last number" would be the wrong one.
    let header = -1
    let column = -1
    for (let index = 0; index < matrix.length; index += 1) {
      const row = matrix[index]
      if (!Array.isArray(row)) continue
      const found = row.map(assumptionText).findIndex((text) => /^sig\.?$/i.test(text))
      if (found >= 0) { header = index; column = found; break }
    }
    if (header < 0) continue
    // Prefer the "Equal variances assumed" row: the "not assumed" row leaves the
    // Levene columns blank, which would read as a missing significance.
    // A blank cell is not a small p value: Number('') is 0, so reading the
    // text through Number alone would turn "this column is empty" into the
    // strongest warning the plugin can print.
    const readP = (row) => {
      if (!Array.isArray(row)) return Number.NaN
      const text = assumptionText(row[column])
      return text === '' ? Number.NaN : Number(text)
    }
    const rows = matrix.slice(header + 1).filter((row) => Array.isArray(row))
    const labelledRows = rows.filter((row) => assumptionText(row[0]) !== '' && HOMOGENEITY_ROW.test(assumptionText(row[0])))
    // A row whose p is blank must never win over a later row that carries one:
    // SPSS prints "Based on Mean / Based on Median / …" and the first of them is
    // exactly the one PSPP can leave empty. Order the candidates by "has a real
    // number", then by "is the row the reader is told to use".
    const assumed = rows.filter((row) => /Equal variances assumed/i.test(row.map(assumptionText).join(' ')))
    const dataRow = assumed.find((row) => Number.isFinite(readP(row)))
      ?? rows.find((row) => Number.isFinite(readP(row)))
      ?? assumed[0]
      ?? labelledRows[0]
    if (!dataRow) continue
    const p = readP(dataRow)
    // PSPP prints anything below .0005 as ".000"; that underflow is the case
    // that matters most, so it must still count as a warning.
    if (!Number.isFinite(p) || p < 0 || p >= 0.05) continue
    const shown = p === 0 ? 'p < 0.001' : `p = ${p.toFixed(3)}`
    // SPSS prints three Levene variants and its own documentation says to read
    // "Based on Mean". When PSPP only fills a different variant, saying which one
    // the number came from is the difference between a note and a guess.
    const rowLabel = assumptionText(dataRow[0])
    const variant = /基于\s*均值|Based on Mean/i.test(rowLabel) ? '基于均值'
      : /基于\s*中位数|Based on Median/i.test(rowLabel) ? '基于中位数'
        : /截尾|Trimmed/i.test(rowLabel) ? '基于截尾均值'
          : ''
    const qualifier = variant === '' || variant === '基于均值' ? '' : `（${variant}）`
    const ownCaption = String(item.table?.caption ?? item.title ?? '')
    const advice = /Independent Samples/i.test(ownCaption)
      ? '均值比较请读「不假定等方差 / Welch」那一行'
      : 'PSPP 的单因素方差分析没有 Welch 行：可以改用不依赖方差齐性的方法（Welch ANOVA、GLM 对比），或先把变量变换成正态、方差齐的样子'
    pushNote(item, `方差齐性检验${qualifier}的 ${shown}（< 0.05）：各组方差不等，${advice}`)
  }
  return items
}

/**
 * A t test or an ANOVA on data that is not normal gives a p value that looks
 * precise and is not. EXAMINE prints the test; the note says which variable,
 * how far off, and what to do instead.
 */
const NORMALITY_LABEL = /Shapiro-Wilk|Kolmogorov-Smirnov|正态性|常態性/i

export function annotateNormality(items) {
  if (!Array.isArray(items)) return items
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    const matrix = item.table.matrix
    const labelled = matrix.some((row) => Array.isArray(row) && NORMALITY_LABEL.test(row.map(assumptionText).join(' ')))
    if (!labelled) continue
    // Same two-row shape as the Levene table: the group label row, then the row
    // that actually names "Sig.". Take the last such column, which is
    // Shapiro-Wilk's when Kolmogorov-Smirnov is printed next to it.
    let header = -1
    let column = -1
    for (let index = 0; index < matrix.length; index += 1) {
      const row = matrix[index]
      if (!Array.isArray(row)) continue
      const names = row.map(assumptionText)
      for (let cell = 0; cell < names.length; cell += 1) {
        if (/^sig\.?$/i.test(names[cell])) { header = index; column = cell }
      }
    }
    if (header < 0) continue
    const dataRows = matrix.slice(header + 1).filter((row) => Array.isArray(row))
    // EXAMINE … BY group prints one block of rows per group and only the first
    // one repeats the variable name; the rest carry an empty first cell. Naming
    // those "变量" tells the reader nothing about which variable (or which
    // group) the p value belongs to.
    const grouped = dataRows.length > 1
    let lastLabel = ''
    const off = []
    for (const row of dataRows) {
      const cells = row.map(assumptionText)
      if (cells[0] !== '') lastLabel = cells[0]
      const sigText = cells[column]
      // A blank cell is not a p value: Number('') is 0, which would read as a
      // deviation at p < 0.001.
      const value = sigText === '' ? Number.NaN : Number(sigText)
      if (!Number.isFinite(value) || value < 0 || value > 1 || value >= 0.05) continue
      const group = grouped ? cells.slice(1, column).find((text) => text !== '') ?? '' : ''
      off.push({ name: lastLabel || '变量', group, p: value })
    }
    if (off.length === 0) continue
    const which = off
      .map((entry) => {
        const label = entry.group === '' ? entry.name : `${entry.name}（分组 ${entry.group}）`
        return `${label}（${entry.p < 0.001 ? 'p < 0.001' : `p = ${entry.p.toFixed(3)}`}）`
      })
      .join('、')
    pushNote(item, `正态性检验：${which} 偏离正态（p < 0.05）；样本不大时 t 检验/方差分析的 p 值可能不准，可以改用非参数检验，或者先做变量变换`)
  }
  return items
}

/**
 * Ten cases per predictor is the rule of thumb; below it the coefficients move
 * too much from one dataset to the next for a p value to carry much weight.
 */
export function annotateSampleSize(items, dataset, regression) {
  if (!Array.isArray(items) || !regression) return items
  const predictors = Array.isArray(regression.independents) ? regression.independents.length : 0
  const cases = Array.isArray(dataset?.rows) ? dataset.rows.length : 0
  if (predictors < 1 || cases < 1) return items
  if (cases >= 10 * predictors) return items
  const target = items.filter((item) => item.kind === 'table')
    .find((item) => /ANOVA|Model Summary|模型摘要/i.test(String(item.table?.caption ?? item.title ?? '')))
  if (!target) return items
  pushNote(target, `样本量 ${cases} 对 ${predictors} 个预测变量偏少（经验上每个预测变量最好有 10 例以上，这里约 ${(cases / predictors).toFixed(1)}）：系数和 p 值容易随个案增减而变，减少预测变量或补充个案更稳`)
  return items
}

/**
 * 两两比较的假阳性：引擎给的是未校正的 p 值，跑 N 次比较、每次都拿 0.05 当
 * 阈值时，至少撞上一次的几率是 1-0.95^N，六次就到 26%。只说一次，挂在
 * Multiple Comparisons / 事后检验那张表上；已经写了校正方法（Bonferroni 等）
 * 的表不再提醒。
 */
/**
 * A weight variable of all zeros makes PSPP drop every case and print N = 0 —
 * the table looks like the data vanished. The script names the weight, so the
 * dataset can answer whether that is what happened.
 */
/**
 * A data file can carry a weight that the script never mentions: `WEIGHT BY`
 * is written into a .sav by SAVE, and every later GET FILE keeps it. The table
 * then says N = .00 while the panel still holds every case, which looks like
 * lost data. Trigger on that evidence instead of on the script text.
 */
export function annotateZeroCases(items, dataset, script) {
  const cases = dataset?.rows?.length ?? 0
  if (cases === 0) return 0
  // A weight that zeroes every case and a column that is missing everywhere look
  // the same in the table (`N` = 0 on every row) but need opposite advice: one is
  // "run WEIGHT OFF", the other is "check the missing values". Ask the script
  // which story applies instead of always blaming the weight.
  const statements = splitStatements(String(script ?? ''))
  const weighed = statements.some((part) => /^WEIGHT\s+BY\b/i.test(part.trim()))
  // `Case Processing Summary` already prints Included / Excluded / Total, so a
  // second note guessing at weights is noise on top of a table that explains
  // itself. Keep the note for tables that report a statistic.
  // `Report` (MEANS … BY) and `Summary` (CROSSTABS with no cells) are the tables
  // that print `NaN` when a column has nothing to compute from, so they must not
  // be skipped: they are exactly the ones that need the note.
  const SUMMARY_ONLY = /^(case processing summary|model summary)/i
  let added = 0
  for (const item of items) {
    const matrix = item?.table?.matrix
    if (!Array.isArray(matrix) || matrix.length < 2) continue
    const caption = String(item.table?.caption ?? item.title ?? '').trim()
    if (SUMMARY_ONLY.test(caption)) continue
    if (Array.isArray(item.notes) && item.notes.some((note) => /有效个案是 0|加权后/.test(note))) continue
    const header = matrix.find((row) => Array.isArray(row) && row.some((cell) => /^n$/i.test(String(cell ?? '').trim())))
    if (!header) continue
    const column = header.findIndex((cell) => /^n$/i.test(String(cell ?? '').trim()))
    // Only rows that name something: `Missing N (listwise) = 0` and an empty
    // group in `Group Statistics` are normal data, not a weight that removed
    // every case, and counting their zeros made the note appear on ordinary
    // twelve-case data.
    const SUMMARY_LABEL = /^(valid|missing|total|sum)\b/i
    const counts = matrix.slice(matrix.indexOf(header) + 1)
      .filter((row) => Array.isArray(row)
        && String(row[column] ?? '').trim() !== ''
        && String(row[0] ?? '').trim() !== ''
        && !SUMMARY_LABEL.test(String(row[0]).trim()))
      .map((row) => Number(String(row[column]).trim()))
      .filter((value) => Number.isFinite(value))
    if (counts.length === 0 || counts.some((value) => value !== 0)) continue
    const said = weighed
      ? `这张表的有效个案是 0，可内存里这份数据有 ${cases} 例：这段语法里带着 WEIGHT BY，而权重列在每一行上都是 0，PSPP 会把权重为 0 的个案整条排除。先跑一次 WEIGHT OFF 看看`
      : `这张表的有效个案是 0，可内存里这份数据有 ${cases} 例：这次分析用到的列在这 ${cases} 例上全是缺失值（不是权重的问题）。检查这几个变量的缺失值，或者先把缺失值处理掉再跑`
    pushNote(item, said)
    added += 1
    // One note is enough: MEANS and EXAMINE print several tables that are all
    // empty for the same reason, and six identical paragraphs read as six bugs.
    break
  }
  return added
}

export function annotateWeightedEmpty(items, dataset, script) {
  // Read the statement, not the raw text: `* WEIGHT BY w.` in a comment or in a
  // TITLE string is not weighting. The last WEIGHT BY wins, the way the engine
  // treats a second one.
  const statements = splitStatements(String(script ?? ''))
  const weighed = statements.filter((part) => /^WEIGHT\s+BY\b/i.test(part.trim()))
  if (weighed.length === 0) return 0
  const match = /WEIGHT\s+BY\s+([A-Za-z_$#@][A-Za-z0-9_$#@]*)/i.exec(weighed[weighed.length - 1].trim())
  if (!match) return 0
  const name = match[1].toUpperCase()
  const index = (dataset?.variables ?? []).findIndex((variable) => String(variable?.name ?? '').toUpperCase() === name)
  const rows = dataset?.rows ?? []
  if (index < 0 || rows.length === 0) return 0
  const weighted = rows.some((row) => {
    const value = Number(row?.[index])
    return Number.isFinite(value) && value !== 0
  })
  if (weighted) return 0
  // Every table in the run is affected by the same weight; leaving the second
  // one at `N = .00` with no word about why is how people read a number wrong.
  let added = 0
  for (const item of items) {
    if (item.kind !== 'table') continue
    if (Array.isArray(item.notes) && item.notes.some((note) => /加权后有效个案是 0/.test(note))) continue
    pushNote(item, `加权后有效个案是 0：WEIGHT BY 用的是 ${match[1]}，而这一列全是 0，PSPP 会把权重为 0 的个案整条排除。把权重改成 1 以上的值，或者先 WEIGHT OFF 再跑一次`)
    added += 1
  }
  return added
}

export function annotateComparisons(items) {
  if (!Array.isArray(items)) return items
  // PSPP writes the method name in the leftmost column of the first data row,
  // not in the table title: Bonferroni, Tukey and LSD all come out as
  // "Multiple Comparisons (score)". Reading the title alone warned about
  // uncorrected p values on tables the engine had already corrected.
  const ADJUSTED = /Bonferroni|Sidak|Šidák|Holm|Tukey|Scheff|Games|校正|adjust/i
  for (const item of items) {
    if (item.kind !== 'table') continue
    const caption = String(item.table?.caption ?? item.title ?? '')
    if (!/Multiple Comparisons|Post Hoc|事后|多重比较/i.test(caption)) continue
    const matrix = Array.isArray(item.table?.matrix) ? item.table.matrix : []
    const method = matrix.map((row) => (Array.isArray(row) ? String(row[0] ?? '').trim() : '')).find((label) => label !== '') ?? ''
    if (ADJUSTED.test(method) || ADJUSTED.test(caption)) continue
    const headerIndex = matrix.findIndex((row) => Array.isArray(row) && row.some((cell) => /^(sig\.?|p)$/i.test(String(cell ?? '').trim())))
    if (headerIndex < 0) continue
    const column = matrix[headerIndex].findIndex((cell) => /^(sig\.?|p)$/i.test(String(cell ?? '').trim()))
    const rows = matrix.slice(headerIndex + 1)
      .filter((row) => {
        if (!Array.isArray(row)) return false
        const text = String(row[column] ?? '').trim()
        return text !== '' && Number.isFinite(Number(text))
      })
    // Each pair is printed twice (I vs J and J vs I), so the number of rows is
    // not the number of comparisons. The "(I)" column is filled in only on the
    // first row of each pair, which is exactly one row per comparison.
    const firstColumn = matrix[headerIndex].findIndex((cell) => /^\(I\)/i.test(String(cell ?? '').trim()))
    // Without an "(I)" column the fallback counts the rows that carry a p value,
    // which assumes one row per comparison (what PSPP prints). An engine that
    // prints both directions as separate rows would double this number.
    const pairs = firstColumn >= 0
      ? rows.filter((row) => String(row[firstColumn] ?? '').trim() !== '').length
      : rows.length
    const count = pairs > 0 ? pairs : rows.length
    if (count < 2) continue
    const chance = (1 - Math.pow(0.95, count)) * 100
    pushNote(item, `这里做了 ${count} 次两两比较，引擎给的是未校正的 p 值：每次都拿 0.05 当阈值时，至少撞上一次假阳性的概率约 ${chance.toFixed(0)}%（1 − 0.95^${count}）。要下结论请按项数打折扣，或者用 Bonferroni（p × ${count}）看`)
  }
  return items
}

function annotateLayeredCmh(item, dataset) {
  const parsed = layeredCrosstabCounts(item.table?.matrix)
  if (!parsed) {
    pushNote(item, '这张分层交叉表不是每层 2×2（或者有层缺格），Cochran–Mantel–Haenszel 检验要每层都是 2×2 才有意义，所以没有算')
    return
  }
  const result = mantelHaenszel(parsed.strata.map((stratum) => stratum.matrix))
  pushNote(item, describeMantelHaenszel(result))
  if (parsed.strata.length > 1) pushNote(item, describeHomogeneity(breslowDay(parsed.strata.map((stratum) => stratum.matrix))))
  // 层名与行名只有数据集里有；表头只打标签，所以尽量反查成人能读的样子。
  const layerVariable = dataset ? crosstabVariable(dataset, parsed.layerName) : null
  const layerLabel = layerVariable ? (String(layerVariable.label ?? '').trim() || layerVariable.name) : null
  if (layerLabel) pushNote(item, `分层变量：${layerLabel}（共 ${parsed.strata.length} 层：${parsed.strata.map((stratum) => stratum.label).join('、')}）`)
}

function isLayeredCrosstab(item) {
  const caption = String(item.table?.caption ?? item.title ?? '')
  if ((caption.match(/×/g) ?? []).length < 2) return false
  const matrix = item.table?.matrix ?? []
  return matrix.some((row) => (row ?? []).some((cell) => /^(count|计数)$/i.test(String(cell ?? '').trim())))
}

/**
 * 只请求了 PHI / 什么都没请求时没有 Chi-Square Tests 表，也就没有 Fisher 行可指 ——
 * 但小样本这件事本身还是要说，否则用户会把一个 2×2 的卡方当真。
 */
function applyMissingChiSquareHint(pair) {
  const { rows, columns, smallCells, minExpected } = pair.counts
  if (rows !== 2 || columns !== 2 || smallCells === 0) return
  pushNote(pair.item, `2×2 表里有 ${smallCells} 个单元格的期望频数 < 5（最小 ${Number.isFinite(minExpected) ? minExpected.toFixed(2) : '—'}），样本小；这次没有请求卡方（CHISQ），所以同一次运行里没有 Fisher's Exact Test 行可看。要小样本的结论，重跑时在统计量里勾上卡方`)
}

function pushNote(item, text) {
  item.notes = [...(item.notes ?? []), text]
}

/** 计数可能带权（WEIGHT 之后不再是整数），整数就照原样打，否则留两位。 */
function formatCount(value) {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function isSymmetricMeasures(item) {
  // 标题可能是英文也可能被翻译（Symmetric Measures / 对称度量），而「有没有 Kappa 行」
  // 只能看内容：方表会多一行 Kappa，非方表这张表里只剩有效个案数。
  if (/^(symmetric measures|对称度量)/i.test(String(item.table?.caption ?? item.title ?? '').trim())) return true
  const matrix = item.table?.matrix ?? []
  return matrix.some((row) => (row ?? []).some((cell) => /^kappa$/i.test(String(cell ?? '').trim())))
}

/**
 * 认出引擎的 Chi-Square Tests 表。
 *
 * 不能靠「有没有 Pearson 行」来认：χ² 恰好为 0 时 PSPP 不打那一行，而这正是 2×2
 * 小样本最常出现、最需要提示「去看 Fisher」的情形。表头里那两列（值 + 渐近/确切
 * 显著度）在两种语言下都稳定，用它认表。
 */
function isChiSquareTable(item) {
  const caption = String(item.table?.caption ?? item.title ?? '').trim()
  if (/^(chi-square tests|卡方检验|卡方测试)/i.test(caption)) return true
  const matrix = item.table?.matrix ?? []
  const hasValueColumn = matrix.slice(0, 3)
    .some((row) => (row ?? []).some((cell) => /^(value|值)$/i.test(String(cell ?? '').trim())))
  const hasSignificanceColumn = matrix.slice(0, 3)
    .some((row) => (row ?? []).some((cell) => /asymptotic sig|exact sig|渐近显著|确切显著度/i.test(String(cell ?? '').trim())))
  return hasValueColumn && hasSignificanceColumn
}

/** 引擎省掉 Pearson 行时的补算：用同一张交叉表的计数（已含 WEIGHT）。 */
function chiSquareFromCounts(counts, matrix) {
  const test = pearsonChiSquare(counts.counts)
  if (!test) return null
  const hasFisher = matrix.some((row) => (row ?? []).some((cell) => /fisher|精确检验|确切概率/i.test(String(cell ?? '').trim())))
  // 全表计数为 0 之类的退化情形没有 χ²，交给调用方按「没有 χ²」处理。
  return { chiSquare: test.statistic, df: test.df, total: test.total, hasFisher, source: 'counts' }
}

function applyCramersV(pair) {
  const { counts, chi: entry } = pair
  const { rows, columns, total, smallCells, minExpected } = counts
  const chiItem = entry.item
  const chi = entry.value
  const smallest = Math.min(rows, columns) - 1
  // 小样本提示先写：2×2 里用户最需要看到的是「去看 Fisher」，而不是效应量。
  if (smallCells > 0) {
    const expected = `最小 ${Number.isFinite(minExpected) ? minExpected.toFixed(2) : '—'}`
    pushNote(chiItem, rows === 2 && columns === 2
      ? `2×2 表里有 ${smallCells} 个单元格的期望频数 < 5（${expected}），样本小，看同表的 Fisher's Exact Test 行（Exact Sig.）—— 它不依赖大样本近似，这里的 Pearson 卡方与连续性校正只作参考`
      : `有 ${smallCells} 个单元格的期望频数 < 5（${expected}），卡方近似不可靠；PSPP 只在 2×2 给 Fisher，${rows}×${columns} 的表要精确结果就在统计量里勾「精确检验（插件按边际枚举）」，或者合并类别、增加样本量`)
  }
  if (rows === 2 && columns === 2 && !chi?.hasFisher) {
    pushNote(chiItem, '同表没有 Fisher 行：重跑时把统计量里的卡方（CHISQ）勾上，2×2 时 PSPP 会自动多打一行 Fisher\'s Exact Test')
  }
  if (!chi || smallest < 1) return
  // 行列数必须能解释这张表的 df，对不上就说明数错了（层变量、合并类别都会这样）。
  const expectedDf = (rows - 1) * (columns - 1)
  if (chi.df !== null && chi.df !== expectedDf) {
    pushNote(chiItem, `交叉表数出来是 ${rows}×${columns}（df 应为 ${expectedDf}），但同表卡方的 df 是 ${chi.df}；行列数没把握，没有写 Cramér's V`)
    return
  }
  if (Math.abs(total - chi.total) > 1e-6 * Math.max(1, Math.abs(chi.total))) {
    pushNote(chiItem, `交叉表的计数合计是 ${formatCount(total)}，同表卡方的有效个案 N 是 ${formatCount(chi.total)}；两者对不上，没有写 Cramér's V`)
    return
  }
  const v = cramersVFromChiSquare(chi.chiSquare, chi.total, rows, columns)
  if (v === null) return
  const formula = `V = sqrt(χ² / (N·(min(r,c)−1))) = sqrt(${chi.chiSquare.toFixed(3)} / (${formatCount(chi.total)}·${smallest}))，r = ${rows}、c = ${columns}`
  const phiNote = rows === 2 && columns === 2
    ? '；2×2 时 min(r,c)−1 = 1，V 就等于 φ（= sqrt(χ²/N)），两个名字是同一件事'
    : ''
  // 引擎自己（PHI 请求）就会在 Symmetric Measures 里打 Cramer's V，那种情况不再重复一行，
  // 只顺手核对两个来源是否一致 —— 不一致才是需要人看一眼的信号。
  const engineV = pair.sym ? engineCramersV(pair.sym.matrix, smallest === 1) : null
  if (engineV !== null) {
    const agree = Math.abs(engineV - v) <= 0.005
    pushNote(chiItem, agree
      ? `Cramér's V = ${v.toFixed(3)}：引擎已在下面的 Symmetric Measures 表里给出同一个数（${formula}），这里不再重复追加一行${phiNote}`
      : `Cramér's V 两个来源不一致：引擎的 Symmetric Measures 写 ${engineV.toFixed(3)}，按本表 χ²、N 与行列数重算得 ${v.toFixed(3)}（${formula}）；以引擎值为准，并核对 WEIGHT / FILTER 设置${phiNote}`)
    return
  }
  const matrix = chiItem.table.matrix
  const valueColumn = matrix.slice(0, 3)
    .map((row) => (row ?? []).findIndex((cell) => /^(value|值)$/i.test(String(cell ?? '').trim())))
    .find((index) => index >= 0)
  if (valueColumn === undefined) return
  const row = Array.from({ length: matrix[0].length }, () => '')
  row[0] = "Cramér's V"
  row[valueColumn] = v.toFixed(2)
  matrix.push(row)
  const source = chi.source === 'counts'
    ? '；χ² 由本插件按同一张交叉表的计数补算（Pearson χ² 恰好为 0 时 PSPP 会把那一行整个省掉）'
    : ''
  pushNote(chiItem, `Cramér's V = ${v.toFixed(3)}（表里那一行是本插件追加的，不是引擎输出）：${formula}，N 取自这张表${source}${phiNote}`)
}

/**
 * 引擎在 Symmetric Measures 里给的 Cramer's V；min(r,c) = 2 时 φ 与它同值，
 * 所以在那种形状下把 Phi 也认作 Cramer's V（表里只请求了 PHI 时会出现这种表）。
 */
function engineCramersV(matrix, phiEqualsV) {
  for (const row of matrix) {
    const cells = (row ?? []).map((cell) => String(cell ?? '').trim())
    const cramer = cells.findIndex((cell) => /^cramer'?s v$/i.test(cell))
    // A blank cell is not a zero association: Number('') is 0, which would
    // report V = 0 when the engine simply did not print the number.
    const readCell = (row, index) => {
      const text = String(row[index] ?? '').trim()
      return text === '' ? Number.NaN : Number(text)
    }
    if (cramer >= 0) {
      const value = readCell(cells, cramer + 1)
      if (Number.isFinite(value)) return value
    }
    if (!phiEqualsV) continue
    const phi = cells.findIndex((cell) => /^(phi|φ)$/i.test(cell))
    if (phi >= 0) {
      const value = readCell(cells, phi + 1)
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

function applyKappa(counts, symItem, matrix) {
  const shape = `${counts.rows}×${counts.columns}`
  const square = counts.rows === counts.columns
  const kappaRow = matrix.find((row) => (row ?? []).some((cell) => /^kappa$/i.test(String(cell ?? '').trim())))
  if (!kappaRow) {
    pushNote(symItem, square
      ? `这张表里没有 Kappa 值：本表是 ${shape}，形状上算得了 Kappa，只是这次没请求 —— 在统计量里加上 KAPPA（statistics.kappa = true）就会有。Kappa 只对 2×2（Cohen's κ）或行、列类别完全相同的方表有意义`
      : `这张表里没有 Kappa 值：Kappa 只对 2×2 或行、列类别完全相同的方表有意义，本次数出来是 ${shape}（行、列类别不同），PSPP 因此只给了有效个案数。要报一致性就让行、列来自同一组类别，并在统计量里要 KAPPA（statistics.kappa = true）`)
    return
  }
  const labelIndex = kappaRow.findIndex((cell) => /^kappa$/i.test(String(cell ?? '').trim()))
  const kappaText = String(kappaRow[labelIndex + 1] ?? '').trim()
  const value = kappaText === '' ? Number.NaN : Number(kappaText)
  pushNote(symItem, `Kappa = ${Number.isFinite(value) ? value.toFixed(3) : '—'}：只对 2×2（Cohen's κ）或行、列类别完全相同的方表有意义，非方表即使引擎打了数字也解释不了；本表数出来是 ${shape}。经验分档（Landis & Koch）：<0.20 差、0.21–0.40 一般、0.41–0.60 中等、0.61–0.80 好、0.81–1.00 很好`)
}

/**
 * RELIABILITY 的输出后面追加一张插件自己算的 ICC 表。
 *
 * PSPP 2.1.3 的 RELIABILITY 不接受 /ICC=（实测报语法错误），所以 ICC 只能在这里
 * 算；评分者名单从语法里读回来，而不是让调用方再传一遍 —— 面板、agent 工具和语法
 * 编辑器三条路最终都走 runSyntax，只有语法是它们共同知道的东西。
 */
/* 会改数据（或换数据）的命令：这类语法里的 RELIABILITY 用的是改过之后的数据，
 * 而插件手上还是当前数据集，算出来的 ICC 一定和引擎那张信度表对不上。 */
const DATA_CHANGING = /\b(COMPUTE|RECODE|AUTORECODE|RANK|SORT\s+CASES|SELECT\s+IF|AGGREGATE|DO\s+IF|WEIGHT\s+BY|FILTER\s+BY|SAVE\s+OUTFILE|GET\s+(?:FILE|DATA))\b/i

/**
 * A short fingerprint of the data a table was computed from.
 *
 * Names and case counts are not enough: two runs of the same 60-case file with
 * one edited cell would look identical. FNV-1a over the variable sheet plus a
 * spread sample of cells is cheap even on 200k rows and catches any edit that
 * changes a value the sample touches (the whole row set is sampled at the
 * edges, where edits usually happen).
 */
export function dataDigest(dataset) {
  if (!dataset) return null
  let hash = 0x811c9dc5
  const mix = (text) => {
    const value = String(text ?? '')
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  const variables = dataset.variables ?? []
  for (const variable of variables) {
    mix(variable.name)
    mix(variable.type)
    mix(variable.label)
    mix(JSON.stringify(variable.valueLabels ?? {}))
    mix(variable.decimals)
  }
  const rows = dataset.rows ?? []
  mix(rows.length)
  const edge = Math.min(20, rows.length)
  for (let index = 0; index < edge; index += 1) mix(JSON.stringify(rows[index]))
  for (let index = Math.max(0, rows.length - edge); index < rows.length; index += 1) mix(JSON.stringify(rows[index]))
  return hash.toString(16).padStart(8, '0')
}

export function annotateReliabilityIcc(items, dataset, syntax, runId = null) {
  if (!dataset) return items
  const names = reliabilityVariables(syntax)
  if (names.length < 2) return items
  // 信度表都没打出来（语法写错、命令被跳过）就不加 ICC：一张孤零零的 ICC 挂在
  // 一次失败的运行下面，读者会以为信度确实算过了。
  const reliability = items.find((item) => item.kind === 'table' && (/reliability statistics|信度统计量/i.test(String(item.table?.caption ?? item.title ?? ''))))
  if (!reliability) return items
  if (DATA_CHANGING.test(String(syntax ?? ''))) {
    pushNote(reliability, '没有计算 ICC：这段语法里有会改数据或换数据的命令，引擎用的是改过之后的数据，插件手上还是当前数据集。把 RELIABILITY 单独跑一次（不带那些命令）就能拿到 ICC')
    return items
  }
  const built = iccTable(dataset, names)
  if (built.matrix.length === 0) {
    pushNote(reliability, `没有计算 ICC：${built.notes.at(-1)}`)
    return items
  }
  const engineCases = engineCaseCount(items)
  if (engineCases !== null && engineCases !== built.cases) {
    // 引擎和我们对「用哪些个案」的答案不同（比如语法里的 MISSING 设置），ICC 就不是同一批数据。
    pushNote(reliability, `ICC 没有计算：引擎的有效个案是 ${engineCases} 例，本插件从当前数据集重算得到 ${built.cases} 例。把 RELIABILITY 单独跑一次、并确认两个数字一致后再看 ICC`)
    return items
  }
  const index = items.length
  items.push({
    kind: 'table',
    title: built.title,
    table: { caption: built.title, matrix: built.matrix, notes: built.notes },
    notes: built.notes,
    name: null,
    id: `run-${runId ?? 'now'}-${index}`,
    runId,
    script: '',
    artifactUrl: null,
    at: Date.now(),
  })
  return items
}

/** 从 RELIABILITY 语法里读回变量表；读不到就返回空，调用方保持原样。 */
function reliabilityVariables(syntax) {
  const command = /RELIABILITY\b([\s\S]*?)\./i.exec(String(syntax ?? ''))
  if (!command) return []
  // 变量表在后面任一条子命令（/SCALE、/MODEL …）处结束，所以遇到斜杠就停。
  const list = /\/VARIABLES\s*=\s*([^/\n]+)/i.exec(command[1])
  if (!list) return []
  return list[1]
    .split(/\s+/)
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_$@#?][\w$@#.]*$/.test(name))
}

/** 引擎的「个案处理总结」里那个有效个案数，用来核对 ICC 算的是不是同一批数据。 */
function engineCaseCount(items) {
  for (const item of items) {
    if (item.kind !== 'table' || !Array.isArray(item.table?.matrix)) continue
    if (!/case processing summary|个案处理总结|个案处理摘要|个案摘要/i.test(String((item.table.caption ?? item.title) ?? ''))) continue
    for (const row of item.table.matrix) {
      if (!Array.isArray(row)) continue
      if (!/^(valid|有效)$/i.test(String(row[0] ?? '').trim())) continue
      const countText = String(row[1] ?? '').trim()
      if (countText === '') continue
      const count = Number(countText)
      if (Number.isFinite(count)) return count
    }
  }
  return null
}

function worstStderrLine(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return (
    lines.find((line) => /error:|错误[:：]/.test(line))
    ?? lines.find((line) => !/^note:|^提示[:：]/i.test(line))
    ?? lines[0]
    ?? '引擎没有给出原因'
  )
}

// SPLIT FILE / WEIGHT / FILTER / SELECT IF carry meaning across runs even though
// every run is a new process. Group 1 is the variable list; OFF clears it.
/**
 * Copy a variable record under a new name.
 *
 * Restructuring keeps formats, value labels and missing codes with the data
 * they describe; only the name and the position change.
 */
function cloneVariable(variable, name) {
  return {
    ...variable,
    name,
    label: variable.label ?? '',
    valueLabels: { ...(variable.valueLabels ?? {}) },
    missing: Array.isArray(variable.missing) ? [...variable.missing] : [],
  }
}

/**
 * Make `base` a usable PSPP variable name that no one in `taken` has yet.
 *
 * Generated names come from data (`score_1`, `score_男`) plus a numeric
 * suffix when they collide, so they have to survive the same rules the
 * variable editor enforces: no leading digit, no punctuation, 64 chars.
 */
function reserve(taken, base) {
  const clean = String(base ?? '').replaceAll(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_').slice(0, 56) || 'V'
  const lead = /^[0-9]/.test(clean) ? `V_${clean}` : clean
  let name = lead
  let suffix = 2
  while (taken.has(name.toLowerCase())) {
    name = `${lead}_${suffix}`
    suffix += 1
  }
  taken.add(name.toLowerCase())
  return name
}

/**
 * Turn one incoming case (object keyed by variable name, or positional array)
 * into a row aligned with `variables`.
 */
function coerceRow(entry, variables) {
  const keyed = Array.isArray(entry)
    ? Object.fromEntries(variables.map((variable, index) => [variable.name, entry[index]]))
    : (entry ?? {})
  return variables.map((variable) => {
    const raw = keyed[variable.name]
    if (raw === undefined || raw === null || raw === '') return null
    if (variable.type === 'numeric') {
      const numeric = Number(raw)
      return Number.isFinite(numeric) ? numeric : null
    }
    return String(raw)
  })
}

const SESSION_DIRECTIVES = {
  split: /^\s*SPLIT\s+FILE\s+(?:BY\s+([^.\n]+?)\s*|OFF\s*)\./im,
  weight: /^\s*WEIGHT\s+(?:BY\s+([^.\n]+?)\s*|OFF\s*)\./im,
  filter: /^\s*FILTER\s+(?:BY\s+([^.\n]+?)\s*|OFF\s*)\./im,
  select: /^\s*SELECT\s+IF\s*\(.*?\)\s*\./ims,
}

const SYSTEM_FILE_EXTENSIONS = new Set(['.sav', '.por', '.sys'])
const UPLOAD_EXTENSIONS = new Set(['.sav', '.por', '.sys', '.csv', '.txt', '.tsv', '.xlsx', '.ods', '.dta', '.sps'])

/**
 * One short hash standing for every variable property the panel draws.
 *
 * The polling signature has to notice a label, a format or a missing-value
 * change without shipping the dictionary itself, so the dictionary is boiled
 * down to 8 hex digits here. FNV-1a: no dependency, and a collision would only
 * mean the panel misses one redraw until the next real change.
 */
function variableDigest(variables) {
  let hash = 0x811c9dc5
  for (const variable of variables) {
    const text = [
      variable.name,
      variable.label ?? '',
      variable.alignment ?? '',
      variable.format ?? '',
      variable.type ?? '',
      variable.measure ?? '',
      variable.width ?? '',
      variable.decimals ?? '',
      JSON.stringify(variable.missing ?? null),
      ...Object.entries(variable.valueLabels ?? {}).flat().map(String),
    ].join('|')
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16)
}
const UPLOAD_PREFIX = /^\d{10,}-/
// Two drops in the same millisecond still need two files.
let uploadSeq = 0

/** Drop the storage prefix that saveUpload() adds; other files are untouched. */
function displayName(path) {
  const base = basename(path)
  return /[\\/]uploads[\\/]/.test(path) ? base.replace(UPLOAD_PREFIX, '') : base
}

class Mutex {
  constructor() {
    this.tail = Promise.resolve()
    this.pending = 0
  }

  /** True while a queued or running task holds the workspace. */
  get busy() {
    return this.pending > 0
  }

  run(task) {
    this.pending += 1
    const settle = () => { this.pending -= 1 }
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined).then(settle, settle)
    return next
  }
}

/**
 * One session's statistics workbench: the owned dataset, the engine runs,
 * the output tree, and the agent-facing operations. Every mutation and run
 * is serialized because PSPP writes a single working system file.
 */
/**
 * Excel pads worksheets with blank cells and blank trailing rows; drop those so
 * the table has real columns and cases.
 */
function trimSheet(rows) {
  const kept = rows.filter((row) => Array.isArray(row) && row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''))
  if (kept.length === 0) throw new Error('这个工作表是空的')
  const width = Math.max(...kept.map((row) => row.length))
  return kept.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? null))
}

// Text the panel is allowed to write on the user's behalf. The list is an
// allow-list on purpose: these writes come from the browser half, and a
// same-origin page could otherwise overwrite ~/.bashrc or a profile patch.
const TEXT_WRITE_EXTENSIONS = new Set(['.sps', '.txt', '.csv', '.tsv', '.html', '.htm', '.md', '.json', '.labels', '.log'])

/** Refuse a text write whose target is not a document this plugin owns. */
export function assertTextTarget(target) {
  const name = basename(target)
  if (name === '' || name.startsWith('.')) {
    throw new Error(`不能写到 ${target}：这类隐藏文件（以点开头）不由本插件负责，换个文件名`)
  }
  const ext = extname(target).toLowerCase()
  if (!TEXT_WRITE_EXTENSIONS.has(ext)) {
    throw new Error(`不能写到 ${target}：只能写 ${[...TEXT_WRITE_EXTENSIONS].join(' ')} 这类文本文件（.sav 请用「保存数据」，.docx/.xlsx/.pdf 请用导出）`)
  }
}

export class Workspace {
  constructor(options = {}) {
    this.id = String(options.id ?? 'default')
    this.engine = options.engine
    this.root = options.root
    this.config = options.config ?? {}
    // Settings are re-read through this store so a knob changed in the panel
    // reaches the session that is already open (see liveConfig()).
    this.settingsStore = options.settingsStore ?? null
    this.cwd = options.cwd ?? process.cwd()
    this.dir = join(this.root, this.id)
    // The engine cannot open non-ASCII paths on Windows (see lib/stage.js), and
    // the run directory is itself a path it has to open. When the profile lives
    // under a Chinese user name, keep the runs in an ASCII location instead.
    if (!isPlainPath(this.dir)) {
      const fallback = [process.env.ProgramData, process.env.PUBLIC, process.env.SystemDrive && join(process.env.SystemDrive, 'ProgramData')]
        .filter((base) => base && isPlainPath(base))
        .find(Boolean)
      if (fallback) {
        this.preferredDir = this.dir
        this.dir = join(fallback, 'dsh-analytics', this.id)
      }
    }
    this.ioDir = join(this.dir, 'io')
    this.mutex = new Mutex()
    // >0 while the engine owns the data (a run or a file load has the rows in
    // flight); edits are refused instead of being silently overwritten.
    this.busyDepth = 0
    this.seq = 0
    // runId is a counter that starts at 1 in every workspace, and the panel
    // session and the tool session are different workspaces: both used to write
    // runs/1, runs/2 and could overwrite each other's chart.svg or output html.
    // The directory name gets a suffix from the id; runId stays the number.
    let hash = 0x811c9dc5
    for (let index = 0; index < this.id.length; index += 1) {
      hash ^= this.id.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    this.runSuffix = hash.toString(16).padStart(8, '0').slice(0, 6)
    // Requests currently inside the engine. evictIdle() may not release a
    // workspace while any of them is in flight, even if it looks idle.
    this.inflight = 0
    this.items = []
    // Items written by one action share a batch: "export the last output" has
    // to find the pairwise table and table 1 as well, and those never came from
    // an engine run (runId is null for them).
    this.batch = 0
    this.log = []
    // Multiple response sets: kept here because PSPP will not tabulate them
    // (see lib/mrsets.js); `mrRead` names the one the panel is showing.
    this.mrSets = []
    this.mrRead = null
    // SPLIT FILE / WEIGHT / FILTER are session settings: every run is a fresh
    // pspp process, so the workspace remembers them and re-issues them in front
    // of later runs. SELECT IF is destructive (cases are gone after the run), so
    // it is only described in the status bar, never replayed.
    this.splitBy = []
    this.weightBy = null
    this.filterBy = null
    this.selectIf = null
    this.dataset = null
    this.lastError = null
    this.createdAt = Date.now()
    // Who changed the data last, and how many times.
    //
    // Two panels can show the same workspace (the left column's launcher and a
    // Session's tab both name the same docId), and each keeps its own rows and
    // undo stack. Without this the second window silently overwrites the first
    // and the first one never learns its grid is stale: a wrong number nobody
    // notices. The counter travels in state(); the panel compares the writer
    // with its own id and says so instead of pretending to be current.
    this.revision = 0
    this.lastWriter = null
    // Set by the HTTP layer for the duration of one request; tool calls leave it
    // unset, so a write from the agent keeps the previous panel's name out of it.
    this.currentWriter = null
    // Undo stack: one entry per data change. Cell edits store the two values,
    // structural edits store a snapshot, and a cell budget keeps the memory
    // cost bounded on a large dataset.
    this.undoStack = []
    this.redoStack = []
    this.historyLimit = Number(this.config.historyLimit) > 0 ? Number(this.config.historyLimit) : 30
    this.historyCells = Number(this.config.historyCells) > 0 ? Number(this.config.historyCells) : 12000000
    // Snapshot count alone says nothing about memory: 30 snapshots of a
    // half-million-cell dataset is already ~1 GB of arrays. Keep a budget over
    // the whole stack and drop the oldest step when it is exceeded.
    this.historyBudgetCells = Number(this.config.historyBudgetCells) > 0 ? Number(this.config.historyBudgetCells) : 4000000
    this.historyDropped = 0
  }

  /**
   * Deployment config plus the settings file as it is right now.
   *
   * The panel promises "立即生效" for the display knobs, so these cannot be
   * baked in when the workspace is created: `settingsStore.current()` re-reads
   * the file (cached for a second) on every use.
   */
  liveConfig() {
    if (!this.settingsStore) return this.config
    try {
      return { ...this.config, ...this.settingsStore.current() }
    } catch {
      return this.config
    }
  }

  get timeoutMs() {
    const value = Number(this.liveConfig().timeoutMs)
    return value > 0 ? value : 120000
  }

  get maxRows() {
    const value = Number(this.liveConfig().maxRows)
    return value > 0 ? value : 200000
  }

  /**
   * Refuse an edit while the engine owns the data.
   *
   * A persist run ends by replacing every row from work.sav, and opening a file
   * replaces the whole dataset. An edit that slipped in during either used to
   * return 200 and then vanish; saying so is better than losing it silently.
   */
  assertEditable() {
    if (this.busyDepth > 0) {
      throw new Error('正在运行分析或载入数据，现在不能改：等这次运行结束再编辑（输出视图里能看到进度）')
    }
  }

  async init() {
    // A released dataset has to come back even though the one-time bootstrap
    // promise has already settled, so hydration is checked before it.
    if (this.dataset?.evicted === true) return this.hydrate()
    // Every request goes through here. Two requests that arrive together each
    // used to start a restore, and whichever finished last won; sharing one
    // promise also keeps a half-restored dataset out of everyone's sight.
    if (!this.initPromise) {
      // A rejected bootstrap used to stay cached and poison every later request.
      this.initPromise = this.bootstrap().catch((error) => {
        this.initPromise = null
        throw error
      })
    }
    return this.initPromise
  }

  async bootstrap() {
    await mkdir(join(this.dir, 'runs'), { recursive: true })
    await mkdir(join(this.dir, 'tmp'), { recursive: true })
    // A restarted host finds work.sav on disk; loading it means a restored
    // panel shows the data the user had instead of re-opening the seed file
    // (which for a dropped file is a copy, not the file the user edited).
    if (!this.dataset) await this.restore()
    else if (this.dataset.evicted === true) await this.hydrate()
  }

  /**
   * Bring back the rows of a workspace whose data was released to keep memory
   * down. Variables, labels, value labels and multiple-response sets survive
   * eviction in memory; only the case rows are re-read from work.sav.
   */
  async hydrate() {
    if (!this.dataset || this.dataset.evicted !== true) return this.dataset
    // Two requests can hit a released workspace together; one read is enough.
    if (!this.hydratePromise) {
      this.hydratePromise = (async () => {
        this.dataset.evicted = false
        try {
          await this.reloadFromWork()
        } catch (error) {
          this.dataset.evicted = true
          throw new Error(`回收后的数据集没能从工作文件读回来：${error.message}`)
        }
        return this.dataset
      })().finally(() => { this.hydratePromise = null })
    }
    return this.hydratePromise
  }

  /** Reload the dataset left in this workspace by an earlier host process. */
  async restore() {
    const workPath = join(this.dir, 'work.sav')
    if (!existsSync(workPath)) return null
    let meta = {}
    try {
      meta = JSON.parse(await readFile(join(this.dir, 'dataset.json'), 'utf8'))
    } catch {
      meta = {}
    }
    // A workspace bound to a real data file comes back, and so does a built one
    // (origin 'new'): its rows live in work.sav and dropping them on restart
    // loses work the user never asked to lose. A dropped file is a copy whose
    // path the browser never gave us — restoring it would open a file the user
    // did not ask for, so such a workspace starts empty and the copy stays on
    // disk for 打开数据… to pick up.
    const built = meta.origin === 'new' && meta.sourcePath == null
    if (meta.temporary === true) return null
    if (typeof meta.sourcePath !== 'string' && !built) return null
    // The shell stays a local object until the rows are in: assigning it to
    // this.dataset first let concurrent requests read a dataset with no rows
    // and write "Cannot read properties of undefined" all over the panel.
    const shell = {
      sourcePath: typeof meta.sourcePath === 'string' ? meta.sourcePath : null,
      temporary: meta.temporary === true,
      name: typeof meta.name === 'string' ? meta.name : null,
      // The stamp on every table says when the file was read. Restoring without
      // it printed openedAt: null, i.e. a table that could name its file but not
      // when it came from it.
      openedAt: typeof meta.openedAt === 'number' ? meta.openedAt : null,
      origin: typeof meta.origin === 'string' ? meta.origin : undefined,
      sourceSize: typeof meta.sourceSize === 'number' ? meta.sourceSize : null,
      sourceMtime: typeof meta.sourceMtime === 'number' ? meta.sourceMtime : null,
      // A built dataset has no file to be in sync with, so it is always unsaved.
      dirty: built ? true : meta.dirty === true,
    }
    if (Array.isArray(meta.conflicts)) this.conflicts = meta.conflicts.slice(-50)
    try {
      // flush: false — workSav() would throw "no dataset is open" for a shell
      // and the catch below would turn every restored session into an empty
      // panel (the rows are already in work.sav on disk).
      await this.reloadFromWork(shell, { flush: false })
    } catch {
      this.dataset = null
      return null
    }
    // Write the sidecar for workspaces created before it existed.
    await this.rememberDataset()
    return this.dataset
  }

  /** Remember which file this workspace belongs to (restore() reads it back). */
  /**
   * What a launcher row needs, whether the rows are in memory or released.
   *
   * Returning null means "nothing worth offering": no data, a dropped copy the
   * user cannot recognise, or a workspace whose saved rows are gone.
   */
  async summary() {
    const live = this.dataset
    // An evicted dataset keeps a shell with no rows: its `rows.length` is 0 and
    // its `name` is stale, so it has to be described from the sidecar instead.
    if (live && live.evicted !== true) {
      return {
        name: live.name ?? (live.sourcePath ? displayName(live.sourcePath) : null),
        caseCount: live.rows?.length ?? 0,
        sourcePath: live.temporary === true ? null : live.sourcePath ?? null,
        dirty: live.dirty === true,
        released: false,
      }
    }
    let meta = {}
    try {
      meta = JSON.parse(await readFile(join(this.dir, 'dataset.json'), 'utf8'))
    } catch {
      return null
    }
    if (meta.temporary === true) return null
    const built = meta.origin === 'new' && meta.sourcePath == null
    if (typeof meta.sourcePath !== 'string' && !built) return null
    if (!existsSync(join(this.dir, 'work.sav'))) return null
    return {
      name: meta.name ?? (typeof meta.sourcePath === 'string' ? displayName(meta.sourcePath) : null),
      caseCount: Number(meta.caseCount ?? 0) || 0,
      sourcePath: typeof meta.sourcePath === 'string' ? meta.sourcePath : null,
      dirty: meta.dirty === true,
      released: true,
    }
  }

  async rememberDataset({ bumpRevision = true } = {}) {
    // Opening or saving replaces what another panel may be showing, so this is
    // a write for the same reason an edit is. Recording a refused write is not:
    // it changes the trail, not the data, and a conflict that bumped the
    // revision would invalidate the very retry the caller is about to send.
    if (this.dataset && bumpRevision) this.noteWrite()
    const file = join(this.dir, 'dataset.json')
    if (!this.dataset) {
      await rm(file, { force: true }).catch(() => {})
      return
    }
    const payload = JSON.stringify({
      sourcePath: this.dataset.sourcePath ?? null,
      temporary: this.dataset.temporary === true,
      name: this.dataset.name ?? null,
      openedAt: typeof this.dataset.openedAt === 'number' ? this.dataset.openedAt : null,
      origin: this.dataset.origin ?? null,
      sourceSize: typeof this.dataset.sourceSize === 'number' ? this.dataset.sourceSize : null,
      sourceMtime: typeof this.dataset.sourceMtime === 'number' ? this.dataset.sourceMtime : null,
      // The launcher lists a dataset it may never load: without this, a released
      // workspace shows up with 0 cases and looks empty.
      caseCount: this.dataset.rows?.length ?? 0,
      // Whether the panel holds unsaved edits is part of "where did this table
      // come from": a restored workspace that silently claims to be clean makes
      // the reader believe the file on disk is what produced the numbers.
      dirty: this.dataset.dirty === true,
      // Refused writes leave a trail: after the fact, "who changed what while I
      // was typing" is the question a user asks, and a toast that has already
      // faded cannot answer it.
      conflicts: (this.conflicts ?? []).slice(-50),
    })
    // Written atomically: another panel, the launcher or a restart can read this
    // file while it is being replaced, and a half-written one is not just
    // unparseable — restore() would then forget which data the numbers came from.
    const staging = `${file}.tmp`
    await writeFile(staging, payload).then(() => rename(staging, file)).catch(() => {})
  }

  /**
   * Resolve a user-supplied path and check it is somewhere we may touch.
   *
   * Every read and write in this class goes through here, so this is the one
   * place that has to be right: the panel is reachable over HTTP, which makes
   * "the user typed it" too weak a guarantee (see lib/paths.js).
   */
  resolvePath(input) {
    if (typeof input !== 'string' || input.trim() === '') throw new Error('a file path is required')
    const live = this.liveConfig()
    return checkPath(input, {
      cwd: this.cwd,
      allowedDirs: live.allowedDirs,
      roots: rootsFrom(live.allowedDirs, { cwd: this.cwd }),
    })
  }

  /** The directory name for one run: the number plus this workspace's suffix. */
  runDirName(runId) {
    return `${runId}-${this.runSuffix}`
  }

  /**
   * Where one run's files live.
   *
   * Falls back to the old unprefixed directory so runs written by an earlier
   * version still resolve (artifacts are linked by runId, not by path).
   */
  runDir(runId) {
    const primary = join(this.dir, 'runs', this.runDirName(runId))
    if (existsSync(primary)) return primary
    const legacy = join(this.dir, 'runs', String(runId))
    return existsSync(legacy) ? legacy : primary
  }

  /**
   * Mark a unit of work as in flight.
   *
   * `release()` already refuses while the engine owns the data (busyDepth) or
   * the mutex is held, but reading an artifact happens after the run has
   * finished: without this count, eviction could release — or forget — a
   * workspace while a chart file is being read from it.
   */
  track(work) {
    this.inflight += 1
    return Promise.resolve().then(work).finally(() => { this.inflight -= 1 })
  }

  /**
   * A few hundred bytes that change whenever the panel would have to redraw.
   *
   * The panel polls the host for work the agent did; polling `state()` shipped
   * every output matrix (a 3000-case frequency table is ~300 KB) once a
   * second. This carries the same change signal — data shape, variable
   * formatting, output count, the transform switches, the last error — but no
   * matrices, so a poll is cheap and the full state is fetched only when the
   * signature actually moved.
   */
  signature() {
    const dataset = this.dataset
    return {
      id: this.id,
      version: pluginInfo().version || this.config?.pluginVersion || null,
      engineSource: this.engine.source,
      cwd: this.cwd,
      dataset: dataset
        ? {
          // Same rule as state(): a browser-dropped copy has no path the user
          // could recognise, so it must not show up as one.
          sourcePath: dataset.temporary === true ? null : dataset.sourcePath,
          workPath: dataset.workPath ?? null,
          name: dataset.name ?? (dataset.sourcePath ? displayName(dataset.sourcePath) : null),
          caseCount: dataset.rows?.length ?? 0,
          varCount: dataset.variables?.length ?? 0,
          vars: variableDigest(dataset.variables ?? []),
          truncated: dataset.truncated === true,
          dirty: dataset.dirty === true,
          temporary: dataset.temporary === true,
          origin: dataset.origin ?? null,
          openedAt: dataset.openedAt ?? null,
        }
        : null,
      items: this.items.length,
      lastItemId: this.items.at(-1)?.id ?? null,
      // A run that only writes data changes no shape and adds no item; the log
      // tail is what tells the panel something happened at all.
      logTail: this.log.length > 0 ? this.log[this.log.length - 1].text : null,
      importNotes: (this.importNotes ?? []).length,
      mrRead: this.mrRead,
      // A cell edit changes no shape, adds no item and writes no log line, so
      // without this the panel's heartbeat said "nothing changed" and the other
      // window never learned that its grid was stale.
      revision: Number(this.revision ?? 0),
      lastWriter: this.lastWriter ?? null,
      mrSets: this.mrSets.length,
      splitBy: this.splitBy,
      weightBy: this.weightBy,
      filterBy: this.filterBy,
      selectIf: this.selectIf,
      lastError: this.lastError?.raw ?? null,
      history: this.historyInfo(),
      // Settings the panel draws with. Without them here, changing 表格样式 or
      // 导出上限 left an already-open panel on the old value until it was
      // reloaded: the heartbeat looked unchanged, so the panel never re-read.
      view: {
        tableStyle: this.liveConfig().tableStyle === 'grid' ? 'grid' : 'three-line',
        maxRows: Number(this.liveConfig().maxRows) > 0 ? Number(this.liveConfig().maxRows) : null,
        maxExportRows: Number(this.liveConfig().maxExportRows) > 0 ? Number(this.liveConfig().maxExportRows) : null,
        // Switching the panel language has to reach an open panel the same way
        // a table style does: through the signature the heartbeat compares.
        locale: this.liveConfig().uiLanguage === 'en' ? 'en' : 'zh',
      },
    }
  }

  state() {
    return {
      // The polling signature used to live only on api/heartbeat, which meant a
      // panel that had just drawn fresh state still had to re-read it once more
      // to learn the signature. It travels with the state instead: whoever holds
      // the state holds what to compare the next heartbeat against.
      signal: this.signature(),
      // Which panel last wrote this data, so another window can tell that what
      // it is looking at is not what is on disk any more (see noteWrite).
      revision: Number(this.revision ?? 0),
      lastWriter: this.lastWriter ?? null,
      conflictCount: (this.conflicts ?? []).length,
      lastConflict: (this.conflicts ?? []).at(-1) ?? null,
      id: this.id,
      version: pluginInfo().version || this.config?.pluginVersion || null,
      engine: {
        source: this.engine.source,
        bin: this.engine.bin,
        bundled: this.engine.source === 'bundled',
        hint: this.engine.bin ? undefined : this.engine.hint,
      },
      cwd: this.cwd,
      // The 设置 page writes these; the panel draws the output tables and the
      // status bar from them. It travels with the state because the panel
      // already reads that on every real change — a second request per tick
      // just to learn a table preset would be waste.
      tableStyle: this.liveConfig().tableStyle === 'grid' ? 'grid' : 'three-line',
      maxRows: Number(this.liveConfig().maxRows) > 0 ? Number(this.liveConfig().maxRows) : null,
      // The HTML export is built in the browser and has no host round trip, so
      // it can only honour the export cap if the cap travels with the state.
      maxExportRows: Number(this.liveConfig().maxExportRows) > 0 ? Number(this.liveConfig().maxExportRows) : null,
      // The panel translates its own text: it needs to know which language to
      // translate into before it draws the first frame.
      locale: this.liveConfig().uiLanguage === 'en' ? 'en' : 'zh',
      dataset: this.dataset
        ? {
          // A copy that only exists because a browser dropped its bytes has no
          // path the user could recognise: never hand that copy's location to
          // the panel, or it ends up shown as if it were the real file.
          sourcePath: this.dataset.temporary === true ? null : this.dataset.sourcePath,
          workPath: this.dataset.workPath,
          caseCount: this.dataset.rows?.length ?? 0,
          truncated: this.dataset.truncated === true,
          dirty: this.dataset.dirty === true,
          // A dropped file only reaches the host as bytes, so it lives in the
          // workspace as a copy; saving must not silently write that copy.
          temporary: this.dataset.temporary === true,
          origin: this.dataset.origin ?? (this.dataset.sourcePath ? 'file' : 'new'),
          sourceSize: this.dataset.sourceSize ?? null,
          sourceMtime: this.dataset.sourceMtime ?? null,
          name: this.dataset.name ?? (this.dataset.sourcePath ? displayName(this.dataset.sourcePath) : null),
          variables: this.dataset.variables,
        }
        : null,
      // Always an array, never a missing key: anything reading item.notes
      // (the panel, a tool result, a second plugin) should not have to guess.
      items: this.items.map((item) => (Array.isArray(item.notes) ? item : { ...item, notes: [] })),
      mrSets: this.mrSets.map((entry) => { const { rows, ...rest } = entry; return rest }),
      mrRead: this.mrRead,
      splitBy: this.splitBy,
      weightBy: this.weightBy,
      filterBy: this.filterBy,
      selectIf: this.selectIf,
      log: this.log.slice(-200),
      // Why the imported columns are not named what the file said: the panel
      // has to show this, otherwise V1/V2 look like the file's own headings.
      importNotes: this.importNotes ?? [],
      lastError: this.lastError,
      history: this.historyInfo(),
    }
  }

  /* ------------------------------------------------------ multiple response */

  /** Define (or replace) a multiple response set. */
  defineMrSet(input) {
    if (!this.dataset) throw new Error('先打开一个数据集')
    const set = normalizeSet(input, this.dataset.variables)
    // No row array here: a set is a definition (variables + counted values) and
    // the tables re-read the rows from work.sav. Holding a reference to
    // dataset.rows kept every case alive after release() emptied the dataset,
    // so idle eviction never freed anything for a workspace with sets.
    const entry = {
      ...set,
      createdAt: Date.now(),
    }
    const index = this.mrSets.findIndex((other) => other.name === set.name)
    if (index >= 0) this.mrSets.splice(index, 1, entry)
    else this.mrSets.push(entry)
    this.log.push({ at: Date.now(), text: `定义多选题 ${set.name}（${set.variables.join(' ')}）` })
    return this.state()
  }

  removeMrSet(name) {
    this.mrSets = this.mrSets.filter((entry) => entry.name !== name)
    if (this.mrRead === name) this.mrRead = null
    this.log.push({ at: Date.now(), text: `删除多选题 ${name}` })
    return this.state()
  }

  setMrRead(name) {
    this.mrRead = name ?? null
    return this.state()
  }

  /**
   * Frequency table for one set. Reads the rows fresh instead of trusting the
   * copy taken at definition time, so an edit in the grid shows up.
   */
  async mrFrequency(name, options = {}) {
    const entry = this.mrSets.find((other) => other.name === name)
    if (!entry) throw new Error(`没有定义多选题 ${name}`)
    if (!this.dataset) throw new Error('先打开一个数据集')
    const workPath = await this.workSav()
    const run = (script, opts) => this.exec(script, opts)
    const variables = await readDictionary(run, workPath)
    const data = await readData(run, workPath, variables, { maxRows: this.maxRows })
    const result = tabulate(entry, variables, data.rows)
    const title = entry.label ? `${entry.label}（${entry.name}）` : `多选题：${entry.name}`
    const item = {
      id: `mr-${entry.name}-${Date.now()}`,
      kind: 'table',
      title,
      table: {
        caption: title,
        matrix: frequencyMatrix(result, options),
        html: '',
      },
      // PSPP cannot tabulate a set, so a report card replays the set plus a
      // FREQUENCIES on every member variable: same variables, engine output.
      script: [
        `GET FILE=${quoteSyntaxPath(workPath)}.`,
        mrsetsSyntax(entry),
        `FREQUENCIES /VARIABLES=${entry.variables.join(' ')}.`,
      ].join('\n'),
      mrSet: entry.name,
      createdAt: Date.now(),
    }
    const [stored] = this.appendItems([item])
    this.mrRead = entry.name
    this.log.push({ at: Date.now(), text: `多选题频数 ${entry.name}：${result.responses} 个响应、${result.respondents} 个个案` })
    return { result, item: stored, state: this.state() }
  }

  /** Cross tabulation of one set against a grouping variable. */
  async mrCrosstab(name, groupVariable) {
    const entry = this.mrSets.find((other) => other.name === name)
    if (!entry) throw new Error(`没有定义多选题 ${name}`)
    if (!this.dataset) throw new Error('先打开一个数据集')
    const workPath = await this.workSav()
    const run = (script, opts) => this.exec(script, opts)
    const variables = await readDictionary(run, workPath)
    const data = await readData(run, workPath, variables, { maxRows: this.maxRows })
    const matrix = mrCrosstab(entry, groupVariable, variables, data.rows)
    const title = `${entry.label || entry.name} × ${groupVariable}`
    const item = {
      id: `mrx-${entry.name}-${Date.now()}`,
      kind: 'table',
      title,
      table: { caption: title, matrix, html: '' },
      script: [
        `GET FILE=${quoteSyntaxPath(workPath)}.`,
        mrsetsSyntax(entry),
        `CROSSTABS /TABLES=${entry.variables.join(' ')} BY ${groupVariable}.`,
      ].join('\n'),
      mrSet: entry.name,
      createdAt: Date.now(),
    }
    const [stored] = this.appendItems([item])
    this.mrRead = entry.name
    this.log.push({ at: Date.now(), text: `多选题交叉表 ${title}` })
    return { result: { matrix }, item: stored, state: this.state() }
  }

  /**
   * Publication table 1 (baseline) or table 2 (between-group comparison).
   *
   * The rows come from the loaded dataset rather than an engine run, because a
   * thesis table interleaves categories, percentages and p values in one grid
   * that no single PSPP command produces.
   */
  publicationTable(kind, options = {}) {
    if (!this.dataset) throw new Error('先打开一个数据集')
    if (kind !== 'baseline' && kind !== 'compare') throw new Error('表类型只能是 baseline（表 1）或 compare（表 2）')
    const built = kind === 'baseline' ? buildBaselineTable(this.dataset, options) : buildCompareTable(this.dataset, options)
    const item = {
      id: `pub-${kind}-${Date.now()}`,
      kind: 'table',
      title: built.title,
      table: { caption: built.title, matrix: built.matrix, html: '' },
      notes: built.notes,
      createdAt: Date.now(),
    }
    const [stored] = this.appendItems([item])
    this.log.push({ at: Date.now(), text: `${built.title}：${built.matrix.length - 1} 行` })
    return { item: stored, notes: built.notes, matrix: built.matrix, state: this.state() }
  }

  pairwiseTable(options = {}) {
    if (!this.dataset) throw new Error('先打开一个数据集')
    const built = options.layout === 'matrix'
      ? buildSignificanceMatrix(this.dataset, options)
      : buildPairwiseTable(this.dataset, options)
    const item = {
      id: `pair-${Date.now()}`,
      kind: 'table',
      title: built.title,
      table: { caption: built.title, matrix: built.matrix, html: '' },
      notes: built.notes,
      createdAt: Date.now(),
    }
    const [stored] = this.appendItems([item])
    this.log.push({ at: Date.now(), text: `${built.title}：${built.matrix.length - 1} 对比较` })
    return { item: stored, notes: built.notes, matrix: built.matrix, state: this.state() }
  }

  /** Partial correlations: PSPP has no PARTIAL CORR, so the plugin computes it. */
  partialTable(options = {}) {
    if (!this.dataset) throw new Error('先打开一个数据集')
    const built = options.layout === 'matrix'
      ? buildPartialMatrix(this.dataset, options)
      : buildPartialTable(this.dataset, options)
    const item = {
      id: `partial-${Date.now()}`,
      kind: 'table',
      title: built.title,
      table: { caption: built.title, matrix: built.matrix, html: '' },
      notes: built.notes,
      createdAt: Date.now(),
    }
    const [stored] = this.appendItems([item])
    this.log.push({ at: Date.now(), text: `${built.title}：${built.matrix.length - 1} 对变量` })
    return { item: stored, notes: built.notes, matrix: built.matrix, state: this.state() }
  }

  /** Replay the definitions into the working .sav. */
  async persistMrSets() {
    if (this.mrSets.length === 0) return 0
    return this.persistMrSetsTo(await this.workSav())
  }

  async persistMrSetsTo(savPath) {
    // The engine runs inside the run directory, so the path has to be
    // absolute before it reaches GET FILE / SAVE OUTFILE.
    const workPath = resolve(savPath)
    // Read-modify-write of a .sav the user may have named in Chinese, which the
    // Windows engine cannot open: edit a staging copy and put it back after.
    const staged = await stageFile(workPath, this.ioDir)
    const script = [
      `GET FILE=${quoteSyntaxPath(staged.path)}.`,
      ...this.mrSets.map((entry) => mrsetsSyntax(entry)),
      `SAVE OUTFILE=${quoteSyntaxPath(staged.path)}.`,
    ].join('\n') + '\n'
    let result
    try {
      result = await this.exec(script, { outName: 'mrsets', collectOutput: false })
    } catch (error) {
      await staged.dispose()
      throw error
    }
    if (result.code !== 0) {
      await staged.dispose()
      // stderr starts with a 提示 line, so taking [0] showed the note and hid
      // the real cause (e.g. "this identifier must start with '$'").
      throw new Error(`保存多选题定义失败：${worstStderrLine(result.stderr)}`)
    }
    // Every run prints "MRSETS is implemented but no other commands support
    // multiple response sets yet" as a 提示 while still storing the set, so
    // only a 错误 line means the dictionary did not take it.
    const failure = String(result.stderr ?? '').split('\n').find((line) => line.includes('错误') || /error:/i.test(line))
    if (failure) {
      await staged.dispose()
      throw new Error(`保存多选题定义失败：${failure.trim()}`)
    }
    await staged.commit()
    return this.mrSets.length
  }

  /* --------------------------------------------------------------- history */

  historyInfo() {
    const undo = this.undoStack.at(-1)
    const redo = this.redoStack.at(-1)
    return {
      undo: this.undoStack.length,
      redo: this.redoStack.length,
      dropped: this.historyDropped,
      undoLabel: undo ? undo.label : null,
      redoLabel: redo ? redo.label : null,
    }
  }

  /** Full snapshot of the current data, labelled with the change it precedes. */
  captureHistory(label) {
    return {
      kind: 'full',
      label: String(label || '编辑'),
      cells: this.dataset.rows.length * Math.max(1, this.dataset.variables.length),
      variables: structuredClone(this.dataset.variables),
      rows: this.dataset.rows.map((row) => row.slice()),
    }
  }

  /** Record a change that is about to happen, so 撤销 can put the data back. */
  /** Record that the data changed, and by whom. */
  /**
   * Remember a refused write.
   *
   * A conflict toast is gone in five seconds, but the interesting question
   * ("did anything try to overwrite my data while I was working?") is asked
   * hours later, by which time the panel is closed. Kept in dataset.json next
   * to the data it belongs to, and exposed in state so the panel can show a
   * count without a second request.
   */
  recordConflict(details = {}) {
    const entry = {
      at: Date.now(),
      expected: Number(details.expected ?? 0),
      actual: Number(details.actual ?? 0),
      lastWriter: typeof details.lastWriter === 'string' ? details.lastWriter : null,
      writer: typeof details.writer === 'string' ? details.writer : null,
      route: typeof details.route === 'string' ? details.route : null,
    }
    this.conflicts = [...(this.conflicts ?? []), entry].slice(-50)
    // Returned so the caller can wait for the file: the answer to "did anything
    // try to overwrite my data" is read from dataset.json, and a 409 that comes
    // back before the record lands is the same as no record at all.
    this.pendingConflictWrite = this.rememberDataset({ bumpRevision: false })
      .catch(() => { /* the trail is best effort */ })
    return entry
  }

  /** Resolve once the conflict trail has reached dataset.json. */
  async settled() {
    await this.pendingConflictWrite
  }

  noteWrite() {
    this.revision = Number(this.revision ?? 0) + 1
    // A tool call (or any client that does not name itself) has no owner to
    // report: crediting the previous panel made a dialog-driven write look
    // exactly like another browser window's.
    this.lastWriter = typeof this.currentWriter === 'string' && this.currentWriter ? this.currentWriter : null
    return this.revision
  }

  pushHistory(label) {
    this.noteWrite()
    if (!this.dataset) return
    const cells = this.dataset.rows.length * Math.max(1, this.dataset.variables.length)
    if (cells > this.historyCells) {
      // Too big to snapshot on every keystroke: leave the stack alone rather
      // than let the panel eat hundreds of megabytes.
      this.undoStack = []
      this.redoStack = []
      return
    }
    this.undoStack.push(this.captureHistory(label))
    this.trimHistory()
    this.redoStack = []
  }

  /** Record one cell change without cloning the whole dataset. */
  pushCellHistory(row, column, before, after) {
    this.noteWrite()
    if (!this.dataset) return
    this.undoStack.push({ kind: 'cell', label: '编辑单元格', cells: 1, row, column, before, after })
    this.trimHistory()
    this.redoStack = []
  }

  /**
   * Keep the undo stack inside both limits: a step count and a total cell
   * budget. Dropping a step is a visible loss (the next 撤销 goes further back),
   * so the count is reported and the panel can say so, but silently eating a
   * gigabyte is the worse trade.
   */
  trimHistory() {
    while (this.undoStack.length > this.historyLimit) {
      this.undoStack.shift()
      this.historyDropped += 1
    }
    let total = this.undoStack.reduce((sum, entry) => sum + (Number(entry.cells) > 0 ? Number(entry.cells) : 1), 0)
    while (this.undoStack.length > 1 && total > this.historyBudgetCells) {
      const gone = this.undoStack.shift()
      total -= Number(gone.cells) > 0 ? Number(gone.cells) : 1
      this.historyDropped += 1
    }
  }

  applyHistoryEntry(entry, undo) {
    if (!this.dataset) throw new Error('数据集已关闭：撤销记录随之失效')
    if (entry.kind === 'cell') {
      const row = this.dataset.rows[entry.row]
      if (row) row[entry.column] = undo ? entry.before : entry.after
      this.dataset.dirty = true
      return
    }
    this.dataset.variables = structuredClone(entry.variables)
    this.dataset.rows = entry.rows.map((row) => row.slice())
    this.dataset.dirty = true
  }

  undo() {
    this.assertEditable()
    if (!this.dataset) throw new Error('没有打开数据集')
    const entry = this.undoStack.pop()
    if (!entry) throw new Error('没有可撤销的操作')
    this.redoStack.push({ ...this.captureHistory(entry.label) })
    this.applyHistoryEntry(entry, true)
    return { action: 'undo', label: entry.label, history: this.historyInfo() }
  }

  redo() {
    this.assertEditable()
    if (!this.dataset) throw new Error('没有打开数据集')
    const entry = this.redoStack.pop()
    if (!entry) throw new Error('没有可重做的操作')
    this.undoStack.push({ ...this.captureHistory(entry.label) })
    this.applyHistoryEntry(entry, false)
    return { action: 'redo', label: entry.label, history: this.historyInfo() }
  }

  page(offset = 0, limit = 100, columns = null) {
    if (!this.dataset) return { offset: 0, limit, total: 0, rows: [], variables: [] }
    const start = Math.max(0, Number(offset) || 0)
    const size = Math.max(1, Math.min(2000, Number(limit) || 100))
    const variables = this.dataset.variables
    const indices = Array.isArray(columns) && columns.length > 0
      ? columns.map((name) => variables.findIndex((variable) => variable.name === name)).filter((index) => index >= 0)
      : variables.map((_, index) => index)
    const rows = this.dataset.rows.slice(start, start + size).map((row) => indices.map((index) => row[index] ?? null))
    return {
      offset: start,
      limit: size,
      total: this.dataset.rows.length,
      columns: indices.map((index) => variables[index].name),
      rows,
      variables: this.dataset.variables,
      truncated: this.dataset.truncated === true,
    }
  }

  /** Write the in-memory dataset to the working system file. */
  async workSav(options = {}) {
    if (!this.dataset) throw new Error('no dataset is open; open a data file or create a new one first')
    const workPath = this.dataset.workPath ?? join(this.dir, 'work.sav')
    this.dataset.workPath = workPath
    if (this.dataset.dirty === true || !existsSync(workPath)) {
      // A truncated dataset holds only the first `maxRows` cases: writing it
      // back replaces work.sav with that prefix and loses the rest for good.
      // save() already refuses; every path that flushes the working file has
      // to refuse too.
      if (this.dataset.truncated === true && options?.force !== true) {
        throw new Error(`这份数据超过 ${this.maxRows} 个个案，面板里只有前 ${(this.dataset.rows ?? []).length} 个：现在写回工作文件会把后面的个案丢掉。请直接用语法在完整数据上分析，或者先筛选出一个较小的数据文件再导入`)
      }
      await writeSav((script, options) => this.exec(script, options), {
        variables: this.dataset.variables,
        rows: this.dataset.rows,
      }, workPath)
      this.dataset.dirty = false
      // The sidecar has to follow the working file: a built dataset used to be
      // written to work.sav while dataset.json still described the file that
      // was open before, so a restored session stamped its tables with the
      // wrong source (P21).
      await this.rememberDataset()
    }
    return workPath
  }

  /** Run one syntax file inside a fresh run directory and collect its output. */
  async exec(scriptText, options = {}) {
    const runId = ++this.seq
    const dir = this.runDir(runId)
    await mkdir(dir, { recursive: true })
    const outName = options.outName ?? 'output'
    const format = options.format ?? 'html'
    const outPath = join(dir, `${outName}.${format}`)
    const errPath = join(dir, `${outName}.err`)
    const scriptPath = join(dir, 'run.sps')
    await writeFile(scriptPath, scriptText, 'utf8')

    const env = engineEnv(this.engine, options.env ?? {})
    // The syntax file this plugin writes is always UTF-8, but the engine picks
    // its syntax encoding from the locale, which on Windows is the ANSI code
    // page (cp936) — Chinese labels would come out as mojibake.
    const args = ['--syntax-encoding=UTF-8', '-o', outPath, '-e', errPath]
    if (this.config.safer === true) args.push('--safer')
    args.push(scriptPath)

    const result = await runProcess(this.engine.bin, args, {
      cwd: dir,
      env,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
    })

    let outputText = ''
    let outputHtml = ''
    // Binary outputs (a .spv archive is a zip) and callers that only want the
    // side effects skip the read entirely; decoding a 5 MB archive as UTF-8
    // yields megabytes of garbage and nothing usable.
    if (options.collectOutput !== false) {
      try {
        const raw = await readFile(outPath, 'utf8')
        if (format === 'html') outputHtml = raw
        else outputText = raw
      } catch {
        /* driver produced no output */
      }
    }
    let stderr = ''
    // Two streams, and which one carries the diagnosis depends on how the
    // engine died: an ordinary refusal goes to the `-e` file, while a PSPP bug
    // banner is written straight to fd 2 and leaves the file empty (measured on
    // 2.1.3 with a SIGSEGV). Reading the file alone therefore dropped the only
    // sentence that said "the engine crashed", so keep both.
    let fileStderr = ''
    try {
      fileStderr = await readFile(errPath, 'utf8')
    } catch { /* the file is missing when the engine died before opening it */ }
    stderr = [fileStderr, String(result.stderr ?? '')].filter((text) => text.trim() !== '').join('\n')

    const dataCsvPath = join(dir, 'data.csv')
    return {
      runId,
      dir,
      code: result.code,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr,
      outputPath: outPath,
      outputText,
      outputHtml,
      dataCsvPath,
    }
  }

  async reloadFromWork(base = this.dataset, options = {}) {
    const workPath = options.flush === false
      ? (base?.workPath ?? join(this.dir, 'work.sav'))
      : await this.workSav()
    const run = (script, options) => this.exec(script, options)
    const variables = await readDictionary(run, workPath)
    const data = await readData(run, workPath, variables, { maxRows: this.maxRows })
    const next = {
      ...base,
      workPath,
      variables,
      rows: data.rows,
      truncated: data.truncated,
      dirty: false,
      evicted: false,
    }
    // Published in one assignment: readers never see a dataset whose variables
    // and rows are still missing (that used to throw in state()).
    this.dataset = next
    return next
  }

  /** Sheet names of a workbook so the panel can ask which one to import. */
  async listSheets(inputPath) {
    const path = this.resolvePath(inputPath)
    const ext = extname(path).toLowerCase()
    const reader = ext === '.ods' ? readOds : readXlsx
    const book = reader(await readFile(path))
    return { path, sheets: book.sheetNames }
  }

  /**
   * Read a file the way `open()` would, but answer what it *would* become
   * instead of replacing the dataset. The wizard shows the caller's columns,
   * their guessed types and the first rows, so encoding, delimiter, header and
   * missing-value markers can be corrected before anything is imported.
   */
  async previewImport(inputPath, options = {}) {
    const path = this.resolvePath(inputPath)
    let info
    try {
      info = await stat(path)
    } catch (error) {
      throw new Error(describeFsError(error, path))
    }
    if (!info.isFile()) throw new Error(`${path} 是个目录，不是数据文件`)
    const ext = extname(path).toLowerCase()
    const wanted = (columns, rows, extra = {}) => ({
      path,
      kind: extra.kind ?? 'delimited',
      encoding: extra.encoding ?? null,
      delimiter: extra.delimiter ?? null,
      hasHeader: extra.hasHeader !== false,
      skipRows: Number(options.skipRows ?? 0) || 0,
      skipTailRows: Number(options.skipTailRows ?? 0) || 0,
      sheet: extra.sheet ?? null,
      sheets: extra.sheets ?? [],
      totalRows: rows.length,
      columns: columns.map((variable) => ({
        name: variable.name,
        label: variable.label ?? '',
        type: variable.type,
        width: variable.width,
        missing: variable.missing ?? [],
      })),
      // The first rows are shown as they were read (numbers as numbers), so a
      // column that came out numeric only because of a marker is visible.
      rows: rows.slice(0, 20),
      notes: extra.notes ?? [],
    })
    if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
      const text = decodeText(await readFile(path), options.encoding)
      const delimiter = options.delimiter && options.delimiter !== 'auto'
        ? options.delimiter
        : guessDelimiter(text)
      const imported = await importDelimited(text, {
        sourcePath: path,
        delimiter,
        hasHeader: options.hasHeader === undefined ? ext !== '.txt' : options.hasHeader !== false,
        skipRows: options.skipRows,
        skipTailRows: options.skipTailRows,
        names: options.names,
        types: options.types,
        missing: options.missing,
      })
      return wanted(imported.variables, imported.rows, {
        encoding: String(options.encoding ?? 'auto'),
        delimiter,
        hasHeader: options.hasHeader === undefined ? ext !== '.txt' : options.hasHeader !== false,
        notes: imported.notes ?? [],
      })
    }
    if (ext === '.xlsx' || ext === '.ods') {
      const book = (ext === '.ods' ? readOds : readXlsx)(await readFile(path))
      const index = options.sheet === undefined || options.sheet === null || options.sheet === ''
        ? 0
        : typeof options.sheet === 'number'
          ? options.sheet
          : book.sheetNames.indexOf(String(options.sheet))
      const sheet = book.sheets[index] ?? book.sheets[0]
      if (!sheet) throw new Error(`这个 ${ext} 里没有工作表`)
      const imported = buildTable(trimSheet(sheet.rows), {
        sourcePath: path,
        hasHeader: options.hasHeader !== false,
        skipRows: options.skipRows,
        skipTailRows: options.skipTailRows,
        names: options.names,
        types: options.types,
        missing: options.missing,
      })
      return wanted(imported.variables, imported.rows, {
        kind: 'sheet',
        sheet: sheet.name,
        sheets: book.sheetNames,
        hasHeader: options.hasHeader !== false,
        notes: imported.notes ?? [],
      })
    }
    throw new Error(`${ext || '这个'} 文件不能预览：向导支持 .csv、.txt、.tsv、.xlsx、.ods，其它格式直接用「打开数据」`)
  }

  async open(inputPath, options = {}) {
    return this.mutex.run(async () => {
      this.busyDepth += 1
      try {
      const path = this.resolvePath(inputPath)
      let info
      try {
        info = await stat(path)
      } catch (error) {
        throw new Error(describeFsError(error, path))
      }
      if (!info.isFile()) throw new Error(`${path} 是个目录，不是数据文件`)
      const ext = extname(path).toLowerCase()
      const workPath = join(this.dir, 'work.sav')
      // Spreadsheet headings often have to be renamed to satisfy PSPP's rules;
      // the notes collected here travel back to the panel so the rename is
      // visible instead of silently changing a column's name.
      this.importNotes = []

      if (SYSTEM_FILE_EXTENSIONS.has(ext)) {
        // A Chinese path cannot be opened by the Windows engine: read a staging
        // copy instead (lib/stage.js) and keep the user's path for display.
        const staged = await stageInput(path, this.ioDir)
        try {
          const script = `GET FILE=${quoteSyntaxPath(staged.path)}.\nSAVE OUTFILE=${quoteSyntaxPath(workPath)}.\n`
          const result = await this.exec(script, { outName: 'open', env: { LC_ALL: 'C', LANG: 'C' } })
          if (result.code !== 0) {
            throw new Error(describeEngineError(result.stderr, basename(path), result.code))
          }
        } finally {
          await staged.dispose()
        }
      } else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
        // Chinese exports are still often GBK and Windows tools write ';' or
        // tabs, so let the caller choose instead of guessing blindly.
        const text = decodeText(await readFile(path), options.encoding)
        const imported = await importDelimited(text, {
          sourcePath: path,
          delimiter: options.delimiter,
          hasHeader: options.hasHeader === undefined ? ext !== '.txt' : options.hasHeader !== false,
          skipRows: options.skipRows,
          skipTailRows: options.skipTailRows,
          names: options.names,
          types: options.types,
          missing: options.missing,
        })
        this.importNotes = imported.notes ?? []
        this.dataset = { variables: imported.variables, rows: imported.rows, workPath, sourcePath: path, dirty: true }
        await this.workSav()
      } else if (ext === '.xlsx' || ext === '.ods') {
        // Excel and LibreOffice both store a ZIP of XML; lib/xlsx.js and
        // lib/ods.js read them without any dependency, so a worksheet imports
        // like a delimited file.
        const book = (ext === '.ods' ? readOds : readXlsx)(await readFile(path))
        const wanted = options.sheet === undefined || options.sheet === null || options.sheet === ''
          ? 0
          : typeof options.sheet === 'number'
            ? options.sheet
            : book.sheetNames.indexOf(String(options.sheet))
        const sheet = book.sheets[wanted] ?? book.sheets[0]
        if (!sheet) throw new Error(`这个 ${ext} 里没有工作表`)
        const imported = buildTable(trimSheet(sheet.rows), {
          sourcePath: path,
          hasHeader: options.hasHeader !== false,
          skipRows: options.skipRows,
          skipTailRows: options.skipTailRows,
          names: options.names,
          types: options.types,
          missing: options.missing,
        })
        this.importNotes = imported.notes ?? []
        this.dataset = {
          variables: imported.variables,
          rows: imported.rows,
          workPath,
          sourcePath: path,
          dirty: true,
          sheetName: sheet.name,
        }
        await this.workSav()
      } else if (ext === '.dta') {
        // Stata files carry their own types, labels and value labels, so they
        // are mapped directly instead of going through type inference.
        const parsed = readDta(await readFile(path))
        this.dataset = {
          variables: parsed.variables,
          rows: parsed.rows,
          workPath,
          sourcePath: path,
          dirty: true,
        }
        await this.workSav()
      } else if (ext === '.sps') {
        // A syntax file is opened in the syntax editor, not as data.
        return { kind: 'syntax', path, text: await readFile(path, 'utf8') }
      } else {
        throw new Error(`unsupported data file: ${ext || basename(path)} (supported: .sav, .por, .csv, .txt, .tsv, .xlsx, .ods, .dta)`)
      }

      this.dataset = {
        ...this.dataset,
        sourcePath: path,
        workPath,
        truncated: false,
        dirty: false,
        // When this file was read: part of the provenance stamp on every table,
        // so "the numbers came from the version of a.sav I opened at 18:40" is
        // answerable even after the file on disk has changed.
        openedAt: Date.now(),
        // What was on disk when it was read. Size and mtime are what tell "the
        // file my table came from" apart from a newer file that happens to have
        // the same name and the same case count.
        sourceSize: Number(info.size) > 0 ? Number(info.size) : null,
        sourceMtime: Math.round(Number(info.mtimeMs)) || null,
        // Where the data came from: a path the user opened, bytes a browser
        // dropped (a copy under uploads/), or nothing at all (a dataset built by
        // pspp_new). The name of a new dataset used to be stored as its
        // sourcePath, which made the panel label look like a file name.
        origin: /[\\/]uploads[\\/]/.test(path) ? 'upload' : 'file',
        // Files that only exist because a browser dropped their bytes. Judge
        // by the path itself: a second document gets its own workspace
        // directory, so it opens copies that live under *another* session's
        // uploads/ and a this.dir-prefixed test would call them real files.
        temporary: /[\\/]uploads[\\/]/.test(path),
        name: displayName(path),
      }
      this.undoStack = []
      this.redoStack = []
      await this.reloadFromWork()
      // PSPP stores multiple response sets in the .sav as file attributes and
      // offers no command to read them back, so they are recovered from the
      // bytes here; without this, reopening a file silently forgot every set.
      this.mrSets = await readMrSetsFromFile(path, this.dataset.variables)
      this.mrRead = null
      this.dataset.sourcePath = path
      await this.rememberDataset()
      this.log.push({ at: Date.now(), text: `打开数据：${path}（${this.dataset.rows.length} 个个案，${this.dataset.variables.length} 个变量）` })
      return { path, caseCount: this.dataset.rows.length, variables: this.dataset.variables, notes: this.importNotes ?? [] }
        } finally {
          this.busyDepth -= 1
        }
      })
  }

  async createDataset(spec = {}) {
    return this.mutex.run(async () => {
      const workPath = join(this.dir, 'work.sav')
      const variables = Array.isArray(spec.variables) && spec.variables.length > 0
        ? spec.variables.map((variable, index) => ({
          // position is 1-based and every place that reads a cell goes through
          // `position - 1`; leaving it out made a hand-built dataset look like
          // its cells were all missing.
          position: index + 1,
          name: String(variable.name ?? `V${index + 1}`).replaceAll(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_'),
          label: String(variable.label ?? ''),
          type: variable.type === 'string' ? 'string' : 'numeric',
          width: Number(variable.width) || (variable.type === 'string' ? 8 : 8),
          decimals: Number(variable.decimals ?? 2),
          format: String(variable.format ?? (variable.type === 'string' ? 'A8' : 'F8.2')),
          measure: ['nominal', 'ordinal', 'scale'].includes(variable.measure) ? variable.measure : 'scale',
          role: 'input',
          alignment: variable.type === 'string' ? 'left' : 'right',
          missing: [],
          valueLabels: {},
        }))
        : [
          { name: 'V1', label: '', type: 'numeric', width: 8, decimals: 2, format: 'F8.2', measure: 'scale', role: 'input', alignment: 'right', missing: [], valueLabels: {} },
          { name: 'V2', label: '', type: 'numeric', width: 8, decimals: 2, format: 'F8.2', measure: 'scale', role: 'input', alignment: 'right', missing: [], valueLabels: {} },
        ]
      // Rows may be given with the variables so an agent can define a small
      // table in one call; each row is an object keyed by name or a positional
      // array. Anything that does not fit becomes a system-missing value, the
      // same coercion appendCase applies.
      const incoming = Array.isArray(spec.rows) ? spec.rows : []
      const rows = incoming.map((entry) => coerceRow(entry, variables))
      this.dataset = {
        // No file: the name the caller gave is a label for the document, not a
        // path. Storing it as sourcePath made provenance claim a source that
        // does not exist on disk.
        sourcePath: null,
        name: spec.name ? String(spec.name) : null,
        origin: 'new',
        sourceSize: null,
        sourceMtime: null,
        openedAt: Date.now(),
        workPath,
        variables,
        rows,
        truncated: false,
        dirty: true,
      }
      this.undoStack = []
      this.redoStack = []
      await this.workSav()
      this.log.push({ at: Date.now(), text: `新建数据集（${variables.length} 个变量）` })
      return { workPath, variables }
    })
  }

  /**
   * Execute user syntax. `persist` marks a data-modifying run: the working
   * system file is re-saved and the in-memory model reloaded afterwards.
   */
  async runSyntax(syntax, options = {}) {
    return this.mutex.run(async () => {
      this.busyDepth += 1
      try {
      if (typeof syntax !== 'string' || syntax.trim() === '') throw new Error('syntax is empty')
      // What the caller asked for, before the plugin prepends its own
      // `GET FILE` header: the header is not something the user typed, and
      // counting it as "this script loads data" turned every empty-data run
      // into "you imported an empty file".
      const requested = syntax
      const persist = options.persist === true
      if (persist) this.pushHistory(options.historyLabel ?? '运行数据变更语法')
      let script = syntax.trimEnd() + '\n'
      // Remember (or clear) the session settings before deciding what to prepend,
      // so a run that sets them takes effect for itself and for later runs.
      const splitMatch = script.match(SESSION_DIRECTIVES.split)
      const weightMatch = script.match(SESSION_DIRECTIVES.weight)
      const filterMatch = script.match(SESSION_DIRECTIVES.filter)
      const selectMatch = script.match(SESSION_DIRECTIVES.select)
      if (splitMatch) {
        this.splitBy = splitMatch[1] ? splitMatch[1].trim().split(/\s+/).filter(Boolean) : []
      }
      if (weightMatch) this.weightBy = weightMatch[1] ? weightMatch[1].trim() : null
      if (filterMatch) this.filterBy = filterMatch[1] ? filterMatch[1].trim() : null
      if (selectMatch) this.selectIf = selectMatch[0].trim().replace(/\s+/g, ' ')
      if (this.dataset) {
        const workPath = await this.workSav()
        if (!/^\s*GET\s+(FILE|DATA)\b/im.test(script)) {
          script = `GET FILE=${quoteSyntaxPath(workPath)}.\n${script}`
        }
        const preamble = []
        if (this.splitBy.length > 0 && !splitMatch) {
          preamble.push(`SPLIT FILE BY ${this.splitBy.join(' ')}.`, 'EXECUTE.')
        }
        if (this.weightBy && !weightMatch) preamble.push(`WEIGHT BY ${this.weightBy}.`)
        if (this.filterBy && !filterMatch) preamble.push(`FILTER BY ${this.filterBy}.`)
        if (preamble.length > 0) {
          script = script.replace(
            /^(\s*GET\s+(?:FILE|DATA)[^\n]*\n)/i,
            `$1${preamble.join('\n')}\n`,
          )
        }
        if (persist) script += `SAVE OUTFILE=${quoteSyntaxPath(workPath)}.\n`
      } else if (persist) {
        throw new Error('no dataset is open')
      }

      this.lastScript = script
      // The replay starts from the working file as it is now, so the GET FILE
      // header and the closing SAVE are dropped — otherwise a report would
      // run the transformations twice and write the data file again.
      this.reportScript = this.dataset
        ? script.split('\n')
          .slice(1)
          .filter((line) => !/^\s*SAVE\b/i.test(line))
          .join('\n')
        : ''
      this.reportHeader = this.dataset ? `GET FILE=${quoteSyntaxPath(await this.workSav())}.` : ''
      // RISK on a string grouping variable crashes the engine outright; drop it
      // and compute the risk difference here instead (see dropRiskOnStrings).
      const riskGuard = dropRiskOnStrings(script, this.dataset)
      if (riskGuard) script = riskGuard.syntax
      // CMH is not an engine statistic in 2.1.3: leaving it in makes the whole
      // run fail, so it comes out here and the note is computed below.
      const cmhGuard = dropCmhStatistic(script)
      if (cmhGuard.requested) script = cmhGuard.syntax
      // Everything downstream (which statistics were asked for) must read the
      // syntax the engine actually received, not the caller's original text.
      syntax = script.trimEnd()
      let result = await this.exec(script, { outName: 'output', format: 'html' })
      this.lastRunId = result.runId
      let parsed = parseHtmlOutput(result.outputHtml ?? '')
      const { diagnostics, log } = parseDiagnostics(result.stderr)
      // PSPP 2.1.3 with /STATISTICS=TOL dies inside gsl_blas_dsymm about one run
      // in six and writes nothing at all. The same model without TOL is stable,
      // and the plugin computes tolerance/VIF itself, so drop it and retry once
      // instead of handing the caller an empty run.
      const retried = []
      const degraded = degradeStatistics(script)
      if (result.code !== 0 && parsed.length === 0 && degraded !== script) {
        const retry = await this.exec(degraded, { outName: 'output', format: 'html' })
        if (retry.code === 0 || parseHtmlOutput(retry.outputHtml ?? '').length > 0) {
          const asked = /\bALL\b/i.test(script) ? 'ALL（它包含 TOL）' : 'TOL'
          retried.push(`PSPP 的 ${asked} 统计量偶发崩溃（gsl_blas_dsymm: matrix/vector sizes are not conformant），已去掉 TOL/ALL 自动重跑一次；容忍度与 VIF 见下面的「共线性诊断（插件计算）」`)
          script = degraded
          result = retry
          parsed = parseHtmlOutput(result.outputHtml ?? '')
          this.lastRunId = result.runId
        }
      }
      // An exit code that is not zero with nothing to show used to be returned as
      // a silent empty run — the user reads that as "no significant result". Fail
      // loudly instead, with the engine's own last line.
      if ((result.code !== 0 || result.signal) && parsed.length === 0) {
        // `END DATA` with anything after it on the same line stops PSPP with
        // "Missing END DATA while reading inline data" — an English sentence
        // about inline data that says nothing about the real mistake. This used
        // to be checked after this branch, where it could never be reached
        // because the engine always exits non-zero on that script.
        const tailProblem = inlineDataTailProblem(requested)
        if (tailProblem) throw new Error(tailProblem)
        const sameLine = inlineCommandProblem(requested)
        if (sameLine) throw new Error(sameLine)
        // A crash sentence is a whole paragraph; wrapping it in "no tables (…)"
        // produced nested parentheses around an explanation of its own.
        const said = describeFailure(result)
        if (/^引擎崩溃/.test(said)) throw new Error(said)
        // The engine writes for people who already know the command; keep its
        // sentence as the record and add what to do about it.
        const hint = explainMessage(said)
        const guess = nearestVariableName(said, this.dataset?.variables ?? [])
        // A named candidate makes the generic "check the spelling" line noise.
        const extra = [guess ? '' : hint, guess].filter(Boolean).join('；')
        throw new Error(`引擎没有产出任何表（${said}）${extra ? ` —— ${extra}` : ''}`)
      }
      // Exit code 0 with no table is not success: PSPP reports some refusals
      // only as a warning (Cochran's Q with three values writes "More than two
      // values encountered" and stops). Returning an empty result made the
      // caller read it as "nothing significant".
      if (parsed.length === 0) {
        // A data step (COMPUTE, SORT, a SAVE) legitimately produces no table,
        // so an empty run alone is not an error. PSPP does report some
        // refusals only as a warning — Cochran's Q with three values writes
        // "More than two values encountered" and stops — and those must not
        // come back as "nothing significant".
        const warnings = (diagnostics ?? []).filter((entry) => entry.severity !== 'error').map((entry) => entry.message)
        if (warnings.length > 0 || result.timedOut) {
          const extra = warnings.length > 0 ? `：${warnings.slice(0, 3).join('；')}` : '：引擎超时'
          throw new Error(`引擎这次一条结果都没有（退出码 ${result.code ?? '空'}${result.timedOut ? '，超时' : ''}）${extra}`)
        }
        // PSPP sometimes rejects a command and still exits 0: `REGRESSION.` with no
        // subcommand prints "Syntax error expecting DEPENDENT, METHOD, …" on stderr
        // and returns success. Reading only the warnings here sent that run down to
        // the zero-case explanation, which blames a filter the user never wrote.
        const errors = (diagnostics ?? []).filter((entry) => entry.severity === 'error').map((entry) => String(entry.message ?? '').trim()).filter(Boolean)
        if (errors.length > 0) {
          const said = errors.slice(0, 3).join('；')
          const hint = explainMessage(said)
          throw new Error(`引擎没有产出任何表（${said}）${hint ? ` —— ${hint}` : ''}`)
        }
        // An empty dataset makes DESCRIPTIVES and FREQUENCIES print nothing at
        // all — exit code 0, no diagnostics. The caller reads that as "no
        // significant result", so say what actually happened.
        // A data step can legitimately produce no table, and a GET DATA / DATA
        // LIST run fills the engine's copy of the data without touching the one
        // this object holds, so only say "no cases" when this really is an
        // analysis over an empty dataset.
        const inlineTailProblem = inlineDataTailProblem(requested)
        if (inlineTailProblem) throw new Error(inlineTailProblem)
        const { definesData, asksForResults, loadsData, changesData, filtersData, samplesData } = classifyScript(requested)
        const cases = this.dataset?.rows?.length ?? 0
        // Four mutually exclusive causes, in the order that points at the real
        // one. Each of them used to fall through to "no tables, no explanation",
        // or to the filter advice for a problem that had nothing to do with
        // filtering.
        // Some analysis commands are skipped without a word (see the helper):
        // there is nothing to parse, so the shape of the command itself is the
        // only evidence and it must be checked before blaming a filter.
        const silent = silentCommandProblem(requested)
        if (silent) throw new Error(silent)
        const filterAdvice = `这次运行没有产出任何表：内存里这份数据有 ${cases} 例，但引擎那边没有可分析的个案。常见原因是同一段语法里的筛选把个案全部筛掉了（SELECT IF、FILTER、条件 EXECUTE），或者变量名写错了导致整条命令被跳过；把筛选条件放宽或单独跑一次再看`
        if (asksForResults && loadsData && filtersData) {
          // Import plus filter, nothing left: the filter is what removed the
          // rows. Blaming the file sends the user to the wrong place when the
          // file was fine.
          throw new Error(filterAdvice)
        }
        if (asksForResults && loadsData) {
          // The script pulls data in and asks for results, and the engine still
          // printed nothing: the source it read was empty. Memory can hold cases
          // here (an earlier import), so this cannot be keyed on `cases === 0`.
          throw new Error('这次运行既导入/载入了数据又跑了分析，但引擎一条结果都没有产出：导入的那份数据是空的（0 例），或者路径没指到有内容的文件。检查文件里有没有数据行，再跑一次分析')
        }
        if (asksForResults && cases === 0 && !definesData) {
          throw new Error('这份数据集还没有个案（0 行）：引擎这次一条结果都没有产出。先在数据视图里录入数据或重新导入文件，再跑分析')
        }
        if (asksForResults && cases === 0 && changesData) {
          // COMPUTE on an empty dataset is legal and quiet: the engine reports
          // no error, so without this the output tree just stays blank.
          throw new Error('这份数据集还没有个案（0 行）：这段语法先改了数据、再在上面跑分析，引擎自然没有任何结果。先在数据视图里录入数据或重新导入文件，再跑分析')
        }
        // The rows in memory are not always the rows the engine used: a
        // SELECT IF or a filter in the same script can leave the engine with
        // nothing while this object still holds the old table. Saying "no
        // cases" there would be wrong, and saying nothing leaves the user
        // staring at an empty output tree.
        if (asksForResults && samplesData) {
          // SAMPLE draws a subset; drawing nothing is not a filter, and telling
          // someone to widen a filter he never wrote sends him the wrong way.
          throw new Error(`这次运行没有产出任何表：这段语法里的 SAMPLE 没有抽到任何个案（抽样比例太小，或者数据本来就少）。把比例放宽，或者去掉 SAMPLE 再跑一次`)
        }
        if (asksForResults && cases > 0) {
          throw new Error(filterAdvice)
        }

      }
      const runId = result.runId
      const items = parsed.map((item, index) => {
        // pspp writes absolute paths into <img src>; the artifact endpoint
        // only accepts the bare file name inside the run directory.
        const name = item.kind === 'image' ? basename(String(item.src ?? '')) : null
        return {
          ...item,
          name,
          id: `run-${runId}-${index}`,
          runId,
          // Replayed verbatim when this item goes into a report card.
          script: this.reportScript ? `${this.reportHeader}\n${this.reportScript}` : '',
          artifactUrl: name
            ? `/analytics/api/artifact?sessionId=${encodeURIComponent(this.id)}&runId=${encodeURIComponent(String(runId))}&name=${encodeURIComponent(name)}`
            : null,
          at: Date.now(),
        }
      })
      if (options.pairwise && typeof options.pairwise === 'object') {
        const hint = options.pairwise
        for (const item of items) {
          if (item.kind === 'table') item.pairwise = hint
        }
      }
      // A logistic run knows its outcome and predictors; carrying them on the
      // items lets the output offer "ROC 曲线…" without asking again.
      if (options.roc && typeof options.roc === 'object' && options.roc.by) {
        const hint = { by: String(options.roc.by), variables: (options.roc.variables ?? []).map(String) }
        for (const item of items) {
          if (item.kind === 'table') item.roc = hint
        }
      }
      if (retried.length > 0) {
        for (const text of retried) this.log.push({ at: Date.now(), text })
      }
        // Multi-factor designs cannot send /CONTRAST to the engine (PSPP's GLM
        // takes only MISSING/INTERCEPT/CRITERIA/METHOD/DESIGN), so the contrast
        // is fitted here on the same model the engine reported.
        if (options.contrasts && Array.isArray(options.contrasts.hypotheses) && options.contrasts.hypotheses.length > 0) {
          const builtContrasts = this.contrastTable(this.dataset, options.contrasts)
          if (builtContrasts) {
            const index = items.length
            items.push({
              kind: 'table',
              title: builtContrasts.title,
              table: { caption: builtContrasts.title, matrix: builtContrasts.matrix, notes: builtContrasts.notes },
              notes: builtContrasts.notes,
              name: null,
              id: `run-${runId}-${index}`,
              runId,
              script: '',
              artifactUrl: null,
              at: Date.now(),
            })
          }
        }
      const requestedModel = options.regression ?? requestedRegression(script)
      if (requestedModel && typeof requestedModel === 'object' && this.dataset) {
        // An explicit TOL request that survived gives the engine's own column;
        // do not print a second table underneath it. "Survived" is not the same
        // as "printed", though: PSPP 2.1.3 fills the column with .00 / +Infinit
        // when the fit is degenerate, so the numbers have to be finite and agree
        // with our own calculation before the engine's copy is trusted.
        const engineTol = engineTolerance(items)
        const built = collinearityTable(this.dataset, requestedModel)
        const trusted = engineTol !== null && tolerancesAgree(engineTol, built)
        if (engineTol !== null && !trusted) blankEngineTolerance(items)
        if (requestedModel.influence === true) {
          const influence = influenceTable(this.dataset, requestedModel)
          if (influence) {
            const index = items.length
            items.push({
              kind: 'table',
              title: influence.title,
              table: { caption: influence.title, matrix: influence.matrix, notes: influence.notes },
              notes: influence.notes,
              name: null,
              id: `run-${runId}-${index}`,
              runId,
              script: '',
              artifactUrl: null,
              at: Date.now(),
            })
          }
        }
        if (requestedModel.durbinWatson !== false) {
          const dw = durbinWatsonTable(this.dataset, requestedModel)
          if (dw) {
            const index = items.length
            items.push({
              kind: 'table',
              title: dw.title,
              table: { caption: dw.title, matrix: dw.matrix, notes: dw.notes },
              notes: dw.notes,
              name: null,
              id: `run-${runId}-${index}`,
              runId,
              script: '',
              artifactUrl: null,
              at: Date.now(),
            })
          }
        }
        if (built && !trusted) {
          const index = items.length
          items.push({
            kind: 'table',
            title: built.title,
            table: { caption: built.title, matrix: built.matrix, notes: built.notes },
            notes: engineTol === null
              ? built.notes
              : [
                '引擎这次也打印了容忍度，但数值不可用（PSPP 2.1.3 在退化拟合下会写 +Infinit 或 .00），以重算结果为准',
                ...built.notes,
              ],
            name: null,
            id: `run-${runId}-${index}`,
            runId,
            script: '',
            artifactUrl: null,
            at: Date.now(),
          })
        }
      }
      annotateSeparation(items)
      annotateNonFiniteCoefficients(items)
      annotateOversizedTables(items)
      // Cramér's V、Fisher 指向与 Kappa 的适用范围都挂在引擎自己打的那几张表上；
      // ICC 则是引擎给不了的表（PSPP 2.1.3 的 RELIABILITY 不收 /ICC=），单独追加。
      // The engine cannot do RISK on a string variable (it crashes, and the
      // statistics were dropped from the syntax), so the difference is still
      // computed here — but it must not also be reported as "the engine did not
      // print it", which the note below explains properly.
      annotateCrosstabs(items, {
        statistics: requestedCrosstabStatistics(syntax),
        forceRisk: Boolean(riskGuard),
        cmh: cmhGuard.requested,
        // 风险差的注文要写真实类别值（wave=1「第一波」/ 男、女），变量名与值标签
        // 只有数据集里有；表头打的是变量标签，靠它反查。
        dataset: this.dataset,
      })
      if (riskGuard && items.length > 0) {
        const target = items.find((item) => item.kind === 'table' && / × |×/.test(String(item.table?.caption ?? item.title ?? '')))
        if (target) {
          const reasons = []
          if (riskGuard.variables.length > 0) reasons.push(`对字符串变量（${riskGuard.variables.join('、')}）算风险估计会直接崩溃`)
          if (riskGuard.unknown.length > 0) reasons.push(`在表里出现 ${riskGuard.unknown.join('、')} 这种插件查不到类型的名字（内联表达式或临时变量）时也会崩溃`)
          const named = reasons.join('；同时')
          pushNote(target, `风险估计（RISK）没有发给引擎：PSPP 2.1.3 ${named}（段错误，整次运行没有任何输出），所以这次只跑了其余统计量。同表的「风险差（插件计算）」那一行就是插件按这张表的计数算出来的`)
        }
      }
      annotateExactTest(items, { exact: options.exact === true, exactChi: options.exactChi === true })
      annotateAssumptions(items)
      annotateNormality(items)
      annotateSampleSize(items, this.dataset, requestedModel)
      annotateComparisons(items)
      // Both notes have to see the script the engine actually ran: a WEIGHT BY
      // replayed from an earlier run is prepended to `script`, so asking them
      // about `requested` alone made them blame missing values for a weight.
      annotateWeightedEmpty(items, this.dataset, script)
      annotateZeroCases(items, this.dataset, script)
      // A /CONTRAST whose length differs from the number of factor levels is
      // dropped by the engine with only a stderr warning, so the table would
      // come back without the "Contrast Tests" block and look like a clean run.
      const contrastWarning = (diagnostics ?? []).find((entry) => /number of coefficients \(\d+\) does not equal the number of groups \(\d+\)/i.test(String(entry.message ?? '')))
      if (contrastWarning && items.length > 0) {
        const target = items.filter((item) => item.kind === 'table')
          .find((item) => /anova/i.test(String(item.table?.caption ?? item.title ?? ''))) ?? items.find((item) => item.kind === 'table')
        if (target) {
          pushNote(target, '对比被引擎忽略了：系数个数与因子水平数不一致（引擎只给了一行警告，不给 Contrast Tests 表）。写对比系数时每个因子水平一个数，例如三水平写 2 -1 -1。')
        }
      }
      // The guard inside wants the script the *user* typed: every run starts with
      // the plugin's own `GET FILE` header, and counting that as "this script
      // changes the data" meant ICC was never computed once a working file
      // existed. Replays (WEIGHT BY and friends) are caught by the case-count
      // comparison inside, which says something more useful than "not computed".
      annotateReliabilityIcc(items, this.dataset, requested, runId)
      // Tables and a rejected command can come back from the same run: the
      // engine prints what it managed to compute, so a pasted one-liner that
      // lost its second command looked like a clean result. Say it on the first
      // table, where a reader starts — `diagnostics` alone is not shown in the
      // panel.
      const rejected = diagnostics.filter((entry) => entry.severity === 'error')
      if (items.length > 0 && rejected.length > 0) {
        const target = items.find((item) => item.kind === 'table') ?? items[0]
        const raw = String(rejected[0].message ?? rejected[0].raw ?? '').trim()
        const first = explainMessage(raw) ? `${explainMessage(raw)}——引擎原文：${raw}` : raw
        pushNote(target, `引擎对这段语法报了 ${rejected.length} 处错误（第一处：${first}），下面这些结果只是它能算出来的那部分，别当成整段语法都跑通了`)
      }
      // appendItems stamps each item with the dataset it came from and returns
      // the stamped copies; the caller must hand *those* back, or the run
      // response carries items without a provenance stamp while the state
      // carries them with one.
      const stored = this.appendItems(items)
      if (log.length > 0) {
        this.log.push(...log.map((text) => ({ at: Date.now(), text })))
      }
      // PSPP 2.1.3 quirk: a regression with /STATISTICS=TOL exits non-zero with
      // "No valid data found. This command was skipped." while still writing
      // every table. Reporting that as an error makes a good result look broken,
      // so it is demoted to a note whenever the run produced output.
      if (items.length > 0) {
        for (const entry of diagnostics) {
          const text = String(entry.raw ?? entry.message ?? '')
          if (entry.severity === 'error' && /No valid data found/i.test(text) && /REGRESSION/i.test(text)) {
            entry.severity = 'note'
            entry.hint = entry.hint ?? 'PSPP 2.1.3 在带 TOL 的回归里会报这句，但表已完整产出，结果可用'
          }
        }
      }
      this.lastError = diagnostics.find((entry) => entry.severity === 'error') ?? null

      if (persist) await this.reloadFromWork()

      return {
        runId,
        // Same shape as state(): a caller reading item.notes should always find
        // a list, whether it looks at the run response or the panel state.
        items: stored.map((item) => (Array.isArray(item.notes) ? item : { ...item, notes: [] })),
        diagnostics,
        log,
        caseCount: this.dataset?.rows.length ?? 0,
        variables: this.dataset?.variables ?? [],
      }
        } finally {
          this.busyDepth -= 1
        }
      })
  }

  /**
   * Compute a chart from the in-memory dataset and render it as SVG.
   *
   * PSPP's graphs are fixed-style PNGs; drawing them here keeps the plugin's
   * output crisp and lets the panel show the same chart to the agent.
   */
  async addChart(kind, options = {}) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('no dataset is open')
      const chart = buildChartModel(this.dataset, kind, options)
      // Titles are built from templates so the dictionary can translate them;
      // the variable names inside stay exactly as the user named them. A title
      // the user typed is their own words and must not be translated — the
      // template is only what the chart was born with.
      if (options.title === undefined) {
        chart.title = localize(chart.title, this.liveConfig().uiLanguage === 'en' ? 'en' : 'zh')
      }
      // Remember which analysis this picture was drawn for. Export pairs a
      // chart with a table by this run id, not by "whatever table is above it",
      // which used to drop a distribution chart inside a regression table.
      const sourceRunId = options.sourceRunId ?? options.runId ?? this.lastRunId ?? null
      const tableId = options.tableId ?? null
      const chartSpec = {
        kind,
        variable: options.variable ?? null,
        by: options.by ?? null,
      }
      const runId = ++this.seq
      const dir = this.runDir(runId)
      await mkdir(dir, { recursive: true })
      const svg = renderSvg(chart)
      await writeFile(join(dir, 'chart.svg'), svg, 'utf8')
      await writeFile(join(dir, 'chart.json'), JSON.stringify({ kind, options, chart, sourceRunId, tableId }, null, 2), 'utf8')
      const item = {
        kind: 'image',
        title: chart.title,
        name: 'chart.svg',
        src: 'chart.svg',
        alt: `chart: ${chart.title}`,
        id: `chart-${runId}-0`,
        runId,
        sourceRunId: sourceRunId === null ? null : Number(sourceRunId),
        tableId,
        chartSpec,
        artifactUrl: `/analytics/api/artifact?sessionId=${encodeURIComponent(this.id)}&runId=${encodeURIComponent(String(runId))}&name=chart.svg`,
        at: Date.now(),
      }
      const [stored] = this.appendItems([item])
      this.log.push({ at: Date.now(), text: `图表：${chart.title}` })
      return { runId, item: stored, chart, svgPath: join(dir, 'chart.svg') }
    })
  }

  /**
   * Re-render an existing chart with different titles, colour or category
   * order. The numbers are recomputed from the same dataset and options, so an
   * edit never silently changes what the chart is about.
   */
  async updateChart(runId, patch = {}) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('no dataset is open')
      const id = Number(runId)
      if (!Number.isInteger(id) || id < 1) throw new Error(`unknown chart run: ${runId}`)
      const dir = this.runDir(id)
      let saved
      try {
        saved = JSON.parse(await readFile(join(dir, 'chart.json'), 'utf8'))
      } catch {
        throw new Error(`第 ${id} 次运行没有图表可以修改`)
      }
      const options = { ...(saved.options ?? {}) }
      for (const key of ['title', 'subtitle', 'xLabel', 'yLabel', 'accent', 'sortCategories']) {
        if (patch[key] === undefined) continue
        const value = typeof patch[key] === 'string' ? patch[key].trim() : patch[key]
        if (value === '' || value === 'none') delete options[key]
        else options[key] = value
      }
      const chart = buildChartModel(this.dataset, saved.kind ?? options.kind, options)
      if (options.title === undefined) {
        chart.title = localize(chart.title, this.liveConfig().uiLanguage === 'en' ? 'en' : 'zh')
      }
      const svg = renderSvg(chart)
      await writeFile(join(dir, 'chart.svg'), svg, 'utf8')
      await writeFile(join(dir, 'chart.json'), JSON.stringify({ kind: saved.kind ?? options.kind, options, chart }, null, 2), 'utf8')
      const stamp = Date.now()
      this.items = this.items.map((item) => (item.runId === id && item.kind === 'image'
        ? {
          ...item,
          title: chart.title,
          alt: `chart: ${chart.title}`,
          artifactUrl: `/analytics/api/artifact?sessionId=${encodeURIComponent(this.id)}&runId=${encodeURIComponent(String(id))}&name=chart.svg&v=${stamp}`,
        }
        : item))
      this.log.push({ at: stamp, text: `图表已修改：${chart.title}` })
      return { runId: id, chart, options, item: this.items.find((item) => item.runId === id && item.kind === 'image') ?? null }
    })
  }

  /**
   * Draw one of the regression diagnostics PSPP has no plot for.
   *
   * The model is the same least-squares fit the coefficient table comes from, so
   * the picture cannot disagree with the table; the chart is a normal output and
   * can be exported or bound into a report like any other.
   */
  async addRegressionPlot(kind, options = {}) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('没有打开的数据集：先打开数据再画回归诊断图')
      const regression = options.regression ?? {}
      const plots = regressionPlots(this.dataset, {
        dependent: regression.dependent ?? options.dependent,
        independents: regression.independents ?? options.independents ?? [],
      })
      if (plots.length === 0) {
        throw new Error('这张回归图算不出来：自变量不足、样本量太小，或者残差方差为 0')
      }
      const wanted = kind === 'pp' || kind === 'ppplot' ? 1 : 0
      const chart = plots[wanted]
      if (!chart) throw new Error('这张回归图算不出来：样本量不够')
      chart.title = localize(chart.title, this.liveConfig().uiLanguage === 'en' ? 'en' : 'zh')
      const runId = ++this.seq
      const dir = this.runDir(runId)
      await mkdir(dir, { recursive: true })
      const svg = renderSvg(chart)
      await writeFile(join(dir, 'chart.svg'), svg, 'utf8')
      await writeFile(join(dir, 'chart.json'), JSON.stringify({ kind: wanted === 1 ? 'pp' : 'residual', options: regression, chart, sourceRunId: this.lastRunId ?? null }, null, 2), 'utf8')
      const item = {
        kind: 'image',
        title: chart.title,
        name: 'chart.svg',
        src: 'chart.svg',
        alt: `chart: ${chart.title}`,
        id: `chart-${runId}-0`,
        runId,
        sourceRunId: this.lastRunId ?? null,
        tableId: null,
        chartSpec: { kind: 'regression', plot: wanted === 1 ? 'pp' : 'residual', dependent: regression.dependent ?? null },
        artifactUrl: `/analytics/api/artifact?sessionId=${encodeURIComponent(this.id)}&runId=${encodeURIComponent(String(runId))}&name=chart.svg`,
        at: Date.now(),
      }
      const [stored] = this.appendItems([item])
      this.log.push({ at: Date.now(), text: `图表：${chart.title}` })
      return { runId, item: stored, chart, svgPath: join(dir, 'chart.svg') }
    })
  }

  /**
   * Draw an existing chart again as another type, using the same variables.
   *
   * The old chart stays in the output tree: a histogram and a box plot of the
   * same variable are two answers to two questions, and deciding which one to
   * keep is the user's call, not the plugin's.
   */
  async redrawChart(runId, type) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('no dataset is open')
      const id = Number(runId)
      if (!Number.isInteger(id) || id < 1) throw new Error(`unknown chart run: ${runId}`)
      let saved
      try {
        saved = JSON.parse(await readFile(join(this.runDir(id), 'chart.json'), 'utf8'))
      } catch {
        throw new Error(`第 ${id} 次运行没有图表可以重绘`)
      }
      const kind = String(type ?? saved.kind ?? '').trim()
      if (!['bar', 'histogram', 'boxplot', 'line', 'pie', 'area', 'scatterplot'].includes(kind)) {
        throw new Error(`重绘的目标类型不认识：${type ?? '(空)'}`)
      }
      const options = { ...(saved.options ?? {}) }
      // A grid has no variables of its own to redraw; a scatterplot needs x/y
      // rather than variable, so the missing pieces are named instead of
      // letting the engine say "unknown variable: undefined".
      if (saved.kind === 'grid') throw new Error('拼版不能重绘成别的类型：先取消拼版，重画单图')
      const chart = buildChartModel(this.dataset, kind, options)
      if (options.title === undefined) {
        chart.title = localize(chart.title, this.liveConfig().uiLanguage === 'en' ? 'en' : 'zh')
      }
      const sourceRunId = saved.sourceRunId ?? id
      const nextId = ++this.seq
      const dir = this.runDir(nextId)
      await mkdir(dir, { recursive: true })
      const svg = renderSvg(chart)
      await writeFile(join(dir, 'chart.svg'), svg, 'utf8')
      await writeFile(join(dir, 'chart.json'), JSON.stringify({ kind, options, chart, sourceRunId, redrawnFrom: id }, null, 2), 'utf8')
      const item = {
        kind: 'image',
        title: chart.title,
        name: 'chart.svg',
        src: 'chart.svg',
        alt: `chart: ${chart.title}`,
        id: `chart-${nextId}-0`,
        runId: nextId,
        sourceRunId: sourceRunId === null ? null : Number(sourceRunId),
        tableId: saved.tableId ?? null,
        chartSpec: { kind, variable: options.variable ?? null, by: options.by ?? null, redrawnFrom: id },
        artifactUrl: `/analytics/api/artifact?sessionId=${encodeURIComponent(this.id)}&runId=${encodeURIComponent(String(nextId))}&name=chart.svg`,
        at: Date.now(),
      }
      const [stored] = this.appendItems([item])
      this.log.push({ at: Date.now(), text: `图表已重绘：${chart.title}` })
      return { runId: nextId, item: stored, chart, redrawnFrom: id, svgPath: join(dir, 'chart.svg') }
    })
  }

  /**
   * Bind several existing charts into one picture.
   *
   * The charts stay in the output tree as they are; the grid is one more output,
   * so a report can carry the four-up overview without losing the individual
   * charts. Order follows the ids the caller passes — the same order the panel
   * ticked them in.
   */
  async addChartGrid(ids, layout = '2x2', options = {}) {
    return this.mutex.run(async () => {
      const wanted = (Array.isArray(ids) ? ids : []).map((id) => String(id))
      if (wanted.length === 0) throw new Error('拼版至少要勾一张图')
      const charts = []
      for (const id of wanted) {
        const item = this.items.find((entry) => entry.id === id)
        if (!item) throw new Error(`有 ${wanted.length - charts.length} 张勾选的图已经不在输出树里了：刷新面板后重新勾选`)
        if (item.kind !== 'image') throw new Error(`「${item.title ?? id}」不是图，拼版只收图表`)
        const path = join(this.runDir(Number(item.runId)), 'chart.svg')
        let svg
        try {
          svg = await readFile(path, 'utf8')
        } catch {
          throw new Error(`「${item.title ?? id}」的图已经不在了（第 ${item.runId} 次运行的 chart.svg 被删了），重画一次再拼版`)
        }
        charts.push({ item, svg })
      }
      const svg = composeChartGrid(charts.map((entry) => entry.svg), layout, options)
      const runId = ++this.seq
      const dir = this.runDir(runId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'chart.svg'), svg, 'utf8')
      const layoutName = layout === '1x2' ? '1 × 2' : layout === '2x1' ? '2 × 1' : '2 × 2'
      const title = `${layoutName} 拼版（${charts.length} 张图）`
      const item = {
        kind: 'image',
        title,
        name: 'chart.svg',
        src: 'chart.svg',
        alt: `chart: ${title}`,
        id: `chart-${runId}-0`,
        runId,
        sourceRunId: null,
        tableId: null,
        chartSpec: { kind: 'grid', layout, sources: charts.map((entry) => entry.item.id) },
        artifactUrl: `/analytics/api/artifact?sessionId=${encodeURIComponent(this.id)}&runId=${encodeURIComponent(String(runId))}&name=chart.svg`,
        at: Date.now(),
      }
      const [stored] = this.appendItems([item])
      this.log.push({ at: Date.now(), text: `图表拼版：${title}` })
      return { runId, item: stored, svgPath: join(dir, 'chart.svg'), charts: charts.length, layout }
    })
  }

  /**
   * Write one of this dataset's charts to a file.
   *
   * The SVG is copied as stored; the PNG is rasterised here rather than in the
   * browser so the agent can export a chart too. `runId` may come from a URL
   * produced by `api/chart` (the `runId=` query parameter), which is what the
   * panel's chart buttons hand over.
   * @param {{ runId?: number|string, url?: string, path: string, format?: string, scale?: number }} options
   */
  async exportChart(options = {}) {
    const path = String(options.path ?? '').trim()
    if (!path) throw new Error('exportChart needs a path')
    const resolved = isAbsolute(path) ? path : resolve(this.cwd, path)
    const format = (options.format ?? extname(resolved).slice(1) ?? '').toLowerCase()
    if (format !== 'png' && format !== 'svg') throw new Error('图表只能导出为 .png 或 .svg')
    let runId = options.runId
    if (runId === undefined || runId === null || runId === '') {
      const found = /[?&]runId=(\d+)/.exec(String(options.url ?? ''))
      if (!found) throw new Error('exportChart needs a runId or the url of a chart')
      runId = found[1]
    }
    const id = Number(runId)
    if (!Number.isInteger(id) || id < 1) throw new Error(`unknown chart run: ${runId}`)
    const dir = this.runDir(id)
    let svg
    try {
      svg = await readFile(join(dir, 'chart.svg'), 'utf8')
    } catch {
      throw new Error(`第 ${id} 次运行没有图表可以导出`)
    }
    const scale = Number(options.scale) > 0 ? Math.min(4, Number(options.scale)) : 1
    const bytes = format === 'png' ? svgToPng(svg, scale) : Buffer.from(svg, 'utf8')
    await ensureParentDir(resolved)
    await writeFile(resolved, bytes)
    this.log.push({ at: Date.now(), text: `图表已导出：${resolved}` })
    return { path: resolved, format, bytes: bytes.length }
  }

  async save(inputPath, options = {}) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('no dataset is open')
      const target = inputPath ? this.resolvePath(inputPath) : this.dataset.sourcePath
      if (!target) throw new Error('no target path given and the dataset has no source file')
      if (!inputPath && this.dataset.temporary === true) {
        throw new Error('这份数据来自拖入的文件副本，还没有对应的磁盘文件：请用「另存为…」选择保存位置')
      }
      // The data view loads at most maxRows cases. Writing that subset back
      // over the file would silently delete every case past the limit, so a
      // truncated dataset may only be saved when the caller says so.
      if (this.dataset.truncated === true && options?.force !== true) {
        throw new Error(`这份数据超过 ${this.maxRows} 个个案，面板里只载入了前 ${this.maxRows} 个：现在保存会把后面的个案丢掉。要保住全部数据请用「导出为 CSV」或直接在引擎里跑语法；确实只保存前 ${this.maxRows} 个就加 force: true`)
      }
      // force reaches workSav too: the message above tells the caller to pass
      // it, and the flush below used to hit the same guard again and refuse.
      const workPath = await this.workSav({ force: options?.force === true })
      if (resolve(target) === resolve(workPath)) {
        return { path: target, caseCount: this.dataset.rows.length }
      }
      // Write into an ASCII staging file first: the Windows engine cannot open a
      // Chinese target, and the CSV side-car it reads would sit in that folder
      // too. Node copies the finished .sav to the real path afterwards.
      // Target folders are created on demand, the same way exporting a chart or
      // an Office document already did: "save to D:\新文件夹\a.sav" is a normal
      // thing to type, and ENOENT from a folder the user has not made yet reads
      // as "the path is wrong" rather than "the folder is missing".
      await ensureParentDir(target)
      const staged = await stageOutput(target, this.ioDir)
      const temp = `${staged.path}.tmp-${process.pid}-${Date.now()}`
      try {
        await writeSav((script, options) => this.exec(script, options), {
          variables: this.dataset.variables,
          rows: this.dataset.rows,
        }, temp)
        await rename(temp, staged.path)
        // Multiple response sets live in the dictionary, not in the rows, so
        // they have to be replayed onto the file that was just written.
        if (this.mrSets.length > 0) await this.persistMrSetsTo(staged.path)
        await staged.commit()
      } catch (error) {
        // A failed save must not leave `<target>.tmp-<pid>-<stamp>` beside the
        // user's data file: the temp system file is ours, so remove it here.
        await rm(temp, { force: true }).catch(() => { /* best effort */ })
        await staged.dispose()
        // The error names the staging file inside our own work directory; the
        // user needs the path they actually asked to save to.
        throw new Error(describeFsError(error, target))
      }
      this.dataset.sourcePath = target
      this.dataset.temporary = false
      this.dataset.name = displayName(target)
      this.dataset.origin = 'file'
      // Saving writes a new file, so the fingerprint has to follow it: leaving
      // the old size/mtime (or null after 另存为 of a built dataset) would make
      // every table stamp point at a version of the data that never existed.
      try {
        const info = await stat(target)
        this.dataset.sourceSize = Number(info.size) > 0 ? Number(info.size) : null
        this.dataset.sourceMtime = Math.round(Number(info.mtimeMs)) || null
      } catch {
        this.dataset.sourceSize = null
        this.dataset.sourceMtime = null
      }
      await this.rememberDataset()
      this.log.push({ at: Date.now(), text: `保存数据：${target}` })
      return { path: target, caseCount: this.dataset.rows.length, variables: this.dataset.variables.length }
    })
  }

  /**
   * Re-run the most recent syntax into a printable document.
   * The engine writes PDF/ODT directly; the file is then copied to the
   * requested path. Replaying is safe for read-only procedures, which is
   * what the menu offers this for.
   */
  /**
   * The picture bytes behind the image items on screen.
   *
   * A chart drawn by this plugin lives in its run directory as SVG; PSPP's own
   * graphs are PNG already. Both have to become PNG to go inside a .docx or
   * .xlsx, and the URL is the only handle the item carries.
   */
  async loadOutputImages(items) {
    const loaded = []
    const seen = new Set()
    for (const item of items) {
      if (item.kind !== 'image') continue
      const url = item.artifactUrl ?? item.url
      if (!url || seen.has(url)) continue
      seen.add(url)
      const match = /runId=([^&]+).*?name=([^&]+)/.exec(url)
      if (!match) continue
      // The URL is untrusted input as far as this method is concerned: keep
      // the two segments to a run number and a bare file name so a crafted
      // item cannot pull arbitrary file bytes into an exported document.
      const runDir = decodeURIComponent(match[1])
      const fileName = decodeURIComponent(match[2])
      if (!/^\d+$/.test(runDir) || !/^[A-Za-z0-9._-]+$/.test(fileName) || fileName.includes('..')) continue
      const file = join(this.runDir(Number(runDir)), fileName)
      try {
        const raw = await readFile(file)
        const bytes = /\.svg$/i.test(file) ? svgToPng(raw.toString('utf8'), 2) : raw
        const size = pngSize(bytes)
        loaded.push({ url, bytes, width: size.width, height: size.height })
      } catch {
        /* the artifact is gone; the writer puts 图表缺失 in its place */
      }
    }
    return loaded
  }

  /**
   * Notes as engine lines, for the exports PSPP writes itself.
   *
   * The .docx and .xlsx writers lay notes out themselves, but a PDF/ODT/.spv is
   * produced by the engine, so the only way to carry the caveats into it is to
   * append ECHO statements: PSPP prints those as ordinary paragraphs, Chinese
   * included.
   */
  notesEchoScript(items = null, onlyRunId = null) {
    const source = Array.isArray(items) && items.length > 0 ? items : this.state().items
    // The document replays one run; a note written for a table that is not in
    // that run would describe a table the reader cannot find.
    const list = onlyRunId === null || onlyRunId === undefined
      ? source
      : source.filter((item) => Number(item.runId) === Number(onlyRunId))
    const lines = []
    for (const item of list) {
      const notes = Array.isArray(item.notes) ? item.notes : []
      for (const note of notes) {
        const text = String(note ?? '').trim()
        if (!text) continue
        const title = String(item.table?.caption ?? item.title ?? '').trim()
        const label = title ? `${title}：` : ''
        lines.push(`ECHO '${`注：${label}${text}`.replace(/'/g, "''").replace(/\s*\n\s*/g, ' ')}'.`)
      }
    }
    return lines.join('\n')
  }

  /**
   * The distinct datasets behind a list of output items, for the metadata an
   * exported file carries. Two tables from the same session and the same file
   * are one source, not two.
   */
  sourcesOf(items = []) {
    const seen = new Map()
    for (const item of items) {
      const from = item?.provenance
      if (!from) continue
      const key = [from.sessionId, from.origin ?? '', from.sourcePath ?? '', from.openedAt ?? ''].join('|')
      if (!seen.has(key)) seen.set(key, from)
    }
    if (seen.size === 0 && this.dataset) seen.set('current', this.provenance())
    return [...seen.values()]
  }

  async exportOffice(inputPath, items = null, options = {}) {
    return this.mutex.run(async () => {
      const target = this.resolvePath(inputPath)
      const ext = extname(target).toLowerCase()
      if (ext !== '.docx' && ext !== '.xlsx') throw new Error('导出格式只能是 .docx 或 .xlsx')
      const scope = options.scope === 'last' ? 'last' : 'session'
      const all = this.state().items
      const list = Array.isArray(items) && items.length > 0
        ? items
        : scope === 'last'
          ? this.lastRunItems(all)
          : all
      if (!list.some((item) => item.kind === 'table' || item.kind === 'image')) {
        throw new Error('还没有可导出的输出：先运行一次分析')
      }
      let images = []
      try { images = await this.loadOutputImages(list) } catch { images = [] }
      let bytes
      if (ext === '.xlsx') {
        // Excel floats a picture over the grid, so the sheet reserves the rows
        // and anchors it to the table's first cell (oneCellAnchor).
        bytes = buildXlsx({
          items: list,
          images,
          formulas: options.formulas !== false,
          data: options.data === true ? this.caseData() : null,
          sources: this.sourcesOf(list),
          style: this.liveConfig().tableStyle,
          maxRows: this.liveConfig().maxExportRows,
          lang: this.liveConfig().uiLanguage,
        })
      } else {
        bytes = buildDocx({
          title: `${this.dataset?.name ?? localize('统计输出', this.liveConfig().uiLanguage)} · ${localize('PSPP 输出', this.liveConfig().uiLanguage)}`,
          items: list,
          images,
          sources: this.sourcesOf(list),
          style: this.liveConfig().tableStyle,
          maxRows: this.liveConfig().maxExportRows,
          lang: this.liveConfig().uiLanguage,
        })
      }
      await ensureParentDir(target)
      try {
        await writeFile(target, bytes)
      } catch (error) {
        throw new Error(describeFsError(error, target))
      }
      return {
        path: target,
        format: ext.slice(1),
        bytes: bytes.length,
        tables: list.filter((item) => item.kind === 'table').length,
        images: list.filter((item) => item.kind === 'image').length,
      }
    })
  }

  /**
   * The cases as they stand in the working file, shaped for a spreadsheet:
   * variable names as the header, one row per case. A hidden sheet of this is
   * what lets a reader recompute means and SDs, which no printed table carries.
   */
  caseData(limit = 20000) {
    if (!this.dataset) return null
    const variables = this.dataset.variables ?? []
    const rows = (this.dataset.rows ?? []).slice(0, limit)
    return {
      variables: variables.map((variable) => ({ name: variable.name, label: variable.label ?? '' })),
      rows,
      truncated: (this.dataset.rows ?? []).length > rows.length,
    }
  }

  /** Write free text (an exported table, a note) to a real path. */
  async writeText(inputPath, text) {
    const target = this.resolvePath(inputPath)
    assertTextTarget(target)
    await ensureParentDir(target)
    try {
      await writeFile(target, text, 'utf8')
    } catch (error) {
      throw new Error(describeFsError(error, target))
    }
    const info = await stat(target)
    return { path: target, bytes: info.size }
  }

  async exportDocument(inputPath, format = 'pdf') {
    return this.mutex.run(async () => {
      if (!this.lastScript) throw new Error('还没有可导出的输出：先运行一次分析')
      const exported = this.state().items.filter((item) => item.kind === 'table' || item.kind === 'image')
      if (exported.length === 0) {
        throw new Error('这次输出里没有表格也没有图：先运行一个会出结果的分析，再导出 PDF/ODT')
      }
      const target = this.resolvePath(inputPath)
      const ext = extname(target).toLowerCase()
      // .spv is the SPSS output container: the same archive SPSS itself writes,
      // so a PSPP run can be reopened in SPSS and pasted into a report.
      if (ext !== '.pdf' && ext !== '.odt' && ext !== '.spv') throw new Error('导出格式只能是 .pdf、.odt 或 .spv')
      const kind = ext.slice(1)
      await ensureParentDir(target)
      const notes = kind === 'spv' ? '' : this.notesEchoScript(null, this.lastRunId)
      // The replay is a fresh run of the same syntax, so it hits the same engine
      // crashes: a crosstab of a string group with RISK killed PSPP when the user
      // ran it, and re-running it verbatim would kill the export too (the panel
      // only ever saw the guarded script). Guard the replay the same way.
      const guarded = guardForReplay(this.dataset ? this.lastScript : this.lastScript, this.dataset)
      const result = await this.exec(notes ? `${guarded}\n${notes}\n` : guarded, {
        outName: 'export',
        format: kind,
        // A .spv is a zip of XML, not text: reading it as UTF-8 would waste the
        // whole archive and leave `outputHtml` garbage.
        collectOutput: kind !== 'spv',
      })
      if (result.code !== 0) {
        const reason = String(result.stderr ?? '').trim().split('\n')[0] || `退出码 ${result.code}`
        throw new Error(`导出失败：${reason}`)
      }
      const produced = join(this.runDir(result.runId), `export.${kind}`)
      await assertSpvHasTables(produced, kind)
      try {
        await copyFile(produced, target)
      } catch (error) {
        throw new Error(describeFsError(error, target))
      }
      const info = await stat(target)
      this.log.push({ at: Date.now(), text: `导出输出（${kind}）：${target}` })
      return { path: target, format: kind, bytes: info.size }
    })
  }

  /**
   * Re-run one past script into a document.
   *
   * The report card replays the exact syntax behind each table the user
   * ticked, so the document holds those results and nothing else — PSPP
   * writes the whole run, charts included, and does not need a PDF writer
   * here.
   */
  async exportScript(inputPath, script, format = 'pdf') {
    return this.mutex.run(async () => {
      const text = String(script ?? '').trim()
      if (!text) throw new Error('报告卡里还没有可导出的内容：先勾选几个结果')
      const target = this.resolvePath(inputPath)
      const ext = extname(target).toLowerCase()
      if (ext !== '.pdf' && ext !== '.odt' && ext !== '.spv') throw new Error('导出格式只能是 .pdf、.odt 或 .spv')
      const kind = ext.slice(1)
      await ensureParentDir(target)
      const notes = kind === 'spv' ? '' : this.notesEchoScript()
      const guarded = this.dataset ? guardForReplay(text, this.dataset) : text
      const result = await this.exec(notes ? `${guarded}\n${notes}\n` : `${guarded}\n`, {
        outName: 'report',
        format: kind,
        collectOutput: kind !== 'spv',
      })
      if (result.code !== 0) {
        const reason = String(result.stderr ?? '').trim().split('\n')[0] || `退出码 ${result.code}`
        throw new Error(`导出失败：${reason}`)
      }
      const produced = join(this.runDir(result.runId), `report.${kind}`)
      await assertSpvHasTables(produced, kind)
      try {
        await copyFile(produced, target)
      } catch (error) {
        throw new Error(describeFsError(error, target))
      }
      const info = await stat(target)
      this.log.push({ at: Date.now(), text: `导出报告卡（${kind}）：${target}` })
      return { path: target, format: kind, bytes: info.size }
    })
  }

  /**
   * 选中的表与图汇编成一份报告（封面 / 目录 / 表号），而不是重放语法。
   *
   * exportOffice() 是"把输出树倒出来"，exportScript() 是"把这些分析再跑一遍"。
   * 这份是第三种：表格已经算好了，用户勾的那几张连同编号排成一册，交出去就能读
   * —— 封面写明标题、数据与生成时间，目录列出表号，避免读的人自己数。
   *
   * @param {string} inputPath 目标 .docx 或 .html
   * @param {string[]} ids 输出条目 id（顺序即成册顺序）
   * @param {object} [options] { title, subtitle }
   */
  async exportReportBook(inputPath, ids, options = {}) {
    return this.mutex.run(async () => {
      const target = this.resolvePath(inputPath)
      const ext = extname(target).toLowerCase()
      if (ext !== '.docx' && ext !== '.html' && ext !== '.htm') {
        throw new Error('报告成册的格式只能是 .docx 或 .html（要重放成 PDF 请用「导出报告卡…」）')
      }
      const wanted = Array.isArray(ids) ? ids.map(String) : []
      if (wanted.length === 0) throw new Error('报告里还没有内容：在输出树里勾选要装订的表或图')
      const all = this.state().items
      const byId = new Map(all.map((item) => [item.id, item]))
      // The tick order is the reading order, so an id that has gone (a cleared
      // run) is an error rather than something to silently skip: a report with a
      // table missing and the numbering closed up is worse than one that says so.
      const missing = wanted.filter((id) => !byId.has(id))
      if (missing.length > 0) {
        throw new Error(`有 ${missing.length} 个勾选的输出已经不在输出树里了：刷新面板后重新勾选`)
      }
      const list = wanted.map((id) => byId.get(id))
      if (!list.some((item) => item.kind === 'table' || item.kind === 'image')) {
        throw new Error('勾选的条目里没有表或图：报告成册只装表格与图表')
      }
      let images = []
      try { images = await this.loadOutputImages(list) } catch { images = [] }
      const lang = this.liveConfig().uiLanguage
      const title = String(options.title ?? '').trim() || (this.dataset?.name ?? localize('统计分析报告', lang))
      const subtitle = String(options.subtitle ?? '').trim()
      const meta = {
        dataset: this.dataset ? `${localize('数据集：', lang)}${this.dataset.name ?? ''}` : '',
        generatedAt: `${localize('生成于 ', lang)}${readableTime(Date.now())}`,
        engine: `GNU PSPP 2.1.3 · dsh-analytics ${pluginInfo().version ?? ''}`.trim(),
      }
      const shared = {
        title,
        subtitle,
        items: list,
        images,
        sources: this.sourcesOf(list),
        meta,
        style: this.liveConfig().tableStyle,
        maxRows: this.liveConfig().maxExportRows,
        lang,
      }
      const bytes = ext === '.docx' ? buildReportDocx(shared) : Buffer.from(buildReportHtml(shared), 'utf8')
      await ensureParentDir(target)
      try {
        await writeFile(target, bytes)
      } catch (error) {
        throw new Error(describeFsError(error, target))
      }
      const info = await stat(target)
      const tables = list.filter((item) => item.kind === 'table').length
      const figures = list.filter((item) => item.kind === 'image').length
      this.log.push({ at: Date.now(), text: `报告成册（${tables} 表 ${figures} 图）：${target}` })
      return { path: target, bytes: info.size, tables, figures, format: ext === '.docx' ? 'docx' : 'html' }
    })
  }

  /**
   * 多因子设计的自定义对比：设计矩阵与广义线性假设检验都在插件里算。
   *
   * PSPP 的 GLM 只认 MISSING/INTERCEPT/CRITERIA/METHOD/DESIGN，`/CONTRAST` 是
   * 语法错，所以单因子走 ONEWAY（引擎自己给 Contrast Tests），多因子没有引擎
   * 通路 —— 这里按同一张设计矩阵做 Lβ 与 F。因子主效应的权重用等权（与 SPSS
   * 的 Type III 一致），否则主效应会随另一因子的样本量倾斜。
   */
  contrastTable(dataset, request) {
    const spec = request ?? {}
    const list = Array.isArray(spec.hypotheses) ? spec.hypotheses : []
    const dependent = spec.dependent
    const factors = Array.isArray(spec.factors) ? spec.factors : []
    const covariates = Array.isArray(spec.covariates) ? spec.covariates : []
    if (!dependent || factors.length === 0) return null
    const model = designColumns(dataset, { dependent, factors, covariates, interactions: true, intercept: true })
    if (!model) return null
    const names = model.names
    const levels = model.levels ?? {}
    const weightFor = (factor) => {
      const count = Array.isArray(levels[factor]) ? levels[factor].length : 0
      return count > 0 ? 1 / count : 0
    }
    // A column name is a product of `factor[level]` terms; the coefficient of the
    // hypothesis's own factor comes from the user, the other factors get equal
    // weight over their levels (that is what makes it a Type III style test).
    const buildRow = (term) => {
      const target = String(term.factor ?? '')
      const coefficients = Array.isArray(term.coefficients) ? term.coefficients.map(Number) : []
      const targetLevels = Array.isArray(levels[target]) ? levels[target] : []
      if (targetLevels.length === 0 || coefficients.length !== targetLevels.length) return null
      const row = names.map((name) => {
        const parts = String(name).split('*').map((part) => {
          const match = part.match(/^(.+)\[(.+)\]$/)
          return match ? { factor: match[1], level: match[2] } : { factor: part, level: null }
        })
        let value = 1
        let seen = false
        for (const part of parts) {
          if (part.level === null) {
            // Intercept or covariate: a contrast on a factor does not touch it.
            if (part.factor === 'Intercept') continue
            return 0
          }
          if (part.factor === target) {
            const at = targetLevels.map(String).indexOf(part.level)
            if (at < 0) return 0
            value *= coefficients[at]
            seen = true
          } else {
            value *= weightFor(part.factor)
          }
        }
        return seen ? value : 0
      })
      return row
    }
    const prepared = []
    for (const entry of list) {
      const term = entry?.term ?? {}
      const row = buildRow(term)
      const label = entry?.label ?? `${term.factor} 的对比`
      if (!row) {
        prepared.push({ label, reason: `系数个数要等于 ${term.factor} 的水平数（${(levels[term.factor] ?? []).length} 个）` })
        continue
      }
      prepared.push({ label, coefficients: row })
    }
    const results = generalLinearTest(model, prepared.map((entry) => (
      entry.coefficients ? entry : { label: entry.label, coefficients: names.map(() => 0) }
    )))
    // The module only knows the numbers; a wrong coefficient count is reported as
    // "not estimable" with its own reason, so keep the explanation we already had.
    const lines = results.map((result, index) => {
      const intended = prepared[index]
      if (intended && !intended.coefficients) {
        return `自定义对比（插件计算）：「${intended.label}」：不可估（${intended.reason}）`
      }
      return describeContrasts(result)
    })
    const matrix = [['对比', '估计', '标准误', 't', 'df', 'p']]
    results.forEach((result, index) => {
      const label = prepared[index]?.label ?? result.label ?? `对比 ${index + 1}`
      if (result.ok !== true) {
        matrix.push([label, '—', '—', '—', '—', '—'])
        return
      }
      matrix.push([
        label,
        Number(result.estimate).toFixed(3),
        Number(result.se).toFixed(3),
        Number(result.t).toFixed(3),
        String(result.df2),
        Number(result.p) < 0.001 ? '< .001' : Number(result.p).toFixed(3),
      ])
    })
    return {
      title: '自定义对比（插件计算）',
      matrix,
      notes: [
        ...model.notes ?? [],
        ...(model.dropped > 0 ? [`按 listwise 删掉 ${model.dropped} 个个案（少一个变量就等于少一个观测）`] : []),
        '主效应用等权组合（与 SPSS 的 Type III 一致）：模型里有交互项时，直接读交互项那一列等于只看参照水平，所以这里按各水平均分。',
        '因变量与因子都按变量名匹配；字符串因子按水平编码成哑变量，第一个水平作参照。',
        ...lines,
      ],
    }
  }

  async exportCsv(inputPath) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('no dataset is open')
      const target = this.resolvePath(inputPath)
      const workPath = await this.workSav()
      await ensureParentDir(target)
      const staged = await stageOutput(target, this.ioDir)
      try {
        const script = [
          `GET FILE=${quoteSyntaxPath(workPath)}.`,
          `SAVE TRANSLATE /OUTFILE=${quoteSyntaxPath(staged.path)} /TYPE=CSV /REPLACE.`,
        ].join('\n') + '\n'
        const result = await this.exec(script, { outName: 'export', env: { LC_ALL: 'C', LANG: 'C' }, collectOutput: false })
        if (result.code !== 0) throw new Error(`导出失败：${describeEngineError(result.stderr, basename(target), result.code)}`)
        await staged.commit()
      } catch (error) {
        await staged.dispose()
        throw error
      }
      this.log.push({ at: Date.now(), text: `导出 CSV：${target}` })
      return { path: target }
    })
  }

  async runAndPersist(syntax, options = {}) {
    return this.runSyntax(syntax, { ...options, persist: true })
  }

  /* ---------------------------------------------------------------- editing */

  /** Normalise one incoming value for a variable and validate the cell. */
  resolveCell(rowIndex, variableName, value) {
    if (!this.dataset) throw new Error('no dataset is open')
    const column = this.dataset.variables.findIndex((variable) => variable.name === variableName)
    if (column < 0) throw new Error(`unknown variable: ${variableName}`)
    const row = Number(rowIndex)
    if (!Number.isInteger(row) || row < 0 || row >= this.dataset.rows.length) throw new Error(`row out of range: ${rowIndex}`)
    const variable = this.dataset.variables[column]
    let parsed = value
    if (value === null || value === undefined || value === '') parsed = null
    else if (variable.type === 'numeric') {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) throw new Error(`${variableName} expects a number`)
      parsed = numeric
    } else {
      parsed = String(value)
    }
    return { row, column, variable: variableName, value: parsed }
  }

  setCell(rowIndex, variableName, value) {
    this.assertEditable()
    const cell = this.resolveCell(rowIndex, variableName, value)
    const before = this.dataset.rows[cell.row][cell.column] ?? null
    this.pushCellHistory(cell.row, cell.column, before, cell.value)
    this.dataset.rows[cell.row][cell.column] = cell.value
    this.dataset.dirty = true
    return { row: cell.row, variable: cell.variable, value: cell.value }
  }

  /** Paste a rectangular block: all cells are validated before any is written. */
  setCells(cells, options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    if (!Array.isArray(cells) || cells.length === 0) throw new Error('no cells to paste')
    // Pasting a block from a spreadsheet routinely runs past the last case and
    // past the last variable. Growing the table here (instead of rejecting the
    // paste) is what makes a copied rectangle actually land.
    let addedCases = 0
    let addedVariables = 0
    if (options.extend) {
      const wantedRows = Math.max(...cells.map((cell) => Number(cell?.row) + 1).filter(Number.isFinite), 0)
      // A pasted block that runs past the last variable names the new columns
      // V<n>; those placeholders carry the position, so resolve both forms.
      const wantedColumns = Math.max(...cells.map((cell) => {
        const name = cell?.variable
        const at = this.dataset.variables.findIndex((entry) => entry.name === name)
        if (Number.isFinite(at) && at >= 0) return at + 1
        const placeholder = /^V(\d+)$/.exec(String(name ?? ''))
        return placeholder ? Number(placeholder[1]) : 0
      }), 0)
      while (this.dataset.rows.length < wantedRows) {
        this.dataset.rows.push(this.dataset.variables.map(() => null))
        addedCases += 1
      }
      while (this.dataset.variables.length < wantedColumns) {
        const taken = new Set(this.dataset.variables.map((entry) => entry.name))
        let index = this.dataset.variables.length + 1
        while (taken.has(`V${index}`)) index += 1
        this.dataset.variables.push({
          name: `V${index}`,
          label: '',
          position: this.dataset.variables.length + 1,
          type: 'numeric',
          width: 8,
          decimals: 2,
          format: 'F8.2',
          measure: 'scale',
          role: 'input',
          alignment: 'right',
          missing: [],
          valueLabels: {},
        })
        addedVariables += 1
      }
    }
    const resolved = cells.map((cell) => this.resolveCell(cell?.row, cell?.variable, cell?.value))
    this.pushHistory(`粘贴 ${resolved.length} 个单元格`)
    for (const cell of resolved) this.dataset.rows[cell.row][cell.column] = cell.value
    this.dataset.dirty = true
    return { updated: resolved.length, addedCases, addedVariables }
  }

  /**
   * Append several cases at once (one undo step).
   *
   * The tool path uses this for a pasted table: calling appendCase in a loop
   * would push one snapshot per row into the undo stack and make undo walk
   * backwards one line at a time.
   */
  appendCases(cases = []) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const list = Array.isArray(cases) ? cases : []
    if (list.length === 0) throw new Error('没有要追加的个案')
    const rows = list.map((entry) => coerceRow(entry, this.dataset.variables))
    this.pushHistory(`追加 ${rows.length} 个个案`)
    this.dataset.rows.push(...rows)
    this.dataset.dirty = true
    return { added: rows.length, cases: this.dataset.rows.length }
  }

  appendCase(values = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    // Accept either a name-keyed object or a positional array.
    const keyed = Array.isArray(values)
      ? Object.fromEntries(this.dataset.variables.map((variable, index) => [variable.name, values[index]]))
      : values ?? {}
    const row = this.dataset.variables.map((variable) => {
      const raw = keyed[variable.name]
      if (raw === undefined || raw === null || raw === '') return null
      if (variable.type === 'numeric') {
        const numeric = Number(raw)
        return Number.isFinite(numeric) ? numeric : null
      }
      return String(raw)
    })
    this.pushHistory('插入个案')
    this.dataset.rows.push(row)
    this.dataset.dirty = true
    return { index: this.dataset.rows.length - 1 }
  }

  /** Insert one case at `index` (append when index is omitted/out of range). */
  insertCase(index, values = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const keyed = Array.isArray(values)
      ? Object.fromEntries(this.dataset.variables.map((variable, at) => [variable.name, values[at]]))
      : values ?? {}
    const row = this.dataset.variables.map((variable) => {
      const raw = keyed[variable.name]
      if (raw === undefined || raw === null || raw === '') return null
      if (variable.type === 'numeric') {
        const numeric = Number(raw)
        return Number.isFinite(numeric) ? numeric : null
      }
      return String(raw)
    })
    const at = Number.isInteger(index) ? Math.max(0, Math.min(Number(index), this.dataset.rows.length)) : this.dataset.rows.length
    this.pushHistory('插入个案')
    this.dataset.rows.splice(at, 0, row)
    this.dataset.dirty = true
    return { index: at, cases: this.dataset.rows.length }
  }

  /** Stable multi-key sort of the owned rows; nulls always sort last. */
  sortCases(keys = []) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const columns = keys
      .map((key) => ({ index: this.dataset.variables.findIndex((variable) => variable.name === key.name), descending: key.order === 'd' }))
      .filter((key) => key.index >= 0)
    if (columns.length === 0) throw new Error('no sort keys')
    const compare = (left, right) => {
      for (const { index, descending } of columns) {
        const a = left[index]
        const b = right[index]
        if (a === b) continue
        if (a === null || a === undefined) return 1
        if (b === null || b === undefined) return -1
        const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh-CN')
        if (result !== 0) return descending ? -result : result
      }
      return 0
    }
    this.pushHistory('排序个案')
    this.dataset.rows = this.dataset.rows.map((row, order) => ({ row, order }))
      .sort((left, right) => compare(left.row, right.row) || left.order - right.order)
      .map((entry) => entry.row)
    this.dataset.dirty = true
    return { cases: this.dataset.rows.length, keys: columns.length }
  }

  /** Transpose the dataset through PSPP's own FLIP command. */
  async flip(options = {}) {
    if (!this.dataset) throw new Error('no dataset is open')
    const strings = this.dataset.variables.filter((variable) => variable.type === 'string')
    if (strings.length > 0 && options.force !== true) {
      const names = strings.map((variable) => variable.name).join('、')
      throw new Error(`转置会丢掉字符串变量的内容：PSPP 的 FLIP 只保留数值列，${names} 在转置后会变成缺失值（变量名也会变成 VAR000、VAR001…）。要保住内容请先把它们「重新编码为不同变量」成数值；确实要转置就在面板里勾「我明白」，对话里传 force: true`)
    }
    const result = await this.runSyntax('FLIP.', { persist: true, historyLabel: '转置' })
    const failed = (result.diagnostics ?? []).find((entry) => entry.severity === 'error')
    if (failed) throw new Error(failed.message)
    return { variables: this.dataset.variables.length, cases: this.dataset.rows.length }
  }

  /**
   * Restructuring replaces the whole matrix, so it cannot run on a truncated
   * one: the cases that were never loaded would simply disappear.
   */
  assertRestructurable() {
    if (this.dataset?.truncated === true) {
      const loaded = (this.dataset.rows ?? []).length
      throw new Error(`这份数据超过 ${this.maxRows} 个个案，面板里只载入了前 ${loaded} 个：现在重构会把后面的个案丢掉。请先把设置里的「数据视图最多载入个案数」调大，或者用语法在完整数据上做（插件里的 PST 命令只作用于载入的部分）`)
    }
  }

  /**
   * Data > Restructure > Cases to Variables.
   *
   * PSPP 2.1.3 has no CASESTOVARS, so the pivot runs here on the owned matrix.
   * The result is deterministic: groups keep first-seen order, index values are
   * sorted ascending, so the same input always yields the same dataset. A
   * repeated (identifier, index) pair keeps its first value and is counted in
   * `duplicates` rather than silently overwriting.
   * @param {{ id?: string|string[], index?: string, variables?: string|string[] }} options
   * @returns {{ kind: string, variables: number, cases: number, created: number, duplicates: number, dropped: string[] }}
   */
  restructureCasesToVars(options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    this.assertRestructurable()
    const list = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；]+/))
      .map((entry) => String(entry).trim()).filter(Boolean)
    const source = this.dataset.variables
    const idNames = list(options.id)
    const spreadNames = list(options.variables)
    const indexName = String(options.index ?? '').trim()
    if (!indexName) throw new Error('个案转变量需要指定索引变量（它的取值会变成新列）')
    if (spreadNames.length === 0) throw new Error('个案转变量需要至少一个要展开的变量')
    const indexAt = source.findIndex((variable) => variable.name === indexName)
    if (indexAt < 0) throw new Error(`没有这个变量：${indexName}`)
    const idAt = idNames.map((name) => {
      const at = source.findIndex((variable) => variable.name === name)
      if (at < 0) throw new Error(`没有这个变量：${name}`)
      return at
    })
    const spreadAt = spreadNames.map((name) => {
      const at = source.findIndex((variable) => variable.name === name)
      if (at < 0) throw new Error(`没有这个变量：${name}`)
      return at
    })
    if (spreadAt.includes(indexAt)) throw new Error('索引变量不能同时是要展开的变量')

    // gather
    const groups = new Map()
    let duplicates = 0
    for (const row of this.dataset.rows) {
      const key = idAt.map((at) => String(row[at] ?? '\u0000')).join('\u0001')
      let group = groups.get(key)
      if (!group) {
        group = { ids: idAt.map((at) => row[at] ?? null), cells: new Map() }
        groups.set(key, group)
      }
      const indexValue = row[indexAt]
      if (indexValue === null || indexValue === undefined || indexValue === '') continue
      const slot = String(indexValue)
      if (group.cells.has(slot)) { duplicates += 1; continue }
      group.cells.set(slot, spreadAt.map((at) => row[at] ?? null))
    }
    if (groups.size === 0) throw new Error('没有可重构的个案')

    // index values sorted: numbers ascending first, then text
    const numeric = [...new Set([...groups.values()].flatMap((group) => [...group.cells.keys()]))]
    numeric.sort((left, right) => {
      const a = Number(left)
      const b = Number(right)
      const aNum = Number.isFinite(a) && left.trim() !== ''
      const bNum = Number.isFinite(b) && right.trim() !== ''
      if (aNum && bNum && a !== b) return a - b
      if (aNum !== bNum) return aNum ? -1 : 1
      return left.localeCompare(right, 'zh-CN')
    })

    const taken = new Set()
    const variables = idAt.map((at) => cloneVariable(source[at], reserve(taken, source[at].name)))
    const columns = []
    for (const at of spreadAt) {
      for (const [position, value] of numeric.entries()) {
        // PSPP only accepts ASCII variable names, so a Chinese category cannot
        // become part of the column name; fall back to its position instead.
        const cleaned = String(value).replace(/[^A-Za-z0-9]/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
        const suffix = cleaned || `v${position + 1}`
        const name = reserve(taken, `${source[at].name}_${suffix}`)
        const base = source[at]
        const variable = cloneVariable(base, name)
        variable.label = base.label ? `${base.label} · ${value}` : `${base.name} · ${value}`
        variable.measure = base.measure
        variables.push(variable)
        columns.push({ at, value })
      }
    }
    const rows = []
    for (const group of groups.values()) {
      const row = [...group.ids]
      for (const { at, value } of columns) {
        const cell = group.cells.get(value)
        row.push(cell === undefined ? null : cell[spreadAt.indexOf(at)])
      }
      rows.push(row)
    }
    this.pushHistory('个案转变量')
    this.dataset.variables = variables
    this.dataset.rows = rows
    this.dataset.dirty = true
    return {
      kind: 'casesToVars',
      variables: variables.length,
      cases: rows.length,
      created: columns.length,
      duplicates,
      dropped: [],
    }
  }

  /**
   * Data > Restructure > Variables to Cases (the inverse pivot).
   *
   * Every stacked variable becomes one row per case, carrying the identifier
   * values and either the variable name or its position as the index column.
   * PSPP has no VARSTOCASES, so this also runs on the owned matrix.
   * @param {{ variables?: string|string[], id?: string|string[], target?: string, indexName?: string, indexValues?: 'names'|'numbers' }} options
   * @returns {{ kind: string, variables: number, cases: number, created: number }}
   */
  restructureVarsToCases(options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    this.assertRestructurable()
    const list = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；]+/))
      .map((entry) => String(entry).trim()).filter(Boolean)
    const source = this.dataset.variables
    const stackNames = list(options.variables)
    const idNames = list(options.id)
    if (stackNames.length === 0) throw new Error('变量转个案需要至少一个要堆叠的变量')
    const stackAt = stackNames.map((name) => {
      const at = source.findIndex((variable) => variable.name === name)
      if (at < 0) throw new Error(`没有这个变量：${name}`)
      return at
    })
    const kinds = new Set(stackAt.map((at) => source[at].type))
    if (kinds.size > 1) {
      const detail = stackAt.map((at) => `${source[at].name}（${source[at].type === 'string' ? '字符串' : '数值'}）`).join('、')
      throw new Error(`变量转个案要求要堆叠的变量类型一致：${detail} 混在一起了。请先「自动重新编码」成同一类型再试`)
    }
    const idAt = idNames.map((name) => {
      const at = source.findIndex((variable) => variable.name === name)
      if (at < 0) throw new Error(`没有这个变量：${name}`)
      return at
    })
    const sample = source[stackAt[0]]
    const taken = new Set()
    const variables = idAt.map((at) => {
      const copy = cloneVariable(source[at], reserve(taken, source[at].name))
      return copy
    })
    const target = reserve(taken, String(options.target ?? 'value').trim() || 'value')
    const targetVariable = cloneVariable(sample, target)
    targetVariable.label = sample.label || ''
    const indexMode = options.indexValues === 'numbers' ? 'numbers' : 'names'
    const indexVariableName = reserve(taken, String(options.indexName ?? 'index').trim() || 'index')
    const indexVariable = {
      name: indexVariableName,
      label: '原来属于哪个变量',
      type: indexMode === 'numbers' ? 'numeric' : 'string',
      width: indexMode === 'numbers' ? 8 : Math.max(8, ...stackNames.map((name) => name.length)),
      decimals: 0,
      format: indexMode === 'numbers' ? 'F8.0' : `A${Math.max(8, ...stackNames.map((name) => name.length))}`,
      measure: indexMode === 'numbers' ? 'ordinal' : 'nominal',
      role: 'input',
      alignment: indexMode === 'numbers' ? 'right' : 'left',
      missing: [],
      valueLabels: {},
    }
    variables.push(targetVariable, indexVariable)
    const rows = []
    for (const row of this.dataset.rows) {
      const ids = idAt.map((at) => row[at] ?? null)
      stackAt.forEach((at, position) => {
        rows.push([
          ...ids,
          row[at] ?? null,
          indexMode === 'numbers' ? position + 1 : stackNames[position],
        ])
      })
    }
    this.pushHistory('变量转个案')
    this.dataset.variables = variables
    this.dataset.rows = rows
    this.dataset.dirty = true
    return { kind: 'varsToCases', variables: variables.length, cases: rows.length, created: 2 }
  }

  /**
   * Analyze > Missing Value Analysis.
   *
   * PSPP 2.1.3 refuses MVA outright ("MVA is not yet implemented"), so the two
   * tables are computed here from the held matrix and pushed into the output as
   * ordinary table items — same shape as a run, so outline/copy/export all work.
   * @param {{ variables?: string|string[], univariate?: boolean, patterns?: boolean }} options
   * @returns {{ runId: number, tables: number, cases: number, variables: string[] }}
   */
  missingAnalysis(options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    this.assertRestructurable()
    const list = (Array.isArray(options.variables) ? options.variables : String(options.variables ?? '').split(/[\s,，;；]+/))
      .map((entry) => String(entry).trim()).filter(Boolean)
    const tables = mvaTables(this.dataset, list, {
      univariate: options.univariate !== false,
      patterns: options.patterns !== false,
    })
    const runId = ++this.seq
    const items = tables.map((table, index) => ({
      kind: 'table',
      title: table.title,
      table: { caption: table.title, matrix: table.matrix, notes: table.notes },
      notes: table.notes,
      name: null,
      id: `run-${runId}-${index}`,
      runId,
      script: '',
      artifactUrl: null,
      at: Date.now(),
    }))
    this.appendItems(items)
    return { runId, tables: items.length, cases: (this.dataset.rows ?? []).length, variables: list }
  }

  /**
   * Data > Identify Duplicate Cases.
   *
   * PSPP has no such command, so the report is built from the matrix. When
   * `indicators` is on, two variables are created so "Select Cases" can filter
   * on them: `dupSeq` (position inside its group, 0 when unique) and `dupLast`
   * (1 for the last occurrence of a repeated group).
   */
  identifyDuplicates(options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    this.assertRestructurable()
    const list = (Array.isArray(options.variables) ? options.variables : String(options.variables ?? '').split(/[\s,，;；]+/))
      .map((entry) => String(entry).trim()).filter(Boolean)
    const report = duplicateReport(this.dataset, { variables: list })
    if (!report) throw new Error('这份数据里没有可用来比对的变量')
    const runId = ++this.seq
    const items = [{
      kind: 'table',
      title: report.title,
      table: { caption: report.title, matrix: report.matrix, notes: report.notes },
      notes: report.notes,
      name: null,
      id: `run-${runId}-0`,
      runId,
      script: '',
      artifactUrl: null,
      at: Date.now(),
    }]
    let created = []
    if (options.indicators === true) {
      const taken = new Set(this.dataset.variables.map((variable) => variable.name.toLowerCase()))
      const pick = (base) => {
        let name = base
        let counter = 2
        while (taken.has(name.toLowerCase())) {
          name = `${base}_${counter}`
          counter += 1
        }
        taken.add(name.toLowerCase())
        return name
      }
      const seqName = pick('dupSeq')
      const lastName = pick('dupLast')
      this.pushHistory('标识重复个案')
      const template = this.dataset.variables[0]
      for (const [name, label] of [[seqName, '组内序号（0 = 唯一）'], [lastName, '是否重复组的末条']]) {
        this.dataset.variables.push({
          ...cloneVariable(template, name),
          name,
          label,
          type: 'numeric',
          width: 8,
          decimals: 0,
          format: 'F8.0',
          measure: 'nominal',
          alignment: 'right',
          missing: [],
          valueLabels: {},
          position: this.dataset.variables.length + 1,
        })
      }
      this.dataset.rows.forEach((row, index) => {
        row.push(report.sequence[index] ?? 0, report.lastOfGroup[index] ?? 0)
      })
      this.dataset.dirty = true
      created = [seqName, lastName]
      items[0].notes = [...report.notes, `已新增两个指示变量：${seqName}（组内序号）、${lastName}（末条标记），可用「数据 → 选择个案」按 ${seqName} > 1 筛出重复`]
    }
    this.appendItems(items)
    return { runId, groups: report.groups, duplicates: report.duplicates, created, cases: this.dataset.rows.length }
  }

  /**
   * Data > Identify Outliers.
   *
   * Same shape as identifyDuplicates: two tables come back either way, and the
   * indicator variables are opt-in because they change the dataset.
   * @param {{ variables?: string|string[], percentiles?: number[], indicators?: boolean }} options
   */
  identifyOutliers(options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    this.assertRestructurable()
    const list = (Array.isArray(options.variables) ? options.variables : String(options.variables ?? '').split(/[\s,，;；]+/))
      .map((entry) => String(entry).trim()).filter(Boolean)
    const report = outlierReport(this.dataset, { variables: list, percentiles: options.percentiles })
    if (!report) throw new Error('这份数据里没有可用来判定的数值变量')
    const runId = ++this.seq
    const items = [report.summary, report.details].map((table, index) => ({
      kind: 'table',
      title: table.title,
      table: { caption: table.title, matrix: table.matrix, notes: table.notes },
      notes: table.notes,
      name: null,
      id: `run-${runId}-${index}`,
      runId,
      script: '',
      artifactUrl: null,
      at: Date.now(),
    }))
    let created = []
    if (options.indicators === true) {
      const taken = new Set(this.dataset.variables.map((variable) => variable.name.toLowerCase()))
      const pick = (base) => {
        let name = base
        let counter = 2
        while (taken.has(name.toLowerCase())) {
          name = `${base}_${counter}`
          counter += 1
        }
        taken.add(name.toLowerCase())
        return name
      }
      const anyName = pick('outlier')
      const countName = pick('outlierN')
      this.pushHistory('标识异常个案')
      const template = this.dataset.variables[0]
      for (const [name, label] of [[anyName, '是否越界（1 = 至少一个变量越界）'], [countName, '越界的变量个数']]) {
        this.dataset.variables.push({
          ...cloneVariable(template, name),
          name,
          label,
          type: 'numeric',
          width: 8,
          decimals: 0,
          format: 'F8.0',
          measure: 'nominal',
          alignment: 'right',
          missing: [],
          valueLabels: {},
          position: this.dataset.variables.length + 1,
        })
      }
      this.dataset.rows.forEach((row, index) => {
        const count = report.flagCount[index] ?? 0
        row.push(count > 0 ? 1 : 0, count)
      })
      this.dataset.dirty = true
      created = [anyName, countName]
      items[1].notes = [...report.details.notes, `已新增两个指示变量：${anyName}（是否越界）、${countName}（越界变量个数），可用「数据 → 选择个案」按 ${anyName} = 1 筛出这些个案`]
    }
    this.appendItems(items)
    return {
      runId,
      variables: report.variables,
      flagged: report.flagged,
      hits: report.hits,
      lowPercent: report.lowPercent,
      highPercent: report.highPercent,
      created,
      cases: this.dataset.rows.length,
    }
  }

  /**
   * Transform > Replace Missing Values.
   *
   * One history entry for the whole fill, so a mistaken replacement is a single
   * undo. The values are computed from the variable itself (see lib/mva.js);
   * nothing is written to disk until the next run, like every other edit.
   * @param {{ variables?: string|string[], method?: 'mean'|'linear'|'nearby' }} options
   */
  replaceMissingValues(options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const list = (Array.isArray(options.variables) ? options.variables : String(options.variables ?? '').split(/[\s,，;；]+/))
      .map((entry) => String(entry).trim()).filter(Boolean)
    if (list.length === 0) throw new Error('替换缺失值需要至少一个变量')
    const method = String(options.method ?? 'mean').toLowerCase()
    const changes = replaceMissing(this.dataset, list, method)
    if (changes.length === 0) {
      return { method, filled: 0, variables: list, cases: (this.dataset.rows ?? []).length }
    }
    this.assertEditable()
    this.pushHistory('替换缺失值')
    const positions = new Map(this.dataset.variables.map((variable) => [variable.name, variable.position - 1]))
    for (const change of changes) {
      const column = positions.get(change.variable)
      if (column === undefined) continue
      const row = this.dataset.rows[change.row]
      if (!row) continue
      row[column] = change.value
    }
    this.dataset.dirty = true
    return { method, filled: changes.length, variables: list, cases: (this.dataset.rows ?? []).length }
  }

  /**
   * Merge another system file into the open dataset.
   * `add` appends its cases (ADD FILES), `match` joins variables by key
   * (MATCH FILES /BY); both write the result back to the working file.
   */
  async mergeFile(options = {}) {
    if (!this.dataset) throw new Error('no dataset is open')
    const kind = options.kind === 'match' ? 'match' : 'add'
    const target = this.resolvePath(options.path)
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`${target} is not a file`)
    if (!SYSTEM_FILE_EXTENSIONS.has(extname(target).toLowerCase())) {
      throw new Error('合并只接受 PSPP 系统文件（.sav/.por/.sys）；请先把对方另存为 .sav')
    }
    const by = (Array.isArray(options.by) ? options.by : String(options.by ?? '').split(/\s+/))
      .map((entry) => String(entry).trim())
      .filter(Boolean)
    if (kind === 'match' && by.length === 0) throw new Error('按关键变量合并需要至少一个键变量')
    const staged = await stageInput(target, this.ioDir)
    const script = kind === 'match'
      ? `MATCH FILES /FILE=* /FILE=${quoteSyntaxPath(staged.path)} /BY ${by.join(' ')}.`
      : `ADD FILES /FILE=* /FILE=${quoteSyntaxPath(staged.path)}.`
    let result
    try {
      result = await this.runSyntax(script, { persist: true, historyLabel: kind === 'match' ? '按关键变量合并' : '添加个案' })
    } finally {
      await staged.dispose()
    }
    const failed = (result.diagnostics ?? []).find((entry) => entry.severity === 'error')
    if (failed) throw new Error(failed.message)
    return {
      kind,
      path: target,
      variables: this.dataset.variables.length,
      cases: this.dataset.rows.length,
      items: result.items,
      runId: result.runId,
    }
  }

  /**
   * Give the case rows back to the system allocator without losing the session:
   * variables, labels and multiple-response sets stay, the workspace stays open,
   * and the next request re-reads work.sav (see hydrate()). Unsaved edits are
   * written first, so releasing never loses them.
   */
  async release() {
    if (!this.dataset || this.dataset.evicted === true) return false
    // Idle eviction runs on every request, so without this a release could
    // start while a SAVE OUTFILE was still writing the same work.sav: two
    // writers, and the shorter one won. Queue behind the engine instead, and
    // give up immediately rather than make the caller wait for a long run.
    if (this.busyDepth > 0 || this.inflight > 0 || this.mutex.busy) return false
    return this.mutex.run(async () => {
      if (!this.dataset || this.dataset.evicted === true) return false
      if (this.busyDepth > 0 || this.inflight > 0) return false
      if (this.dataset.dirty === true) {
        try {
          await this.workSav()
        } catch {
          return false
        }
      }
      this.dataset.rows = []
      this.dataset.evicted = true
      this.undoStack = []
      this.redoStack = []
      return true
    })
  }

  async close() {
    this.dataset = null
    this.undoStack = []
    this.redoStack = []
    await this.rememberDataset()
    return { closed: true }
  }

  deleteCase(rowIndex) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const row = Number(rowIndex)
    if (!Number.isInteger(row) || row < 0 || row >= this.dataset.rows.length) throw new Error(`row out of range: ${rowIndex}`)
    this.pushHistory('删除个案')
    this.dataset.rows.splice(row, 1)
    this.dataset.dirty = true
    return { deleted: row, caseCount: this.dataset.rows.length }
  }

  addVariable(spec = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const existing = new Set(this.dataset.variables.map((variable) => variable.name.toLowerCase()))
    let name = String(spec.name ?? `V${this.dataset.variables.length + 1}`).replaceAll(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_')
    if (!name) name = `V${this.dataset.variables.length + 1}`
    let suffix = 1
    while (existing.has(name.toLowerCase())) {
      name = `${name.replace(/\d+$/, '')}${suffix}`
      suffix += 1
    }
    const type = spec.type === 'string' ? 'string' : 'numeric'
    const variable = {
      name,
      label: String(spec.label ?? ''),
      type,
      width: Number(spec.width) || (type === 'string' ? 8 : 8),
      decimals: Number(spec.decimals ?? 2),
      format: type === 'string' ? `A${Number(spec.width) || 8}` : `F${Number(spec.width) || 8}.${Number(spec.decimals ?? 2)}`,
      measure: ['nominal', 'ordinal', 'scale'].includes(spec.measure) ? spec.measure : (type === 'string' ? 'nominal' : 'scale'),
      role: 'input',
      alignment: type === 'string' ? 'left' : 'right',
      missing: [],
      valueLabels: {},
    }
    this.pushHistory('插入变量')
    this.dataset.variables.push(variable)
    for (const row of this.dataset.rows) row.push(null)
    this.dataset.dirty = true
    return variable
  }

  /**
   * Move one variable to a new position.
   *
   * Data cells live in row arrays, so a reorder has to move column `from` of
   * every row as well as the variable record; doing them in one place keeps
   * the two in step. In SPSS this is the drag handle in Variable View.
   * @param {string} name - variable to move.
   * @param {number} position - 1-based destination index.
   * @returns {{ order: string[] }}
   */
  moveVariable(name, position) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const from = this.dataset.variables.findIndex((entry) => entry.name === name)
    if (from < 0) throw new Error(`unknown variable: ${name}`)
    const to = Math.max(0, Math.min(this.dataset.variables.length - 1, Number(position) - 1))
    if (!Number.isInteger(to)) throw new Error(`bad position: ${position}`)
    if (to === from) return { order: this.dataset.variables.map((entry) => entry.name) }
    this.pushHistory('调整变量顺序')
    const [variable] = this.dataset.variables.splice(from, 1)
    this.dataset.variables.splice(to, 0, variable)
    for (const row of this.dataset.rows) {
      const [value] = row.splice(from, 1)
      row.splice(to, 0, value)
    }
    this.dataset.variables.forEach((entry, index) => { entry.position = index + 1 })
    this.dataset.dirty = true
    return { order: this.dataset.variables.map((entry) => entry.name) }
  }

  /**
   * Replace a variable's value labels wholesale.
   *
   * One history entry for the whole import, so a mis-parsed label file is a
   * single Ctrl+Z rather than one per label.
   * @param {string} name - variable to relabel.
   * @param {object} labels - `{ value: label }`.
   * @param {{ merge?: boolean }} [options] - merge keeps labels not mentioned.
   * @returns {object} the variable.
   */
  setValueLabels(name, labels, options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const variable = this.dataset.variables.find((entry) => entry.name === name)
    if (!variable) throw new Error(`unknown variable: ${name}`)
    const next = options.merge === true ? { ...(variable.valueLabels ?? {}) } : {}
    for (const [value, label] of Object.entries(labels ?? {})) {
      const text = String(label ?? '').trim()
      if (text === '') delete next[String(value)]
      else next[String(value)] = text
    }
    this.pushHistory('导入值标签')
    variable.valueLabels = next
    this.dataset.dirty = true
    return variable
  }

  updateVariable(name, patch = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const variable = this.dataset.variables.find((entry) => entry.name === name)
    if (!variable) throw new Error(`unknown variable: ${name}`)
    let renamed = false
    if (patch.name !== undefined) {
      const next = String(patch.name).trim()
      if (!next) throw new Error('变量名不能为空')
      if (!/^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,63}$/.test(next)) {
        throw new Error(`变量名不合法：${next}（只能字母、数字、下划线、汉字，且不能以数字开头）`)
      }
      if (this.dataset.variables.some((entry) => entry !== variable && entry.name.toLowerCase() === next.toLowerCase())) {
        throw new Error(`已经有同名变量：${next}`)
      }
      // One history entry for the whole call: a rename followed by a property
      // change must undo back to the state before this call, not to the
      // half-renamed one.
      this.pushHistory(next !== name ? '重命名变量' : '修改变量属性')
      if (next !== name) {
        variable.name = next
        this.dataset.dirty = true
      }
      renamed = true
    }
    if (!renamed) this.pushHistory('修改变量属性')
    for (const key of ['label', 'format', 'measure', 'alignment', 'role']) {
      if (patch[key] !== undefined) variable[key] = String(patch[key])
    }
    for (const key of ['width', 'decimals']) {
      if (patch[key] !== undefined) variable[key] = Number(patch[key])
    }
    if (patch.type !== undefined) variable.type = patch.type === 'string' ? 'string' : 'numeric'
    if (patch.valueLabels !== undefined && typeof patch.valueLabels === 'object') {
      variable.valueLabels = { ...patch.valueLabels }
    }
    if (patch.missing !== undefined && Array.isArray(patch.missing)) variable.missing = patch.missing
    this.dataset.dirty = true
    return variable
  }

  /**
   * The variable view lets several rows be selected; changing 小数位 or 测量 on
   * ten of them must undo in one step, so the history entry is written here and
   * every variable is patched without one.
   */
  updateVariables(names, patch = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const wanted = (Array.isArray(names) ? names : [names]).filter(Boolean)
    if (wanted.length === 0) throw new Error('没有选中要改的变量')
    const targets = wanted.map((name) => {
      const variable = this.dataset.variables.find((entry) => entry.name === name)
      if (!variable) throw new Error(`unknown variable: ${name}`)
      return variable
    })
    this.pushHistory('批量修改变量属性')
    for (const variable of targets) {
      if (patch.type !== undefined) variable.type = patch.type === 'string' ? 'string' : 'numeric'
      for (const key of ['label', 'format', 'measure', 'alignment', 'role']) {
        if (patch[key] !== undefined) variable[key] = String(patch[key])
      }
      for (const key of ['width', 'decimals']) {
        if (patch[key] !== undefined) variable[key] = Number(patch[key])
      }
      if (patch.missing !== undefined && Array.isArray(patch.missing)) variable.missing = patch.missing
    }
    this.dataset.dirty = true
    return { variables: targets.map((variable) => variable.name), patch }
  }

  deleteVariable(name) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const index = this.dataset.variables.findIndex((variable) => variable.name === name)
    if (index < 0) throw new Error(`unknown variable: ${name}`)
    this.pushHistory('删除变量')
    this.dataset.variables.splice(index, 1)
    for (const row of this.dataset.rows) row.splice(index, 1)
    this.dataset.dirty = true
    return { deleted: name, variables: this.dataset.variables.length }
  }

  /* ------------------------------------------------------- search/replace */

  /** Column list for a search: one named variable, or every variable. */
  searchColumns(column) {
    if (!column) return this.dataset.variables.map((_, index) => index)
    const index = this.dataset.variables.findIndex((variable) => variable.name === column)
    if (index < 0) throw new Error(`unknown variable: ${column}`)
    return [index]
  }

  find(query, options = {}) {
    if (!this.dataset) throw new Error('no dataset is open')
    const text = String(query ?? '')
    if (text === '') throw new Error('查找内容不能为空')
    const matchCase = options.matchCase === true
    const whole = options.whole === true
    const needle = matchCase ? text : text.toLowerCase()
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 200))
    const columns = this.searchColumns(options.column)
    const matches = []
    for (let row = 0; row < this.dataset.rows.length; row += 1) {
      for (const column of columns) {
        const raw = this.dataset.rows[row][column]
        if (raw === null || raw === undefined) continue
        const hay = matchCase ? String(raw) : String(raw).toLowerCase()
        if (whole ? hay !== needle : !hay.includes(needle)) continue
        matches.push({ row, column, variable: this.dataset.variables[column].name, value: raw })
        if (matches.length >= limit) {
          return { matches, total: matches.length, truncated: true, scanned: row + 1, cases: this.dataset.rows.length }
        }
      }
    }
    return { matches, total: matches.length, truncated: false, scanned: this.dataset.rows.length, cases: this.dataset.rows.length }
  }

  /** Replace every match; numbers only take a whole-cell match. */
  replace(findText, replaceText, options = {}) {
    this.assertEditable()
    if (!this.dataset) throw new Error('no dataset is open')
    const text = String(findText ?? '')
    if (text === '') throw new Error('查找内容不能为空')
    const replacement = String(replaceText ?? '')
    const matchCase = options.matchCase === true
    const whole = options.whole === true
    const needle = matchCase ? text : text.toLowerCase()
    const columns = this.searchColumns(options.column)
    const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi')

    const hits = []
    for (const column of columns) {
      const variable = this.dataset.variables[column]
      for (let row = 0; row < this.dataset.rows.length; row += 1) {
        const raw = this.dataset.rows[row][column]
        if (raw === null || raw === undefined) continue
        const hay = matchCase ? String(raw) : String(raw).toLowerCase()
        if (whole ? hay !== needle : !hay.includes(needle)) continue
        if (variable.type === 'numeric') {
          // A partial replacement would turn 12 into 1X; only whole cells make sense.
          if (!whole && !/^-?\d+(\.\d+)?$/.test(replacement)) continue
          const numeric = Number(replacement)
          if (!Number.isFinite(numeric)) continue
          hits.push({ row, column, value: numeric })
        } else {
          hits.push({ row, column, value: whole ? replacement : String(raw).replaceAll(pattern, replacement) })
        }
      }
    }
    if (hits.length === 0) return { replaced: 0, find: text, replace: replacement }
    this.pushHistory('查找替换')
    for (const hit of hits) this.dataset.rows[hit.row][hit.column] = hit.value
    this.dataset.dirty = true
    return { replaced: hits.length, find: text, replace: replacement }
  }

  /* -------------------------------------------------- format conversion --- */

  /** Convert a data file with pspp-convert (the format follows the extension). */
  async convert(outputPath, options = {}) {
    const tool = this.engine.tools?.['pspp-convert']
    if (!tool) throw new Error('这个引擎没有带 pspp-convert：请换一份自带工具的引擎')
    const target = this.resolvePath(outputPath)
    if (extname(target) === '') throw new Error('目标路径需要扩展名，例如 .csv / .por / .dta')
    let source = options.path ? this.resolvePath(options.path) : null
    if (!source) {
      if (!this.dataset) throw new Error('没有打开数据集')
      source = await this.workSav()
    }
    // pspp-convert is the same Windows build as pspp, so both sides of the
    // conversion are staged when the names are not plain ASCII.
    const readFrom = await stageInput(source, this.ioDir)
    await ensureParentDir(target)
    const writeTo = await stageOutput(target, this.ioDir)
    let result
    try {
      result = await runProcess(tool, [readFrom.path, writeTo.path], {
        cwd: this.cwd,
        env: engineEnv(this.engine, {}),
        timeoutMs: this.timeoutMs,
      })
      if (result.code !== 0) {
        // The engine only ever sees the staging copy, so put the user's own
        // paths back into the message before showing it.
        const detail = (worstStderrLine(result.stderr) || `退出码 ${result.code}`)
          // The staging paths already point back at the user's files; the
          // engine's own install path is noise they cannot act on.
          .split(tool).join('pspp-convert')
          .split(readFrom.path).join(source)
          .split(writeTo.path).join(target)
        const hint = explainMessage(detail)
        throw new Error(`转换失败：${detail}${hint ? ` —— ${hint}` : ''}`)
      }
      await writeTo.commit()
    } catch (error) {
      await writeTo.dispose()
      throw error
    } finally {
      await readFrom.dispose()
    }
    const info = await stat(target)
    this.log.push({ at: Date.now(), text: `转换：${basename(source)} → ${basename(target)}（${info.size} B）` })
    return { path: target, source, bytes: info.size, format: extname(target).slice(1) }
  }

  /** Append items as one batch and return the stamped copies. */
  appendItems(list) {
    this.batch = (this.batch ?? 0) + 1
    const batchId = this.batch
    // Every table and chart carries where its numbers came from. The panel and
    // the agent share one workspace per session, and two sessions can hold two
    // different files with the same name; without this stamp a screenshot of a
    // table cannot be traced back to a dataset.
    const origin = this.provenance()
    const stamped = list.map((item) => ({
      ...item,
      batchId,
      provenance: item.provenance ?? { ...origin, runId: item.runId ?? null },
    }))
    this.items = [...this.items, ...stamped].slice(-400)
    return stamped
  }

  /** The dataset a table computed right now would be computed from. */
  provenance() {
    const dataset = this.dataset
    // 'new' = built from nothing (pspp_new), 'upload' = bytes a browser dropped,
    // 'file' = a path the user opened. Older datasets have no origin field, so
    // it is derived: a path means a file, otherwise the data came from nowhere.
    const origin = dataset?.origin ?? (dataset?.sourcePath ? 'file' : (dataset ? 'new' : null))
    return {
      sessionId: this.id,
      origin,
      sourcePath: dataset && dataset.origin !== 'new' && dataset.temporary !== true ? (dataset.sourcePath ?? null) : null,
      workPath: dataset?.workPath ?? null,
      name: dataset
        ? (dataset.name ?? (dataset.sourcePath ? displayName(dataset.sourcePath) : null))
        : null,
      caseCount: dataset?.rows?.length ?? 0,
      varCount: dataset?.variables?.length ?? 0,
      openedAt: dataset?.openedAt ?? null,
      // The identity of the file itself, not just its name: a table can then
      // say whether the data it was computed from is still the file on disk.
      sourceSize: dataset?.sourceSize ?? null,
      sourceMtime: dataset?.sourceMtime ?? null,
      // Which bytes these numbers came from: a name and a case count cannot
      // tell a re-saved file from the one that was analysed.
      digest: dataDigest(dataset),
      conflicts: (this.conflicts ?? []).length,
      at: Date.now(),
    }
  }

  /**
   * The items the most recent action produced. A chart drawn outside a run has its
   * own runId, so the newest runId among the items is the right one; falling
   * back to the last few keeps "export the last output" sensible when the run
   * only wrote data.
   */
  lastRunItems(items) {
    const tables = items.filter((item) => item.kind === 'table' || item.kind === 'image')
    if (tables.length === 0) return tables
    const batches = tables.map((item) => Number(item.batchId) || 0)
    if (Math.max(...batches) > 0) {
      const newest = Math.max(...batches)
      const picked = tables.filter((item) => (Number(item.batchId) || 0) === newest)
      if (picked.length > 0) return picked
    }
    const newest = Math.max(...tables.map((item) => Number(item.runId) || 0))
    const picked = tables.filter((item) => (Number(item.runId) || 0) === newest)
    return picked.length > 0 ? picked : tables.slice(-1)
  }

  /** Store a file dropped onto the panel, so it can then be opened normally. */
  async saveUpload(name, base64, options = {}) {
    const flattened = String(name ?? '').replaceAll('\\', '/')
    const safe = basename(flattened).replaceAll(/[\u0000-\u001f]/g, '').trim()
    if (!safe || safe === '.' || safe === '..') throw new Error('上传需要文件名')
    const extension = extname(safe).toLowerCase()
    if (!UPLOAD_EXTENSIONS.has(extension)) {
      throw new Error(`不支持这种文件：${extension || safe}（可拖入 .sav/.por/.sys/.csv/.txt/.tsv/.sps）`)
    }
    const text = String(base64 ?? '').replace(/^data:[^,]*,/, '').trim()
    // Buffer.from ignores anything outside the base64 alphabet, so "!!!"
    // used to be written as a 6-byte file and reported as a success.
    if (text === '' || !/^[A-Za-z0-9+/=\s]+$/.test(text) || text.replace(/\s/g, '').length % 4 === 1) {
      throw new Error('上传的数据不是有效的 base64：请重新拖入文件')
    }
    const buffer = Buffer.from(text, 'base64')
    if (buffer.length === 0) throw new Error('文件是空的')
    const limit = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 64 * 1024 * 1024
    if (buffer.length > limit) throw new Error(`文件太大（上限 ${Math.round(limit / 1024 / 1024)} MB）`)
    const dir = join(this.dir, 'uploads')
    await mkdir(dir, { recursive: true })
    // Each drop gets its own file: a numeric prefix keeps two files of the same
    // name apart, so dropping the same file twice never becomes "(3).sav".
    // The prefix is an implementation detail — every place that shows a name
    // strips it again (see displayName()).
    uploadSeq = (uploadSeq % 1000) + 1
    const stamp = `${Date.now()}${String(uploadSeq).padStart(3, '0')}`
    const path = join(dir, `${stamp}-${safe}`)
    await writeFile(path, buffer)
    return { path, name: safe, bytes: buffer.length }
  }

  async clearOutput() {
    if (this.busyDepth > 0 || this.mutex.busy) {
      throw new Error('正在运行分析或载入数据，现在不能清除输出：等这次运行结束再清（输出视图里能看到进度）')
    }
    this.items = []
    this.log = []
    // Each run keeps its own directory (HTML, CSV, SVG, chart.json) and nothing
    // ever deleted them: a long session grew without bound. The working file
    // lives in the workspace root, so only runs/ is cleared.
    const runsDir = join(this.dir, 'runs')
    let removedRuns = 0
    try {
      for (const entry of await readdir(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        await rm(join(runsDir, entry.name), { recursive: true, force: true })
        removedRuns += 1
      }
    } catch {
      /* nothing has been written yet */
    }
    return { cleared: true, removedRuns }
  }

  /** Drop one output item (the panel's per-item delete button). */
  removeOutput(id) {
    const key = String(id ?? '')
    if (key === '') throw new Error('an output id is required')
    const before = this.items.length
    this.items = this.items.filter((item) => String(item.id) !== key)
    if (before === this.items.length) throw new Error(`输出里没有这一项：${key}`)
    return { removed: before - this.items.length }
  }

  artifactPath(runId, name) {
    if (!/^\d+$/.test(String(runId))) return null
    const safeName = basename(String(name))
    if (safeName !== String(name)) return null
    const path = join(this.runDir(Number(runId)), safeName)
    return path.startsWith(this.dir) ? path : null
  }

  async artifact(runId, name) {
    const path = this.artifactPath(runId, name)
    if (!path) return null
    return this.track(async () => {
      try {
        return await readFile(path)
      } catch {
        return null
      }
    })
  }
}

export class WorkspaceRegistry {
  constructor(options = {}) {
    this.engine = options.engine
    this.root = options.root
    this.config = options.config ?? {}
    this.cwdResolver = options.cwdResolver ?? (() => process.cwd())
    // Live settings file (`~/.dsh/analytics/settings.json`). Read at workspace
    // creation, so a knob changed in the panel reaches the next session without
    // a restart; workspaces already open keep the values they were built with.
    this.settingsStore = options.settingsStore ?? null
    this.map = new Map()
  }

  /** The config a new workspace gets: deployment patch first, then user settings. */
  configFor() {
    if (!this.settingsStore) return this.config
    try {
      return { ...this.config, ...this.settingsStore.current() }
    } catch {
      return this.config
    }
  }

  get(id, cwd) {
    const key = String(id ?? 'default')
    let workspace = this.map.get(key)
    if (!workspace) {
      workspace = new Workspace({
        id: key,
        engine: this.engine,
        root: this.root,
        config: this.configFor(),
        settingsStore: this.settingsStore,
        cwd: cwd ?? this.cwdResolver(key) ?? process.cwd(),
      })
      this.map.set(key, workspace)
    }
    workspace.lastUsedAt = Date.now()
    if (cwd) workspace.cwd = cwd
    return workspace
  }

  async ensure(id, cwd) {
    // A session that ran a 50 000-case analysis keeps those rows in memory for
    // as long as the process lives. Dropping the dataset of workspaces nobody
    // has touched for a while keeps a long-lived dsh from growing without
    // bound; the files on disk stay, so reopening restores the data.
    if (this.config.evictIdle !== false) await this.evictIdle({ skip: String(id) })
    const workspace = this.get(id, cwd)
    await workspace.init()
    return workspace
  }

  /**
   * Release the in-memory dataset of workspaces that have been idle.
   *
   * Only the dataset is dropped: the workspace directory, the saved files and
   * the undo history settings stay, and the next request reopens the working
   * save. Anything the user is looking at is skipped, and so is the workspace
   * a tool call currently resolves to.
   */
  async evictIdle(options = {}) {
    const maxIdleMs = Number(options.maxIdleMs ?? this.config.maxIdleMs ?? 30 * 60 * 1000)
    const now = Number(options.now ?? Date.now())
    const active = new Set(this.active ? [...this.active.values()] : [])
    // ensure() calls this before handing the workspace out: without the skip it
    // would release the very session that asked for the data and then read it
    // back from disk, paying a write plus a read for nothing.
    const skip = options.skip === undefined ? null : String(options.skip)
    const dropped = []
    for (const [key, workspace] of this.map) {
      if (skip !== null && key === skip) continue
      if (active.has(key)) continue
      const last = Number(workspace.lastUsedAt ?? 0)
      const idle = last > 0 ? now - last : Number.POSITIVE_INFINITY
      // The Workspace object itself was never removed from this map, so a
      // long-lived host accumulated one per tab forever. A released workspace
      // that has been idle for four times the window is safe to forget: the
      // files stay and the next request builds a fresh object that restores
      // from them. An already-released workspace has to be looked at too —
      // skipping it here meant the object only ever left the map in the rare
      // run where it was both released and overdue in the same pass.
      // A request still reading a chart file or an export target must not have
      // its workspace forgotten underneath it.
      if (workspace.inflight > 0) continue
      if (workspace.dataset?.evicted === true) {
        if (idle >= maxIdleMs * 4) {
          this.map.delete(key)
          if (this.active instanceof Map) this.active.delete(key)
        }
        continue
      }
      if (!workspace.dataset) continue
      if (idle < maxIdleMs) continue
      if (await workspace.release()) {
        dropped.push(key)
        if (idle >= maxIdleMs * 4) {
          this.map.delete(key)
          if (this.active instanceof Map) this.active.delete(key)
        }
      }
    }
    return dropped
  }

  list() {
    return [...this.map.values()]
  }

  /**
   * Open datasets, most recently used first.
   *
   * The left column's global panel has no Session of its own, so without this
   * it started on an empty document while the conversation next to it already
   * held data. Listing the workspaces that exist lets that panel adopt the one
   * the user was last looking at, and switch between them.
   */
  async recent(options = {}) {
    // Number(undefined) is NaN, and slice(0, NaN) is empty: the no-argument call
    // — the one the panel actually makes — must not read the default twice.
    const requested = Number(options.limit ?? 20)
    const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20
    const shown = new Set(this.active instanceof Map ? [...this.active.values()] : [])
    const rows = []
    for (const [key, workspace] of this.map) {
      // A workspace whose rows were released still has them on disk; listing it
      // only while resident made the launcher lose datasets after an idle sweep.
      const summary = await workspace.summary().catch(() => null)
      if (!summary) continue
      rows.push({
        docId: key,
        sessionId: key,
        ...summary,
        onScreen: shown.has(key),
        lastUsedAt: Number(workspace.lastUsedAt ?? 0),
      })
    }
    rows.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    return rows.slice(0, limit)
  }

  /** The panel tab the user is actually looking at, per DSH session. */
  setActive(sessionId, docId) {
    const key = String(sessionId ?? 'default')
    if (!this.active) this.active = new Map()
    if (docId === undefined || docId === null) this.active.delete(key)
    else this.active.set(key, String(docId))
  }

  /**
   * The workspace a tool call should act on: the tab on screen when there is
   * one, the session's primary workspace otherwise.
   */
  resolveForTools(sessionId) {
    const key = String(sessionId ?? 'default')
    return this.active?.get(key) ?? key
  }
}

export { dirname }
