// Multiple response sets.
//
// PSPP 2.1.3 parses `MRSETS` into the data dictionary and then refuses to use
// the set anywhere: `FREQUENCIES /VARIABLES=$q1.` answers "$q1 不是有效的变量名"
// and not even `DISPLAY MRSETS` exists. So the definition lives here, and the
// counting is done in JavaScript from the rows the workspace already holds —
// which is also what SPSS tabulates for a multiple dichotomy set (percent of
// cases on a dichotomous variable, or a category share for a categorical one).

const NAME = /^[A-Za-z@#$_][A-Za-z0-9@#$_]{0,63}$/

function name(raw, what) {
  let value = String(raw ?? '').trim()
  if (!value) throw new Error(`${what}不能为空`)
  // PSPP only accepts a multiple-response set whose name starts with '$'
  // ("this identifier must start with '$'"), and SPSS shows them that way too,
  // so a plain name is prefixed instead of rejected.
  if (!value.startsWith('$')) value = `$${value}`
  if (!NAME.test(value)) throw new Error(`${what}「${value}」不是合法的 SPSS 变量名`)
  return value
}

/** Validate one set definition against the dataset's variables. */
export function normalizeSet(input, variables = []) {
  const known = new Map(variables.map((variable) => [variable.name, variable]))
  const kind = input.kind === 'mdgroup' ? 'mdgroup' : 'mcgroup'
  const set = {
    name: name(input.name, '多选题名'),
    label: String(input.label ?? '').trim(),
    kind,
    variables: [],
    value: null,
    counted: null,
    empty: false,
  }
  const list = Array.isArray(input.variables) ? input.variables : []
  const seen = new Set()
  for (const entry of list) {
    const variable = known.get(String(entry))
    if (!variable) throw new Error(`数据集里没有变量 ${entry}`)
    if (seen.has(variable.name)) continue
    if (variable.type !== 'numeric') throw new Error(`多选题只能用数值变量，${variable.name} 是字符串`)
    seen.add(variable.name)
    set.variables.push(variable.name)
  }
  if (set.variables.length === 0) throw new Error('多选题至少要选一个变量')
  if (kind === 'mdgroup') {
    if (!Array.isArray(input.value) || input.value.length === 0) {
      throw new Error('多分类多选题要给出「计数哪些值」，例如 1 2 3')
    }
    const values = []
    for (const entry of input.value) {
      const numeric = Number(entry)
      if (!Number.isFinite(numeric)) throw new Error(`计数值必须是数字：${entry}`)
      values.push(numeric)
    }
    set.value = [...new Set(values)]
    set.counted = String(input.counted ?? 'counted').toLowerCase() === 'respondents' ? 'respondents' : 'counted'
  }
  set.empty = input.empty === true || String(input.empty ?? '').toLowerCase() === 'include'
  return set
}

/** Syntax that records the definition in a saved .sav (PSPP stores it, SPSS reads it). */
export function mrsetsSyntax(set) {
  const quote = (text) => `'${String(text).replaceAll("'", "''")}'`
  if (set.kind === 'mdgroup') {
    // PSPP 2.1.3 knows /VALUE but not /COUNTEDVALUES (SPSS does); the counted
    // variety is kept here and re-applied when the .sav is read back.
    // PSPP 2.1.3 takes exactly one /VALUE and rejects a list ("Syntax error
    // expecting NAME, VARIABLES, ..."), and a second definition under the same
    // name replaces the first, so only the first counted value survives into
    // the .sav. The set itself is still counted correctly in the panel, which
    // reads the rows directly; the label is what tells the user which value
    // was recorded for SPSS.
    const values = set.value.length > 0 ? set.value : [1]
    const recorded = values.length > 1 ? `${set.label ? `${set.label} ` : ''}（值 ${values.join('/')}，PSPP 只记 ${values[0]}）` : set.label
    return `MRSETS /MDGROUP NAME=${set.name}${recorded ? ` LABEL=${quote(recorded)}` : ''} VARIABLES=${set.variables.join(' ')} VALUE=${values[0]}.`
  }
  return `MRSETS /MCGROUP NAME=${set.name}${set.label ? ` LABEL=${quote(set.label)}` : ''} VARIABLES=${set.variables.join(' ')}.`
}

function labelOf(variable, value) {
  const labels = variable?.valueLabels ?? {}
  const hit = labels[String(value)]
  return hit === undefined ? String(value) : hit
}

/**
 * Tabulate a multiple response set.
 *
 * Returns { responses, respondents, cases, categories: [{ key, label, count, cases }] }.
 * `count` is responses — the number SPSS prints as "Responses N".
 */
export function tabulate(set, variables, rows) {
  const byName = new Map(variables.map((variable) => [variable.name, variable]))
  const columns = set.variables.map((entry) => variables.findIndex((variable) => variable.name === entry))
  const missing = (variable, value) => {
    if (value === null || value === undefined) return true
    const rules = variable?.missing ?? []
    return rules.some((rule) => {
      if (Array.isArray(rule)) return value >= rule[0] && value <= rule[1]
      return Number(rule) === value
    })
  }
  const isCounted = (value) => (set.value ? set.value.includes(Number(value)) : Number(value) !== 0)
  const labelled = (variable) => Object.entries(variable?.valueLabels ?? {})
  const categories = new Map()
  const add = (key, label, rowIndex) => {
    const entry = categories.get(key) ?? { key, label, count: 0, rows: new Set() }
    entry.count += 1
    entry.rows.add(rowIndex)
    categories.set(key, entry)
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    if (set.kind === 'mcgroup') {
      // Dichotomy: each variable is a yes/no question and counts once per case.
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index]
        if (column < 0) continue
        const variable = byName.get(set.variables[index])
        const value = row[column]
        if (missing(variable, value)) continue
        if (isCounted(value)) add(set.variables[index], variable?.label || variable?.name || set.variables[index], rowIndex)
      }
    } else if (set.counted === 'respondents') {
      // One answer per respondent: the first counted value found wins.
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index]
        if (column < 0) continue
        const variable = byName.get(set.variables[index])
        const value = row[column]
        if (missing(variable, value)) continue
        if (isCounted(value)) { add(Number(value), labelOf(variable, value), rowIndex); break }
      }
    } else {
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index]
        if (column < 0) continue
        const variable = byName.get(set.variables[index])
        const value = row[column]
        if (missing(variable, value)) continue
        // Only the values the set was defined over belong to its domain; a
        // stray code (a 9 that is not declared missing) is not a category.
        if (set.value && !isCounted(value)) continue
        add(Number(value), labelOf(variable, value), rowIndex)
      }
    }
  }
  // SPSS keeps the whole labelled domain of a set, including categories nobody
  // chose (a brand list shows a zero row rather than dropping the brand).
  const fixedDomain = set.kind === 'mdgroup' && set.counted !== 'respondents'
  const wantEmpty = set.empty || fixedDomain
  if (wantEmpty) {
    for (const entry of set.variables) {
      const variable = byName.get(entry)
      for (const [value, label] of labelled(variable)) {
        if (set.kind === 'mcgroup' && variable?.missing?.map?.(Number).includes(Number(value))) continue
        if (set.kind === 'mdgroup' && !isCounted(Number(value))) continue
        const key = set.kind === 'mcgroup' ? entry : Number(value)
        if (categories.has(key)) continue
        categories.set(key, { key, label: set.kind === 'mcgroup' ? (variable?.label || entry) : label, count: 0, rows: new Set() })
      }
    }
  }
  if (set.kind === 'mdgroup') {
    const allowed = new Set()
    for (const entry of set.variables) for (const [value] of labelled(byName.get(entry))) allowed.add(String(Number(value)))
    if (allowed.size > 0) {
      for (const key of [...categories.keys()]) {
        if (!allowed.has(String(key))) categories.delete(key)
      }
    }
  }
  const list = [...categories.values()].sort((left, right) => {
    if (typeof left.key === 'number' && typeof right.key === 'number') return left.key - right.key
    return String(left.key).localeCompare(String(right.key), 'zh-CN')
  })
  const responders = new Set()
  let responses = 0
  for (const entry of list) {
    responses += entry.count
    for (const rowIndex of entry.rows) responders.add(rowIndex)
  }
  return {
    ok: true,
    set: { ...set, variables: [...set.variables] },
    responses,
    respondents: responders.size,
    cases: rows.length,
    categories: list.map((entry) => ({ key: entry.key, label: entry.label, count: entry.count, cases: entry.rows.size })),
  }
}

