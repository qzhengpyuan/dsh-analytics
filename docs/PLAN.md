# 工作计划（lead × Win10 共同维护）

> 这份文件回答：**接下来按什么顺序做什么、每件事怎么算做完、谁验。**
> 已完成的历史在这里只留一行（详细过程在 [CHANGELOG.md](CHANGELOG.md)，成品能力在 [FEATURES.md](FEATURES.md)，里程碑状态在 [ROADMAP.md](ROADMAP.md)）。
> 规则：**每完成一批，就把条目从第 3 节挪到第 1 节的回顾里压成一行，同时补第 3 节的新条目。** 不让它变成第二份 CHANGELOG。

## 0. 协作与节奏

| 谁 | 负责 |
| --- | --- |
| lead（本机） | 实现、单测、发版链（tag/CI/pack/Release/热重载）、按验收判据自检 |
| Win10 | 独立复验：按 V 项逐条取证（真机渲染、真引擎、变异测试）、给 P1–P3、指出规划里漏掉的风险 |

- **一批一发**：一批 = 一个主题、10 条以上改动、1–3 天。批内做完跑全量 `npm test` + 自检，才发一次 `remote_send_message`（`operationId lead-<版本>-verify-<序号>`），报告落 `X:\临时文件\win10-report-<版本>.md`。
- **报告回来一次修完**：P0–P2 全部修完再发下一批，不逐条往返；P3 可以并进下一批。
- **发布 ≠ 送验**：版本号一改一版（便于 bisect），送验按批。
- **改动登记**：每批完成时更新 CHANGELOG（过程）＋ FEATURES（能力）＋ 本文件（挪行）＋ ROADMAP（里程碑勾选）。
- 新增断言必须**做过删除式变异验证**（把修复删掉要变红），否则不算测过。

## 1. 已完成（压缩回顾，一行一批）

| 版本区间 | 干了什么 | 一句话结论 |
| --- | --- | --- |
| 0.1.0–0.24.x | 把 GNU PSPP 2.1.3 打包成插件引擎，建工作区/导入导出/23 个 `pspp_*` 工具、SPSS 风格四视图与对话框 | 引擎能跑、面板能用、工具能挂预设 |
| 0.25.x | 数据来源可辨：数据集指纹、`provenance` 随表输出、心跳轮询（state 12 KB → 688 B） | 一张表能说清来自哪份数据 |
| 0.26.x | 工具收进「统计分析」预设（不泄漏到别的会话）；打包自检（`registerTools` 泄漏事故的修复） | 预设隔离成立，产物解包复核 |
| 0.27.x | 设置面板、对话框「粘贴/帮助」、交叉表 Fisher/Kappa、ICC 自算、一条命令安装、UI 对齐第一轮 | 参数不再散落在对话框里 |
| 0.28.x | 路径白名单（`lib/paths.js` 单点闸门）、Word/Excel 跟随表格样式、runs 目录唯一化 | 面板不能被诱导读写凭据文件 |
| 0.29.x–0.31.x | 大表先画 200 行 + 显示全部；输出树按「运行 N」分组；导出体积上限；截断提示 | 几千行的表不再卡死面板 |
| 0.32.x | 英文界面（中文原文当 key，1339 条词条）、水合契约、菜单助记键、时延直连 | 双语外壳，切换 30 ms 级 |
| 0.33.x–0.47.x | 数据重构（个案↔变量）、编辑菜单补全、多数据集并行、撤销内存预算、`stripEngineLocation` | 数据整理这一块补齐 |
| 0.48.x–0.54.x | 多窗口一致性（revision/409/冲突对话框）、注文体系（期望频数/方差齐性/正态性/多重比较/样本量/共线/DW）、PSPP 缺陷绕法（RISK 段错、EXAMINE 只给第一个变量、0 行静默） | 数字会说话，缺陷有解释 |
| 0.55.x–0.56.x | 节奏改造（成批）、死词条门禁、`${}` 漏翻族收口（模板 + 捕获位白名单）、静默命令诊断、引擎崩溃文案、更新检查 | 英文界面不再半截，误诊不再胡说 |
| 0.57.0 | 语法模板库、运行历史（回填/重跑）、SPSS 式工具栏提示、报告成册（docx/html，封面+目录+编号+来源） | 界面第一次有"新东西"，不是一个修字 |

