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
 * Turn engine stderr into a sentence that names the user's file, not ours.
 *
 * When PSPP cannot open a data file it prints the failure plus the path of the
 * temporary run.sps it was executing (`C:\...\runs\3\run.sps:2: error:
 * Stopping syntax file processing here...`). That path means nothing to the
 * user, and on Windows a file another program holds open surfaces as
 * "Permission denied", which reads like a permissions problem when the real
 * cause is an open Excel window.
 */
export function describeEngineError(stderr, target = '') {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(?:[\\/]runs[\\/]\d+[\\/]run\.sps|Stopping syntax file processing|error: Stopping syntax)/i.test(line))
  const text = lines.join(' ')
  const where = target || ''
  if (/permission denied|access is denied|access denied/i.test(text)) {
    return where
      ? `打不开 ${where}：文件正被其他程序占用（Excel/Word/另一个 DSH 会话），或者没有读权限。关掉占用它的程序再试`
      : '打不开这个文件：它正被其他程序占用（Excel/Word/另一个 DSH 会话），或者没有读权限'
  }
  if (/no such file|does not exist|cannot open/i.test(text)) {
    return where ? `打不开 ${where}：文件不在这个位置了（可能被移动或删除）` : '打不开这个文件：它不在这个位置了'
  }
  const brief = text.length > 160 ? `${text.slice(0, 160)}…` : text
  if (!brief) return where ? `打不开 ${where}：引擎没有给出原因` : '打不开这个文件：引擎没有给出原因'
  return where ? `打不开 ${where}：${brief}` : brief
}
