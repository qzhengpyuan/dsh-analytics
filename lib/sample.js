/**
 * 内置示例数据：一份小型的「员工」数据集，字段都是 SPSS 课程里最常见的形状
 * （分类变量带值标签、连续变量、0/1 指示、计数），加起来 60 例。
 *
 * 目的只有一个：新装好插件的人不用先去找数据，点「帮助 → 打开示例数据」就能
 * 立刻看到描述统计、交叉表、t 检验、相关与图。
 */

const DEPARTMENTS = [
  { code: 1, label: '研发' },
  { code: 2, label: '市场' },
  { code: 3, label: '客服' },
]

const SEXES = [
  { code: 0, label: '女' },
  { code: 1, label: '男' },
]

// 固定的伪随机序列：每次都得到同一份数据，截图与用例才可复现。
function sequence(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function sampleDataset() {
  const random = sequence(20261126)
  const rows = []
  for (let index = 0; index < 60; index += 1) {
    const sex = index % 2
    const dept = DEPARTMENTS[index % 3].code
    const tenure = 1 + Math.floor(random() * 18)
    const training = random() < 0.45 ? 1 : 0
    // 薪资：部门基线 + 工龄 + 培训 + 噪声，好让 t 检验与回归都有话说。
    const salary = Math.round(6800 + dept * 900 + tenure * 190 + training * 700 + (random() - 0.5) * 1600)
    const performance = Math.round((55 + tenure * 1.1 + training * 6 + (random() - 0.5) * 12) * 10) / 10
    const satisfaction = Math.min(10, Math.max(1, Math.round(4 + performance / 20 + (random() - 0.5) * 4)))
    rows.push([index + 1, sex, dept, tenure, salary, performance, training, satisfaction])
  }
  return {
    name: '示例数据（员工）',
    variables: [
      { name: 'id', label: '编号', type: 'numeric', measure: 'nominal' },
      { name: 'sex', label: '性别', type: 'numeric', measure: 'nominal', valueLabels: { 0: '女', 1: '男' } },
      { name: 'dept', label: '部门', type: 'numeric', measure: 'nominal', valueLabels: { 1: '研发', 2: '市场', 3: '客服' } },
      { name: 'tenure', label: '工龄（年）', type: 'numeric', measure: 'scale' },
      { name: 'salary', label: '月薪（元）', type: 'numeric', measure: 'scale' },
      { name: 'performance', label: '绩效分', type: 'numeric', measure: 'scale' },
      { name: 'training', label: '参加过培训', type: 'numeric', measure: 'nominal', valueLabels: { 0: '没参加', 1: '参加过' } },
      { name: 'satisfaction', label: '满意度（1-10）', type: 'numeric', measure: 'ordinal' },
    ],
    rows,
    sexes: SEXES,
    departments: DEPARTMENTS,
  }
}

/** 打开示例数据后顺手跑的一小段语法：描述、频数、t 检验、相关。 */
export const SAMPLE_SYNTAX = [
  'DESCRIPTIVES VARIABLES=tenure salary performance satisfaction',
  '  /STATISTICS=MEAN STDDEV MIN MAX.',
  'FREQUENCIES VARIABLES=sex dept training /BARCHART.',
  'T-TEST GROUPS=training(0 1) /VARIABLES=performance.',
  'CORRELATIONS /VARIABLES=tenure salary performance.',
].join('\n')