## 2. 进行中

| 批 | 内容 | 状态 |
| --- | --- | --- |
| 0.57.1 | 自检补强：21 条模板逐条过真引擎、两条手写模板进 smoke、运行历史持久化断言；新增本文件 | 已发布 |
| 0.57.2 | 修 0.57.0 报告：P1 图自成一节（不再配给表）+ 图表行有勾选框、P2 图标 title 全量还原、P3×3 | 已发布 |
| 0.57.3 | 送验 0.57.2（V-a…V-d + 回归）；等回执 | 送验中 |
| 0.57.3 | 工具栏提示：改成落上就显示（用户要求），配色改成固定的深底浅字（皮肤下半透明 token 造成的字同底色） | 已发布 |
| 0.58.0 | 导入向导：预览（编码/分隔符/跳过行/列名与类型/前 20 行）+ 缺失值标记 + 工作表；`pspp_open` 同参数 | 已发布 |
| 0.59.0 | 图表工作台：副标题 + 多图拼版（2×2/1×2/2×1）+ 光栅器组偏移；用户标题不被翻译 | 已发布 |
| 0.60.0 | 重绘为另一种图（`redrawOf`）+ PNG 导出倍率 1×–4× | 已发布 |
| 0.61.0 | GLM 模型选择（自动/主效应/自定义）；回归诊断图（残差散点 + 正态 P-P，自算）；GLM 协变量与保存因引擎不支持而明确不做 | 已发布 |
| 0.61.1 | 修 0.58.0 报告 P1（提示条被宿主皮肤染色）+ P2×2（CSV 跳过头文案、缺失标记判据统一） | 已发布 |
| 0.62.0 | 数据编辑器增强：计算变量表达式构建器、变量视图批量修改、导入跳过表尾行 | 已发布 |
| 0.63.0 | 可发现性：快捷键一览、关于对话框、三入口区分、Alt+1…4 真接通 | 已发布 |
| 0.64.0 | 散点图按类别着色（第三变量分组 + 图例），`pspp_chart` 的 `group` | 已发布 |
| 0.65.0 | 条形图支持分类变量（计次 / 百分比），对标 SPSS 图形 → 条形图 | 已发布 |
| 0.66.0 | 修 0.63.0 复验报告：引擎版本进 state、图表编辑器回填且只发改动项、新建图表只弹一个模态、表达式悬空运算符、measure 译法、预览错误就地显示 | 已发布 |
| 0.67.0 | 替换缺失值补齐 SPSS 五种方法（含 `span`）+ README 补界面图小节（Win10 截的四张真机图） | 已发布 |

## 3. 下一批详细规划

排序即优先级。每项都写清：**做什么 / 为什么 / 怎么算做完 / 落点**。

### 3.1 批 0.57.3 —— 复验收尾（送验中，半天）

0.57.2 已修完 0.57.0 报告的 P1/P2/P3×3，等 `lead-0572-verify-0115` 回执。

- [ ] 报告回来后只处理新发现的 P0–P2；P3 并进下一批。
- [x] 模板可跑性：21 条逐条把 `<>` 换成真实变量跑真引擎（0.57.1 探针）—— 20 条出表/改数据，"第 21 条"`LOGISTIC REGRESSION` 停下的原因是因变量非二分（引擎原话），不是模板写错；这条口径要写进判据，别把数据问题算成 21/21 不成立。
- [x] 图表行勾选框（0.57.2）：输出树里图与表一样有框，取消勾选后成册里该图消失。
- [x] `api/update` 归因：插件侧已放到自家闸门之前，但宿主 `/api` 围栏仍要启动令牌（实测 `api/version` 同样 401）⇒ 外部脚本拿不到是宿主行为，不再当插件 bug 追。
- [ ] 仍未自证：成册在**多表多图混合**时的编号连续（已有一条 3 条目用例，多图待补）、`.html` 打印预览不缺图（需真机）。

### 3.2 批 0.58.0 —— 导入向导（已完成，0.58.0 发布）

**为什么提前**：它要动 `buildTable` 的两个既有口径（首行即表头、列类型靠推断），而这两条已被 `test/client.mjs` / `test/poll.mjs` 的文案断言锁住；越晚动，越多新用例建在旧假设上。

