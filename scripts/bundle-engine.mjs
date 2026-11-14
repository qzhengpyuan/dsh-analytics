#!/usr/bin/env node
/**
 * Build the relocatable PSPP engine that ships inside this plugin.
 *
 * The plugin never asks the user to install PSPP: this script copies the
 * engine binaries and their shared libraries into `engine/<platform>-<arch>/`,
 * then writes a launcher that resolves the libraries relative to the plugin
 * directory. `lib/engine.js` picks that directory at runtime.
 *
 * Two sources are supported.
 *
 *   1. A system installation, which is the quick path on a Linux box:
 *
 *        sudo dnf install pspp
 *        node scripts/bundle-engine.mjs
 *
 *      The resulting engine is only as portable as that machine's glibc, so a
 *      release build instead runs this inside an old distribution container
 *      and imports the *prefix* it produced (see 2).
 *
 *   2. A configure prefix, which is how the shipped engines are made. Building
 *      PSPP against an old glibc lowers the runtime requirement from 2.43 to
 *      whatever that distribution has (2.28 for AlmaLinux 8):
 *
 *        podman run --rm -v "$PWD/out:/work/out:Z" almalinux:8   # build there
 *        node scripts/bundle-engine.mjs --from-prefix /path/to/out
 *
 * macOS and Windows prefixes are handled too: dylibs get their install names
 * rewritten to `@loader_path`, DLLs land in `lib/` next to a `.cmd` launcher.
 * Those steps only run on the matching platform, so a macOS bundle has to be
 * produced on macOS (that is what .github/workflows/build-engine.yml does).
 *
 * Options:
 *   --from <path>          pspp binary to read (default /usr/bin/pspp)
 *   --from-prefix <dir>    an installed prefix: bin/, lib/, optionally share/
 *   --platform <name>      target directory name (default: this machine's
 *                          `process.platform-process.arch`)
 *   --out <dir>            engine root (default `<package>/engine`)
 *   --keep                 do not delete the target directory first
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`--${name} needs a value`)
    process.exit(1)
  }
  return value
}

const prefixDir = option('from-prefix', null)
const sourceBinary = resolve(option('from', '/usr/bin/pspp'))
const platform = option('platform', `${process.platform}-${process.arch}`)
const engineRoot = resolve(option('out', join(packageRoot, 'engine')))
const keep = argv.includes('--keep')

const isDarwin = platform.startsWith('darwin')
const isWindows = platform.startsWith('win32')
const TOOLS = ['pspp', 'pspp-convert', 'pspp-output']
const exe = isWindows ? '.exe' : ''

// glibc components must come from the host: shipping a distro copy and
// injecting it through LD_LIBRARY_PATH breaks on any other glibc build.
// Everything else (PSPP, GSL, Cairo/Pango, ...) is vendored so the engine does
// not depend on the user having PSPP installed.
const HOST_LIBC = new Set([
  'libc.so.6',
  'libm.so.6',
  'libdl.so.2',
  'libpthread.so.0',
  'librt.so.1',
  'libresolv.so.2',
  'libnss_files.so.2',
  'libnss_dns.so.2',
  'libutil.so.1',
  'libanl.so.1',
  'libmvec.so.1',
  'libcrypt.so.2',
  'ld-linux-x86-64.so.2',
  'ld-linux-aarch64.so.1',
])

// Windows resolves imports from the system directory, and those DLLs must not
// be vendored: a copy of kernel32 next to the engine would shadow the real one.
const SYSTEM_DLL = new Set([
  'advapi32.dll', 'bcrypt.dll', 'comctl32.dll', 'comdlg32.dll', 'crypt32.dll',
  'dbghelp.dll', 'dnsapi.dll', 'dwmapi.dll', 'gdi32.dll', 'gdiplus.dll',
  'imm32.dll', 'iphlpapi.dll', 'kernel32.dll', 'kernelbase.dll', 'mpr.dll',
  'msimg32.dll', 'msvcrt.dll', 'mswsock.dll', 'netapi32.dll', 'normaliz.dll',
  'ntdll.dll', 'ole32.dll', 'oleacc.dll', 'oleaut32.dll', 'powrprof.dll',
  'propsys.dll', 'psapi.dll', 'rpcrt4.dll', 'sechost.dll', 'secur32.dll',
  'setupapi.dll', 'shell32.dll', 'shlwapi.dll', 'ucrtbase.dll', 'user32.dll',
  'userenv.dll', 'uxtheme.dll', 'version.dll', 'wer.dll', 'wininet.dll',
  'winmm.dll', 'wintrust.dll', 'ws2_32.dll', 'wsock32.dll', 'wtsapi32.dll',
])

/** Shared-library file name test for the target platform. */
function isLibraryName(name) {
  if (isWindows) return /\.dll$/i.test(name)
  if (isDarwin) return /\.(dylib|so|bundle)(\.\d+)*$/.test(name)
  return name.includes('.so')
}