/** Rows for the output table, in the layout the SPSS frequency table uses. */
export function frequencyMatrix(result, { percentBase = 'responses' } = {}) {
  const header = ['', '响应数', '百分比', '个案百分比']
  const base = percentBase === 'cases' ? result.cases : 0
  const matrix = [header]
  for (const entry of result.categories) {
    const share = result.responses > 0 ? (entry.count / result.responses) * 100 : 0
    const byCase = result.cases > 0 ? (entry.cases / result.cases) * 100 : 0
    matrix.push([
      entry.label,
      String(entry.count),
      `${share.toFixed(1)}%`,
      `${byCase.toFixed(1)}%`,
    ])
  }
  const totalShare = 100
  const totalByCase = result.cases > 0 ? (result.respondents / result.cases) * 100 : 0
  matrix.push(['总计', String(result.responses), `${totalShare.toFixed(0)}%`, `${totalByCase.toFixed(0)}%`])
  if (base) matrix.push(['个案数', String(base), '', ''])
  return matrix
}

/** Cross tabulation of one set against one grouping variable. */
export function crosstab(set, groupBy, variables, rows) {
  const column = variables.findIndex((variable) => variable.name === groupBy)
  if (column < 0) throw new Error(`数据集里没有分组变量 ${groupBy}`)
  const groups = new Map()
  const counts = new Map()
  const groupVariable = variables[column]
  const groupMissing = (value) => {
    if (value === null || value === undefined || value === '') return true
    if (groupVariable?.type === 'string') return (groupVariable.missing ?? []).includes(String(value))
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return true
    return (groupVariable?.missing ?? []).some((rule) => (Array.isArray(rule)
      ? numeric >= rule[0] && numeric <= rule[1]
      : Number(rule) === numeric))
  }
  // Only the codes a categorical group variable was labelled with are real
  // groups; a code its labels never mention is not a group of its own.
  const labelledGroups = new Set(Object.keys(groupVariable?.valueLabels ?? {}).map((value) => String(Number(value))))
  const knownGroup = (value) => labelledGroups.size === 0 || labelledGroups.has(String(Number(value)))
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const raw = rows[rowIndex][column]
    if (groupMissing(raw) || !knownGroup(raw)) continue
    const key = String(raw)
    if (!groups.has(key)) groups.set(key, { key, label: labelOf(variables[column], raw), cases: 0 })
    groups.get(key).cases += 1
  }
  const single = { ...set }
  const perGroup = new Map()
  for (const [key, group] of groups) {
    const subset = rows.filter((row) => !groupMissing(row[column]) && knownGroup(row[column]) && String(row[column]) === key)
    const table = tabulate(single, variables, subset)
    perGroup.set(key, table)
    for (const entry of table.categories) {
      const list = counts.get(entry.key) ?? { label: entry.label, total: 0, byGroup: new Map() }
      list.total += entry.count
      list.byGroup.set(key, entry.count)
      counts.set(entry.key, list)
    }
  }
  const order = [...groups.values()].sort((left, right) => {
    const leftValue = Number(left.key)
    const rightValue = Number(right.key)
    if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) return leftValue - rightValue
    return left.label.localeCompare(right.label, 'zh-CN')
  })
  const matrix = [['', ...order.map((group) => group.label), '总计']]
  for (const [key, entry] of counts) {
    matrix.push([entry.label, ...order.map((group) => String(entry.byGroup.get(group.key) ?? 0)), String(entry.total)])
  }
  return matrix
}

