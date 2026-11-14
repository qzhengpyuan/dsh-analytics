import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const packageRoot = dirname(here)

/** Directory name used for one platform's prebuilt engine, e.g. `linux-x64`. */
export const platformDir = `${process.platform}-${process.arch}`

/** Executables the plugin may call, in the order they matter. */
const TOOLS = ['pspp', 'pspp-convert', 'pspp-output']

function executableFor(root, tool) {
  const candidates = process.platform === 'win32'
    ? [join(root, 'libexec', `${tool}.exe`), join(root, 'bin', `${tool}.exe`), join(root, 'bin', `${tool}.cmd`)]
    : [join(root, 'bin', tool)]
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Inspect one directory as a possible engine root.
 *
 * Two layouts are accepted: a platform directory (`engine/linux-x64/`) with
 * `bin/`, `libexec/` and `lib/`, and a flat tree (`engine/` directly holding
 * those three) which is what older bundles and hand-built prefixes look like.
 */
function inspect(base, source) {
  const bin = executableFor(base, 'pspp')
  if (!bin) return null
  const lib = join(base, 'lib')
  return {
    source,
    platform: platformDir,
    bin,
    lib: existsSync(lib) ? lib : null,
    share: existsSync(join(base, 'share', 'pspp')) ? join(base, 'share', 'pspp') : null,
    home: base,
    tools: Object.fromEntries(
      TOOLS.map((tool) => [tool, executableFor(base, tool)]).filter(([, path]) => path),
    ),
  }
}

/**
 * Resolve the PSPP engine the plugin owns.
 *
 * Order: explicit config -> environment -> the engine shipped inside this
 * package (its `<platform>-<arch>` subdirectory first, then a flat tree) -> a
 * system installation. The bundled copy is the intended production path; the
 * system fallback keeps development usable and is reported through `source`
 * so the UI can be honest about it.
 */
export function resolveEngine(config = {}) {
  const roots = []
  if (typeof config.engineDir === 'string' && config.engineDir.trim() !== '') {
    roots.push({ base: config.engineDir, source: 'configured' })
  }
  // `DSH_ANALYTICS_PSPP_ENGINE` is the pre-rename name; keep honouring it.
  const fromEnv = process.env.DSH_ANALYTICS_ENGINE || process.env.DSH_ANALYTICS_PSPP_ENGINE
  if (fromEnv) {
    roots.push({ base: fromEnv, source: 'env' })
  }
  roots.push({ base: join(packageRoot, 'engine'), source: 'bundled' })

  for (const candidate of roots) {
    const places = [join(candidate.base, platformDir), candidate.base]
    for (const base of places) {
      const engine = inspect(base, candidate.source)
      if (engine) return engine
    }
  }

  const systemPaths = process.platform === 'win32'
    ? []
    : ['/usr/bin/pspp', '/usr/local/bin/pspp', '/opt/homebrew/bin/pspp']
  for (const bin of systemPaths) {
    if (existsSync(bin)) {
      return {
        source: 'system',
        platform: platformDir,
        bin,
        lib: null,
        share: null,
        home: null,
        tools: { pspp: bin },
      }
    }
  }

  return {
    source: 'missing',
    platform: platformDir,
    // Surfaced by pspp_status and the panel: the engine is per platform, and the
    // released builds are downloadable, so name the command instead of failing
    // with a bare ENOENT later.
    hint: `没有 ${platformDir} 的 PSPP 引擎：在插件目录运行 npm run engine:fetch（或配置 engineDir 指向一份可用引擎）`,
    bin: null,
    lib: null,
    share: null,
    home: null,
    tools: {},
  }
}

/**
 * Environment for a child engine process.
 *
 * The bundled libraries live next to the binaries, so the dynamic loader has
 * to be pointed at them: `LD_LIBRARY_PATH` on Linux, `DYLD_LIBRARY_PATH` for
 * the macOS loader, and `PATH` on Windows (there is no equivalent variable for
 * a directory of DLLs that a process was not linked against).
 */
export function engineEnv(engine, extra = {}) {
  const env = { ...process.env, ...extra }
  if (!engine.lib) return env
  const separator = process.platform === 'win32' ? ';' : ':'
  env.LD_LIBRARY_PATH = [engine.lib, env.LD_LIBRARY_PATH].filter(Boolean).join(separator)
  env.DYLD_LIBRARY_PATH = [engine.lib, env.DYLD_LIBRARY_PATH].filter(Boolean).join(separator)
  if (process.platform === 'win32') {
    env.PATH = [engine.lib, env.PATH].filter(Boolean).join(separator)
  }
  return env
}

/**
 * Run one child process to completion. Never rejects on a non-zero exit;
 * callers decide what an exit code means. Rejects only when the process
 * could not be started at all.
 */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 120000,
    signal,
    input,
    maxOutputBytes = 16 * 1024 * 1024,
  } = options

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener?.('abort', onAbort)
      resolve({
        code: value.code,
        signal: value.signal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, timeoutMs)
      : null

    const onAbort = signal
      ? () => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      : null
    if (onAbort) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= maxOutputBytes) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= maxOutputBytes) stderr.push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, exitSignal) => finish({ code, signal: exitSignal }))

    if (input !== undefined) {
      try {
        child.stdin.end(input)
      } catch {
        try { child.stdin.end() } catch { /* ignore */ }
      }
    } else {
      try { child.stdin.end() } catch { /* ignore */ }
    }
  })
}
