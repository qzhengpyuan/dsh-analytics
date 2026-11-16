# 0.27.0 计划：一次把「像 SPSS 的成熟产品」补齐

目标版本 0.27.0。四件产品向的欠账 + 一件视觉对齐，逐条给出验收判据。拆给子代理并行做，宿主半/统计层/浏览器半分开，避免同时改 `client.js`。

## 1. 设置面板（浏览器半 + 宿主半）

现状：`registerTools`、`maxRows`、`timeoutMs`、`safer`、引擎路径只能改 `cordis.patch.yml` 再 disable→enable。

做法：面板新增「设置」页（DSH 设置 → 统计分析，槽 `settings.section`），宿主半新增 `GET/PUT api/settings`，落盘 `~/.dsh/analytics/settings.json`。
可调项与生效方式：

| 项 | 默认 | 生效时机 |
|---|---|---|
| 最大个案数 `maxRows` | 200000 | 新建的 workspace 立即生效；当前会话重载后生效 |
| 单次运行超时 `timeoutMs` | 120000 | 下一次运行 |
| `safer`（PSPP `--safer`） | false | 下一次运行 |
| 输出表样式（三线表/网格） | 三线表 | 面板立即重绘 + 下次导出 |
| 小数位（表格显示） | 2 | 面板立即 |
| `registerTools` | false | **只读展示**，旁边写明「改它要改 `cordis.patch.yml` 并停→启插件」 |

验收：改 maxRows=100 → 打开 200 例的 CSV，面板显示 100 例 + 「已截断」提示；重启宿主后设置仍在。

## 2. 对话框「粘贴语法」

现状：点完对话框直接跑，SPSS 用户习惯的「粘贴 → 改 → 运行」缺失。

做法：在共享页脚（`确定 / 粘贴 / 重置 / 取消 / 帮助`）里加「粘贴」，行为 = 把本对话框将要运行的语法写进语法视图（不执行），并把页签切到「语法」、光标置于末尾。

验收：频率对话框填完点「粘贴」→ 语法页多出 `FREQUENCIES /VARIABLES=x.`，输出区无新条目；再点「确定」才跑。

## 3. 统计自算（不依赖 PSPP 的部分）

- **Cramér's V**：`V = sqrt(χ²/(N·(min(r,c)-1)))`，接在交叉表 `Chi-Square Tests` 之后；2×2 时等于 φ，注里说明。
- **小样本提示**：2×2 且存在期望频数 < 5 时，表注点名「看同表 Fisher's Exact Test 行（Exact Sig.）」——PSPP 本来就算这一行，是我们没引导用户去看。
- **Kappa**：交叉表选项加 `KAPPA`，透出 PSPP 的 `Symmetric Measures` 表。
- **ICC**：PSPP 不支持 `/ICC=`，由 JS 算并追加表：ICC(2,1) 绝对一致、ICC(3,1) 一致性、F/df/p、95% CI（McGraw & Wong），表注写清模型与适用条件。

验收：每条都有能手工核对的小数据断言；`node test/tables.mjs` 全绿。

## 4. 一条命令安装

`dsh-analytics` 在 npm 上**已被别的包占用**（2026-08-14 起，latest 0.4.0），本机也没有 npm 登录态，所以不抢占名字。

改走 GitHub 源安装：`dsh plugin --profile <p> add git+ssh://git@github.com/qzhengpyuan/dsh-analytics.git#v0.27.0`，`postinstall` 调 `scripts/fetch-engine.mjs` 补本平台引擎（仓库里 `engine/` 不入库）。私有库需要 `GITHUB_TOKEN`（`fetch-engine.mjs` 已支持从环境变量或 `~/.dsh/.credentials.yaml` 取）。

验收：在 `/tmp` 的干净前缀里 `npm install` 这个 git 源能装出完整的包（引擎在、`import('dsh-analytics/tools')` 正常）。

## 5. UI 对齐 SPSS（紧凑版）

面板窄（侧栏 380–520 px），照 SPSS 26 的比例缩：12px 字体、24px 菜单栏、30px 工具条、四个页签**移到内容区下方**、输出视图左树 190px、表格改三线表（外框 1px、表头上下双线、去竖线）、对话框 520px 且页脚 `确定/粘贴/重置/取消/帮助`、状态栏 22px。深浅色都靠现有 `--ap-*` 变量派生。

验收：`node test/client.mjs`（jsdom）全绿；`.ap-view-tab` 等被测试引用的 class 与文案保持不变。

## 交付顺序

1. 统计层（`lib/**`）与视觉层（`client.js`）并行 —— 两者不碰同一文件。
2. 视觉层落地后，设置面板 + 粘贴语法再动 `client.js`（同一文件串行，避免互相覆盖）。
3. 我整合：`npm test`、文档（CHANGELOG/FEATURES/README）、版本号 0.27.0、打包（`scripts/pack.mjs` 的 `registerTools` 双检必须过）、tag、push、CI、Release。
4. 复验交给 Win10 那份会话（它已跑过 0.26.3/0.26.5 两轮，脚本在 `C:\Temp`）。
