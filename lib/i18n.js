/**
 * Locale strings for the panel and for host-side messages.
 *
 * Chinese is the source language: the panel is written in Chinese and every
 * translatable string is its own key. English lives in `locale/en.json`, which
 * maps those keys to English. A missing key falls back to the Chinese text, so
 * a half-translated dictionary degrades to mixed language instead of blanks.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCALE_DIR = join(HERE, '..', 'locale')

const CACHE = new Map()

/** Every string this build knows how to translate, for one language. */
export function dictionaryFor(lang) {
  const wanted = lang === 'en' ? 'en' : 'zh'
  if (CACHE.has(wanted)) return CACHE.get(wanted)
  let strings = {}
  if (wanted === 'en') {
    try {
      const raw = JSON.parse(readFileSync(join(LOCALE_DIR, 'en.json'), 'utf8'))
      if (raw && typeof raw.strings === 'object' && raw.strings !== null) strings = raw.strings
    } catch {
      strings = {}
    }
  }
  CACHE.set(wanted, strings)
  return strings
}

export function normalizeLang(value) {
  // Used where a wrong value should degrade to the source language rather than
  // fail (a stored file edited by hand, a query string copied from a chat).
  return String(value ?? '').trim().toLowerCase() === 'en' ? 'en' : 'zh'
}

/**
 * Translate one message string.
 *
 * Exact hits win. Otherwise every known key that appears inside the text is
 * replaced, longest first: that is what turns `已保存 3 个表、2 张图` into
 * `Saved 3 tables, 2 charts` without a key for every number combination.
 * Strings without a Chinese character are returned untouched, which keeps paths,
 * numbers and PSPP's own English output out of the way.
 */
export function translateText(strings, text) {
  if (!strings || typeof text !== 'string' || text === '') return text
  const exact = strings[text]
  if (typeof exact === 'string') return exact
  if (!/[\u4e00-\u9fff]/.test(text) || text.length > 600) return text
  // Whole-string replacement used to fall back to "replace every key that
  // appears inside". On long sentences that produced mixed text — a variance
  // note came out as `Homogeneity of variance test的 p < 0.001…` — so the only
  // remaining pattern support is an explicit template entry with `{0}`, `{1}`:
  // the sentence is matched whole and the captured pieces are put back.
  const checkbox = /^(✓\s*)(.*)$/.exec(text)
  if (checkbox) return `${checkbox[1]}${translateText(strings, checkbox[2])}`
  for (const { pattern, value } of templatesOf(strings)) {
    const match = pattern.exec(text)
    if (!match) continue
    return value.replace(/\{(\d+)\}/g, (whole, index) => match[Number(index) + 1] ?? whole)
  }
  return text
}

const TEMPLATE_CACHE = new WeakMap()

function templatesOf(strings) {
  const hit = TEMPLATE_CACHE.get(strings)
  if (hit) return hit
  const list = Object.entries(strings)
    .filter(([key, value]) => /\{\d+\}/.test(key) && typeof value === 'string' && /\{\d+\}/.test(value))
    // Sort by literal text, not key length: a key like `{0}：{1}` is long but
    // says nothing, and it used to win over `拆分：{0}`, turning the label into
    // "拆分: grp" — half translated, which reads worse than leaving it alone.
    .sort((a, b) => b[0].replace(/\{\d+\}/g, '').length - a[0].replace(/\{\d+\}/g, '').length)
    .map(([key, value]) => ({ pattern: patternFor(key), value }))
  TEMPLATE_CACHE.set(strings, list)
  return list
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `来源：{0} · {1} 例` becomes an anchored regex with one group per slot. */
function patternFor(key) {
  const parts = key.split(/\{\d+\}/)
  return new RegExp(`^${parts.map(escapeRe).join('(.+?)')}$`)
}

/** Translate a host-side message for the given UI language. */
export function localize(text, lang) {
  const strings = dictionaryFor(lang)
  if (strings === null || Object.keys(strings).length === 0) return text
  return translateText(strings, text)
}