- [x] 向导：编码、分隔符、跳过前 N 行、首行是否变量名、逐列变量名与类型、前 20 行预览，改任一项重读。**日期类型没做**（PSPP 里日期是格式不是类型，留到 0.61 之后看需求）。
- [x] 缺失值标记：`NA`、`-9` 登记成用户缺失值，随 `.sav` 落盘（`MISSING VALUES`）。
- [x] 工作表选择：向导里直接列工作表名；`test/import.mjs` 覆盖「第二张表」与「按名字选」，索引路径由 `previewImport` 的数字分支覆盖。
- [x] 判据（评审补的三条）：
  - `V-e` GBK 的 CSV 带中文表头「年龄」→ 变量名 ASCII、label 为「年龄」、notes 里有一条改名说明。
  - `V-f` 声明 `-9` 为用户缺失值 → `writeSav()` 后再 `GET FILE` 读回字典，`MISSING VALUES` 仍在（只断言内存变量不算）。
  - `V-g` `skipRows` 生效后，凡文案里出现「第 N 行 / 第一行」的地方行号必须跟着变（否则用户看到错误行号）。
- [ ] 风险：逐列强制「字符串」时 `lib/dataset.js:313` 的宽度推断要走 A 格式分支，这条路目前没有真引擎用例。
- [ ] 落点：`lib/dataset.js`、`lib/xlsx.js`、`lib/routes.js`（`api/previewImport`）、`client.js`、`pspp_import` 参数。

### 3.3 批 0.59.0 —— 图表工作台（已完成，0.59.0 发布）

**评审改了两处**：① 「误差条」不是一个独立类型（`lib/tools.js:1271` 的枚举是 `bar/histogram/scatterplot/boxplot/line/pie/area`，误差线是 bar 的一个模式，见 `lib/charts.js` 的 `ERROR_BAR_LABELS`）；② 「重绘为其它类型」拆到 0.60.0 单独立项。

**落地时的第三个判断**：不做「图表构建器」对话框。七种类型各自的对话框已经在 `图形` 菜单里，误差线早已在条形图「选项」里，再套一层「先选类型再填目标框」只是菜单套菜单，反而多两次点击。本批做真正缺的两件：副标题、多图拼版。

- [x] 图注副标题：`lib/charts.js` 的 `applyChartOverrides` 认 `subtitle`（空串删除），`renderSvg` 画在标题下 `y=36`；`updateChart` 白名单加 `subtitle`；`pspp_chart` 加 `subtitle`。
- [x] 一页多图拼版：`图形 → 图表拼版…`，2×2 / 1×2 / 2×1，**按勾选顺序**左上→右下；`composeChartGrid()` 生成单文档单背景（不嵌嵌套 `svg`），`lib/raster.js` 补组 `transform` 支持，导出 PNG 与浏览器一致；`pspp_chart` 加 `grid: {items, layout}`。
- [x] 用户的标题/副标题不再被 `localize()` 再翻一次（`addChart`/`updateChart` 只在 `options.title === undefined` 时翻生成的标题）。
- [x] 判据（评审四条 + 实施修正）：
  - `V-h` 条形图 + 误差线 ±1 SD → 模型 `categories` 带 `errorLow/errorHigh`（真引擎与模型侧早有用例，本批未改）。
  - `V-i` **改用像素尺寸而非宽高比**：评审算的「2×2 ≈ 1.0」不成立 —— 每格是 560×360，2×2 拼版是 1148×748，宽高比仍是 1.53。`test/charts.mjs` 断言 `1x2` 拼版像素恰为 `1148 × 376`、左右两格都有墨迹、中间 16 px 间隙全空。**仍不能断言 docx EMU extent**（`MAX_IMAGE_CX = 5_040_000` 会 clamp）。
  - `V-j` `applyChartOverrides(m,{ subtitle:'x' }).subtitle === 'x'` 且 `renderSvg` 含该文本、位置在标题下方。
  - `V-k` 英文界面下用户输入的标题与副标题原样保留。
- [x] 落点：`client.js`（拼版对话框、副标题字段、图形菜单）、`lib/charts.js`（`subtitle` + `composeChartGrid`）、`lib/raster.js`（组偏移）、`lib/workspace.js`（`addChartGrid`、标题本地化口径）、`lib/routes.js`（`api/chartGrid`）、`lib/tools.js`、词条 17 条、新套件 `test/charts.mjs`。

