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
    return where
      ? `没有权限访问 ${where}：目录是只读的，或者属于另一个用户`
      : '没有权限访问这个路径：目录是只读的，或者属于另一个用户'
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
