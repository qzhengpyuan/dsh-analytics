// 方法建议 → 真跑一次：面板的「运行」按钮与 agent 走同一条调用。
//
// 建议里带的 `how` 是（工具名 + 参数），本来只有 agent 能执行。面板要让人点一下
// 就跑，必须复用同一份参数，否则「建议说跑 A、面板跑了 B」。这里按工具名分派到
// 宿主已有的方法上：
//   pspp_analyze      → buildAnalysis（tools.js 的纯函数）+ runSyntax
//   pspp_chart        → addChart（图形由插件自算，不经过引擎）
//   pspp_cox / pspp_poisson / pspp_multinomial → 宿主上已有的计算入口
// 其余工具（例如要写文件的导出）不接：面板没有对应视图，硬跑只会把结果塞进用户
// 看不懂的地方。那种建议让 agent 在对话里执行。
import { buildAnalysis } from './tools.js'
import { adviceInvocation } from './advise.js'

/** 面板里能一键运行的工具；不在名单里的一律转给 agent。 */
export const ADVICE_RUNNABLE = new Set(['pspp_analyze', 'pspp_chart', 'pspp_cox', 'pspp_poisson', 'pspp_multinomial'])

const PICK = (source, keys) => {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

/**
 * 跑第 index 条建议。返回 `{ index, analysis, tool, params, syntax, runId, … }`，
 * 路由把 `state` 一并回给面板，面板据此刷新输出树。
 *
 * 只认结果里的参数，不接受客户端传进来的 params：跑哪条由序号决定，内容由
 * `adviseDataset` 当场重算。`adviseMethods({ append: false })` 保证这次重算不往
 * 输出树里再塞一张建议表。
 */
export async function runAdvice(workspace, adviseResult, index) {
  const call = adviceInvocation(adviseResult, index)
  if (!ADVICE_RUNNABLE.has(call.tool)) {
    throw new Error(`第 ${call.index + 1} 条建议要用 ${call.tool} 执行，面板里没有这一类结果视图：让 agent 跑一次，或者在对话框里按提示操作`)
  }
  if (!workspace?.dataset) throw new Error('还没有打开数据集：先导入数据或新建一个')
  const findVariable = (name) => (name ? workspace.dataset.variables.find((variable) => variable.name === name) ?? null : null)
  if (call.tool === 'pspp_analyze') {
    const procedure = String(call.params.procedure ?? '')
    if (!procedure) throw new Error('这条建议没有写明要跑哪个过程（procedure），不能一键运行')
    const column = findVariable(call.params.column ?? call.params.columns ?? null)
    const group = findVariable(call.params.by ?? call.params.group ?? null)
    const syntax = buildAnalysis(procedure, {
      ...call.params,
      columnMeasure: column?.measure ?? null,
      groupString: group ? group.type === 'string' : false,
    })
    // 与 `pspp_analyze` 一样把「这一组来自哪个变量」写进输出项：面板随后才会
    // 在输出上给出「两两比较」这种跟随该次运行的入口。
    const pairwise = ['ttest_independent', 'oneway', 'glm'].includes(procedure)
      && call.params.by
      && Array.isArray(call.params.variables) && call.params.variables.length > 0
      ? { group: call.params.by, variables: call.params.variables }
      : null
    const result = await workspace.runSyntax(syntax, { pairwise })
    return { ...call, syntax, runId: result.runId, items: result.items?.length ?? 0 }
  }
  if (call.tool === 'pspp_chart') {
    const drawn = await workspace.addChart(call.params.type, call.params)
    return { ...call, syntax: null, runId: drawn.runId, itemId: drawn.item.id, chart: drawn.chart }
  }
  // 插件自算的过程（Cox / Poisson / 多项 Logistic）不产生语法，表也不挂在某次
  // 引擎运行上：`runId` 一律回 null，面板按「插件表」这一批刷新。
  if (call.tool === 'pspp_cox') {
    const result = workspace.coxTable(PICK(call.params, ['time', 'event', 'covariates', 'strata', 'start']))
    const last = result.items[result.items.length - 1]
    return { ...call, syntax: null, runId: null, itemId: last.id, title: last.title }
  }
  if (call.tool === 'pspp_poisson') {
    const result = workspace.poissonTable(PICK(call.params, ['dependent', 'independents']))
    const last = result.items[result.items.length - 1]
    return { ...call, syntax: null, runId: null, itemId: last.id, title: last.title }
  }
  const result = workspace.multinomialTable(PICK(call.params, ['dependent', 'independents', 'reference']))
  const last = result.items[result.items.length - 1]
  return { ...call, syntax: null, runId: null, itemId: last.id, title: last.title }
}