### 3.4 批 0.60.0 —— 重绘与图表细节（已完成，0.60.0 发布）

- [x] 「重绘为其它类型」：输出页图上的「重绘…」，选类型后用同一组变量重画；`pspp_chart` 加 `redrawOf`，保留 `sourceRunId` 与 `chartSpec.redrawnFrom`，旧图仍在输出树里；拼版拒绝重绘并说明原因。
- [x] PNG 导出倍率：图上 1×/2×/3×/4× 下拉，随 `api/chart/export` 的 `scale` 到服务端（`svgToPng`，上限 4）。
- [ ] Word/Excel 内嵌尺寸按倍率算 —— **不做**：内嵌图走 `MAX_IMAGE_CX = 5_040_000` 封顶（约 14 cm），与用户选的 PNG 倍率无关；把倍率传进 docx 只会让同一张图在不同导出里尺寸不一致。
- [x] 判据：`V-l` 重绘后旧图仍在、新图 `kind` 变、`sourceRunId` 与原图一致（`test/routes.mjs` 的 `api/chart/redraw` 组）；`V-m` scale=3 的 PNG 像素是 scale=1 的 3 倍（`test/charts.mjs` 的 `svgToPng` + `pngSize`）。

### 3.5 批 0.61.0 —— 分析补齐第二轮（评审建议砍成两半，1 天 + 1 天）

**第一批（统计量）**

- [x] 交叉表统计量补齐：风险估计（RR/OR + CI）、Cochran–Mantel–Haenszel、Somers' d、Kendall tau-b/c、Eta、r×c 精确检验（2×2 Fisher 已有）—— **早已实现，不必重做**。证据：`client.js` 的 `crosstabs` spec 已含 `chisq/phi/cc/lambda/uc/gamma/btau/ctau/somersd/eta/corr/risk/kappa/exact/exactchi/cmh`；RR/OR 由 `lib/risk.js` 算（PSPP 对字符串变量跑 `RISK` 会段错，数值 2×2 仍走引擎的 `Risk Estimate` 表）；CMH 与 Breslow–Day 在 `lib/cmh.js`，由 `lib/workspace.js` 的 `annotateLayeredCmh` 挂在分层交叉表上；2×2 精确检验用引擎自带的 Fisher 行。复核方法：`grep -n "somersd\|exactchi\|annotateLayeredCmh" client.js lib/*.js`。
- [ ] 判据：每个统计量都有真引擎输出与手算对照（`test/tables.mjs`/`test/exact.mjs`）。

**第二批（对话框）**

- [x] GLM 的模型选择（0.61.0）：自动 / 只要主效应 / 自定义 `/DESIGN`。
- [x] GLM 的协变量（WITH）与保存（`/SAVE`）—— **引擎不支持，明确不做**：PSPP 2.1.3 的 `GLM` 对 `WITH` 与 `/SAVE` 都报 `Syntax error expecting MISSING, INTERCEPT, CRITERIA, METHOD, or DESIGN.`（探针实测），对话框 hint 指向「分析 → 回归 → 线性回归」。
- [x] 回归诊断图（0.61.0）：残差散点（带 y = 0 虚线）与标准化残差正态 P-P 图，按同一次拟合自算（`lib/regression.js` 的 `regressionPlots`），进输出树、能进成册报告。
- [x] 回归的保存（预测值/残差）：早已由 `/SAVE=PRED RESID` 支持；杠杆值 PSPP 不输出，不做。
- [x] 替换缺失值（0.67.0）：五种方法与 SPSS 同名（序列平均值 / 临近点的平均值 / 临近点的中位数 / 线性插值 / 线性趋势处的点），临近点两种可设两侧各取几个（`span`，默认 2，夹在 1–100）。**PSPP 2.1.3 没有 `RMV`**（探针：`RMV: RMV is not yet implemented.`，rc=1），所以整条链路都在插件里算：对话框 → `api/missing` 的 `span` → `workspace.replaceMissingValues` → `lib/mva.js` 的 `replaceMissing(dataset, names, method, {span})`；`pspp_transform` 的 `method` 枚举同步扩展。判据：`test/mva.mjs` 三条（偏斜邻域下均值 34.333… 对中位数 2、趋势法还原 1/3/5、`span: 0` 回落与错误文案列全六种方法）、`test/routes.mjs` 一条走 HTTP（`nearbyMedian` + `span: 2` 把四格填成 `1.5/2/2/51`，值从 `api/rows` 读回）、`test/client.mjs` 断言选项顺序用 SPSS 中文名、`span` 以数字下发、均值法不附带 `span`。
- [x] 判据：`test/smoke.mjs` 用真引擎跑 `/DESIGN=a b`（只要主效应）与 `/DESIGN=a b a*b`（自动）两条；`test/routes.mjs` 覆盖 `api/regressionPlot` 两张图；`test/regression.mjs` 覆盖两张图的模型结构；`test/client.mjs` 打开回归对话框断言「图」组。自定义设计只剩「为空时中文报错」这一条纯字符串分支（`client.js:2752`）。

