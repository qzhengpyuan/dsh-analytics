// The English panel is one dictionary plus a substring rule, so the tests that
// matter are about the rule: whole-key hits, interpolated text, and the promise
// that paths, numbers and data values come back untouched.
import assert from 'node:assert/strict'

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
    console.log('FAIL', name)
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
  for (const text of ['/mnt/E/临时文件/a.sav'.replace('临时文件', 'tmp'), 'C:\\Temp\\a.sav', '0.944', 'Descriptive Statistics', '']) {
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

console.log()
if (process.exitCode) console.log(`${checks} checks passed, some failed`)
else console.log(`${checks} checks passed`)
