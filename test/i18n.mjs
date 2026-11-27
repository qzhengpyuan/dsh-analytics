// The English panel is one dictionary plus a substring rule, so the tests that
// matter are about the rule: whole-key hits, interpolated text, and the promise
// that paths, numbers and data values come back untouched.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dictionaryFor, localize, normalizeLang, translateText } from '../lib/i18n.js'
import { normalizeSetting } from '../lib/settings.js'

let checks = 0
function check(name, run) {
  try {
    run()
    checks += 1
    console.log('ok  ', name)
  } catch (failure) {
    process.exitCode = 1
    console.log('FAIL ', name)
    console.log(failure.message)
  }
}

const en = dictionaryFor('en')

check('the english dictionary is complete enough to be called a translation', () => {
  assert.ok(Object.keys(en).length >= 900, `only ${Object.keys(en).length} entries`)
  assert.equal(en['统计分析'], 'Statistics')
  assert.equal(en['变量视图'], 'Variable View')
})

check('chinese needs no dictionary and gets none', () => {
  assert.deepEqual(dictionaryFor('zh'), {})
  assert.equal(localize('统计分析', 'zh'), '统计分析')
})

check('an interpolated export line reads as english, with plurals that fit the sentence', () => {
  const line = localize('来源：sixty.csv · 60 例 · 3 变量 · 596 B · 打开于 2026-11-16 13:20', 'en')
  assert.equal(line, 'Source: sixty.csv · 60 cases · 3 variables · 596 B · opened at 2026-11-16 13:20')
})

check('a host validation message keeps its numbers and loses its chinese', () => {
  // Taken from the validator itself: a copy written by hand drifted from the real
  // 1000–5000000 range and made the verifier report a mismatch that did not exist.
  let thrown = null
  try { normalizeSetting('maxRows', 10) } catch (failure) { thrown = failure }
  assert.ok(thrown, 'the validator rejects 10')
  assert.equal(thrown.message, 'maxRows 必须在 1000 到 5000000 之间，收到 10')
  const text = localize(thrown.message, 'en')
  assert.equal(text, 'maxRows must be 1000–5000000; received 10')
  assert.equal(/[\u4e00-\u9fff]/.test(text), false)
})

check('paths, numbers and plain ascii are left alone', () => {
  for (const text of ['/data/tmp/a.sav'.replace('临时文件', 'tmp'), 'C:\\Temp\\a.sav', '0.944', 'Descriptive Statistics', '']) {
    assert.equal(localize(text, 'en'), text)
  }
})

check('a data value that happens to be a key is only translated where the panel asks', () => {
  // 男/女 are deliberately absent: a panel that translates the user's category
  // labels would change the meaning of the table it is drawing.
  assert.equal(translateText(en, '男'), '男')
  assert.equal(translateText(en, '女'), '女')
})

check('the language setting accepts exactly the two languages it ships', () => {
  assert.equal(normalizeLang('en'), 'en')
  assert.equal(normalizeLang('zh'), 'zh')
  assert.equal(normalizeLang('EN'), 'en')
  assert.equal(normalizeLang('fr'), 'zh')
  assert.equal(normalizeLang(undefined), 'zh')
})

check('chart titles are templates, so the variable name survives the switch', () => {
  // The panel tab and the exported file name both show this string; a variable
  // called `score` must stay `score`.
  assert.equal(localize('score 的直方图', 'en'), 'Histogram of score')
  assert.equal(localize('score 与 group 的散点图', 'en'), 'Scatterplot of score and group')
  assert.equal(localize('score 按 group 的箱线图', 'en'), 'Boxplot of score by group')
  assert.equal(localize('score 的箱线图', 'en'), 'Boxplot of score')
  assert.equal(localize('group 的构成（环形）', 'en'), 'Composition of group (donut)')
  assert.equal(localize('已在第 4 行插入个案', 'en'), 'Inserted a case at row 4')
  assert.equal(localize('已删除第 2 行', 'en'), 'Deleted row 2')
})

