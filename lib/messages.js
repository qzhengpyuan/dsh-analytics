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
  // SPSS 用户最常撞上的「这条命令 PSPP 没有」：直接给替代命令，别让人去猜。
  {
    match: /Unknown command `CODEBOOK'/i,
    hint: 'PSPP 没有 CODEBOOK：看单变量分布用「描述统计 → 频率」，看集中趋势用「描述统计 → 描述」',
  },
  {
    // PSPP knows these command names and refuses them on purpose: the message is
    // English and looks like a syntax complaint, while the real answer is "this
    // engine does not have it, use that instead". Each one is in docs/FEATURES.md
    // as a known engine limit.
    match: /CLUSTER: CLUSTER is not yet implemented/i,
    hint: 'PSPP 2.1.3 没有层次聚类：用「分析 → 降维 → 快速聚类」（QUICK CLUSTER，K 均值）代替，或导出数据后用别的工具跑',
  },
  {
    match: /PARTIAL CORR: PARTIAL CORR is not yet implemented/i,
    hint: 'PSPP 2.1.3 没有偏相关：用「分析 → 相关 → 偏相关」，那一项由插件自己计算，不经过引擎',
  },
  {
    match: /DISCRIMINANT: DISCRIMINANT is not yet implemented/i,
    hint: 'PSPP 2.1.3 没有判别分析：两组判别可以用「分析 → 回归 → 二元 Logistic 回归」代替；多组请导出数据后用别的工具',
  },
  {
    match: /MVA: MVA is not yet implemented/i,
    hint: 'PSPP 2.1.3 没有缺失值分析（MVA）：看缺失比例用「描述统计 → 频率」加缺失值定义，填补用「数据 → 替换缺失值」',
  },
  {
    match: /is not yet implemented/i,
    hint: 'PSPP 2.1.3 还没有实现这条过程（不是你语法写错）：换成引擎支持的等价过程，或导出数据后用别的工具跑',
  },
  {
    match: /Unknown command `(TABLES|CTABLES)'/i,
    hint: 'PSPP 没有 TABLES/CTABLES：用「分析 → 描述统计 → 交叉表」或「均值」代替',
  },
  {
    match: /Unknown command `(UNIANOVA|GLM)'/i,
    hint: 'PSPP 的 GLM 只做单因子方差分析：多因子或协方差分析请改用「比较均值 → 单因素 ANOVA」或在对话里让我用 R/Python 那一侧算',
  },
  {
    match: /Unknown command `(MIXED|GENLIN|LOGISTIC REGRESSION MATRIX|SURVIVAL|COXREG|TREE|CHAID)'/i,
    hint: 'PSPP 2.1.3 没有这条过程：混合模型、生存分析、决策树都超出内置引擎的范围，可以导出数据后用别的工具跑',
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
