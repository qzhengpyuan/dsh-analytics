/**
 * Turn a Node filesystem error into a sentence a user can act on.
 *
 * `EACCES: permission denied, copyfile ...` names the staging file inside the
 * plugin's own work directory, which the user has never seen and cannot fix;
 * what they need to know is which folder they cannot write to and why.
 */
export function describeFsError(error, target = '') {
  const code = String(error?.code ?? '')
  const where = target || String(error?.path ?? '')
  if (code === 'ENOENT') {
    return where
      ? `找不到这个路径：${where}（检查路径是否写错；相对路径以会话工作目录为基准）`
      : '找不到这个路径，检查一下是否写错'
  }
  if (code === 'EACCES' || code === 'EPERM') {
    // Windows reports a file another program holds open as EACCES/EPERM, so
    // "read-only directory or another user" alone would misdiagnose a locked
    // .sav (Excel still has it open) as a permissions problem.
    return where
      ? `没有权限访问 ${where}：目录是只读的、属于另一个用户，或者文件正被其他程序占用（Windows 上被 Excel/Word 打开会报这个错）。关掉占用它的程序再试`
      : '没有权限访问这个路径：目录是只读的、属于另一个用户，或者文件正被其他程序占用'
  }
  if (code === 'EBUSY') {
    return where ? `${where} 正被其他程序占用，关掉它再试` : '这个文件正被其他程序占用，关掉它再试'
  }
  if (code === 'ENOSPC') return '磁盘空间不足，写不进去'
  if (code === 'EISDIR') return where ? `${where} 是个目录，不是文件` : '这个路径是个目录，不是文件'
  if (code === 'ENOTDIR') return where ? `${where} 的上一级不是目录` : '路径中有一段不是目录'
  if (code === 'EROFS') return where ? `${where} 在只读文件系统上，写不进去` : '这个文件系统是只读的'
  if (code === 'EEXIST') return where ? `${where} 已经存在，而且不是一个能覆盖的文件（可能是个目录）` : '这个路径已经存在，不能覆盖'
  if (code === 'ENOTEMPTY') return where ? `${where} 里还有文件，不能当作空目录使用` : '目录里还有文件'
  if (code === 'ENAMETOOLONG') return '文件名太长，超过系统的上限'
  return error?.message ?? String(error)
}

/**
 * Drop `<any path>run.sps:3.1-3.10: ` and `error: ` from an engine message.
 *
 * The engine reports positions in the temporary syntax file this plugin wrote,
 * which the user has never seen: `C:\...\runs\9-8529db\run.sps:3.1-3.10: error:
 * Unknown command`. The position (3.1-3.10) is still useful when shown next to
 * the user's own syntax, the path and the `error:` prefix are not.
 */
export function stripEngineLocation(text) {
  return String(text ?? '')
    .replace(/(?:^|\s)(?:[A-Za-z]:[\\/][^\s:]*|[^\s:]*[\\/])?[^\s:\\/]*\.(?:sps|txt|dat):\d+(?:\.\d+(?:-\d+\.\d+)?)?:\s*/g, ' ')
    .replace(/^\s*(?:error|错误)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * PSPP dying on its own defect, as opposed to refusing the user's syntax.
 *
 * When a PSPP 2.1.3 bug fires it prints a bug-report banner and dies by signal:
 * Linux reports 139 (128 + SIGSEGV) and Windows reports 3, so the exit code can
 * decide neither "crashed" nor "which crash". The banner can — but only before
 * the lines are cleaned, because `stripEngineLocation` and the "last non-empty
 * line" fallback would otherwise hand the user `build_system: x86_64-w64-mingw32`
 * and call it a syntax error.
 *
 * Returns null when the text is not a crash, so callers can keep their own
 * wording for ordinary engine refusals.
 */
export function describeEngineCrash(text, code = null) {
  const source = String(text ?? '')
  if (!source) return null
  const crashed = /you have discovered a bug in pspp/i.test(source)
    || /\bsegmentation violation\b/i.test(source)
    || /proximate cause\s*:/i.test(source)
  if (!crashed) return null
  const captured = source.match(/proximate cause\s*:\s*([^\r\n]+)/i)
  const cause = captured
    ? stripEngineLocation(captured[1])
      .replace(/[^\s]*[\\/]runs[\\/][^\s]*/gi, '')
      .trim()
    : ''
  // The banner lists the build host and the version right next to the cause;
  // neither helps the user, and quoting the cause line is all that is needed.
  const reason = cause && !/^(?:build_system|host_system|version)\b/i.test(cause) ? cause : ''
  const numeric = Number(code)
  const exit = code !== null && code !== undefined && String(code).trim() !== '' && Number.isFinite(numeric)
    ? `（退出码 ${numeric}）`
    : ''
  return `引擎崩溃${exit}：这是 PSPP 引擎自身的缺陷，不是你的数据或语法问题；引擎报告的原因：${reason || '没有给出原因'}。请换一种做法再试（去掉触发它的那条统计量，或改用另一个过程），并把这条消息反馈给插件维护者`
}

/**
 * Turn engine stderr into a sentence that names the user's file, not ours.
 *
 * When PSPP cannot open a data file it prints the failure plus the path of the
 * temporary run.sps it was executing (`C:\...\runs\3\run.sps:2: error:
 * Stopping syntax file processing here...`). That path means nothing to the
 * user, and on Windows a file another program holds open surfaces as
 * "Permission denied", which reads like a permissions problem when the real
 * cause is an open Excel window.
 */
export function describeEngineError(stderr, target = '', code = null) {
  const where = target || ''
  // A crash is not "cannot open X": the file was fine, the engine died. Saying
  // "打不开" here sends the user looking for a broken file that isn't one.
  const crash = describeEngineCrash(stderr, code)
  if (crash) return where ? crash.replace(/^引擎崩溃/, `处理 ${where} 时引擎崩溃`) : crash
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(?:[\\/]runs[\\/]\d+[\\/]run\.sps|Stopping syntax file processing|error: Stopping syntax)/i.test(line))
  const text = lines.join(' ')
  if (/permission denied|access is denied|access denied/i.test(text)) {
    return where
      ? `打不开 ${where}：文件正被其他程序占用（Excel/Word/另一个 DSH 会话），或者没有读权限。关掉占用它的程序再试`
      : '打不开这个文件：它正被其他程序占用（Excel/Word/另一个 DSH 会话），或者没有读权限'
  }
  if (/no such file|does not exist|cannot open/i.test(text)) {
    return where ? `打不开 ${where}：文件不在这个位置了（可能被移动或删除）` : '打不开这个文件：它不在这个位置了'
  }
  const cleaned = stripEngineLocation(text)
  const brief = cleaned.length > 160 ? `${cleaned.slice(0, 160)}…` : cleaned
  if (!brief) return where ? `打不开 ${where}：引擎没有给出原因` : '打不开这个文件：引擎没有给出原因'
  return where ? `打不开 ${where}：${brief}` : brief
}