### 3.6 批 0.62.0 —— 数据编辑器增强（1 天）

- [x] 计算变量表达式构建器（0.62.0）：函数与变量按钮插入 + 括号/未知名校验（`checkExpression`）。
- [x] 变量视图多选批量改类型/小数位/宽度/测量（0.62.0）：`updateVariables` 一次 `pushHistory`，左栏一次请求。
- [x] 导入跳过表尾行（0.62.0，报告 P3-5）：`skipTailRows` 走 CSV 与工作表两条路径。
- [x] 值标签批量编辑：**早已有**（「数据 → 批量导入值标签」，`parseValueLabelLines` 容忍空行、中文等号与 `VALUE LABELS` 语法），补记在此以免重复做。
- [x] 判据：`test/routes.mjs` 的 `updateMany` 组证明「一次撤销全还原」；`test/client.mjs` 证明批量对话框只发用户设过的字段。

### 3.7 批 0.63.0 —— 可发现性与分发（1 天）

- [x] README 实机截图（0.67.0）：Win10 复验时截了四张（`01-panel-output` / `02-panel-data` / `03-dialog-descriptives` 2× / `04-report-book`，均为 1000×800 或 1320×880，像素自检 ink 占比 2.5%–99.8%），落到 `docs/screenshots/{panel-output,panel-data,dialog-descriptives,report-book}.png`，README 新增「界面」小节两张两列表格引用。附带发现：`docs/screenshots/` 原有 23 张图**没有任何 Markdown 引用**（只有 CHANGELOG 提过），故 README 里这句话同时把目录挂出来了。
- [x] 三个同名入口文案区分（0.63.0）：左栏「统计分析（数据面板）」、文件页签「统计分析 · 数据文件」、右栏「统计分析」。
- [x] 帮助菜单补齐（0.63.0）：快捷键一览、关于（版本/引擎/目录/许可）与真实的 `Alt+1…4` 视图切换。
- [ ] npm 发布：换名（`dsh-analytics-pspp` 已作包名）+ `npm login`；发布前 `npm pack` 后解包复核。
- [ ] 判据：README 图片能显示、`npm view dsh-analytics-pspp version` 与最新 tag 一致。

### 3.8 候补（未排期，按需插入）

- 面板大表虚拟化的实机观感（滚动条/spacer 高度/底色）——需 Win10 取证后再改。
- 宿主侧 93 条 `${}` 拼接报错的英文覆盖（按需补，不阻塞）。
- 最小端到端用例（真 Chromium 点菜单 → 看到表）：本机缺认证会话，需先解决。
- 引擎升级评估（PSPP 2.1.3 → 新版）：构建成本高（74 分钟/约 240 分钟 CI），只在需要新过程时做。

## 4. 明确不做

- 生存分析、复杂抽样、多重插补、混合模型、决策树、ANCOVA（GLM 的 WITH）、REPORT/PPLOT/CURVEFIT：PSPP 2.1.3 不实现，只给中文提示与替代路径（见 FEATURES「受引擎限制的功能」）。
- 复制 SPSS 的 207 个菜单条目：侧栏宽度放不下，只保证**条目重叠处的行为一致**。
- 重写统计计算：能让引擎算的一律让引擎算，插件只做注文与呈现。

## 5. 变更记录

