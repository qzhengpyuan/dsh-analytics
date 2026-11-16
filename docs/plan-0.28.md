# 0.28 计划：本机与 Win10 侧商定的优先级

日期 2026-11-16。参与：本机（lead）与 Win10 虚拟机的 dsh 会话（独立复验方）。
依据：Win10 的复验报告 + `/mnt/E/临时文件/win10-plan.md`（它的排序与遗留问题清单）。

## 一、结论先行

**P0 三件，按这个顺序做，一件一发版：**

1. **路径边界**（Win10 排第一，我接受）
   现状：`readFile` / `writeText` / `saveSyntax` / 导出 / `convert` / `merge` 接受任意绝对路径。
   风险不是「用户点错」，而是「不需要用户犯错」：面板已经 HTTP 暴露，cookie 可自签（HMAC key 就是
   `~/.dsh/.credentials.yaml` 里那串 secret），一次路径笔误或被数据内容诱导，就能读走凭据、覆盖任意文件。
   做法：`realpath` 之后比对**允许目录**（默认 `~`、会话 cwd、`/mnt`、`/tmp`、系统临时目录），
   `~/.dsh`、`~/.ssh`、`~/.gnupg` 一律硬拒（含其子路径，白名单也不放开）；越界时返回可操作的中文错误
   （「这个路径不在允许的目录里：…。要放开就把它的上级目录加到 设置 → 允许的目录」），设置页新增
   「允许的目录」一项，用户自己写什么就放开什么 —— 自由仍在用户手里，但必须是显式的。
2. **Word/Excel 导出跟随 `tableStyle`**（我原来的 P0-1，降为第二）
   0.27.3 只把样式接到了 HTML；`lib/office.js` 的 `tableXml()` 把边框写死成三线表。改法：`buildDocx`
   收 `style`，`tableXml` 按 `three-line` / `grid` / `plain` 生成 `tcBorders` 与 `tblBorders`；xlsx 侧同理。
3. **`runs/<seq>` 换唯一目录 + `evictIdle` 在飞引用计数**
   两个工作区（面板一条会话、对话一条会话）共用 `runs/N` 会互相覆盖输出文件；`evictIdle` 释放时不看有没有
   在飞请求。改法：目录名 `runs/<seq>-<workspaceNonce>`（`runId` 仍是数字，标签与排序不动），
   `busyDepth` 之外再加 `inflight` 计数，>0 不释放。

**P1（P0 清完再做，顺序待定）：**

- `settings` 的「立即生效」口径：`configFor()` 只在创建工作区时读设置，老会话不跟随（Win10 FAIL）。
  两个选项：`state()` 每次读 `settingsStore.current()`（真·立即生效），或文案改成「新会话生效」。
  倾向前者 —— 表格样式这种纯展示项没理由要求重开会话。
- 菜单可点性 + 键盘通路：Win10 在真 Chromium 点不开 `.ap-menu-pop`，我这边 jsdom 通过。
  需要确认是取证姿势还是真 bug；无论结论，都补 SPSS 那套 `Alt+F/E/D/T/A/G/U/H` 助记键与上下键导航。
- 大表渲染：单表 3500+ 节点无虚拟化；`api/state` 仍全量下发 items。
- 最小 e2e（真浏览器：打开数据 → 频率 → 导出 HTML），排在菜单问题定性之后。
- UI 对齐第二轮：工具栏图标化、变量视图列宽拖拽、输出树按 run 分组、对话框选项卡化。

**P2（可以等）：** 多数据集并行、PDF 自带渲染（现在 PDF 由 PSPP 排，不带来源戳）、undo 快照上限
（12M 格 × 30 能吃掉内存）、英文界面、`maxRows` 截断提示、导出体积上限。

## 二、Win10 报的、我确认要修的杂项

| 问题 | 处理 |
| --- | --- |
| `scripts/install.mjs` 把 profile 写死 `web` | 改成探测（`dsh plugin list` 或问用户），默认取唯一 profile |
| Win10 的 `.credentials.yaml` 没有 `refs.GITHUB_TOKEN` | 安装文档写清「私库需 `GITHUB_TOKEN=… node scripts/install.mjs`」 |
| 错误 toast 铺 `run.sps:1.1-1.11` 引擎原文 | 结论留中文，「原文」收进可展开的详情 |
| `maxRows` 截断后状态栏不提示 | 状态栏加「已载入前 N / 共 M 例」 |
| 导出体积无上限（3002 行 docx 7.3 MB） | 超过阈值先问，或写一条上限设置 |
| `web-ui-agents` 告警时有时无 | 保持观察，不进 CI 判据（CI 只看测试退出码） |

## 三、交付方式

- 一件一个版本、一个 tag、一个 Release（带 `SHA256SUMS`）；每件都补测试与文档。
- 复验交给 Win10，用「写文件 + 回一句路径」（`X:\临时文件\<名>.md`）交换结论，省双方上下文。
- 本机不能重启 dsh web，插件热重载只做 `plugin_manager set_plugin include:analytics` 停→启。