/** MSYS2 tools report `/mingw64/bin/x.dll`; Node needs a native path to open it. */
function hostPath(path) {
  if (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(path)) return path
  try {
    return execFileSync('cygpath', ['-w', path], { encoding: 'utf8' }).trim()
  } catch {
    return path
  }
}

if (!prefixDir && !existsSync(sourceBinary)) {
  console.error(`pspp binary not found: ${sourceBinary}`)
  console.error('Install PSPP (`sudo dnf install pspp`) or pass --from-prefix <dir>.')
  process.exit(1)
}
if (prefixDir && !existsSync(join(prefixDir, 'bin', `pspp${exe}`))) {
  console.error(`not a PSPP prefix (no bin/pspp${exe}): ${prefixDir}`)
  process.exit(1)
}
if (isDarwin && process.platform !== 'darwin') {
  console.error('a darwin engine must be bundled on macOS (install_name_tool is required)')
  process.exit(1)
}

const target = join(engineRoot, platform)
if (!keep) rmSync(target, { recursive: true, force: true })
const binDir = join(target, 'bin')
const libDir = join(target, 'lib')
const execDir = join(target, 'libexec')
for (const dir of [binDir, libDir, execDir]) mkdirSync(dir, { recursive: true })

/**
 * Read the version banner; a prefix binary needs its own library directory.
 *
 * Returns null when the binary cannot run here. That happens for a cross-arch
 * build: the linux-arm64 prefix is produced on an x86 runner, and the kernel's
 * binfmt handler reaches for an aarch64 loader this machine does not have.
 */
function psppVersion(binary, libraryDir = null) {
  const separator = isWindows ? ';' : ':'
  const env = libraryDir
    ? {
      ...process.env,
      LD_LIBRARY_PATH: [libraryDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(separator),
      DYLD_LIBRARY_PATH: [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(separator),
      PATH: [libraryDir, process.env.PATH].filter(Boolean).join(separator),
    }
    : process.env
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', env }).split('\n')[0].trim()
  } catch {
    return null
  }
}

/** Version from the installed library names, for a prefix that cannot be run here. */
function prefixVersion() {
  for (const directory of [join(prefixDir, 'lib'), join(prefixDir, 'lib64')]) {
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory)) {
      const match = /^libpspp-core-(\d+\.\d+(?:\.\d+)?)\.[a-z]/.exec(file)
      if (match) return `pspp (GNU PSPP) ${match[1]}`
    }
  }
  return null
}

const version = (prefixDir
  ? psppVersion(join(prefixDir, 'bin', `pspp${exe}`), join(prefixDir, 'lib')) ?? prefixVersion()
  : psppVersion(sourceBinary)) ?? 'pspp (GNU PSPP) (version unknown)'
/** "pspp (GNU PSPP) 2.1.3" -> "2.1.3", for prose that already names PSPP. */
const release = version.replace(/^pspp\s*\(GNU PSPP\)\s*/, '')
console.log(`bundling ${version} for ${platform}`)

const copied = new Set()

/** Copy one library into lib/; returns true when it was not there before. */
function copyLib(path) {
  if (!existsSync(path)) return false
  const name = basename(path)
  if (HOST_LIBC.has(name)) return false
  if (copied.has(name)) return false
  copyFileSync(path, join(libDir, name))
  copied.add(name)
  return true
}

/** Copy every library `ldd` reports for one binary, minus the host glibc. */
function copyLddLibraries(binary) {
  for (const path of lddDependencies(binary)) copyLib(path)
}