check('a capture that is user data keeps its name', () => {
  // 0.56.0 recursed into every capture, and the dictionary has short keys such as
  // 保存/总计: a variable called 保存 came out as "Save" and the same dataset name
  // was translated in one place of a docx and not in another. Only the templates
  // listed as sentence-carrying may recurse.
  assert.equal(localize('保存 的直方图', 'en'), 'Histogram of 保存')
  assert.equal(localize('名称 的构成', 'en'), 'Composition of 名称')
  assert.equal(localize('总计 · 5 例 · 1 变量', 'en'), '总计 · 5 cases · 1 variables')
  assert.equal(localize('新建数据集（总计，未保存）', 'en'), 'New dataset(总计, unsaved)')
  assert.equal(localize('数据文件：总计', 'en'), 'Data file: 总计')
  // A note body is a sentence with numbers and names in it, so it stays as it is.
  assert.equal(localize('注：分层变量：甲（共 3 层：0.013）', 'en'), 'Note: 分层变量：甲（共 3 层：0.013）')
  // The one template that does carry a sentence still translates inside out.
  assert.equal(
    localize('A − B：不可估（该对比在数据里没有对应的自由度，通常是某一格没有观测）', 'en'),
    'A − B: not estimable (the data leaves this contrast with no degrees of freedom, usually because a cell has no observations)',
  )
})

check('a specific template beats a generic one of the same shape', () => {
  // `{0}：{1}` is long as a pattern but carries one character of text; it used to
  // win over `拆分：{0}`, leaving "拆分: grp" — half translated.
  assert.equal(localize('拆分：grp', 'en'), 'Split by: grp')
  assert.equal(localize('会话：default', 'en'), 'Session: default')
  assert.equal(localize('score · 第 1 行', 'en'), 'score · Row 1')
  assert.equal(localize('删除第 5 个个案', 'en'), 'Delete case 5')
  assert.equal(localize('整表按 score 升序', 'en'), 'Sort the whole sheet by score ascending')
  assert.equal(localize('画 score 的直方图', 'en'), 'Histogram of score')
  assert.equal(localize('第 3 行（还没有变量）', 'en'), 'Row 3 (no variable yet)')
  assert.equal(localize('在第 2 行前插入个案', 'en'), 'Insert a case before row 2')
})

// Every entry has to be reachable: a fragment left over from a message that was
// later rewritten into one sentence is dead weight nobody notices, and the dead
// ones drift out of sync with the live text. Split a key at its placeholders and
// require at least one piece to appear in the code that ships (not in tests, where
// Chinese also shows up as expected values).
check('every dictionary entry is still referenced by shipped code', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..')
  // Everything that ships: the panel bundle, the host half, and lib/. Tests are
  // excluded on purpose - Chinese there is an expected value, not a message.
  const files = ['client.js', 'index.js', 'tools-entry.js']
  for (const name of readdirSync(join(root, 'lib'))) {
    if (name.endsWith('.js')) files.push(join('lib', name))
  }
  // Wrapped template literals put newlines and indentation inside a sentence, and
  // an apostrophe inside a single-quoted literal is written `\'`, so both sides are
  // unescaped and flattened before comparing.
  const flat = (text) => text
    .replace(/\\n/g, '\n')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
  const source = flat(files.map((name) => readFileSync(join(root, name), 'utf8')).join('\n'))
  const strings = dictionaryFor('en')
  // A few entries never appear as a literal because the code assembles the sentence
  // around a value (`${head}：不可估（${reason}）`, `工具挂载（registerTools）：开`).
  // They still hit at runtime - the assembled string is the key - so they are listed
  // here with the place that builds them rather than deleted.
  const assembled = new Set([
    '不可估（该对比在数据里没有对应的自由度，通常是某一格没有观测）', // lib/contrasts.js 与 lib/workspace.js 拼在 `${head}：不可估（…）` 里
    '工具挂载（registerTools）：关', // client.js 的 tr(`工具挂载（registerTools）：${…}`)
    '工具挂载（registerTools）：开',
    '{0} 的构成（环形）', // lib/charts.js 的 `${name} 的构成${donut ? '（环形）' : ''}`
    '{0}：不可估（{1}）', // lib/contrasts.js 的 `${head}：不可估（${reason}）`，套住上面那条
  ])
  // Criterion: one piece found is enough. A stricter rule ("two pieces, or a piece
  // of six characters") was measured and rejected: it flags 21 entries that are
  // genuine fragments of longer sentences (`· 打开于`, `右轴`, `，超时`), so its
  // allowlist would be longer than the drift it prevents. What this check does
  // catch is the case that actually happens — a message rewritten into one
  // sentence, leaving its old tail in the dictionary.
  const dead = Object.keys(strings).filter((key) => {
    if (assembled.has(key)) return false
    const pieces = key.split(/\{\d+\}/).map((piece) => piece.trim()).filter((piece) => piece.length >= 2)
    if (pieces.length === 0) return false
    return !pieces.some((piece) => source.includes(flat(piece)))
  })
  assert.deepEqual(dead, [], `entries nothing references: ${dead.slice(0, 5).join(' | ')}`)
})

console.log()
if (process.exitCode) console.log(`${checks} checks passed, some failed`)
else console.log(`${checks} checks passed`)
