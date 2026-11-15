import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path'

import { engineEnv, runProcess } from './engine.js'
import { quoteSyntaxPath, readData, readDictionary, importDelimited, buildTable, decodeText, writeSav } from './dataset.js'
import { describeFsError, describeEngineError } from './fserr.js'
import { readXlsx } from './xlsx.js'
import { readOds } from './ods.js'
import { readDta } from './dta.js'
import { parseDiagnostics, parseHtmlOutput } from './html.js'
import { buildChartModel, renderSvg } from './charts.js'
import { explainMessage } from './messages.js'
import { buildDocx, buildXlsx, pngSize } from './office.js'
import { svgToPng } from './raster.js'
import { normalizeSet, parseMrSetAttribute, tabulate, frequencyMatrix, crosstab as mrCrosstab, mrsetsSyntax } from './mrsets.js'
import { pluginInfo } from './version.js'
import { buildBaselineTable, buildCompareTable, buildPairwiseTable, buildPartialMatrix, buildPartialTable, buildSignificanceMatrix } from './tables.js'
import { collinearityTable } from './regression.js'
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
 * Why a run produced no tables: exit code plus the engine's own first line.
 *
 * The old text repeated its own prefix ("引擎没有产出任何表：引擎没有给出原因")
 * and dropped the GSL line that explains the crash, so nobody could act on it.
 */