/** Absolute paths of the libraries `ldd` resolves for one file. */
function lddDependencies(file) {
  let output
  try {
    output = execFileSync('ldd', [file], { encoding: 'utf8' })
  } catch {
    return []
  }
  const paths = []
  for (const line of output.split('\n')) {
    const match = /=>\s+(\S+)/.exec(line) ?? /^\s*(\S+)\s+\(0x/.exec(line)
    if (!match || !/[\\/]/.test(match[1])) continue
    const path = hostPath(match[1])
    const name = basename(path)
    if (path.includes('vdso') || /^ld-(linux|musl|so)/.test(name)) continue
    if (isWindows && (SYSTEM_DLL.has(name.toLowerCase()) || /^api-ms-win-/i.test(name))) continue
    paths.push(path)
  }
  return paths
}

/**
 * Copy the whole loader closure, not just what the prefix contains.
 *
 * A Windows build links the DLLs that live in the MSYS2 tree, and Homebrew
 * keeps the macOS dependencies outside the configure prefix; in both cases the
 * prefix alone is not enough, so walk the imports until nothing new appears.
 */
function collectLoaderClosure(files) {
  const queue = [...files]
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    for (const dependency of lddDependencies(file)) {
      if (copyLib(dependency)) queue.push(join(libDir, basename(dependency)))
    }
  }
}

