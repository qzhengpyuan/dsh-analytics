// The English panel is one dictionary plus a substring rule, so the tests that
// matter are about the rule: whole-key hits, interpolated text, and the promise
// that paths, numbers and data values come back untouched.
import assert from 'node:assert/strict'

import { dictionaryFor, localize, normalizeLang, translateText } from '../lib/i18n.js'

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
  const text = localize('maxRows 必须是 100 到 2000000 之间的整数，收到 10', 'en')
  assert.equal(text, 'maxRows must be 100–2000000 as an integer; received 10')
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

console.log()
if (process.exitCode) console.log(`${checks} checks passed, some failed`)
else console.log(`${checks} checks passed`)