export function describeFailure(result) {
  const lines = [
    ...String(result?.stderr ?? '').split('\n'),
    ...String(result?.stdout ?? '').split('\n'),
  ].map((line) => line.trim()).filter(Boolean)
  const pick = lines.find((line) => /error|错误|conformant|gsl_|cannot|无法/i.test(line))
    ?? lines[lines.length - 1]
  const code = result?.code === null || result?.code === undefined
    ? (result?.timedOut ? '超时' : '没有退出码')
    : `退出码 ${result.code}${result?.timedOut ? '（超时）' : ''}`
  return pick ? `${code}：${pick}` : `${code}，引擎没有输出任何诊断信息`
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
    notes.push('系数里有 NaN 或 +Infinit：常见原因是预测变量之间完全共线、某个预测变量是常数，或者某一组数据完全没有变异。这几行的 B、S.E.、t 与 Sig. 不能用，先看「共线性诊断」表或去掉多余的变量再重跑')
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
    // Undo stack: one entry per data change. Cell edits store the two values,
    // structural edits store a snapshot, and a cell budget keeps the memory
    // cost bounded on a large dataset.
    this.undoStack = []
    this.redoStack = []
    this.historyLimit = Number(this.config.historyLimit) > 0 ? Number(this.config.historyLimit) : 30
    this.historyCells = Number(this.config.historyCells) > 0 ? Number(this.config.historyCells) : 12000000
  }

  get timeoutMs() {
    return Number(this.config.timeoutMs) > 0 ? Number(this.config.timeoutMs) : 120000
  }

  get maxRows() {
    return Number(this.config.maxRows) > 0 ? Number(this.config.maxRows) : 200000
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
    // Only a workspace bound to a real data file comes back. A dropped file is
    // a copy whose path the browser never gave us: restoring it would open a
    // file the user did not ask for, so such a workspace starts empty and the
    // copy stays on disk for 打开数据… to pick up.
    if (typeof meta.sourcePath !== 'string' || meta.temporary === true) return null
    // The shell stays a local object until the rows are in: assigning it to
    // this.dataset first let concurrent requests read a dataset with no rows
    // and write "Cannot read properties of undefined" all over the panel.
    const shell = {
      sourcePath: typeof meta.sourcePath === 'string' ? meta.sourcePath : null,
      temporary: meta.temporary === true,
      name: typeof meta.name === 'string' ? meta.name : null,
      dirty: false,
    }
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
  async rememberDataset() {
    const file = join(this.dir, 'dataset.json')
    if (!this.dataset) {
      await rm(file, { force: true }).catch(() => {})
      return
    }
    await writeFile(file, JSON.stringify({
      sourcePath: this.dataset.sourcePath ?? null,
      temporary: this.dataset.temporary === true,
      name: this.dataset.name ?? null,
    })).catch(() => {})
  }

  resolvePath(input) {
    if (typeof input !== 'string' || input.trim() === '') throw new Error('a file path is required')
    const raw = input.trim()
    if (raw.startsWith('~/')) return join(process.env.HOME ?? '/root', raw.slice(2))
    if (isAbsolute(raw)) return raw
    return resolve(this.cwd, raw)
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
      mrSets: this.mrSets.length,
      splitBy: this.splitBy,
      weightBy: this.weightBy,
      filterBy: this.filterBy,
      selectIf: this.selectIf,
      lastError: this.lastError?.raw ?? null,
      history: this.historyInfo(),
    }
  }

  state() {
    return {
      // The polling signature used to live only on api/heartbeat, which meant a
      // panel that had just drawn fresh state still had to re-read it once more
      // to learn the signature. It travels with the state instead: whoever holds
      // the state holds what to compare the next heartbeat against.
      signal: this.signature(),
      id: this.id,
      version: pluginInfo().version || this.config?.pluginVersion || null,
      engine: {
        source: this.engine.source,
        bin: this.engine.bin,
        bundled: this.engine.source === 'bundled',
        hint: this.engine.bin ? undefined : this.engine.hint,
      },
      cwd: this.cwd,
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
          name: this.dataset.name ?? (this.dataset.sourcePath ? displayName(this.dataset.sourcePath) : null),
          variables: this.dataset.variables,
        }
        : null,
      items: this.items,
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
      undoLabel: undo ? undo.label : null,
      redoLabel: redo ? redo.label : null,
    }
  }

  /** Full snapshot of the current data, labelled with the change it precedes. */
  captureHistory(label) {
    return {
      kind: 'full',
      label: String(label || '编辑'),
      variables: structuredClone(this.dataset.variables),
      rows: this.dataset.rows.map((row) => row.slice()),
    }
  }

  /** Record a change that is about to happen, so 撤销 can put the data back. */
  pushHistory(label) {
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
    while (this.undoStack.length > this.historyLimit) this.undoStack.shift()
    this.redoStack = []
  }

  /** Record one cell change without cloning the whole dataset. */
  pushCellHistory(row, column, before, after) {
    if (!this.dataset) return
    this.undoStack.push({ kind: 'cell', label: '编辑单元格', row, column, before, after })
    while (this.undoStack.length > this.historyLimit) this.undoStack.shift()
    this.redoStack = []
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
    }
    return workPath
  }

  /** Run one syntax file inside a fresh run directory and collect its output. */
  async exec(scriptText, options = {}) {
    const runId = ++this.seq
    const dir = join(this.dir, 'runs', String(runId))
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
    try {
      stderr = await readFile(errPath, 'utf8')
    } catch {
      stderr = result.stderr
    }

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
            throw new Error(describeEngineError(result.stderr, basename(path)))
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
        sourcePath: spec.name ? String(spec.name) : null,
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
      if (result.code !== 0 && parsed.length === 0) {
        throw new Error(`引擎没有产出任何表（${describeFailure(result)}）`)
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
      if (options.regression && typeof options.regression === 'object' && this.dataset) {
        // An explicit TOL request that survived gives the engine's own column;
        // do not print a second table underneath it. "Survived" is not the same
        // as "printed", though: PSPP 2.1.3 fills the column with .00 / +Infinit
        // when the fit is degenerate, so the numbers have to be finite and agree
        // with our own calculation before the engine's copy is trusted.
        const engineTol = engineTolerance(items)
        const built = collinearityTable(this.dataset, options.regression)
        const trusted = engineTol !== null && tolerancesAgree(engineTol, built)
        if (engineTol !== null && !trusted) blankEngineTolerance(items)
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
      this.appendItems(items)
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
        items,
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
      const dir = join(this.dir, 'runs', String(runId))
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
      const dir = join(this.dir, 'runs', String(id))
      let saved
      try {
        saved = JSON.parse(await readFile(join(dir, 'chart.json'), 'utf8'))
      } catch {
        throw new Error(`第 ${id} 次运行没有图表可以修改`)
      }
      const options = { ...(saved.options ?? {}) }
      for (const key of ['title', 'xLabel', 'yLabel', 'accent', 'sortCategories']) {
        if (patch[key] === undefined) continue
        const value = typeof patch[key] === 'string' ? patch[key].trim() : patch[key]
        if (value === '' || value === 'none') delete options[key]
        else options[key] = value
      }
      const chart = buildChartModel(this.dataset, saved.kind ?? options.kind, options)
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
    const dir = join(this.dir, 'runs', String(id))
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
      const file = join(this.dir, 'runs', runDir, fileName)
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
        })
      } else {
        bytes = buildDocx({ title: `${this.dataset?.name ?? '统计输出'} · PSPP 输出`, items: list, images })
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
      const result = await this.exec(notes ? `${this.lastScript}\n${notes}\n` : this.lastScript, {
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
      const produced = join(this.dir, 'runs', String(result.runId), `export.${kind}`)
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
      const result = await this.exec(notes ? `${text}\n${notes}\n` : `${text}\n`, {
        outName: 'report',
        format: kind,
        collectOutput: kind !== 'spv',
      })
      if (result.code !== 0) {
        const reason = String(result.stderr ?? '').trim().split('\n')[0] || `退出码 ${result.code}`
        throw new Error(`导出失败：${reason}`)
      }
      const produced = join(this.dir, 'runs', String(result.runId), `report.${kind}`)
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

  async exportCsv(inputPath) {
    return this.mutex.run(async () => {
      if (!this.dataset) throw new Error('no dataset is open')
      const target = this.resolvePath(inputPath)
      const workPath = await this.workSav()
      const staged = await stageOutput(target, this.ioDir)
      try {
        const script = [
          `GET FILE=${quoteSyntaxPath(workPath)}.`,
          `SAVE TRANSLATE /OUTFILE=${quoteSyntaxPath(staged.path)} /TYPE=CSV /REPLACE.`,
        ].join('\n') + '\n'
        const result = await this.exec(script, { outName: 'export', env: { LC_ALL: 'C', LANG: 'C' }, collectOutput: false })
        if (result.code !== 0) throw new Error(`导出失败：${describeEngineError(result.stderr, basename(outPath))}`)
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
    if (this.busyDepth > 0 || this.mutex.busy) return false
    return this.mutex.run(async () => {
      if (!this.dataset || this.dataset.evicted === true) return false
      if (this.busyDepth > 0) return false
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
    const stamped = list.map((item) => ({ ...item, batchId, provenance: item.provenance ?? origin }))
    this.items = [...this.items, ...stamped].slice(-400)
    return stamped
  }

  /** The dataset a table computed right now would be computed from. */
  provenance() {
    const dataset = this.dataset
    return {
      sessionId: this.id,
      sourcePath: dataset && dataset.temporary !== true ? (dataset.sourcePath ?? null) : null,
      workPath: dataset?.workPath ?? null,
      name: dataset
        ? (dataset.name ?? (dataset.sourcePath ? displayName(dataset.sourcePath) : null))
        : null,
      caseCount: dataset?.rows?.length ?? 0,
      varCount: dataset?.variables?.length ?? 0,
      openedAt: dataset?.openedAt ?? null,
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
    const path = join(this.dir, 'runs', String(runId), safeName)
    return path.startsWith(this.dir) ? path : null
  }

  async artifact(runId, name) {
    const path = this.artifactPath(runId, name)
    if (!path) return null
    try {
      return await readFile(path)
    } catch {
      return null
    }
  }
}

export class WorkspaceRegistry {
  constructor(options = {}) {
    this.engine = options.engine
    this.root = options.root
    this.config = options.config ?? {}
    this.cwdResolver = options.cwdResolver ?? (() => process.cwd())
    this.map = new Map()
  }

  get(id, cwd) {
    const key = String(id ?? 'default')
    let workspace = this.map.get(key)
    if (!workspace) {
      workspace = new Workspace({
        id: key,
        engine: this.engine,
        root: this.root,
        config: this.config,
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