/**
 * Best-effort read-back of the definitions PSPP stores in a .sav.
 *
 * PSPP keeps a multiple response set as a file attribute whose value looks like
 *
 *   $m1=C 6 组一 a b            (mcgroup)
 *   $m2=D1 1 6 组二 a b c       (mdgroup: D<k> then k values)
 *
 * The label sits between a small numeric blob and the trailing variable names,
 * and it may contain spaces. Only the parts we can recover without guessing are
 * parsed: name, kind, label, variables and (for mdgroup) the counted value. The
 * rest — PSPP's internal flag blob — is deliberately ignored; a definition that
 * comes back with defaults is better than one invented from a number we do not
 * understand. Callers must still validate the result against the dictionary.
 */
export function parseMrSetAttribute(value, variables = []) {
  const text = String(value ?? '').trim()
  const at = text.indexOf('=')
  if (at < 2) return null
  const rawName = text.slice(0, at).trim()
  if (!rawName.startsWith('$')) return null
  if (!NAME.test(rawName)) return null
  const body = text.slice(at + 1).trim()
  const tokens = body.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const known = new Set(variables.map((variable) => variable.name))
  let kind = null
  let values = []
  let rest = tokens
  const grouped = /^([CD])(\d*)$/.exec(rest[0] ?? '')
  if (!grouped) return null
  if (grouped[1] === 'C') {
    kind = 'mcgroup'
    rest = rest.slice(1)
  } else {
    kind = 'mdgroup'
    const count = Number(grouped[2] || '0')
    rest = rest.slice(1)
    if (!Number.isInteger(count) || count < 1 || rest.length < count) return null
    values = rest.slice(0, count).map(Number).filter(Number.isFinite)
    rest = rest.slice(count)
    if (values.length !== count) return null
  }
  // The flag blob PSPP writes between the values and the label: one token, and
  // it is never a variable name in practice. Keep it out of the label.
  if (rest.length > 0 && /^\d+$/.test(rest[0])) rest = rest.slice(1)
  // Variables are the trailing tokens the dictionary knows about; at least two
  // of them, which is also PSPP's own minimum.
  const names = []
  while (rest.length > 0 && known.has(rest.at(-1))) {
    names.unshift(rest.pop())
  }
  if (names.length < 2) return null
  return {
    name: rawName,
    label: rest.join(' '),
    kind,
    variables: [...new Set(names)],
    value: kind === 'mdgroup' ? values : null,
  }
}
