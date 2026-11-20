import { copyFile, mkdir, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'

/**
 * Windows PSPP opens data files through the ANSI code page (cp936 on a Chinese
 * system) while the rest of the program works in UTF-8. A path containing any
 * non-ASCII byte is then handed to the C runtime in a form the file system
 * cannot resolve, and the engine reports "No such file or directory" for a file
 * that plainly exists. Linux and macOS builds are unaffected.
 *
 * The engine is a third-party binary, so the fix lives here: every path the
 * engine is asked to read or write goes through an ASCII staging copy, and the
 * result is copied back by Node, which handles Unicode paths correctly.
 */

/** Whether a path is safe to hand straight to the engine. */
export function isPlainPath(value) {
  return !/[^\x00-\x7F]/.test(String(value ?? ''))
}

let sequence = 0

async function stagedName(dir, prefix, sourcePath) {
  await mkdir(dir, { recursive: true })
  sequence += 1
  return join(dir, `${prefix}-${process.pid}-${sequence}${extname(sourcePath) || '.dat'}`)
}

/**
 * Copy a file the engine has to *read* into an ASCII path.
 * `dispose()` removes the copy; reading never writes anything back.
 */
export async function stageInput(filePath, dir) {
  const source = String(filePath)
  if (isPlainPath(source)) return { path: source, staged: false, dispose: async () => {} }
  const path = await stagedName(dir, 'in', source)
  await copyFile(source, path)
  return { path, staged: true, dispose: () => rm(path, { force: true }).catch(() => {}) }
}

/**
 * Give the engine an ASCII path to *write*, then move the result where the user
 * asked for it. `commit()` copies back and cleans the staging file up.
 */
export async function stageOutput(targetPath, dir) {
  const target = String(targetPath)
  if (isPlainPath(target)) {
    return { path: target, staged: false, commit: async () => target, dispose: async () => {} }
  }
  const path = await stagedName(dir, 'out', target)
  const commit = async () => {
    await copyFile(path, target)
    await rm(path, { force: true }).catch(() => {})
    return target
  }
  return { path, staged: true, commit, dispose: () => rm(path, { force: true }).catch(() => {}) }
}

/**
 * Read-modify-write of one file, e.g. replaying multiple-response definitions
 * into a .sav. `commit()` copies the edited bytes back over the original.
 */
export async function stageFile(filePath, dir) {
  const source = String(filePath)
  if (isPlainPath(source)) {
    return { path: source, staged: false, commit: async () => source, dispose: async () => {} }
  }
  const path = await stagedName(dir, 'rw', source)
  await copyFile(source, path)
  return {
    path,
    staged: true,
    commit: async () => {
      await copyFile(path, source)
      await rm(path, { force: true }).catch(() => {})
      return source
    },
    dispose: () => rm(path, { force: true }).catch(() => {}),
  }
}
