/**
 * 「跟着做一遍」：把示例数据能做的六七个分析排成一条有先后顺序的路线。
 *
 * 每一步只有三种形状之一：
 *   - `syntax`：一条 PSPP 语法，交给真引擎跑（走的路径与面板「分析」菜单完全一样）；
 *   - `compute`：不碰引擎的插件计算（功效与样本量、数据体检）；
 *   - `sample`：打开内置示例数据。
 *
 * 放在宿主半而不是客户端：这样 `api/guide/run` 能直接用真引擎验证每一步，
 * 面板只负责把返回的表格与句子摆出来。
 */

export const GUIDE_STEPS = [
  {
    id: 'open-sample',
    kind: 'sample',
    title: '打开示例数据（员工 60 例）',
    why: '不用先准备数据：这 60 例有性别、部门、工龄、月薪、绩效、是否参加培训与满意度，值标签是齐的。',
    look: '数据视图里出现 8 个变量、60 例；值标签把 0/1/2/3 显示成「没参加」「研发」这类文字。',
  },
  {
    id: 'describe',
    kind: 'syntax',
    title: '描述统计：三个连续变量的均值与标准差',
    syntax: 'DESCRIPTIVES salary performance tenure.',
    why: '拿到数据先看量纲和离散程度：均值与标准差差几十倍，就说明单位或者录入有问题。',
    look: '每行一个变量的 n、均值、标准差；示例数据里月薪约 1 万、工龄约 6 年。',
  },
  {
    id: 'frequencies',
    kind: 'syntax',
    title: '频数 + 条形图：两个分类变量的分布',
    syntax: 'FREQUENCIES dept training /BARCHART.',
    why: '分类变量要先确认每类都有足够的个案，某一类只有两三个的话后面所有分组检验都不稳。',
    look: '部门与培训各 20 例 / 30 例，比例还算均匀；图里能直接看出有没有偏斜。',
  },
  {
    id: 'crosstab',
    kind: 'syntax',
    title: '交叉表 + 卡方：部门与是否参加培训',
    syntax: 'CROSSTABS /TABLES=dept BY training /STATISTICS=CHISQ PHI.',
    why: '两个分类变量的关系先看交叉表的每格个案数与卡方。',
    look: '示例数据是按设计配平的，卡方不显著（p 远大于 0.05）—— 这正是「没有关系」长什么样。',
  },
  {
    id: 'ttest',
    kind: 'syntax',
    title: '独立样本 t 检验：参加过培训的人月薪更高吗',
    syntax: 'T-TEST GROUPS=training(0 1) /VARIABLES=salary.',
    why: '一组连续变量按两组比较，是最常见的问题；表里同时给 Levene 方差齐性检验，方差不齐时要不假定方差相等那一行。',
    look: '示例数据里培训组的月薪高一截、p < 0.05；句子会写明用的是哪一行。',
  },
  {
    id: 'correlation',
    kind: 'syntax',
    title: '相关矩阵：工龄、月薪、绩效',
    syntax: 'CORRELATIONS /VARIABLES=tenure salary performance.',
    why: '两个连续变量的关系先看相关：r 的绝对值小于 0.3 时，后面的回归多半也讲不出什么。',
    look: '工龄与月薪、工龄与绩效都正相关；相关不等于因果，注文里会提示。',
  },
  {
    id: 'regression',
    kind: 'syntax',
    title: '线性回归：用工龄与绩效解释月薪',
    syntax: 'REGRESSION /DEPENDENT=salary /METHOD=ENTER tenure performance.',
    why: '把「谁影响谁」写成模型：R² 说解释了多少，系数说每变化一个单位影响多少。',
    look: '示例数据 R² 约 0.39；两个自变量的系数都显著，常数项是「工龄与绩效都为 0」时的基线。',
  },
  {
    id: 'power',
    kind: 'compute',
    title: '功效与样本量：60 例够不够',
    why: '做完检验再补一件事：这个样本量对中等效应（Cohen\'s d = 0.5）有多少把握度。写方法学一节要用这两个数。',
    look: '每组要 64 例才有 0.8 的把握度；示例数据每组 30 例，把握度明显不够 —— 不显著时要分清「没关系」与「看不出」。',
  },
  {
    id: 'profile',
    kind: 'compute',
    title: '数据体检：这份数据哪里会出事',
    why: '把上面每一步都自己看一遍很费时间；数据体检一次性列出空列、常量列、文本存数字、编号列、离群与重复列。',
    look: '示例数据是干净的（没有必须先处理的问题）；编号列 id 会被标出来，提醒它不该进模型。',
  },
]

const BY_ID = new Map(GUIDE_STEPS.map((step) => [step.id, step]))

/** 给面板的一份清单：只留可以公开的字段，语法也带上（用户想复制去自己跑）。 */
export function guideList() {
  return GUIDE_STEPS.map((step) => ({
    id: step.id,
    kind: step.kind,
    title: step.title,
    why: step.why,
    look: step.look,
    syntax: step.syntax ?? null,
  }))
}

/** 按 id 找一步；找不到就报中文，并列出可用 id。 */
export function findGuideStep(id) {
  const key = String(id ?? '').trim()
  const step = BY_ID.get(key)
  if (!step) throw new Error(`没有这一步：${key}（可用 ${GUIDE_STEPS.map((entry) => entry.id).join('、')}）`)
  return step
}