/** LC_RPATH entries of a macOS file, with @loader_path expanded. */
function darwinRpaths(file) {
  const listing = execFileSync('otool', ['-l', file], { encoding: 'utf8' }).split('\n')
  const rpaths = []
  for (let index = 0; index < listing.length; index += 1) {
    if (!listing[index].includes('cmd LC_RPATH')) continue
    // The value is two lines below the command: `path <value> (offset N)`.
    for (let probe = index + 1; probe < Math.min(index + 4, listing.length); probe += 1) {
      const match = /^\s*path (\S+) \(offset/.exec(listing[probe])
      if (!match) continue
      rpaths.push(expandDarwinPath(match[1], file))
      break
    }
  }
  return rpaths
}

/** `@loader_path` / `@executable_path` refer to the directory of the file itself here. */
function expandDarwinPath(path, file) {
  const directory = dirname(file)
  if (path.startsWith('@loader_path/')) return join(directory, path.slice('@loader_path/'.length))
  if (path.startsWith('@executable_path/')) return join(directory, path.slice('@executable_path/'.length))
  return path
}

/**
 * Turn one `otool -L` entry into a path on disk.
 *
 * Homebrew dylibs link each other through `@rpath`, so a reference that starts
 * with `@` still points at a real file — it just needs the LC_RPATH list of the
 * file that names it (this is what left libbrotlicommon out of the bundle).
 */
const DARWIN_FALLBACK_DIRS = ['/opt/homebrew/lib', '/usr/local/lib']

function resolveDarwinReference(path, file, rpaths) {
  if (path.startsWith('@rpath/')) {
    const rest = path.slice('@rpath/'.length)
    for (const rpath of rpaths) {
      const candidate = join(rpath, rest)
      if (existsSync(candidate)) return candidate
    }
    // A keg-only formula may be linked without the rpath that points at it;
    // the keg's lib/ directory is still reachable through the brew prefix.
    for (const directory of [...DARWIN_FALLBACK_DIRS, join(dirname(file))]) {
      const candidate = join(directory, rest)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  if (path.startsWith('@')) {
    const expanded = expandDarwinPath(path, file)
    return existsSync(expanded) ? expanded : null
  }
  return path
}

/** Absolute paths of the non-system dylibs one macOS file links against. */
function otoolDependencies(file) {
  const rpaths = darwinRpaths(file)
  const listing = execFileSync('otool', ['-L', file], { encoding: 'utf8' }).split('\n').slice(1)
  const paths = []
  for (const line of listing) {
    const path = line.trim().split(' (')[0]
    if (!path) continue
    if (path.startsWith('/usr/lib/') || path.startsWith('/System/')) continue
    const resolved = resolveDarwinReference(path, file, rpaths)
    if (!resolved) {
      console.warn(`  unresolved reference: ${path} (from ${basename(file)}; rpaths: ${rpaths.join(', ') || 'none'})`)
      continue
    }
    paths.push(resolved)
  }
  return paths
}

/**
 * macOS equivalent of the closure walk: Homebrew dylibs live outside the prefix.
 *
 * The queue holds the files where they actually live, not their copies in
 * lib/, because a dylib's LC_RPATH is written relative to its own location
 * (`@loader_path/../lib`): resolving it against the copy would point back into
 * lib/ and miss the sibling library that has not been copied yet.
 */
function collectDarwinClosure(files) {
  const queue = [...files]
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    for (const dependency of otoolDependencies(file)) {
      if (copyLib(dependency)) queue.push(dependency)
    }
  }
}

/** macOS: every reference must be relative to the binary, because SIP strips DYLD_*. */
function rewriteDarwinReferences() {
  const bundled = new Set(readdirSync(libDir))
  const ours = [
    ...TOOLS.map((tool) => join(execDir, tool)).filter((path) => existsSync(path)),
    ...[...bundled].map((name) => join(libDir, name)),
  ]
  for (const file of ours) {
    const inLib = dirname(file) === libDir
    const prefix = inLib ? '@loader_path' : '@loader_path/../lib'
    const header = execFileSync('otool', ['-D', file], { encoding: 'utf8' }).split('\n')
    const ownId = (header[1] ?? '').trim()
    if (inLib && ownId && ownId !== `${prefix}/${basename(file)}`) {
      execFileSync('install_name_tool', ['-id', `${prefix}/${basename(file)}`, file])
    }
    const listing = execFileSync('otool', ['-L', file], { encoding: 'utf8' }).split('\n').slice(1)
    for (const line of listing) {
      const path = line.trim().split(' (')[0]
      if (!path) continue
      if (path.startsWith('/usr/lib/') || path.startsWith('/System/')) continue
      const name = basename(path)
      const alreadyOurs = path.startsWith('@loader_path/') || path.startsWith('@executable_path/')
      if (!bundled.has(name)) {
        if (!alreadyOurs) console.warn(`  unbundled dependency: ${name} (from ${basename(file)})`)
        continue
      }
      if (path === `${prefix}/${name}`) continue
      execFileSync('install_name_tool', ['-change', path, `${prefix}/${name}`, file])
    }
  }
}

/** A real binary goes to libexec/, a launcher that sets the loader path to bin/. */
function installTool(source, name) {
  const execPath = join(execDir, `${name}${exe}`)
  copyFileSync(source, execPath)
  chmodSync(execPath, 0o755)
  if (!prefixDir) copyLddLibraries(source)

  if (isWindows) {
    // No LD_LIBRARY_PATH equivalent: the DLL search order needs the directory
    // on PATH before the executable starts.
    const wrapper = [
      '@echo off',
      'rem Relocatable launcher for the PSPP engine bundled with dsh-analytics.',
      'set "DIR=%~dp0.."',
      'set "PATH=%DIR%\\lib;%PATH%"',
      `"%DIR%\\libexec\\${name}.exe" %*`,
      '',
    ].join('\r\n')
    writeFileSync(join(binDir, `${name}.cmd`), wrapper)
    return
  }

  const wrapper = [
    '#!/bin/sh',
    '# Relocatable launcher for the PSPP engine bundled with dsh-analytics.',
    'DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)',
    'LD_LIBRARY_PATH="$DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    'DYLD_LIBRARY_PATH="$DIR/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"',
    'export LD_LIBRARY_PATH DYLD_LIBRARY_PATH',
    `exec "$DIR/libexec/${name}" "$@"`,
    '',
  ].join('\n')
  writeFileSync(join(binDir, name), wrapper, { mode: 0o755 })
}

if (prefixDir) {
  // An installed prefix already carries the libraries the build linked
  // against; taking all of them keeps private modules reachable too. Under
  // MSYS2 the DLLs live in bin/ rather than lib/, so both are scanned.
  const candidates = [join(prefixDir, 'lib'), join(prefixDir, 'lib64')]
  if (isWindows) candidates.push(join(prefixDir, 'bin'))
  for (const directory of candidates) {
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory)) {
      if (!isLibraryName(file)) continue
      copyLib(join(directory, file))
    }
    // libtool installs the output drivers as modules in lib/pspp/; flattening
    // them into lib/ is what lets the loader find them through the launcher.
    const modules = join(directory, 'pspp')
    if (!existsSync(modules)) continue
    for (const file of readdirSync(modules)) {
      if (!isLibraryName(file)) continue
      copyLib(join(modules, file))
    }
  }
  const binaries = []
  for (const tool of TOOLS) {
    const source = join(prefixDir, 'bin', `${tool}${exe}`)
    if (!existsSync(source)) continue
    binaries.push(join(execDir, `${tool}${exe}`))
    installTool(source, tool)
  }
  // The prefix holds PSPP's own libraries; the dependencies (Homebrew, MSYS2)
  // live elsewhere, so walk the imports and vendor whatever is still missing.
  if (isDarwin) collectDarwinClosure([...binaries, ...[...copied].map((name) => join(libDir, name))])
  if (isWindows) collectLoaderClosure(binaries)
} else {
  installTool(sourceBinary, 'pspp')
  for (const sibling of ['pspp-convert', 'pspp-output']) {
    for (const candidate of [join(dirname(sourceBinary), `${sibling}${exe}`), join(dirname(sourceBinary), sibling)]) {
      if (existsSync(candidate)) {
        installTool(candidate, sibling)
        break
      }
    }
  }
  // Private engine libraries (libpspp*.so) are not always reported by ldd for
  // every tool, and the converters reach them indirectly.
  for (const directory of ['/usr/lib64/pspp', '/usr/lib/pspp']) {
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory)) {
      if (isLibraryName(file)) copyLib(join(directory, file))
    }
  }
}

