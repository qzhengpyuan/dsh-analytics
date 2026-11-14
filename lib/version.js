/**
 * The manifest is the one place that says which build is running, and it is
 * rewritten in place by every release. Node caches JSON modules for the life of
 * the process, so `createRequire(...)('../package.json')` keeps answering with
 * the version that was on disk when the process started — after a hot reload
 * the panel then claims the old number and every verification reads it wrong.
 * Read the file, keyed by mtime so a busy poll loop does not re-parse it.
 */
import { readFileSync, statSync } from 'node:fs'

const manifest = new URL('../package.json', import.meta.url)
let cached = { stamp: null, value: { name: '', version: '' } }

export function pluginInfo() {
  try {
    const stamp = statSync(manifest).mtimeMs
    if (stamp !== cached.stamp) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      cached = {
        stamp,
        value: { name: typeof parsed.name === 'string' ? parsed.name : '', version: typeof parsed.version === 'string' ? parsed.version : '' },
      }
    }
  } catch {
    // Keep the last good value: an unreadable manifest must not blank the status bar.
  }
  return cached.value
}