| 日期 | 谁 | 改了什么 |
| --- | --- | --- |
| 2026-11-22 | lead | 建文件：0.24–0.57.0 压成回顾表，排 0.57.1–0.62.0 六批 |
| 2026-11-22 | win10 | 评审 r1（`X:\临时文件\win10-plan-review.md`）：0.57 收尾必须第一个；导入向导提前到图表工作台之前；误差条不是独立类型；重绘拆出；拼版断言只能钉 PNG 像素；`subtitle` 是新字段；工作表选择已有代码只需补用例 |
| 2026-11-22 | lead | 合并评审 r1：3.1 收尾、0.58 导入向导、0.59 图表（拆出重绘）、0.60 重绘、0.61 分析两半、0.62 编辑器、0.63 分发 |
| 2026-11-23 | lead | 0.58.0 发布：向导（预览/列名/类型/跳过行/缺失标记/工作表）+ `pspp_open` 四参数；日期类型明确不做 |
| 2026-11-23 | lead | 0.59.0 发布：副标题 + 拼版（`composeChartGrid`、`api/chartGrid`、`pspp_chart.grid`）；不做「图表构建器」对话框，理由写在 §3.3；评审 `V-i` 的宽高比判据按实测改成像素尺寸 |
| 2026-11-23 | lead | 0.60.0 发布：重绘（`redrawChart`、`api/chart/redraw`、`pspp_chart.redrawOf`）+ PNG 倍率；Word/Excel 内嵌尺寸不跟倍率，理由写在 §3.4 |
| 2026-11-24 | lead | 送验 `lead-0740-verify-0120`（0.67–0.74 八版一批，V1–V8 判据 + 全量测试口径） |
| 2026-11-24 | lead | 0.82.0 发布：多项 Logistic 回归（K−1 个 logit 的牛顿–拉夫逊拟合、五张表、参照类别可指定、分离与共线分开报）、`lib/multinomial.js`、`pspp_multinomial` 与 `POST api/multinomial`、面板「分析 → 回归 → 多项 Logistic…」；二分类与引擎 `LOGISTIC REGRESSION` 互校成立；新套件 `test/multinomial.mjs`（42 套件 / 681 ok） |
| 2026-11-25 | lead | 0.83.0 发布：有序 Logistic 回归（比例优势模型 `logit P(Y≤k) = θ_k − xβ`、牛顿–拉夫逊 + 数值 Hessian、阈值递增守卫、平行线检验按无约束多项 Logistic 重拟合取 `2Δℓ`、五张表）、`lib/ordinal.js`、`pspp_ordinal` 与 `POST api/ordinal`、面板「分析 → 回归 → 有序 Logistic…」；二分类与引擎 `LOGISTIC REGRESSION` 互校成立（β 同号、阈值 = 常数取反）；新套件 `test/ordinal.mjs`（43 套件 / 690 ok） |
| 2026-11-25 | lead | 0.90.0 发布：对应分析（卡方分解 + 幂迭代 SVD + 行/列主坐标、四张表 + 双标图）、`lib/correspondence.js`、`biplot` 图型、`pspp_correspondence` 与 `POST api/correspondence`、面板「分析 → 降维 → 对应分析…」；新套件 `test/correspondence.mjs`（49 套件 / 733 ok） |
| 2026-11-25 | lead | 0.89.0 发布：分布计算器（六种分布的密度/概率质量、累积、上尾、双侧、分位数，不需要数据集）、`lib/distributions.js`、`pspp_distribution` 与 `POST api/distribution`、面板「实用程序 → 分布计算器…」；t/卡方尾概率直接复用检验用的 `studentP`/`chiSquareP` 以保证两处 P 一致；新套件 `test/distributions.mjs`（48 套件 / 724 ok） |
| 2026-11-25 | lead | 0.84.0 发布：泊松回归（`log μ = xβ`、IRLS + 步长减半、离散参数照实报并点名过度离散、三张表）、`lib/poisson.js`、`pspp_poisson` 与 `POST api/poisson`、面板「分析 → 回归 → 泊松回归…」；闭式解（仅截距 β₀ = ln 均值、二分类斜率与标准误）加得分方程归零三重校验；新套件 `test/poisson.mjs`（44 套件 / 700 ok） |
| 2026-11-24 | lead | 0.81.0 发布：修 Win10 0780 报告的 P1（KM 图能画不能改 —— 抽 `Workspace.chartFor()` 统一三个调用点）+ P2（中位生存期印进图里）+ P3×3（可用值列表、edit 工具描述、Cox ties 口径）（41 套件 / 673 ok） |
| 2026-11-24 | lead | 0.80.0 发布：时间序列（移动平均 / 简单指数平滑 / 双指数平滑，模型摘要 MAE/RMSE/MAPE + 序列拟合表 + 序列图，可选外推期数）、`lib/timeseries.js`、`pspp_timeseries` 与 `POST api/timeseries`、面板「分析 → 时间序列」；新套件 `test/timeseries.mjs`（41 套件 / 672 ok） |
| 2026-11-24 | lead | 0.79.0 发布：系统聚类（平均/最长/最短/Ward × 四种距离、Lance–Williams 递推、凝聚状态表 + 聚类成员 + 各组人数）、树状图 `dendrogram`、`pspp_cluster` 与 `POST api/cluster`、面板「分析 → 分类 → 系统聚类…」；新套件 `test/cluster.mjs`（41 套件 / 663 ok） |
| 2026-11-24 | lead | 0.78.0 发布：修 Win10 0740 报告的 P1×5 + P2×5（分组项默认值、数字输入框、中位数检验字符串引号、图表请求扁平化、`/BARCHART`），自检抓出 `km` 同一处双层 `options`；重绘保留 plot/fit；宿主报错中文化；`SHA256SUMS-<版本>` 留档 |
| 2026-11-24 | lead | 0.77.0 发布：判别分析（Fisher 线性判别 + 混淆矩阵 + 特征值/典型相关 + Wilks 检验）、`pspp_discriminant` 与 `POST api/discriminant`、面板「分析 → 分类 → 判别…」；求逆/行列式抽成 `lib/linalg.js`；新套件 `test/discriminant.mjs`（40 套件 / 654 ok） |
| 2026-11-24 | lead | 0.76.0 发布：Cox 比例风险回归（Newton–Raphson 偏似然、Breslow 并列、Exp(B) + 95% CI）、`pspp_cox` 与 `POST api/cox`、面板「生存分析 → Cox 回归…」；得分检验与 log-rank 对账成立；新套件 `test/cox.mjs`（39 套件 / 646 ok） |
| 2026-11-24 | lead | 0.75.0 发布：Kaplan–Meier（乘积极限 + Greenwood CI + 中位生存 + 完整矩阵 log-rank）+ 生存分析菜单与 `pspp_chart.km`；新套件 `test/survival.mjs` |
| 2026-11-24 | lead | 0.74.0 发布：X̄–R 控制图（两栏 SVG、A2/D3/D4 限值、越界标注）+ 分析菜单「质量控制」组 |
| 2026-11-24 | lead | 0.73.0 发布：帕累托图（自绘：降序柱 + 累计百分比折线 + 80% 参考线 + 尾部折叠） |
| 2026-11-24 | lead | 0.72.0 发布：修 0660 报告 P1（图表对话框丢 `variables` ⇒ 文本变量条形图恒发 MEAN）、补 P2 变异用例、改正 0.63–0.66 计数与口径说明 |
| 2026-11-24 | lead | 0.71.0 发布：数据 → 转置（`FLIP`，含 `/NEWNAMES`），`pspp_transform.transpose` |
| 2026-11-24 | lead | 0.70.0 发布：频率图表扩到四种（饼图、直方图+正态曲线）、散点图拟合线与 R²；`chartSpec` 记 `fit` |
| 2026-11-24 | lead | 0.69.0 发布：P-P / Q-Q 图（插件自算点，`PPLOT` 引擎未实现）；`CHART_SPECS` 挂测试钩子 |
| 2026-11-23 | lead | 0.68.0 发布：中位数检验（`NPAR TESTS /MEDIAN=`，FEATURES 那行「缺」改原生） |
| 2026-11-23 | lead | 0.67.0 发布：替换缺失值补齐 SPSS 五种方法（`REPLACE_METHODS`、`span` 贯通三层、`pspp_transform.span`）+ README 界面小节；§3.5 的交叉表统计量按 `grep` 复核标记为「早已实现」 |