if (isDarwin) rewriteDarwinReferences()

const licenceCandidates = [
  prefixDir && join(prefixDir, 'share', 'licenses', 'pspp', 'COPYING'),
  prefixDir && join(prefixDir, 'share', 'doc', 'pspp', 'COPYING'),
  '/usr/share/licenses/pspp/COPYING',
  '/usr/share/doc/pspp/COPYING',
  '/usr/share/licenses/pspp/LICENSE',
]
const licence = licenceCandidates.find((path) => path && existsSync(path))
if (licence) copyFileSync(licence, join(target, 'COPYING'))

const runtimeNote = isWindows
  ? 'Windows binaries come from MSYS2/mingw64; `bin/pspp.cmd` prepends `lib/` to\n`PATH` so the DLLs resolve before the executable starts.'
  : isDarwin
    ? 'Built on macOS against Homebrew dependencies. Every library reference was\nrewritten to `@loader_path`, so the engine does not depend on Homebrew being\ninstalled and survives the SIP stripping of `DYLD_LIBRARY_PATH`.'
    : 'Built against glibc 2.28 (AlmaLinux 8), so any distribution from that era on\nruns it: RHEL/Alma/Rocky 8+, Ubuntu 18.10+, Debian 10+, openSUSE Leap 15+.'

const rpathNote = !isWindows && !isDarwin
  ? `
The binaries keep the build-time RPATH \`/work/out/lib/pspp\` from libtool.
That path does not exist on a user machine, so the loader skips it and uses the
\`LD_LIBRARY_PATH\` the launcher sets — harmless, but do not create such a
directory on a host you deploy to.
`
  : ''

writeFileSync(join(target, 'README.md'), `# Bundled PSPP engine (${platform})

${version}

This directory is a relocatable copy of the GNU PSPP engine used by
dsh-analytics. It is started through \`bin/pspp${isWindows ? '.cmd' : ''}\`, a launcher
that points the dynamic loader at \`lib/\`, so the plugin works on a machine
where PSPP is not installed. \`libexec/\` holds the real binaries.

${runtimeNote}
${rpathNote}
PSPP is free software under the GNU General Public License version 3 or later.
The corresponding source is the GNU PSPP ${release} release from
https://ftp.gnu.org/gnu/pspp/. Keep \`COPYING\` next to the binaries when
redistributing this plugin.
`)

/** Human-readable directory size, without depending on a `du` binary. */
function directorySize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? directorySize(path) : statSync(path).size
  }
  return total
}

const files = readdirSync(libDir).length
const bytes = directorySize(target)
const size = `${(bytes / 1024 / 1024).toFixed(0)} MB`
console.log(`engine ready: ${target} (${files} libraries, ${size})`)

// Keep the top-level README in step with what is actually on disk.
const platforms = existsSync(engineRoot)
  ? readdirSync(engineRoot).filter((name) => {
    const dir = join(engineRoot, name)
    return statSync(dir).isDirectory() && existsSync(join(dir, 'bin', 'pspp'))
  })
  : []
writeFileSync(join(engineRoot, 'README.md'), `# Bundled PSPP engines

One directory per platform and architecture; \`lib/engine.js\` picks
\`<process.platform>-<process.arch>\` and falls back to a flat tree, which is
what a hand-built prefix looks like.

Present: ${platforms.length ? platforms.map((name) => `\`${name}\``).join(', ') : '(none)'}

Rebuild with \`node scripts/bundle-engine.mjs\` (from the system install) or
\`node scripts/bundle-engine.mjs --from-prefix <dir> --platform <name>\` (from a
container build against an older glibc). See docs/install.md and
.github/workflows/build-engine.yml for the per-platform recipes.

PSPP is GPLv3+; each platform directory carries its own \`COPYING\`.
`)
