# 面板视觉口径：对齐 SPSS Statistics 26（紧凑版）

> 只影响浏览器半 `client.js`（`const CSS = "…"` 与几处 JSX）。宿主半 `lib/**`、`index.js` 不参与。
> 目标不是复刻 SPSS 的像素，而是在 DSH 侧栏（通常 380–520 px）里保持 SPSS 的**比例与层次**：
> 同样的 12px 正文、同一套「菜单栏 / 工具条 / 内容 / 页签 / 状态栏」垂直顺序、同样的三线表与对话框骨架。

## 1. 尺寸表

| 部件 | SPSS 26 原值 | 本面板 | 说明 |
|---|---|---|---|
| 正文字号 | 12 px | 12 px | `.ap-root`；不再跟 `--dsh-content-font-size` 走 |
| 说明/状态栏小字 | 11 px | 11 px | `.ap-hint`、`.ap-status`、表格脚注；**正文不再出现 ≤10 px** |
| 菜单栏高 | 24 px | 24 px | `.ap-menu` |
| 菜单项左右内边距 | 8 px | 8 px | `.ap-menu-button` |
| 下拉菜单项行高 | 22 px | 22 px | `.ap-menu-pop button` |
| 菜单弹层边框/阴影 | 1 px + 2 px | 1 px `--ap-line-2` + `2px 2px 2px` 文本混色 | `.ap-menu-pop` |
| 工具条高 | 30 px | 30 px（`min-height`） | `.ap-toolbar` |
| 工具条按钮 | 24 × 24 | 高 24 px、宽随文字（≥24） | 见 §5 取舍：按钮是文字不是图标 |
| 工具图标 | 16 × 16 | — | 面板没有图标集，全部文字标签 |
| 页签高 | 26 px | 26 px | `.ap-tabstrip`，选中 `.ap-view-tab.ap-active` |
| 大纲树宽 | 190 px | 190 px（可拖到 150–460） | `.ap-outline` + `localStorage['ap.outlineWidth']` |
| 表格单元格内边距 | 3 × 6 | `3px 6px` | `.ap-doc th, .ap-doc td` |
| 表题 | 12 px 加粗 | 12 px / 700 | `.ap-item-head h3` |
| 表注 | 11 px 斜体灰 | 11 px / italic / `--ap-text-2` | `.ap-footnote` |
| 状态栏高 | 22 px | 22 px | `.ap-status` |
| 对话框宽 | 520 px | `min(520px, calc(100% - 24px))` | `.ap-modal`；`wide` 变体 560 px |
| 对话框标题 | 13 px 加粗 | 13 px / 700 | `.ap-modal-title` |
| 对话框页脚按钮 | 24 px 高 / 左右 12 px | 同 | `.ap-modal-foot .ap-tool` |
| 箭头按钮列 | 28 px | 28 px | `.ap-dlg-arrow` |

垂直顺序（SPSS 的 Data Editor 与 Viewer 一致）：
**菜单栏 → 工具条 →（数据集页签）→ 内容区 → 视图页签条 → 状态栏**。
`.ap-tabstrip` 在 JSX 里已经移到 `.ap-body` 之后、`.ap-status` 之前。

## 2. 颜色映射

全部颜色仍经 `--ap-*` → `--dsw-alias-*` / `color-mix()` 派生，深浅色共用一个口径；新增的两个色位在深色下**改写为混色**，不写死浅色值。

| 语义 | 变量 | 浅色（SPSS 26 取色） | 深色 |
|---|---|---|---|
| 菜单/页签悬停 | `--ap-hover` | `#d6e6f7`（`--dsw-alias-interactive-bg-hover` 优先） | `color-mix(in srgb, var(--ap-text) 8%, var(--ap-panel))` |
| 树选中 / 系统选中蓝 | `--ap-select` | `#cce8ff` | `color-mix(in srgb, var(--ap-accent) 25%, var(--ap-panel))` |
| 表格外框 | `--ap-line-3` | 文本 28% 混白 | 同一公式，自动变浅 |
| 表头上下线 | `--ap-line-3` / `--ap-line-4` | 28% / 45% | 同上 |
| 单元格横线 | `--ap-line` | 12% | 同上 |
| 选中单元格 | `--ap-selected` | 强调色 18% 混白 | 同一公式 |
| 斑马纹 | `--ap-stripe` | 文本 4% 混白 | 同一公式 |
| 对话框标题条 | `--ap-surface-2` → `--ap-head-2` 渐变 | 5%→7% | 同一公式 |

顺手补掉的三个历史空引用（原先没定义，等于取浏览器默认值）：
`--ap-muted` → `--ap-text-3`、`--ap-button` → `--ap-surface`、`--ap-head-1` → `--ap-head`、`--ap-line-subtle` → `--ap-line`。

## 3. SPSS 部件 → 本面板实现

