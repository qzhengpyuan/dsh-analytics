/**
 * PSPP speaks English (its Chinese catalogue covers only part of the program),
 * and its messages are written for people who already know what the command
 * does. A student who typed `SELECT IF` on a fresh session gets
 *
 *   error: FREQUENCIES: FREQUENCIES is allowed only after the active dataset
 *   has been defined.
 *
 * which names neither the cause nor the fix. This module keeps the engine text
 * as the record of what happened and adds one short Chinese sentence saying
 * what to do about it. The dictionary is deliberately pattern-based: PSPP
 * embeds variable and file names in the sentence, so an exact-match table would
 * never hit.
 */

const RULES = [
  {
    match: /is allowed only after the active dataset has been defined/i,
    hint: '这条命令需要先有数据集：先打开一个数据文件，或新建数据集并定义变量',
  },
  {
    match: /Stopping syntax file processing here/i,
    hint: '出错后引擎停止了后面的语句，下面的结果可能不完整',
  },
  {
    match: /No such file or directory|cannot be opened for reading|Could not open .* for reading/i,
    hint: '文件打不开：确认路径存在；Windows 上路径含中文时旧版引擎会读不到，本插件已做中转',
  },
  {
    match: /is not a variable name/i,
    hint: '这不是数据集里的变量名：检查拼写，或这一步依赖的上一条变换还没成功',
  },
  {
    match: /is not a system or portable file/i,
    hint: '这不是 SPSS 数据文件（.sav/.por/.sys）：先用「打开数据」导入 CSV/Excel',
  },
  {
    match: /At least two variables are required/i,
    hint: '多选题至少要选两个变量',
  },
  {
    match: /MRSETS is implemented but no other commands support/i,
    hint: 'PSPP 只保存多选题定义、不做统计；请用「转换 → 多选题面板」看频数与交叉表',
  },
  {
    match: /Variable .* is not numeric|requires numeric/i,
    hint: '这个位置需要数值变量，字符串变量不能参与计算',
  },
  {
    match: /expecting (?:one of the following|an? )|Syntax error expecting/i,
    hint: '语法错误：这里的写法不被接受，按提示里的关键字改写',
  },
  {
    match: /Unknown command|not a recognized command/i,
    hint: '没有这条命令：检查命令拼写（PSPP 与 SPSS 的命令集不完全相同）',
  },
  {
    match: /There is no .* in the dictionary|undefined variable/i,
    hint: '字典里没有这个变量：先确认变量名，或它在上一步已经被删除/改名',
  },
  {
    match: /Invalid (?:number|integer|value)/i,
    hint: '数值写法不合法：检查括号里的取值或格式',
  },
  {
    match: /No valid cases|no cases were found|There are no cases/i,
    hint: '没有可分析的有效个案：检查筛选条件、缺失值定义，或变量是否全为空',
  },
  {
    match: /Matrix is singular|singular matrix|cannot be inverted/i,
    hint: '矩阵奇异：自变量之间存在完全共线，或样本量太小',
  },
  {
    match: /Too many variables|out of memory/i,
    hint: '规模超出引擎限制：减少变量或拆分数据集',
  },
  {
    match: /File already exists/i,
    hint: '目标文件已存在：换一个文件名，或先删掉旧文件',
  },
]

/** Chinese one-liner for an engine message, or null when nothing matches. */
export function explainMessage(message) {
  const text = String(message ?? '')
  if (text === '') return null
  for (const rule of RULES) {
    if (rule.match.test(text)) return rule.hint
  }
  return null
}

/** Attach `hint` to one diagnostic (keeps `message` untouched). */
export function explainDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return diagnostic
  const hint = explainMessage(diagnostic.message)
  return hint ? { ...diagnostic, hint } : diagnostic
}
