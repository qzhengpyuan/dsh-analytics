/**
 * The manifest is the one place that says which build is running, and it is
 * rewritten in place by every release. Node caches JSON modules for the life of
 * the process, so `createRequire(...)('../package.json')` keeps answering with
 * the version that was on disk when the process started — after a hot reload
 * the panel then claims the old number and every verification reads it wrong.
 *
 * The file is re-read at most once a second. Keying only on mtime was not enough:
 * over SMB (a Windows host reading the Linux checkout through a mapped drive) the
 * cached attributes stay stale far longer than the edit, and the panel went on
 * reporting the previous version after three reloads.
 */
import { readFileSync, statSync } from 'node:fs'

const DEFAULT_MANIFEST = new URL('../package.json', import.meta.url)
const REREAD_MS = 1000
const cache = new Map()

function current(key) {
  if (!cache.has(key)) cache.set(key, { at: 0, stamp: null, value: { name: '', version: '' } })
  return cache.get(key)
}

export function pluginInfo(manifest = DEFAULT_MANIFEST) {
  const key = String(manifest)
  const entry = current(key)
  const now = Date.now()
  let stamp = entry.stamp
  if (now - entry.at < REREAD_MS) {
    try {
      stamp = statSync(manifest).mtimeMs
    } catch {
      return entry.value
    }
    if (stamp === entry.stamp) return entry.value
  }
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    entry.at = now
    entry.stamp = statSync(manifest).mtimeMs
    entry.value = {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
    }
  } catch {
    // Keep the last good value: an unreadable manifest must not blank the status bar.
  }
  return entry.value
}