| SPSS 26 部件 | 观感要点 | 实现 |
|---|---|---|
| 菜单栏 | 24 px、项 8 px、悬停蓝底、弹出菜单细线 + 2 px 投影、快捷键右对齐灰字 | `.ap-menu` / `.ap-menu-button` / `.ap-menu-pop`；`renderMenuItems()` 把标签尾部「（Ctrl+Z）」拆成 `.ap-keys` 右对齐 |
| 工具条 | 30 px、按钮按下凹陷、组间竖线 | `.ap-toolbar` / `.ap-tool`（hover `inset` 双 1 px、active 内阴影）/ `.ap-tool-sep`（原来写死 `#b7bcc5` 的行内 span 已换成变量色） |
| Data Editor 底部页签 | 26 px、选中白底 + 1 px 上框、其余灰底 | 页签移到内容区下方；`.ap-view-tab.ap-active` |
| Viewer 导航树 | 190 px、选中蓝、树与内容 1 px 分隔 | `.ap-outline` / `.ap-outline button.ap-ol-active`；`active === item.id` 时加类 |
| Viewer 表格（三线表） | 外框 1 px、表头上下双线、无竖线、数值右对齐、表注斜体 | `.ap-doc table` 系列；数值列由 `isNumericCell()` 在 DOM 上打 `.ap-num`（不动 `matrixHtml` 生成的字符串，导出 HTML 保持原样） |
| 分析对话框 | 520 px、左变量列表白底内凹、右目标框、28 px ▶、页脚 `确定/粘贴/重置/取消/帮助` | `.ap-dlg*` 系列；`AnalysisDialog` 增加「选中变量」与逐框箭头、`onPaste/onReset/onHelp` |
| 状态栏 | 22 px、左「N 个个案 · M 个变量」、右引擎信息、1 px 上框 | `.ap-status` / `.ap-status-cases` / `.ap-status-right`；来源路径移到数据集页签与左侧那格的 tooltip |

对话框页脚顺序与行为（`Modal` 的 `onPaste/onReset/onHelp` 为可选，只有能兑现的对话框才渲染这三个按钮）：

- **确定**（默认，加粗边框 `.ap-primary`）：执行；
- **粘贴**：把这次设置将运行的 PSPP 语法写进「语法」页签，不执行、不切走数据（`AnalysisDialog` 的 `build()` 已产出 `syntax` 才有此键）；
- **重置**：`values/flags/current/help` 回到刚打开对话框时的状态；
- **取消**：`onCancel`；
- **帮助**：展开 `.ap-dlg-help`，显示确定会执行的语法（不生成语法的画图类对话框显示说明文字）。

## 4. 改了哪些 JSX（其余全是 CSS）

1. 视图页签条从内容区上方**移到**内容区下方（`h('div', { className: 'ap-tabstrip' … })` 整体搬到 `.ap-status` 之前），class 与文案未动。
2. 工具条里两根写死颜色的分隔 `<span style=…>` 换成 `<span className="ap-tool-sep">`。
3. `renderMenuItems()` 拆出快捷键，`menuLabel()` 返回「文字 + 快捷键」两个 span。
4. `Modal()` 新增 `onPaste/onReset/onHelp` 三个可选按钮，`确定` 加 `.ap-primary`。
5. `AnalysisDialog()`：变量行可选中（`.ap-current`）、每个目标框左侧 28 px `▶`（加入/移出当前变量）、帮助面板、重置、粘贴。
6. `OutputDoc`：树项加 `.ap-ol-active`；大纲默认宽度 190 / 下限 150；渲染后给纯数字单元格打 `.ap-num`。
7. 状态栏：`caseText`（左）、`engineHint`/`就绪`/`导入说明`/`v…`（右），来源路径进 tooltip。

## 5. 窄栏取舍与还没对齐的地方

- **工具条会折成两行**：12 个文字按钮在 380–520 px 里放不进一行。SPSS 用 16 px 图标 + 24 px 方按钮所以放得下；面板没有图标资源，保持一致优先级：先保 30 px 行高、24 px 按钮高与组间竖线，再允许换行（`flex-wrap`）。要单行只能改图标化，那是另一个改动。
- **按钮不是 24 × 24**：文字按钮宽随文案（`min-width:24px`），高严格 24 px。
- **对话框箭头是「逐框」而不是「一列」**：SPSS 只有一个共享的目标框列表，所以中间是一整列 28 px 箭头；本面板的目标框是纵向堆叠且数量随过程变化，箭头贴在各自框的左侧才能对齐。宽度仍是 28 px。
- **变量列表保留了复选框**：SPSS 的列表是纯选中 + 箭头。这里两条路都留（勾选 = 直接加/减，选中后按 `▶` = SPSS 习惯），因为 `test/client.mjs` 依赖 `.ap-dlg-var` 里的 `input` 做断言。
- **输出表可能横向滚动**：表头按「词」换行（`word-break:keep-all`），列多时整表超出 290 px 的内容宽度，靠 `.ap-table-wrap` 横向滚动 —— 与 SPSS Viewer 在窄窗里的行为一致，但不如宽屏好看。
- **没有对齐的**：SPSS 的「窗口标题栏 + 关闭按钮」、Viewer 的双击编辑表格、菜单里的图标与首字母下划线（Alt 助记键）、工具条下拉箭头（SPSS 有些按钮长按出子菜单）。这些在侧栏面板里没有对应结构，未做。
- **深色主题**：SPSS 本身没有深色模式，所以深色下只保证「不透白、不刺眼、层级仍在」，取色规则与浅色同源（文本/强调色混底），没有单独设计一套深色配色。

## 第二轮（0.30.0）

| SPSS 部件 | 现在的实现 |
|---|---|
| 工具栏图标（16×16、无文字） | `apIcon(name)` 内联 SVG，`ICON_PATHS` 十个字形，`.ap-icon-btn` 26×26；名字在 `title`/`aria-label` |
| Viewer 输出树按过程分组 | 每次运行前一行 `.ap-ol-run`「运行 N」，组内维持执行顺序 |
| 数据编辑器表头：名字 + 小字标签 | `.ap-head-name` / `.ap-head-label` 两行，标签 10 px 灰字，无标签只占一行 |
| 菜单助记键 Alt+F/E/… | `MENU_MNEMONICS` 映射到中文菜单名；`↑↓` 走条目、`←→` 换菜单、`Esc` 收起 |

取舍：图标是手绘路径而不是图标库 —— 面板不打包、不引运行时依赖，十个字形六十行代码比多一个依赖划算；`Alt` 助记键按中文菜单名映射（SPSS 中文版也是这样，`Alt+F` 开「文件」）。
